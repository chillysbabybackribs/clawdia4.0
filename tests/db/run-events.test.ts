import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const runMock = vi.fn();
const allMock = vi.fn();

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      if (sql.includes('SELECT COALESCE(MAX(seq), 0) AS seq')) return { get: getMock };
      if (sql.includes('FROM run_events started')) return { all: allMock };
      if (sql.includes('INSERT INTO run_events')) return { run: runMock };
      if (sql.includes('SELECT 1 AS ok FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1')) return { get: getMock };
      if (sql.includes("kind = 'workflow_stage_changed'")) return { get: getMock };
      return { get: getMock, run: runMock, all: allMock };
    },
  }),
}));

describe('run_events.closeDanglingToolExecutions()', () => {
  beforeEach(() => {
    getMock.mockReset();
    runMock.mockReset();
    allMock.mockReset();
    runMock.mockReturnValue({ lastInsertRowid: 8 });
  });

  it('synthesizes tool_failed events for open tool_started entries', async () => {
    allMock.mockReturnValue([
      {
        tool_name: 'shell_exec',
        surface: 'shell',
        tool_use_id: 'toolu-1',
        detail: 'grep for symbol',
      },
    ]);
    getMock.mockReturnValue({ seq: 7 });

    const { closeDanglingToolExecutions } = await import('../../src/main/db/run-events');
    const count = closeDanglingToolExecutions('run-1', 'failed');

    expect(count).toBe(1);
    expect(runMock).toHaveBeenCalledWith(
      'run-1',
      8,
      expect.any(String),
      'tool_failed',
      'dispatch',
      'shell',
      'shell_exec',
      expect.stringContaining('"toolUseId":"toolu-1"'),
    );
    expect(runMock).toHaveBeenCalledWith(
      'run-1',
      8,
      expect.any(String),
      'tool_failed',
      'dispatch',
      'shell',
      'shell_exec',
      expect.stringContaining('"synthesized":true'),
    );
  });
});
