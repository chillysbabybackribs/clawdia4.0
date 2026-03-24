/**
 * Runs — durable task execution history.
 *
 * Phase 1 keeps the current in-memory process UX, but persists the underlying
 * run metadata so detached/completed work remains available after restart.
 */

import { getDb } from './database';
import type { ProviderId, WorkflowStage } from '../../shared/types';
import { maybeRecordSequence } from '../agent/bloodhound/recorder';

export type RunStatus = 'running' | 'awaiting_approval' | 'needs_human' | 'completed' | 'failed' | 'cancelled';

export interface RunRow {
  id: string;
  conversation_id: string;
  title: string;
  goal: string;
  status: RunStatus;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  tool_call_count: number;
  error: string | null;
  was_detached: number;
  provider: string | null;
  model: string | null;
  workflow_stage: string;
}

export interface RunRecord {
  id: string;
  conversationId: string;
  title: string;
  goal: string;
  status: RunStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  toolCallCount: number;
  error?: string;
  wasDetached: boolean;
  provider?: ProviderId;
  model?: string;
  workflowStage?: WorkflowStage;
}

export function createRun(id: string, conversationId: string, goal: string, provider?: ProviderId, model?: string): RunRow {
  const db = getDb();
  const now = new Date().toISOString();
  const title = goal.length > 80 ? goal.slice(0, 77) + '...' : goal;

  db.prepare(`
    INSERT INTO runs (
      id, conversation_id, title, goal, status,
      started_at, updated_at, tool_call_count, was_detached, provider, model, workflow_stage
    ) VALUES (?, ?, ?, ?, 'running', ?, ?, 0, 0, ?, ?, 'starting')
  `).run(id, conversationId, title, goal, now, now, provider || null, model || null);

  return {
    id,
    conversation_id: conversationId,
    title,
    goal,
    status: 'running',
    started_at: now,
    updated_at: now,
    completed_at: null,
    tool_call_count: 0,
    error: null,
    was_detached: 0,
    provider: provider || null,
    model: model || null,
    workflow_stage: 'starting',
  };
}

export function getRun(id: string): RunRow | null {
  return (getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow) || null;
}

export function listRuns(limit = 100): RunRow[] {
  return getDb()
    .prepare('SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as RunRow[];
}

export function getRunRecord(id: string): RunRecord | null {
  const row = getRun(id);
  return row ? toRunRecord(row) : null;
}

export function listRunRecords(limit = 100): RunRecord[] {
  return listRuns(limit).map(toRunRecord);
}

export function completeRun(id: string, status: Exclude<RunStatus, 'running' | 'awaiting_approval' | 'needs_human'>, error?: string): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE runs
    SET status = ?, error = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(status, error || null, now, now, id);

  // Non-blocking — Bloodhound records qualifying runs async
  maybeRecordSequence(id, status).catch(err =>
    console.warn('[Bloodhound] recording failed silently:', err.message)
  );
}

export function setRunStatus(id: string, status: Extract<RunStatus, 'running' | 'awaiting_approval' | 'needs_human'>, error?: string): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE runs
    SET status = ?,
        error = COALESCE(?, error),
        completed_at = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(status, error || null, now, id);
}

export function incrementRunToolCount(id: string): void {
  getDb().prepare(`
    UPDATE runs
    SET tool_call_count = tool_call_count + 1,
        updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id);
}

export function setRunDetached(id: string, wasDetached: boolean): void {
  getDb().prepare(`
    UPDATE runs
    SET was_detached = ?, updated_at = ?
    WHERE id = ?
  `).run(wasDetached ? 1 : 0, new Date().toISOString(), id);
}

export function setRunExecutionInfo(id: string, provider: ProviderId, model: string): void {
  getDb().prepare(`
    UPDATE runs
    SET provider = ?, model = ?, updated_at = ?
    WHERE id = ?
  `).run(provider, model, new Date().toISOString(), id);
}

export function setRunWorkflowStage(id: string, workflowStage: WorkflowStage): void {
  getDb().prepare(`
    UPDATE runs
    SET workflow_stage = ?, updated_at = ?
    WHERE id = ?
  `).run(workflowStage, new Date().toISOString(), id);
}

export function reconcileInterruptedRuns(reason = 'Clawdia restarted before this run completed.'): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE runs
    SET status = 'failed',
        error = COALESCE(error, ?),
        completed_at = COALESCE(completed_at, ?),
        updated_at = ?
    WHERE status IN ('running', 'awaiting_approval', 'needs_human')
  `).run(reason, now, now);
}

export function deleteRun(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM run_approvals WHERE run_id = ?').run(id);
  db.prepare('DELETE FROM run_human_interventions WHERE run_id = ?').run(id);
  db.prepare('DELETE FROM run_file_locks WHERE run_id = ?').run(id);
  db.prepare('DELETE FROM run_changes WHERE run_id = ?').run(id);
  db.prepare('DELETE FROM run_events WHERE run_id = ?').run(id);
  db.prepare('DELETE FROM task_sequences WHERE run_id = ?').run(id);
  db.prepare('DELETE FROM runs WHERE id = ?').run(id);
}

export function evictOldRuns(maxHistory: number): void {
  const db = getDb();
  const oldDone = db.prepare(`
    SELECT id
    FROM runs
    WHERE status != 'running'
    ORDER BY COALESCE(completed_at, updated_at) DESC
    LIMIT -1 OFFSET ?
  `).all(maxHistory) as Array<{ id: string }>;

  if (oldDone.length === 0) return;
  const del = db.prepare('DELETE FROM runs WHERE id = ?');
  const delApprovals = db.prepare('DELETE FROM run_approvals WHERE run_id = ?');
  const delHuman = db.prepare('DELETE FROM run_human_interventions WHERE run_id = ?');
  const delLocks = db.prepare('DELETE FROM run_file_locks WHERE run_id = ?');
  const delChanges = db.prepare('DELETE FROM run_changes WHERE run_id = ?');
  const delEvents = db.prepare('DELETE FROM run_events WHERE run_id = ?');
  const delTaskSequences = db.prepare('DELETE FROM task_sequences WHERE run_id = ?');
  const tx = db.transaction((rows: Array<{ id: string }>) => {
    for (const row of rows) {
      delApprovals.run(row.id);
      delHuman.run(row.id);
      delLocks.run(row.id);
      delChanges.run(row.id);
      delEvents.run(row.id);
      delTaskSequences.run(row.id);
      del.run(row.id);
    }
  });
  tx(oldDone);
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    startedAt: new Date(row.started_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined,
    toolCallCount: row.tool_call_count,
    error: row.error || undefined,
    wasDetached: !!row.was_detached,
    provider: (row.provider as ProviderId | null) || undefined,
    model: row.model || undefined,
    workflowStage: (row.workflow_stage as WorkflowStage | null) || 'starting',
  };
}
