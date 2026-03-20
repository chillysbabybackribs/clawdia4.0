import { getDb } from './database';

export interface RunFileLockRow {
  path: string;
  run_id: string;
  conversation_id: string;
  acquired_at: string;
  last_seen_at: string;
  source_revision: string | null;
  lock_mode: 'write';
}

export function getRunFileLock(path: string): RunFileLockRow | null {
  return (getDb().prepare('SELECT * FROM run_file_locks WHERE path = ?').get(path) as RunFileLockRow) || null;
}

export function acquireRunFileLock(
  path: string,
  runId: string,
  conversationId: string,
  sourceRevision?: string | null,
): { ok: true } | { ok: false; ownerRunId: string } {
  const db = getDb();
  const existing = getRunFileLock(path);
  const now = new Date().toISOString();

  if (existing && existing.run_id !== runId) {
    return { ok: false, ownerRunId: existing.run_id };
  }

  db.prepare(`
    INSERT INTO run_file_locks (
      path, run_id, conversation_id, acquired_at, last_seen_at, source_revision, lock_mode
    ) VALUES (?, ?, ?, ?, ?, ?, 'write')
    ON CONFLICT(path) DO UPDATE SET
      run_id = excluded.run_id,
      conversation_id = excluded.conversation_id,
      last_seen_at = excluded.last_seen_at,
      source_revision = excluded.source_revision,
      lock_mode = 'write'
  `).run(path, runId, conversationId, now, now, sourceRevision || null);

  return { ok: true };
}

export function releaseRunFileLock(path: string, runId: string): void {
  getDb().prepare('DELETE FROM run_file_locks WHERE path = ? AND run_id = ?').run(path, runId);
}

export function releaseRunFileLocks(runId: string): void {
  getDb().prepare('DELETE FROM run_file_locks WHERE run_id = ?').run(runId);
}

export function clearAllRunFileLocks(): void {
  getDb().prepare('DELETE FROM run_file_locks').run();
}
