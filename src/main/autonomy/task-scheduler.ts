/**
 * TaskScheduler — time-based and completion-triggered autonomous task scheduling.
 *
 * Uses node-cron for time-based triggers.
 * Runs execute via process-manager as background agents.
 * Audit log retained 30 days (evictOldRuns called at init).
 */
import cron from 'node-cron';
import { getDb } from '../db/database';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScheduledTask {
  id: number;
  name: string;
  description: string;
  cronExpr?: string;
  triggerType: 'time' | 'completion';
  triggerAfterTaskId?: number;
  prompt: string;
  enabled: boolean;
  requiresApproval: boolean;
  approved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskRun {
  id: number;
  taskId: number;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  startedAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export interface CreateTaskInput {
  name: string;
  description?: string;
  cronExpr?: string;
  triggerType?: 'time' | 'completion';
  triggerAfterTaskId?: number;
  prompt: string;
  requiresApproval?: boolean;
}

// ─── TaskScheduler ────────────────────────────────────────────────────────────

export class TaskScheduler {
  private jobs = new Map<number, ReturnType<typeof cron.schedule>>();

  constructor() {
    this.evictOldRuns();
  }

  // ── Task CRUD ──

  createTask(input: CreateTaskInput): ScheduledTask {
    const now = new Date().toISOString();
    const result = getDb().prepare(`
      INSERT INTO scheduled_tasks
        (name, description, cron_expr, trigger_type, trigger_after_task_id, prompt, requires_approval, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      input.description ?? '',
      input.cronExpr ?? null,
      input.triggerType ?? 'time',
      input.triggerAfterTaskId ?? null,
      input.prompt,
      input.requiresApproval ? 1 : 0,
      now,
      now,
    );
    return this.getTask(result.lastInsertRowid as number)!;
  }

  getTask(id: number): ScheduledTask | null {
    const row = getDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as any;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(): ScheduledTask[] {
    return (getDb().prepare('SELECT * FROM scheduled_tasks ORDER BY id ASC').all() as any[]).map(this.rowToTask);
  }

  enableTask(id: number, enabled: boolean): void {
    getDb().prepare('UPDATE scheduled_tasks SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?').run(enabled ? 1 : 0, id);
    if (!enabled) {
      this.jobs.get(id)?.stop();
      this.jobs.delete(id);
    }
  }

  deleteTask(id: number): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  }

  // ── Scheduling ──

  /**
   * Start cron jobs for all enabled time-based tasks.
   * Call this at app startup after process-manager is initialized.
   */
  start(runTask: (prompt: string, taskId: number) => Promise<void>): void {
    const tasks = this.listTasks().filter(t => t.enabled && t.triggerType === 'time' && t.cronExpr);
    for (const task of tasks) {
      this.scheduleTask(task, runTask);
    }
    console.log(`[Scheduler] Started ${tasks.length} scheduled tasks`);
  }

  private scheduleTask(task: ScheduledTask, runTask: (prompt: string, taskId: number) => Promise<void>): void {
    if (!task.cronExpr || !cron.validate(task.cronExpr)) {
      console.warn(`[Scheduler] Invalid cron expr for task ${task.id}: ${task.cronExpr}`);
      return;
    }
    const job = cron.schedule(task.cronExpr, async () => {
      if (task.requiresApproval && !task.approved) {
        this.recordRun(task.id, 'skipped', undefined, 'Requires approval — not yet approved');
        return;
      }
      const run = this.recordRun(task.id, 'running');
      try {
        await runTask(task.prompt, task.id);
        this.updateRun(run.id, 'completed');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.updateRun(run.id, 'failed', undefined, msg);
      }
    });
    this.jobs.set(task.id, job);
  }

  // ── Runs ──

  recordRun(taskId: number, status: ScheduledTaskRun['status'], result?: string, error?: string): ScheduledTaskRun {
    const now = new Date().toISOString();
    const res = getDb().prepare(`
      INSERT INTO scheduled_task_runs (task_id, status, started_at, result, error)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, status, now, result ?? null, error ?? null);
    return this.getRun(res.lastInsertRowid as number)!;
  }

  updateRun(runId: number, status: ScheduledTaskRun['status'], result?: string, error?: string): void {
    getDb().prepare(`
      UPDATE scheduled_task_runs SET status = ?, completed_at = datetime('now'), result = ?, error = ? WHERE id = ?
    `).run(status, result ?? null, error ?? null, runId);
  }

  getRun(id: number): ScheduledTaskRun | null {
    const row = getDb().prepare('SELECT * FROM scheduled_task_runs WHERE id = ?').get(id) as any;
    return row ? this.rowToRun(row) : null;
  }

  listRuns(taskId: number): ScheduledTaskRun[] {
    return (getDb().prepare('SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC').all(taskId) as any[]).map(this.rowToRun);
  }

  /** Evict runs older than 30 days. Called at init. */
  evictOldRuns(): void {
    try {
      getDb().prepare(`DELETE FROM scheduled_task_runs WHERE started_at < datetime('now', '-30 days')`).run();
    } catch {
      // Table may not exist yet during first init — migrations run after module load
    }
  }

  // ── Helpers ──

  private rowToTask(row: any): ScheduledTask {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      cronExpr: row.cron_expr ?? undefined,
      triggerType: row.trigger_type,
      triggerAfterTaskId: row.trigger_after_task_id ?? undefined,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      requiresApproval: row.requires_approval === 1,
      approved: row.approved === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToRun(row: any): ScheduledTaskRun {
    return {
      id: row.id,
      taskId: row.task_id,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
    };
  }
}

// Singleton
export const taskScheduler = new TaskScheduler();
