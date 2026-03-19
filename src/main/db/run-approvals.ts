import { getDb } from './database';

export type RunApprovalStatus = 'pending' | 'approved' | 'denied';

export interface RunApprovalRow {
  id: number;
  run_id: string;
  status: RunApprovalStatus;
  action_type: string;
  target: string;
  summary: string;
  request_json: string;
  created_at: string;
  resolved_at: string | null;
}

export interface RunApprovalRecord {
  id: number;
  runId: string;
  status: RunApprovalStatus;
  actionType: string;
  target: string;
  summary: string;
  request: Record<string, any>;
  createdAt: string;
  resolvedAt?: string;
}

export function createRunApproval(
  runId: string,
  input: {
    actionType: string;
    target: string;
    summary: string;
    request?: Record<string, any>;
  },
): RunApprovalRecord {
  const db = getDb();
  const createdAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO run_approvals (
      run_id, status, action_type, target, summary, request_json, created_at
    ) VALUES (?, 'pending', ?, ?, ?, ?, ?)
  `).run(
    runId,
    input.actionType,
    input.target,
    input.summary,
    JSON.stringify(input.request || {}),
    createdAt,
  );

  return {
    id: Number(result.lastInsertRowid),
    runId,
    status: 'pending',
    actionType: input.actionType,
    target: input.target,
    summary: input.summary,
    request: input.request || {},
    createdAt,
  };
}

export function listRunApprovalRecords(runId: string): RunApprovalRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM run_approvals WHERE run_id = ? ORDER BY id ASC')
    .all(runId) as RunApprovalRow[];
  return rows.map(toRunApprovalRecord);
}

export function getRunApprovalRecord(id: number): RunApprovalRecord | null {
  const row = getDb().prepare('SELECT * FROM run_approvals WHERE id = ?').get(id) as RunApprovalRow | undefined;
  return row ? toRunApprovalRecord(row) : null;
}

export function resolveRunApproval(id: number, status: Exclude<RunApprovalStatus, 'pending'>): RunApprovalRecord | null {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE run_approvals
    SET status = ?, resolved_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(status, now, id);
  return getRunApprovalRecord(id);
}

export function reconcilePendingRunApprovals(reason = 'Clawdia restarted before this approval was resolved.'): void {
  const db = getDb();
  const now = new Date().toISOString();
  const pending = db.prepare(`
    SELECT id, request_json FROM run_approvals WHERE status = 'pending'
  `).all() as Array<{ id: number; request_json: string }>;

  const update = db.prepare(`
    UPDATE run_approvals
    SET status = 'denied', request_json = ?, resolved_at = ?
    WHERE id = ?
  `);

  const tx = db.transaction((rows: Array<{ id: number; request_json: string }>) => {
    for (const row of rows) {
      const request = safeParse(row.request_json);
      request.reconciledReason = reason;
      update.run(JSON.stringify(request), now, row.id);
    }
  });

  tx(pending);
}

export function deleteRunApprovals(runId: string): void {
  getDb().prepare('DELETE FROM run_approvals WHERE run_id = ?').run(runId);
}

function toRunApprovalRecord(row: RunApprovalRow): RunApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    actionType: row.action_type,
    target: row.target,
    summary: row.summary,
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
