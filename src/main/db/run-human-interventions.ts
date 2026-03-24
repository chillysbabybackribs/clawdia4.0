import { getDb } from './database';

export interface RunHumanInterventionRow {
  id: number;
  run_id: string;
  status: 'pending' | 'resolved' | 'dismissed';
  intervention_type: string;
  target: string | null;
  summary: string;
  instructions: string | null;
  request_json: string;
  created_at: string;
  resolved_at: string | null;
}

export interface RunHumanInterventionRecord {
  id: number;
  runId: string;
  status: 'pending' | 'resolved' | 'dismissed';
  interventionType: 'password' | 'otp' | 'captcha' | 'native_dialog' | 'site_confirmation' | 'conflict_resolution' | 'manual_takeover' | 'phone_required' | 'unexpected_form' | 'unknown';
  target?: string;
  summary: string;
  instructions?: string;
  request: Record<string, any>;
  createdAt: string;
  resolvedAt?: string;
}

export interface CreateRunHumanInterventionInput {
  interventionType: RunHumanInterventionRecord['interventionType'];
  target?: string;
  summary: string;
  instructions?: string;
  request?: Record<string, any>;
}

export function createRunHumanIntervention(
  runId: string,
  input: CreateRunHumanInterventionInput,
): RunHumanInterventionRecord {
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO run_human_interventions (
      run_id, status, intervention_type, target, summary, instructions, request_json, created_at
    ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    input.interventionType,
    input.target || null,
    input.summary,
    input.instructions || null,
    JSON.stringify(input.request || {}),
    now,
  );

  return {
    id: Number(result.lastInsertRowid),
    runId,
    status: 'pending',
    interventionType: input.interventionType,
    target: input.target,
    summary: input.summary,
    instructions: input.instructions,
    request: input.request || {},
    createdAt: now,
  };
}

export function getRunHumanInterventionRecord(id: number): RunHumanInterventionRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM run_human_interventions WHERE id = ?')
    .get(id) as RunHumanInterventionRow | undefined;
  return row ? toRecord(row) : null;
}

export function listRunHumanInterventionRecords(runId: string): RunHumanInterventionRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM run_human_interventions WHERE run_id = ? ORDER BY id ASC')
    .all(runId) as RunHumanInterventionRow[];
  return rows.map(toRecord);
}

export function resolveRunHumanIntervention(
  id: number,
  status: 'resolved' | 'dismissed',
): RunHumanInterventionRecord | null {
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE run_human_interventions
    SET status = ?, resolved_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(status, now, id);
  return getRunHumanInterventionRecord(id);
}

export function reconcilePendingRunHumanInterventions(): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE run_human_interventions
    SET status = 'dismissed',
        resolved_at = COALESCE(resolved_at, ?)
    WHERE status = 'pending'
  `).run(now);
}

function toRecord(row: RunHumanInterventionRow): RunHumanInterventionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    interventionType: row.intervention_type as RunHumanInterventionRecord['interventionType'],
    target: row.target || undefined,
    summary: row.summary,
    instructions: row.instructions || undefined,
    request: safeParse(row.request_json),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || undefined,
  };
}

function safeParse(json: string): Record<string, any> {
  try {
    return JSON.parse(json || '{}') as Record<string, any>;
  } catch {
    return {};
  }
}
