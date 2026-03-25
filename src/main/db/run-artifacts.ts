import { getDb } from './database';
import type { RunArtifact } from '../../shared/types';

interface RunArtifactRow {
  id: number;
  run_id: string;
  kind: 'execution_plan' | 'execution_graph_scaffold' | 'execution_graph_state' | 'evidence_ledger';
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export function listRunArtifacts(runId: string): RunArtifact[] {
  const rows = getDb()
    .prepare('SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY id ASC')
    .all(runId) as RunArtifactRow[];
  return rows.map(toRunArtifact);
}

export function upsertRunArtifact(
  runId: string,
  kind: 'execution_plan' | 'execution_graph_scaffold' | 'execution_graph_state' | 'evidence_ledger',
  title: string,
  body: string,
): RunArtifact {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare(
    'SELECT id FROM run_artifacts WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1',
  ).get(runId, kind) as { id?: number } | undefined;

  if (existing?.id) {
    db.prepare(`
      UPDATE run_artifacts
      SET title = ?, body = ?, updated_at = ?
      WHERE id = ?
    `).run(title, body, now, existing.id);

    const row = db.prepare('SELECT * FROM run_artifacts WHERE id = ?').get(existing.id) as RunArtifactRow;
    return toRunArtifact(row);
  }

  const result = db.prepare(`
    INSERT INTO run_artifacts (run_id, kind, title, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(runId, kind, title, body, now, now);

  const row = db.prepare('SELECT * FROM run_artifacts WHERE id = ?').get(result.lastInsertRowid) as RunArtifactRow;
  return toRunArtifact(row);
}

function toRunArtifact(row: RunArtifactRow): RunArtifact {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
