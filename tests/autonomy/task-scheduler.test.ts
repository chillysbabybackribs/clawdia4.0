import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (b: Buffer) => b.toString() },
  app: { getPath: () => os.tmpdir() },
}));

// Mock node-cron so tests don't actually schedule.
// Include validate + __esModule:true so the default import resolves correctly
// and scheduleTask's cron.validate() call doesn't throw.
vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(() => ({ stop: vi.fn() })),
    validate: vi.fn(() => true),
  },
  __esModule: true,
}));

let tmpPath: string;
beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `clawdia-sched-test-${Date.now()}.sqlite`);
  process.env.CLAWDIA_DB_PATH = tmpPath;
  vi.resetModules();
});
afterEach(async () => {
  const { closeDb } = await import('../../src/main/db/database');
  closeDb();
  delete process.env.CLAWDIA_DB_PATH;
  try { fs.unlinkSync(tmpPath); } catch {}
  try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
  try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
});

describe('TaskScheduler', () => {
  it('creates a scheduled task and persists it', async () => {
    const { TaskScheduler } = await import('../../src/main/autonomy/task-scheduler');
    const scheduler = new TaskScheduler();
    const task = scheduler.createTask({ name: 'Daily briefing', cronExpr: '0 9 * * *', prompt: 'Give me a morning briefing' });
    expect(task.id).toBeGreaterThan(0);
    expect(task.name).toBe('Daily briefing');
  });

  it('lists all tasks', async () => {
    const { TaskScheduler } = await import('../../src/main/autonomy/task-scheduler');
    const scheduler = new TaskScheduler();
    scheduler.createTask({ name: 'Task A', cronExpr: '* * * * *', prompt: 'Do A' });
    scheduler.createTask({ name: 'Task B', cronExpr: '* * * * *', prompt: 'Do B' });
    expect(scheduler.listTasks()).toHaveLength(2);
  });

  it('records a task run', async () => {
    const { TaskScheduler } = await import('../../src/main/autonomy/task-scheduler');
    const scheduler = new TaskScheduler();
    const task = scheduler.createTask({ name: 'Test', cronExpr: '* * * * *', prompt: 'test' });
    const run = scheduler.recordRun(task.id, 'completed', 'done');
    expect(run.taskId).toBe(task.id);
    expect(run.status).toBe('completed');
  });

  it('evicts runs older than 30 days', async () => {
    const { getDb } = await import('../../src/main/db/database');
    const { TaskScheduler } = await import('../../src/main/autonomy/task-scheduler');
    const scheduler = new TaskScheduler();
    const task = scheduler.createTask({ name: 'Old', cronExpr: '* * * * *', prompt: 'old task' });
    // Insert an old run directly
    getDb().prepare(`INSERT INTO scheduled_task_runs (task_id, status, started_at, completed_at) VALUES (?, 'completed', datetime('now', '-31 days'), datetime('now', '-31 days'))`).run(task.id);
    const before = scheduler.listRuns(task.id);
    expect(before).toHaveLength(1);
    scheduler.evictOldRuns();
    const after = scheduler.listRuns(task.id);
    expect(after).toHaveLength(0);
  });
});
