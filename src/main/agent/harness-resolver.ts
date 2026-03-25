import type { PromptModule, TaskProfile } from './classifier';
import type { NormalizedToolDefinition } from './client';
import { resolveModelForProvider } from './provider/factory';
import type {
  CapabilityHealthSignal,
  HarnessLearningSummary,
  HarnessOptimizationHint,
  LearningConfidence,
  ScenarioSummary,
  SystemAuditSummary,
} from './system-audit';
import { EXECUTION_PLANNING_ENABLED } from './runtime-constraints';
import type { ProviderId } from '../../shared/model-registry';

export type HarnessExecutionMode = 'direct' | 'plan_then_execute' | 'step_controlled' | 'deterministic_first';
export type ToolFamily = 'browser' | 'desktop' | 'filesystem' | 'shell' | 'memory';
export type HarnessAdjustmentMode = 'advisory' | 'constraint';
export type HarnessGoalId =
  | 'complete_action'
  | 'produce_artifact'
  | 'gather_evidence'
  | 'compare_and_report'
  | 'modify_workspace'
  | 'verify_state_change'
  | 'safely_apply_change'
  | 'intervention_gated_completion';
export type HarnessSubGoalId =
  | 'navigate'
  | 'locate_target'
  | 'perform_action'
  | 'verify_outcome'
  | 'gather'
  | 'extract'
  | 'compare'
  | 'synthesize'
  | 'produce_report'
  | 'inspect_state'
  | 'prepare_change'
  | 'apply_change'
  | 'verify_change'
  | 'gather_inputs'
  | 'generate_artifact'
  | 'verify_artifact'
  | 'reach_intervention_gate'
  | 'wait_for_intervention'
  | 'resume_completion';
export type HarnessStrategyId =
  | 'direct_balanced'
  | 'deterministic_browser_first'
  | 'narrow_path_verified'
  | 'browser_over_gui'
  | 'verify_before_write'
  | 'low_shell_dependence'
  | 'recovery_constrained'
  | 'intervention_waiting';

export interface HarnessPromptPolicy {
  addModules?: PromptModule[];
  removeModules?: PromptModule[];
  preserveSystemAwareness?: boolean;
  directiveLines?: string[];
}

export interface HarnessProviderStrategy {
  preferredTier?: 'fast' | 'balanced' | 'deep';
  requireCapabilities?: string[];
  note?: string;
}

export interface HarnessToolPolicy {
  preferFamilies?: ToolFamily[];
  discourageFamilies?: ToolFamily[];
  suppressFamilies?: ToolFamily[];
  demotedTools?: string[];
  deterministicBrowserFirst?: boolean;
  avoidGuiWhenDegraded?: boolean;
}

export interface HarnessSafetyPolicy {
  elevatedApproval?: boolean;
  elevatedVerification?: boolean;
  preferHumanInterventionOverRetry?: boolean;
}

export interface HarnessResponsePolicy {
  evidenceOrientedFinish?: boolean;
  requireVerificationSummary?: boolean;
}

export interface HarnessResolutionInput {
  userMessage: string;
  profile: TaskProfile;
  provider: ProviderId;
  initialModel: string;
  forcedAgentProfile?: string;
  allowedTools?: string[];
  systemAuditSummary: SystemAuditSummary;
}

export type HarnessRetryGuidance = 'standard' | 'verify_before_retry' | 'avoid_repeated_retries';
export type HarnessBranchingGuidance = 'standard' | 'narrow_path' | 'deterministic_first';

export interface HarnessReactiveAdjustment {
  id: string;
  reason: string;
  signals: string[];
  effect: string;
  mode: HarnessAdjustmentMode;
  trigger: string;
  supersedesBase?: boolean;
}

export interface HarnessStrategyShift {
  id: string;
  from: HarnessStrategyId;
  to: HarnessStrategyId;
  trigger: string;
  reason: string;
  effect: string;
  mode: HarnessAdjustmentMode;
  signals: string[];
  supersedesBase?: boolean;
}

export interface HarnessGoalAdjustment {
  id: string;
  from: HarnessGoalId;
  to: HarnessGoalId;
  trigger: string;
  reason: string;
  effect: string;
  signals: string[];
  narrowed: boolean;
  mode: HarnessAdjustmentMode;
}

export interface HarnessSubGoalAdjustment {
  id: string;
  from: HarnessSubGoalId;
  to: HarnessSubGoalId;
  trigger: string;
  reason: string;
  effect: string;
  signals: string[];
  mode: HarnessAdjustmentMode;
}

export interface RuntimeHarnessSignal {
  kind: 'tool_result' | 'verification_failed' | 'recovery_invoked' | 'human_intervention_required';
  iterationIndex: number;
  toolName?: string;
  toolFamily?: ToolFamily;
  success?: boolean;
  detail?: string;
  verificationType?: string;
  transition?: string;
}

export interface RuntimeHarnessReactiveState {
  successfulToolCount: number;
  failedToolCount: number;
  toolFailureCounts: Record<string, number>;
  familyFailureCounts: Partial<Record<ToolFamily, number>>;
  transitionFailureCounts: Record<string, number>;
  recoveryCount: number;
  verificationFailureCount: number;
  humanInterventionCount: number;
  lastToolFamily?: ToolFamily;
  firedAdjustmentIds: string[];
  appliedStrategyShiftKeys: string[];
  appliedGoalAdjustmentKeys: string[];
  appliedSubGoalAdjustmentKeys: string[];
  toolSuccessCounts: Record<string, number>;
  familySuccessCounts: Partial<Record<ToolFamily, number>>;
  signalHistory: RuntimeHarnessSignal[];
}

export interface HarnessDefinition {
  id: string;
  description: string;
  priority: number;
  applies(input: HarnessResolutionInput): boolean;
  executionMode: HarnessExecutionMode;
  promptPolicy?: HarnessPromptPolicy;
  providerStrategy?: HarnessProviderStrategy;
  toolPolicy?: HarnessToolPolicy;
  safetyPolicy?: HarnessSafetyPolicy;
  responsePolicy?: HarnessResponsePolicy;
}

export interface ResolvedHarness {
  id: string;
  baseHarnessId: string;
  baseGoal: HarnessGoalId;
  currentGoal: HarnessGoalId;
  baseSubGoalPlan: HarnessSubGoalId[];
  currentSubGoal: HarnessSubGoalId;
  completedSubGoals: HarnessSubGoalId[];
  subGoalAdjustments: HarnessSubGoalAdjustment[];
  subGoalConfidence: number;
  subGoalProgressSignals: string[];
  stageAwareNotes: string[];
  goalConfidence: number;
  goalDriftSignals: string[];
  goalAdjustments: HarnessGoalAdjustment[];
  goalAwareNotes: string[];
  baseStrategy: HarnessStrategyId;
  currentStrategy: HarnessStrategyId;
  description: string;
  priority: number;
  requestedExecutionMode: HarnessExecutionMode;
  actualExecutionMode: HarnessExecutionMode;
  downgradeReason?: string;
  promptPolicy: HarnessPromptPolicy;
  providerStrategy: HarnessProviderStrategy;
  toolPolicy: HarnessToolPolicy;
  safetyPolicy: HarnessSafetyPolicy;
  responsePolicy: HarnessResponsePolicy;
  retryGuidance: HarnessRetryGuidance;
  branchingGuidance: HarnessBranchingGuidance;
  reactiveNotes: string[];
  adaptationReasons: string[];
  reactiveAdjustments: HarnessReactiveAdjustment[];
  inLoopAdjustments: HarnessReactiveAdjustment[];
  strategyShiftHistory: HarnessStrategyShift[];
  strategyShiftReasons: string[];
  hadInLoopAdaptation: boolean;
  auditSignalsUsed: string[];
  learningPatternKey: string;
  learningConfidence?: LearningConfidence;
  learningEvidenceSummary: string[];
  appliedLearningHints: HarnessOptimizationHint[];
  learningInfluencedStart: boolean;
  selectedModel: string;
  providerStrategyNote: string;
  matchedHarnessIds: string[];
}

function browserHealth(summary: SystemAuditSummary): CapabilityHealthSignal | undefined {
  return summary.capabilityHealth.find((signal) => signal.subsystem === 'browser_automation');
}

function guiHealth(summary: SystemAuditSummary): CapabilityHealthSignal | undefined {
  return summary.capabilityHealth.find((signal) => signal.subsystem === 'gui_automation');
}

function planningHealth(summary: SystemAuditSummary): CapabilityHealthSignal | undefined {
  return summary.capabilityHealth.find((signal) => signal.subsystem === 'planning');
}

function subAgentHealth(summary: SystemAuditSummary): CapabilityHealthSignal | undefined {
  return summary.capabilityHealth.find((signal) => signal.subsystem === 'sub_agent_swarm');
}

function shellHealth(summary: SystemAuditSummary): CapabilityHealthSignal | undefined {
  return summary.capabilityHealth.find((signal) => signal.subsystem === 'shell_cli');
}

function isResearchPrompt(text: string): boolean {
  return /\b(compare|research|analyze|analysis|report|summarize|extract|latest|recommend|evidence|findings)\b/i.test(text);
}

function isBrowserTransactionPrompt(text: string): boolean {
  return /\b(login|sign[ -]?in|checkout|buy|purchase|book|reserve|submit|post|publish|send|fill|form|compose|reply|apply|register|signup|sign[ -]?up)\b/i.test(text);
}

function isHighSafetyPrompt(text: string): boolean {
  return /\b(rm\s+-rf|sudo|delete|destroy|wipe|publish|push|bulk|sensitive|approval|production|system package|apply plan|filesystem moves?)\b/i.test(text);
}

function hasWeakWorkflowSignals(summary: SystemAuditSummary): boolean {
  return summary.scenarioSummaries.some((scenario) =>
    scenario.workflowCohesionScore < 6
    || scenario.retryBurden >= 2
    || scenario.fragileTransitions.length > 0,
  );
}

function isDesktopPrompt(input: HarnessResolutionInput): boolean {
  return input.profile.promptModules.has('desktop_apps');
}

function isCodingPrompt(input: HarnessResolutionInput): boolean {
  return input.profile.promptModules.has('coding') || input.profile.promptModules.has('filesystem');
}

function mergePromptPolicy(base?: HarnessPromptPolicy): HarnessPromptPolicy {
  return {
    addModules: [...(base?.addModules || [])],
    removeModules: [...(base?.removeModules || [])],
    preserveSystemAwareness: base?.preserveSystemAwareness ?? true,
    directiveLines: [...(base?.directiveLines || [])],
  };
}

function mergeProviderStrategy(base?: HarnessProviderStrategy): HarnessProviderStrategy {
  return {
    preferredTier: base?.preferredTier,
    requireCapabilities: [...(base?.requireCapabilities || [])],
    note: base?.note || '',
  };
}

function mergeToolPolicy(base?: HarnessToolPolicy): HarnessToolPolicy {
  return {
    preferFamilies: [...(base?.preferFamilies || [])],
    discourageFamilies: [...(base?.discourageFamilies || [])],
    suppressFamilies: [...(base?.suppressFamilies || [])],
    demotedTools: [...(base?.demotedTools || [])],
    deterministicBrowserFirst: base?.deterministicBrowserFirst ?? false,
    avoidGuiWhenDegraded: base?.avoidGuiWhenDegraded ?? false,
  };
}

function mergeSafetyPolicy(base?: HarnessSafetyPolicy): HarnessSafetyPolicy {
  return {
    elevatedApproval: base?.elevatedApproval ?? false,
    elevatedVerification: base?.elevatedVerification ?? false,
    preferHumanInterventionOverRetry: base?.preferHumanInterventionOverRetry ?? false,
  };
}

function mergeResponsePolicy(base?: HarnessResponsePolicy): HarnessResponsePolicy {
  return {
    evidenceOrientedFinish: base?.evidenceOrientedFinish ?? false,
    requireVerificationSummary: base?.requireVerificationSummary ?? false,
  };
}

function pickPrimaryScenario(summary: SystemAuditSummary): ScenarioSummary | null {
  if (summary.scenarioSummaries.length === 0) return null;
  const ranked = [...summary.scenarioSummaries].sort((left, right) =>
    left.workflowCohesionScore - right.workflowCohesionScore
    || right.retryBurden - left.retryBurden
    || right.repeatedFailureClusterCount - left.repeatedFailureClusterCount
    || (right.fragileTransitions[0]?.failureRate || 0) - (left.fragileTransitions[0]?.failureRate || 0)
    || left.scenario.id.localeCompare(right.scenario.id),
  );
  return ranked[0] || null;
}

function hasSparseAuditData(summary: SystemAuditSummary): boolean {
  return summary.observedRuns < 3
    || summary.workflowSummary.sparseDataWarnings.length > 0
    || (summary.capabilityHealth.length > 0 && summary.capabilityHealth.every((signal) => signal.confidenceScore < 0.5 || signal.sampleSize < 3));
}

function mentionsExplicitDesktopRequirement(input: HarnessResolutionInput): boolean {
  return input.profile.promptModules.has('desktop_apps');
}

function mentionsExplicitBrowserRequirement(input: HarnessResolutionInput): boolean {
  return input.profile.promptModules.has('browser');
}

function ensureUnique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function inferBaseGoal(input: HarnessResolutionInput): { goal: HarnessGoalId; confidence: number } {
  const message = input.userMessage;
  if (isHighSafetyPrompt(message)) return { goal: 'safely_apply_change', confidence: 0.9 };
  if (input.profile.promptModules.has('research') && /\b(compare|comparison|versus|vs\.?|report)\b/i.test(message)) {
    return { goal: 'compare_and_report', confidence: 0.9 };
  }
  if (input.profile.promptModules.has('research')) return { goal: 'gather_evidence', confidence: 0.85 };
  if (input.profile.promptModules.has('coding') || input.profile.promptModules.has('filesystem')) {
    return { goal: 'modify_workspace', confidence: 0.85 };
  }
  if (/\b(verify|confirm|check whether|validate|ensure)\b/i.test(message)) {
    return { goal: 'verify_state_change', confidence: 0.8 };
  }
  if (input.profile.promptModules.has('browser') && isBrowserTransactionPrompt(message)) {
    return { goal: 'complete_action', confidence: 0.9 };
  }
  if (/\b(write|save|create|generate|export|document|markdown|report)\b/i.test(message)) {
    return { goal: 'produce_artifact', confidence: 0.75 };
  }
  return { goal: 'complete_action', confidence: 0.6 };
}

function buildBaseSubGoalPlan(goal: HarnessGoalId): HarnessSubGoalId[] {
  switch (goal) {
    case 'complete_action':
      return ['navigate', 'locate_target', 'perform_action', 'verify_outcome'];
    case 'compare_and_report':
      return ['gather', 'extract', 'compare', 'synthesize', 'produce_report'];
    case 'gather_evidence':
      return ['gather', 'extract', 'synthesize', 'produce_report'];
    case 'modify_workspace':
      return ['inspect_state', 'prepare_change', 'apply_change', 'verify_change'];
    case 'safely_apply_change':
      return ['inspect_state', 'prepare_change', 'apply_change', 'verify_change'];
    case 'produce_artifact':
      return ['gather_inputs', 'generate_artifact', 'verify_artifact'];
    case 'verify_state_change':
      return ['inspect_state', 'verify_change'];
    case 'intervention_gated_completion':
      return ['reach_intervention_gate', 'wait_for_intervention', 'resume_completion', 'verify_outcome'];
    default:
      return ['navigate', 'verify_outcome'];
  }
}

function inferSubGoalConfidence(goal: HarnessGoalId): number {
  switch (goal) {
    case 'complete_action':
    case 'compare_and_report':
    case 'modify_workspace':
    case 'safely_apply_change':
      return 0.85;
    case 'gather_evidence':
    case 'produce_artifact':
    case 'verify_state_change':
      return 0.75;
    case 'intervention_gated_completion':
      return 0.8;
    default:
      return 0.6;
  }
}

function canNarrowGoal(from: HarnessGoalId, to: HarnessGoalId): boolean {
  if (from === to) return true;
  const allowed: Record<HarnessGoalId, HarnessGoalId[]> = {
    complete_action: ['verify_state_change', 'intervention_gated_completion'],
    produce_artifact: ['verify_state_change', 'intervention_gated_completion'],
    gather_evidence: ['compare_and_report', 'produce_artifact', 'intervention_gated_completion'],
    compare_and_report: ['produce_artifact', 'verify_state_change', 'intervention_gated_completion'],
    modify_workspace: ['safely_apply_change', 'verify_state_change', 'intervention_gated_completion'],
    verify_state_change: ['intervention_gated_completion'],
    safely_apply_change: ['verify_state_change', 'intervention_gated_completion'],
    intervention_gated_completion: [],
  };
  return (allowed[from] || []).includes(to);
}

function resolveBaseStrategy(definitionId: string, toolPolicy: HarnessToolPolicy, safetyPolicy: HarnessSafetyPolicy, responsePolicy: HarnessResponsePolicy): HarnessStrategyId {
  if (definitionId === 'browser_transaction' || toolPolicy.deterministicBrowserFirst) return 'deterministic_browser_first';
  if (definitionId === 'high_safety' || safetyPolicy.elevatedVerification || responsePolicy.requireVerificationSummary) return 'narrow_path_verified';
  return 'direct_balanced';
}

function hasFired(state: RuntimeHarnessReactiveState, id: string): boolean {
  return state.firedAdjustmentIds.includes(id);
}

function markFired(state: RuntimeHarnessReactiveState, id: string): void {
  if (!state.firedAdjustmentIds.includes(id)) state.firedAdjustmentIds.push(id);
}

export const HARNESS_DEFINITIONS: HarnessDefinition[] = [
  {
    id: 'high_safety',
    description: 'Elevated approval and verification posture for sensitive or destructive work.',
    priority: 100,
    applies: (input) => isHighSafetyPrompt(input.userMessage),
    executionMode: 'plan_then_execute',
    providerStrategy: {
      preferredTier: 'deep',
      note: 'Bias toward deeper reasoning for sensitive work unless the runtime or explicit model selection overrides it.',
    },
    toolPolicy: {
      discourageFamilies: ['desktop'],
      avoidGuiWhenDegraded: true,
    },
    safetyPolicy: {
      elevatedApproval: true,
      elevatedVerification: true,
      preferHumanInterventionOverRetry: true,
    },
    responsePolicy: {
      requireVerificationSummary: true,
    },
    promptPolicy: {
      directiveLines: [
        'Use narrower, reviewable steps.',
        'Treat approvals and verification as first-class requirements.',
      ],
    },
  },
  {
    id: 'desktop_operator',
    description: 'Desktop and app-control oriented operator harness.',
    priority: 80,
    applies: (input) => isDesktopPrompt(input),
    executionMode: 'direct',
    toolPolicy: {
      preferFamilies: ['desktop', 'browser'],
      avoidGuiWhenDegraded: true,
    },
    providerStrategy: {
      preferredTier: 'balanced',
      note: 'Keep desktop execution responsive while preserving enough reasoning depth for stateful app control.',
    },
    promptPolicy: {
      addModules: ['desktop_apps'],
      directiveLines: [
        'Use desktop capability context and app routing constraints.',
        'Avoid GUI-first behavior when GUI automation health is degraded.',
      ],
    },
  },
  {
    id: 'browser_transaction',
    description: 'Deterministic-first browser harness for transactional browser work.',
    priority: 70,
    applies: (input) => input.profile.promptModules.has('browser') && isBrowserTransactionPrompt(input.userMessage),
    executionMode: 'deterministic_first',
    toolPolicy: {
      preferFamilies: ['browser'],
      discourageFamilies: ['desktop'],
      deterministicBrowserFirst: true,
      avoidGuiWhenDegraded: true,
    },
    safetyPolicy: {
      preferHumanInterventionOverRetry: true,
    },
    providerStrategy: {
      preferredTier: 'balanced',
      note: 'Prefer deterministic browser paths and keep the execution model responsive for stepwise interaction.',
    },
    promptPolicy: {
      addModules: ['browser'],
      directiveLines: [
        'Try site harnesses and saved browser executors before open-ended browsing.',
        'Prefer browser tools over GUI tools when either can complete the task.',
      ],
    },
  },
  {
    id: 'research',
    description: 'Evidence-oriented browser research and extraction harness.',
    priority: 60,
    applies: (input) => input.profile.promptModules.has('research') || (input.profile.promptModules.has('browser') && isResearchPrompt(input.userMessage)),
    executionMode: 'step_controlled',
    toolPolicy: {
      preferFamilies: ['browser', 'memory'],
      discourageFamilies: ['desktop'],
      avoidGuiWhenDegraded: true,
    },
    providerStrategy: {
      preferredTier: 'deep',
      note: 'Prefer deeper reasoning for evidence synthesis and structured comparison unless an explicit model overrides it.',
    },
    responsePolicy: {
      evidenceOrientedFinish: true,
      requireVerificationSummary: true,
    },
    promptPolicy: {
      addModules: ['research', 'browser'],
      directiveLines: [
        'Prefer evidence-backed extraction and concise synthesis.',
        'Avoid GUI unless browser or filesystem tooling cannot complete the task.',
        'Never navigate to about:blank or any empty URL during research. Blank navigations are invalid.',
        'If the needed information may already be on the current page, use browser_read_page or browser_extract instead of navigating away.',
      ],
    },
  },
  {
    id: 'coding',
    description: 'Narrow coding/filesystem specialization.',
    priority: 50,
    applies: (input) => isCodingPrompt(input),
    executionMode: 'direct',
    toolPolicy: {
      preferFamilies: ['filesystem', 'shell', 'memory'],
    },
    providerStrategy: {
      preferredTier: 'balanced',
      note: 'Keep coding runs on a balanced model by default unless an explicit model or higher-priority harness overrides it.',
    },
    promptPolicy: {
      addModules: ['coding'],
      directiveLines: [
        'Keep code changes reviewable and grounded in the current workspace.',
      ],
    },
  },
  {
    id: 'default_operator',
    description: 'Balanced operator default for general cross-domain work.',
    priority: 0,
    applies: () => true,
    executionMode: 'direct',
    providerStrategy: {
      preferredTier: 'balanced',
      note: 'Use the balanced default posture for general operator work.',
    },
    promptPolicy: {
      preserveSystemAwareness: true,
      directiveLines: [
        'Stay balanced and operator-oriented across browser, filesystem, desktop, and shell surfaces.',
      ],
    },
  },
];

function resolveActualExecutionMode(requested: HarnessExecutionMode, summary: SystemAuditSummary): {
  actualExecutionMode: HarnessExecutionMode;
  downgradeReason?: string;
} {
  if (requested === 'plan_then_execute') {
    const planning = planningHealth(summary);
    if (!EXECUTION_PLANNING_ENABLED) {
      return {
        actualExecutionMode: 'direct',
        downgradeReason: 'planning disabled by runtime constraints',
      };
    }
    if (planning?.status === 'degraded' || planning?.status === 'disabled') {
      return {
        actualExecutionMode: 'direct',
        downgradeReason: 'planning downgraded because planning health is not currently reliable',
      };
    }
  }
  return { actualExecutionMode: requested };
}

function resolveSelectedModel(input: HarnessResolutionInput, providerStrategy: HarnessProviderStrategy): {
  selectedModel: string;
  note: string;
} {
  const required = providerStrategy.requireCapabilities || [];
  if (required.includes('supportsHarnessGeneration')) {
    const supportedProviders = new Set<ProviderId>(['anthropic', 'openai']);
    if (!supportedProviders.has(input.provider)) {
      return {
        selectedModel: input.initialModel,
        note: `${providerStrategy.note || 'Keep current model.'} Required capability unavailable on ${input.provider}, so the initial model was retained.`,
      };
    }
  }

  if (!providerStrategy.preferredTier) {
    return {
      selectedModel: input.initialModel,
      note: providerStrategy.note || 'Retained the initial model selection.',
    };
  }

  const tierAlias =
    providerStrategy.preferredTier === 'deep' ? 'opus' :
      providerStrategy.preferredTier === 'fast' ? 'haiku' :
        'sonnet';
  const selectedModel = resolveModelForProvider(input.provider, tierAlias);
  if (selectedModel === input.initialModel) {
    return {
      selectedModel,
      note: providerStrategy.note || 'Retained the initial model selection.',
    };
  }

  return {
    selectedModel,
    note: providerStrategy.note || `Adjusted model selection to ${providerStrategy.preferredTier}.`,
  };
}

function buildLearningPatternKey(harnessId: string, baseGoal: HarnessGoalId): string {
  return `${harnessId}:${baseGoal}`;
}

function findLearningSummary(
  summary: SystemAuditSummary,
  harnessId: string,
  baseGoal: HarnessGoalId,
): HarnessLearningSummary | undefined {
  const key = buildLearningPatternKey(harnessId, baseGoal);
  return summary.harnessLearningSummaries.find((entry) => entry.patternKey === key);
}

function rankHarnessWithLearning(
  definition: HarnessDefinition,
  baseGoal: HarnessGoalId,
  summary: SystemAuditSummary,
): { definition: HarnessDefinition; learningSummary?: HarnessLearningSummary; score: number } {
  const learningSummary = findLearningSummary(summary, definition.id, baseGoal);
  const confidenceScore = learningSummary?.confidence.score || 0;
  const completionRate = learningSummary?.completionRate || 0;
  return {
    definition,
    learningSummary,
    score: definition.priority + (confidenceScore >= 0.5 ? completionRate + confidenceScore * 0.25 : 0),
  };
}

function shouldPromoteLearnedHarness(
  leader: { definition: HarnessDefinition; learningSummary?: HarnessLearningSummary; score: number },
  challenger: { definition: HarnessDefinition; learningSummary?: HarnessLearningSummary; score: number },
): boolean {
  if (!challenger.learningSummary) return false;
  if (challenger.learningSummary.confidence.score < 0.6) return false;
  if (!challenger.learningSummary.optimizationHints.some((hint) => hint.kind === 'prefer_harness_start')) return false;
  if (leader.definition.priority - challenger.definition.priority > 1) return false;
  return challenger.learningSummary.completionRate >= (leader.learningSummary?.completionRate || 0) + 0.2;
}

function applyLearningHints(
  params: {
    baseGoal: HarnessGoalId;
    currentGoal: HarnessGoalId;
    baseSubGoalPlan: HarnessSubGoalId[];
    currentSubGoal: HarnessSubGoalId;
    baseStrategy: HarnessStrategyId;
    currentStrategy: HarnessStrategyId;
    promptPolicy: HarnessPromptPolicy;
    toolPolicy: HarnessToolPolicy;
    retryGuidance: HarnessRetryGuidance;
    branchingGuidance: HarnessBranchingGuidance;
    reactiveNotes: string[];
    adaptationReasons: string[];
    auditSignalsUsed: string[];
    goalAwareNotes: string[];
    stageAwareNotes: string[];
  },
  learningSummary: HarnessLearningSummary | undefined,
): { appliedHints: HarnessOptimizationHint[]; evidenceSummary: string[]; learningInfluencedStart: boolean } {
  if (!learningSummary || learningSummary.confidence.sparse) {
    return {
      appliedHints: [],
      evidenceSummary: learningSummary?.evidenceSummary || [],
      learningInfluencedStart: false,
    };
  }

  const appliedHints: HarnessOptimizationHint[] = [];
  let learningInfluencedStart = false;
  for (const hint of learningSummary.optimizationHints) {
    if (hint.confidence.score < 0.5) continue;
    switch (hint.kind) {
      case 'prefer_strategy_start':
        if (hint.preferStrategy) {
          params.baseStrategy = hint.preferStrategy as HarnessStrategyId;
          params.currentStrategy = params.baseStrategy;
          learningInfluencedStart = true;
        }
        if (hint.demoteFamily && !params.toolPolicy.discourageFamilies?.includes(hint.demoteFamily as ToolFamily)) {
          params.toolPolicy.discourageFamilies = [...(params.toolPolicy.discourageFamilies || []), hint.demoteFamily as ToolFamily];
          learningInfluencedStart = true;
        }
        break;
      case 'demote_tool_family':
        if (hint.demoteFamily && !params.toolPolicy.discourageFamilies?.includes(hint.demoteFamily as ToolFamily)) {
          params.toolPolicy.discourageFamilies = [...(params.toolPolicy.discourageFamilies || []), hint.demoteFamily as ToolFamily];
          learningInfluencedStart = true;
        }
        break;
      case 'tighten_goal_posture':
        if (hint.preferGoal && canNarrowGoal(params.baseGoal, hint.preferGoal as HarnessGoalId)) {
          params.currentGoal = hint.preferGoal as HarnessGoalId;
          learningInfluencedStart = true;
        }
        if (hint.preferStrategy) {
          params.baseStrategy = hint.preferStrategy as HarnessStrategyId;
          params.currentStrategy = params.baseStrategy;
          learningInfluencedStart = true;
        }
        break;
      case 'stage_caution':
        if (hint.cautionSubGoal && params.baseSubGoalPlan.includes(hint.cautionSubGoal as HarnessSubGoalId)) {
          params.stageAwareNotes.push(`Learned caution: similar runs often stall at ${hint.cautionSubGoal}.`);
        }
        if (hint.branchingGuidance && params.branchingGuidance === 'standard') {
          params.branchingGuidance = hint.branchingGuidance as HarnessBranchingGuidance;
        }
        break;
      case 'transition_caution':
        if (hint.cautionTransition) {
          params.stageAwareNotes.push(`Learned transition caution: ${hint.cautionTransition}.`);
        }
        if (hint.retryGuidance && params.retryGuidance === 'standard') {
          params.retryGuidance = hint.retryGuidance as HarnessRetryGuidance;
        }
        break;
      case 'prefer_retry_guidance':
        if (hint.retryGuidance && params.retryGuidance === 'standard') {
          params.retryGuidance = hint.retryGuidance as HarnessRetryGuidance;
          learningInfluencedStart = true;
        }
        if (hint.branchingGuidance && params.branchingGuidance === 'standard') {
          params.branchingGuidance = hint.branchingGuidance as HarnessBranchingGuidance;
          learningInfluencedStart = true;
        }
        break;
      default:
        break;
    }

    params.promptPolicy.directiveLines = [
      ...(params.promptPolicy.directiveLines || []),
      `Apply learned start-of-run caution: ${hint.effect}`,
    ];
    params.reactiveNotes.push(`Learned start bias applied: ${hint.effect}`);
    params.adaptationReasons.push(`cross-run learning: ${hint.reason}`);
    params.auditSignalsUsed.push(`learning:${learningSummary.patternKey}:${hint.id}`);
    appliedHints.push(hint);
  }

  return {
    appliedHints,
    evidenceSummary: learningSummary.evidenceSummary,
    learningInfluencedStart,
  };
}

export function resolveHarness(input: HarnessResolutionInput): ResolvedHarness {
  const { goal: inferredBaseGoal, confidence: goalConfidence } = inferBaseGoal(input);
  const matched = HARNESS_DEFINITIONS.filter((definition) => definition.applies(input));
  const ranked = matched
    .map((definition) => rankHarnessWithLearning(definition, inferredBaseGoal, input.systemAuditSummary))
    .sort((a, b) =>
      b.score - a.score
      || b.definition.priority - a.definition.priority
      || a.definition.id.localeCompare(b.definition.id));
  const selectedRank = ranked.length > 1 && shouldPromoteLearnedHarness(ranked[0], ranked[1])
    ? ranked[1]
    : ranked[0];
  const selected = selectedRank?.definition || HARNESS_DEFINITIONS[HARNESS_DEFINITIONS.length - 1];
  const selectedLearningSummary = selectedRank?.learningSummary;

  const promptPolicy = mergePromptPolicy(selected.promptPolicy);
  const toolPolicy = mergeToolPolicy(selected.toolPolicy);
  const safetyPolicy = mergeSafetyPolicy(selected.safetyPolicy);
  const responsePolicy = mergeResponsePolicy(selected.responsePolicy);
  const providerStrategy = mergeProviderStrategy(selected.providerStrategy);
  const reactiveAdjustments: HarnessReactiveAdjustment[] = [];
  const reactiveNotes: string[] = [];
  const adaptationReasons: string[] = [];
  const auditSignalsUsed: string[] = [];
  let retryGuidance: HarnessRetryGuidance = 'standard';
  let branchingGuidance: HarnessBranchingGuidance = toolPolicy.deterministicBrowserFirst ? 'deterministic_first' : 'standard';

  const gui = guiHealth(input.systemAuditSummary);
  const browser = browserHealth(input.systemAuditSummary);
  const planning = planningHealth(input.systemAuditSummary);
  const subAgent = subAgentHealth(input.systemAuditSummary);
  const shell = shellHealth(input.systemAuditSummary);
  const primaryScenario = pickPrimaryScenario(input.systemAuditSummary);
  const sparseAuditData = hasSparseAuditData(input.systemAuditSummary);

  if (toolPolicy.avoidGuiWhenDegraded && gui?.status === 'degraded') {
    auditSignalsUsed.push('capability:gui_automation=degraded');
    if (!toolPolicy.discourageFamilies?.includes('desktop')) {
      toolPolicy.discourageFamilies = [...(toolPolicy.discourageFamilies || []), 'desktop'];
    }
    if (!toolPolicy.preferFamilies?.includes('browser') && browser && input.profile.promptModules.has('browser')) {
      toolPolicy.preferFamilies = ['browser', ...(toolPolicy.preferFamilies || [])];
    }
    if (
      gui.sampleSize >= 3
      && gui.confidenceScore >= 0.5
      && browser?.status === 'healthy'
      && browser.confidenceScore >= 0.5
      && mentionsExplicitBrowserRequirement(input)
      && !mentionsExplicitDesktopRequirement(input)
    ) {
      toolPolicy.suppressFamilies = ensureUnique([...(toolPolicy.suppressFamilies || []), 'desktop']);
    }
    promptPolicy.directiveLines = [
      ...(promptPolicy.directiveLines || []),
      'GUI automation health is degraded; prefer browser or non-GUI paths when feasible.',
    ];
    reactiveNotes.push('GUI degraded relative to browser; desktop paths were demoted.');
    adaptationReasons.push('degraded GUI health with viable browser alternative');
    reactiveAdjustments.push({
      id: 'prefer_browser_over_gui',
      reason: 'GUI automation is degraded while browser automation remains viable.',
      signals: ['capability:gui_automation=degraded', browser ? `capability:browser_automation=${browser.status}` : 'capability:browser_automation=unknown'],
      effect: toolPolicy.suppressFamilies?.includes('desktop')
        ? 'suppressed desktop tool family and promoted browser'
        : 'demoted desktop tool family and promoted browser',
      mode: toolPolicy.suppressFamilies?.includes('desktop') ? 'constraint' : 'advisory',
      trigger: 'degraded GUI health with viable browser alternative',
    });
  }

  if (!EXECUTION_PLANNING_ENABLED || planning?.status === 'degraded' || planning?.status === 'disabled' || planning?.status === 'unproven') {
    auditSignalsUsed.push(!EXECUTION_PLANNING_ENABLED ? 'runtime:planning=disabled' : `capability:planning=${planning?.status || 'unknown'}`);
    reactiveNotes.push('Planning-first behavior is not reliable in the current runtime state.');
    adaptationReasons.push('planning unavailable or low-confidence');
    reactiveAdjustments.push({
      id: 'avoid_planning_first',
      reason: !EXECUTION_PLANNING_ENABLED
        ? 'Planning is disabled by runtime constraints.'
        : `Planning capability is currently ${planning?.status}.`,
      signals: [!EXECUTION_PLANNING_ENABLED ? 'runtime:planning=disabled' : `capability:planning=${planning?.status || 'unknown'}`],
      effect: 'kept planning posture downgraded or avoided planning-first guidance',
      mode: 'advisory',
      trigger: 'planning unavailable or low-confidence',
    });
  }

  if (subAgent?.status === 'degraded') {
    auditSignalsUsed.push('capability:sub_agent_swarm=degraded');
    reactiveNotes.push('Sub-agent health is weak; keep the run on a narrower single-path execution posture.');
    adaptationReasons.push('sub-agent capability degraded');
    branchingGuidance = branchingGuidance === 'deterministic_first' ? branchingGuidance : 'narrow_path';
    reactiveAdjustments.push({
      id: 'avoid_subagent_heavy_posture',
      reason: 'Recent sub-agent swarm health is degraded.',
      signals: ['capability:sub_agent_swarm=degraded'],
      effect: 'reduced branching guidance and discouraged multi-branch behavior',
      mode: 'advisory',
      trigger: 'sub-agent capability degraded',
    });
  }

  if (!sparseAuditData && primaryScenario && (primaryScenario.workflowCohesionScore < 6 || primaryScenario.retryBurden >= 2)) {
    auditSignalsUsed.push(`scenario:${primaryScenario.scenario.id}`);
    branchingGuidance = branchingGuidance === 'deterministic_first' ? branchingGuidance : 'narrow_path';
    retryGuidance = primaryScenario.retryBurden >= 2 ? 'verify_before_retry' : retryGuidance;
    promptPolicy.directiveLines = [
      ...(promptPolicy.directiveLines || []),
      'Current workflow data suggests narrower deterministic paths outperform exploratory branching.',
    ];
    reactiveNotes.push(`Workflow fragility detected in ${primaryScenario.scenario.id}; branching guidance narrowed.`);
    adaptationReasons.push('low workflow cohesion or elevated retry burden');
    reactiveAdjustments.push({
      id: 'narrow_for_fragile_workflow',
      reason: `Scenario ${primaryScenario.scenario.id} shows low cohesion (${primaryScenario.workflowCohesionScore.toFixed(1)}) or elevated retry burden (${primaryScenario.retryBurden.toFixed(1)}).`,
      signals: [
        `scenario:workflow_cohesion=${primaryScenario.workflowCohesionScore.toFixed(1)}`,
        `scenario:retry_burden=${primaryScenario.retryBurden.toFixed(1)}`,
      ],
      effect: 'set narrow-path branching guidance and verify-before-retry posture',
      mode: 'advisory',
      trigger: 'low workflow cohesion or elevated retry burden',
    });
  }

  if (!sparseAuditData && primaryScenario?.fragileTransitions.length) {
    const fragile = primaryScenario.fragileTransitions[0];
    auditSignalsUsed.push(`scenario:fragile_transition=${fragile.transition}`);
    promptPolicy.directiveLines = [
      ...(promptPolicy.directiveLines || []),
      `Fragile transition observed: ${fragile.transition}; verify state explicitly before crossing phases.`,
    ];
    branchingGuidance = branchingGuidance === 'deterministic_first' ? branchingGuidance : 'narrow_path';
    reactiveNotes.push(`Fragile transition ${fragile.transition} detected; explicit intermediate verification encouraged.`);
    adaptationReasons.push('fragile transition observed in workflow traces');
    reactiveAdjustments.push({
      id: 'fragile_transition_caution',
      reason: `Recent workflow traces show ${fragile.transition} as a fragile transition.`,
      signals: [
        `scenario:fragile_transition=${fragile.transition}`,
        `scenario:fragile_failure_rate=${fragile.failureRate.toFixed(2)}`,
      ],
      effect: 'added transition-specific caution and narrowed branching guidance',
      mode: 'advisory',
      trigger: 'fragile transition observed in workflow traces',
    });
  }

  if (!sparseAuditData && primaryScenario?.repeatedFailureClusterCount && primaryScenario.repeatedFailureClusterCount >= 1) {
    const failureTool = primaryScenario.mostCommonFailureTool;
    const failureSubsystem = primaryScenario.mostCommonFailureSubsystem;
    if (failureTool) toolPolicy.demotedTools = ensureUnique([...(toolPolicy.demotedTools || []), failureTool]);
    if (failureSubsystem === 'shell_cli') toolPolicy.discourageFamilies = ensureUnique([...(toolPolicy.discourageFamilies || []), 'shell']);
    if (failureSubsystem === 'gui_automation') toolPolicy.discourageFamilies = ensureUnique([...(toolPolicy.discourageFamilies || []), 'desktop']);
    retryGuidance = 'avoid_repeated_retries';
    auditSignalsUsed.push(`scenario:failure_cluster=${primaryScenario.repeatedFailureClusterCount}`);
    reactiveNotes.push(`Repeated failure cluster detected${failureTool ? ` around ${failureTool}` : ''}; repeated retries were discouraged.`);
    adaptationReasons.push('repeated failure cluster on dominant failing path');
    reactiveAdjustments.push({
      id: 'demote_repeated_failure_tool',
      reason: 'Recent workflow traces show repeated clustered failures on the same path.',
      signals: [
        `scenario:failure_cluster_count=${primaryScenario.repeatedFailureClusterCount}`,
        failureTool ? `scenario:failure_tool=${failureTool}` : 'scenario:failure_tool=unknown',
        failureSubsystem ? `scenario:failure_subsystem=${failureSubsystem}` : 'scenario:failure_subsystem=unknown',
      ],
      effect: failureTool
        ? `demoted ${failureTool} and discouraged repeated retries`
        : 'discouraged repeated retries on the dominant failing path',
      mode: failureTool ? 'constraint' : 'advisory',
      trigger: 'repeated failure cluster on dominant failing path',
    });
  }

  if (!sparseAuditData && primaryScenario && primaryScenario.earlyFailureRate >= 0.5) {
    if (mentionsExplicitBrowserRequirement(input)) {
      toolPolicy.deterministicBrowserFirst = true;
      branchingGuidance = 'deterministic_first';
    } else {
      branchingGuidance = branchingGuidance === 'deterministic_first' ? branchingGuidance : 'narrow_path';
    }
    auditSignalsUsed.push(`scenario:early_failure_rate=${primaryScenario.earlyFailureRate.toFixed(2)}`);
    reactiveNotes.push('Early failure pattern detected; safer entry posture selected.');
    adaptationReasons.push('most failures occur early in comparable workflows');
    reactiveAdjustments.push({
      id: 'early_failure_safer_entry',
      reason: `Comparable workflows fail early (${primaryScenario.earlyFailureRate.toFixed(2)}).`,
      signals: [`scenario:early_failure_rate=${primaryScenario.earlyFailureRate.toFixed(2)}`],
      effect: mentionsExplicitBrowserRequirement(input)
        ? 'enforced deterministic-first browser posture'
        : 'narrowed the initial execution path',
      mode: mentionsExplicitBrowserRequirement(input) ? 'constraint' : 'advisory',
      trigger: 'most failures occur early in comparable workflows',
    });
  }

  if (!sparseAuditData && primaryScenario && primaryScenario.lateFailureRate >= 0.5) {
    safetyPolicy.elevatedVerification = true;
    responsePolicy.requireVerificationSummary = true;
    auditSignalsUsed.push(`scenario:late_failure_rate=${primaryScenario.lateFailureRate.toFixed(2)}`);
    reactiveNotes.push('Late failure pattern detected; stronger intermediate and finish verification was enabled.');
    adaptationReasons.push('most failures occur late in comparable workflows');
    reactiveAdjustments.push({
      id: 'late_failure_more_verification',
      reason: `Comparable workflows fail late (${primaryScenario.lateFailureRate.toFixed(2)}).`,
      signals: [`scenario:late_failure_rate=${primaryScenario.lateFailureRate.toFixed(2)}`],
      effect: 'enabled stronger verification posture and reporting',
      mode: 'constraint',
      trigger: 'most failures occur late in comparable workflows',
    });
  }

  if (!sparseAuditData && shell?.status === 'degraded' && input.systemAuditSummary.repeatedRecentFailures.some((entry) => entry.toolName === 'shell_exec' && entry.streak >= 2)) {
    toolPolicy.discourageFamilies = ensureUnique([...(toolPolicy.discourageFamilies || []), 'shell']);
    toolPolicy.demotedTools = ensureUnique([...(toolPolicy.demotedTools || []), 'shell_exec']);
    retryGuidance = 'verify_before_retry';
    auditSignalsUsed.push('capability:shell_cli=degraded');
    auditSignalsUsed.push('tool:shell_exec=repeated_recent_failures');
    reactiveNotes.push('Shell-heavy retry loops are underperforming; shell was demoted and verify-before-retry guidance was applied.');
    adaptationReasons.push('degraded shell capability with repeated recent shell failures');
    reactiveAdjustments.push({
      id: 'demote_shell_retry_loops',
      reason: 'Shell capability is degraded and shell_exec has repeated recent failures.',
      signals: ['capability:shell_cli=degraded', 'tool:shell_exec_repeated_recent_failures'],
      effect: 'demoted shell family and set verify-before-retry guidance',
      mode: 'constraint',
      trigger: 'degraded shell capability with repeated recent shell failures',
    });
  }

  if (sparseAuditData) {
    auditSignalsUsed.push('audit:sparse_data');
    reactiveNotes.push('Audit data is sparse; reactive adaptation stayed minimal.');
    adaptationReasons.push('sparse audit data guard');
    reactiveAdjustments.push({
      id: 'sparse_data_guard',
      reason: 'Recent system-audit data is too sparse to justify stronger reactive changes.',
      signals: ['audit:sparse_data'],
      effect: 'kept adaptation minimal and avoided stronger suppression rules',
      mode: 'advisory',
      trigger: 'sparse audit data guard',
    });
  }

  if (subAgentHealth(input.systemAuditSummary)?.status === 'degraded' || hasWeakWorkflowSignals(input.systemAuditSummary)) {
    promptPolicy.directiveLines = [
      ...(promptPolicy.directiveLines || []),
      'Avoid unnecessary branching, retries, or sub-agent-heavy plans when a narrower path will work.',
    ];
  }

  const { actualExecutionMode, downgradeReason } = resolveActualExecutionMode(selected.executionMode, input.systemAuditSummary);
  const { selectedModel, note } = resolveSelectedModel(input, providerStrategy);
  const baseGoal = inferredBaseGoal;
  const baseSubGoalPlan = buildBaseSubGoalPlan(baseGoal);
  const subGoalConfidence = inferSubGoalConfidence(baseGoal);
  let baseStrategy = resolveBaseStrategy(selected.id, toolPolicy, safetyPolicy, responsePolicy);
  const learningState = {
    baseGoal,
    currentGoal: baseGoal,
    baseSubGoalPlan,
    currentSubGoal: baseSubGoalPlan[0],
    baseStrategy,
    currentStrategy: baseStrategy,
    promptPolicy,
    toolPolicy,
    retryGuidance,
    branchingGuidance,
    reactiveNotes,
    adaptationReasons,
    auditSignalsUsed,
    goalAwareNotes: [] as string[],
    stageAwareNotes: [] as string[],
  };
  const { appliedHints, evidenceSummary, learningInfluencedStart } = applyLearningHints(learningState, selectedLearningSummary);
  baseStrategy = learningState.baseStrategy;
  retryGuidance = learningState.retryGuidance;
  branchingGuidance = learningState.branchingGuidance;

  return {
    id: selected.id,
    baseHarnessId: selected.id,
    baseGoal,
    currentGoal: learningState.currentGoal,
    baseSubGoalPlan,
    currentSubGoal: learningState.currentSubGoal,
    completedSubGoals: [],
    subGoalAdjustments: [],
    subGoalConfidence,
    subGoalProgressSignals: [],
    stageAwareNotes: ensureUnique(learningState.stageAwareNotes),
    goalConfidence,
    goalDriftSignals: [],
    goalAdjustments: [],
    goalAwareNotes: ensureUnique(learningState.goalAwareNotes),
    baseStrategy,
    currentStrategy: learningState.currentStrategy,
    description: selected.description,
    priority: selected.priority,
    requestedExecutionMode: selected.executionMode,
    actualExecutionMode,
    downgradeReason,
    promptPolicy,
    providerStrategy,
    toolPolicy,
    safetyPolicy,
    responsePolicy,
    retryGuidance,
    branchingGuidance,
    reactiveNotes: ensureUnique(reactiveNotes),
    adaptationReasons: ensureUnique(adaptationReasons),
    reactiveAdjustments,
    inLoopAdjustments: [],
    strategyShiftHistory: [],
    strategyShiftReasons: [],
    hadInLoopAdaptation: false,
    auditSignalsUsed: ensureUnique(auditSignalsUsed),
    learningPatternKey: buildLearningPatternKey(selected.id, baseGoal),
    learningConfidence: selectedLearningSummary?.confidence,
    learningEvidenceSummary: evidenceSummary,
    appliedLearningHints: appliedHints,
    learningInfluencedStart,
    selectedModel,
    providerStrategyNote: note,
    matchedHarnessIds: matched.map((definition) => definition.id),
  };
}

export function createRuntimeHarnessReactiveState(): RuntimeHarnessReactiveState {
  return {
    successfulToolCount: 0,
    failedToolCount: 0,
    toolFailureCounts: {},
    familyFailureCounts: {},
    transitionFailureCounts: {},
    recoveryCount: 0,
    verificationFailureCount: 0,
    humanInterventionCount: 0,
    firedAdjustmentIds: [],
    appliedStrategyShiftKeys: [],
    appliedGoalAdjustmentKeys: [],
    appliedSubGoalAdjustmentKeys: [],
    toolSuccessCounts: {},
    familySuccessCounts: {},
    signalHistory: [],
  };
}

export function applyHarnessPromptModules(
  modules: Set<PromptModule>,
  policy?: HarnessPromptPolicy,
): Set<PromptModule> {
  const next = new Set(modules);
  for (const moduleName of policy?.addModules || []) next.add(moduleName);
  for (const moduleName of policy?.removeModules || []) next.delete(moduleName);
  return next;
}

export function inferToolFamily(toolName: string): ToolFamily {
  if (toolName.startsWith('browser_')) return 'browser';
  if (toolName === 'app_control' || toolName === 'gui_interact' || toolName === 'dbus_control') return 'desktop';
  if (toolName.startsWith('file_') || toolName.startsWith('directory_') || toolName.startsWith('fs_')) return 'filesystem';
  if (toolName.startsWith('memory_') || toolName === 'recall_context') return 'memory';
  return 'shell';
}

function pushInLoopAdjustment(
  harness: ResolvedHarness,
  state: RuntimeHarnessReactiveState,
  adjustment: HarnessReactiveAdjustment,
): void {
  harness.hadInLoopAdaptation = true;
  harness.inLoopAdjustments = [...harness.inLoopAdjustments, adjustment];
  harness.reactiveAdjustments = [...harness.reactiveAdjustments, adjustment];
  harness.reactiveNotes = ensureUnique([...harness.reactiveNotes, adjustment.reason]);
  harness.adaptationReasons = ensureUnique([...harness.adaptationReasons, adjustment.trigger]);
  harness.auditSignalsUsed = ensureUnique([...harness.auditSignalsUsed, ...adjustment.signals]);
  markFired(state, adjustment.id);
}

function hasAppliedStrategyShift(state: RuntimeHarnessReactiveState, key: string): boolean {
  return state.appliedStrategyShiftKeys.includes(key);
}

function markStrategyShiftApplied(state: RuntimeHarnessReactiveState, key: string): void {
  if (!state.appliedStrategyShiftKeys.includes(key)) state.appliedStrategyShiftKeys.push(key);
}

function hasAppliedGoalAdjustment(state: RuntimeHarnessReactiveState, key: string): boolean {
  return state.appliedGoalAdjustmentKeys.includes(key);
}

function markGoalAdjustmentApplied(state: RuntimeHarnessReactiveState, key: string): void {
  if (!state.appliedGoalAdjustmentKeys.includes(key)) state.appliedGoalAdjustmentKeys.push(key);
}

function hasAppliedSubGoalAdjustment(state: RuntimeHarnessReactiveState, key: string): boolean {
  return state.appliedSubGoalAdjustmentKeys.includes(key);
}

function markSubGoalAdjustmentApplied(state: RuntimeHarnessReactiveState, key: string): void {
  if (!state.appliedSubGoalAdjustmentKeys.includes(key)) state.appliedSubGoalAdjustmentKeys.push(key);
}

function applyStrategyEffects(
  harness: ResolvedHarness,
  shiftTo: HarnessStrategyId,
  input: HarnessResolutionInput,
): void {
  switch (shiftTo) {
    case 'browser_over_gui':
      harness.toolPolicy.discourageFamilies = ensureUnique([...(harness.toolPolicy.discourageFamilies || []), 'desktop']);
      harness.toolPolicy.suppressFamilies = ensureUnique([...(harness.toolPolicy.suppressFamilies || []), 'desktop']);
      harness.toolPolicy.preferFamilies = ensureUnique(['browser', ...(harness.toolPolicy.preferFamilies || [])]);
      if (input.profile.promptModules.has('browser')) harness.toolPolicy.deterministicBrowserFirst = true;
      break;
    case 'deterministic_browser_first':
      harness.toolPolicy.preferFamilies = ensureUnique(['browser', ...(harness.toolPolicy.preferFamilies || [])]);
      harness.toolPolicy.deterministicBrowserFirst = true;
      harness.branchingGuidance = 'deterministic_first';
      break;
    case 'low_shell_dependence':
      harness.toolPolicy.discourageFamilies = ensureUnique([...(harness.toolPolicy.discourageFamilies || []), 'shell']);
      harness.toolPolicy.demotedTools = ensureUnique([...(harness.toolPolicy.demotedTools || []), 'shell_exec']);
      harness.toolPolicy.preferFamilies = ensureUnique([...(harness.toolPolicy.preferFamilies || []), 'filesystem']);
      harness.retryGuidance = 'verify_before_retry';
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      break;
    case 'narrow_path_verified':
      harness.retryGuidance = 'verify_before_retry';
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      harness.safetyPolicy.elevatedVerification = true;
      harness.responsePolicy.requireVerificationSummary = true;
      break;
    case 'verify_before_write':
      harness.retryGuidance = 'verify_before_retry';
      harness.safetyPolicy.elevatedVerification = true;
      harness.responsePolicy.requireVerificationSummary = true;
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      break;
    case 'recovery_constrained':
      harness.retryGuidance = 'verify_before_retry';
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      break;
    case 'intervention_waiting':
      harness.retryGuidance = 'avoid_repeated_retries';
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      harness.safetyPolicy.preferHumanInterventionOverRetry = true;
      break;
    case 'direct_balanced':
      break;
  }
}

export function applyHarnessStrategyShift(
  harness: ResolvedHarness,
  state: RuntimeHarnessReactiveState,
  shift: HarnessStrategyShift,
  input: HarnessResolutionInput,
): boolean {
  const sameKey = `${shift.from}->${shift.to}`;
  const reverseKey = `${shift.to}->${shift.from}`;
  const lastShift = harness.strategyShiftHistory[harness.strategyShiftHistory.length - 1];
  if (harness.currentStrategy === shift.to) return false;
  if (hasAppliedStrategyShift(state, sameKey)) return false;
  if (lastShift && lastShift.from === shift.to && lastShift.to === shift.from) return false;
  if (hasAppliedStrategyShift(state, reverseKey)) return false;

  applyStrategyEffects(harness, shift.to, input);
  harness.hadInLoopAdaptation = true;
  harness.currentStrategy = shift.to;
  harness.strategyShiftHistory = [...harness.strategyShiftHistory, shift];
  harness.strategyShiftReasons = ensureUnique([...harness.strategyShiftReasons, shift.trigger]);
  harness.reactiveNotes = ensureUnique([...harness.reactiveNotes, shift.reason]);
  harness.adaptationReasons = ensureUnique([...harness.adaptationReasons, shift.trigger]);
  harness.auditSignalsUsed = ensureUnique([...harness.auditSignalsUsed, ...shift.signals]);
  markStrategyShiftApplied(state, sameKey);
  return true;
}

function applyGoalEffects(
  harness: ResolvedHarness,
  adjustment: HarnessGoalAdjustment,
): void {
  switch (adjustment.to) {
    case 'compare_and_report':
    case 'gather_evidence':
      harness.toolPolicy.preferFamilies = ensureUnique(['browser', 'memory', ...(harness.toolPolicy.preferFamilies || [])]);
      harness.toolPolicy.discourageFamilies = ensureUnique([...(harness.toolPolicy.discourageFamilies || []), 'desktop']);
      harness.responsePolicy.evidenceOrientedFinish = true;
      break;
    case 'produce_artifact':
      harness.responsePolicy.requireVerificationSummary = true;
      harness.retryGuidance = 'verify_before_retry';
      break;
    case 'verify_state_change':
      harness.safetyPolicy.elevatedVerification = true;
      harness.responsePolicy.requireVerificationSummary = true;
      harness.retryGuidance = 'verify_before_retry';
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      break;
    case 'safely_apply_change':
      harness.safetyPolicy.elevatedVerification = true;
      harness.safetyPolicy.elevatedApproval = harness.safetyPolicy.elevatedApproval || false;
      harness.responsePolicy.requireVerificationSummary = true;
      harness.retryGuidance = 'verify_before_retry';
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      break;
    case 'intervention_gated_completion':
      harness.safetyPolicy.preferHumanInterventionOverRetry = true;
      harness.retryGuidance = 'avoid_repeated_retries';
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      break;
    case 'complete_action':
      harness.toolPolicy.deterministicBrowserFirst = harness.toolPolicy.deterministicBrowserFirst || false;
      break;
    case 'modify_workspace':
      harness.toolPolicy.preferFamilies = ensureUnique([...(harness.toolPolicy.preferFamilies || []), 'filesystem']);
      break;
  }
}

export function applyGoalAwareAdjustment(
  harness: ResolvedHarness,
  state: RuntimeHarnessReactiveState,
  adjustment: HarnessGoalAdjustment,
): boolean {
  const key = `${adjustment.from}->${adjustment.to}:${adjustment.trigger}`;
  if (hasAppliedGoalAdjustment(state, key)) return false;
  if (adjustment.to !== adjustment.from && !canNarrowGoal(harness.baseGoal, adjustment.to)) return false;
  if (adjustment.to !== harness.currentGoal && !canNarrowGoal(harness.currentGoal, adjustment.to)) return false;

  applyGoalEffects(harness, adjustment);
  harness.hadInLoopAdaptation = true;
  harness.currentGoal = adjustment.to;
  harness.goalAdjustments = [...harness.goalAdjustments, adjustment];
  harness.goalAwareNotes = ensureUnique([...harness.goalAwareNotes, adjustment.reason]);
  harness.goalDriftSignals = ensureUnique([...harness.goalDriftSignals, ...adjustment.signals]);
  harness.reactiveNotes = ensureUnique([...harness.reactiveNotes, adjustment.reason]);
  harness.adaptationReasons = ensureUnique([...harness.adaptationReasons, adjustment.trigger]);
  harness.auditSignalsUsed = ensureUnique([...harness.auditSignalsUsed, ...adjustment.signals]);
  markGoalAdjustmentApplied(state, key);
  return true;
}

function isStageInPlan(harness: ResolvedHarness, stage: HarnessSubGoalId): boolean {
  return harness.baseSubGoalPlan.includes(stage);
}

function getStageIndex(harness: ResolvedHarness, stage: HarnessSubGoalId): number {
  return harness.baseSubGoalPlan.indexOf(stage);
}

function advanceCompletedStages(harness: ResolvedHarness, to: HarnessSubGoalId): void {
  const targetIndex = getStageIndex(harness, to);
  if (targetIndex <= 0) return;
  const completed = harness.baseSubGoalPlan.slice(0, targetIndex);
  harness.completedSubGoals = ensureUnique([...harness.completedSubGoals, ...completed]);
}

function applySubGoalEffects(harness: ResolvedHarness, adjustment: HarnessSubGoalAdjustment): void {
  if (adjustment.to === 'verify_outcome' || adjustment.to === 'verify_change' || adjustment.to === 'verify_artifact') {
    harness.safetyPolicy.elevatedVerification = true;
    harness.responsePolicy.requireVerificationSummary = true;
    harness.retryGuidance = 'verify_before_retry';
    if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
  }
  if (adjustment.to === 'gather' || adjustment.to === 'extract' || adjustment.to === 'compare') {
    harness.toolPolicy.preferFamilies = ensureUnique(['browser', 'memory', ...(harness.toolPolicy.preferFamilies || [])]);
    harness.toolPolicy.discourageFamilies = ensureUnique([...(harness.toolPolicy.discourageFamilies || []), 'desktop']);
    harness.responsePolicy.evidenceOrientedFinish = true;
  }
  if (adjustment.to === 'inspect_state' || adjustment.to === 'prepare_change') {
    harness.retryGuidance = 'verify_before_retry';
    if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
  }
  if (adjustment.to === 'wait_for_intervention') {
    harness.retryGuidance = 'avoid_repeated_retries';
    harness.safetyPolicy.preferHumanInterventionOverRetry = true;
  }
}

export function applySubGoalAdjustment(
  harness: ResolvedHarness,
  state: RuntimeHarnessReactiveState,
  adjustment: HarnessSubGoalAdjustment,
): boolean {
  const key = `${adjustment.from}->${adjustment.to}:${adjustment.trigger}`;
  const interventionStageOverride =
    adjustment.to === 'wait_for_intervention'
    && harness.currentGoal === 'intervention_gated_completion';
  if (!interventionStageOverride && !isStageInPlan(harness, adjustment.to)) return false;
  if (!interventionStageOverride && !isStageInPlan(harness, adjustment.from)) return false;
  if (hasAppliedSubGoalAdjustment(state, key)) return false;
  const fromIndex = interventionStageOverride ? -1 : getStageIndex(harness, adjustment.from);
  const toIndex = interventionStageOverride ? -1 : getStageIndex(harness, adjustment.to);
  const currentIndex = interventionStageOverride ? -1 : getStageIndex(harness, harness.currentSubGoal);
  if (adjustment.from !== harness.currentSubGoal) return false;
  if (!interventionStageOverride && Math.abs(toIndex - fromIndex) > 1) return false;
  if (!interventionStageOverride && Math.abs(toIndex - currentIndex) > 1) return false;
  const last = harness.subGoalAdjustments[harness.subGoalAdjustments.length - 1];
  if (
    last
    && last.from === adjustment.to
    && last.to === adjustment.from
    && last.trigger === adjustment.trigger
  ) return false;

  applySubGoalEffects(harness, adjustment);
  harness.hadInLoopAdaptation = true;
  advanceCompletedStages(harness, adjustment.to);
  harness.currentSubGoal = adjustment.to;
  harness.subGoalAdjustments = [...harness.subGoalAdjustments, adjustment];
  harness.stageAwareNotes = ensureUnique([...harness.stageAwareNotes, adjustment.reason]);
  harness.subGoalProgressSignals = ensureUnique([...harness.subGoalProgressSignals, ...adjustment.signals]);
  harness.reactiveNotes = ensureUnique([...harness.reactiveNotes, adjustment.reason]);
  harness.adaptationReasons = ensureUnique([...harness.adaptationReasons, adjustment.trigger]);
  harness.auditSignalsUsed = ensureUnique([...harness.auditSignalsUsed, ...adjustment.signals]);
  markSubGoalAdjustmentApplied(state, key);
  return true;
}

function updateRuntimeStateFromSignal(
  state: RuntimeHarnessReactiveState,
  signal: RuntimeHarnessSignal,
): void {
  state.signalHistory.push(signal);
  if (signal.kind === 'tool_result') {
    if (signal.success) {
      state.successfulToolCount += 1;
      if (signal.toolName) {
        state.toolSuccessCounts[signal.toolName] = (state.toolSuccessCounts[signal.toolName] || 0) + 1;
      }
      if (signal.toolFamily) {
        state.familySuccessCounts[signal.toolFamily] = (state.familySuccessCounts[signal.toolFamily] || 0) + 1;
      }
    } else {
      state.failedToolCount += 1;
      if (signal.toolName) {
        state.toolFailureCounts[signal.toolName] = (state.toolFailureCounts[signal.toolName] || 0) + 1;
      }
      if (signal.toolFamily) {
        state.familyFailureCounts[signal.toolFamily] = (state.familyFailureCounts[signal.toolFamily] || 0) + 1;
      }
      if (state.lastToolFamily && signal.toolFamily && state.lastToolFamily !== signal.toolFamily) {
        const transition = `${state.lastToolFamily} -> ${signal.toolFamily}`;
        state.transitionFailureCounts[transition] = (state.transitionFailureCounts[transition] || 0) + 1;
      }
    }
    if (signal.toolFamily) state.lastToolFamily = signal.toolFamily;
    return;
  }

  if (signal.kind === 'verification_failed') {
    state.verificationFailureCount += 1;
    return;
  }

  if (signal.kind === 'recovery_invoked') {
    state.recoveryCount += 1;
    return;
  }

  if (signal.kind === 'human_intervention_required') {
    state.humanInterventionCount += 1;
  }
}

function maybeApplyInLoopAdjustment(
  harness: ResolvedHarness,
  state: RuntimeHarnessReactiveState,
  signal: RuntimeHarnessSignal,
  input: HarnessResolutionInput,
): HarnessReactiveAdjustment[] {
  const adjustments: HarnessReactiveAdjustment[] = [];

  if (signal.kind === 'tool_result' && signal.success === false && signal.toolName) {
    const count = state.toolFailureCounts[signal.toolName] || 0;
    const ruleId = `repeat_tool_failure:${signal.toolName}`;
    if (count >= 2 && !hasFired(state, ruleId)) {
      harness.toolPolicy.demotedTools = ensureUnique([...(harness.toolPolicy.demotedTools || []), signal.toolName]);
      harness.retryGuidance = 'avoid_repeated_retries';
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      const adjustment = {
        id: ruleId,
        reason: `Repeated ${signal.toolName} failures detected in this run.`,
        signals: [`run:tool_failure:${signal.toolName}=${count}`],
        effect: `demoted ${signal.toolName}, discouraged repeated retries, and narrowed branching`,
        mode: 'constraint' as const,
        trigger: 'repeated tool failure in current run',
        supersedesBase: true,
      };
      pushInLoopAdjustment(harness, state, adjustment);
      adjustments.push(adjustment);
    }
  }

  if (signal.kind === 'tool_result' && signal.success === false && signal.toolFamily) {
    const count = state.familyFailureCounts[signal.toolFamily] || 0;
    const ruleId = `repeat_family_failure:${signal.toolFamily}`;
    if (count >= 2 && !hasFired(state, ruleId)) {
      harness.toolPolicy.discourageFamilies = ensureUnique([...(harness.toolPolicy.discourageFamilies || []), signal.toolFamily]);
      if (
        signal.toolFamily === 'desktop'
        && input.profile.promptModules.has('browser')
        && !input.profile.promptModules.has('desktop_apps')
      ) {
        harness.toolPolicy.suppressFamilies = ensureUnique([...(harness.toolPolicy.suppressFamilies || []), 'desktop']);
        if (!harness.toolPolicy.preferFamilies?.includes('browser')) {
          harness.toolPolicy.preferFamilies = ['browser', ...(harness.toolPolicy.preferFamilies || [])];
        }
      }
      harness.retryGuidance = 'avoid_repeated_retries';
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      const adjustment = {
        id: ruleId,
        reason: `Repeated ${signal.toolFamily} failures detected in this run.`,
        signals: [`run:family_failure:${signal.toolFamily}=${count}`],
        effect: signal.toolFamily === 'desktop' && harness.toolPolicy.suppressFamilies?.includes('desktop')
          ? 'suppressed desktop family and promoted browser alternative'
          : `demoted ${signal.toolFamily} family and narrowed retry behavior`,
        mode: signal.toolFamily === 'desktop' ? 'constraint' as const : 'advisory' as const,
        trigger: 'repeated tool family failure in current run',
        supersedesBase: true,
      };
      pushInLoopAdjustment(harness, state, adjustment);
      adjustments.push(adjustment);
    }
  }

  if (signal.kind === 'tool_result' && signal.success === false && state.successfulToolCount === 0) {
    const ruleId = 'early_current_run_failure';
    if (!hasFired(state, ruleId)) {
      harness.retryGuidance = 'verify_before_retry';
      if (input.profile.promptModules.has('browser')) {
        harness.toolPolicy.deterministicBrowserFirst = true;
        harness.branchingGuidance = 'deterministic_first';
      } else if (harness.branchingGuidance !== 'deterministic_first') {
        harness.branchingGuidance = 'narrow_path';
      }
      const adjustment = {
        id: ruleId,
        reason: 'Failure occurred before meaningful progress in this run.',
        signals: ['run:early_failure=true'],
        effect: input.profile.promptModules.has('browser')
          ? 'switched to safer deterministic entry posture'
          : 'narrowed the active path and discouraged exploratory retries',
        mode: 'advisory' as const,
        trigger: 'early failure in current run',
        supersedesBase: true,
      };
      pushInLoopAdjustment(harness, state, adjustment);
      adjustments.push(adjustment);
    }
  }

  if (signal.kind === 'verification_failed' && state.successfulToolCount >= 2) {
    const ruleId = 'late_verification_failure';
    if (!hasFired(state, ruleId)) {
      harness.safetyPolicy.elevatedVerification = true;
      harness.responsePolicy.requireVerificationSummary = true;
      harness.retryGuidance = 'verify_before_retry';
      const adjustment = {
        id: ruleId,
        reason: 'Late-stage verification failed after partial progress.',
        signals: [`run:verification_failure:${signal.verificationType || 'unknown'}`],
        effect: 'elevated verification posture and required explicit verification before continuation',
        mode: 'constraint' as const,
        trigger: 'late verification failure in current run',
        supersedesBase: true,
      };
      pushInLoopAdjustment(harness, state, adjustment);
      adjustments.push(adjustment);
    }
  }

  if (signal.kind === 'recovery_invoked') {
    const ruleId = 'recovery_loop_pressure';
    if (state.recoveryCount >= 2 && !hasFired(state, ruleId)) {
      harness.retryGuidance = 'verify_before_retry';
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      const adjustment = {
        id: ruleId,
        reason: 'Recovery has been invoked repeatedly in this run.',
        signals: [`run:recovery_count=${state.recoveryCount}`],
        effect: 'narrowed branching and required verification before further retries',
        mode: 'constraint' as const,
        trigger: 'recovery loop pressure in current run',
        supersedesBase: true,
      };
      pushInLoopAdjustment(harness, state, adjustment);
      adjustments.push(adjustment);
    }
  }

  if (signal.kind === 'human_intervention_required') {
    const ruleId = 'human_intervention_pending';
    if (!hasFired(state, ruleId)) {
      harness.retryGuidance = 'avoid_repeated_retries';
      if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
      const adjustment = {
        id: ruleId,
        reason: 'Human intervention is required in the current run.',
        signals: ['run:human_intervention_required=true'],
        effect: 'shifted to pause-aware narrow execution and blocked speculative retries',
        mode: 'constraint' as const,
        trigger: 'human intervention required in current run',
        supersedesBase: true,
      };
      pushInLoopAdjustment(harness, state, adjustment);
      adjustments.push(adjustment);
    }
  }

  if (signal.kind === 'tool_result' && signal.success === false && signal.toolFamily) {
    const transition = state.lastToolFamily && state.lastToolFamily !== signal.toolFamily
      ? `${state.lastToolFamily} -> ${signal.toolFamily}`
      : undefined;
    if (transition) {
      const count = state.transitionFailureCounts[transition] || 0;
      const ruleId = `fragile_transition_runtime:${transition}`;
      if (count >= 2 && !hasFired(state, ruleId)) {
        harness.retryGuidance = 'verify_before_retry';
        if (harness.branchingGuidance !== 'deterministic_first') harness.branchingGuidance = 'narrow_path';
        const adjustment = {
          id: ruleId,
          reason: `Current run encountered repeated fragile transition ${transition}.`,
          signals: [`run:transition_failure:${transition}=${count}`],
          effect: 'added boundary caution and required explicit verification on the transition',
          mode: 'advisory' as const,
          trigger: 'fragile transition observed in current run',
          supersedesBase: true,
        };
        pushInLoopAdjustment(harness, state, adjustment);
        adjustments.push(adjustment);
      }
    }
  }

  return adjustments;
}

function maybeApplyStrategyShift(
  harness: ResolvedHarness,
  state: RuntimeHarnessReactiveState,
  signal: RuntimeHarnessSignal,
  input: HarnessResolutionInput,
): HarnessStrategyShift[] {
  const shifts: HarnessStrategyShift[] = [];
  const pushShift = (shift: HarnessStrategyShift): void => {
    if (applyHarnessStrategyShift(harness, state, shift, input)) {
      shifts.push(shift);
    }
  };

  if (signal.kind === 'tool_result' && signal.success === false && signal.toolFamily === 'desktop') {
    const count = state.familyFailureCounts.desktop || 0;
    if (count >= 2 && input.profile.promptModules.has('browser') && !input.profile.promptModules.has('desktop_apps')) {
      pushShift({
        id: 'shift_browser_over_gui',
        from: harness.currentStrategy,
        to: 'browser_over_gui',
        trigger: 'gui path collapse',
        reason: 'GUI path is underperforming in the current run; browser-first execution was enforced.',
        effect: 'suppressed desktop-heavy posture and shifted to browser-first execution',
        mode: 'constraint',
        signals: [`run:family_failure:desktop=${count}`],
        supersedesBase: true,
      });
    }
  }

  if (signal.kind === 'tool_result' && signal.success === false && signal.toolFamily === 'browser') {
    const count = state.familyFailureCounts.browser || 0;
    if (count >= 2 && input.profile.promptModules.has('browser')) {
      pushShift({
        id: 'shift_deterministic_browser_first',
        from: harness.currentStrategy,
        to: 'deterministic_browser_first',
        trigger: 'open-ended browser underperformance',
        reason: 'Open-ended browser exploration is underperforming; deterministic browser paths were preferred.',
        effect: 'enforced deterministic browser-first posture',
        mode: 'constraint',
        signals: [`run:family_failure:browser=${count}`],
        supersedesBase: true,
      });
    }
  }

  if (signal.kind === 'tool_result' && signal.success === false && (signal.toolFamily === 'shell' || signal.toolName === 'shell_exec')) {
    const familyCount = state.familyFailureCounts.shell || 0;
    const toolCount = signal.toolName ? state.toolFailureCounts[signal.toolName] || 0 : 0;
    if (familyCount >= 2 || toolCount >= 2) {
      pushShift({
        id: 'shift_low_shell_dependence',
        from: harness.currentStrategy,
        to: 'low_shell_dependence',
        trigger: 'shell-heavy path underperformance',
        reason: 'Shell-heavy execution is underperforming; lower-shell alternatives were preferred.',
        effect: 'demoted shell and preferred filesystem-first verified alternatives',
        mode: 'constraint',
        signals: [
          `run:family_failure:shell=${familyCount}`,
          signal.toolName ? `run:tool_failure:${signal.toolName}=${toolCount}` : 'run:tool_failure:shell=unknown',
        ],
        supersedesBase: true,
      });
    }
  }

  if (signal.kind === 'verification_failed' && state.successfulToolCount >= 2) {
    const filesystemOrDocument = input.profile.promptModules.has('document')
      || input.profile.promptModules.has('filesystem')
      || input.profile.promptModules.has('coding');
    pushShift({
      id: filesystemOrDocument ? 'shift_verify_before_write' : 'shift_narrow_path_verified',
      from: harness.currentStrategy,
      to: filesystemOrDocument ? 'verify_before_write' : 'narrow_path_verified',
      trigger: 'late-stage workflow fragility',
      reason: filesystemOrDocument
        ? 'Late verification failed after writes; verify-before-write posture was enabled.'
        : 'Late verification failed; the run shifted to a narrower verification-heavy posture.',
      effect: filesystemOrDocument
        ? 'enabled verify-before-write posture for remaining work'
        : 'shifted to narrow-path verified execution',
      mode: 'constraint',
      signals: [`run:verification_failure:${signal.verificationType || 'unknown'}`],
      supersedesBase: true,
    });
  }

  if (signal.kind === 'recovery_invoked' && state.recoveryCount >= 2) {
    pushShift({
      id: 'shift_recovery_constrained',
      from: harness.currentStrategy,
      to: 'recovery_constrained',
      trigger: 'recovery-loop saturation',
      reason: 'Repeated recovery indicates the current path is unstable; recovery-constrained posture was enabled.',
      effect: 'narrowed the path and required verification before further retries',
      mode: 'constraint',
      signals: [`run:recovery_count=${state.recoveryCount}`],
      supersedesBase: true,
    });
  }

  if (signal.kind === 'human_intervention_required') {
    pushShift({
      id: 'shift_intervention_waiting',
      from: harness.currentStrategy,
      to: 'intervention_waiting',
      trigger: 'human intervention required',
      reason: 'Human intervention is pending; speculative continuation was disabled.',
      effect: 'shifted to intervention-waiting posture',
      mode: 'constraint',
      signals: ['run:human_intervention_required=true'],
      supersedesBase: true,
    });
  }

  if (signal.kind === 'tool_result' && signal.success === false && signal.transition?.includes('browser -> filesystem')) {
    const count = state.transitionFailureCounts[signal.transition] || 0;
    if (count >= 2) {
      pushShift({
        id: 'shift_verify_before_write_boundary',
        from: harness.currentStrategy,
        to: 'verify_before_write',
        trigger: 'fragile boundary crossing',
        reason: 'Browser-to-filesystem transition is failing repeatedly; verify-before-write posture was enabled.',
        effect: 'required explicit verification before continuing browser-to-filesystem writes',
        mode: 'constraint',
        signals: [`run:transition_failure:${signal.transition}=${count}`],
        supersedesBase: true,
      });
    }
  }

  return shifts;
}

function maybeApplyGoalAwareAdjustments(
  harness: ResolvedHarness,
  state: RuntimeHarnessReactiveState,
  signal: RuntimeHarnessSignal,
  input: HarnessResolutionInput,
): HarnessGoalAdjustment[] {
  const adjustments: HarnessGoalAdjustment[] = [];
  const pushGoal = (adjustment: HarnessGoalAdjustment): void => {
    if (applyGoalAwareAdjustment(harness, state, adjustment)) {
      adjustments.push(adjustment);
    }
  };
  const evidenceGoal = harness.baseGoal === 'gather_evidence' || harness.baseGoal === 'compare_and_report';
  const actionGoal = harness.baseGoal === 'complete_action';
  const changeGoal = harness.baseGoal === 'modify_workspace' || harness.baseGoal === 'safely_apply_change';

  if (signal.kind === 'tool_result' && signal.success === false) {
    if (actionGoal && signal.toolName && /browser_(search|navigate)/.test(signal.toolName) && (state.toolFailureCounts[signal.toolName] || 0) >= 2) {
      pushGoal({
        id: 'goal_complete_action_drift',
        from: harness.currentGoal,
        to: 'complete_action',
        trigger: 'action goal being treated like an exploratory goal',
        reason: 'Exploratory browser behavior is not serving the completion goal; completion-first posture was reinforced.',
        effect: 'reinforced completion-first goal posture and narrowed exploration',
        signals: [`run:tool_failure:${signal.toolName}=${state.toolFailureCounts[signal.toolName] || 0}`],
        narrowed: false,
        mode: 'advisory',
      });
    }

    if (changeGoal && signal.toolFamily === 'shell' && (state.familyFailureCounts.shell || 0) >= 2) {
      pushGoal({
        id: 'goal_safe_change_under_fragility',
        from: harness.currentGoal,
        to: 'safely_apply_change',
        trigger: 'safe-change goal under elevated fragility',
        reason: 'Change application is fragile; the run tightened toward safe-change validation.',
        effect: 'tightened the goal toward safe, verified change application',
        signals: [`run:family_failure:shell=${state.familyFailureCounts.shell || 0}`],
        narrowed: true,
        mode: 'constraint',
      });
    }
  }

  if (signal.kind === 'tool_result' && signal.success === true && evidenceGoal && (signal.toolFamily === 'desktop' || signal.toolFamily === 'shell')) {
    pushGoal({
      id: 'goal_evidence_not_action',
      from: harness.currentGoal,
      to: harness.currentGoal === 'compare_and_report' ? 'compare_and_report' : 'gather_evidence',
      trigger: 'evidence goal being treated like an action goal',
      reason: 'The run drifted toward action-oriented tools before enough evidence was gathered.',
      effect: 'biased the run back toward evidence collection and report posture',
      signals: [`run:successful_family:${signal.toolFamily}=1`],
      narrowed: false,
      mode: 'advisory',
    });
  }

  if (signal.kind === 'verification_failed' && state.successfulToolCount >= 2) {
    const nextGoal: HarnessGoalId = changeGoal
      ? 'safely_apply_change'
      : harness.baseGoal === 'produce_artifact' || harness.baseGoal === 'compare_and_report'
        ? 'verify_state_change'
        : 'verify_state_change';
    pushGoal({
      id: 'goal_mechanical_without_goal_progress',
      from: harness.currentGoal,
      to: nextGoal,
      trigger: 'mechanical progress without goal progress',
      reason: 'Work progressed mechanically, but the intended outcome is still not verified.',
      effect: 'tightened the run toward explicit goal-state verification',
      signals: [`run:verification_failure:${signal.verificationType || 'unknown'}`],
      narrowed: true,
      mode: 'constraint',
    });
  }

  if (signal.kind === 'human_intervention_required') {
    pushGoal({
      id: 'goal_intervention_gated',
      from: harness.currentGoal,
      to: 'intervention_gated_completion',
      trigger: 'intervention-gated goal',
      reason: 'Human intervention is required before the requested goal can be completed meaningfully.',
      effect: 'specialized the run to intervention-gated completion',
      signals: ['run:human_intervention_required=true'],
      narrowed: true,
      mode: 'constraint',
    });
  }

  if (signal.kind === 'tool_result' && signal.success === false && signal.toolName && (state.toolFailureCounts[signal.toolName] || 0) >= 2) {
    const repeatSignal = `run:tool_failure:${signal.toolName}=${state.toolFailureCounts[signal.toolName] || 0}`;
    pushGoal({
      id: 'goal_protection_under_failure',
      from: harness.currentGoal,
      to: changeGoal ? 'safely_apply_change' : harness.currentGoal,
      trigger: 'goal-protection under repeated failure',
      reason: 'Repeated failures are optimizing for local motion instead of safe goal completion.',
      effect: 'suppressed irrelevant retries and tightened goal-serving posture',
      signals: [repeatSignal],
      narrowed: changeGoal,
      mode: 'advisory',
    });
  }

  return adjustments;
}

function maybeApplySubGoalAdjustments(
  harness: ResolvedHarness,
  state: RuntimeHarnessReactiveState,
  signal: RuntimeHarnessSignal,
): HarnessSubGoalAdjustment[] {
  const adjustments: HarnessSubGoalAdjustment[] = [];
  const push = (adjustment: HarnessSubGoalAdjustment): void => {
    if (applySubGoalAdjustment(harness, state, adjustment)) adjustments.push(adjustment);
  };
  const current = harness.currentSubGoal;

  if (signal.kind === 'tool_result' && signal.success === true) {
    if (current === 'navigate' && signal.toolFamily === 'browser' && /browser_(navigate|read_page|extract|tab_new|tab_switch)/.test(signal.toolName || '')) {
      push({
        id: 'subgoal_navigate_to_locate',
        from: 'navigate',
        to: 'locate_target',
        trigger: 'navigation success',
        reason: 'Navigation completed; move to locating the target.',
        effect: 'advanced the run from navigation to target location',
        signals: [`run:tool_success:${signal.toolName || 'browser'}=1`],
        mode: 'advisory',
      });
    } else if (current === 'locate_target' && signal.toolFamily === 'browser' && /browser_(detect_form|click|type|extract|read_page)/.test(signal.toolName || '')) {
      push({
        id: 'subgoal_locate_to_perform',
        from: 'locate_target',
        to: 'perform_action',
        trigger: 'target located',
        reason: 'Relevant target was located; move to performing the action.',
        effect: 'advanced from locating the target to action execution',
        signals: [`run:tool_success:${signal.toolName || 'browser'}=1`],
        mode: 'advisory',
      });
    } else if (current === 'perform_action' && signal.toolFamily === 'browser' && /browser_(click|type|fill_field|run_harness|run_playbook)/.test(signal.toolName || '')) {
      push({
        id: 'subgoal_perform_to_verify',
        from: 'perform_action',
        to: 'verify_outcome',
        trigger: 'action execution success',
        reason: 'The action appears to have been executed; explicit outcome verification is now required.',
        effect: 'advanced from action execution to outcome verification',
        signals: [`run:tool_success:${signal.toolName || 'browser'}=1`],
        mode: 'advisory',
      });
    } else if (current === 'gather' && (signal.toolFamily === 'browser' || signal.toolFamily === 'filesystem')) {
      push({
        id: 'subgoal_gather_to_extract',
        from: 'gather',
        to: 'extract',
        trigger: 'source access success',
        reason: 'Sources were accessed successfully; move to extracting relevant content.',
        effect: 'advanced from gathering sources to extraction',
        signals: [`run:successful_family:${signal.toolFamily}=1`],
        mode: 'advisory',
      });
    } else if (current === 'extract' && signal.toolFamily === 'browser' && /browser_(extract|read_page)/.test(signal.toolName || '')) {
      const next = harness.baseSubGoalPlan.includes('compare') ? 'compare' : 'synthesize';
      push({
        id: `subgoal_extract_to_${next}`,
        from: 'extract',
        to: next as HarnessSubGoalId,
        trigger: 'extraction success',
        reason: 'Relevant content was extracted; move to comparison or synthesis.',
        effect: `advanced from extraction to ${next}`,
        signals: [`run:tool_success:${signal.toolName || 'browser'}=1`],
        mode: 'advisory',
      });
    } else if (current === 'compare' && (signal.toolName === 'browser_extract' || signal.toolName === 'file_read' || signal.toolName === 'memory_search')) {
      push({
        id: 'subgoal_compare_to_synthesize',
        from: 'compare',
        to: 'synthesize',
        trigger: 'comparison material prepared',
        reason: 'Comparison material is available; move to synthesis.',
        effect: 'advanced from compare to synthesize',
        signals: [`run:tool_success:${signal.toolName || 'compare'}=1`],
        mode: 'advisory',
      });
    } else if (current === 'synthesize' && (signal.toolName === 'file_write' || signal.toolName === 'create_document')) {
      if (harness.baseSubGoalPlan.includes('produce_report')) {
        push({
          id: 'subgoal_synthesize_to_report',
          from: 'synthesize',
          to: 'produce_report',
          trigger: 'report generation started',
          reason: 'Synthesis is being materialized into a report.',
          effect: 'advanced from synthesis to report production',
          signals: [`run:tool_success:${signal.toolName}=1`],
          mode: 'advisory',
        });
      }
    } else if (current === 'inspect_state' && (signal.toolName === 'file_read' || signal.toolName === 'directory_tree' || signal.toolName?.startsWith('fs_'))) {
      push({
        id: 'subgoal_inspect_to_prepare',
        from: 'inspect_state',
        to: 'prepare_change',
        trigger: 'state inspection complete',
        reason: 'Relevant state was inspected; move to preparing the change.',
        effect: 'advanced from inspect_state to prepare_change',
        signals: [`run:tool_success:${signal.toolName || 'filesystem'}=1`],
        mode: 'advisory',
      });
    } else if (current === 'prepare_change' && (signal.toolName === 'file_edit' || signal.toolName === 'file_write')) {
      push({
        id: 'subgoal_prepare_to_apply',
        from: 'prepare_change',
        to: 'apply_change',
        trigger: 'write initiated after preparation',
        reason: 'The change is now being applied.',
        effect: 'advanced from prepare_change to apply_change',
        signals: [`run:tool_success:${signal.toolName}=1`],
        mode: 'advisory',
      });
    } else if (current === 'apply_change' && (signal.toolName === 'file_edit' || signal.toolName === 'file_write')) {
      if (harness.baseSubGoalPlan.includes('verify_change')) {
        push({
          id: 'subgoal_apply_to_verify',
          from: 'apply_change',
          to: 'verify_change',
          trigger: 'write completed',
          reason: 'The change appears written; verification is now required.',
          effect: 'advanced from apply_change to verify_change',
          signals: [`run:tool_success:${signal.toolName}=1`],
          mode: 'advisory',
        });
      }
    } else if (current === 'gather_inputs' && (signal.toolFamily === 'browser' || signal.toolFamily === 'filesystem' || signal.toolFamily === 'memory')) {
      push({
        id: 'subgoal_inputs_to_generate',
        from: 'gather_inputs',
        to: 'generate_artifact',
        trigger: 'inputs gathered',
        reason: 'Inputs are available; move to generating the artifact.',
        effect: 'advanced from input gathering to artifact generation',
        signals: [`run:successful_family:${signal.toolFamily}=1`],
        mode: 'advisory',
      });
    } else if (current === 'generate_artifact' && (signal.toolName === 'file_write' || signal.toolName === 'create_document')) {
      push({
        id: 'subgoal_generate_to_verify_artifact',
        from: 'generate_artifact',
        to: 'verify_artifact',
        trigger: 'artifact write success',
        reason: 'The artifact appears generated; verification is now required.',
        effect: 'advanced from artifact generation to artifact verification',
        signals: [`run:tool_success:${signal.toolName}=1`],
        mode: 'advisory',
      });
    } else if (current === 'reach_intervention_gate' && signal.toolFamily === 'browser') {
      push({
        id: 'subgoal_reach_gate_to_wait',
        from: 'reach_intervention_gate',
        to: 'wait_for_intervention',
        trigger: 'intervention boundary reached',
        reason: 'The run reached the intervention gate and is waiting for human completion.',
        effect: 'advanced to wait_for_intervention',
        signals: [`run:successful_family:${signal.toolFamily}=1`],
        mode: 'advisory',
      });
    }
  }

  if (signal.kind === 'tool_result' && signal.success === false) {
    if (current === 'perform_action' && signal.toolName && /browser_(search|navigate)/.test(signal.toolName)) {
      push({
        id: 'subgoal_action_stage_mismatch',
        from: 'perform_action',
        to: 'perform_action',
        trigger: 'stage/path mismatch',
        reason: 'The run drifted back into exploration while it should be performing the action.',
        effect: 'kept the stage on perform_action and suppressed irrelevant exploration',
        signals: [`run:tool_failure:${signal.toolName}=${state.toolFailureCounts[signal.toolName] || 0}`],
        mode: 'constraint',
      });
    } else if ((current === 'inspect_state' || current === 'prepare_change') && (signal.toolName === 'file_write' || signal.toolName === 'file_edit')) {
      push({
        id: 'subgoal_apply_before_inspect',
        from: current,
        to: current,
        trigger: 'apply-before-inspect on change goals',
        reason: 'Writes were attempted too early for the current change stage.',
        effect: 'kept the stage on safe inspection/preparation and reinforced verified change posture',
        signals: [`run:tool_failure:${signal.toolName}=${state.toolFailureCounts[signal.toolName] || 0}`],
        mode: 'constraint',
      });
    } else if ((current === 'gather' || current === 'extract') && (signal.toolFamily === 'desktop' || signal.toolFamily === 'shell')) {
      push({
        id: 'subgoal_evidence_drift_correction',
        from: current,
        to: current === 'extract' ? 'gather' : 'gather',
        trigger: 'premature action on evidence/report goal',
        reason: 'Evidence collection drifted into action-heavy behavior too early.',
        effect: 're-centered the stage on bounded evidence gathering',
        signals: [`run:family_failure:${signal.toolFamily}=${state.familyFailureCounts[signal.toolFamily] || 0}`],
        mode: 'advisory',
      });
    } else {
      const failureCount = signal.toolName ? (state.toolFailureCounts[signal.toolName] || 0) : 0;
      if (failureCount >= 2) {
        push({
          id: `subgoal_repeated_failure:${current}`,
          from: current,
          to: current,
          trigger: 'repeated failure at same stage',
          reason: `The run is stalled at ${current} with repeated failures.`,
          effect: `kept the stage on ${current} and tightened stage-local retry behavior`,
          signals: [signal.toolName ? `run:tool_failure:${signal.toolName}=${failureCount}` : `run:stage_failure:${current}`],
          mode: 'advisory',
        });
      }
    }
  }

  if (signal.kind === 'verification_failed') {
    if (current === 'verify_outcome' || current === 'verify_change' || current === 'verify_artifact') {
      push({
        id: `subgoal_keep_${current}_on_verification_failure`,
        from: current,
        to: current,
        trigger: 'verification-stage fragility',
        reason: 'Verification failed, so the run must remain on the verification stage.',
        effect: 'blocked false stage advancement and tightened verification posture',
        signals: [`run:verification_failure:${signal.verificationType || 'unknown'}`],
        mode: 'constraint',
      });
    } else if (current === 'apply_change') {
      push({
        id: 'subgoal_return_to_verify_change',
        from: 'apply_change',
        to: 'verify_change',
        trigger: 'mechanical stage progression without actual stage completion',
        reason: 'Writes completed, but the change is not verified yet.',
        effect: 'moved the run into verify_change instead of advancing past verification',
        signals: [`run:verification_failure:${signal.verificationType || 'unknown'}`],
        mode: 'constraint',
      });
    } else if (current === 'perform_action') {
      push({
        id: 'subgoal_move_to_verify_outcome',
        from: 'perform_action',
        to: 'verify_outcome',
        trigger: 'mechanical stage progression without actual stage completion',
        reason: 'Action execution occurred, but outcome verification is still unmet.',
        effect: 'moved the run into verify_outcome and blocked false completion',
        signals: [`run:verification_failure:${signal.verificationType || 'unknown'}`],
        mode: 'constraint',
      });
    }
  }

  if (signal.kind === 'human_intervention_required' && buildBaseSubGoalPlan(harness.currentGoal).includes('wait_for_intervention')) {
    const from = current === 'wait_for_intervention' ? 'wait_for_intervention' : current;
    push({
      id: 'subgoal_wait_for_intervention',
      from,
      to: 'wait_for_intervention',
      trigger: 'intervention stage specialization',
      reason: 'Human intervention is required before the stage can complete.',
      effect: 'moved the stage to wait_for_intervention',
      signals: ['run:human_intervention_required=true'],
      mode: 'constraint',
    });
  }

  return adjustments;
}

export function applyInLoopHarnessAdjustment(
  harness: ResolvedHarness,
  state: RuntimeHarnessReactiveState,
  signal: RuntimeHarnessSignal,
  input: HarnessResolutionInput,
): { harness: ResolvedHarness; adjustments: HarnessReactiveAdjustment[]; strategyShifts: HarnessStrategyShift[]; goalAdjustments: HarnessGoalAdjustment[]; subGoalAdjustments: HarnessSubGoalAdjustment[] } {
  updateRuntimeStateFromSignal(state, signal);
  const adjustments = maybeApplyInLoopAdjustment(harness, state, signal, input);
  const strategyShifts = maybeApplyStrategyShift(harness, state, signal, input);
  const goalAdjustments = maybeApplyGoalAwareAdjustments(harness, state, signal, input);
  const subGoalAdjustments = maybeApplySubGoalAdjustments(harness, state, signal);
  return { harness, adjustments, strategyShifts, goalAdjustments, subGoalAdjustments };
}

function deterministicBrowserRank(toolName: string): number {
  const order = [
    'browser_run_harness',
    'browser_run_playbook',
    'browser_detect_form',
    'browser_fill_field',
    'browser_wait',
    'browser_read_page',
    'browser_extract',
  ];
  const index = order.indexOf(toolName);
  return index === -1 ? order.length : index;
}

export function applyHarnessToolPolicy(
  tools: NormalizedToolDefinition[],
  policy?: HarnessToolPolicy,
): NormalizedToolDefinition[] {
  if (!policy) return tools;
  const suppressed = new Set(policy.suppressFamilies || []);
  const demotedTools = new Map((policy.demotedTools || []).map((toolName, index) => [toolName, index]));
  const prefer = new Map((policy.preferFamilies || []).map((family, index) => [family, index]));
  const discourage = new Map((policy.discourageFamilies || []).map((family, index) => [family, index]));
  const filtered = tools.filter((tool) => !suppressed.has(inferToolFamily(tool.name)));

  return [...filtered].sort((left, right) => {
    if (policy.deterministicBrowserFirst) {
      const leftDet = deterministicBrowserRank(left.name);
      const rightDet = deterministicBrowserRank(right.name);
      if (leftDet !== rightDet) return leftDet - rightDet;
    }

    const leftDemoted = demotedTools.has(left.name) ? demotedTools.get(left.name)! : Number.POSITIVE_INFINITY;
    const rightDemoted = demotedTools.has(right.name) ? demotedTools.get(right.name)! : Number.POSITIVE_INFINITY;
    if (leftDemoted !== rightDemoted) return rightDemoted - leftDemoted;

    const leftFamily = inferToolFamily(left.name);
    const rightFamily = inferToolFamily(right.name);
    const leftPrefer = prefer.has(leftFamily) ? prefer.get(leftFamily)! : Number.POSITIVE_INFINITY;
    const rightPrefer = prefer.has(rightFamily) ? prefer.get(rightFamily)! : Number.POSITIVE_INFINITY;
    if (leftPrefer !== rightPrefer) return leftPrefer - rightPrefer;

    const leftDiscourage = discourage.has(leftFamily) ? discourage.get(leftFamily)! : Number.POSITIVE_INFINITY;
    const rightDiscourage = discourage.has(rightFamily) ? discourage.get(rightFamily)! : Number.POSITIVE_INFINITY;
    if (leftDiscourage !== rightDiscourage) return rightDiscourage - leftDiscourage;

    return 0;
  });
}

export function buildHarnessDirectiveBlock(harness: ResolvedHarness): string {
  const lines = [
    '[HARNESS]',
    `id=${harness.baseHarnessId}`,
    `learning_key=${harness.learningPatternKey}`,
    `base_goal=${harness.baseGoal}`,
    `goal=${harness.currentGoal}`,
    `subgoal=${harness.currentSubGoal}`,
    `base_strategy=${harness.baseStrategy}`,
    `strategy=${harness.currentStrategy}`,
    `requested_mode=${harness.requestedExecutionMode}`,
    `actual_mode=${harness.actualExecutionMode}`,
  ];

  if (harness.toolPolicy.deterministicBrowserFirst) lines.push('tool_bias=deterministic_browser_first');
  if ((harness.toolPolicy.preferFamilies || []).length > 0) lines.push(`prefer_families=${(harness.toolPolicy.preferFamilies || []).join(',')}`);
  if ((harness.toolPolicy.discourageFamilies || []).length > 0) lines.push(`discourage_families=${(harness.toolPolicy.discourageFamilies || []).join(',')}`);
  if ((harness.toolPolicy.suppressFamilies || []).length > 0) lines.push(`suppress_families=${(harness.toolPolicy.suppressFamilies || []).join(',')}`);
  if ((harness.toolPolicy.demotedTools || []).length > 0) lines.push(`demoted_tools=${(harness.toolPolicy.demotedTools || []).join(',')}`);
  if (harness.safetyPolicy.elevatedApproval) lines.push('safety=elevated_approval');
  if (harness.safetyPolicy.elevatedVerification) lines.push('verification=elevated');
  if (harness.responsePolicy.evidenceOrientedFinish) lines.push('finish=evidence_oriented');
  if (harness.responsePolicy.requireVerificationSummary) lines.push('report=include_verification_summary');
  if (harness.retryGuidance !== 'standard') lines.push(`retry_guidance=${harness.retryGuidance}`);
  if (harness.branchingGuidance !== 'standard') lines.push(`branching_guidance=${harness.branchingGuidance}`);
  if (harness.hadInLoopAdaptation) lines.push(`in_loop_adjustments=${harness.inLoopAdjustments.length}`);
  if (harness.learningConfidence) lines.push(`learning_confidence=${harness.learningConfidence.score}`);
  for (const line of harness.promptPolicy.directiveLines || []) {
    lines.push(`directive=${line}`);
  }
  for (const hint of harness.appliedLearningHints.slice(-3)) {
    lines.push(`learning_hint=${hint.id}:${hint.effect}`);
  }
  for (const note of harness.reactiveNotes.slice(-4)) {
    lines.push(`reactive_note=${note}`);
  }
  for (const adjustment of harness.inLoopAdjustments.slice(-3)) {
    lines.push(`runtime_adjustment=${adjustment.id}:${adjustment.effect}`);
  }
  const latestGoalAdjustment = harness.goalAdjustments[harness.goalAdjustments.length - 1];
  if (latestGoalAdjustment) lines.push(`goal_shift=${latestGoalAdjustment.from}->${latestGoalAdjustment.to}:${latestGoalAdjustment.effect}`);
  const latestSubGoalAdjustment = harness.subGoalAdjustments[harness.subGoalAdjustments.length - 1];
  if (latestSubGoalAdjustment) lines.push(`subgoal_shift=${latestSubGoalAdjustment.from}->${latestSubGoalAdjustment.to}:${latestSubGoalAdjustment.effect}`);
  const latestShift = harness.strategyShiftHistory[harness.strategyShiftHistory.length - 1];
  if (latestShift) lines.push(`strategy_shift=${latestShift.from}->${latestShift.to}:${latestShift.effect}`);
  if (harness.downgradeReason) lines.push(`downgrade=${harness.downgradeReason}`);

  return lines.join('\n');
}

export function formatResolvedHarnessDebug(harness: ResolvedHarness): string {
  const lines = [
    `Harness: ${harness.id}`,
    `Base harness: ${harness.baseHarnessId}`,
    `Base goal: ${harness.baseGoal}`,
    `Current goal: ${harness.currentGoal}`,
    `Base sub-goal plan: ${harness.baseSubGoalPlan.join(' -> ')}`,
    `Current sub-goal: ${harness.currentSubGoal}`,
    `Completed sub-goals: ${harness.completedSubGoals.join(' -> ') || 'none'}`,
    `Sub-goal confidence: ${harness.subGoalConfidence}`,
    `Goal confidence: ${harness.goalConfidence}`,
    `Learning key: ${harness.learningPatternKey}`,
    `Learning confidence: ${harness.learningConfidence ? harness.learningConfidence.score : 'none'}`,
    `Base strategy: ${harness.baseStrategy}`,
    `Current strategy: ${harness.currentStrategy}`,
    `Description: ${harness.description}`,
    `Requested mode: ${harness.requestedExecutionMode}`,
    `Actual mode: ${harness.actualExecutionMode}${harness.downgradeReason ? ` (${harness.downgradeReason})` : ''}`,
    `Model: ${harness.selectedModel}`,
    `Model strategy: ${harness.providerStrategyNote}`,
    `Prefer families: ${(harness.toolPolicy.preferFamilies || []).join(', ') || 'none'}`,
    `Discourage families: ${(harness.toolPolicy.discourageFamilies || []).join(', ') || 'none'}`,
    `Suppress families: ${(harness.toolPolicy.suppressFamilies || []).join(', ') || 'none'}`,
    `Demoted tools: ${(harness.toolPolicy.demotedTools || []).join(', ') || 'none'}`,
    `Deterministic browser first: ${harness.toolPolicy.deterministicBrowserFirst ? 'yes' : 'no'}`,
    `Elevated approval: ${harness.safetyPolicy.elevatedApproval ? 'yes' : 'no'}`,
    `Elevated verification: ${harness.safetyPolicy.elevatedVerification ? 'yes' : 'no'}`,
    `Evidence-oriented finish: ${harness.responsePolicy.evidenceOrientedFinish ? 'yes' : 'no'}`,
    `Retry guidance: ${harness.retryGuidance}`,
    `Branching guidance: ${harness.branchingGuidance}`,
    `Reactive notes: ${harness.reactiveNotes.join(' | ') || 'none'}`,
    `Learning evidence: ${harness.learningEvidenceSummary.join(' | ') || 'none'}`,
    `Applied learning hints: ${harness.appliedLearningHints.map((hint) => `${hint.id} (${hint.kind})`).join(' | ') || 'none'}`,
    `Learning influenced start: ${harness.learningInfluencedStart ? 'yes' : 'no'}`,
    `Goal-aware notes: ${harness.goalAwareNotes.join(' | ') || 'none'}`,
    `Stage-aware notes: ${harness.stageAwareNotes.join(' | ') || 'none'}`,
    `Adaptation reasons: ${harness.adaptationReasons.join(' | ') || 'none'}`,
    `Goal drift signals: ${harness.goalDriftSignals.join(' | ') || 'none'}`,
    `Sub-goal progress signals: ${harness.subGoalProgressSignals.join(' | ') || 'none'}`,
    `Strategy shift reasons: ${harness.strategyShiftReasons.join(' | ') || 'none'}`,
    `Had in-loop adaptation: ${harness.hadInLoopAdaptation ? 'yes' : 'no'}`,
    `In-loop adjustments: ${harness.inLoopAdjustments.map((adjustment) => `${adjustment.id} (${adjustment.mode})`).join(' | ') || 'none'}`,
    `Goal adjustments: ${harness.goalAdjustments.map((adjustment) => `${adjustment.from}->${adjustment.to} (${adjustment.mode})`).join(' | ') || 'none'}`,
    `Sub-goal adjustments: ${harness.subGoalAdjustments.map((adjustment) => `${adjustment.from}->${adjustment.to} (${adjustment.mode})`).join(' | ') || 'none'}`,
    `Strategy shifts: ${harness.strategyShiftHistory.map((shift) => `${shift.from}->${shift.to} (${shift.mode})`).join(' | ') || 'none'}`,
    `Audit signals: ${harness.auditSignalsUsed.join(' | ') || 'none'}`,
    `Matched: ${harness.matchedHarnessIds.join(', ')}`,
  ];
  return lines.join('\n');
}
