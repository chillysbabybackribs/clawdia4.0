/**
 * Run Events — durable structured event log for task runs.
 */

import { getDb } from './database';
import type { AgentProfile } from '../../shared/types';

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

interface DanglingToolStart {
  toolUseId: string;
  toolName: string;
  surface?: string | null;
  detail?: string;
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

export function hasRunEventKind(runId: string, kind: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM run_events WHERE run_id = ? AND kind = ? LIMIT 1')
    .get(runId, kind) as { ok?: number } | undefined;
  return row?.ok === 1;
}

export function hasWorkflowStageEvent(runId: string, workflowStage: string): boolean {
  const row = getDb()
    .prepare(`
      SELECT 1 AS ok
      FROM run_events
      WHERE run_id = ?
        AND kind = 'workflow_stage_changed'
        AND payload_json LIKE ?
      LIMIT 1
    `)
    .get(runId, `%"workflowStage":"${workflowStage}"%`) as { ok?: number } | undefined;
  return row?.ok === 1;
}

export function closeDanglingToolExecutions(runId: string, terminalStatus: 'completed' | 'failed' | 'cancelled'): number {
  const rows = getDb()
    .prepare(`
      SELECT
        tool_name,
        surface,
        json_extract(payload_json, '$.toolUseId') AS tool_use_id,
        json_extract(payload_json, '$.detail') AS detail
      FROM run_events started
      WHERE run_id = ?
        AND kind = 'tool_started'
        AND json_extract(payload_json, '$.toolUseId') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM run_events closed
          WHERE closed.run_id = started.run_id
            AND closed.kind IN ('tool_completed', 'tool_failed')
            AND json_extract(closed.payload_json, '$.toolUseId') = json_extract(started.payload_json, '$.toolUseId')
        )
      ORDER BY seq ASC
    `)
    .all(runId) as Array<{ tool_name?: string | null; surface?: string | null; tool_use_id?: string | null; detail?: string | null }>;

  for (const row of rows) {
    const started: DanglingToolStart = {
      toolUseId: row.tool_use_id || '',
      toolName: row.tool_name || 'unknown_tool',
      surface: row.surface,
      detail: row.detail || undefined,
    };
    appendRunEvent(runId, {
      kind: 'tool_failed',
      phase: 'dispatch',
      surface: started.surface || undefined,
      toolName: started.toolName,
      payload: {
        toolUseId: started.toolUseId,
        detail: started.detail || 'Tool execution did not record a terminal result before run finalization.',
        durationMs: null,
        resultPreview: `[Synthetic closeout] Tool execution was left open when the run ended with status ${terminalStatus}.`,
        status: 'error',
        synthesized: true,
        terminalStatus,
      },
    });
  }

  return rows.length;
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

export function getRunAgentProfile(runId: string): AgentProfile | undefined {
  const row = getDb()
    .prepare(`
      SELECT payload_json
      FROM run_events
      WHERE run_id = ? AND kind = 'run_classified'
      ORDER BY seq DESC
      LIMIT 1
    `)
    .get(runId) as { payload_json?: string } | undefined;

  if (!row?.payload_json) return undefined;
  const payload = safeParse(row.payload_json);
  return payload.agentProfile === 'filesystem'
    ? 'filesystem'
    : payload.agentProfile === 'bloodhound'
      ? 'bloodhound'
      : payload.agentProfile === 'general'
        ? 'general'
        : payload.agentProfile === 'ytdlp'
          ? 'ytdlp'
          : undefined;
}

export function getLastSpecializedTool(runId: string): string | undefined {
  const row = getDb()
    .prepare(`
      SELECT tool_name
      FROM run_events
      WHERE run_id = ? AND tool_name LIKE 'fs_%'
      ORDER BY seq DESC
      LIMIT 1
    `)
    .get(runId) as { tool_name?: string | null } | undefined;

  return row?.tool_name || undefined;
}

function safeParse(json: string): Record<string, any> {
  try {
    return JSON.parse(json || '{}') as Record<string, any>;
  } catch {
    return {};
  }
}
