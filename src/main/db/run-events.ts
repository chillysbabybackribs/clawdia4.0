/**
 * Run Events — durable structured event log for task runs.
 */

import { getDb } from './database';

export interface RunEventRow {
  id: number;
  run_id: string;
  seq: number;
  ts: string;
  kind: string;
  phase: string | null;
  surface: string | null;
  tool_name: string | null;
  payload_json: string;
}

export interface RunEventRecord {
  id: number;
  runId: string;
  seq: number;
  timestamp: string;
  kind: string;
  phase?: string | null;
  surface?: string | null;
  toolName?: string | null;
  payload: Record<string, any>;
}

export interface AppendRunEventInput {
  kind: string;
  phase?: string;
  surface?: string;
  toolName?: string;
  payload?: Record<string, any>;
}

export function appendRunEvent(runId: string, event: AppendRunEventInput): number {
  const db = getDb();
  const seqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM run_events WHERE run_id = ?').get(runId) as { seq?: number };
  const seq = (seqRow?.seq || 0) + 1;
  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO run_events (
      run_id, seq, ts, kind, phase, surface, tool_name, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    seq,
    now,
    event.kind,
    event.phase || null,
    event.surface || null,
    event.toolName || null,
    JSON.stringify(event.payload || {}),
  );

  return Number(result.lastInsertRowid);
}

export function listRunEvents(runId: string): RunEventRow[] {
  return getDb()
    .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC')
    .all(runId) as RunEventRow[];
}

export function getRunEventRecords(runId: string): RunEventRecord[] {
  return listRunEvents(runId).map(row => ({
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    timestamp: row.ts,
    kind: row.kind,
    phase: row.phase,
    surface: row.surface,
    toolName: row.tool_name,
    payload: safeParse(row.payload_json),
  }));
}

export function deleteRunEvents(runId: string): void {
  getDb().prepare('DELETE FROM run_events WHERE run_id = ?').run(runId);
}

function safeParse(json: string): Record<string, any> {
  try {
    return JSON.parse(json || '{}') as Record<string, any>;
  } catch {
    return {};
  }
}
