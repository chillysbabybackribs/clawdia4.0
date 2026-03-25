import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const runMock = vi.fn();
const allMock = vi.fn();

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      if (sql.includes('SELECT * FROM run_artifacts')) return { all: allMock, get: getMock };
      if (sql.includes('SELECT id FROM run_artifacts')) return { get: getMock };
      if (sql.includes('UPDATE run_artifacts')) return { run: runMock };
      if (sql.includes('INSERT INTO run_artifacts')) return { run: runMock };
      return { get: getMock, run: runMock, all: allMock };
    },
  }),
}));

describe('run_artifacts', () => {
  beforeEach(() => {
    getMock.mockReset();
    runMock.mockReset();
    allMock.mockReset();
  });

  it('passes execution_graph_scaffold through the persistence layer', async () => {
    getMock
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({
        id: 1,
        run_id: 'run-1',
        kind: 'execution_graph_scaffold',
        title: 'Execution Graph Scaffold',
        body: '{"ok":true}',
        created_at: '2026-03-21T00:00:00.000Z',
        updated_at: '2026-03-21T00:00:00.000Z',
      });
    runMock.mockReturnValue({ lastInsertRowid: 1 });

    const { upsertRunArtifact } = await import('../../src/main/db/run-artifacts');
    const artifact = upsertRunArtifact('run-1', 'execution_graph_scaffold', 'Execution Graph Scaffold', '{"ok":true}');

    expect(runMock).toHaveBeenCalled();
    expect(artifact.kind).toBe('execution_graph_scaffold');
  });

  it('passes execution_graph_state through the persistence layer', async () => {
    getMock
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({
        id: 2,
        run_id: 'run-2',
        kind: 'execution_graph_state',
        title: 'Execution Graph State',
        body: '{"status":"running"}',
        created_at: '2026-03-21T00:00:00.000Z',
        updated_at: '2026-03-21T00:00:00.000Z',
      });
    runMock.mockReturnValue({ lastInsertRowid: 2 });

    const { upsertRunArtifact } = await import('../../src/main/db/run-artifacts');
    const artifact = upsertRunArtifact('run-2', 'execution_graph_state', 'Execution Graph State', '{"status":"running"}');

    expect(runMock).toHaveBeenCalled();
    expect(artifact.kind).toBe('execution_graph_state');
  });

  it('passes evidence_ledger through the persistence layer', async () => {
    getMock
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({
        id: 3,
        run_id: 'run-3',
        kind: 'evidence_ledger',
        title: 'Evidence Ledger',
        body: '{"facts":[{"key":"total_runs","value":20}]}',
        created_at: '2026-03-25T00:00:00.000Z',
        updated_at: '2026-03-25T00:00:00.000Z',
      });
    runMock.mockReturnValue({ lastInsertRowid: 3 });

    const { upsertRunArtifact } = await import('../../src/main/db/run-artifacts');
    const artifact = upsertRunArtifact('run-3', 'evidence_ledger', 'Evidence Ledger', '{"facts":[{"key":"total_runs","value":20}]}');

    expect(runMock).toHaveBeenCalled();
    expect(artifact.kind).toBe('evidence_ledger');
  });
});
