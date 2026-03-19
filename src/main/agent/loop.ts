/**
 * Agent Loop — The core agentic execution loop.
 *
 * Phases: classify → build prompt → call LLM → dispatch tools → loop → respond
 * Limits: 30 iterations, 10 min wall time.
 *
 * Token optimizations:
 *   - Per-tool result caps (not a flat 50K)
 *   - Sliding history window (last 8 user/assistant turns)
 *   - Memory injection only when relevant
 *   - Early batching nudge for GUI tasks (at call #2)
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { BrowserWindow } from 'electron';
import { classify, type TaskProfile, type ToolGroup } from './classifier';
import { buildStaticPrompt, buildDynamicPrompt } from './prompt-builder';
import { getToolsForGroup, executeTool } from './tool-builder';
import { AnthropicClient, resolveModelId, type LLMResponse } from './client';
import { getPromptContext } from '../db/memory';
import { getDesktopCapabilities } from './executors/desktop-executors';
import { IPC_EVENTS } from '../../shared/ipc-channels';

const MAX_ITERATIONS = 30;
const MAX_WALL_MS = 10 * 60 * 1000;
const MAX_HISTORY_TURNS = 16;
const WRAP_UP_THRESHOLD = 25;
const GUI_BATCH_NUDGE_AT = 2; // Nudge at call #2 — before the LLM burns calls on single actions

const NARRATION_RE = /^(?:I'll start by|Let me (?:start|begin|first)|I need to (?:first|read|check|look)|Here's my (?:plan|approach)|I want to (?:start|begin))/i;
const CAPABILITY_DENIAL_RE = /(?:I (?:can't|cannot|don't have|am unable to) (?:access|browse|execute|run|open|launch|read|write))/i;

const TOOL_RESULT_CAPS: Record<string, number> = {
  shell_exec: 10_000,
  file_read: 20_000,
  file_write: 500,
  file_edit: 500,
  directory_tree: 5_000,
  browser_search: 5_000,
  browser_navigate: 10_000,
  browser_read_page: 10_000,
  browser_click: 5_000,
  browser_type: 500,
  browser_extract: 10_000,
  browser_screenshot: 1_000,
  create_document: 500,
  memory_search: 3_000,
  memory_store: 500,
  app_control: 10_000,
  gui_interact: 5_000,
  dbus_control: 8_000,
};
const DEFAULT_RESULT_CAP = 10_000;

export interface LoopOptions {
  apiKey: string;
  model?: string;
  onStreamText?: (text: string) => void;
  onThinking?: (thought: string) => void;
  onToolActivity?: (activity: { name: string; status: string; detail?: string }) => void;
  onStreamEnd?: () => void;
  window?: BrowserWindow;
}

function pickModel(classifierModel: string, storedModel?: string, isGreeting?: boolean): string {
  if (isGreeting) return resolveModelId('haiku');
  if (classifierModel === 'opus') return resolveModelId('opus');
  if (storedModel) return storedModel;
  return resolveModelId(classifierModel);
}

function trimHistory(history: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (history.length <= MAX_HISTORY_TURNS) return history;
  const trimmed = history.slice(-MAX_HISTORY_TURNS);
  if (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed.shift();
  const droppedCount = history.length - trimmed.length;
  if (droppedCount > 0) console.log(`[Agent] History trimmed: kept ${trimmed.length} of ${history.length}`);
  return trimmed;
}

export async function runAgentLoop(
  userMessage: string,
  history: Anthropic.MessageParam[],
  options: LoopOptions,
): Promise<{ response: string; toolCalls: { name: string; status: string; detail?: string }[] }> {
  const { apiKey, onStreamText, onThinking, onToolActivity, onStreamEnd } = options;

  const profile = classify(userMessage);
  console.log(`[Agent] Classified: group=${profile.toolGroup} modules=[${[...profile.promptModules]}] model=${profile.model} greeting=${profile.isGreeting}`);

  const modelId = pickModel(profile.model, options.model, profile.isGreeting);
  console.log(`[Agent] Using model: ${modelId} (classifier=${profile.model}, stored=${options.model || 'none'})`);

  const client = new AnthropicClient(apiKey, modelId);
  const staticPrompt = buildStaticPrompt(profile.toolGroup, profile.promptModules);

  let memoryContext = '';
  if (!profile.isGreeting && userMessage.length > 10) {
    try { memoryContext = getPromptContext(500, userMessage); } catch {}
  }

  let desktopContext = '';
  if (profile.promptModules.has('desktop_apps')) {
    try { desktopContext = await getDesktopCapabilities(); } catch {}
  }

  const dynamicPrompt = buildDynamicPrompt({
    model: modelId,
    toolGroup: profile.toolGroup,
    memoryContext,
    desktopContext,
    isGreeting: profile.isGreeting,
  });

  let tools = getToolsForGroup(profile.toolGroup);
  const trimmedHistory = trimHistory(history);
  const messages: Anthropic.MessageParam[] = [...trimmedHistory, { role: 'user', content: userMessage }];

  const allToolCalls: { name: string; status: string; detail?: string }[] = [];
  let toolCallCount = 0;
  let guiBatchNudgeSent = false;
  const startTime = Date.now();
  let finalText = '';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (Date.now() - startTime > MAX_WALL_MS) {
      console.warn(`[Agent] Wall time limit reached at iteration ${iteration}`);
      break;
    }

    onThinking?.('Thinking...');

    // Early batch nudge for desktop tasks — fires after just 2 tool calls
    // This catches the LLM before it wastes calls on single-action patterns
    if (!guiBatchNudgeSent && profile.promptModules.has('desktop_apps') && toolCallCount >= GUI_BATCH_NUDGE_AT) {
      messages.push({
        role: 'user',
        content: '[SYSTEM] IMPORTANT: For all remaining GUI steps, use gui_interact with action="batch_actions" and pass an "actions" array to execute multiple click/type/key steps in ONE tool call. Use "screenshot_and_focus" instead of separate focus+screenshot. Do NOT make single-action gui_interact calls.',
      });
      guiBatchNudgeSent = true;
      console.log(`[Agent] GUI batch nudge sent at ${toolCallCount} tool calls`);
    }

    if (toolCallCount >= WRAP_UP_THRESHOLD && !profile.isGreeting) {
      messages.push({ role: 'user', content: `[SYSTEM] ${toolCallCount} tool calls used (limit: ${MAX_ITERATIONS}). Wrap up.` });
    }

    let iterationText = '';
    let response: LLMResponse;

    try {
      response = await client.chat(messages, profile.isGreeting ? [] : tools, staticPrompt, dynamicPrompt, (chunk) => {
        iterationText += chunk;
        onStreamText?.(chunk);
      });
    } catch (err: any) {
      console.error(`[Agent] LLM error:`, err.message);
      finalText = `I encountered an error: ${err.message}`;
      break;
    }

    onThinking?.('');

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const responseText = textBlocks.map(b => b.text).join('');

    if (toolUseBlocks.length === 0) {
      const isShortNarration = iteration === 0 && responseText.length < 300 && NARRATION_RE.test(responseText) && toolCallCount === 0;

      if (isShortNarration && iteration < MAX_ITERATIONS - 1) {
        onStreamText?.('\n\n__RESET__');
        messages.push({ role: 'assistant', content: response.content as any });
        messages.push({ role: 'user', content: '[SYSTEM] You described a plan but did not execute it. Use your tools now.' });
        continue;
      }

      if (responseText && CAPABILITY_DENIAL_RE.test(responseText) && iteration < 3) {
        onStreamText?.('\n\n__RESET__');
        messages.push({ role: 'assistant', content: response.content as any });
        messages.push({ role: 'user', content: '[SYSTEM] You have full system access: filesystem, shell, browser, desktop control (app_control, gui_interact batch_actions, dbus_control). Use your tools.' });
        continue;
      }

      finalText = responseText;
      break;
    }

    if (iterationText) onStreamText?.('\n\n__RESET__');
    messages.push({ role: 'assistant', content: response.content as any });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      toolCallCount++;
      const startMs = Date.now();

      onToolActivity?.({ name: toolUse.name, status: 'running', detail: summarizeInput(toolUse.name, toolUse.input as any) });
      console.log(`[Agent] Tool #${toolCallCount}: ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);

      let result: string;
      try { result = await executeTool(toolUse.name, toolUse.input as any); }
      catch (err: any) { result = `[Error] ${err.message}`; }

      const durationMs = Date.now() - startMs;
      const status = result.startsWith('[Error') ? 'error' : 'success';

      onToolActivity?.({ name: toolUse.name, status, detail: summarizeInput(toolUse.name, toolUse.input as any) });
      allToolCalls.push({ name: toolUse.name, status, detail: summarizeInput(toolUse.name, toolUse.input as any) });
      console.log(`[Agent] Result (${durationMs}ms): ${result.slice(0, 200)}`);

      if (status === 'error') result += '\n[Hint: Change your approach — do not retry the same command.]';

      const cap = TOOL_RESULT_CAPS[toolUse.name] || DEFAULT_RESULT_CAP;
      let cappedResult = result;
      if (result.length > cap) {
        cappedResult = result.slice(0, cap) + `\n\n[Truncated — ${result.length} chars, showing first ${cap}]`;
      }

      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: cappedResult });
    }

    messages.push({ role: 'user', content: toolResults as any });

    if (iteration === MAX_ITERATIONS - 1) {
      finalText = responseText || '[Reached iteration limit.]';
    }
  }

  onStreamEnd?.();
  return { response: finalText, toolCalls: allToolCalls };
}

function summarizeInput(toolName: string, input: Record<string, any>): string {
  switch (toolName) {
    case 'shell_exec': return input.command?.slice(0, 80) || '';
    case 'file_read': return input.path || '';
    case 'file_write': return input.path || '';
    case 'file_edit': return input.path || '';
    case 'directory_tree': return input.path || '';
    case 'browser_search': return `"${input.query}"` || '';
    case 'browser_navigate': return input.url || '';
    case 'browser_click': return input.target || '';
    case 'browser_type': return input.text?.slice(0, 40) || '';
    case 'browser_extract': return input.instruction?.slice(0, 60) || '';
    case 'create_document': return input.filename || '';
    case 'memory_search': return input.query || '';
    case 'memory_store': return `${input.category}/${input.key}` || '';
    case 'app_control': return `${input.app} ${input.command?.slice(0, 50) || ''}`;
    case 'gui_interact': {
      if (input.action === 'batch_actions') return `batch (${input.actions?.length || 0} steps)`;
      return `${input.action}${input.window ? ` "${input.window}"` : ''}${input.x != null ? ` (${input.x},${input.y})` : ''}`;
    }
    case 'dbus_control': return `${input.action}${input.service ? ` ${input.service.split('.').pop()}` : ''}${input.method ? `.${input.method}` : ''}`;
    default: return JSON.stringify(input).slice(0, 60);
  }
}
