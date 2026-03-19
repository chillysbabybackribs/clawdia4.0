/**
 * Agent Loop — The core agentic execution loop.
 *
 * Phases: classify → ROUTE → build prompt → call LLM → dispatch tools → loop → respond
 *
 * NEW: Pre-LLM routing via Control Surface Registry.
 * Before the LLM acts, the routing layer:
 *   1. Detects the target app from the user message
 *   2. Loads the app's profile from the registry
 *   3. Selects the best control surface for this task
 *   4. Filters disallowed tools from the LLM's tool list
 *   5. Injects execution constraints into the system prompt
 *
 * This transforms the architecture from "LLM improvises tool choice"
 * to "System selects control surface → LLM executes within constraints."
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { BrowserWindow } from 'electron';
import { classify, type TaskProfile, type ToolGroup } from './classifier';
import { buildStaticPrompt, buildDynamicPrompt } from './prompt-builder';
import { getToolsForGroup, filterTools, executeTool } from './tool-builder';
import { AnthropicClient, resolveModelId, type LLMResponse } from './client';
import { getPromptContext } from '../db/memory';
import { getDesktopCapabilities, getGuiState, resetGuiStateForNewConversation, warmCoordinatesForApp } from './executors/desktop-executors';
import { getStateSummary } from './gui/ui-state';
import { getShortcutPromptBlock } from './gui/shortcuts';
import {
  extractAppName, discoverApps, routeTask, seedRegistry, scanHarnesses,
  recordSurfaceUsage, recordSurfaceDeviation, type ExecutionPlan,
} from '../db/app-registry';
import { IPC_EVENTS } from '../../shared/ipc-channels';

const MAX_ITERATIONS = 30;
const MAX_WALL_MS = 10 * 60 * 1000;
const MAX_HISTORY_TURNS = 16;
const WRAP_UP_THRESHOLD = 25;
const GUI_BATCH_NUDGE_AT = 2;

const NARRATION_RE = /^(?:I'll start by|Let me (?:start|begin|first)|I need to (?:first|read|check|look)|Here's my (?:plan|approach)|I want to (?:start|begin))/i;
const CAPABILITY_DENIAL_RE = /(?:I (?:can't|cannot|don't have|am unable to) (?:access|browse|execute|run|open|launch|read|write))/i;

const TOOL_RESULT_CAPS: Record<string, number> = {
  shell_exec: 10_000, file_read: 20_000, file_write: 500, file_edit: 500,
  directory_tree: 5_000, browser_search: 5_000, browser_navigate: 10_000,
  browser_read_page: 10_000, browser_click: 5_000, browser_type: 500,
  browser_extract: 10_000, browser_screenshot: 1_000, create_document: 500,
  memory_search: 3_000, memory_store: 500,
  app_control: 10_000, gui_interact: 5_000, dbus_control: 8_000,
};
const DEFAULT_RESULT_CAP = 10_000;

// Seed registry on first import
let registrySeeded = false;
function ensureRegistry(): void {
  if (registrySeeded) return;
  try { seedRegistry(); registrySeeded = true; } catch (e) { console.warn('[Registry] Seed failed:', e); }
}

export interface LoopOptions {
  apiKey: string;
  model?: string;
  onStreamText?: (text: string) => void;
  onThinking?: (thought: string) => void;
  onToolActivity?: (activity: { name: string; status: string; detail?: string }) => void;
  /** Progressive stdout/stderr chunks from shell_exec. toolId matches the running tool. */
  onToolStream?: (payload: { toolId: string; toolName: string; chunk: string }) => void;
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
  const { apiKey, onStreamText, onThinking, onToolActivity, onToolStream, onStreamEnd } = options;

  // Ensure registry is seeded
  ensureRegistry();

  const profile = classify(userMessage);
  console.log(`[Agent] Classified: group=${profile.toolGroup} modules=[${[...profile.promptModules]}] model=${profile.model} greeting=${profile.isGreeting}`);

  const modelId = pickModel(profile.model, options.model, profile.isGreeting);
  console.log(`[Agent] Using model: ${modelId}`);

  const client = new AnthropicClient(apiKey, modelId);
  const staticPrompt = buildStaticPrompt(profile.toolGroup, profile.promptModules);

  let memoryContext = '';
  if (!profile.isGreeting && userMessage.length > 10) {
    try { memoryContext = getPromptContext(500, userMessage); } catch {}
  }

  // ═══════════════════════════════════════════
  // PRE-LLM ROUTING — Control Surface Registry
  // ═══════════════════════════════════════════
  let desktopContext = '';
  let executionPlan: ExecutionPlan | null = null;
  let shortcutContext = '';
  let guiStateContext = '';

  if (profile.promptModules.has('desktop_apps')) {
    // Scan for CLI-Anything harnesses (once per session)
    try { await scanHarnesses(); } catch {}

    // Get desktop capabilities (display layout, tools, etc.)
    try { desktopContext = await getDesktopCapabilities(); } catch {}

    // Detect target app and compute execution plan
    // Fast sync check first, then async discovery if needed
    const targetApp = extractAppName(userMessage) || await discoverApps(userMessage);
    if (targetApp) {
      executionPlan = routeTask(userMessage, targetApp);
      console.log(`[Router] App: ${targetApp} → surface: ${executionPlan.selectedSurface} | reasoning: ${executionPlan.reasoning}`);
      recordSurfaceUsage(executionPlan.selectedSurface);

      // Inject keyboard shortcuts for detected app
      shortcutContext = getShortcutPromptBlock(targetApp);

      // PHASE 2: Pre-warm in-memory coordinate targets from persistent SQLite cache
      // This eliminates orientation screenshots for apps we've used before
      warmCoordinatesForApp(targetApp);
    }

    // Inject GUI state summary (focus, confidence, known targets)
    const guiState = getGuiState();
    guiStateContext = getStateSummary(guiState);
  }

  const dynamicPrompt = buildDynamicPrompt({
    model: modelId,
    toolGroup: profile.toolGroup,
    memoryContext,
    desktopContext,
    executionConstraint: executionPlan?.constraint,
    shortcutContext,
    guiStateContext,
    isGreeting: profile.isGreeting,
  });

  // Get tools for this group, then FILTER based on execution plan
  let tools = getToolsForGroup(profile.toolGroup);
  if (executionPlan && executionPlan.disallowedTools.length > 0) {
    tools = filterTools(tools, executionPlan.disallowedTools);
  }

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

    // Early batch nudge for desktop tasks using GUI
    if (!guiBatchNudgeSent && profile.promptModules.has('desktop_apps')
        && (!executionPlan || executionPlan.selectedSurface === 'gui')
        && toolCallCount >= GUI_BATCH_NUDGE_AT) {
      messages.push({
        role: 'user',
        content: '[SYSTEM] IMPORTANT: For remaining GUI steps, use gui_interact batch_actions. Do NOT make single-action gui_interact calls.',
      });
      guiBatchNudgeSent = true;
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
        messages.push({ role: 'user', content: '[SYSTEM] You have full system access. Use your tools.' });
        continue;
      }

      finalText = responseText;
      break;
    }

    if (iterationText) onStreamText?.('\n\n__RESET__');
    messages.push({ role: 'assistant', content: response.content as any });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    // ─────────────────────────────────────────────────────────────────
    // PHASE 1: Parallel tool dispatch
    //
    // Independent tools returned in the same LLM turn are dispatched
    // concurrently via Promise.all. Two tools are considered dependent
    // (and thus run sequentially) only when one references the other's
    // output by name — detected via a lightweight input-string scan.
    // GUI / desktop tools always run sequentially (order matters for
    // window state) and shell_exec is kept sequential for cwd safety.
    //
    // Typical speedup: 40-60% wall-time reduction on multi-source turns
    // (e.g. file_read + browser_search + memory_search in one LLM step).
    // ─────────────────────────────────────────────────────────────────

    const SEQUENTIAL_TOOLS = new Set([
      'gui_interact', 'app_control', 'dbus_control', 'shell_exec',
    ]);

    /**
     * Partition tool blocks into ordered batches.
     * Each batch can be dispatched with Promise.all.
     * A batch boundary is inserted whenever:
     *   - a sequential tool is encountered, OR
     *   - a tool's input string references the name of a previous tool
     *     (lightweight cross-reference detection).
     */
    function partitionIntoBatches(
      blocks: Anthropic.ToolUseBlock[],
    ): Anthropic.ToolUseBlock[][] {
      const batches: Anthropic.ToolUseBlock[][] = [];
      let current: Anthropic.ToolUseBlock[] = [];
      const seenNames: string[] = [];

      for (const block of blocks) {
        const isSeq = SEQUENTIAL_TOOLS.has(block.name);
        const inputStr = JSON.stringify(block.input).toLowerCase();
        const referencesPrev = seenNames.some(n => inputStr.includes(n.toLowerCase()));

        if (isSeq || referencesPrev) {
          // Flush whatever is in current, then put this block alone
          if (current.length > 0) { batches.push(current); current = []; }
          batches.push([block]);
        } else {
          current.push(block);
        }
        seenNames.push(block.name);
      }
      if (current.length > 0) batches.push(current);
      return batches;
    }

    const batches = partitionIntoBatches(toolUseBlocks);
    const parallelBatchCount = batches.filter(b => b.length > 1).length;
    if (parallelBatchCount > 0) {
      console.log(`[Agent] Parallel dispatch: ${toolUseBlocks.length} tools → ${batches.length} batch(es), ${parallelBatchCount} parallel`);
    }

    for (const batch of batches) {
      // Fire all tools in this batch concurrently
      const batchResults = await Promise.all(batch.map(async (toolUse) => {
        toolCallCount++;
        const startMs = Date.now();
        const detail = summarizeInput(toolUse.name, toolUse.input as any);

        onToolActivity?.({ name: toolUse.name, status: 'running', detail });
        console.log(`[Agent] Tool #${toolCallCount}: ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);

        let result: string;
        try {
          const chunkCb = onToolStream
            ? (tn: string, chunk: string) => onToolStream({ toolId: toolUse.id, toolName: tn, chunk })
            : undefined;
          result = await executeTool(toolUse.name, toolUse.input as any, chunkCb);
        }
        catch (err: any) { result = `[Error] ${err.message}`; }

        const durationMs = Date.now() - startMs;
        const status = result.startsWith('[Error') ? 'error' : 'success';

        onToolActivity?.({ name: toolUse.name, status, detail });
        allToolCalls.push({ name: toolUse.name, status, detail });
        console.log(`[Agent] Result (${durationMs}ms): ${result.slice(0, 200)}`);

        // Phase 5: Track surface deviations
        if (executionPlan?.appId && executionPlan.selectedSurface) {
          recordSurfaceDeviation(executionPlan.appId, executionPlan.selectedSurface, toolUse.name);
        }

        if (status === 'error') result += '\n[Hint: Change your approach — do not retry the same command.]';

        const cap = TOOL_RESULT_CAPS[toolUse.name] || DEFAULT_RESULT_CAP;
        if (result.length > cap) {
          result = result.slice(0, cap) + `\n\n[Truncated — ${result.length} chars, showing first ${cap}]`;
        }

        return { id: toolUse.id, content: result } as const;
      }));

      // Preserve original LLM-returned order in the tool_results array
      for (const r of batchResults) {
        toolResults.push({ type: 'tool_result', tool_use_id: r.id, content: r.content });
      }
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
