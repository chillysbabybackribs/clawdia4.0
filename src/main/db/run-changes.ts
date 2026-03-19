/**
 * Run Changes — normalized reviewable changes for a run.
 */

import { getDb } from './database';

export interface RunChangeRecord {
  id: number;
  runId: string;
  eventId?: number;
  changeType: string;
  target: string;
  summary: string;
  diffText?: string;
  createdAt: string;
}

export function createRunChange(input: {
  runId: string;
  eventId?: number;
  changeType: string;
  target: string;
  summary: string;
  diffText?: string;
}): number {
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO run_changes (
      run_id, event_id, change_type, target, summary, diff_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.eventId || null,
    input.changeType,
    input.target,
    input.summary,
    input.diffText || null,
    now,
  );

  return Number(result.lastInsertRowid);
}

export function listRunChanges(runId: string): RunChangeRecord[] {
  return (getDb().prepare(`
    SELECT
      id,
      run_id as runId,
      event_id as eventId,
      change_type as changeType,
      target,
      summary,
      diff_text as diffText,
      created_at as createdAt
    FROM run_changes
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(runId)) as RunChangeRecord[];
}

export function deleteRunChanges(runId: string): void {
  getDb().prepare('DELETE FROM run_changes WHERE run_id = ?').run(runId);
}

export function buildTextDiff(before: string | null, after: string | null): string {
  const beforeLines = (before || '').split('\n');
  const afterLines = (after || '').split('\n');

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }

  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix--;
    afterSuffix--;
  }

  const removed = beforeLines.slice(prefix, beforeSuffix + 1).map(line => `- ${line}`);
  const added = afterLines.slice(prefix, afterSuffix + 1).map(line => `+ ${line}`);
  const diff = [...removed, ...added].join('\n').trim();

  if (!diff) return '(No textual diff available)';
  if (diff.length > 5000) return diff.slice(0, 5000) + '\n... [diff truncated]';
  return diff;
}
