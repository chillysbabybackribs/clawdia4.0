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

import type { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { classify, hasStrongYtdlpIntent, type TaskProfile, type ToolGroup } from './classifier';
import { applyAgentProfileOverride } from './agent-profile-override';
import { isFilesystemQuoteLookupTask } from './filesystem-agent-routing';
import { buildStaticPrompt, buildDynamicPrompt } from './prompt-builder';
import { getToolsForGroup, filterTools } from './tool-builder';
import { createProviderClient, resolveModelForProvider, type LLMResponse, type NormalizedMessage, type NormalizedTextBlock, type NormalizedToolResultBlock, type NormalizedToolUseBlock } from './client';
import * as appRegistry from '../db/app-registry';
import type { ExecutionPlan } from '../db/app-registry';
import { savePlaybook, shouldAutoSavePlaybook, validatePlaybookCandidate, writeBloodhoundExecutorArtifacts, executeSavedBloodhoundPlaybook } from '../db/browser-playbooks';
import { type VerificationResult } from './verification';
import { fireNestedCancel, registerNestedCancel, clearNestedCancel } from './loop-cancel';
import { runYtdlpPipeline, type YtdlpResult } from './loop-ytdlp';
import { runPreLLMSetup } from './loop-setup';
import { dispatchTools, type DispatchContext } from './loop-dispatch';
import { buildEvidenceLedgerPromptBlock, createEvidenceLedgerState } from './evidence-ledger';
import { verifyFileOutcomes, runRecoveryIteration, logVerificationSummary } from './loop-recovery';
import { createExecutionPlan, requireExecutionPlanApproval, shouldCreateExecutionPlan } from './workflow';
import { cancelPendingApprovals } from './approval-manager';
import { cancelPendingHumanInterventions } from './human-intervention-manager';
import { appendRunEvent } from '../db/run-events';
import { upsertRunArtifact } from '../db/run-artifacts';
import { getSelectedPerformanceStance, getUnrestrictedMode } from '../store';
import type { AgentProfile, PerformanceStance, ProviderId } from '../../shared/types';
import { setProcessAgentProfile, setProcessExecutionInfo, setProcessWorkflowStage } from './process-manager';
import { countRunBackgroundTabs, getCurrentUrl, preserveRunBackgroundTabs, runHarness } from '../browser/manager';
import { prepareHarnessExecutionFromMessage } from '../browser/site-harness';
import { calendarList } from '../db/calendar';
import type { NormalizedMessageContentBlock } from './provider/types';
import { EXECUTION_PLANNING_ENABLED, LOOP_MAX_WALL_MS } from './runtime-constraints';
import { getSystemAuditSummary, getSystemAwarenessBlock } from './system-audit';
import {
  applyInLoopHarnessAdjustment,
  applyHarnessPromptModules,
  applyHarnessToolPolicy,
  buildHarnessDirectiveBlock,
  createRuntimeHarnessReactiveState,
  formatResolvedHarnessDebug,
  resolveHarness,
  type HarnessResolutionInput,
  type RuntimeHarnessSignal,
} from './harness-resolver';

const MAX_ITERATIONS = 50;
const MAX_HISTORY_TURNS = 16;
const MAX_HISTORY_TOKENS = 80_000;
const WRAP_UP_THRESHOLD = 25;
const GUI_BATCH_NUDGE_AT = 2;
const MAX_BROWSER_SEARCH_ROUNDS = 2;
const MAX_BROWSER_INSPECTED_TARGETS = 6;
const MAX_BROWSER_SCROLL_FALLBACKS_PER_TARGET = 2;
const MAX_BROWSER_BACKGROUND_TABS = 6;

const NARRATION_RE = /^(?:I'll start by|Let me (?:start|begin|first)|I need to (?:first|read|check|look)|Here's my (?:plan|approach)|I want to (?:start|begin)|I'll (?:begin|first)|To (?:start|begin|complete|accomplish|do) this|First,? I(?:'ll| will| need)|I'm going to start)/i;
const CAPABILITY_DENIAL_RE = /(?:I (?:can't|cannot|don't have|am unable to|lack the ability to|do not have) (?:access|browse|execute|run|open|launch|read|write|interact with|control|use))/i;
const MULTI_STEP_CONNECTOR_RE = /\b(and then|then|after that|afterwards|next|followed by)\b/i;

interface BrowserRuntimeBudgetState {
  searchRounds: number;
  inspectedTargets: Set<string>;
  scrollFallbackCounts: Map<string, number>;
  lastTargetKey: string | null;
  pendingBackgroundTabIds: string[];
  successfulExtractions: number;
  successfulArticleOrListingExtractions: number;
  successfulDiscussionExtractions: number;
  firstWaveComplete: boolean;
}

function inferBrowserTargetKey(toolName: string, input: Record<string, any>, fallbackTargetKey?: string | null): string | null {
  if (typeof input.tabId === 'string' && input.tabId.trim()) return `tab:${input.tabId.trim()}`;
  if (typeof input.url === 'string' && input.url.trim()) return `url:${input.url.trim()}`;
  if (toolName.startsWith('browser_') && typeof input.__runId === 'string' && input.__runId.trim()) {
    return fallbackTargetKey || `run:${input.__runId.trim()}:active`;
  }
  return fallbackTargetKey || null;
}

function detectBrowserPolicyViolation(
  toolUseBlocks: NormalizedToolUseBlock[],
  state: BrowserRuntimeBudgetState,
  runId?: string,
): string | null {
  const requestedBackgroundOpens = toolUseBlocks.filter((block) => block.name === 'browser_tab_open_background').length;
  const hasSinglePageTunnelTurn =
    state.searchRounds >= 1
    && state.successfulExtractions === 0
    && state.pendingBackgroundTabIds.length === 0
    && requestedBackgroundOpens === 0
    && toolUseBlocks.some((block) => ['browser_navigate', 'browser_read_page', 'browser_scroll'].includes(block.name));
  if (hasSinglePageTunnelTurn) {
    return 'Before drilling into one page, open a small balanced first wave of promising sources in parallel and inspect those first. Prefer 2 guide/review sources plus 1 listing or store source.';
  }

  if (state.firstWaveComplete) {
    const hasNewSearch = toolUseBlocks.some((block) => block.name === 'browser_search');
    if (hasNewSearch) {
      return 'The first evidence wave is already complete. Do not issue more browser_search calls unless a required field is still missing from the current sources.';
    }
    if (requestedBackgroundOpens > 0) {
      return 'The first evidence wave is already complete. Use the sources you already opened and synthesize before opening more tabs.';
    }
    const hasReadPressure = toolUseBlocks.some((block) => block.name === 'browser_read_page');
    const hasFreshExtract = toolUseBlocks.some((block) => block.name === 'browser_extract');
    if (hasReadPressure && !hasFreshExtract && state.successfulArticleOrListingExtractions >= 2) {
      return 'You already have a successful first-wave extract batch. Avoid browser_read_page unless a specific missing field cannot be obtained from the extracted results.';
    }
  }

  const hasUntargetedInspectWithPendingTabs = state.pendingBackgroundTabIds.length > 0
    && toolUseBlocks.some((block) => ['browser_navigate', 'browser_extract', 'browser_read_page'].includes(block.name)
      && !(typeof (block.input as Record<string, any>)?.tabId === 'string' && String((block.input as Record<string, any>).tabId).trim()));
  if (hasUntargetedInspectWithPendingTabs) {
    const tabIds = state.pendingBackgroundTabIds.slice(0, 6).join(', ');
    return `Background tabs are already open. Target inspection explicitly with tabId instead of using the active tab. Pending tabIds: ${tabIds}`;
  }

  const hasSearch = toolUseBlocks.some((block) => block.name === 'browser_search');
  if (hasSearch && state.searchRounds >= MAX_BROWSER_SEARCH_ROUNDS) {
    return 'Search budget reached. Select from the sources you already found and inspect or synthesize instead of issuing more browser_search calls.';
  }

  if (requestedBackgroundOpens > 0 && runId) {
    const openTabs = countRunBackgroundTabs(runId);
    if (openTabs + requestedBackgroundOpens > MAX_BROWSER_BACKGROUND_TABS) {
      return 'Background tab budget reached. Close stale background tabs or use the sources you already opened before opening more.';
    }
  }

  const projectedTargets = new Set(state.inspectedTargets);
  for (const block of toolUseBlocks) {
    if (!['browser_navigate', 'browser_extract', 'browser_read_page'].includes(block.name)) continue;
    const targetKey = inferBrowserTargetKey(block.name, block.input as Record<string, any>, state.lastTargetKey);
    if (targetKey) projectedTargets.add(targetKey);
  }
  if (projectedTargets.size > MAX_BROWSER_INSPECTED_TARGETS) {
    return 'Inspection budget reached. Use the evidence from the current pages and synthesize instead of opening or inspecting additional sources.';
  }

  for (const block of toolUseBlocks) {
    if (block.name !== 'browser_scroll') continue;
    const targetKey = inferBrowserTargetKey(block.name, block.input as Record<string, any>, state.lastTargetKey) || 'active';
    if ((state.scrollFallbackCounts.get(targetKey) || 0) >= MAX_BROWSER_SCROLL_FALLBACKS_PER_TARGET) {
      return 'Scroll fallback budget reached on the current page. Use browser_extract or browser_read_page once, or finish from the evidence already gathered.';
    }
  }

  return null;
}

function updateBrowserBudgetState(
  toolUseBlocks: NormalizedToolUseBlock[],
  toolResults: NormalizedToolResultBlock[],
  state: BrowserRuntimeBudgetState,
): void {
  if (toolUseBlocks.some((block) => block.name === 'browser_search')) {
    state.searchRounds += 1;
  }

  toolUseBlocks.forEach((block, index) => {
    const result = toolResults[index];
    const content = typeof result?.content === 'string'
      ? result.content
      : Array.isArray(result?.content)
        ? result.content.map((entry) => ('text' in entry ? entry.text : '')).join('\n')
        : '';
    const failed = result?.is_error === true || /^\[Error/.test(content);
    if (failed) return;

    const input = block.input as Record<string, any>;
    const targetKey = inferBrowserTargetKey(block.name, input, state.lastTargetKey) || 'active';
    if (['browser_navigate', 'browser_extract', 'browser_read_page'].includes(block.name)) {
      state.inspectedTargets.add(targetKey);
      state.lastTargetKey = targetKey;
      if (typeof input.tabId === 'string' && input.tabId.trim()) {
        state.pendingBackgroundTabIds = state.pendingBackgroundTabIds.filter((tabId) => tabId !== input.tabId.trim());
      }
      if (block.name === 'browser_extract') {
        const extractedPageType = extractStructuredPageType(content);
        if (extractedPageType) {
          state.successfulExtractions += 1;
          if (extractedPageType === 'article' || extractedPageType === 'listing') {
            state.successfulArticleOrListingExtractions += 1;
          } else if (extractedPageType === 'discussion') {
            state.successfulDiscussionExtractions += 1;
          }
          state.firstWaveComplete =
            state.successfulArticleOrListingExtractions >= 2
            || state.successfulExtractions >= 3
            || (state.successfulArticleOrListingExtractions >= 1 && state.successfulDiscussionExtractions >= 1 && state.successfulExtractions >= 2);
        }
      }
    } else if (block.name === 'browser_scroll') {
      state.lastTargetKey = targetKey;
      state.scrollFallbackCounts.set(targetKey, (state.scrollFallbackCounts.get(targetKey) || 0) + 1);
    } else if (block.name === 'browser_tab_open_background') {
      const openedTabId = extractOpenedBackgroundTabId(content);
      if (openedTabId && !state.pendingBackgroundTabIds.includes(openedTabId)) {
        state.pendingBackgroundTabIds.push(openedTabId);
        state.lastTargetKey = `tab:${openedTabId}`;
      } else {
        state.lastTargetKey = targetKey;
      }
    } else if (block.name === 'browser_tab_close_background' && typeof input.tabId === 'string' && input.tabId.trim()) {
      state.pendingBackgroundTabIds = state.pendingBackgroundTabIds.filter((tabId) => tabId !== input.tabId.trim());
    }
  });
}

function extractOpenedBackgroundTabId(content: string): string | null {
  if (!content || /^\[Error/.test(content)) return null;
  try {
    const parsed = JSON.parse(content);
    return typeof parsed?.tabId === 'string' && parsed.tabId.trim() ? parsed.tabId.trim() : null;
  } catch {
    return null;
  }
}

function extractStructuredPageType(content: string): string | null {
  if (!content || /^\[Error/.test(content)) return null;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    return typeof parsed.pageType === 'string' && parsed.pageType.trim() ? parsed.pageType.trim() : null;
  } catch {
    return null;
  }
}

function buildBlockedToolResults(
  toolUseBlocks: NormalizedToolUseBlock[],
  message: string,
): NormalizedToolResultBlock[] {
  return toolUseBlocks.map((block) => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content: `[Error] ${message}`,
    is_error: true,
  }));
}

function detectToolPolicyViolation(toolUseBlocks: NormalizedToolUseBlock[]): string | null {
  for (const block of toolUseBlocks) {
    if (block.name !== 'create_document') continue;
    const input = block.input as Record<string, any>;
    const rawFilename = String(input?.filename || '').trim();
    if (rawFilename && path.isAbsolute(rawFilename)) {
      return 'create_document does not accept explicit absolute output paths. Use file_write for absolute paths like /home/... and reserve create_document for default artifact locations.';
    }
  }
  return null;
}

// Seed registry on first import
let registrySeeded = false;
function ensureRegistry(): void {
  if (registrySeeded) return;
  try {
    const seed = typeof appRegistry.seedRegistry === 'function' ? appRegistry.seedRegistry : null;
    if (!seed) {
      console.warn('[Registry] Seed skipped: seedRegistry export unavailable');
      registrySeeded = true;
      return;
    }
    seed();
    registrySeeded = true;
  } catch (e) {
    console.warn('[Registry] Seed failed:', e);
  }
}

// ═══════════════════════════════════
// Loop Control — Cancel, Pause, Add Context
// ═══════════════════════════════════

interface RunLoopControl {
  abortController: AbortController;
  isPaused: boolean;
  pauseResolve: (() => void) | null;
  pendingContext: string | null;
  performanceStance: PerformanceStance;
}

const runControls = new Map<string, RunLoopControl>();
const DEFAULT_RUN_KEY = '__default__';

export function cancelLoop(runId?: string): boolean {
  const state = getRunControl(runId);
  if (!state) return false;

  state.abortController.abort();
  console.log(`[Loop] Cancel requested${runId ? ` for ${runId}` : ''}`);
  cancelPendingApprovals(getRunKey(runId));
  cancelPendingHumanInterventions(getRunKey(runId));
  fireNestedCancel();   // abort harness generation if running
  if (state.pauseResolve) { state.pauseResolve(); state.pauseResolve = null; }
  state.isPaused = false;
  return true;
}

export function pauseLoop(runId?: string): boolean {
  const state = getRunControl(runId);
  if (!state) return false;

  state.isPaused = true;
  console.log(`[Loop] Pause requested${runId ? ` for ${runId}` : ''} — will hold after current iteration`);
  return true;
}

export function resumeLoop(runId?: string): boolean {
  const state = getRunControl(runId);
  if (!state) return false;

  state.isPaused = false;
  if (state.pauseResolve) {
    state.pauseResolve();
    state.pauseResolve = null;
    console.log(`[Loop] Resumed${runId ? ` for ${runId}` : ''}`);
  }
  return true;
}

export function addContext(runId: string | undefined, text: string): boolean {
  const state = getRunControl(runId);
  if (!state) return false;

  state.pendingContext = text;
  console.log(`[Loop] Context queued for ${getRunKey(runId)} (${text.length} chars) — will inject on next iteration`);
  if (state.isPaused) resumeLoop(runId);
  return true;
}

function waitIfPaused(state: RunLoopControl): Promise<void> {
  if (!state.isPaused) return Promise.resolve();
  return new Promise<void>((resolve) => { state.pauseResolve = resolve; });
}

function isCancelled(state: RunLoopControl): boolean {
  return state.abortController.signal.aborted;
}

function detectPerformanceStanceDirective(text: string): PerformanceStance | null {
  if (!text) return null;
  if (/\b(be more aggressive|go hard|take a bigger swing|max(?:imize)? performance|be more autonomous|push harder|up my performance dramatically)\b/i.test(text)) {
    return 'aggressive';
  }
  if (/\b(be conservative|be careful|slow down|be safer|smaller changes)\b/i.test(text)) {
    return 'conservative';
  }
  if (/\b(back to normal|standard mode|balanced mode)\b/i.test(text)) {
    return 'standard';
  }
  return null;
}

// ═══════════════════════════════════
// Types + Helpers
// ═══════════════════════════════════

export interface LoopOptions {
  runId?: string;
  provider: ProviderId;
  forcedAgentProfile?: AgentProfile;
  allowedTools?: string[];
  graphExecutionMode?: 'auto' | 'disabled';
  parentSignal?: AbortSignal;
  maxIterations?: number;
  apiKey: string;
  model?: string;
  onStreamText?: (text: string) => void;
  onThinking?: (thought: string) => void;
  onToolActivity?: (activity: { name: string; status: string; detail?: string }) => void;
  onToolStream?: (payload: { toolId: string; toolName: string; chunk: string }) => void;
  onWorkflowPlanReset?: () => void;
  onWorkflowPlanText?: (text: string) => void;
  onWorkflowPlanEnd?: () => void;
  onStreamEnd?: () => void;
  onPaused?: () => void;
  onResumed?: () => void;
  onProgress?: (text: string) => void;  // narration during pre-LLM setup
  window?: BrowserWindow;
  initialUserContent?: string | NormalizedMessageContentBlock[];
}

function pickModel(provider: ProviderId, classifierModel: string, storedModel?: string, isGreeting?: boolean): string {
  if (isGreeting) return resolveModelForProvider(provider, 'haiku');
  if (classifierModel === 'opus') return resolveModelForProvider(provider, 'opus');
  if (storedModel) return resolveModelForProvider(provider, storedModel);
  return resolveModelForProvider(provider, classifierModel);
}

function estimateTokens(msg: NormalizedMessage): number {
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

function hasOnlyToolResults(msg: NormalizedMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as any[]).every((b: any) => b.type === 'tool_result');
}

function trimHistory(history: NormalizedMessage[]): NormalizedMessage[] {
  let trimmed = history.length > MAX_HISTORY_TURNS
    ? history.slice(-MAX_HISTORY_TURNS) : [...history];
  let totalTokens = trimmed.reduce((sum, m) => sum + estimateTokens(m), 0);
  while (totalTokens > MAX_HISTORY_TOKENS && trimmed.length > 2) {
    const dropped = trimmed.shift()!;
    totalTokens -= estimateTokens(dropped);
  }
  // Drop any leading assistant turn — history must start with user
  if (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed.shift();
  // Drop any leading user turns that are purely tool_results — their paired
  // assistant tool_use blocks were already trimmed off, leaving orphaned IDs that
  // Anthropic and OpenAI will reject. Repeat in case removing one exposes another.
  // Uses .every() not .some() — mixed text+tool_result messages are preserved.
  while (trimmed.length > 0 && trimmed[0].role === 'user' && hasOnlyToolResults(trimmed[0])) {
    totalTokens -= estimateTokens(trimmed[0]);
    trimmed.shift();
    // The orphaned tool_result's assistant is now at the front — drop it too
    const nextFront = trimmed[0];
    if (nextFront && nextFront.role === 'assistant') {
      totalTokens -= estimateTokens(nextFront);
      trimmed.shift();
    }
  }
  const droppedCount = history.length - trimmed.length;
  if (droppedCount > 0) {
    console.log(`[Agent] History trimmed: kept ${trimmed.length} of ${history.length} messages (~${Math.round(totalTokens / 1000)}K tokens)`);
  }
  return trimmed;
}

function shouldForceContinuationAfterPartialExecution(
  userMessage: string,
  toolCalls: { name: string; status: string }[],
): string | null {
  const successfulToolCalls = toolCalls.filter((call) => call.status === 'success');
  if (successfulToolCalls.length === 0) return null;

  const lower = userMessage.toLowerCase();
  const successfulNames = new Set(successfulToolCalls.map((call) => call.name));

  const wantsSearch = /\b(search|look up)\b/i.test(userMessage);
  const wantsOpenOrNavigate = /\b(open|launch|navigate|go to|visit)\b/i.test(userMessage);
  const isMultiStep = MULTI_STEP_CONNECTOR_RE.test(userMessage) || (wantsSearch && wantsOpenOrNavigate);

  if (!isMultiStep) return null;

  const hasSearchExecution =
    successfulNames.has('browser_search') ||
    successfulNames.has('browser_type') ||
    successfulNames.has('browser_extract') ||
    successfulNames.has('browser_read_page');

  if (wantsSearch && !hasSearchExecution) {
    return `You only completed the setup/open step. Continue until the full request is done: "${userMessage}". Opening or launching the site is not enough; perform the requested search and then respond.`;
  }

  if (successfulToolCalls.length === 1) {
    const firstTool = successfulToolCalls[0]?.name;
    if (firstTool === 'app_control' || firstTool === 'browser_navigate') {
      return `You only completed the first step of a multi-step request. Continue executing the remaining steps for: "${userMessage}". Do not stop after the initial open/navigate action.`;
    }
  }

  if (/\bsearch google for\b/i.test(lower) && !successfulNames.has('browser_search')) {
    return `The user asked you to search Google, not just open it. Continue executing the search for: "${userMessage}".`;
  }

  return null;
}

export function isExplicitSwarmRequest(userMessage: string): boolean {
  return /\bagent_spawn\b|\bspawn\b.*\b(agent|sub-agent|worker)s?\b|\bsub-agent\b|\bparallel\b|\bworkers?\b|\bcoordinator\b|\bswarm\b/i.test(userMessage);
}

// ═══════════════════════════════════
// Main Loop
// ═══════════════════════════════════

export async function runAgentLoop(
  userMessage: string,
  history: NormalizedMessage[],
  options: LoopOptions,
): Promise<{ response: string; toolCalls: { name: string; status: string; detail?: string }[] }> {
  const { apiKey, onStreamText, onThinking, onToolActivity, onToolStream, onStreamEnd, runId } = options;

  const runKey = getRunKey(runId);
  const control = createRunControl(runKey);
  const detachParentAbort = bindParentAbort(control.abortController, options.parentSignal);
  ensureRegistry();

  // ── Classify ──
  const profile = applyAgentProfileOverride(classify(userMessage), options.forcedAgentProfile);
  const preserveBrowserRunTabs = () => {
    if (!runId || profile.toolGroup !== 'browser') return;
    try { preserveRunBackgroundTabs(runId); } catch {}
  }

  console.log(`[Agent] Classified: profile=${profile.agentProfile} group=${profile.toolGroup} modules=[${[...profile.promptModules]}] model=${profile.model} greeting=${profile.isGreeting}`);
  if (runId) {
    appendRunEvent(runId, {
      kind: 'run_classified',
      phase: 'classification',
      payload: {
        agentProfile: profile.agentProfile,
        toolGroup: profile.toolGroup,
        promptModules: [...profile.promptModules],
        modelTier: profile.model,
        isGreeting: profile.isGreeting,
      },
    });
    setProcessAgentProfile(runId, profile.agentProfile);
  }

  const baseModelId = pickModel(options.provider, profile.model, options.model, profile.isGreeting);
  const harnessInput: HarnessResolutionInput = {
    userMessage,
    profile,
    provider: options.provider,
    initialModel: baseModelId,
    forcedAgentProfile: options.forcedAgentProfile,
    allowedTools: options.allowedTools,
    systemAuditSummary: getSystemAuditSummary(),
  };
  let currentHarness = resolveHarness(harnessInput);
  const runtimeHarnessState = createRuntimeHarnessReactiveState();
  const modelId = options.model ? baseModelId : currentHarness.selectedModel;
  if (options.model && currentHarness.selectedModel !== modelId) {
    currentHarness.selectedModel = modelId;
    currentHarness.providerStrategyNote = `${currentHarness.providerStrategyNote} Explicit model selection preserved.`;
  }
  console.log(`[Harness] ${formatResolvedHarnessDebug(currentHarness).replace(/\n/g, ' | ')}`);
  if (runId) {
    appendRunEvent(runId, {
      kind: 'harness_resolved',
      phase: 'classification',
      payload: {
        harnessId: currentHarness.id,
        baseHarnessId: currentHarness.baseHarnessId,
        baseGoal: currentHarness.baseGoal,
        currentGoal: currentHarness.currentGoal,
        baseSubGoalPlan: currentHarness.baseSubGoalPlan,
        currentSubGoal: currentHarness.currentSubGoal,
        completedSubGoals: currentHarness.completedSubGoals,
        subGoalConfidence: currentHarness.subGoalConfidence,
        goalConfidence: currentHarness.goalConfidence,
        learningPatternKey: currentHarness.learningPatternKey,
        learningConfidence: currentHarness.learningConfidence || null,
        learningEvidenceSummary: currentHarness.learningEvidenceSummary,
        appliedLearningHints: currentHarness.appliedLearningHints,
        learningInfluencedStart: currentHarness.learningInfluencedStart,
        baseStrategy: currentHarness.baseStrategy,
        currentStrategy: currentHarness.currentStrategy,
        requestedExecutionMode: currentHarness.requestedExecutionMode,
        actualExecutionMode: currentHarness.actualExecutionMode,
        downgradeReason: currentHarness.downgradeReason || null,
        selectedModel: currentHarness.selectedModel,
        preferFamilies: currentHarness.toolPolicy.preferFamilies || [],
        discourageFamilies: currentHarness.toolPolicy.discourageFamilies || [],
        suppressFamilies: currentHarness.toolPolicy.suppressFamilies || [],
        demotedTools: currentHarness.toolPolicy.demotedTools || [],
        deterministicBrowserFirst: currentHarness.toolPolicy.deterministicBrowserFirst === true,
        elevatedApproval: currentHarness.safetyPolicy.elevatedApproval === true,
        elevatedVerification: currentHarness.safetyPolicy.elevatedVerification === true,
        retryGuidance: currentHarness.retryGuidance,
        branchingGuidance: currentHarness.branchingGuidance,
        reactiveNotes: currentHarness.reactiveNotes,
        adaptationReasons: currentHarness.adaptationReasons,
        goalAwareNotes: currentHarness.goalAwareNotes,
        goalAdjustments: currentHarness.goalAdjustments,
        goalDriftSignals: currentHarness.goalDriftSignals,
        subGoalAdjustments: currentHarness.subGoalAdjustments,
        subGoalProgressSignals: currentHarness.subGoalProgressSignals,
        stageAwareNotes: currentHarness.stageAwareNotes,
        auditSignalsUsed: currentHarness.auditSignalsUsed,
        reactiveAdjustments: currentHarness.reactiveAdjustments,
        strategyShiftHistory: currentHarness.strategyShiftHistory,
        providerStrategyNote: currentHarness.providerStrategyNote,
      },
    });
  }

  if (runId) setProcessExecutionInfo(runId, options.provider, modelId);
  const defaultPerformanceStance = getSelectedPerformanceStance();
  const initialPerformanceDirective = detectPerformanceStanceDirective(userMessage);
  control.performanceStance = initialPerformanceDirective || defaultPerformanceStance;
  console.log(`[Agent] Using model: ${modelId}`);
  if (runId) {
    appendRunEvent(runId, {
      kind: 'model_selected',
      phase: 'classification',
      payload: { modelId },
    });
    appendRunEvent(runId, {
      kind: 'performance_stance_selected',
      phase: 'classification',
      payload: {
        performanceStance: control.performanceStance,
        source: initialPerformanceDirective ? 'user_message' : 'settings_default',
      },
    });
  }

  const client = createProviderClient(options.provider, apiKey, modelId);
  const harnessPromptModules = applyHarnessPromptModules(profile.promptModules, currentHarness.promptPolicy);
  const staticPrompt = buildStaticPrompt(profile.toolGroup, harnessPromptModules);

  if (runId) setProcessWorkflowStage(runId, 'starting');

  // ── Pre-LLM Setup (extracted to loop-setup.ts) ──
  const setup = await runPreLLMSetup(userMessage, profile, client, options.onProgress, {
    allowedTools: options.allowedTools,
  });
  const { executionPlan } = setup;
  if (runId) {
    appendRunEvent(runId, {
      kind: 'preflight_completed',
      phase: 'setup',
      payload: {
        selectedSurface: executionPlan?.selectedSurface || null,
        appId: executionPlan?.appId || null,
        disallowedTools: executionPlan?.disallowedTools || [],
      },
    });
  }

  // ── Extractor agent short-circuit ──
  if (profile.agentProfile === 'ytdlp' && hasStrongYtdlpIntent(userMessage)) {
    if (!client.supportsHarnessGeneration) {
      options.onStreamText?.('Extractor requires a provider that supports nested agent loops (Anthropic). Switch providers to use it.');
      options.onStreamEnd?.();
      preserveBrowserRunTabs();
      cleanupRunControl(runKey);
      detachParentAbort();
      return { response: '', toolCalls: [] };
    }
    let ytdlpResult: YtdlpResult;
    try {
      ytdlpResult = await runYtdlpPipeline(userMessage, {
        client,
        apiKey: options.apiKey,
        onThinking: (text) => options.onThinking?.(text),
        onRegisterCancel: registerNestedCancel,
      });
    } finally {
      clearNestedCancel();
    }
    const summary = ytdlpResult.success
      ? `Downloaded ${ytdlpResult.files.length} file(s):\n${ytdlpResult.files.join('\n')}`
      : `Extractor failed: ${ytdlpResult.reason}`;
    options.onStreamText?.(summary);
    options.onStreamEnd?.();
    preserveBrowserRunTabs();
    cleanupRunControl(runKey);
    detachParentAbort();
    return { response: summary, toolCalls: [] };
  }

  if (profile.toolGroup === 'browser') {
    const currentUrl = getCurrentUrl(runId ? { runId } : undefined) || undefined;

    if (currentUrl) {
      const preparedHarness = prepareHarnessExecutionFromMessage(userMessage, currentUrl);
      if (preparedHarness) {
        const harnessRun = await runHarness(
          preparedHarness.harness.domain,
          preparedHarness.harness.actionName,
          preparedHarness.fieldValues,
          preparedHarness.autoSubmit,
        );
        if (!harnessRun.startsWith('[Error]') && !harnessRun.startsWith('✗')) {
          if (runId) {
            appendRunEvent(runId, {
              kind: 'tool_completed',
              phase: 'setup',
              surface: 'browser',
              toolName: 'browser_run_harness',
              payload: {
                detail: `Pre-loop site harness: ${preparedHarness.harness.domain}/${preparedHarness.harness.actionName}`,
                resultPreview: harnessRun.slice(0, 500),
                status: 'success',
              },
            });
          }
          preserveBrowserRunTabs();
          cleanupRunControl(runKey);
          detachParentAbort();
          return { response: harnessRun, toolCalls: [] };
        }
      }
    }

    const executorRun = await executeSavedBloodhoundPlaybook(userMessage, currentUrl, {
      exactOnly: true,
      target: runId ? { runId } : undefined,
    });
    if (executorRun?.ok) {
      if (runId) {
        appendRunEvent(runId, {
          kind: 'bloodhound_executor_ran',
          phase: 'setup',
          payload: {
            domain: executorRun.playbook.domain,
            taskPattern: executorRun.playbook.taskPattern,
            successRate: executorRun.playbook.successRate,
            validationRuns: executorRun.playbook.validationRuns,
          },
        });
      }
      preserveBrowserRunTabs();
      cleanupRunControl(runKey);
      detachParentAbort();
      return { response: executorRun.response, toolCalls: [] };
    }

    if (executorRun && runId) {
      appendRunEvent(runId, {
        kind: 'bloodhound_executor_failed',
        phase: 'setup',
        payload: {
          domain: executorRun.playbook.domain,
          taskPattern: executorRun.playbook.taskPattern,
          reason: executorRun.response,
        },
      });
    }
  }

  // ── Build dynamic prompt ──
  const calendarContext = (() => {
    try {
      const todayEvents = calendarList({});  // reads from calendar.sqlite directly — no subprocess
      const now = new Date();
      const weekday = now.toLocaleDateString([], { weekday: 'long' });
      const dateStr = now.toISOString().slice(0, 10);
      if (!todayEvents.length) return `Today is ${weekday} ${dateStr}. No events scheduled.`;
      const lines = todayEvents.map(e => {
        const time = e.start_time ? `${e.start_time}` : 'All day';
        const dur = e.duration ? ` (${e.duration} min)` : '';
        return `  - ${time}  ${e.title}${dur}`;
      });
      return `Today is ${weekday} ${dateStr}. Your schedule:\n${lines.join('\n')}`;
    } catch { return ''; }
  })();
  const evidenceLedgerState = createEvidenceLedgerState();

  const buildCurrentDynamicPrompt = (): string => buildDynamicPrompt({
    agentProfile: profile.agentProfile,
    model: modelId,
    toolGroup: profile.toolGroup,
    projectRoot: shouldInjectProjectContext(userMessage, profile) ? detectWorkspaceRoot(process.cwd()) : undefined,
    calendarContext: calendarContext || undefined,
    memoryContext: setup.memoryContext,
    recallContext: setup.recallContext,
    siteContext: setup.siteContext,
    playbookContext: setup.playbookContext,
    harnessContext: setup.harnessContext,
    desktopContext: setup.desktopContext,
    executionConstraint: executionPlan?.constraint,
    systemAwarenessContext: getSystemAwarenessBlock() || undefined,
    harnessDirectiveContext: buildHarnessDirectiveBlock(currentHarness),
    evidenceLedgerContext: buildEvidenceLedgerPromptBlock(evidenceLedgerState),
    shortcutContext: setup.shortcutContext,
    guiStateContext: setup.guiStateContext,
    isGreeting: profile.isGreeting,
    performanceStance: control.performanceStance,
  });
  let dynamicPrompt = buildCurrentDynamicPrompt();

  if (EXECUTION_PLANNING_ENABLED && shouldCreateExecutionPlan(userMessage, profile)) {
    let executionPlanText: string | null = null;
    let planRevisionRound = 0;

    while (true) {
      const planningRunId = runId;
      const previousPlan = executionPlanText;

      if (planningRunId) setProcessWorkflowStage(planningRunId!, 'planning');
      if (planningRunId) {
        appendRunEvent(planningRunId!, {
          kind: 'workflow_stage_changed',
          phase: 'planning',
          payload: { workflowStage: 'planning', revisionRound: planRevisionRound },
        });
      }
      options.onWorkflowPlanReset?.();
      onThinking?.(planRevisionRound > 0 ? 'Drafting revised execution plan...' : 'Drafting execution plan...');
      executionPlanText = await createExecutionPlan({
        client,
        runId: planningRunId,
        userMessage,
        staticPrompt,
        dynamicPrompt,
        performanceStance: control.performanceStance,
        onText: (chunk) => options.onWorkflowPlanText?.(chunk),
        signal: control.abortController.signal,
        ...(planRevisionRound > 0 && previousPlan
          ? { revisionContext: { previousPlan: previousPlan!, round: planRevisionRound } }
          : {}),
      });
      options.onWorkflowPlanEnd?.();
      onThinking?.('');

      const activeRunId = planningRunId;
      const currentExecutionPlan = executionPlanText;
      if (!activeRunId || !currentExecutionPlan) break;

      const decision = await requireExecutionPlanApproval({
        runId: activeRunId!,
        plan: currentExecutionPlan!,
      });
      if (decision === 'approved') break;
      if (decision === 'revise') {
        planRevisionRound += 1;
        appendRunEvent(activeRunId!, {
          kind: 'workflow_plan_revised',
          phase: 'planning',
          payload: { revisionRound: planRevisionRound },
        });
        continue;
      }
      appendRunEvent(activeRunId!, {
        kind: 'workflow_plan_denied',
        phase: 'planning',
        payload: { workflowStage: 'planning' },
      });
      onStreamEnd?.();
      preserveBrowserRunTabs();
      cleanupRunControl(runKey);
      clearNestedCancel();
      detachParentAbort();
      return {
        response: 'Execution stopped because the plan approval was denied.',
        toolCalls: [],
      };
    }
  }

  if (runId) setProcessWorkflowStage(runId, 'executing');
  if (runId) {
    appendRunEvent(runId, {
      kind: 'workflow_stage_changed',
      phase: 'execution',
      payload: { workflowStage: 'executing' },
    });
  }

  // ── Prepare tools ──
  let tools = getToolsForGroup(profile.toolGroup);
  if (options.allowedTools && options.allowedTools.length > 0) {
    const allowed = new Set(options.allowedTools);
    tools = tools.filter((tool) => allowed.has(tool.name));
  }
  if (executionPlan && executionPlan.disallowedTools.length > 0) {
    tools = filterTools(tools, executionPlan.disallowedTools);
  }
  tools = applyHarnessToolPolicy(tools, currentHarness.toolPolicy);
  const filesystemQuoteLookupMode = profile.agentProfile === 'filesystem' && isFilesystemQuoteLookupTask(userMessage);
  if (filesystemQuoteLookupMode) {
    tools = filterTools(tools, ['shell_exec']);
  }

  // ── Prepare message history ──
  const trimmedHistory = trimHistory(history);
  const messages: NormalizedMessage[] = [...trimmedHistory, { role: 'user', content: options.initialUserContent ?? userMessage }];

  // ── Dispatch context (mutable, shared with loop-dispatch) ──
  const dispatchCtx: DispatchContext = {
    runId,
    signal: control.abortController.signal,
    tools,
    executionPlan,
    toolGroup: profile.toolGroup,
    recoveryMode: false,
    filesystemQuoteLookupMode,
    strongFilesystemQuoteMatch: false,
    escalatedToFull: false,
    toolCallCount: 0,
    allToolCalls: [],
    allVerifications: [],
    iterationIndex: 0,
    lastToolFamily: undefined,
    evidenceLedger: evidenceLedgerState,
    onToolActivity,
    onToolStream,
  };

  const applyRuntimeHarnessSignal = (signal: RuntimeHarnessSignal): void => {
    const { adjustments, strategyShifts, goalAdjustments, subGoalAdjustments } = applyInLoopHarnessAdjustment(currentHarness, runtimeHarnessState, signal, harnessInput);
    if (adjustments.length === 0 && strategyShifts.length === 0 && goalAdjustments.length === 0 && subGoalAdjustments.length === 0) return;
    dispatchCtx.tools = applyHarnessToolPolicy(dispatchCtx.tools, currentHarness.toolPolicy);
    dynamicPrompt = buildCurrentDynamicPrompt();
    if (runId) {
      appendRunEvent(runId, {
        kind: 'harness_in_loop_adjusted',
        phase: 'execution',
        payload: {
          baseHarnessId: currentHarness.baseHarnessId,
          harnessId: currentHarness.id,
          baseGoal: currentHarness.baseGoal,
          currentGoal: currentHarness.currentGoal,
          baseSubGoalPlan: currentHarness.baseSubGoalPlan,
          currentSubGoal: currentHarness.currentSubGoal,
          completedSubGoals: currentHarness.completedSubGoals,
          learningPatternKey: currentHarness.learningPatternKey,
          learningConfidence: currentHarness.learningConfidence || null,
          appliedLearningHints: currentHarness.appliedLearningHints,
          baseStrategy: currentHarness.baseStrategy,
          currentStrategy: currentHarness.currentStrategy,
          signal,
          retryGuidance: currentHarness.retryGuidance,
          branchingGuidance: currentHarness.branchingGuidance,
          suppressFamilies: currentHarness.toolPolicy.suppressFamilies || [],
          demotedTools: currentHarness.toolPolicy.demotedTools || [],
          adjustments,
          goalAdjustments,
          subGoalAdjustments,
          strategyShifts,
        },
      });
    }
  };
  dispatchCtx.onRuntimeSignal = applyRuntimeHarnessSignal;

  let guiBatchNudgeSent = false;
  let browserSearchBudgetNudgeSent = false;
  let browserTabBudgetNudgeSent = false;
  let browserScrollBudgetNudgeKey: string | null = null;
  const guiBatchNudgeAt = control.performanceStance === 'aggressive'
    ? 1
    : control.performanceStance === 'conservative'
      ? 3
      : GUI_BATCH_NUDGE_AT;
  const wrapUpThreshold = control.performanceStance === 'aggressive'
    ? 35
    : control.performanceStance === 'conservative'
      ? 18
      : WRAP_UP_THRESHOLD;
  const startTime = Date.now();
  let finalText = '';
  let swarmCompleted = false;
  const maxIterations = Math.max(1, options.maxIterations ?? MAX_ITERATIONS);
    const browserBudgetState: BrowserRuntimeBudgetState = {
      searchRounds: 0,
      inspectedTargets: new Set<string>(),
      scrollFallbackCounts: new Map<string, number>(),
      lastTargetKey: null,
      pendingBackgroundTabIds: [],
      successfulExtractions: 0,
      successfulArticleOrListingExtractions: 0,
      successfulDiscussionExtractions: 0,
      firstWaveComplete: false,
    };

  // ═══════════════════════════════════
  // Iteration Loop
  // ═══════════════════════════════════

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (Date.now() - startTime > LOOP_MAX_WALL_MS) {
      console.warn(`[Agent] Wall time limit reached at iteration ${iteration}`);
      break;
    }

    // ── Loop control gate ──
    if (isCancelled(control)) {
      console.log(`[Agent] Cancelled at iteration ${iteration}`);
      if (runId) {
        appendRunEvent(runId, {
          kind: 'run_cancel_requested',
          phase: 'control',
          payload: { iteration },
        });
      }
      finalText = finalText || '[Cancelled by user]';
      break;
    }

    if (control.isPaused) {
      options.onPaused?.();
      onThinking?.('Paused — waiting to resume...');
      if (runId) {
        appendRunEvent(runId, {
          kind: 'run_paused',
          phase: 'control',
          payload: { iteration },
        });
      }
      await waitIfPaused(control);
      if (isCancelled(control)) { finalText = '[Cancelled by user]'; break; }
      options.onResumed?.();
      if (runId) {
        appendRunEvent(runId, {
          kind: 'run_resumed',
          phase: 'control',
          payload: { iteration },
        });
      }
    }

    // Inject pending user context
    if (control.pendingContext !== null) {
      const ctx: string = control.pendingContext;
      control.pendingContext = null;
      const nextStance = detectPerformanceStanceDirective(ctx);
      if (nextStance && nextStance !== control.performanceStance) {
        control.performanceStance = nextStance;
        messages.push({
          role: 'user',
          content: `[SYSTEM] PERFORMANCE STANCE changed to ${nextStance}. Adjust your behavior immediately. ${
            nextStance === 'aggressive'
              ? 'Widen search, take larger execution steps, and reduce hand-holding.'
              : nextStance === 'conservative'
                ? 'Take smaller steps, verify before larger changes, and prioritize safety.'
                : 'Return to balanced execution.'
          }`,
        });
        if (runId) {
          appendRunEvent(runId, {
            kind: 'performance_stance_changed',
            phase: 'control',
            payload: {
              performanceStance: nextStance,
              source: 'user_context',
            },
          });
        }
      }
      messages.push({ role: 'user', content: `[USER CONTEXT] ${ctx}` });
      console.log(`[Agent] Injected user context: ${ctx.slice(0, 80)}`);
      if (runId) {
        appendRunEvent(runId, {
          kind: 'context_injected',
          phase: 'control',
          payload: { text: ctx.slice(0, 500) },
        });
      }
    }

    onThinking?.('Reviewing context and deciding the next step...');
    if (runId) {
      appendRunEvent(runId, {
        kind: 'thinking',
        phase: 'llm',
        payload: { iteration },
      });
    }

    // ── Mid-loop injections ──
    if (!guiBatchNudgeSent && profile.promptModules.has('desktop_apps')
        && (!executionPlan || executionPlan.selectedSurface === 'gui')
        && dispatchCtx.toolCallCount >= guiBatchNudgeAt) {
      messages.push({
        role: 'user',
        content: '[SYSTEM] IMPORTANT: For remaining GUI steps, use gui_interact batch_actions. Do NOT make single-action gui_interact calls.',
      });
      guiBatchNudgeSent = true;
    }

    if (dispatchCtx.toolCallCount >= wrapUpThreshold && !profile.isGreeting) {
      messages.push({ role: 'user', content: `[SYSTEM] ${dispatchCtx.toolCallCount} tool calls used (limit: ${maxIterations}). Wrap up.` });
    }

    if (profile.toolGroup === 'browser') {
      if (!browserSearchBudgetNudgeSent && browserBudgetState.searchRounds >= MAX_BROWSER_SEARCH_ROUNDS) {
        messages.push({
          role: 'user',
          content: '[SYSTEM] Search budget reached. Use the sources you already found and inspect or synthesize instead of issuing more browser_search calls.',
        });
        browserSearchBudgetNudgeSent = true;
      }
      if (browserBudgetState.firstWaveComplete && !messages.some((msg) => typeof msg.content === 'string' && msg.content.includes('first evidence wave is complete'))) {
        messages.push({
          role: 'user',
          content: '[SYSTEM] The first evidence wave is complete. Prefer synthesis or one targeted follow-up for missing fields instead of more search or more source-opening.',
        });
      }
      if (runId && !browserTabBudgetNudgeSent && countRunBackgroundTabs(runId) >= MAX_BROWSER_BACKGROUND_TABS) {
        messages.push({
          role: 'user',
          content: '[SYSTEM] Background tab budget reached. Close stale background tabs before opening more, or continue from the tabs you already have.',
        });
        browserTabBudgetNudgeSent = true;
      }
      const stalledScrollEntry = [...browserBudgetState.scrollFallbackCounts.entries()].find(([, count]) => count >= MAX_BROWSER_SCROLL_FALLBACKS_PER_TARGET);
      if (stalledScrollEntry && browserScrollBudgetNudgeKey !== stalledScrollEntry[0]) {
        messages.push({
          role: 'user',
          content: '[SYSTEM] Stop repeated scrolling on the current page. Use browser_extract or browser_read_page once, or synthesize from the evidence already gathered.',
        });
        browserScrollBudgetNudgeKey = stalledScrollEntry[0];
      }
    }

    // ── LLM Call ──
    let iterationText = '';
    let response: LLMResponse;
    dynamicPrompt = buildCurrentDynamicPrompt();

    try {
      response = await client.chat(messages, profile.isGreeting || swarmCompleted ? [] : dispatchCtx.tools, staticPrompt, dynamicPrompt, (chunk) => {
        iterationText += chunk;
        onStreamText?.(chunk);
      }, { signal: control.abortController.signal });
    } catch (err: any) {
      if (err.name === 'AbortError' || isCancelled(control)) {
        console.log('[Agent] LLM call aborted by user');
        finalText = finalText || iterationText || '[Cancelled by user]';
        break;
      }
      console.error(`[Agent] LLM error:`, err.message);
      if (runId) {
        appendRunEvent(runId, {
          kind: 'llm_error',
          phase: 'llm',
          payload: { iteration, message: err.message },
        });
      }
      finalText = `I encountered an error: ${err.message}`;
      break;
    }

    onThinking?.(response.thinkingText || '');

    const textBlocks = response.content.filter((b): b is NormalizedTextBlock => b.type === 'text');
    const toolUseBlocks = response.content.filter((b): b is NormalizedToolUseBlock => b.type === 'tool_use');
    const responseText = textBlocks.map(b => b.text).join('');

    // ── No tools → check for narration/denial or return ──
    // Guard: if the provider signalled tool_calls but streaming produced no blocks
    // (e.g. GPT-5 chunk ordering delivered finish_reason before all deltas), force
    // another iteration rather than terminating with an empty tool list.
    if (toolUseBlocks.length === 0 && response.stopReason === 'tool_use') {
      console.warn('[Agent] stopReason=tool_use but no tool_use blocks received — forcing continuation');
      messages.push({ role: 'assistant', content: response.content as any });
      messages.push({ role: 'user', content: '[SYSTEM] You indicated tool calls were needed. Please proceed with your tool calls now.' });
      continue;
    }

    if (toolUseBlocks.length === 0) {
      const isShortNarration = iteration === 0 && responseText.length < 300 && NARRATION_RE.test(responseText) && dispatchCtx.toolCallCount === 0;

      if (isShortNarration && iteration < maxIterations - 1) {
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

      const continuationInstruction = shouldForceContinuationAfterPartialExecution(userMessage, dispatchCtx.allToolCalls);
      if (continuationInstruction && iteration < maxIterations - 1) {
        onStreamText?.('\n\n__RESET__');
        messages.push({ role: 'assistant', content: response.content as any });
        messages.push({ role: 'user', content: `[SYSTEM] ${continuationInstruction}` });
        continue;
      }

      finalText = responseText;
      if (runId) {
        appendRunEvent(runId, {
          kind: 'assistant_response',
          phase: 'llm',
          payload: { iteration, text: responseText.slice(0, 1000) },
        });
      }
      break;
    }

    // ── Tool dispatch (extracted to loop-dispatch.ts) ──
    const toolPolicyViolation = detectToolPolicyViolation(toolUseBlocks);
    if (toolPolicyViolation && iteration < maxIterations - 1) {
      onStreamText?.('\n\n__RESET__');
      messages.push({ role: 'assistant', content: response.content as any });
      messages.push({
        role: 'user',
        content: buildBlockedToolResults(toolUseBlocks, toolPolicyViolation) as any,
      });
      messages.push({ role: 'user', content: `[SYSTEM] ${toolPolicyViolation}` });
      continue;
    }

    if (profile.toolGroup === 'browser') {
      const browserPolicyViolation = detectBrowserPolicyViolation(toolUseBlocks, browserBudgetState, runId);
      if (browserPolicyViolation && iteration < maxIterations - 1) {
        onStreamText?.('\n\n__RESET__');
        messages.push({ role: 'assistant', content: response.content as any });
        messages.push({
          role: 'user',
          content: buildBlockedToolResults(toolUseBlocks, browserPolicyViolation) as any,
        });
        messages.push({ role: 'user', content: `[SYSTEM] ${browserPolicyViolation}` });
        continue;
      }
    }

    if (iterationText) onStreamText?.('\n\n__RESET__');
    messages.push({ role: 'assistant', content: response.content as any });

    dispatchCtx.iterationIndex = iteration;
    const toolResults = await dispatchTools(toolUseBlocks, dispatchCtx);
    if (profile.toolGroup === 'browser') {
      updateBrowserBudgetState(toolUseBlocks, toolResults, browserBudgetState);
    }
    messages.push({ role: 'user', content: toolResults as any });

    const successfulSwarmOnlyTurn =
      isExplicitSwarmRequest(userMessage) &&
      toolUseBlocks.length > 0 &&
      toolUseBlocks.every(block => block.name === 'agent_spawn') &&
      toolResults.every(result => !String(result.content || '').startsWith('[Error'));

    if (successfulSwarmOnlyTurn) {
      swarmCompleted = true;
      messages.push({
        role: 'user',
        content: '[SYSTEM] The swarm execution is complete. Do not call any more tools. Summarize the swarm results only.',
      });
    }

    // Escalation notice
    if (dispatchCtx.escalatedToFull && !messages.some(m =>
      typeof m.content === 'string' && m.content.includes('[SYSTEM] Additional tools are now available'),
    )) {
      messages.push({
        role: 'user',
        content: '[SYSTEM] Additional tools are now available. Your tool set has been expanded. Proceed with your task.',
      });
    }

    if (iteration === maxIterations - 1) {
      finalText = responseText || '[Reached iteration limit.]';
    }
  }

  onStreamEnd?.();

  // ── Post-loop verification + recovery (extracted to loop-recovery.ts) ──
  if (finalText && !finalText.startsWith('[Cancelled') && !profile.isGreeting && dispatchCtx.allToolCalls.length > 0) {
    if (runId) setProcessWorkflowStage(runId, 'reviewing');
    if (runId) {
      appendRunEvent(runId, {
        kind: 'workflow_stage_changed',
        phase: 'review',
        payload: { workflowStage: 'reviewing' },
      });
    }
    const issue = verifyFileOutcomes(finalText, dispatchCtx.allToolCalls);
    if (issue) {
      if (runId) {
        appendRunEvent(runId, {
          kind: 'recovery_started',
          phase: 'recovery',
          payload: { issue },
        });
      }
      finalText = await runRecoveryIteration(issue, finalText, {
        runId,
        client,
        messages,
        tools: dispatchCtx.tools,
        staticPrompt,
        dynamicPrompt: buildCurrentDynamicPrompt(),
        getDynamicPrompt: buildCurrentDynamicPrompt,
        signal: control.abortController.signal,
        iterationIndex: dispatchCtx.iterationIndex,
        onStreamText,
        onToolActivity,
        onToolStream,
        allToolCalls: dispatchCtx.allToolCalls,
        toolCallCount: dispatchCtx.toolCallCount,
        onRuntimeSignal: applyRuntimeHarnessSignal,
      });
      onStreamEnd?.();
      if (runId) {
        appendRunEvent(runId, {
          kind: 'recovery_completed',
          phase: 'recovery',
          payload: { finalText: finalText.slice(0, 1000) },
        });
      }
    }
  }

  if (runId) setProcessWorkflowStage(runId, 'completed');
  if (runId) {
    appendRunEvent(runId, {
      kind: 'harness_run_summary',
      phase: 'lifecycle',
      payload: {
        baseHarnessId: currentHarness.baseHarnessId,
        harnessId: currentHarness.id,
        baseGoal: currentHarness.baseGoal,
        currentGoal: currentHarness.currentGoal,
        baseSubGoalPlan: currentHarness.baseSubGoalPlan,
        currentSubGoal: currentHarness.currentSubGoal,
        completedSubGoals: currentHarness.completedSubGoals,
        learningPatternKey: currentHarness.learningPatternKey,
        learningConfidence: currentHarness.learningConfidence || null,
        appliedLearningHints: currentHarness.appliedLearningHints,
        learningInfluencedStart: currentHarness.learningInfluencedStart,
        baseStrategy: currentHarness.baseStrategy,
        currentStrategy: currentHarness.currentStrategy,
        hadInLoopAdaptation: currentHarness.hadInLoopAdaptation,
        inLoopAdjustmentCount: currentHarness.inLoopAdjustments.length,
        inLoopAdjustmentIds: currentHarness.inLoopAdjustments.map((adjustment) => adjustment.id),
        goalAdjustmentCount: currentHarness.goalAdjustments.length,
        goalAdjustmentIds: currentHarness.goalAdjustments.map((adjustment) => adjustment.id),
        subGoalAdjustmentCount: currentHarness.subGoalAdjustments.length,
        subGoalAdjustmentIds: currentHarness.subGoalAdjustments.map((adjustment) => adjustment.id),
        strategyShiftCount: currentHarness.strategyShiftHistory.length,
        strategyShiftIds: currentHarness.strategyShiftHistory.map((shift) => shift.id),
        retryGuidance: currentHarness.retryGuidance,
        branchingGuidance: currentHarness.branchingGuidance,
        completedWithResponse: !!finalText,
      },
    });
    appendRunEvent(runId, {
      kind: 'workflow_stage_changed',
      phase: 'lifecycle',
      payload: { workflowStage: 'completed' },
    });
    if (evidenceLedgerState.facts.length > 0) {
      upsertRunArtifact(
        runId,
        'evidence_ledger',
        'Evidence Ledger',
        JSON.stringify({ facts: evidenceLedgerState.facts }, null, 2),
      );
    }
  }

  // ── Background memory extraction ──
  if (!profile.isGreeting && finalText.length > 50 && userMessage.length > 20) {
    try {
      const { extractMemoryInBackground } = await import('./memory-extractor');
      extractMemoryInBackground(options.provider, apiKey, userMessage, finalText);
    } catch { /* non-fatal */ }
  }

  // ── Save playbook ──
  const browserToolCalls = dispatchCtx.allToolCalls.filter(tc =>
    tc.name.startsWith('browser_') && tc.status === 'success',
  );
  const formAwareBrowserCalls = browserToolCalls.filter(tc =>
    tc.name === 'browser_fill_field'
    || tc.name === 'browser_run_harness'
    || tc.name === 'browser_register_harness'
    || tc.name === 'browser_detect_form'
    || tc.name === 'browser_focus_field',
  );
  const shouldSkipPlaybookSave = formAwareBrowserCalls.length >= 2;

  if (
    !shouldSkipPlaybookSave &&
    browserToolCalls.length >= 2 &&
    finalText &&
    !finalText.startsWith('[Cancelled') &&
    shouldAutoSavePlaybook(userMessage, browserToolCalls.map(tc => ({
      name: tc.name,
      input: tc.input || {},
      summary: tc.detail || tc.name,
    })))
  ) {
    try {
      const browserRuntimeMs = browserToolCalls.reduce((sum, tc) => sum + (tc.durationMs || 0), 0);
      const browserStepCount = browserToolCalls.length;
      const serializableBrowserCalls = browserToolCalls.map(tc => ({
        name: tc.name,
        input: tc.input || {},
        summary: tc.detail || tc.name,
      }));
      const currentBrowserUrl = getCurrentUrl(runId ? { runId } : undefined);

      if (profile.agentProfile === 'bloodhound' && !getUnrestrictedMode()) {
        const validation = await validatePlaybookCandidate(userMessage, serializableBrowserCalls, {
          expectedUrl: currentBrowserUrl,
        });
        if (validation.metThreshold) {
          const saved = savePlaybook(
            userMessage,
            serializableBrowserCalls,
            currentBrowserUrl,
            {
              agentProfile: profile.agentProfile,
              validationRuns: validation.attemptedRuns,
              successRate: validation.successRate,
              runtimeMs: validation.avgRuntimeMs || browserRuntimeMs,
              notes: [
                `Observed ${browserStepCount} successful browser step(s) in ${Math.round(browserRuntimeMs / 1000)}s during design run.`,
                ...validation.notes,
              ],
              stepsOverride: validation.selectedSteps,
            },
          );
          let artifactNote = '';
          if (saved) {
            const artifacts = writeBloodhoundExecutorArtifacts(userMessage, saved, {
              finalUrl: currentBrowserUrl,
              successMessage: finalText,
            });
            artifactNote = `\nArtifacts:\n- ${artifacts.markdownPath}\n- ${artifacts.jsonPath}`;
          }
          finalText += `\n\n[Bloodhound] Executor validated at ${Math.round(validation.successRate * 100)}% over ${validation.attemptedRuns} run(s) and saved for reuse.`;
          if (artifactNote) finalText += artifactNote;
        } else {
          finalText += `\n\n[Bloodhound] Executor replay validation reached ${Math.round(validation.successRate * 100)}% over ${validation.attemptedRuns} run(s), below threshold. It was not saved as validated memory.`;
        }
      } else if (profile.agentProfile === 'bloodhound') {
        const saved = savePlaybook(
          userMessage,
          serializableBrowserCalls,
          currentBrowserUrl,
          {
            agentProfile: profile.agentProfile,
            validationRuns: 1,
            successRate: 1,
            runtimeMs: browserRuntimeMs,
            notes: [
              `Unrestricted mode was enabled; Bloodhound replay validation was skipped.`,
              `Observed ${browserStepCount} successful browser step(s) in ${Math.round(browserRuntimeMs / 1000)}s during design run.`,
            ],
          },
        );
        let artifactNote = '';
        if (saved) {
          const artifacts = writeBloodhoundExecutorArtifacts(userMessage, saved, {
            finalUrl: currentBrowserUrl,
            successMessage: finalText,
          });
          artifactNote = `\nArtifacts:\n- ${artifacts.markdownPath}\n- ${artifacts.jsonPath}`;
        }
        finalText += `\n\n[Bloodhound] Unrestricted mode is enabled, so replay validation was skipped and the executor was saved directly.`;
        if (artifactNote) finalText += artifactNote;
      } else {
        savePlaybook(
          userMessage,
          serializableBrowserCalls,
          currentBrowserUrl,
          {
            agentProfile: profile.agentProfile,
            validationRuns: 1,
            successRate: 1,
            runtimeMs: browserRuntimeMs,
            notes: [],
          },
        );
      }
    } catch { /* non-fatal */ }
  }

  // ── Verification summary ──
  logVerificationSummary(dispatchCtx.allVerifications);
  if (runId && dispatchCtx.allVerifications.length > 0) {
    appendRunEvent(runId, {
      kind: 'verification_summary',
      phase: 'verification',
      payload: {
        checks: dispatchCtx.allVerifications.length,
        failed: dispatchCtx.allVerifications.filter(v => !v.passed).length,
      },
    });
  }

  // Clean up
  preserveBrowserRunTabs();
  cleanupRunControl(runKey);
  clearNestedCancel();  // guard: clears any registered nested cancel fn on all exit paths
  detachParentAbort();

  return { response: finalText, toolCalls: dispatchCtx.allToolCalls };
}

function getRunKey(runId?: string): string {
  return runId || DEFAULT_RUN_KEY;
}

function createRunControl(runKey: string): RunLoopControl {
  const state: RunLoopControl = {
    abortController: new AbortController(),
    isPaused: false,
    pauseResolve: null,
    pendingContext: null,
    performanceStance: 'standard',
  };
  runControls.set(runKey, state);
  return state;
}

function getRunControl(runId?: string): RunLoopControl | null {
  return runControls.get(getRunKey(runId)) || null;
}

function cleanupRunControl(runKey: string): void {
  const state = runControls.get(runKey);
  if (!state) return;
  if (state.pauseResolve) {
    state.pauseResolve();
    state.pauseResolve = null;
  }
  runControls.delete(runKey);
}

function bindParentAbort(abortController: AbortController, parentSignal?: AbortSignal): () => void {
  if (!parentSignal) return () => {};
  if (parentSignal.aborted) {
    abortController.abort();
    return () => {};
  }
  const onAbort = () => abortController.abort();
  parentSignal.addEventListener('abort', onAbort, { once: true });
  return () => parentSignal.removeEventListener('abort', onAbort);
}

function shouldInjectProjectContext(userMessage: string, profile: TaskProfile): boolean {
  if (profile.promptModules.has('coding') || profile.agentProfile === 'filesystem') return true;
  return /\b(?:repo|repository|project|workspace|codebase|clawdia)\b/i.test(userMessage);
}

function detectWorkspaceRoot(cwd: string): string | undefined {
  const candidates = [cwd, path.resolve(cwd, '..')];
  for (const candidate of candidates) {
    if (looksLikeWorkspaceRoot(candidate)) return candidate;
  }
  return undefined;
}

function looksLikeWorkspaceRoot(candidate: string): boolean {
  try {
    if (!fs.existsSync(path.join(candidate, 'package.json'))) return false;
    return fs.existsSync(path.join(candidate, 'src', 'main')) || fs.existsSync(path.join(candidate, '.git'));
  } catch {
    return false;
  }
}
