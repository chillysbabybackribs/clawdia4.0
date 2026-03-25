import { beforeEach, describe, expect, it, vi } from 'vitest';

const completeRunMock = vi.fn();
const createRunMock = vi.fn();
const incrementRunToolOutcomeMock = vi.fn();
const setRunDetachedMock = vi.fn();
const setRunExecutionInfoMock = vi.fn();
const setRunStatusMock = vi.fn();
const setRunWorkflowStageMock = vi.fn();
const evictOldRunsMock = vi.fn();
const reconcileInterruptedRunsMock = vi.fn();
const appendRunEventMock = vi.fn();
const closeDanglingToolExecutionsMock = vi.fn();
const hasRunEventKindMock = vi.fn();
const hasWorkflowStageEventMock = vi.fn();
const finalizeRunAuditMock = vi.fn();
const clearRunFileStateMock = vi.fn();
const setBrowserExecutionModeMock = vi.fn();

vi.mock('../../src/main/db/runs', () => ({
  completeRun: completeRunMock,
  createRun: createRunMock,
  deleteRun: vi.fn(),
  evictOldRuns: evictOldRunsMock,
  getRun: vi.fn(),
  incrementRunToolOutcome: incrementRunToolOutcomeMock,
  incrementRunToolCount: vi.fn(),
  listRuns: vi.fn(() => []),
  reconcileInterruptedRuns: reconcileInterruptedRunsMock,
  setRunExecutionInfo: setRunExecutionInfoMock,
  setRunStatus: setRunStatusMock,
  setRunDetached: setRunDetachedMock,
  setRunWorkflowStage: setRunWorkflowStageMock,
}));

vi.mock('../../src/main/db/run-events', () => ({
  appendRunEvent: appendRunEventMock,
  closeDanglingToolExecutions: closeDanglingToolExecutionsMock,
  getLastSpecializedTool: vi.fn(),
  getRunAgentProfile: vi.fn(),
  hasRunEventKind: hasRunEventKindMock,
  hasWorkflowStageEvent: hasWorkflowStageEventMock,
}));

vi.mock('../../src/main/agent/file-lock-manager', () => ({
  clearRunFileState: clearRunFileStateMock,
  initFileLockManager: vi.fn(),
}));

vi.mock('../../src/main/browser/manager', () => ({
  setBrowserExecutionMode: setBrowserExecutionModeMock,
}));

vi.mock('../../src/main/agent/stream-batcher', () => ({
  createStreamBatcher: vi.fn(() => ({
    push: vi.fn(),
    flushImmediate: vi.fn(),
  })),
}));

vi.mock('../../src/main/agent/system-audit', () => ({
  finalizeRunAudit: finalizeRunAuditMock,
}));

vi.mock('../../src/main/db/run-approvals', () => ({
  reconcilePendingRunApprovals: vi.fn(),
}));

vi.mock('../../src/main/db/run-human-interventions', () => ({
  reconcilePendingRunHumanInterventions: vi.fn(),
}));

describe('process-manager terminal audit envelope', () => {
  beforeEach(() => {
    vi.resetModules();
    completeRunMock.mockReset();
    createRunMock.mockReset();
    incrementRunToolOutcomeMock.mockReset();
    setRunDetachedMock.mockReset();
    setRunExecutionInfoMock.mockReset();
    setRunStatusMock.mockReset();
    setRunWorkflowStageMock.mockReset();
    evictOldRunsMock.mockReset();
    reconcileInterruptedRunsMock.mockReset();
    appendRunEventMock.mockReset();
    closeDanglingToolExecutionsMock.mockReset();
    hasRunEventKindMock.mockReset();
    hasWorkflowStageEventMock.mockReset();
    finalizeRunAuditMock.mockReset();
    clearRunFileStateMock.mockReset();
    setBrowserExecutionModeMock.mockReset();
    hasRunEventKindMock.mockReturnValue(false);
    hasWorkflowStageEventMock.mockReturnValue(false);
    closeDanglingToolExecutionsMock.mockReturnValue(0);
  });

  it('backfills terminal summary, workflow stage, and failure event when the loop did not emit them', async () => {
    closeDanglingToolExecutionsMock.mockReturnValue(1);
    const { registerProcess, completeProcess } = await import('../../src/main/agent/process-manager');
    const processId = registerProcess('conv-1', 'Investigate the repo', 'anthropic' as any, 'claude-haiku');

    appendRunEventMock.mockClear();
    completeProcess(processId, 'failed', 'boom');

    expect(completeRunMock).toHaveBeenCalledWith(processId, 'failed', 'boom');
    expect(closeDanglingToolExecutionsMock).toHaveBeenCalledWith(processId, 'failed');
    expect(incrementRunToolOutcomeMock).toHaveBeenCalledWith(processId, 'failed', 1);
    expect(clearRunFileStateMock).toHaveBeenCalledWith(processId);
    expect(appendRunEventMock).toHaveBeenCalledWith(processId, expect.objectContaining({
      kind: 'harness_run_summary',
      phase: 'lifecycle',
      payload: expect.objectContaining({
        synthesized: true,
        terminalStatus: 'failed',
        danglingToolClosureCount: 1,
      }),
    }));
    expect(appendRunEventMock).toHaveBeenCalledWith(processId, expect.objectContaining({
      kind: 'workflow_stage_changed',
      phase: 'lifecycle',
      payload: { workflowStage: 'failed' },
    }));
    expect(appendRunEventMock).toHaveBeenCalledWith(processId, expect.objectContaining({
      kind: 'run_failed',
      phase: 'lifecycle',
      payload: { error: 'boom' },
    }));
  });

  it('does not duplicate terminal events that already exist', async () => {
    hasRunEventKindMock.mockImplementation((_runId: string, kind: string) =>
      kind === 'harness_run_summary' || kind === 'run_completed'
    );
    hasWorkflowStageEventMock.mockReturnValue(true);

    const { registerProcess, completeProcess } = await import('../../src/main/agent/process-manager');
    const processId = registerProcess('conv-2', 'Quick success', 'anthropic' as any, 'claude-haiku');

    appendRunEventMock.mockClear();
    completeProcess(processId, 'completed');

    expect(appendRunEventMock).not.toHaveBeenCalledWith(processId, expect.objectContaining({ kind: 'harness_run_summary' }));
    expect(appendRunEventMock).not.toHaveBeenCalledWith(processId, expect.objectContaining({ kind: 'workflow_stage_changed' }));
    expect(appendRunEventMock).not.toHaveBeenCalledWith(processId, expect.objectContaining({ kind: 'run_completed' }));
  });
});
