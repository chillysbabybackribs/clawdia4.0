import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (_sql: string) => ({ get: getMock, run: runMock, all: allMock }),
  }),
}));

const getMock = vi.fn();
const runMock = vi.fn();
const allMock = vi.fn();

vi.mock('../../../src/main/db/runs', () => ({
  getRun: vi.fn(),
}));

vi.mock('../../../src/main/db/run-events', () => ({
  getRunEventRecords: vi.fn(),
}));

vi.mock('../../../src/main/db/task-sequences', () => ({
  insertTaskSequence: vi.fn().mockReturnValue(1),
  updateTaskSequenceSteps: vi.fn(),
  updateTaskSequenceEmbedding: vi.fn(),
}));

vi.mock('../../../src/main/agent/bloodhound/distiller', () => ({
  distillSteps: vi.fn().mockReturnValue([
    { seq: 0, surface: 'browser', tool: 'browser_navigate', input: {}, outputSummary: 'ok', durationMs: 100, success: true },
    { seq: 1, surface: 'browser', tool: 'browser_click', input: {}, outputSummary: 'clicked', durationMs: 50, success: true },
    { seq: 2, surface: 'browser', tool: 'browser_extract', input: {}, outputSummary: 'data', durationMs: 80, success: true },
  ]),
  distillWithLLM: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/main/agent/bloodhound/embedder', () => ({
  embedGoal: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2])),
}));

function makeRunRow(overrides: Record<string, any> = {}) {
  return {
    id: 'run-1',
    conversation_id: 'conv-1',
    title: 'test run',
    goal: 'check github notifications',
    status: 'completed',
    started_at: new Date(Date.now() - 20000).toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    tool_call_count: 3,
    error: null,
    was_detached: 0,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    workflow_stage: 'complete',
    ...overrides,
  };
}

function makeToolEvents(count = 3) {
  const events: any[] = [];
  for (let i = 0; i < count; i++) {
    events.push({ kind: 'tool_started', seq: i * 2, toolName: 'browser_navigate', payload: { toolUseId: `tid-${i}`, input: {}, ordinal: i, detail: '' } });
    events.push({ kind: 'tool_completed', seq: i * 2 + 1, toolName: 'browser_navigate', payload: { toolUseId: `tid-${i}`, resultPreview: 'ok', durationMs: 100, detail: '' } });
  }
  return events;
}

describe('maybeRecordSequence()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMock.mockReturnValue({ lastInsertRowid: 1 });
  });

  it('skips recording when run has fewer than 3 tool calls and duration < 15s and single surface', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    const { getRunEventRecords } = await import('../../../src/main/db/run-events');
    vi.mocked(getRun).mockReturnValue(makeRunRow({
      tool_call_count: 2,
      started_at: new Date(Date.now() - 5000).toISOString(),
    }));
    vi.mocked(getRunEventRecords).mockReturnValue(makeToolEvents(2));

    const { distillSteps } = await import('../../../src/main/agent/bloodhound/distiller');
    vi.mocked(distillSteps).mockReturnValue([
      { seq: 0, surface: 'browser', tool: 'browser_navigate', input: {}, outputSummary: 'ok', durationMs: 100, success: true },
      { seq: 1, surface: 'browser', tool: 'browser_click', input: {}, outputSummary: 'clicked', durationMs: 50, success: true },
    ]);

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await maybeRecordSequence('run-1', 'completed');

    const { insertTaskSequence } = await import('../../../src/main/db/task-sequences');
    expect(vi.mocked(insertTaskSequence)).not.toHaveBeenCalled();
  });

  it('records when tool_call_count >= 3', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    const { getRunEventRecords } = await import('../../../src/main/db/run-events');
    vi.mocked(getRun).mockReturnValue(makeRunRow({ tool_call_count: 3, started_at: new Date(Date.now() - 5000).toISOString() }));
    vi.mocked(getRunEventRecords).mockReturnValue(makeToolEvents(3));

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await maybeRecordSequence('run-1', 'completed');

    const { insertTaskSequence } = await import('../../../src/main/db/task-sequences');
    expect(vi.mocked(insertTaskSequence)).toHaveBeenCalledOnce();
  });

  it('records with outcome=partial when status is cancelled and steps exist', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    const { getRunEventRecords } = await import('../../../src/main/db/run-events');
    vi.mocked(getRun).mockReturnValue(makeRunRow({ tool_call_count: 3, started_at: new Date(Date.now() - 5000).toISOString() }));
    vi.mocked(getRunEventRecords).mockReturnValue(makeToolEvents(3));

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await maybeRecordSequence('run-1', 'cancelled');

    const { insertTaskSequence } = await import('../../../src/main/db/task-sequences');
    const callArg = vi.mocked(insertTaskSequence).mock.calls[0][0];
    expect(callArg.outcome).toBe('partial');
  });

  it('skips recording when cancelled with 0 successful tool calls', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    const { getRunEventRecords } = await import('../../../src/main/db/run-events');
    vi.mocked(getRun).mockReturnValue(makeRunRow({ tool_call_count: 0, started_at: new Date(Date.now() - 5000).toISOString() }));
    vi.mocked(getRunEventRecords).mockReturnValue([]);

    const { distillSteps } = await import('../../../src/main/agent/bloodhound/distiller');
    vi.mocked(distillSteps).mockReturnValue([]);

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await maybeRecordSequence('run-1', 'cancelled');

    const { insertTaskSequence } = await import('../../../src/main/db/task-sequences');
    expect(vi.mocked(insertTaskSequence)).not.toHaveBeenCalled();
  });

  it('records when duration > 15 seconds even if tool count < 3', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    const { getRunEventRecords } = await import('../../../src/main/db/run-events');
    vi.mocked(getRun).mockReturnValue(makeRunRow({
      tool_call_count: 1,
      started_at: new Date(Date.now() - 20000).toISOString(),
    }));
    vi.mocked(getRunEventRecords).mockReturnValue(makeToolEvents(1));

    const { distillSteps } = await import('../../../src/main/agent/bloodhound/distiller');
    vi.mocked(distillSteps).mockReturnValue([
      { seq: 0, surface: 'browser', tool: 'browser_navigate', input: {}, outputSummary: 'ok', durationMs: 20000, success: true },
    ]);

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await maybeRecordSequence('run-1', 'completed');

    const { insertTaskSequence } = await import('../../../src/main/db/task-sequences');
    expect(vi.mocked(insertTaskSequence)).toHaveBeenCalledOnce();
  });

  it('does not throw when getRun returns null', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    vi.mocked(getRun).mockReturnValue(null);

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await expect(maybeRecordSequence('missing-run', 'completed')).resolves.not.toThrow();
  });
});
