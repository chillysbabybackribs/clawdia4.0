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
import { classify, type TaskProfile, type ToolGroup } from './classifier';
import { applyAgentProfileOverride } from './agent-profile-override';
import { isFilesystemQuoteLookupTask } from './filesystem-agent-routing';
import { buildStaticPrompt, buildDynamicPrompt } from './prompt-builder';
import { getToolsForGroup, filterTools } from './tool-builder';
import { createProviderClient, resolveModelForProvider, type LLMResponse, type NormalizedMessage, type NormalizedTextBlock, type NormalizedToolUseBlock } from './client';
import * as appRegistry from '../db/app-registry';
import type { ExecutionPlan } from '../db/app-registry';
import { savePlaybook, shouldAutoSavePlaybook, validatePlaybookCandidate, writeBloodhoundExecutorArtifacts, executeSavedBloodhoundPlaybook } from '../db/browser-playbooks';
import { type VerificationResult } from './verification';
import { fireNestedCancel, registerNestedCancel, clearNestedCancel } from './loop-cancel';
import { runYtdlpPipeline, type YtdlpResult } from './loop-ytdlp';
import { runPreLLMSetup } from './loop-setup';
import { dispatchTools, type DispatchContext } from './loop-dispatch';
import { verifyFileOutcomes, runRecoveryIteration, logVerificationSummary } from './loop-recovery';
import { createExecutionPlan, requireExecutionPlanApproval, shouldCreateExecutionPlan } from './workflow';
import { buildBrowserStepControllerPrompt, extractStepDoneMarker, stripStepDoneMarkers } from './task-compiler';
import { cancelPendingApprovals } from './approval-manager';
import { cancelPendingHumanInterventions } from './human-intervention-manager';
import { appendRunEvent } from '../db/run-events';
import { upsertRunArtifact } from '../db/run-artifacts';
import { getSelectedPerformanceStance, getUnrestrictedMode } from '../store';
import type { AgentProfile, PerformanceStance, ProviderId } from '../../shared/types';
import { setProcessAgentProfile, setProcessExecutionInfo, setProcessWorkflowStage } from './process-manager';
import { getCurrentUrl, runHarness } from '../browser/manager';
import { prepareHarnessExecutionFromMessage } from '../browser/site-harness';
import { calendarList } from '../db/calendar';
import type { NormalizedMessageContentBlock } from './provider/types';
import * as graphExecutor from './graph-executor';

const MAX_ITERATIONS = 50;
const MAX_WALL_MS = 10 * 60 * 1000;
const MAX_HISTORY_TURNS = 16;
const MAX_HISTORY_TOKENS = 80_000;
const WRAP_UP_THRESHOLD = 25;
const GUI_BATCH_NUDGE_AT = 2;

const NARRATION_RE = /^(?:I'll start by|Let me (?:start|begin|first)|I need to (?:first|read|check|look)|Here's my (?:plan|approach)|I want to (?:start|begin)|I'll (?:begin|first)|To (?:start|begin|complete|accomplish|do) this|First,? I(?:'ll| will| need)|I'm going to start)/i;
const CAPABILITY_DENIAL_RE = /(?:I (?:can't|cannot|don't have|am unable to|lack the ability to|do not have) (?:access|browse|execute|run|open|launch|read|write|interact with|control|use))/i;
const MULTI_STEP_CONNECTOR_RE = /\b(and then|then|after that|afterwards|next|followed by)\b/i;

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

function resolveGraphExecutorFns() {
  return {
    canExecuteGraphScaffold: typeof graphExecutor.canExecuteGraphScaffold === 'function' ? graphExecutor.canExecuteGraphScaffold : null,
    executeGraphScaffold: typeof graphExecutor.executeGraphScaffold === 'function' ? graphExecutor.executeGraphScaffold : null,
    getWorkerDependencyChain: typeof graphExecutor.getWorkerDependencyChain === 'function' ? graphExecutor.getWorkerDependencyChain : null,
  };
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
  ensureRegistry();

  // ── Classify ──
  const profile = applyAgentProfileOverride(classify(userMessage), options.forcedAgentProfile);
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

  const modelId = pickModel(options.provider, profile.model, options.model, profile.isGreeting);
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
  const staticPrompt = buildStaticPrompt(profile.toolGroup, profile.promptModules);

  if (runId) setProcessWorkflowStage(runId, 'starting');

  // ── Pre-LLM Setup (extracted to loop-setup.ts) ──
  const setup = await runPreLLMSetup(userMessage, profile, client, options.onProgress, {
    enableExecutionGraphScaffold: (options.graphExecutionMode ?? 'auto') !== 'disabled',
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
    if (setup.executionGraphScaffold) {
      upsertRunArtifact(
        runId,
        'execution_graph_scaffold',
        'Execution Graph Scaffold',
        JSON.stringify(setup.executionGraphScaffold.planner, null, 2),
      );
      appendRunEvent(runId, {
        kind: 'execution_graph_scaffold_created',
        phase: 'planning',
        payload: {
          summary: setup.executionGraphScaffold.planner.summary,
          nodeCount: setup.executionGraphScaffold.planner.graph.nodes.length,
          edgeCount: setup.executionGraphScaffold.planner.graph.edges.length,
          parallelBranches: setup.executionGraphScaffold.planner.topology.parallelBranches,
        },
      });
    }
  }

  // ── Extractor agent short-circuit ──
  if (profile.agentProfile === 'ytdlp') {
    if (!client.supportsHarnessGeneration) {
      options.onStreamText?.('Extractor requires a provider that supports nested agent loops (Anthropic). Switch providers to use it.');
      options.onStreamEnd?.();
      cleanupRunControl(runKey);
      return { response: '', toolCalls: [] };
    }
    let ytdlpResult: YtdlpResult;
    try {
      ytdlpResult = await runYtdlpPipeline(userMessage, {
        client,
        apiKey: options.apiKey,
        onProgress: (text) => options.onStreamText?.(text),
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
    cleanupRunControl(runKey);
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
          cleanupRunControl(runKey);
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
      cleanupRunControl(runKey);
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

  const dynamicPrompt = buildDynamicPrompt({
    agentProfile: profile.agentProfile,
    model: modelId,
    toolGroup: profile.toolGroup,
    calendarContext: calendarContext || undefined,
    memoryContext: setup.memoryContext,
    recallContext: setup.recallContext,
    siteContext: setup.siteContext,
    playbookContext: setup.playbookContext,
    harnessContext: setup.harnessContext,
    executionSketchContext: setup.executionSketchContext,
    executionGraphContext: setup.executionGraphContext,
    desktopContext: setup.desktopContext,
    executionConstraint: executionPlan?.constraint,
    shortcutContext: setup.shortcutContext,
    guiStateContext: setup.guiStateContext,
    isGreeting: profile.isGreeting,
    performanceStance: control.performanceStance,
  });

  const graphExecutorFns = resolveGraphExecutorFns();
  if ((options.graphExecutionMode ?? 'auto') !== 'disabled' && graphExecutorFns.canExecuteGraphScaffold?.(setup.executionGraphScaffold)) {
    const graph = setup.executionGraphScaffold!.planner.graph;
    const workerNodes = graph.nodes.filter((node) => node.kind === 'worker');
    const isDependentGraphChain = !!graphExecutorFns.getWorkerDependencyChain?.(graph, workerNodes);
    try {
      if (!graphExecutorFns.executeGraphScaffold) {
        throw new Error('graph executor export unavailable');
      }
      const graphResult = await graphExecutorFns.executeGraphScaffold({
        scaffold: setup.executionGraphScaffold!,
        originalUserMessage: userMessage,
        client,
        staticPrompt,
        dynamicPrompt,
        runWorkerLoop: (workerOptions) => runAgentLoop(workerOptions.userMessage, workerOptions.history, {
          runId: workerOptions.runId,
          provider: workerOptions.provider,
          apiKey: workerOptions.apiKey,
          forcedAgentProfile: workerOptions.forcedAgentProfile,
          allowedTools: workerOptions.allowedTools,
          graphExecutionMode: workerOptions.graphExecutionMode,
          model: workerOptions.model,
          onStreamText: workerOptions.onStreamText,
          onThinking: workerOptions.onThinking,
          onToolActivity: workerOptions.onToolActivity,
          onToolStream: workerOptions.onToolStream,
          onProgress: workerOptions.onProgress,
        }),
        workerBaseOptions: {
          runId,
          provider: options.provider,
          apiKey,
          model: modelId,
          onStreamText: undefined,
          onThinking: undefined,
          onToolActivity: undefined,
          onToolStream: undefined,
          onProgress: undefined,
          graphExecutionMode: 'disabled',
        },
        onGraphEvent: runId ? (event) => {
          appendRunEvent(runId, {
            kind: event.kind,
            phase: event.phase,
            payload: event.payload,
          });
        } : undefined,
        onGraphState: runId ? (snapshot) => {
          upsertRunArtifact(
            runId,
            'execution_graph_state',
            'Execution Graph State',
            JSON.stringify(snapshot, null, 2),
          );
        } : undefined,
      });
      if (graphResult.handled && graphResult.response) {
        onStreamText?.(graphResult.response);
        onStreamEnd?.();
        cleanupRunControl(runKey);
        return { response: graphResult.response, toolCalls: [] };
      }
      if (isDependentGraphChain) {
        const failureMessage = 'Graph execution could not validate the dependent worker chain, so the run was stopped before falling back into the legacy loop. Check the graph state and verification events in the run detail view.';
        console.warn('[GraphExecutor] Dependent graph chain failed verification; stopping instead of falling back to classic loop.');
        if (runId) {
          appendRunEvent(runId, {
            kind: 'execution_graph_chain_stopped',
            phase: 'reviewing',
            payload: {
              message: failureMessage,
              graphId: graph.id,
              workerNodeIds: workerNodes.map((node) => node.id),
            },
          });
        }
        onStreamText?.(failureMessage);
        onStreamEnd?.();
        cleanupRunControl(runKey);
        return { response: failureMessage, toolCalls: [] };
      }
    } catch (error: any) {
      if (isDependentGraphChain) {
        const failureMessage = `Graph execution failed before the dependent worker chain could complete: ${error?.message || String(error)}`;
        console.warn(`[GraphExecutor] ${failureMessage}`);
        if (runId) {
          appendRunEvent(runId, {
            kind: 'execution_graph_chain_stopped',
            phase: 'reviewing',
            payload: {
              message: failureMessage,
              graphId: graph.id,
              workerNodeIds: workerNodes.map((node) => node.id),
            },
          });
        }
        onStreamText?.(failureMessage);
        onStreamEnd?.();
        cleanupRunControl(runKey);
        return { response: failureMessage, toolCalls: [] };
      }
      console.warn(`[GraphExecutor] Falling back to classic loop: ${error?.message || String(error)}`);
      if (runId) {
        appendRunEvent(runId, {
          kind: 'execution_graph_scaffold_fallback',
          phase: 'planning',
          payload: { message: error?.message || String(error) },
        });
      }
    }
  }

  if (false && shouldCreateExecutionPlan(userMessage, profile)) { // DISABLED: plan creation commented out
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
    filesystemQuoteLookupMode,
    strongFilesystemQuoteMatch: false,
    escalatedToFull: false,
    toolCallCount: 0,
    allToolCalls: [],
    allVerifications: [],
    onToolActivity,
    onToolStream,
  };

  let guiBatchNudgeSent = false;
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
  const browserExecutionSketch = setup.browserExecutionSketch;
  let currentBrowserSketchStep = 0;
  let announcedBrowserSketchStep = -1;
  let swarmCompleted = false;

  // ═══════════════════════════════════
  // Iteration Loop
  // ═══════════════════════════════════

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (Date.now() - startTime > MAX_WALL_MS) {
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

    onThinking?.('Thinking...');
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
      messages.push({ role: 'user', content: `[SYSTEM] ${dispatchCtx.toolCallCount} tool calls used (limit: ${MAX_ITERATIONS}). Wrap up.` });
    }

    if (browserExecutionSketch
        && currentBrowserSketchStep < browserExecutionSketch.steps.length
        && announcedBrowserSketchStep !== currentBrowserSketchStep) {
      messages.push({
        role: 'user',
        content: buildBrowserStepControllerPrompt(browserExecutionSketch, currentBrowserSketchStep),
      });
      announcedBrowserSketchStep = currentBrowserSketchStep;
    }

    // ── LLM Call ──
    let iterationText = '';
    let response: LLMResponse;

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
      const completedSketchStep = extractStepDoneMarker(responseText);
      const cleanResponseText = stripStepDoneMarkers(responseText);
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

      const continuationInstruction = shouldForceContinuationAfterPartialExecution(userMessage, dispatchCtx.allToolCalls);
      if (continuationInstruction && iteration < MAX_ITERATIONS - 1) {
        onStreamText?.('\n\n__RESET__');
        messages.push({ role: 'assistant', content: response.content as any });
        messages.push({ role: 'user', content: `[SYSTEM] ${continuationInstruction}` });
        continue;
      }

      if (browserExecutionSketch && currentBrowserSketchStep < browserExecutionSketch.steps.length) {
        const expectedStep = currentBrowserSketchStep + 1;
        const totalSteps = browserExecutionSketch.steps.length;

        if (completedSketchStep !== null && completedSketchStep >= expectedStep) {
          // Advance to the completed step (may jump multiple steps if LLM
          // emitted [STEP_DONE:1] [STEP_DONE:2] [STEP_DONE:3] in one response)
          currentBrowserSketchStep = completedSketchStep;
          announcedBrowserSketchStep = -1;

          if (currentBrowserSketchStep >= totalSteps) {
            // ALL steps are done — let the response through, don't force continuation
            finalText = cleanResponseText;
            if (runId) {
              appendRunEvent(runId, {
                kind: 'assistant_response',
                phase: 'llm',
                payload: { iteration, text: cleanResponseText.slice(0, 1000) },
              });
            }
            break;
          }

          // More steps remain — continue to the next one
          if (iteration < MAX_ITERATIONS - 1) {
            onStreamText?.('\n\n__RESET__');
            messages.push({ role: 'assistant', content: cleanResponseText || `[STEP ${completedSketchStep} COMPLETE]` });
            messages.push({
              role: 'user',
              content: `[SYSTEM] Step ${completedSketchStep} is complete. Continue with step ${currentBrowserSketchStep + 1}/${totalSteps} now.`,
            });
            continue;
          }
        } else if (currentBrowserSketchStep < totalSteps - 1 && iteration < MAX_ITERATIONS - 1) {
          onStreamText?.('\n\n__RESET__');
          messages.push({ role: 'assistant', content: cleanResponseText || response.content as any });
          messages.push({
            role: 'user',
            content: `[SYSTEM] Do not conclude the overall task yet. You are still on step ${expectedStep}/${totalSteps}. When step ${expectedStep} is complete, include [STEP_DONE:${expectedStep}] in your next text response and then continue to the next step.`,
          });
          continue;
        }
      }

      finalText = cleanResponseText;
      if (runId) {
        appendRunEvent(runId, {
          kind: 'assistant_response',
          phase: 'llm',
          payload: { iteration, text: cleanResponseText.slice(0, 1000) },
        });
      }
      break;
    }

    // ── Tool dispatch (extracted to loop-dispatch.ts) ──
    if (iterationText) onStreamText?.('\n\n__RESET__');
    messages.push({ role: 'assistant', content: response.content as any });

    const toolResults = await dispatchTools(toolUseBlocks, dispatchCtx);
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

    if (iteration === MAX_ITERATIONS - 1) {
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
        client,
        messages,
        tools: dispatchCtx.tools,
        staticPrompt,
        dynamicPrompt,
        signal: control.abortController.signal,
        onStreamText,
        onToolActivity,
        allToolCalls: dispatchCtx.allToolCalls,
        toolCallCount: dispatchCtx.toolCallCount,
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
      kind: 'workflow_stage_changed',
      phase: 'lifecycle',
      payload: { workflowStage: 'completed' },
    });
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
  cleanupRunControl(runKey);
  clearNestedCancel();  // guard: clears any registered nested cancel fn on all exit paths

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
