import { describe, expect, it } from 'vitest';
import {
  formatCapabilityScorecardText,
  formatSystemAwarenessBlock,
  summarizeRecentTelemetry,
  type CapabilityHealthSignal,
} from '../../src/main/agent/system-audit';
import type { AuditToolTelemetryRecord } from '../../src/main/db/audit-tool-telemetry';
import type { RunRecord } from '../../src/main/db/runs';
import type { RunEventRecord } from '../../src/main/db/run-events';

function makeRow(overrides: Partial<AuditToolTelemetryRecord>): AuditToolTelemetryRecord {
  return {
    id: overrides.id ?? 1,
    runId: overrides.runId ?? 'run-1',
    timestamp: overrides.timestamp ?? '2026-03-24T12:00:00.000Z',
    iterationIndex: overrides.iterationIndex ?? 0,
    toolName: overrides.toolName ?? 'browser_read_page',
    toolCategory: overrides.toolCategory,
    success: overrides.success ?? true,
    durationMs: overrides.durationMs ?? 100,
    errorType: overrides.errorType,
    approvalRequired: overrides.approvalRequired ?? false,
    recoveryInvoked: overrides.recoveryInvoked ?? false,
    interventionTriggered: overrides.interventionTriggered ?? false,
    interventionResolved: overrides.interventionResolved ?? false,
    subAgentSpawned: overrides.subAgentSpawned ?? false,
    loopOutcome: overrides.loopOutcome,
  };
}

function getCapability(summary: { capabilityHealth: CapabilityHealthSignal[] }, subsystem: CapabilityHealthSignal['subsystem']): CapabilityHealthSignal {
  const signal = summary.capabilityHealth.find((entry) => entry.subsystem === subsystem);
  if (!signal) throw new Error(`Missing capability signal for ${subsystem}`);
  return signal;
}

function makeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: overrides.id ?? 'run-1',
    conversationId: overrides.conversationId ?? 'conv-1',
    title: overrides.title ?? 'Scenario run',
    goal: overrides.goal ?? 'Exercise scenario',
    scenarioId: overrides.scenarioId,
    status: overrides.status ?? 'completed',
    startedAt: overrides.startedAt ?? 0,
    updatedAt: overrides.updatedAt ?? 10_000,
    completedAt: overrides.completedAt ?? 10_000,
    toolCallCount: overrides.toolCallCount ?? 3,
    error: overrides.error,
    wasDetached: overrides.wasDetached ?? false,
    provider: overrides.provider,
    model: overrides.model,
    workflowStage: overrides.workflowStage ?? 'starting',
  };
}

function makeEvent(overrides: Partial<RunEventRecord>): RunEventRecord {
  return {
    id: overrides.id ?? 1,
    runId: overrides.runId ?? 'run-1',
    seq: overrides.seq ?? 1,
    timestamp: overrides.timestamp ?? '2026-03-24T12:00:00.000Z',
    kind: overrides.kind ?? 'harness_resolved',
    phase: overrides.phase,
    surface: overrides.surface,
    toolName: overrides.toolName,
    payload: overrides.payload ?? {},
  };
}

describe('system audit capability scorecard v1.1', () => {
  it('classifies degraded GUI and emits browser preference guidance', () => {
    const rows: AuditToolTelemetryRecord[] = [
      makeRow({ runId: 'run-a', toolName: 'browser_read_page', toolCategory: 'browser', success: true, durationMs: 800 }),
      makeRow({ id: 2, runId: 'run-a', toolName: 'browser_click', toolCategory: 'browser', success: true, durationMs: 500 }),
      makeRow({ id: 3, runId: 'run-a', toolName: 'browser_extract', toolCategory: 'browser', success: true, durationMs: 650 }),
      makeRow({ id: 4, runId: 'run-b', toolName: 'gui_interact', toolCategory: 'desktop', success: false, durationMs: 2200, errorType: 'error', recoveryInvoked: true }),
      makeRow({ id: 5, runId: 'run-b', toolName: 'gui_interact', toolCategory: 'desktop', success: false, durationMs: 2100, errorType: 'timeout', recoveryInvoked: true }),
      makeRow({ id: 6, runId: 'run-b', toolName: 'app_control', toolCategory: 'desktop', success: true, durationMs: 900 }),
    ];

    const summary = summarizeRecentTelemetry(rows);
    const gui = getCapability(summary, 'gui_automation');
    const browser = getCapability(summary, 'browser_automation');
    expect(gui.status).toBe('degraded');
    expect(gui.reliabilityScore).toBeLessThan(browser.reliabilityScore);
    expect(gui.functionalityScore).toBeLessThan(browser.functionalityScore);
    expect(summary.recoveryHeavyTools).toEqual([{ toolName: 'gui_interact', count: 2 }]);
    expect(summary.autoTuningHints.some((hint) => hint.kind === 'prefer_browser_over_gui')).toBe(true);
    expect(summary.capabilityCategories.find((category) => category.category === 'gui')?.status).toBe('degraded');
    expect(summary.overallScore).toBeGreaterThan(0);

    const block = formatSystemAwarenessBlock(summary);
    expect(block).toContain('[SYSTEM AWARENESS]');
    expect(block).toContain('GUI automation is degraded');
    expect(block).toContain('Recovery has been invoked repeatedly for: gui_interact x2.');
    expect(block).toContain('Prefer browser tools over GUI tools when both can accomplish the task.');
  });

  it('guards against degrading a subsystem on tiny samples', () => {
    const rows: AuditToolTelemetryRecord[] = [
      makeRow({ toolName: 'gui_interact', toolCategory: 'desktop', success: false, durationMs: 1800, errorType: 'error' }),
      makeRow({ id: 2, toolName: 'browser_click', toolCategory: 'browser', success: true, durationMs: 400 }),
    ];

    const summary = summarizeRecentTelemetry(rows);
    const gui = getCapability(summary, 'gui_automation');
    expect(gui.status).toBe('unproven');
    expect(gui.confidenceScore).toBeLessThan(0.5);

    const block = formatSystemAwarenessBlock(summary);
    expect(block).not.toContain('GUI automation is degraded');
  });

  it('tracks human intervention and sub-agent drift signals deterministically', () => {
    const rows: AuditToolTelemetryRecord[] = [
      makeRow({ toolName: 'browser_click', toolCategory: 'browser', success: true, interventionTriggered: true, interventionResolved: true }),
      makeRow({ id: 2, toolName: 'browser_click', toolCategory: 'browser', success: true, interventionTriggered: true, interventionResolved: false }),
      makeRow({ id: 3, toolName: 'agent_spawn', success: false, subAgentSpawned: true, durationMs: 1200, errorType: 'error' }),
      makeRow({ id: 4, toolName: 'agent_spawn', success: true, subAgentSpawned: true, durationMs: 900 }),
    ];

    const summary = summarizeRecentTelemetry(rows);
    expect(summary.interventionObservedRecently).toBe(true);
    expect(summary.interventionResolvedRecently).toBe(true);
    expect(summary.subAgentSpawnObservedRecently).toBe(true);
    expect(getCapability(summary, 'human_intervention_flow').status).toBe('unproven');
    expect(getCapability(summary, 'sub_agent_swarm').status).toBe('unproven');
  });

  it('warns to chunk shell commands after repeated timeout-heavy shell telemetry', () => {
    const rows: AuditToolTelemetryRecord[] = [
      makeRow({ toolName: 'shell_exec', toolCategory: 'shell', success: false, durationMs: 30_000, errorType: 'timeout' }),
      makeRow({ id: 2, toolName: 'shell_exec', toolCategory: 'shell', success: false, durationMs: 30_000, errorType: 'timeout' }),
      makeRow({ id: 3, toolName: 'shell_exec', toolCategory: 'shell', success: true, durationMs: 700 }),
    ];

    const summary = summarizeRecentTelemetry(rows);
    expect(getCapability(summary, 'shell_cli').status).toBe('degraded');
    expect(summary.autoTuningHints.some((hint) => hint.kind === 'chunk_shell_commands')).toBe(true);

    const block = formatSystemAwarenessBlock(summary);
    expect(block).toContain('Break shell work into shorter commands and verify progress incrementally.');
  });

  it('degrades cleanly when telemetry is sparse', () => {
    const summary = summarizeRecentTelemetry([]);
    const block = formatSystemAwarenessBlock(summary);
    expect(block).toContain('[SYSTEM AWARENESS]');
    expect(block).toContain('Recent telemetry is sparse; no runtime reliability ranking or drift signal is available yet.');
  });

  it('aggregates scenario summaries from recent runs and tool telemetry', () => {
    const rows: AuditToolTelemetryRecord[] = [
      makeRow({ runId: 'run-a', toolName: 'browser_read_page', toolCategory: 'browser', success: true, durationMs: 800 }),
      makeRow({ id: 2, runId: 'run-a', toolName: 'fs_write_file', toolCategory: 'filesystem', success: true, durationMs: 120 }),
      makeRow({ id: 3, runId: 'run-b', toolName: 'browser_click', toolCategory: 'browser', success: false, durationMs: 1_000, interventionTriggered: true }),
      makeRow({ id: 4, runId: 'run-b', toolName: 'gui_click', toolCategory: 'desktop', success: false, durationMs: 1_200, recoveryInvoked: true }),
      makeRow({ id: 5, runId: 'run-c', toolName: 'shell_exec', toolCategory: 'shell', success: true, durationMs: 400, approvalRequired: true }),
    ];
    const runs: RunRecord[] = [
      makeRun({ id: 'run-a', scenarioId: 'browser_extract_and_save', status: 'completed', startedAt: 0, completedAt: 90_000, updatedAt: 90_000, toolCallCount: 2 }),
      makeRun({ id: 'run-b', scenarioId: 'browser_extract_and_save', status: 'failed', startedAt: 0, completedAt: 120_000, updatedAt: 120_000, toolCallCount: 2 }),
      makeRun({ id: 'run-c', scenarioId: 'shell_validate', status: 'completed', startedAt: 0, completedAt: 30_000, updatedAt: 30_000, toolCallCount: 1 }),
    ];

    const summary = summarizeRecentTelemetry(rows, runs, rows);
    const browserScenario = summary.scenarioSummaries.find((scenario) => scenario.scenario.id === 'browser_extract_and_save');
    expect(browserScenario).toBeDefined();
    expect(browserScenario?.runCount).toBe(2);
    expect(browserScenario?.completionRate).toBe(0.5);
    expect(browserScenario?.workflowCompletionRate).toBe(0.5);
    expect(browserScenario?.avgToolCalls).toBe(2);
    expect(browserScenario?.averageToolCalls).toBe(2);
    expect(browserScenario?.interventionRate).toBe(0.5);
    expect(browserScenario?.recoveryRate).toBe(0.5);
    expect(browserScenario?.lateFailureRate).toBe(0);
    expect(browserScenario?.earlyFailureRate).toBe(0.5);
    expect(browserScenario?.crossSubsystemCount).toBe(2);
    expect(browserScenario?.workflowEfficiencyScore).toBeGreaterThan(0);
    expect(browserScenario?.workflowCohesionScore).toBeGreaterThan(0);
    expect(browserScenario?.primaryFailureTools[0]).toEqual({ toolName: 'browser_click', count: 1 });
  });

  it('classifies early and late workflow failures deterministically', () => {
    const rows: AuditToolTelemetryRecord[] = [
      makeRow({ runId: 'run-early', toolName: 'shell_exec', toolCategory: 'shell', success: false, durationMs: 100, errorType: 'error' }),
      makeRow({ id: 2, runId: 'run-late', toolName: 'shell_exec', toolCategory: 'shell', success: true, durationMs: 100 }),
      makeRow({ id: 3, runId: 'run-late', toolName: 'fs_read_file', toolCategory: 'filesystem', success: true, durationMs: 50 }),
      makeRow({ id: 4, runId: 'run-late', toolName: 'shell_exec', toolCategory: 'shell', success: false, durationMs: 120, errorType: 'error' }),
    ];
    const runs: RunRecord[] = [
      makeRun({ id: 'run-early', scenarioId: 'workflow_quality_check', status: 'failed', startedAt: 0, completedAt: 1_000, updatedAt: 1_000, toolCallCount: 1 }),
      makeRun({ id: 'run-late', scenarioId: 'workflow_quality_check', status: 'failed', startedAt: 0, completedAt: 3_000, updatedAt: 3_000, toolCallCount: 3 }),
    ];

    const summary = summarizeRecentTelemetry(rows, runs, rows);
    const scenario = summary.scenarioSummaries.find((entry) => entry.scenario.id === 'workflow_quality_check');
    expect(scenario).toBeDefined();
    expect(scenario?.earlyFailureRate).toBe(0.5);
    expect(scenario?.lateFailureRate).toBe(0.5);
    expect(scenario?.workflowCohesionScore).toBeLessThan(6);
    expect(summary.workflowSummary.weakestWorkflows[0]?.scenarioId).toBe('workflow_quality_check');
  });

  it('aggregates common paths, fragile transitions, and repeated failure clusters', () => {
    const rows: AuditToolTelemetryRecord[] = [
      makeRow({ runId: 'run-ok', iterationIndex: 0, toolName: 'shell_exec', toolCategory: 'shell', success: true }),
      makeRow({ id: 2, runId: 'run-ok', iterationIndex: 1, toolName: 'fs_read_file', toolCategory: 'filesystem', success: true }),
      makeRow({ id: 3, runId: 'run-ok', iterationIndex: 2, toolName: 'shell_exec', toolCategory: 'shell', success: true }),
      makeRow({ id: 4, runId: 'run-fail-1', iterationIndex: 0, toolName: 'shell_exec', toolCategory: 'shell', success: true }),
      makeRow({ id: 5, runId: 'run-fail-1', iterationIndex: 1, toolName: 'fs_read_file', toolCategory: 'filesystem', success: true }),
      makeRow({ id: 6, runId: 'run-fail-1', iterationIndex: 2, toolName: 'shell_exec', toolCategory: 'shell', success: true }),
      makeRow({ id: 7, runId: 'run-fail-1', iterationIndex: 3, toolName: 'shell_exec', toolCategory: 'shell', success: false, errorType: 'error' }),
      makeRow({ id: 8, runId: 'run-fail-2', iterationIndex: 0, toolName: 'shell_exec', toolCategory: 'shell', success: true }),
      makeRow({ id: 9, runId: 'run-fail-2', iterationIndex: 1, toolName: 'fs_read_file', toolCategory: 'filesystem', success: true }),
      makeRow({ id: 10, runId: 'run-fail-2', iterationIndex: 2, toolName: 'shell_exec', toolCategory: 'shell', success: true }),
      makeRow({ id: 11, runId: 'run-fail-2', iterationIndex: 3, toolName: 'shell_exec', toolCategory: 'shell', success: false, errorType: 'error' }),
    ];
    const runs: RunRecord[] = [
      makeRun({ id: 'run-ok', scenarioId: 'trace_shell_fs', status: 'completed', startedAt: 0, completedAt: 5_000, updatedAt: 5_000, toolCallCount: 3 }),
      makeRun({ id: 'run-fail-1', scenarioId: 'trace_shell_fs', status: 'failed', startedAt: 0, completedAt: 6_000, updatedAt: 6_000, toolCallCount: 4 }),
      makeRun({ id: 'run-fail-2', scenarioId: 'trace_shell_fs', status: 'failed', startedAt: 0, completedAt: 6_500, updatedAt: 6_500, toolCallCount: 4 }),
    ];

    const summary = summarizeRecentTelemetry(rows, runs, rows);
    const scenario = summary.scenarioSummaries.find((entry) => entry.scenario.id === 'trace_shell_fs');
    expect(scenario).toBeDefined();
    expect(scenario?.mostCommonPath).toBe('shell_exec -> fs_read_file -> shell_exec -> shell_exec');
    expect(scenario?.mostCommonFailedPath).toBe('shell_exec -> fs_read_file -> shell_exec -> shell_exec');
    expect(scenario?.mostCommonSuccessfulPath).toBe('shell_exec -> fs_read_file -> shell_exec');
    expect(scenario?.mostCommonFailureStepIndex).toBe(4);
    expect(scenario?.mostCommonFailureTool).toBe('shell_exec');
    expect(scenario?.failureStepDistribution[0]).toEqual({ stepIndex: 4, count: 2 });
    expect(scenario?.fragileTransitions[0]?.transition).toBe('shell -> shell');
    expect(scenario?.repeatedFailureClusterCount).toBe(1);
  });

  it('summarizes the dominant recovery path and continuation', () => {
    const rows: AuditToolTelemetryRecord[] = [
      makeRow({ runId: 'run-recover-1', iterationIndex: 0, toolName: 'shell_exec', toolCategory: 'shell', success: false, recoveryInvoked: false, errorType: 'error' }),
      makeRow({ id: 2, runId: 'run-recover-1', iterationIndex: 1, toolName: 'shell_exec', toolCategory: 'shell', success: true, recoveryInvoked: true }),
      makeRow({ id: 3, runId: 'run-recover-1', iterationIndex: 2, toolName: 'fs_read_file', toolCategory: 'filesystem', success: true }),
      makeRow({ id: 4, runId: 'run-recover-2', iterationIndex: 0, toolName: 'shell_exec', toolCategory: 'shell', success: false, recoveryInvoked: false, errorType: 'error' }),
      makeRow({ id: 5, runId: 'run-recover-2', iterationIndex: 1, toolName: 'shell_exec', toolCategory: 'shell', success: true, recoveryInvoked: true }),
      makeRow({ id: 6, runId: 'run-recover-2', iterationIndex: 2, toolName: 'fs_read_file', toolCategory: 'filesystem', success: true }),
    ];
    const runs: RunRecord[] = [
      makeRun({ id: 'run-recover-1', scenarioId: 'trace_recovery', status: 'completed', startedAt: 0, completedAt: 4_000, updatedAt: 4_000, toolCallCount: 3 }),
      makeRun({ id: 'run-recover-2', scenarioId: 'trace_recovery', status: 'completed', startedAt: 0, completedAt: 4_000, updatedAt: 4_000, toolCallCount: 3 }),
    ];

    const summary = summarizeRecentTelemetry(rows, runs, rows);
    const scenario = summary.scenarioSummaries.find((entry) => entry.scenario.id === 'trace_recovery');
    expect(scenario).toBeDefined();
    expect(scenario?.mostCommonRecoveryPath).toBe('shell_exec -> shell_exec');
    expect(scenario?.toolBeforeRecovery).toBe('shell_exec');
    expect(scenario?.postRecoveryContinuationPath).toBe('shell_exec -> fs_read_file');
  });

  it('builds bounded harness learning summaries from recent harness events', () => {
    const rows: AuditToolTelemetryRecord[] = [];
    const runs: RunRecord[] = [
      makeRun({ id: 'run-1', status: 'completed', goal: 'Edit file safely' }),
      makeRun({ id: 'run-2', status: 'completed', goal: 'Edit file safely' }),
      makeRun({ id: 'run-3', status: 'failed', goal: 'Edit file safely' }),
    ];
    const events: RunEventRecord[] = [
      makeEvent({
        id: 1,
        runId: 'run-1',
        seq: 1,
        kind: 'harness_resolved',
        payload: {
          harnessId: 'coding',
          baseHarnessId: 'coding',
          baseGoal: 'modify_workspace',
          baseStrategy: 'direct_balanced',
        },
      }),
      makeEvent({
        id: 2,
        runId: 'run-1',
        seq: 2,
        kind: 'harness_in_loop_adjusted',
        payload: {
          signal: { kind: 'tool_result', toolFamily: 'shell', success: false },
          strategyShifts: [{ to: 'low_shell_dependence' }],
          goalAdjustments: [{ to: 'safely_apply_change' }],
          subGoalAdjustments: [{ from: 'verify_change', to: 'verify_change' }],
        },
      }),
      makeEvent({
        id: 3,
        runId: 'run-1',
        seq: 3,
        kind: 'harness_run_summary',
        payload: {
          harnessId: 'coding',
          baseGoal: 'modify_workspace',
          completedWithResponse: true,
          goalAdjustmentIds: ['modify_workspace->safely_apply_change'],
          subGoalAdjustmentIds: ['verify_change->verify_change'],
        },
      }),
      makeEvent({
        id: 4,
        runId: 'run-2',
        seq: 1,
        kind: 'harness_resolved',
        payload: {
          harnessId: 'coding',
          baseHarnessId: 'coding',
          baseGoal: 'modify_workspace',
          baseStrategy: 'direct_balanced',
        },
      }),
      makeEvent({
        id: 5,
        runId: 'run-2',
        seq: 2,
        kind: 'harness_in_loop_adjusted',
        payload: {
          signal: { kind: 'tool_result', toolFamily: 'shell', success: false },
          strategyShifts: [{ to: 'low_shell_dependence' }, { to: 'verify_before_write' }],
          goalAdjustments: [{ to: 'safely_apply_change' }],
          subGoalAdjustments: [{ from: 'verify_change', to: 'verify_change' }],
        },
      }),
      makeEvent({
        id: 6,
        runId: 'run-2',
        seq: 3,
        kind: 'harness_run_summary',
        payload: {
          harnessId: 'coding',
          baseGoal: 'modify_workspace',
          completedWithResponse: true,
          goalAdjustmentIds: ['modify_workspace->safely_apply_change'],
          subGoalAdjustmentIds: ['verify_change->verify_change'],
        },
      }),
      makeEvent({
        id: 7,
        runId: 'run-3',
        seq: 1,
        kind: 'harness_resolved',
        payload: {
          harnessId: 'coding',
          baseHarnessId: 'coding',
          baseGoal: 'modify_workspace',
          baseStrategy: 'direct_balanced',
        },
      }),
      makeEvent({
        id: 8,
        runId: 'run-3',
        seq: 2,
        kind: 'harness_in_loop_adjusted',
        payload: {
          signal: { kind: 'tool_result', toolFamily: 'shell', success: false },
          strategyShifts: [{ to: 'low_shell_dependence' }],
          goalAdjustments: [{ to: 'safely_apply_change' }],
          subGoalAdjustments: [{ from: 'verify_change', to: 'verify_change' }],
        },
      }),
      makeEvent({
        id: 9,
        runId: 'run-3',
        seq: 3,
        kind: 'harness_run_summary',
        payload: {
          harnessId: 'coding',
          baseGoal: 'modify_workspace',
          completedWithResponse: false,
          goalAdjustmentIds: ['modify_workspace->safely_apply_change'],
          subGoalAdjustmentIds: ['verify_change->verify_change'],
        },
      }),
    ];

    const summary = summarizeRecentTelemetry(rows, runs, rows, events);
    const learning = summary.harnessLearningSummaries.find((entry) => entry.patternKey === 'coding:modify_workspace');
    expect(learning).toBeDefined();
    expect(learning?.sampleSize).toBe(3);
    expect(learning?.completionRate).toBeCloseTo(0.67, 2);
    expect(learning?.optimizationHints.map((hint) => hint.id)).toContain('prefer_low_shell_dependence');
    expect(learning?.optimizationHints.map((hint) => hint.id)).toContain('prefer_verify_before_write');
    expect(learning?.repeatedFailingToolFamilies[0]).toEqual({ family: 'shell', count: 3 });
  });

  it('formats a compact scorecard text view from the cached summary shape', () => {
    const rows: AuditToolTelemetryRecord[] = [
      makeRow({ runId: 'run-a', toolName: 'browser_read_page', toolCategory: 'browser', success: true, durationMs: 800 }),
      makeRow({ id: 2, runId: 'run-a', toolName: 'browser_click', toolCategory: 'browser', success: true, durationMs: 350 }),
      makeRow({ id: 3, runId: 'run-b', toolName: 'shell_exec', toolCategory: 'shell', success: false, durationMs: 30_000, errorType: 'timeout' }),
      makeRow({ id: 4, runId: 'run-b', toolName: 'shell_exec', toolCategory: 'shell', success: false, durationMs: 30_000, errorType: 'timeout' }),
      makeRow({ id: 5, runId: 'run-b', toolName: 'shell_exec', toolCategory: 'shell', success: true, durationMs: 700 }),
    ];
    const runs: RunRecord[] = [
      makeRun({ id: 'run-a', scenarioId: 'browser_extract_and_save', status: 'completed', startedAt: 0, completedAt: 75_000, updatedAt: 75_000, toolCallCount: 2 }),
      makeRun({ id: 'run-b', scenarioId: 'shell_validate', status: 'failed', startedAt: 0, completedAt: 95_000, updatedAt: 95_000, toolCallCount: 3 }),
    ];

    const summary = summarizeRecentTelemetry(rows, runs, rows);
    const text = formatCapabilityScorecardText(summary);
    expect(text).toContain('CAPABILITY SCORECARD');
    expect(text).toContain('Overall:');
    expect(text).toContain('Subsystems');
    expect(text).toContain('Categories');
    expect(text).toContain('Scenarios');
    expect(text).toContain('Workflow Summary');
    expect(text).toContain('Eff ');
    expect(text).toContain('Coh ');
    expect(text).toContain('Common path:');
    expect(text).toContain('Failure focus:');
    expect(text).toContain('Recovery path:');
    expect(text).toContain('browser_extract_and_save');
    expect(text).toContain('shell_validate');
  });
});
