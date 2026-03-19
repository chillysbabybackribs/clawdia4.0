/**
 * Agent Loop — The core agentic execution loop.
 *
 * Phases: classify → build prompt → call LLM → dispatch tools → loop → respond
 * Limits: 15 iterations, 5 min wall time.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { BrowserWindow } from 'electron';
import { classify, type TaskProfile, type ToolGroup } from './classifier';
import { buildStaticPrompt, buildDynamicPrompt } from './prompt-builder';
import { getToolsForGroup, executeTool } from './tool-builder';
import { AnthropicClient, resolveModelId, type LLMResponse } from './client';
import { getPromptContext } from '../db/memory';
import { IPC_EVENTS } from '../../shared/ipc-channels';

const MAX_ITERATIONS = 15;
const MAX_WALL_MS = 5 * 60 * 1000;

const NARRATION_RE = /^(?:I'll start by|Let me (?:start|begin|first)|I need to (?:first|read|check|look)|Here's my (?:plan|approach)|I want to (?:start|begin))/i;
const CAPABILITY_DENIAL_RE = /(?:I (?:can't|cannot|don't have|am unable to) (?:access|browse|execute|run|open|launch|read|write))/i;

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

  // Inject user memory into dynamic prompt (skip for greetings — saves tokens)
  let memoryContext = '';
  if (!profile.isGreeting) {
    try {
      memoryContext = getPromptContext(800, userMessage);
    } catch {
      // Memory DB may not be ready yet
    }
  }

  const dynamicPrompt = buildDynamicPrompt({
    model: modelId,
    toolGroup: profile.toolGroup,
    memoryContext,
    isGreeting: profile.isGreeting,
  });

  let tools = getToolsForGroup(profile.toolGroup);

  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  const allToolCalls: { name: string; status: string; detail?: string }[] = [];
  let toolCallCount = 0;
  const startTime = Date.now();
  let finalText = '';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (Date.now() - startTime > MAX_WALL_MS) {
      console.warn(`[Agent] Wall time limit reached at iteration ${iteration}`);
      break;
    }

    onThinking?.('Thinking...');

    if (toolCallCount >= 12 && !profile.isGreeting) {
      messages.push({
        role: 'user',
        content: `[SYSTEM] You have ${15 - toolCallCount} tool calls left. Wrap up and respond.`,
      });
    }

    let iterationText = '';
    let response: LLMResponse;

    try {
      response = await client.chat(
        messages,
        profile.isGreeting ? [] : tools,
        staticPrompt,
        dynamicPrompt,
        (chunk) => {
          iterationText += chunk;
          onStreamText?.(chunk);
        },
      );
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
      const isShortNarration = iteration === 0
        && responseText.length < 300
        && NARRATION_RE.test(responseText)
        && toolCallCount === 0;

      if (isShortNarration && iteration < MAX_ITERATIONS - 1) {
        console.log(`[Agent] Narration detected, nudging to act`);
        onStreamText?.('\n\n__RESET__');
        messages.push({ role: 'assistant', content: response.content as any });
        messages.push({ role: 'user', content: '[SYSTEM] You described a plan but did not execute it. Use your tools now.' });
        continue;
      }

      if (responseText && CAPABILITY_DENIAL_RE.test(responseText) && iteration < 3) {
        console.log(`[Agent] Capability denial detected, correcting`);
        onStreamText?.('\n\n__RESET__');
        messages.push({ role: 'assistant', content: response.content as any });
        messages.push({ role: 'user', content: '[SYSTEM] You have full system access: filesystem, shell, and browser. Use your tools.' });
        continue;
      }

      finalText = responseText;
      break;
    }

    if (iterationText) {
      onStreamText?.('\n\n__RESET__');
    }

    messages.push({ role: 'assistant', content: response.content as any });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      toolCallCount++;
      const startMs = Date.now();

      onToolActivity?.({ name: toolUse.name, status: 'running', detail: summarizeInput(toolUse.name, toolUse.input as any) });
      console.log(`[Agent] Tool: ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);

      let result: string;
      try {
        result = await executeTool(toolUse.name, toolUse.input as any);
      } catch (err: any) {
        result = `[Error] ${err.message}`;
      }

      const durationMs = Date.now() - startMs;
      const status = result.startsWith('[Error') ? 'error' : 'success';

      onToolActivity?.({ name: toolUse.name, status, detail: summarizeInput(toolUse.name, toolUse.input as any) });
      allToolCalls.push({ name: toolUse.name, status, detail: summarizeInput(toolUse.name, toolUse.input as any) });
      console.log(`[Agent] Result (${durationMs}ms): ${result.slice(0, 200)}`);

      if (status === 'error') {
        result += '\n[Hint: Change your approach — do not retry the same command.]';
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.slice(0, 50_000),
      });
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
    default: return JSON.stringify(input).slice(0, 60);
  }
}
