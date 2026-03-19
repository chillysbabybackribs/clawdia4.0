/**
 * Agent Loop — The core agentic execution loop.
 *
 * Phases: classify → ROUTE → build prompt → call LLM → dispatch tools → loop → respond
 *
 * Decomposed into:
 *   loop-setup.ts    — Pre-LLM parallel setup (memory, recall, desktop routing)
 *   loop-dispatch.ts — Parallel tool dispatch with batching and escalation
 *   loop-recovery.ts — Post-loop file verification and recovery iteration
 *   loop.ts          — This file: orchestrator that ties everything together
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { BrowserWindow } from 'electron';
import { classify, type TaskProfile, type ToolGroup } from './classifier';
import { buildStaticPrompt, buildDynamicPrompt } from './prompt-builder';
import { getToolsForGroup, filterTools } from './tool-builder';
import { AnthropicClient, resolveModelId, type LLMResponse } from './client';
import { seedRegistry, type ExecutionPlan } from '../db/app-registry';
import { savePlaybook } from '../db/browser-playbooks';
import { type VerificationResult } from './verification';
import { fireNestedCancel } from './loop-cancel';
import { runPreLLMSetup } from './loop-setup';
import { dispatchTools, type DispatchContext } from './loop-dispatch';
import { verifyFileOutcomes, runRecoveryIteration, logVerificationSummary } from './loop-recovery';

const MAX_ITERATIONS = 50;
const MAX_WALL_MS = 10 * 60 * 1000;
const MAX_HISTORY_TURNS = 16;
const MAX_HISTORY_TOKENS = 80_000;
const WRAP_UP_THRESHOLD = 25;
const GUI_BATCH_NUDGE_AT = 2;

const NARRATION_RE = /^(?:I'll start by|Let me (?:start|begin|first)|I need to (?:first|read|check|look)|Here's my (?:plan|approach)|I want to (?:start|begin))/i;
const CAPABILITY_DENIAL_RE = /(?:I (?:can't|cannot|don't have|am unable to) (?:access|browse|execute|run|open|launch|read|write))/i;

// Seed registry on first import
let registrySeeded = false;
function ensureRegistry(): void {
  if (registrySeeded) return;
  try { seedRegistry(); registrySeeded = true; } catch (e) { console.warn('[Registry] Seed failed:', e); }
}

// ═══════════════════════════════════
// Loop Control — Cancel, Pause, Add Context
// ═══════════════════════════════════

let activeAbortController: AbortController | null = null;
let isPaused = false;
let pauseResolve: (() => void) | null = null;
let pendingContext: string | null = null;

export function cancelLoop(): void {
  if (activeAbortController) {
    activeAbortController.abort();
    console.log('[Loop] Cancel requested');
  }
  fireNestedCancel();   // abort harness generation if running
  if (pauseResolve) { pauseResolve(); pauseResolve = null; }
  isPaused = false;
}

export function pauseLoop(): void {
  isPaused = true;
  console.log('[Loop] Pause requested — will hold after current iteration');
}

export function resumeLoop(): void {
  isPaused = false;
  if (pauseResolve) { pauseResolve(); pauseResolve = null; console.log('[Loop] Resumed'); }
}

export function addContext(text: string): void {
  pendingContext = text;
  console.log(`[Loop] Context queued (${text.length} chars) — will inject on next iteration`);
  if (isPaused) resumeLoop();
}

function waitIfPaused(): Promise<void> {
  if (!isPaused) return Promise.resolve();
  return new Promise<void>((resolve) => { pauseResolve = resolve; });
}

function isCancelled(): boolean {
  return activeAbortController?.signal.aborted ?? false;
}

// ═══════════════════════════════════
// Types + Helpers
// ═══════════════════════════════════

export interface LoopOptions {
  apiKey: string;
  model?: string;
  onStreamText?: (text: string) => void;
  onThinking?: (thought: string) => void;
  onToolActivity?: (activity: { name: string; status: string; detail?: string }) => void;
  onToolStream?: (payload: { toolId: string; toolName: string; chunk: string }) => void;
  onStreamEnd?: () => void;
  onPaused?: () => void;
  onResumed?: () => void;
  onProgress?: (text: string) => void;  // narration during pre-LLM setup
  window?: BrowserWindow;
}

function pickModel(classifierModel: string, storedModel?: string, isGreeting?: boolean): string {
  if (isGreeting) return resolveModelId('haiku');
  if (classifierModel === 'opus') return resolveModelId('opus');
  if (storedModel) return storedModel;
  return resolveModelId(classifierModel);
}

function estimateTokens(msg: Anthropic.MessageParam): number {
  if (typeof msg.content === 'string') return Math.ceil(msg.content.length / 4);
  if (Array.isArray(msg.content)) {
    let total = 0;
    for (const block of msg.content as any[]) {
      if (block.type === 'text') total += Math.ceil((block.text?.length || 0) / 4);
      else if (block.type === 'tool_use') total += Math.ceil(JSON.stringify(block.input || {}).length / 4) + 20;
      else if (block.type === 'tool_result') total += Math.ceil((typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content || '').length) / 4);
      else total += 50;
    }
    return total;
  }
  return 50;
}

function trimHistory(history: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  let trimmed = history.length > MAX_HISTORY_TURNS
    ? history.slice(-MAX_HISTORY_TURNS) : [...history];
  let totalTokens = trimmed.reduce((sum, m) => sum + estimateTokens(m), 0);
  while (totalTokens > MAX_HISTORY_TOKENS && trimmed.length > 2) {
    const dropped = trimmed.shift()!;
    totalTokens -= estimateTokens(dropped);
  }
  if (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed.shift();
  const droppedCount = history.length - trimmed.length;
  if (droppedCount > 0) {
    console.log(`[Agent] History trimmed: kept ${trimmed.length} of ${history.length} messages (~${Math.round(totalTokens / 1000)}K tokens)`);
  }
  return trimmed;
}

// ═══════════════════════════════════
// Main Loop
// ═══════════════════════════════════

export async function runAgentLoop(
  userMessage: string,
  history: Anthropic.MessageParam[],
  options: LoopOptions,
): Promise<{ response: string; toolCalls: { name: string; status: string; detail?: string }[] }> {
  const { apiKey, onStreamText, onThinking, onToolActivity, onToolStream, onStreamEnd } = options;

  activeAbortController = new AbortController();
  isPaused = false;
  pendingContext = null;
  ensureRegistry();

  // ── Classify ──
  const profile = classify(userMessage);
  console.log(`[Agent] Classified: group=${profile.toolGroup} modules=[${[...profile.promptModules]}] model=${profile.model} greeting=${profile.isGreeting}`);

  const modelId = pickModel(profile.model, options.model, profile.isGreeting);
  console.log(`[Agent] Using model: ${modelId}`);

  const client = new AnthropicClient(apiKey, modelId);
  const staticPrompt = buildStaticPrompt(profile.toolGroup, profile.promptModules);

  // ── Pre-LLM Setup (extracted to loop-setup.ts) ──
  const setup = await runPreLLMSetup(userMessage, profile, apiKey, options.onProgress);
  const { executionPlan } = setup;

  // ── Build dynamic prompt ──
  const dynamicPrompt = buildDynamicPrompt({
    model: modelId,
    toolGroup: profile.toolGroup,
    memoryContext: setup.memoryContext,
    recallContext: setup.recallContext,
    siteContext: setup.siteContext,
    playbookContext: setup.playbookContext,
    desktopContext: setup.desktopContext,
    executionConstraint: executionPlan?.constraint,
    shortcutContext: setup.shortcutContext,
    guiStateContext: setup.guiStateContext,
    isGreeting: profile.isGreeting,
  });

  // ── Prepare tools ──
  let tools = getToolsForGroup(profile.toolGroup);
  if (executionPlan && executionPlan.disallowedTools.length > 0) {
    tools = filterTools(tools, executionPlan.disallowedTools);
  }

  // ── Prepare message history ──
  const trimmedHistory = trimHistory(history);
  const messages: Anthropic.MessageParam[] = [...trimmedHistory, { role: 'user', content: userMessage }];

  // ── Dispatch context (mutable, shared with loop-dispatch) ──
  const dispatchCtx: DispatchContext = {
    tools,
    executionPlan,
    toolGroup: profile.toolGroup,
    escalatedToFull: false,
    toolCallCount: 0,
    allToolCalls: [],
    allVerifications: [],
    onToolActivity,
    onToolStream,
  };

  let guiBatchNudgeSent = false;
  const startTime = Date.now();
  let finalText = '';

  // ═══════════════════════════════════
  // Iteration Loop
  // ═══════════════════════════════════

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (Date.now() - startTime > MAX_WALL_MS) {
      console.warn(`[Agent] Wall time limit reached at iteration ${iteration}`);
      break;
    }

    // ── Loop control gate ──
    if (isCancelled()) {
      console.log(`[Agent] Cancelled at iteration ${iteration}`);
      finalText = finalText || '[Cancelled by user]';
      break;
    }

    if (isPaused) {
      options.onPaused?.();
      onThinking?.('Paused — waiting to resume...');
      await waitIfPaused();
      if (isCancelled()) { finalText = '[Cancelled by user]'; break; }
      options.onResumed?.();
    }

    // Inject pending user context
    if (pendingContext !== null) {
      const ctx: string = pendingContext;
      pendingContext = null;
      messages.push({ role: 'user', content: `[USER CONTEXT] ${ctx}` });
      console.log(`[Agent] Injected user context: ${ctx.slice(0, 80)}`);
    }

    onThinking?.('Thinking...');

    // ── Mid-loop injections ──
    if (!guiBatchNudgeSent && profile.promptModules.has('desktop_apps')
        && (!executionPlan || executionPlan.selectedSurface === 'gui')
        && dispatchCtx.toolCallCount >= GUI_BATCH_NUDGE_AT) {
      messages.push({
        role: 'user',
        content: '[SYSTEM] IMPORTANT: For remaining GUI steps, use gui_interact batch_actions. Do NOT make single-action gui_interact calls.',
      });
      guiBatchNudgeSent = true;
    }

    if (dispatchCtx.toolCallCount >= WRAP_UP_THRESHOLD && !profile.isGreeting) {
      messages.push({ role: 'user', content: `[SYSTEM] ${dispatchCtx.toolCallCount} tool calls used (limit: ${MAX_ITERATIONS}). Wrap up.` });
    }

    // ── LLM Call ──
    let iterationText = '';
    let response: LLMResponse;

    try {
      response = await client.chat(messages, profile.isGreeting ? [] : dispatchCtx.tools, staticPrompt, dynamicPrompt, (chunk) => {
        iterationText += chunk;
        onStreamText?.(chunk);
      }, { signal: activeAbortController?.signal });
    } catch (err: any) {
      if (err.name === 'AbortError' || isCancelled()) {
        console.log('[Agent] LLM call aborted by user');
        finalText = finalText || iterationText || '[Cancelled by user]';
        break;
      }
      console.error(`[Agent] LLM error:`, err.message);
      finalText = `I encountered an error: ${err.message}`;
      break;
    }

    onThinking?.('');

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const responseText = textBlocks.map(b => b.text).join('');

    // ── No tools → check for narration/denial or return ──
    if (toolUseBlocks.length === 0) {
      const isShortNarration = iteration === 0 && responseText.length < 300 && NARRATION_RE.test(responseText) && dispatchCtx.toolCallCount === 0;

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

    // ── Tool dispatch (extracted to loop-dispatch.ts) ──
    if (iterationText) onStreamText?.('\n\n__RESET__');
    messages.push({ role: 'assistant', content: response.content as any });

    const toolResults = await dispatchTools(toolUseBlocks, dispatchCtx);
    messages.push({ role: 'user', content: toolResults as any });

    // Escalation notice
    if (dispatchCtx.escalatedToFull && !messages.some(m =>
      typeof m.content === 'string' && m.content.includes('[SYSTEM] Additional tools are now available'),
    )) {
      messages.push({
        role: 'user',
        content: '[SYSTEM] Additional tools are now available. Your tool set has been expanded. Proceed with your task.',
      });
    }

    if (iteration === MAX_ITERATIONS - 1) {
      finalText = responseText || '[Reached iteration limit.]';
    }
  }

  onStreamEnd?.();

  // ── Post-loop verification + recovery (extracted to loop-recovery.ts) ──
  if (finalText && !finalText.startsWith('[Cancelled') && !profile.isGreeting && dispatchCtx.allToolCalls.length > 0) {
    const issue = verifyFileOutcomes(finalText, dispatchCtx.allToolCalls);
    if (issue) {
      finalText = await runRecoveryIteration(issue, finalText, {
        client,
        messages,
        tools: dispatchCtx.tools,
        staticPrompt,
        dynamicPrompt,
        signal: activeAbortController?.signal,
        onStreamText,
        onToolActivity,
        allToolCalls: dispatchCtx.allToolCalls,
        toolCallCount: dispatchCtx.toolCallCount,
      });
      onStreamEnd?.();
    }
  }

  // ── Background memory extraction ──
  if (!profile.isGreeting && finalText.length > 50 && userMessage.length > 20) {
    try {
      const { extractMemoryInBackground } = await import('./memory-extractor');
      extractMemoryInBackground(apiKey, userMessage, finalText);
    } catch { /* non-fatal */ }
  }

  // ── Save playbook ──
  const browserToolCalls = dispatchCtx.allToolCalls.filter(tc =>
    tc.name.startsWith('browser_') && tc.status === 'success',
  );
  if (browserToolCalls.length >= 2 && finalText && !finalText.startsWith('[Cancelled')) {
    try {
      savePlaybook(
        userMessage,
        browserToolCalls.map(tc => ({
          name: tc.name,
          input: tc.input || {},
          summary: tc.detail || tc.name,
        })),
      );
    } catch { /* non-fatal */ }
  }

  // ── Verification summary ──
  logVerificationSummary(dispatchCtx.allVerifications);

  // Clean up
  activeAbortController = null;
  isPaused = false;
  pendingContext = null;
  pauseResolve = null;

  return { response: finalText, toolCalls: dispatchCtx.allToolCalls };
}
