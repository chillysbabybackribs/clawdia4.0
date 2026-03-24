import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const runMock = vi.fn();
const allMock = vi.fn();

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (_sql: string) => ({ get: getMock, run: runMock, all: allMock }),
  }),
}));

describe('task-sequences CRUD', () => {
  beforeEach(() => {
    getMock.mockReset();
    runMock.mockReset();
    allMock.mockReset();
  });

  it('insertTaskSequence returns the new row id', async () => {
    runMock.mockReturnValue({ lastInsertRowid: 42 });
    const { insertTaskSequence } = await import('../../src/main/db/task-sequences');
    const id = insertTaskSequence({
      runId: 'run-1',
      goal: 'check github notifications',
      surfaces: ['browser'],
      steps: [],
      outcome: 'success',
      toolCallCount: 3,
      durationMs: 4200,
      createdAt: '2026-03-24T00:00:00.000Z',
    });
    expect(id).toBe(42);
    expect(runMock).toHaveBeenCalledOnce();
  });

  it('getTaskSequence returns null when not found', async () => {
    getMock.mockReturnValue(undefined);
    const { getTaskSequence } = await import('../../src/main/db/task-sequences');
    const result = getTaskSequence(999);
    expect(result).toBeNull();
  });

  it('getTaskSequence deserializes surfaces and steps JSON', async () => {
    const steps = [{ seq: 0, surface: 'browser', tool: 'browser_navigate', input: { url: 'https://github.com' }, outputSummary: 'ok', durationMs: 200, success: true }];
    getMock.mockReturnValue({
      id: 1,
      run_id: 'run-1',
      goal: 'test',
      goal_embedding: null,
      surfaces: JSON.stringify(['browser']),
      steps: JSON.stringify(steps),
      outcome: 'success',
      tool_call_count: 3,
      duration_ms: 4200,
      success_count: 0,
      fail_count: 0,
      last_used: null,
      created_at: '2026-03-24T00:00:00.000Z',
    });
    const { getTaskSequence } = await import('../../src/main/db/task-sequences');
    const result = getTaskSequence(1);
    expect(result).not.toBeNull();
    expect(result!.surfaces).toEqual(['browser']);
    expect(result!.steps).toEqual(steps);
    expect(result!.goalEmbedding).toBeNull();
  });

  it('getTaskSequence deserializes non-null goal_embedding to Float32Array', async () => {
    const original = new Float32Array([0.1, 0.2, 0.3]);
    const blob = Buffer.from(original.buffer);
    getMock.mockReturnValue({
      id: 2,
      run_id: 'run-2',
      goal: 'test embedding',
      goal_embedding: blob,
      surfaces: JSON.stringify([]),
      steps: JSON.stringify([]),
      outcome: 'success',
      tool_call_count: 3,
      duration_ms: 1000,
      success_count: 3,
      fail_count: 0,
      last_used: null,
      created_at: '2026-03-24T00:00:00.000Z',
    });
    const { getTaskSequence } = await import('../../src/main/db/task-sequences');
    const result = getTaskSequence(2);
    expect(result!.goalEmbedding).toBeInstanceOf(Float32Array);
    expect(result!.goalEmbedding!.length).toBe(3);
  });

  it('updateTaskSequenceSteps serializes steps to JSON', async () => {
    runMock.mockReturnValue({ changes: 1 });
    const { updateTaskSequenceSteps } = await import('../../src/main/db/task-sequences');
    const steps = [{ seq: 0, surface: 'browser' as const, tool: 'browser_navigate', input: {}, outputSummary: 'ok', durationMs: 100, success: true }];
    updateTaskSequenceSteps(1, steps);
    expect(runMock).toHaveBeenCalledOnce();
    const calledWith = runMock.mock.calls[0];
    expect(calledWith[0]).toBe(JSON.stringify(steps));
  });

  it('updateTaskSequenceEmbedding stores Float32Array as Buffer', async () => {
    runMock.mockReturnValue({ changes: 1 });
    const { updateTaskSequenceEmbedding } = await import('../../src/main/db/task-sequences');
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    updateTaskSequenceEmbedding(1, vec);
    expect(runMock).toHaveBeenCalledOnce();
    const calledWith = runMock.mock.calls[0];
    expect(calledWith[0]).toBeInstanceOf(Buffer);
  });

  it('listTaskSequences returns mapped rows', async () => {
    allMock.mockReturnValue([
      {
        id: 1,
        run_id: 'run-1',
        goal: 'test',
        goal_embedding: null,
        surfaces: JSON.stringify(['browser']),
        steps: JSON.stringify([]),
        outcome: 'success',
        tool_call_count: 3,
        duration_ms: 1000,
        success_count: 0,
        fail_count: 0,
        last_used: null,
        created_at: '2026-03-24T00:00:00.000Z',
      },
    ]);
    const { listTaskSequences } = await import('../../src/main/db/task-sequences');
    const results = listTaskSequences();
    expect(results).toHaveLength(1);
    expect(results[0].runId).toBe('run-1');
    expect(allMock).toHaveBeenCalledOnce();
  });
});
