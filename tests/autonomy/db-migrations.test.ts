// vi is a global in this project (vitest.config.ts: globals: true) — no import needed.
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// We test migrations by pointing the DB at a temp file
let tmpPath: string;

beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `clawdia-test-${Date.now()}.sqlite`);
  process.env.CLAWDIA_DB_PATH = tmpPath;
  // vi.resetModules() ensures each dynamic import() below gets a fresh module
  // (including a fresh db singleton), since database.ts caches the DB instance
  // at module level.
  vi.resetModules();
});

afterEach(async () => {
  // closeDb() must be called before unlinkSync — better-sqlite3 holds an open fd.
  // We also clean up WAL/SHM side-files SQLite may have created.
  const { closeDb } = await import('../../src/main/db/database');
  closeDb();
  delete process.env.CLAWDIA_DB_PATH;
  try { fs.unlinkSync(tmpPath); } catch {}
  try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
  try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
});

describe('autonomy migrations', () => {
  it('creates identity_profiles table', async () => {
    const { getDb } = await import('../../src/main/db/database');
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='identity_profiles'").get();
    expect(row).toBeTruthy();
  });

  it('creates managed_accounts table', async () => {
    const { getDb } = await import('../../src/main/db/database');
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_accounts'").get();
    expect(row).toBeTruthy();
  });

  it('creates credential_vault table', async () => {
    const { getDb } = await import('../../src/main/db/database');
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credential_vault'").get();
    expect(row).toBeTruthy();
  });

  it('creates service_mentions table', async () => {
    const { getDb } = await import('../../src/main/db/database');
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='service_mentions'").get();
    expect(row).toBeTruthy();
  });

  it('creates scheduled_tasks table', async () => {
    const { getDb } = await import('../../src/main/db/database');
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'").get();
    expect(row).toBeTruthy();
  });

  it('creates scheduled_task_runs table', async () => {
    const { getDb } = await import('../../src/main/db/database');
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_task_runs'").get();
    expect(row).toBeTruthy();
  });
});
