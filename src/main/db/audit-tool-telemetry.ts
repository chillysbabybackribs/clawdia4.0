import { getDb } from './database';

export type AuditLoopOutcome = 'completed' | 'failed' | 'aborted' | 'cancelled';

export interface AuditToolTelemetryRow {
  id: number;
  run_id: string;
  timestamp: string;
  iteration_index: number;
  tool_name: string;
  tool_category: string | null;
  success: number;
  duration_ms: number;
  error_type: string | null;
  approval_required: number;
  recovery_invoked: number;
  intervention_triggered: number;
  intervention_resolved: number;
  sub_agent_spawned: number;
  loop_outcome: AuditLoopOutcome | null;
}

export interface AuditToolTelemetryRecord {
  id: number;
  runId: string;
  timestamp: string;
  iterationIndex: number;
  toolName: string;
  toolCategory?: string;
  success: boolean;
  durationMs: number;
  errorType?: string;
  approvalRequired: boolean;
  recoveryInvoked: boolean;
  interventionTriggered: boolean;
  interventionResolved: boolean;
  subAgentSpawned: boolean;
  loopOutcome?: AuditLoopOutcome;
}

export interface InsertAuditToolTelemetryInput {
  runId: string;
  iterationIndex: number;
  toolName: string;
  toolCategory?: string | null;
  success: boolean;
  durationMs: number;
  errorType?: string | null;
  approvalRequired?: boolean;
  recoveryInvoked?: boolean;
  interventionTriggered?: boolean;
  interventionResolved?: boolean;
  subAgentSpawned?: boolean;
}

export function insertAuditToolTelemetry(input: InsertAuditToolTelemetryInput): number {
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO audit_tool_telemetry (
      run_id,
      timestamp,
      iteration_index,
      tool_name,
      tool_category,
      success,
      duration_ms,
      error_type,
      approval_required,
      recovery_invoked,
      intervention_triggered,
      intervention_resolved,
      sub_agent_spawned,
      loop_outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    input.runId,
    now,
    input.iterationIndex,
    input.toolName,
    input.toolCategory || null,
    input.success ? 1 : 0,
    Math.max(0, Math.round(input.durationMs)),
    input.errorType || null,
    input.approvalRequired ? 1 : 0,
    input.recoveryInvoked ? 1 : 0,
    input.interventionTriggered ? 1 : 0,
    input.interventionResolved ? 1 : 0,
    input.subAgentSpawned ? 1 : 0,
  );

  return Number(result.lastInsertRowid);
}

export function setAuditRunOutcome(runId: string, loopOutcome: AuditLoopOutcome): void {
  getDb().prepare(`
    UPDATE audit_tool_telemetry
    SET loop_outcome = ?
    WHERE run_id = ?
  `).run(loopOutcome, runId);
}

export function listRecentAuditToolTelemetry(limit = 100): AuditToolTelemetryRecord[] {
  return (getDb().prepare(`
    SELECT *
    FROM audit_tool_telemetry
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(limit) as AuditToolTelemetryRow[]).map(toAuditToolTelemetryRecord);
}

export function deleteAuditToolTelemetryForRun(runId: string): void {
  getDb().prepare('DELETE FROM audit_tool_telemetry WHERE run_id = ?').run(runId);
}

function toAuditToolTelemetryRecord(row: AuditToolTelemetryRow): AuditToolTelemetryRecord {
  return {
    id: row.id,
    runId: row.run_id,
    timestamp: row.timestamp,
    iterationIndex: row.iteration_index,
    toolName: row.tool_name,
    toolCategory: row.tool_category || undefined,
    success: row.success === 1,
    durationMs: row.duration_ms,
    errorType: row.error_type || undefined,
    approvalRequired: row.approval_required === 1,
    recoveryInvoked: row.recovery_invoked === 1,
    interventionTriggered: row.intervention_triggered === 1,
    interventionResolved: row.intervention_resolved === 1,
    subAgentSpawned: row.sub_agent_spawned === 1,
    loopOutcome: row.loop_outcome || undefined,
  };
}
