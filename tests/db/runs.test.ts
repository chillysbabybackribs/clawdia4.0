import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const runMock = vi.fn();
const allMock = vi.fn();

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (_sql: string) => ({ get: getMock, run: runMock, all: allMock }),
  }),
}));

describe('runs.runExists()', () => {
  beforeEach(() => {
    getMock.mockReset();
    runMock.mockReset();
    allMock.mockReset();
    vi.useRealTimers();
  });

  it('returns true when the run row exists', async () => {
    getMock.mockReturnValue({ ok: 1 });
    const { runExists } = await import('../../src/main/db/runs');
    expect(runExists('run-1')).toBe(true);
  });

  it('returns false when the run row does not exist', async () => {
    getMock.mockReturnValue(undefined);
    const { runExists } = await import('../../src/main/db/runs');
    expect(runExists('missing')).toBe(false);
  });

  it('syncs workflow_stage to terminal status when completing a run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T23:10:00.000Z'));
    const { completeRun } = await import('../../src/main/db/runs');

    completeRun('run-2', 'failed', 'boom');

    expect(runMock).toHaveBeenCalledWith(
      'failed',
      'boom',
      '2026-03-24T23:10:00.000Z',
      '2026-03-24T23:10:00.000Z',
      'failed',
      'run-2',
    );
  });
});
