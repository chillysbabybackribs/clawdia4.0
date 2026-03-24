/**
 * task-sequences — Learned multi-surface task sequences.
 *
 * Records distilled tool sequences from any completed agent run that
 * meets the recording threshold. Used by Bloodhound v2 for retrieval
 * and replay in subsequent sub-projects.
 */

import { getDb } from './database';

export type Surface = 'browser' | 'filesystem' | 'shell' | 'desktop' | 'swarm' | 'memory' | 'other';

export interface SequenceStep {
  seq: number;
  surface: Surface;
  tool: string;
  input: Record<string, any>;
  outputSummary: string;
  durationMs: number;
  success: boolean;
}

export interface TaskSequence {
  id: number;
  runId: string;
  goal: string;
  goalEmbedding: Float32Array | null;
  surfaces: Surface[];
  steps: SequenceStep[];
  outcome: 'success' | 'partial' | 'failed';
  toolCallCount: number;
  durationMs: number;
  successCount: number;
  failCount: number;
  lastUsed: string | null;
  createdAt: string;
}

export type NewTaskSequence = Omit<TaskSequence, 'id' | 'goalEmbedding' | 'successCount' | 'failCount' | 'lastUsed'>;

export function insertTaskSequence(row: NewTaskSequence): number {
  const result = getDb().prepare(`
    INSERT INTO task_sequences
      (run_id, goal, surfaces, steps, outcome, tool_call_count, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.runId,
    row.goal,
    JSON.stringify(row.surfaces),
    JSON.stringify(row.steps),
    row.outcome,
    row.toolCallCount,
    row.durationMs,
    row.createdAt,
  );
  return result.lastInsertRowid as number;
}

export function updateTaskSequenceSteps(id: number, steps: SequenceStep[]): void {
  getDb().prepare(`UPDATE task_sequences SET steps = ? WHERE id = ?`)
    .run(JSON.stringify(steps), id);
}

export function updateTaskSequenceEmbedding(id: number, embedding: Float32Array): void {
  getDb().prepare(`UPDATE task_sequences SET goal_embedding = ? WHERE id = ?`)
    .run(Buffer.from(embedding.buffer), id);
}

export function getTaskSequence(id: number): TaskSequence | null {
  const row = getDb().prepare(`SELECT * FROM task_sequences WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return rowToTaskSequence(row);
}

export function listTaskSequences(limit = 100): TaskSequence[] {
  const rows = getDb().prepare(`
    SELECT * FROM task_sequences ORDER BY created_at DESC LIMIT ?
  `).all(limit) as any[];
  return rows.map(rowToTaskSequence);
}

function rowToTaskSequence(row: any): TaskSequence {
  return {
    id: row.id,
    runId: row.run_id,
    goal: row.goal,
    goalEmbedding: row.goal_embedding
      ? (() => { const buf = Buffer.from(row.goal_embedding); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT); })()
      : null,
    surfaces: JSON.parse(row.surfaces || '[]'),
    steps: JSON.parse(row.steps || '[]'),
    outcome: row.outcome,
    toolCallCount: row.tool_call_count,
    durationMs: row.duration_ms,
    successCount: row.success_count,
    failCount: row.fail_count,
    lastUsed: row.last_used,
    createdAt: row.created_at,
  };
}
