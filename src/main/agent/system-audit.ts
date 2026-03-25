import {
  insertAuditToolTelemetry,
  listRecentAuditToolTelemetry,
  setAuditRunOutcome,
  type AuditLoopOutcome,
  type AuditToolTelemetryRecord,
} from '../db/audit-tool-telemetry';
import { listRunRecords, type RunRecord } from '../db/runs';
import { getRunEventRecords, type RunEventRecord } from '../db/run-events';
import {
  DEFAULT_SHELL_TIMEOUT_SECONDS,
  EXECUTION_PLANNING_ENABLED,
  LOOP_MAX_WALL_MS,
  MAX_SHELL_TIMEOUT_SECONDS,
} from './runtime-constraints';

const RECENT_TOOL_WINDOW = 100;
const SCORECARD_TOOL_WINDOW = 250;
const SCENARIO_RUN_WINDOW = 25;
const CACHE_TTL_MS = 60_000;
const MIN_TOOL_SAMPLE = 2;
const MIN_SUBSYSTEM_SAMPLE = 3;
const MIN_RELATIVE_COMPARISON_SAMPLE = 3;
const MIN_CONFIDENCE_SAMPLE = 5;
const DEGRADED_SUCCESS_RATE = 0.6;
const HEALTHY_SUCCESS_RATE = 0.8;
const RELATIVE_ADVANTAGE_DELTA = 0.15;
const RECOVERY_HEAVY_THRESHOLD = 2;
const SHELL_TIMEOUT_HEAVY_THRESHOLD = 2;
const APPROVAL_HEAVY_THRESHOLD = 2;
const MAX_DYNAMIC_AWARENESS_LINES = 6;
const MIN_WORKFLOW_CONFIDENCE_RUNS = 3;
const EARLY_FAILURE_PROGRESS_THRESHOLD = 0.34;
const REASONABLE_TOOL_CALL_TARGET = 4;
const HEAVY_TOOL_CALL_THRESHOLD = 8;
const RETRY_BURDEN_NORMALIZER = 2;
const FAST_WORKFLOW_DURATION_MS = 5_000;
const SLOW_WORKFLOW_DURATION_MS = 60_000;
const MIN_FRAGILE_TRANSITION_FAILING_RUNS = 2;
const FRAGILE_TRANSITION_FAILURE_DELTA = 0.2;
const LEARNING_RUN_WINDOW = 12;
const MIN_LEARNING_SAMPLE = 3;
const MAX_LEARNING_HINTS = 4;

const SUBSYSTEM_CATEGORY_MAP: Record<CapabilitySubsystem, CapabilityCategory> = {
  planning: 'planning',
  browser_automation: 'browser',
  gui_automation: 'gui',
  shell_cli: 'shell',
  filesystem: 'filesystem',
  human_intervention_flow: 'interaction',
  recovery_path: 'reliability',
  sub_agent_swarm: 'autonomy',
};

const CATEGORY_WEIGHTS: Record<CapabilityCategory, number> = {
  browser: 0.22,
  gui: 0.12,
  shell: 0.16,
  filesystem: 0.16,
  interaction: 0.12,
  reliability: 0.1,
  autonomy: 0.06,
  planning: 0.06,
};

export interface RecordToolTelemetryInput {
  runId: string;
  iterationIndex: number;
  toolName: string;
  toolCategory?: string;
  success: boolean;
  durationMs: number;
  errorType?: string | null;
  approvalRequired?: boolean;
  recoveryInvoked?: boolean;
  interventionTriggered?: boolean;
  interventionResolved?: boolean;
  subAgentSpawned?: boolean;
}

export interface ToolAuditMetric {
  toolName: string;
  callCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
}

export interface CategoryReliabilityMetric {
  category: string;
  callCount: number;
  successRate: number;
}

export type CapabilitySubsystem =
  | 'planning'
  | 'browser_automation'
  | 'gui_automation'
  | 'shell_cli'
  | 'filesystem'
  | 'human_intervention_flow'
  | 'recovery_path'
  | 'sub_agent_swarm';

export type CapabilityCategory =
  | 'browser'
  | 'gui'
  | 'shell'
  | 'filesystem'
  | 'interaction'
  | 'reliability'
  | 'autonomy'
  | 'planning';

export type CapabilityStatus = 'healthy' | 'unproven' | 'degraded' | 'disabled';

export interface CapabilityHealthSignal {
  subsystem: CapabilitySubsystem;
  category: CapabilityCategory;
  status: CapabilityStatus;
  declaredAvailable: boolean;
  observedRecently: boolean;
  successRateRecent?: number;
  sampleSize: number;
  degraded: boolean;
  disabledStaticConstraint: boolean;
  functionalityScore: number;
  reliabilityScore: number;
  uxScore: number;
  completenessScore: number;
  confidenceScore: number;
  note?: string;
}

export type AutoTuningHintKind =
  | 'prefer_browser_over_gui'
  | 'avoid_planning'
  | 'chunk_shell_commands'
  | 'treat_sub_agents_as_optional'
  | 'expect_approval_pauses';

export interface AutoTuningHint {
  kind: AutoTuningHintKind;
  reason: string;
  effect: string;
}

export interface CapabilityCategorySummary {
  category: CapabilityCategory;
  subsystemCount: number;
  status: CapabilityStatus;
  functionalityScore: number;
  reliabilityScore: number;
  uxScore: number;
  completenessScore: number;
  confidenceScore: number;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface ScenarioSummary {
  scenario: ScenarioDefinition;
  runCount: number;
  completionRate: number;
  avgDurationMs: number;
  avgToolCalls: number;
  workflowCompletionRate: number;
  averageDurationMs: number;
  averageToolCalls: number;
  earlyFailureRate: number;
  lateFailureRate: number;
  interventionRate: number;
  approvalRate: number;
  recoveryRate: number;
  crossSubsystemCount: number;
  retryBurden: number;
  workflowEfficiencyScore: number;
  workflowCohesionScore: number;
  workflowConfidenceScore: number;
  mostCommonPath?: string;
  mostCommonSuccessfulPath?: string;
  mostCommonFailedPath?: string;
  mostCommonRecoveryPath?: string;
  mostCommonFailureStepIndex?: number;
  mostCommonFailureTool?: string;
  mostCommonFailureSubsystem?: CapabilitySubsystem;
  failureStepDistribution: Array<{ stepIndex: number; count: number }>;
  fragileTransitions: Array<{ transition: string; failingRuns: number; totalRuns: number; failureRate: number }>;
  repeatedFailureClusterCount: number;
  toolBeforeRecovery?: string;
  postRecoveryContinuationPath?: string;
  pathSummary: {
    mostCommonPath?: string;
    mostCommonSuccessfulPath?: string;
    mostCommonFailedPath?: string;
  };
  failureLocalizationSummary: {
    mostCommonFailureStepIndex?: number;
    mostCommonFailureTool?: string;
    mostCommonFailureSubsystem?: CapabilitySubsystem;
    failureStepDistribution: Array<{ stepIndex: number; count: number }>;
    repeatedFailureClusterCount: number;
  };
  transitionSummary: {
    mostCommonSuccessfulTransition?: string;
    mostCommonFailedTransition?: string;
    fragileTransitions: Array<{ transition: string; failingRuns: number; totalRuns: number; failureRate: number }>;
  };
  recoveryPathSummary: {
    mostCommonRecoveryPath?: string;
    toolBeforeRecovery?: string;
    postRecoveryContinuationPath?: string;
  };
  primaryFailureTools: Array<{ toolName: string; count: number }>;
  primaryFailureSubsystems: Array<{ subsystem: CapabilitySubsystem; count: number }>;
}

export interface WorkflowSummaryEntry {
  scenarioId: string;
  score: number;
  note: string;
}

export interface WorkflowScoreSummary {
  strongestWorkflows: WorkflowSummaryEntry[];
  weakestWorkflows: WorkflowSummaryEntry[];
  highestFrictionWorkflows: WorkflowSummaryEntry[];
  sparseDataWarnings: string[];
}

export type HarnessPatternKey = string;

export interface LearningConfidence {
  score: number;
  sampleSize: number;
  recentWindowSize: number;
  sparse: boolean;
}

export type HarnessOptimizationHintKind =
  | 'prefer_harness_start'
  | 'prefer_strategy_start'
  | 'demote_tool_family'
  | 'tighten_goal_posture'
  | 'stage_caution'
  | 'transition_caution'
  | 'prefer_retry_guidance';

export interface HarnessOptimizationHint {
  id: string;
  kind: HarnessOptimizationHintKind;
  reason: string;
  effect: string;
  confidence: LearningConfidence;
  preferHarnessId?: string;
  preferStrategy?: string;
  demoteFamily?: string;
  preferGoal?: string;
  cautionSubGoal?: string;
  cautionTransition?: string;
  retryGuidance?: string;
  branchingGuidance?: string;
}

export interface HarnessLearningSummary {
  patternKey: HarnessPatternKey;
  harnessId: string;
  baseGoal: string;
  sampleSize: number;
  completionRate: number;
  successfulHarnesses: Array<{ harnessId: string; count: number }>;
  failingHarnesses: Array<{ harnessId: string; count: number }>;
  successfulStartingStrategies: Array<{ strategy: string; count: number }>;
  failingStartingStrategies: Array<{ strategy: string; count: number }>;
  repeatedGoalTightenings: Array<{ goal: string; count: number }>;
  repeatedStageStalls: Array<{ subGoal: string; count: number }>;
  repeatedFragileTransitions: Array<{ transition: string; count: number }>;
  repeatedFailingToolFamilies: Array<{ family: string; count: number }>;
  optimizationHints: HarnessOptimizationHint[];
  evidenceSummary: string[];
  confidence: LearningConfidence;
}

export interface CapabilityScorecardSnapshot {
  generatedAt: number;
  observedToolCalls: number;
  observedRuns: number;
  overallScore: number;
  capabilityHealth: CapabilityHealthSignal[];
  categorySummaries: CapabilityCategorySummary[];
  scenarioSummaries: ScenarioSummary[];
  workflowSummary: WorkflowScoreSummary;
  text: string;
}

export interface SystemAuditSummary {
  windowSize: number;
  observedToolCalls: number;
  observedRuns: number;
  mostReliableTools: ToolAuditMetric[];
  leastReliableTools: ToolAuditMetric[];
  averageDurationByTool: Record<string, number>;
  repeatedRecentFailures: Array<{ toolName: string; streak: number }>;
  recoveryHeavyTools: Array<{ toolName: string; count: number }>;
  rarelyUsedTools: string[];
  categoryReliability: CategoryReliabilityMetric[];
  interventionObservedRecently: boolean;
  interventionResolvedRecently: boolean;
  subAgentSpawnObservedRecently: boolean;
  approvalObservedRecently: boolean;
  capabilityHealth: CapabilityHealthSignal[];
  capabilityCategories: CapabilityCategorySummary[];
  scenarioSummaries: ScenarioSummary[];
  workflowSummary: WorkflowScoreSummary;
  overallScore: number;
  autoTuningHints: AutoTuningHint[];
  harnessLearningSummaries: HarnessLearningSummary[];
}

interface CapabilityObservation {
  sampleSize: number;
  successCount: number;
  failureCount: number;
  recoveryCount: number;
  approvalCount: number;
  interventionCount: number;
  resolvedInterventionCount: number;
}

interface RunWorkflowMetrics {
  toolCallCount: number;
  subsystemCount: number;
  recoveryCount: number;
  intervention: boolean;
  approval: boolean;
  failedEarly: boolean;
  failedLate: boolean;
  retryBurden: number;
  pathSignature: string;
  transitionSignatures: string[];
  firstFailureStepIndex?: number;
  firstFailureTool?: string;
  firstFailureSubsystem?: CapabilitySubsystem;
  failingTransition?: string;
  recoveryPathSignature?: string;
  toolBeforeRecovery?: string;
  postRecoveryContinuationPath?: string;
}

let cachedAwarenessBlock = '';
let cachedSummary: SystemAuditSummary | null = null;
let cacheComputedAt = 0;
let cacheDirty = true;

export function recordToolTelemetry(input: RecordToolTelemetryInput): void {
  insertAuditToolTelemetry(input);
  cacheDirty = true;
}

export function finalizeRunAudit(runId: string, loopOutcome: AuditLoopOutcome): void {
  setAuditRunOutcome(runId, loopOutcome);
  recomputeSystemAwareness();
}

export function getSystemAwarenessBlock(): string {
  const stale = Date.now() - cacheComputedAt > CACHE_TTL_MS;
  if (cacheDirty || stale) recomputeSystemAwareness();
  return cachedAwarenessBlock;
}

export function getSystemAuditSummary(): SystemAuditSummary {
  const stale = Date.now() - cacheComputedAt > CACHE_TTL_MS;
  if (cacheDirty || stale || !cachedSummary) recomputeSystemAwareness();
  return cachedSummary!;
}

export function getCapabilityScorecard(): CapabilityScorecardSnapshot {
  const summary = getSystemAuditSummary();
  return {
    generatedAt: cacheComputedAt,
    observedToolCalls: summary.observedToolCalls,
    observedRuns: summary.observedRuns,
    overallScore: summary.overallScore,
    capabilityHealth: summary.capabilityHealth,
    categorySummaries: summary.capabilityCategories,
    scenarioSummaries: summary.scenarioSummaries,
    workflowSummary: summary.workflowSummary,
    text: formatCapabilityScorecardText(summary),
  };
}

export function clearSystemAuditCache(): void {
  cachedAwarenessBlock = '';
  cachedSummary = null;
  cacheComputedAt = 0;
  cacheDirty = true;
}

export function summarizeRecentTelemetry(
  rows: AuditToolTelemetryRecord[],
  recentRuns: RunRecord[] = [],
  scenarioRows: AuditToolTelemetryRecord[] = rows,
  recentRunEvents: RunEventRecord[] = [],
): SystemAuditSummary {
  const metrics = new Map<string, { callCount: number; successCount: number; failureCount: number; totalDurationMs: number }>();
  const categoryMetrics = new Map<string, { callCount: number; successCount: number }>();
  const averageDurationByTool: Record<string, number> = {};
  const runIds = new Set<string>();

  for (const row of rows) {
    runIds.add(row.runId);
    const metric = metrics.get(row.toolName) || {
      callCount: 0,
      successCount: 0,
      failureCount: 0,
      totalDurationMs: 0,
    };
    metric.callCount += 1;
    metric.successCount += row.success ? 1 : 0;
    metric.failureCount += row.success ? 0 : 1;
    metric.totalDurationMs += row.durationMs;
    metrics.set(row.toolName, metric);

    if (row.toolCategory) {
      const category = categoryMetrics.get(row.toolCategory) || { callCount: 0, successCount: 0 };
      category.callCount += 1;
      category.successCount += row.success ? 1 : 0;
      categoryMetrics.set(row.toolCategory, category);
    }
  }

  const toolMetrics: ToolAuditMetric[] = [...metrics.entries()].map(([toolName, metric]) => {
    const avgDurationMs = Math.round(metric.totalDurationMs / Math.max(metric.callCount, 1));
    averageDurationByTool[toolName] = avgDurationMs;
    return {
      toolName,
      callCount: metric.callCount,
      successCount: metric.successCount,
      failureCount: metric.failureCount,
      successRate: metric.callCount > 0 ? metric.successCount / metric.callCount : 0,
      avgDurationMs,
    };
  });

  const reliabilityPool = toolMetrics.filter((metric) => metric.callCount >= MIN_TOOL_SAMPLE);
  const mostReliableTools = [...reliabilityPool]
    .filter((metric) => metric.successCount > 0)
    .sort((a, b) =>
      b.successRate - a.successRate
      || b.callCount - a.callCount
      || a.avgDurationMs - b.avgDurationMs
      || a.toolName.localeCompare(b.toolName))
    .slice(0, 3);

  const leastReliableTools = [...reliabilityPool]
    .filter((metric) => metric.failureCount > 0)
    .sort((a, b) =>
      a.successRate - b.successRate
      || b.failureCount - a.failureCount
      || b.callCount - a.callCount
      || a.avgDurationMs - b.avgDurationMs
      || a.toolName.localeCompare(b.toolName))
    .slice(0, 3);

  const chronologicalRows = [...rows].reverse();
  const recentFailures = new Map<string, number>();
  for (let i = chronologicalRows.length - 1; i >= 0; i--) {
    const row = chronologicalRows[i];
    if (recentFailures.has(row.toolName)) continue;
    if (row.success) {
      recentFailures.set(row.toolName, 0);
      continue;
    }
    let streak = 1;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = chronologicalRows[j];
      if (candidate.toolName !== row.toolName) continue;
      if (candidate.success) break;
      streak += 1;
    }
    recentFailures.set(row.toolName, streak);
  }
  const repeatedRecentFailures = [...recentFailures.entries()]
    .filter(([, streak]) => streak >= 2)
    .map(([toolName, streak]) => ({ toolName, streak }))
    .sort((a, b) => b.streak - a.streak || a.toolName.localeCompare(b.toolName))
    .slice(0, 3);

  const recoveryHeavyTools = groupRowsByTool(rows, (row) => row.recoveryInvoked)
    .filter((item) => item.count >= RECOVERY_HEAVY_THRESHOLD)
    .slice(0, 3);

  const rarelyUsedTools = toolMetrics
    .filter((metric) => metric.callCount === 1)
    .map((metric) => metric.toolName)
    .sort()
    .slice(0, 5);

  const categoryReliability: CategoryReliabilityMetric[] = [...categoryMetrics.entries()]
    .map(([category, metric]) => ({
      category,
      callCount: metric.callCount,
      successRate: metric.callCount > 0 ? metric.successCount / metric.callCount : 0,
    }))
    .sort((a, b) => b.successRate - a.successRate || b.callCount - a.callCount || a.category.localeCompare(b.category));

  const capabilityHealth = buildCapabilityHealth(rows, categoryReliability);
  const autoTuningHints = buildAutoTuningHints(rows, capabilityHealth, categoryReliability);
  const capabilityCategories = buildCapabilityCategorySummaries(capabilityHealth);
  const scenarioSummaries = buildScenarioSummaries(recentRuns, scenarioRows);
  const workflowSummary = buildWorkflowSummary(scenarioSummaries);
  const overallScore = buildOverallScore(capabilityCategories);
  const harnessLearningSummaries = buildHarnessLearningSummaries(recentRuns, recentRunEvents);

  return {
    windowSize: RECENT_TOOL_WINDOW,
    observedToolCalls: rows.length,
    observedRuns: runIds.size,
    mostReliableTools,
    leastReliableTools,
    averageDurationByTool,
    repeatedRecentFailures,
    recoveryHeavyTools,
    rarelyUsedTools,
    categoryReliability,
    interventionObservedRecently: rows.some((row) => row.interventionTriggered),
    interventionResolvedRecently: rows.some((row) => row.interventionResolved),
    subAgentSpawnObservedRecently: rows.some((row) => row.subAgentSpawned || row.toolName === 'agent_spawn'),
    approvalObservedRecently: rows.some((row) => row.approvalRequired),
    capabilityHealth,
    capabilityCategories,
    scenarioSummaries,
    workflowSummary,
    overallScore,
    autoTuningHints,
    harnessLearningSummaries,
  };
}

export function formatSystemAwarenessBlock(summary: SystemAuditSummary): string {
  const staticLines = buildStaticConstraintLines();
  const lines = [
    '[SYSTEM AWARENESS]',
    ...staticLines,
    ...buildDynamicAwarenessLines(summary),
  ];
  return lines.join('\n');
}

export function formatCapabilityScorecardText(summary: SystemAuditSummary): string {
  const lines = [
    'CAPABILITY SCORECARD',
    `Overall: ${summary.overallScore.toFixed(1)}/10`,
    '',
    'Subsystems',
  ];

  for (const capability of summary.capabilityHealth) {
    lines.push(
      `- ${formatSubsystemLabel(capability.subsystem)} [${capability.status}]: `
      + `F ${capability.functionalityScore.toFixed(1)} | `
      + `R ${capability.reliabilityScore.toFixed(1)} | `
      + `UX ${capability.uxScore.toFixed(1)} | `
      + `C ${capability.completenessScore.toFixed(1)} | `
      + `Conf ${capability.confidenceScore.toFixed(2)}`
      + (capability.note ? ` | ${capability.note}` : ''),
    );
  }

  lines.push('', 'Categories');
  for (const category of summary.capabilityCategories) {
    lines.push(
      `- ${formatCapabilityCategoryLabel(category.category)} [${category.status}]: `
      + `F ${category.functionalityScore.toFixed(1)} | `
      + `R ${category.reliabilityScore.toFixed(1)} | `
      + `UX ${category.uxScore.toFixed(1)} | `
      + `C ${category.completenessScore.toFixed(1)} | `
      + `Conf ${category.confidenceScore.toFixed(2)}`,
    );
  }

  if (summary.scenarioSummaries.length > 0) {
    lines.push('', 'Scenarios');
    for (const scenario of summary.scenarioSummaries) {
      const topTool = scenario.primaryFailureTools[0];
      const topSubsystem = scenario.primaryFailureSubsystems[0];
      const failureSummary = topTool
        ? `${topTool.toolName} x${topTool.count}`
        : topSubsystem
          ? `${formatSubsystemLabel(topSubsystem.subsystem)} x${topSubsystem.count}`
          : 'none observed';
      lines.push(
        `- ${scenario.scenario.id}: `
        + `${formatPercent(scenario.workflowCompletionRate)} completion, `
        + `${formatDuration(scenario.averageDurationMs)} avg, `
        + `${scenario.averageToolCalls.toFixed(1)} tools avg, `
        + `${formatPercent(scenario.interventionRate)} intervention, `
        + `${formatPercent(scenario.recoveryRate)} recovery, `
        + `${formatPercent(scenario.earlyFailureRate)} early / ${formatPercent(scenario.lateFailureRate)} late fail, `
        + `Eff ${scenario.workflowEfficiencyScore.toFixed(1)} | `
        + `Coh ${scenario.workflowCohesionScore.toFixed(1)} | `
        + `Conf ${scenario.workflowConfidenceScore.toFixed(2)}, `
        + `top failure ${failureSummary}`,
      );
      lines.push(`  Common path: ${scenario.mostCommonPath || 'n/a'}`);
      lines.push(`  Failure focus: ${formatFailureFocus(scenario)}`);
      lines.push(`  Recovery path: ${scenario.mostCommonRecoveryPath || 'n/a'}`);
    }
  }

  lines.push('', 'Workflow Summary');
  if (summary.workflowSummary.strongestWorkflows.length === 0) {
    lines.push('- No scenario workflow data is available yet.');
  } else {
    lines.push(`- Strongest: ${summary.workflowSummary.strongestWorkflows.map((entry) => `${entry.scenarioId} (${entry.score.toFixed(1)})`).join(', ')}`);
    lines.push(`- Weakest: ${summary.workflowSummary.weakestWorkflows.map((entry) => `${entry.scenarioId} (${entry.score.toFixed(1)})`).join(', ')}`);
    lines.push(`- Highest friction: ${summary.workflowSummary.highestFrictionWorkflows.map((entry) => `${entry.scenarioId} (${entry.note})`).join(', ')}`);
    for (const warning of summary.workflowSummary.sparseDataWarnings.slice(0, 2)) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}

function recomputeSystemAwareness(): void {
  const scorecardRows = listRecentAuditToolTelemetry(SCORECARD_TOOL_WINDOW);
  const summaryRows = scorecardRows.slice(0, RECENT_TOOL_WINDOW);
  const recentRuns = listRunRecords(SCENARIO_RUN_WINDOW);
  const recentRunEvents = recentRuns.flatMap((run) => getRunEventRecords(run.id));
  cachedSummary = summarizeRecentTelemetry(summaryRows, recentRuns, scorecardRows, recentRunEvents);
  cachedAwarenessBlock = formatSystemAwarenessBlock(cachedSummary);
  cacheComputedAt = Date.now();
  cacheDirty = false;
}

function buildStaticConstraintLines(): string[] {
  const lines: string[] = [];
  if (!EXECUTION_PLANNING_ENABLED) {
    lines.push('- Execution planning is currently disabled in production.');
  }
  lines.push(`- Max runtime per run is ${Math.round(LOOP_MAX_WALL_MS / 60_000)} minutes.`);
  lines.push(`- shell_exec defaults to ${DEFAULT_SHELL_TIMEOUT_SECONDS}s timeouts and caps at ${MAX_SHELL_TIMEOUT_SECONDS}s; avoid long monolithic commands.`);
  return lines;
}

function buildDynamicAwarenessLines(summary: SystemAuditSummary): string[] {
  if (summary.observedToolCalls === 0) {
    return ['- Recent telemetry is sparse; no runtime reliability ranking or drift signal is available yet.'];
  }

  const lines: string[] = [
    `- Recent audit window: ${summary.observedToolCalls} tool calls across ${summary.observedRuns} run${summary.observedRuns === 1 ? '' : 's'}.`,
  ];

  const degradedCapabilities = summary.capabilityHealth.filter((cap) => cap.status === 'degraded');
  const unprovenCapabilities = summary.capabilityHealth.filter((cap) => cap.status === 'unproven');

  for (const capability of degradedCapabilities.slice(0, 2)) {
    lines.push(`- ${formatSubsystemLabel(capability.subsystem)} is degraded${capability.note ? `: ${capability.note}` : '.'}`);
  }

  const planning = summary.capabilityHealth.find((cap) => cap.subsystem === 'planning');
  if (planning?.status === 'unproven' && planning.disabledStaticConstraint === false) {
    lines.push('- Planning has not been exercised recently, so confidence is low.');
  }

  if (summary.recoveryHeavyTools.length > 0) {
    lines.push(`- Recovery has been invoked repeatedly for: ${summary.recoveryHeavyTools.map((item) => `${item.toolName} x${item.count}`).join(', ')}.`);
  }

  const humanFlow = summary.capabilityHealth.find((cap) => cap.subsystem === 'human_intervention_flow');
  if (humanFlow?.status === 'healthy') {
    lines.push('- Human intervention flow is available and has completed successfully in the recent window.');
  } else if (humanFlow?.status === 'degraded') {
    lines.push(`- Human intervention flow is degraded${humanFlow.note ? `: ${humanFlow.note}` : '.'}`);
  } else if (humanFlow?.status === 'unproven') {
    lines.push('- Human intervention flow is unproven in the recent window.');
  }

  for (const hint of summary.autoTuningHints) {
    lines.push(`- ${hint.effect}`);
  }

  if (summary.mostReliableTools.length > 0) {
    lines.push(`- Most reliable tools recently: ${summary.mostReliableTools.map(formatToolMetric).join(', ')}.`);
  }

  if (summary.leastReliableTools.length > 0) {
    lines.push(`- Least reliable tools recently: ${summary.leastReliableTools.map(formatToolMetric).join(', ')}.`);
  }

  if (summary.approvalObservedRecently && !summary.autoTuningHints.some((hint) => hint.kind === 'expect_approval_pauses')) {
    lines.push('- Sensitive actions have required approvals recently; expect pauses at those boundaries.');
  }

  if (degradedCapabilities.length === 0 && unprovenCapabilities.length > 0) {
    const mention = unprovenCapabilities
      .filter((cap) => cap.subsystem !== 'planning')
      .slice(0, 1)
      .map((cap) => formatSubsystemLabel(cap.subsystem))[0];
    if (mention) {
      lines.push(`- ${mention} is not well exercised in the recent window; treat it as lower-confidence.`);
    }
  }

  return lines.slice(0, 1 + MAX_DYNAMIC_AWARENESS_LINES);
}

function buildCapabilityHealth(
  rows: AuditToolTelemetryRecord[],
  categoryReliability: CategoryReliabilityMetric[],
): CapabilityHealthSignal[] {
  const byCategory = new Map(categoryReliability.map((metric) => [metric.category, metric]));
  const shellRows = rows.filter((row) => row.toolCategory === 'shell');
  const filesystemRows = rows.filter((row) => row.toolCategory === 'filesystem');
  const humanRows = rows.filter((row) => row.interventionTriggered);
  const recoveryRows = rows.filter((row) => row.recoveryInvoked);
  const swarmRows = rows.filter((row) => row.subAgentSpawned || row.toolName === 'agent_spawn');

  const browserObservation = toObservation(rows.filter((row) => row.toolCategory === 'browser'));
  const guiObservation = toObservation(rows.filter((row) => row.toolCategory === 'desktop'));
  const shellObservation = toObservation(shellRows);
  const filesystemObservation = toObservation(filesystemRows);
  const humanObservation: CapabilityObservation = {
    sampleSize: humanRows.length,
    successCount: humanRows.filter((row) => row.interventionResolved).length,
    failureCount: humanRows.filter((row) => !row.interventionResolved).length,
    recoveryCount: countRows(humanRows, (row) => row.recoveryInvoked),
    approvalCount: countRows(humanRows, (row) => row.approvalRequired),
    interventionCount: humanRows.length,
    resolvedInterventionCount: humanRows.filter((row) => row.interventionResolved).length,
  };
  const recoveryObservation = toObservation(recoveryRows);
  const swarmObservation = toObservation(swarmRows);

  const planning = buildPlanningCapability();
  const browser = classifyCapability('browser_automation', browserObservation, {
    note: 'Browser tools are the primary web path.',
  });
  const gui = classifyCapability('gui_automation', guiObservation, {
    degradedOverride: isRelativelyDegraded(byCategory.get('desktop'), byCategory.get('browser')),
    note: isRelativelyDegraded(byCategory.get('desktop'), byCategory.get('browser'))
      ? 'Browser automation is outperforming GUI automation in the recent window.'
      : undefined,
  });
  const shell = classifyCapability('shell_cli', shellObservation, {
    degradedOverride: countRows(shellRows, (row) => row.errorType === 'timeout') >= SHELL_TIMEOUT_HEAVY_THRESHOLD,
    note: countRows(shellRows, (row) => row.errorType === 'timeout') >= SHELL_TIMEOUT_HEAVY_THRESHOLD
      ? 'Repeated shell timeouts were observed recently.'
      : undefined,
  });
  const filesystem = classifyCapability('filesystem', filesystemObservation);
  const human = classifyCapability('human_intervention_flow', humanObservation, {
    note: humanRows.length >= MIN_SUBSYSTEM_SAMPLE && humanObservation.successCount === 0
      ? 'Interventions were triggered but not resolved successfully.'
      : humanRows.length > 0 && humanObservation.successCount > 0
        ? 'Recent interventions have completed successfully.'
        : undefined,
  });
  const recovery = classifyCapability('recovery_path', recoveryObservation, {
    degradedOverride: recoveryRows.length >= RECOVERY_HEAVY_THRESHOLD,
    note: recoveryRows.length >= RECOVERY_HEAVY_THRESHOLD
      ? 'Recovery has been invoked repeatedly, indicating runtime drift upstream.'
      : undefined,
  });
  const swarm = classifyCapability('sub_agent_swarm', swarmObservation, {
    note: swarmRows.length > 0 && swarmObservation.failureCount > 0
      ? 'Recent swarm runs have mixed completion outcomes.'
      : undefined,
  });

  return [planning, browser, gui, shell, filesystem, human, recovery, swarm];
}

function buildAutoTuningHints(
  rows: AuditToolTelemetryRecord[],
  capabilityHealth: CapabilityHealthSignal[],
  categoryReliability: CategoryReliabilityMetric[],
): AutoTuningHint[] {
  const hints: AutoTuningHint[] = [];
  const bySubsystem = new Map(capabilityHealth.map((signal) => [signal.subsystem, signal]));
  const browser = categoryReliability.find((metric) => metric.category === 'browser');
  const desktop = categoryReliability.find((metric) => metric.category === 'desktop');
  const shellRows = rows.filter((row) => row.toolCategory === 'shell');
  const approvalCount = countRows(rows, (row) => row.approvalRequired);

  if (!EXECUTION_PLANNING_ENABLED) {
    hints.push({
      kind: 'avoid_planning',
      reason: 'Planning is statically disabled in production.',
      effect: 'Avoid relying on execution planning; continue with direct execution paths.',
    });
  }

  if (
    desktop
    && browser
    && desktop.callCount >= MIN_RELATIVE_COMPARISON_SAMPLE
    && browser.callCount >= MIN_RELATIVE_COMPARISON_SAMPLE
    && isRelativelyDegraded(desktop, browser)
  ) {
    hints.push({
      kind: 'prefer_browser_over_gui',
      reason: 'Browser automation is materially outperforming GUI automation in the recent window.',
      effect: 'Prefer browser tools over GUI tools when both can accomplish the task.',
    });
  }

  if (countRows(shellRows, (row) => row.errorType === 'timeout') >= SHELL_TIMEOUT_HEAVY_THRESHOLD) {
    hints.push({
      kind: 'chunk_shell_commands',
      reason: 'Repeated shell timeouts suggest current shell work is too monolithic.',
      effect: 'Break shell work into shorter commands and verify progress incrementally.',
    });
  }

  const swarm = bySubsystem.get('sub_agent_swarm');
  if (swarm && (swarm.status === 'degraded' || swarm.status === 'unproven')) {
    hints.push({
      kind: 'treat_sub_agents_as_optional',
      reason: swarm.status === 'degraded'
        ? 'Recent swarm completions are underperforming.'
        : 'Recent telemetry does not establish reliable swarm performance.',
      effect: 'Treat sub-agents as optional; keep work local unless parallelism clearly helps.',
    });
  }

  if (approvalCount >= APPROVAL_HEAVY_THRESHOLD) {
    hints.push({
      kind: 'expect_approval_pauses',
      reason: 'Recent runs have encountered multiple approval boundaries.',
      effect: 'Expect approval pauses on sensitive actions and keep execution steps reviewable.',
    });
  }

  return hints.slice(0, 4);
}

function buildCapabilityCategorySummaries(capabilityHealth: CapabilityHealthSignal[]): CapabilityCategorySummary[] {
  const grouped = new Map<CapabilityCategory, CapabilityHealthSignal[]>();
  for (const signal of capabilityHealth) {
    const group = grouped.get(signal.category) || [];
    group.push(signal);
    grouped.set(signal.category, group);
  }

  return [...grouped.entries()]
    .map(([category, signals]) => ({
      category,
      subsystemCount: signals.length,
      status: deriveWorstStatus(signals.map((signal) => signal.status)),
      functionalityScore: average(signals.map((signal) => signal.functionalityScore)),
      reliabilityScore: average(signals.map((signal) => signal.reliabilityScore)),
      uxScore: average(signals.map((signal) => signal.uxScore)),
      completenessScore: average(signals.map((signal) => signal.completenessScore)),
      confidenceScore: average(signals.map((signal) => signal.confidenceScore)),
    }))
    .sort((a, b) => weightForCategory(b.category) - weightForCategory(a.category) || a.category.localeCompare(b.category));
}

function buildScenarioSummaries(recentRuns: RunRecord[], rows: AuditToolTelemetryRecord[]): ScenarioSummary[] {
  const scenarioRuns = recentRuns.filter((run) => run.scenarioId);
  if (scenarioRuns.length === 0) return [];

  const rowsByRun = new Map<string, AuditToolTelemetryRecord[]>();
  for (const row of rows) {
    const group = rowsByRun.get(row.runId) || [];
    group.push(row);
    rowsByRun.set(row.runId, group);
  }

  const grouped = new Map<string, RunRecord[]>();
  for (const run of scenarioRuns) {
    const group = grouped.get(run.scenarioId!) || [];
    group.push(run);
    grouped.set(run.scenarioId!, group);
  }

  return [...grouped.entries()]
    .map(([scenarioId, runs]) => {
      const failureTools = new Map<string, number>();
      const failureSubsystems = new Map<CapabilitySubsystem, number>();
      const pathCounts = new Map<string, number>();
      const successfulPathCounts = new Map<string, number>();
      const failedPathCounts = new Map<string, number>();
      const recoveryPathCounts = new Map<string, number>();
      const preRecoveryToolCounts = new Map<string, number>();
      const postRecoveryPathCounts = new Map<string, number>();
      const failureStepCounts = new Map<number, number>();
      const failureToolCounts = new Map<string, number>();
      const failureSubsystemCounts = new Map<CapabilitySubsystem, number>();
      const successfulTransitionCounts = new Map<string, number>();
      const failingTransitionCounts = new Map<string, number>();
      const transitionRunCounts = new Map<string, number>();
      const transitionFailingRunCounts = new Map<string, number>();
      const failureClusters = new Map<string, number>();
      let completedRuns = 0;
      let totalDurationMs = 0;
      let totalToolCalls = 0;
      let interventionRuns = 0;
      let approvalRuns = 0;
      let recoveryRuns = 0;
      let earlyFailures = 0;
      let lateFailures = 0;
      let totalSubsystemCount = 0;
      let totalRetryBurden = 0;

      for (const run of runs) {
        const runRows = sortRunRows(rowsByRun.get(run.id) || []);
        const workflowMetrics = analyzeRunWorkflow(run, runRows);
        if (run.status === 'completed') completedRuns += 1;
        totalDurationMs += Math.max((run.completedAt ?? run.updatedAt) - run.startedAt, 0);
        totalToolCalls += Math.max(run.toolCallCount, workflowMetrics.toolCallCount);
        totalSubsystemCount += workflowMetrics.subsystemCount;
        totalRetryBurden += workflowMetrics.retryBurden;
        incrementCount(pathCounts, workflowMetrics.pathSignature);
        if (run.status === 'completed') {
          incrementCount(successfulPathCounts, workflowMetrics.pathSignature);
        } else {
          incrementCount(failedPathCounts, workflowMetrics.pathSignature);
        }
        if (workflowMetrics.intervention) interventionRuns += 1;
        if (workflowMetrics.approval) approvalRuns += 1;
        if (workflowMetrics.recoveryCount > 0) recoveryRuns += 1;
        if (workflowMetrics.failedEarly) earlyFailures += 1;
        if (workflowMetrics.failedLate) lateFailures += 1;
        if (workflowMetrics.recoveryPathSignature) incrementCount(recoveryPathCounts, workflowMetrics.recoveryPathSignature);
        if (workflowMetrics.toolBeforeRecovery) incrementCount(preRecoveryToolCounts, workflowMetrics.toolBeforeRecovery);
        if (workflowMetrics.postRecoveryContinuationPath) incrementCount(postRecoveryPathCounts, workflowMetrics.postRecoveryContinuationPath);
        if (workflowMetrics.firstFailureStepIndex !== undefined) incrementCount(failureStepCounts, workflowMetrics.firstFailureStepIndex);
        if (workflowMetrics.firstFailureTool) incrementCount(failureToolCounts, workflowMetrics.firstFailureTool);
        if (workflowMetrics.firstFailureSubsystem) incrementCount(failureSubsystemCounts, workflowMetrics.firstFailureSubsystem);
        if (workflowMetrics.firstFailureStepIndex !== undefined || workflowMetrics.firstFailureTool || workflowMetrics.failingTransition) {
          incrementCount(
            failureClusters,
            `${workflowMetrics.firstFailureStepIndex ?? 0}|${workflowMetrics.firstFailureTool ?? 'unknown'}|${workflowMetrics.failingTransition ?? 'none'}`,
          );
        }

        const uniqueTransitions = new Set(workflowMetrics.transitionSignatures);
        for (const transition of uniqueTransitions) {
          incrementCount(transitionRunCounts, transition);
          if (run.status === 'completed') {
            incrementCount(successfulTransitionCounts, transition);
          } else {
            incrementCount(failingTransitionCounts, transition);
            incrementCount(transitionFailingRunCounts, transition);
          }
        }

        for (const row of runRows) {
          if (row.success) continue;
          failureTools.set(row.toolName, (failureTools.get(row.toolName) || 0) + 1);
          const subsystem = inferSubsystemFromRow(row);
          if (subsystem) {
            failureSubsystems.set(subsystem, (failureSubsystems.get(subsystem) || 0) + 1);
          }
        }
      }

      const runCount = Math.max(runs.length, 1);
      const workflowCompletionRate = completedRuns / runCount;
      const averageDurationMs = totalDurationMs / runCount;
      const averageToolCalls = totalToolCalls / runCount;
      const interventionRate = interventionRuns / runCount;
      const approvalRate = approvalRuns / runCount;
      const recoveryRate = recoveryRuns / runCount;
      const earlyFailureRate = earlyFailures / runCount;
      const lateFailureRate = lateFailures / runCount;
      const crossSubsystemCount = roundTo(totalSubsystemCount / runCount, 1);
      const retryBurden = roundTo(totalRetryBurden / runCount, 1);
      const workflowEfficiencyScore = deriveWorkflowEfficiencyScore({
        workflowCompletionRate,
        averageDurationMs,
        averageToolCalls,
        recoveryRate,
        interventionRate,
        approvalRate,
        retryBurden,
      });
      const workflowCohesionScore = deriveWorkflowCohesionScore({
        workflowCompletionRate,
        crossSubsystemCount,
        earlyFailureRate,
        lateFailureRate,
        retryBurden,
      });
      const workflowConfidenceScore = roundTo(clamp(runs.length / MIN_WORKFLOW_CONFIDENCE_RUNS, 0, 1), 2);
      const scenarioFailureRate = 1 - workflowCompletionRate;
      const failureStepDistribution = [...failureStepCounts.entries()]
        .map(([stepIndex, count]) => ({ stepIndex, count }))
        .sort((a, b) => b.count - a.count || a.stepIndex - b.stepIndex)
        .slice(0, 5);
      const fragileTransitions = [...transitionFailingRunCounts.entries()]
        .map(([transition, failingRuns]) => {
          const totalRuns = transitionRunCounts.get(transition) || failingRuns;
          return {
            transition,
            failingRuns,
            totalRuns,
            failureRate: totalRuns > 0 ? failingRuns / totalRuns : 0,
          };
        })
        .filter((item) =>
          item.failingRuns >= MIN_FRAGILE_TRANSITION_FAILING_RUNS
          && item.failureRate - scenarioFailureRate >= FRAGILE_TRANSITION_FAILURE_DELTA)
        .sort((a, b) =>
          b.failureRate - a.failureRate
          || b.failingRuns - a.failingRuns
          || a.transition.localeCompare(b.transition))
        .slice(0, 3)
        .map((item) => ({
          transition: item.transition,
          failingRuns: item.failingRuns,
          totalRuns: item.totalRuns,
          failureRate: roundTo(item.failureRate, 2),
        }));
      const mostCommonPath = mostCommonStringKey(pathCounts);
      const mostCommonSuccessfulPath = mostCommonStringKey(successfulPathCounts);
      const mostCommonFailedPath = mostCommonStringKey(failedPathCounts);
      const mostCommonRecoveryPath = mostCommonStringKey(recoveryPathCounts);
      const toolBeforeRecovery = mostCommonStringKey(preRecoveryToolCounts);
      const postRecoveryContinuationPath = mostCommonStringKey(postRecoveryPathCounts);
      const mostCommonFailureStepIndex = mostCommonNumericKey(failureStepCounts);
      const mostCommonFailureTool = mostCommonStringKey(failureToolCounts);
      const mostCommonFailureSubsystem = mostCommonStringKey(failureSubsystemCounts) as CapabilitySubsystem | undefined;
      const repeatedFailureClusterCount = [...failureClusters.values()].filter((count) => count >= 2).length;
      const mostCommonSuccessfulTransition = mostCommonStringKey(successfulTransitionCounts);
      const mostCommonFailedTransition = mostCommonStringKey(failingTransitionCounts);

      return {
        scenario: buildScenarioDefinition(scenarioId),
        runCount: runs.length,
        completionRate: workflowCompletionRate,
        avgDurationMs: averageDurationMs,
        avgToolCalls: averageToolCalls,
        workflowCompletionRate,
        averageDurationMs,
        averageToolCalls,
        earlyFailureRate,
        lateFailureRate,
        interventionRate,
        approvalRate,
        recoveryRate,
        crossSubsystemCount,
        retryBurden,
        workflowEfficiencyScore,
        workflowCohesionScore,
        workflowConfidenceScore,
        mostCommonPath,
        mostCommonSuccessfulPath,
        mostCommonFailedPath,
        mostCommonRecoveryPath,
        mostCommonFailureStepIndex,
        mostCommonFailureTool,
        mostCommonFailureSubsystem,
        failureStepDistribution,
        fragileTransitions,
        repeatedFailureClusterCount,
        toolBeforeRecovery,
        postRecoveryContinuationPath,
        pathSummary: {
          mostCommonPath,
          mostCommonSuccessfulPath,
          mostCommonFailedPath,
        },
        failureLocalizationSummary: {
          mostCommonFailureStepIndex,
          mostCommonFailureTool,
          mostCommonFailureSubsystem,
          failureStepDistribution,
          repeatedFailureClusterCount,
        },
        transitionSummary: {
          mostCommonSuccessfulTransition,
          mostCommonFailedTransition,
          fragileTransitions,
        },
        recoveryPathSummary: {
          mostCommonRecoveryPath,
          toolBeforeRecovery,
          postRecoveryContinuationPath,
        },
        primaryFailureTools: sortCountMap(failureTools, 'toolName').slice(0, 3) as Array<{ toolName: string; count: number }>,
        primaryFailureSubsystems: sortCountMap(failureSubsystems, 'subsystem').slice(0, 3) as Array<{ subsystem: CapabilitySubsystem; count: number }>,
      };
    })
    .sort((a, b) => b.runCount - a.runCount || b.completionRate - a.completionRate || a.scenario.id.localeCompare(b.scenario.id));
}

function buildWorkflowSummary(scenarioSummaries: ScenarioSummary[]): WorkflowScoreSummary {
  const ranked = [...scenarioSummaries].sort((a, b) =>
    workflowCompositeScore(b) - workflowCompositeScore(a)
    || b.workflowConfidenceScore - a.workflowConfidenceScore
    || a.scenario.id.localeCompare(b.scenario.id));
  const frictionRanked = [...scenarioSummaries].sort((a, b) =>
    workflowFrictionScore(b) - workflowFrictionScore(a)
    || a.workflowEfficiencyScore - b.workflowEfficiencyScore
    || a.scenario.id.localeCompare(b.scenario.id));

  return {
    strongestWorkflows: ranked.slice(0, 3).map((scenario) => ({
      scenarioId: scenario.scenario.id,
      score: roundTo(workflowCompositeScore(scenario), 1),
      note: scenario.mostCommonPath
        ? `Eff ${scenario.workflowEfficiencyScore.toFixed(1)} / Coh ${scenario.workflowCohesionScore.toFixed(1)} | path ${scenario.mostCommonPath}`
        : `Eff ${scenario.workflowEfficiencyScore.toFixed(1)} / Coh ${scenario.workflowCohesionScore.toFixed(1)}`,
    })),
    weakestWorkflows: [...ranked].reverse().slice(0, 3).map((scenario) => ({
      scenarioId: scenario.scenario.id,
      score: roundTo(workflowCompositeScore(scenario), 1),
      note: scenario.fragileTransitions[0]
        ? `fragile ${scenario.fragileTransitions[0].transition}`
        : scenario.earlyFailureRate > scenario.lateFailureRate
          ? 'early failures dominate'
          : 'late-stage friction dominates',
    })),
    highestFrictionWorkflows: frictionRanked.slice(0, 3).map((scenario) => ({
      scenarioId: scenario.scenario.id,
      score: roundTo(workflowFrictionScore(scenario), 1),
      note: `${formatPercent(scenario.recoveryRate)} recovery, ${formatPercent(scenario.interventionRate)} intervention, retry ${scenario.retryBurden.toFixed(1)}`,
    })),
    sparseDataWarnings: scenarioSummaries
      .filter((scenario) => scenario.workflowConfidenceScore < 1)
      .slice(0, 3)
      .map((scenario) => `${scenario.scenario.id} has only ${scenario.runCount} run${scenario.runCount === 1 ? '' : 's'} in the recent window; workflow confidence remains limited.`),
  };
}

function buildHarnessLearningSummaries(
  recentRuns: RunRecord[],
  recentRunEvents: RunEventRecord[],
): HarnessLearningSummary[] {
  if (recentRuns.length === 0 || recentRunEvents.length === 0) return [];

  const runMeta = new Map(recentRuns.map((run) => [run.id, run]));
  const eventsByRun = new Map<string, RunEventRecord[]>();
  for (const event of recentRunEvents) {
    const group = eventsByRun.get(event.runId) || [];
    group.push(event);
    eventsByRun.set(event.runId, group);
  }

  type LearningAccumulator = {
    patternKey: string;
    harnessId: string;
    baseGoal: string;
    runIds: string[];
    completedRuns: number;
    successfulHarnesses: Map<string, number>;
    failingHarnesses: Map<string, number>;
    successfulStartingStrategies: Map<string, number>;
    failingStartingStrategies: Map<string, number>;
    repeatedGoalTightenings: Map<string, number>;
    repeatedStageStalls: Map<string, number>;
    repeatedFragileTransitions: Map<string, number>;
    repeatedFailingToolFamilies: Map<string, number>;
    browserOverGuiCount: number;
    lowShellDependenceCount: number;
    verifyBeforeWriteCount: number;
    safeChangeTighteningCount: number;
    recoveryConstrainedCount: number;
    verifyChangeStallCount: number;
    interventionWaitingCount: number;
  };

  const accumulators = new Map<string, LearningAccumulator>();
  const candidateRuns = [...recentRuns]
    .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
    .slice(0, LEARNING_RUN_WINDOW);

  for (const run of candidateRuns) {
    const events = (eventsByRun.get(run.id) || []).sort((a, b) => a.seq - b.seq);
    const resolved = [...events].reverse().find((event) => event.kind === 'harness_resolved');
    const summary = [...events].reverse().find((event) => event.kind === 'harness_run_summary');
    if (!resolved || !summary) continue;

    const harnessId = String(resolved.payload.harnessId || resolved.payload.baseHarnessId || '');
    const baseGoal = String(resolved.payload.baseGoal || '');
    if (!harnessId || !baseGoal) continue;
    const patternKey = `${harnessId}:${baseGoal}`;
    const acc = accumulators.get(patternKey) || {
      patternKey,
      harnessId,
      baseGoal,
      runIds: [],
      completedRuns: 0,
      successfulHarnesses: new Map<string, number>(),
      failingHarnesses: new Map<string, number>(),
      successfulStartingStrategies: new Map<string, number>(),
      failingStartingStrategies: new Map<string, number>(),
      repeatedGoalTightenings: new Map<string, number>(),
      repeatedStageStalls: new Map<string, number>(),
      repeatedFragileTransitions: new Map<string, number>(),
      repeatedFailingToolFamilies: new Map<string, number>(),
      browserOverGuiCount: 0,
      lowShellDependenceCount: 0,
      verifyBeforeWriteCount: 0,
      safeChangeTighteningCount: 0,
      recoveryConstrainedCount: 0,
      verifyChangeStallCount: 0,
      interventionWaitingCount: 0,
    };

    acc.runIds.push(run.id);
    const completed = run.status === 'completed' && summary.payload.completedWithResponse !== false;
    if (completed) {
      acc.completedRuns += 1;
      incrementCount(acc.successfulHarnesses, harnessId);
    } else {
      incrementCount(acc.failingHarnesses, harnessId);
    }

    const baseStrategy = String(resolved.payload.baseStrategy || '');
    if (baseStrategy) {
      incrementCount(completed ? acc.successfulStartingStrategies : acc.failingStartingStrategies, baseStrategy);
    }

    for (const adjustment of Array.isArray(summary.payload.goalAdjustmentIds) ? summary.payload.goalAdjustmentIds : []) {
      const id = String(adjustment);
      if (id.includes('safely_apply_change') || id.includes('safe_change') || id.includes('verify_state_change')) {
        acc.safeChangeTighteningCount += 1;
      }
    }

    for (const adjustment of Array.isArray(summary.payload.subGoalAdjustmentIds) ? summary.payload.subGoalAdjustmentIds : []) {
      const id = String(adjustment);
      if (id.includes('verify_change')) {
        acc.verifyChangeStallCount += 1;
        incrementCount(acc.repeatedStageStalls, 'verify_change');
      } else if (id.includes('verify_outcome')) {
        incrementCount(acc.repeatedStageStalls, 'verify_outcome');
      }
    }

    for (const event of events.filter((item) => item.kind === 'harness_in_loop_adjusted')) {
      const signal = event.payload.signal || {};
      const signalToolFamily = typeof signal.toolFamily === 'string' ? signal.toolFamily : undefined;
      const signalTransition = typeof signal.transition === 'string' ? signal.transition : undefined;
      const strategyShifts = Array.isArray(event.payload.strategyShifts) ? event.payload.strategyShifts : [];
      const goalAdjustments = Array.isArray(event.payload.goalAdjustments) ? event.payload.goalAdjustments : [];
      const subGoalAdjustments = Array.isArray(event.payload.subGoalAdjustments) ? event.payload.subGoalAdjustments : [];

      if (signalToolFamily && signal.success === false) {
        incrementCount(acc.repeatedFailingToolFamilies, signalToolFamily);
      }
      if (signalTransition) {
        incrementCount(acc.repeatedFragileTransitions, signalTransition);
      }

      for (const shift of strategyShifts) {
        const to = String(shift?.to || '');
        if (to === 'browser_over_gui') acc.browserOverGuiCount += 1;
        if (to === 'low_shell_dependence') acc.lowShellDependenceCount += 1;
        if (to === 'verify_before_write') acc.verifyBeforeWriteCount += 1;
        if (to === 'recovery_constrained') acc.recoveryConstrainedCount += 1;
        if (to === 'intervention_waiting') acc.interventionWaitingCount += 1;
      }

      for (const adjustment of goalAdjustments) {
        const to = String(adjustment?.to || '');
        if (to) incrementCount(acc.repeatedGoalTightenings, to);
        if (to === 'safely_apply_change' || to === 'verify_state_change') {
          acc.safeChangeTighteningCount += 1;
        }
      }

      for (const adjustment of subGoalAdjustments) {
        const from = String(adjustment?.from || '');
        const to = String(adjustment?.to || '');
        if (from && to && from === to) incrementCount(acc.repeatedStageStalls, to);
        if (to === 'verify_change') acc.verifyChangeStallCount += 1;
      }
    }

    accumulators.set(patternKey, acc);
  }

  return [...accumulators.values()]
    .map((acc) => {
      const sampleSize = acc.runIds.length;
      const confidence = buildLearningConfidence(sampleSize, LEARNING_RUN_WINDOW);
      const completionRate = sampleSize > 0 ? acc.completedRuns / sampleSize : 0;
      const optimizationHints: HarnessOptimizationHint[] = [];
      const evidenceSummary: string[] = [];

      const topSuccessfulStrategy = mostCommonStringKey(acc.successfulStartingStrategies);
      const topFailingStrategy = mostCommonStringKey(acc.failingStartingStrategies);
      const topFailingFamily = mostCommonStringKey(acc.repeatedFailingToolFamilies);
      const topFragileTransition = mostCommonStringKey(acc.repeatedFragileTransitions);
      const topGoalTightening = mostCommonStringKey(acc.repeatedGoalTightenings);
      const topStageStall = mostCommonStringKey(acc.repeatedStageStalls);

      if (sampleSize >= MIN_LEARNING_SAMPLE) {
        optimizationHints.push({
          id: 'prefer_harness_start',
          kind: 'prefer_harness_start',
          reason: `Recent ${acc.patternKey} runs have a ${formatPercent(completionRate)} completion rate across ${sampleSize} samples.`,
          effect: `Use ${acc.harnessId} as the preferred starting harness when this class matches and no stronger signal contradicts it.`,
          confidence,
          preferHarnessId: acc.harnessId,
        });
      }

      if (acc.browserOverGuiCount >= 2) {
        optimizationHints.push({
          id: 'prefer_browser_over_gui_start',
          kind: 'prefer_strategy_start',
          reason: 'Recent similar runs repeatedly shifted toward browser-over-GUI execution.',
          effect: 'Start closer to browser_over_gui and demote desktop paths earlier.',
          confidence,
          preferStrategy: 'browser_over_gui',
          demoteFamily: 'desktop',
        });
      }

      if (acc.lowShellDependenceCount >= 2) {
        optimizationHints.push({
          id: 'prefer_low_shell_dependence',
          kind: 'prefer_strategy_start',
          reason: 'Recent similar runs repeatedly shifted away from shell-heavy execution.',
          effect: 'Start with lower shell dependence and stronger filesystem-first caution.',
          confidence,
          preferStrategy: 'low_shell_dependence',
          demoteFamily: 'shell',
        });
      }

      if (acc.verifyBeforeWriteCount >= 2 || acc.safeChangeTighteningCount >= 2) {
        optimizationHints.push({
          id: 'prefer_verify_before_write',
          kind: 'tighten_goal_posture',
          reason: 'Recent similar runs repeatedly tightened toward safe-change verification posture.',
          effect: 'Start with stronger verify-before-write and safe-change caution.',
          confidence,
          preferStrategy: 'verify_before_write',
          preferGoal: 'safely_apply_change',
          retryGuidance: 'verify_before_retry',
        });
      }

      if (topFailingFamily && acc.repeatedFailingToolFamilies.get(topFailingFamily)! >= 2) {
        optimizationHints.push({
          id: `demote_family_${topFailingFamily}`,
          kind: 'demote_tool_family',
          reason: `Recent similar runs repeatedly failed in the ${topFailingFamily} family.`,
          effect: `Start with stronger caution around ${topFailingFamily} tools.`,
          confidence,
          demoteFamily: topFailingFamily,
        });
      }

      if (topStageStall && acc.repeatedStageStalls.get(topStageStall)! >= 2) {
        optimizationHints.push({
          id: `stage_caution_${topStageStall}`,
          kind: 'stage_caution',
          reason: `Recent similar runs repeatedly stalled at ${topStageStall}.`,
          effect: `Start with stronger verification/branching caution around ${topStageStall}.`,
          confidence,
          cautionSubGoal: topStageStall,
          branchingGuidance: 'narrow_path',
        });
      }

      if (topFragileTransition && acc.repeatedFragileTransitions.get(topFragileTransition)! >= 2) {
        optimizationHints.push({
          id: `transition_caution_${topFragileTransition.replace(/\s+/g, '_')}`,
          kind: 'transition_caution',
          reason: `Recent similar runs repeatedly struggled on ${topFragileTransition}.`,
          effect: `Start with explicit boundary caution for ${topFragileTransition}.`,
          confidence,
          cautionTransition: topFragileTransition,
          retryGuidance: 'verify_before_retry',
        });
      }

      if (acc.recoveryConstrainedCount >= 2) {
        optimizationHints.push({
          id: 'prefer_recovery_constrained',
          kind: 'prefer_retry_guidance',
          reason: 'Recent similar runs improved after narrowing under recovery pressure.',
          effect: 'Start with narrower retry behavior and earlier verification before retry.',
          confidence,
          retryGuidance: 'verify_before_retry',
          branchingGuidance: 'narrow_path',
        });
      }

      if (confidence.sparse) {
        evidenceSummary.push(`Only ${sampleSize} recent run${sampleSize === 1 ? '' : 's'} matched ${acc.patternKey}; learning stayed advisory.`);
      } else {
        evidenceSummary.push(`${acc.patternKey} completed ${acc.completedRuns}/${sampleSize} recent runs.`);
      }
      if (topSuccessfulStrategy) evidenceSummary.push(`Best recent starting strategy: ${topSuccessfulStrategy}.`);
      if (topFailingStrategy) evidenceSummary.push(`Weakest recent starting strategy: ${topFailingStrategy}.`);
      if (topGoalTightening) evidenceSummary.push(`Frequent goal tightening: ${topGoalTightening}.`);
      if (topStageStall) evidenceSummary.push(`Repeated stage stall: ${topStageStall}.`);

      return {
        patternKey: acc.patternKey,
        harnessId: acc.harnessId,
        baseGoal: acc.baseGoal,
        sampleSize,
        completionRate: roundTo(completionRate, 2),
        successfulHarnesses: sortCountMap(acc.successfulHarnesses, 'harnessId') as Array<{ harnessId: string; count: number }>,
        failingHarnesses: sortCountMap(acc.failingHarnesses, 'harnessId') as Array<{ harnessId: string; count: number }>,
        successfulStartingStrategies: sortCountMap(acc.successfulStartingStrategies, 'strategy') as Array<{ strategy: string; count: number }>,
        failingStartingStrategies: sortCountMap(acc.failingStartingStrategies, 'strategy') as Array<{ strategy: string; count: number }>,
        repeatedGoalTightenings: sortCountMap(acc.repeatedGoalTightenings, 'goal') as Array<{ goal: string; count: number }>,
        repeatedStageStalls: sortCountMap(acc.repeatedStageStalls, 'subGoal') as Array<{ subGoal: string; count: number }>,
        repeatedFragileTransitions: sortCountMap(acc.repeatedFragileTransitions, 'transition') as Array<{ transition: string; count: number }>,
        repeatedFailingToolFamilies: sortCountMap(acc.repeatedFailingToolFamilies, 'family') as Array<{ family: string; count: number }>,
        optimizationHints: optimizationHints
          .filter((hint) => hint.confidence.score >= 0.5 || hint.confidence.sparse === false)
          .slice(0, MAX_LEARNING_HINTS),
        evidenceSummary: evidenceSummary.slice(0, 4),
        confidence,
      };
    })
    .sort((a, b) =>
      b.confidence.score - a.confidence.score
      || b.sampleSize - a.sampleSize
      || b.completionRate - a.completionRate
      || a.patternKey.localeCompare(b.patternKey));
}

function buildLearningConfidence(sampleSize: number, recentWindowSize: number): LearningConfidence {
  const score = roundTo(clamp(sampleSize / Math.max(MIN_LEARNING_SAMPLE + 2, 1), 0, 1), 2);
  return {
    score,
    sampleSize,
    recentWindowSize,
    sparse: sampleSize < MIN_LEARNING_SAMPLE,
  };
}

function buildOverallScore(categorySummaries: CapabilityCategorySummary[]): number {
  if (categorySummaries.length === 0) return 0;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const category of categorySummaries) {
    const weight = weightForCategory(category.category);
    const categoryComposite = average([
      category.functionalityScore,
      category.reliabilityScore,
      category.uxScore,
      category.completenessScore,
    ]);
    weightedSum += categoryComposite * weight;
    weightTotal += weight;
  }
  return roundTo(weightedSum / Math.max(weightTotal, 1), 1);
}

function buildPlanningCapability(): CapabilityHealthSignal {
  const status: CapabilityStatus = EXECUTION_PLANNING_ENABLED ? 'unproven' : 'disabled';
  const note = EXECUTION_PLANNING_ENABLED
    ? 'Planning telemetry is not exercised in the recent window.'
    : 'Static runtime constraint disables planning.';
  return {
    subsystem: 'planning',
    category: SUBSYSTEM_CATEGORY_MAP.planning,
    status,
    declaredAvailable: true,
    observedRecently: false,
    sampleSize: 0,
    degraded: false,
    disabledStaticConstraint: !EXECUTION_PLANNING_ENABLED,
    functionalityScore: EXECUTION_PLANNING_ENABLED ? 3 : 0,
    reliabilityScore: EXECUTION_PLANNING_ENABLED ? 4 : 0,
    uxScore: EXECUTION_PLANNING_ENABLED ? 5 : 0,
    completenessScore: EXECUTION_PLANNING_ENABLED ? 4 : 0,
    confidenceScore: EXECUTION_PLANNING_ENABLED ? 0 : 1,
    note,
  };
}

function classifyCapability(
  subsystem: CapabilitySubsystem,
  observation: CapabilityObservation,
  opts?: { degradedOverride?: boolean; note?: string },
): CapabilityHealthSignal {
  const successRate = observation.sampleSize > 0
    ? observation.successCount / observation.sampleSize
    : undefined;

  let status: CapabilityStatus;
  let note = opts?.note;

  if (observation.sampleSize === 0) {
    status = 'unproven';
    note = note || 'Not exercised in the recent window.';
  } else if (observation.sampleSize < MIN_SUBSYSTEM_SAMPLE) {
    status = 'unproven';
    note = note || 'Recent sample is too small to trust.';
  } else if (opts?.degradedOverride || (successRate ?? 0) < DEGRADED_SUCCESS_RATE) {
    status = 'degraded';
    note = note || `Recent success rate is ${formatPercent(successRate ?? 0)}.`;
  } else {
    status = 'healthy';
    if (!note && successRate !== undefined && successRate >= HEALTHY_SUCCESS_RATE) {
      note = `Recent success rate is ${formatPercent(successRate)}.`;
    }
  }

  const scores = deriveCapabilityScores(status, observation);
  return {
    subsystem,
    category: SUBSYSTEM_CATEGORY_MAP[subsystem],
    status,
    declaredAvailable: true,
    observedRecently: observation.sampleSize > 0,
    successRateRecent: successRate,
    sampleSize: observation.sampleSize,
    degraded: status === 'degraded',
    disabledStaticConstraint: false,
    functionalityScore: scores.functionalityScore,
    reliabilityScore: scores.reliabilityScore,
    uxScore: scores.uxScore,
    completenessScore: scores.completenessScore,
    confidenceScore: scores.confidenceScore,
    note,
  };
}

function deriveCapabilityScores(
  status: CapabilityStatus,
  observation: CapabilityObservation,
): Pick<CapabilityHealthSignal, 'functionalityScore' | 'reliabilityScore' | 'uxScore' | 'completenessScore' | 'confidenceScore'> {
  const successRate = observation.sampleSize > 0
    ? observation.successCount / observation.sampleSize
    : 0;
  const failureRate = observation.sampleSize > 0
    ? observation.failureCount / observation.sampleSize
    : 0;
  const recoveryRate = observation.sampleSize > 0
    ? observation.recoveryCount / observation.sampleSize
    : 0;
  const approvalRate = observation.sampleSize > 0
    ? observation.approvalCount / observation.sampleSize
    : 0;
  const interventionRate = observation.sampleSize > 0
    ? observation.interventionCount / observation.sampleSize
    : 0;

  const confidenceScore = roundTo(
    clamp(observation.sampleSize / MIN_CONFIDENCE_SAMPLE, 0, 1),
    2,
  );

  if (status === 'disabled') {
    return {
      functionalityScore: 0,
      reliabilityScore: 0,
      uxScore: 0,
      completenessScore: 0,
      confidenceScore: 1,
    };
  }

  let reliabilityScore = observation.sampleSize > 0 ? successRate * 10 : 4;
  if (observation.recoveryCount >= RECOVERY_HEAVY_THRESHOLD) reliabilityScore -= 1;
  if (status === 'degraded') reliabilityScore = Math.min(reliabilityScore, 5.8);
  if (status === 'unproven') reliabilityScore = Math.min(reliabilityScore, 4.8);

  let functionalityScore = observation.sampleSize > 0 ? 4 + successRate * 6 : 3.5;
  if (status === 'degraded') functionalityScore = Math.min(functionalityScore, 6);
  if (status === 'unproven') functionalityScore = Math.min(functionalityScore, 5);

  let uxScore = observation.sampleSize > 0
    ? 10 - failureRate * 4 - interventionRate * 3 - approvalRate * 1.5 - recoveryRate * 2
    : 5;
  if (status === 'degraded') uxScore = Math.min(uxScore, 6.4);
  if (status === 'unproven') uxScore = Math.min(uxScore, 5.5);

  let completenessScore = 5 + (observation.sampleSize > 0 ? 2 : 0) + (status === 'healthy' ? 2 : 0);
  if (status === 'degraded') completenessScore = Math.min(completenessScore, 5.5);
  if (status === 'unproven') completenessScore = Math.min(completenessScore, 4.5);

  return {
    functionalityScore: roundTo(clamp(functionalityScore, 0, 10), 1),
    reliabilityScore: roundTo(clamp(reliabilityScore, 0, 10), 1),
    uxScore: roundTo(clamp(uxScore, 0, 10), 1),
    completenessScore: roundTo(clamp(completenessScore, 0, 10), 1),
    confidenceScore,
  };
}

function toObservation(rows: AuditToolTelemetryRecord[]): CapabilityObservation {
  return {
    sampleSize: rows.length,
    successCount: rows.filter((row) => row.success).length,
    failureCount: rows.filter((row) => !row.success).length,
    recoveryCount: countRows(rows, (row) => row.recoveryInvoked),
    approvalCount: countRows(rows, (row) => row.approvalRequired),
    interventionCount: countRows(rows, (row) => row.interventionTriggered),
    resolvedInterventionCount: countRows(rows, (row) => row.interventionResolved),
  };
}

function groupRowsByTool(
  rows: AuditToolTelemetryRecord[],
  predicate: (row: AuditToolTelemetryRecord) => boolean,
): Array<{ toolName: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!predicate(row)) continue;
    counts.set(row.toolName, (counts.get(row.toolName) || 0) + 1);
  }
  return sortCountMap(counts, 'toolName') as Array<{ toolName: string; count: number }>;
}

function countRows(rows: AuditToolTelemetryRecord[], predicate: (row: AuditToolTelemetryRecord) => boolean): number {
  return rows.reduce((count, row) => count + (predicate(row) ? 1 : 0), 0);
}

function isRelativelyDegraded(
  candidate: CategoryReliabilityMetric | undefined,
  alternative: CategoryReliabilityMetric | undefined,
): boolean {
  if (!candidate || !alternative) return false;
  if (candidate.callCount < MIN_RELATIVE_COMPARISON_SAMPLE || alternative.callCount < MIN_RELATIVE_COMPARISON_SAMPLE) return false;
  return alternative.successRate - candidate.successRate >= RELATIVE_ADVANTAGE_DELTA;
}

function buildScenarioDefinition(id: string): ScenarioDefinition {
  const tags = id.split(/[_-]+/).filter(Boolean).slice(0, 5);
  return {
    id,
    name: tags.length > 0 ? tags.map(capitalize).join(' ') : id,
    description: `Recent runs tagged with scenario "${id}".`,
    tags,
  };
}

function incrementCount<T extends string | number>(counts: Map<T, number>, key: T): void {
  counts.set(key, (counts.get(key) || 0) + 1);
}

function mostCommonStringKey<T extends string>(counts: Map<T, number>): T | undefined {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
}

function mostCommonNumericKey(counts: Map<number, number>): number | undefined {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
}

function sortRunRows(rows: AuditToolTelemetryRecord[]): AuditToolTelemetryRecord[] {
  return [...rows].sort((a, b) =>
    a.iterationIndex - b.iterationIndex
    || a.timestamp.localeCompare(b.timestamp)
    || a.id - b.id);
}

function buildPathSignature(rows: AuditToolTelemetryRecord[]): string {
  if (rows.length === 0) return '';
  return rows.map((row) => row.toolName).join(' -> ');
}

function buildTransitionSignatures(rows: AuditToolTelemetryRecord[]): string[] {
  const transitions: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const transition = buildTransitionSignature(rows[i - 1], rows[i]);
    if (transition) transitions.push(transition);
  }
  return transitions;
}

function buildTransitionSignature(
  previous: AuditToolTelemetryRecord | undefined,
  next: AuditToolTelemetryRecord | undefined,
): string | undefined {
  if (!previous || !next) return undefined;
  const previousSubsystem = inferSubsystemFromRow(previous);
  const nextSubsystem = inferSubsystemFromRow(next);
  if (!previousSubsystem || !nextSubsystem) return undefined;
  return `${formatCompactSubsystemLabel(previousSubsystem)} -> ${formatCompactSubsystemLabel(nextSubsystem)}`;
}

function analyzeRunWorkflow(run: RunRecord, rows: AuditToolTelemetryRecord[]): RunWorkflowMetrics {
  const failureCounts = new Map<string, number>();
  const subsystemSet = new Set<CapabilitySubsystem>();
  const transitionSignatures = buildTransitionSignatures(rows);
  const pathSignature = buildPathSignature(rows);
  const totalSteps = Math.max(rows.length, run.toolCallCount, 1);
  const firstFailureIndex = rows.findIndex((row) => !row.success);
  const successCountBeforeFailure = firstFailureIndex > 0
    ? rows.slice(0, firstFailureIndex).filter((row) => row.success).length
    : 0;
  const recoveryIndex = rows.findIndex((row) => row.recoveryInvoked);
  const firstFailureRow = firstFailureIndex >= 0 ? rows[firstFailureIndex] : undefined;

  for (const row of rows) {
    const subsystem = inferSubsystemFromRow(row);
    if (subsystem) subsystemSet.add(subsystem);
    if (!row.success) {
      failureCounts.set(row.toolName, (failureCounts.get(row.toolName) || 0) + 1);
    }
  }

  const repeatedFailures = [...failureCounts.values()].reduce((sum, count) => sum + Math.max(count - 1, 0), 0);
  const progressBeforeFailure = firstFailureIndex <= 0 ? 0 : firstFailureIndex / totalSteps;
  const failed = run.status !== 'completed' && firstFailureIndex >= 0;
  const failedEarly = failed && (progressBeforeFailure < EARLY_FAILURE_PROGRESS_THRESHOLD || successCountBeforeFailure === 0 || totalSteps <= 2);
  const failedLate = failed && !failedEarly;

  return {
    toolCallCount: totalSteps,
    subsystemCount: subsystemSet.size,
    recoveryCount: countRows(rows, (row) => row.recoveryInvoked),
    intervention: rows.some((row) => row.interventionTriggered),
    approval: rows.some((row) => row.approvalRequired),
    failedEarly,
    failedLate,
    retryBurden: countRows(rows, (row) => row.recoveryInvoked) + repeatedFailures,
    pathSignature,
    transitionSignatures,
    firstFailureStepIndex: firstFailureIndex >= 0 ? firstFailureIndex + 1 : undefined,
    firstFailureTool: firstFailureRow?.toolName,
    firstFailureSubsystem: firstFailureRow ? inferSubsystemFromRow(firstFailureRow) || undefined : undefined,
    failingTransition: firstFailureIndex > 0 ? buildTransitionSignature(rows[firstFailureIndex - 1], rows[firstFailureIndex]) : undefined,
    recoveryPathSignature: recoveryIndex >= 0 ? buildPathSignature(rows.slice(0, recoveryIndex + 1)) : undefined,
    toolBeforeRecovery: recoveryIndex > 0 ? rows[recoveryIndex - 1]?.toolName : undefined,
    postRecoveryContinuationPath: recoveryIndex >= 0 ? buildPathSignature(rows.slice(recoveryIndex)) : undefined,
  };
}

function deriveWorkflowEfficiencyScore(input: {
  workflowCompletionRate: number;
  averageDurationMs: number;
  averageToolCalls: number;
  recoveryRate: number;
  interventionRate: number;
  approvalRate: number;
  retryBurden: number;
}): number {
  const toolDiscipline = input.averageToolCalls <= REASONABLE_TOOL_CALL_TARGET
    ? 1
    : input.averageToolCalls >= HEAVY_TOOL_CALL_THRESHOLD
      ? 0
      : 1 - ((input.averageToolCalls - REASONABLE_TOOL_CALL_TARGET) / (HEAVY_TOOL_CALL_THRESHOLD - REASONABLE_TOOL_CALL_TARGET));
  const frictionPenalty = clamp(
    input.recoveryRate + input.interventionRate + (input.approvalRate * 0.5) + (input.retryBurden / RETRY_BURDEN_NORMALIZER),
    0,
    2,
  );
  const durationDiscipline = input.averageDurationMs <= FAST_WORKFLOW_DURATION_MS
    ? 1
    : input.averageDurationMs >= SLOW_WORKFLOW_DURATION_MS
      ? 0
      : 1 - ((input.averageDurationMs - FAST_WORKFLOW_DURATION_MS) / (SLOW_WORKFLOW_DURATION_MS - FAST_WORKFLOW_DURATION_MS));
  const score = (input.workflowCompletionRate * 5.5) + (toolDiscipline * 2) + clamp(1.5 - frictionPenalty, 0, 1.5) + durationDiscipline;
  return roundTo(clamp(score, 0, 10), 1);
}

function deriveWorkflowCohesionScore(input: {
  workflowCompletionRate: number;
  crossSubsystemCount: number;
  earlyFailureRate: number;
  lateFailureRate: number;
  retryBurden: number;
}): number {
  const transitionQuality = input.crossSubsystemCount >= 2 ? 1 : input.crossSubsystemCount >= 1 ? 0.7 : 0.4;
  const breakdownPenalty = clamp(
    (input.earlyFailureRate * 1.5) + input.lateFailureRate + (input.retryBurden / (RETRY_BURDEN_NORMALIZER * 2)),
    0,
    2,
  );
  const score = (input.workflowCompletionRate * 5) + (transitionQuality * 3) + clamp(2 - breakdownPenalty, 0, 2);
  return roundTo(clamp(score, 0, 10), 1);
}

function workflowCompositeScore(scenario: ScenarioSummary): number {
  return average([
    scenario.workflowEfficiencyScore,
    scenario.workflowCohesionScore,
  ]);
}

function workflowFrictionScore(scenario: ScenarioSummary): number {
  return roundTo(
    (scenario.recoveryRate * 4)
    + (scenario.interventionRate * 3)
    + (scenario.approvalRate * 2)
    + scenario.retryBurden
    + (scenario.earlyFailureRate * 2),
    1,
  );
}

function inferSubsystemFromRow(row: AuditToolTelemetryRecord): CapabilitySubsystem | null {
  if (row.interventionTriggered) return 'human_intervention_flow';
  if (row.recoveryInvoked) return 'recovery_path';
  if (row.subAgentSpawned || row.toolName === 'agent_spawn') return 'sub_agent_swarm';

  switch (row.toolCategory) {
    case 'browser': return 'browser_automation';
    case 'desktop': return 'gui_automation';
    case 'shell': return 'shell_cli';
    case 'filesystem': return 'filesystem';
    default: return null;
  }
}

function deriveWorstStatus(statuses: CapabilityStatus[]): CapabilityStatus {
  const severity: Record<CapabilityStatus, number> = {
    healthy: 0,
    unproven: 1,
    degraded: 2,
    disabled: 3,
  };
  return [...statuses].sort((a, b) => severity[b] - severity[a])[0] || 'unproven';
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return roundTo(values.reduce((sum, value) => sum + value, 0) / values.length, 1);
}

function weightForCategory(category: CapabilityCategory): number {
  return CATEGORY_WEIGHTS[category] || 0;
}

function sortCountMap<T extends string, K extends string>(
  counts: Map<T, number>,
  labelKey: K,
): Array<Record<K, T> & { count: number }> {
  return [...counts.entries()]
    .map(([label, count]) => ({ [labelKey]: label, count } as Record<K, T> & { count: number }))
    .sort((a, b) => Number(b.count) - Number(a.count) || String(a[labelKey]).localeCompare(String(b[labelKey])));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function formatSubsystemLabel(subsystem: CapabilitySubsystem): string {
  switch (subsystem) {
    case 'planning': return 'Planning';
    case 'browser_automation': return 'Browser automation';
    case 'gui_automation': return 'GUI automation';
    case 'shell_cli': return 'Shell/CLI execution';
    case 'filesystem': return 'Filesystem operations';
    case 'human_intervention_flow': return 'Human intervention flow';
    case 'recovery_path': return 'Recovery path';
    case 'sub_agent_swarm': return 'Sub-agent swarm';
  }
}

function formatCompactSubsystemLabel(subsystem: CapabilitySubsystem): string {
  switch (subsystem) {
    case 'planning': return 'planning';
    case 'browser_automation': return 'browser';
    case 'gui_automation': return 'gui';
    case 'shell_cli': return 'shell';
    case 'filesystem': return 'filesystem';
    case 'human_intervention_flow': return 'interaction';
    case 'recovery_path': return 'recovery';
    case 'sub_agent_swarm': return 'swarm';
  }
}

function formatFailureFocus(scenario: ScenarioSummary): string {
  const step = scenario.mostCommonFailureStepIndex ? `#${scenario.mostCommonFailureStepIndex}` : 'n/a';
  const tool = scenario.mostCommonFailureTool || 'n/a';
  const fragile = scenario.fragileTransitions[0]?.transition;
  const cluster = scenario.repeatedFailureClusterCount > 0 ? `, clusters ${scenario.repeatedFailureClusterCount}` : '';
  return `${step} ${tool}${fragile ? `, fragile ${fragile}` : ''}${cluster}`;
}

function formatCapabilityCategoryLabel(category: CapabilityCategory): string {
  switch (category) {
    case 'browser': return 'Browser';
    case 'gui': return 'GUI';
    case 'shell': return 'Shell';
    case 'filesystem': return 'Filesystem';
    case 'interaction': return 'Interaction';
    case 'reliability': return 'Reliability';
    case 'autonomy': return 'Autonomy';
    case 'planning': return 'Planning';
  }
}

function formatToolMetric(metric: ToolAuditMetric): string {
  return `${metric.toolName} (${metric.successCount}/${metric.callCount}, ${metric.avgDurationMs}ms avg)`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${roundTo(durationMs / 1000, 1)}s`;
  return `${Math.round(durationMs / 1000)}s`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
