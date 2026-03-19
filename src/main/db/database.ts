/**
 * Database — SQLite via better-sqlite3.
 * Single database file at ~/.config/clawdia/data.sqlite
 * 
 * Tables:
 *   conversations    — id, title, created_at, updated_at (v1)
 *   messages         — id, conversation_id, role, content, tool_calls, created_at (v1)
 *   messages_fts     — FTS5 on messages for cross-conversation recall (v6)
 *   user_memory      — id, category, key, value, source, confidence, created_at (v2)
 *   user_memory_fts  — FTS5 virtual table for relevance search (v2)
 *   app_registry     — id, profile_json, last_scanned (v3)
 *   coordinate_cache — app, window_key, element, x, y, confidence (v4)
 *   site_profiles    — domain, auth_status, visit_count, nav_hints, account_info (v7)
 *   browser_playbooks— domain, task_pattern, steps, success_count, fail_count (v8)
 *   runs             — durable task runs for detached/reviewable execution history (v9)
 *   run_events       — structured durable run event log (v10)
 *   run_changes      — reviewable normalized change records (v11)
 *   run_approvals    — durable approval checkpoints for sensitive actions (v12)
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

let db: Database.Database | null = null;

function getDbPath(): string {
  // Allow override for testing outside Electron
  if (process.env.CLAWDIA_DB_PATH) {
    const dir = path.dirname(process.env.CLAWDIA_DB_PATH);
    fs.mkdirSync(dir, { recursive: true });
    return process.env.CLAWDIA_DB_PATH;
  }
  const configDir = path.join(app.getPath('userData'));
  fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, 'data.sqlite');
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  console.log(`[DB] Opening database at ${dbPath}`);
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

export function closeDb(): void {
  if (db) { db.close(); db = null; console.log('[DB] Database closed'); }
}

function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);`);

  const currentVersion = (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as any)?.v || 0;

  if (currentVersion < 1) {
    console.log('[DB] Running migration v1: conversations + messages');
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New Chat',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL DEFAULT '',
        tool_calls TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
      INSERT INTO schema_version (version) VALUES (1);
    `);
  }

  if (currentVersion < 2) {
    console.log('[DB] Running migration v2: user_memory + FTS5');
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'extracted', confidence INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(category, key)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_category ON user_memory(category);
      CREATE VIRTUAL TABLE IF NOT EXISTS user_memory_fts USING fts5(key, value, content=user_memory, content_rowid=id);
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON user_memory BEGIN
        INSERT INTO user_memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value); END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON user_memory BEGIN
        INSERT INTO user_memory_fts(user_memory_fts, rowid, key, value) VALUES('delete', old.id, old.key, old.value); END;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON user_memory BEGIN
        INSERT INTO user_memory_fts(user_memory_fts, rowid, key, value) VALUES('delete', old.id, old.key, old.value);
        INSERT INTO user_memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value); END;
      INSERT INTO schema_version (version) VALUES (2);
    `);
  }

  if (currentVersion < 3) {
    console.log('[DB] Running migration v3: app_registry');
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_registry (
        id TEXT PRIMARY KEY,
        profile_json TEXT NOT NULL,
        last_scanned TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (3);
    `);
  }

  if (currentVersion < 4) {
    console.log('[DB] Running migration v4: coordinate_cache');
    db.exec(`
      CREATE TABLE IF NOT EXISTS coordinate_cache (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        app        TEXT    NOT NULL,
        window_key TEXT    NOT NULL,
        element    TEXT    NOT NULL,
        x          INTEGER NOT NULL,
        y          INTEGER NOT NULL,
        confidence REAL    NOT NULL DEFAULT 1.0,
        hit_count  INTEGER NOT NULL DEFAULT 1,
        last_used  TEXT    NOT NULL DEFAULT (datetime('now')),
        created_at TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(app, window_key, element)
      );
      CREATE INDEX IF NOT EXISTS idx_coord_app ON coordinate_cache(app, window_key);
      INSERT INTO schema_version (version) VALUES (4);
    `);
  }

  if (currentVersion < 5) {
    console.log('[DB] Running migration v5: coordinate_cache.resolution column');
    db.exec(`
      ALTER TABLE coordinate_cache ADD COLUMN resolution TEXT;
      INSERT INTO schema_version (version) VALUES (5);
    `);
  }

  if (currentVersion < 6) {
    console.log('[DB] Running migration v6: message FTS for cross-conversation recall');
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content=messages,
        content_rowid=rowid
      );

      -- Populate FTS from existing messages
      INSERT OR IGNORE INTO messages_fts(rowid, content)
        SELECT rowid, content FROM messages WHERE role = 'user';

      -- Keep FTS in sync on new messages
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
      WHEN new.role = 'user' BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;

      INSERT INTO schema_version (version) VALUES (6);
    `);
  }

  if (currentVersion < 7) {
    console.log('[DB] Running migration v7: site_profiles for browser session awareness');
    db.exec(`
      CREATE TABLE IF NOT EXISTS site_profiles (
        domain        TEXT PRIMARY KEY,
        display_name  TEXT NOT NULL DEFAULT '',
        auth_status   TEXT NOT NULL DEFAULT 'unknown',
        last_visited  TEXT NOT NULL DEFAULT (datetime('now')),
        visit_count   INTEGER NOT NULL DEFAULT 0,
        nav_hints     TEXT NOT NULL DEFAULT '{}',
        account_info  TEXT NOT NULL DEFAULT '{}',
        page_map      TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_site_visits ON site_profiles(visit_count DESC);
      INSERT INTO schema_version (version) VALUES (7);
    `);
  }

  if (currentVersion < 8) {
    console.log('[DB] Running migration v8: browser_playbooks for learned navigation patterns');
    db.exec(`
      CREATE TABLE IF NOT EXISTS browser_playbooks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        domain        TEXT NOT NULL,
        task_pattern  TEXT NOT NULL,
        steps         TEXT NOT NULL DEFAULT '[]',
        success_count INTEGER NOT NULL DEFAULT 1,
        fail_count    INTEGER NOT NULL DEFAULT 0,
        last_used     TEXT NOT NULL DEFAULT (datetime('now')),
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(domain, task_pattern)
      );
      CREATE INDEX IF NOT EXISTS idx_playbook_domain ON browser_playbooks(domain, success_count DESC);
      INSERT INTO schema_version (version) VALUES (8);
    `);
  }

  if (currentVersion < 9) {
    console.log('[DB] Running migration v9: durable runs');
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        title            TEXT NOT NULL,
        goal             TEXT NOT NULL,
        status           TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
        started_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        completed_at     TEXT,
        tool_call_count  INTEGER NOT NULL DEFAULT 0,
        error            TEXT,
        was_detached     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_runs_conversation ON runs(conversation_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_updated_at ON runs(updated_at DESC);
      INSERT INTO schema_version (version) VALUES (9);
    `);
  }

  if (currentVersion < 10) {
    console.log('[DB] Running migration v10: run_events');
    db.exec(`
      CREATE TABLE IF NOT EXISTS run_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id       TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        ts           TEXT NOT NULL,
        kind         TEXT NOT NULL,
        phase        TEXT,
        surface      TEXT,
        tool_name    TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq ASC);
      CREATE INDEX IF NOT EXISTS idx_run_events_kind ON run_events(kind, ts DESC);
      INSERT INTO schema_version (version) VALUES (10);
    `);
  }

  if (currentVersion < 11) {
    console.log('[DB] Running migration v11: run_changes');
    db.exec(`
      CREATE TABLE IF NOT EXISTS run_changes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id       TEXT NOT NULL,
        event_id     INTEGER,
        change_type  TEXT NOT NULL,
        target       TEXT NOT NULL,
        summary      TEXT NOT NULL,
        diff_text    TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_changes_run_id ON run_changes(run_id, id ASC);
      CREATE INDEX IF NOT EXISTS idx_run_changes_change_type ON run_changes(change_type, created_at DESC);
      INSERT INTO schema_version (version) VALUES (11);
    `);
  }

  if (currentVersion < 12) {
    console.log('[DB] Running migration v12: awaiting-approval runs + run_approvals');
    db.exec(`
      ALTER TABLE runs RENAME TO runs_old;

      CREATE TABLE IF NOT EXISTS runs (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        title            TEXT NOT NULL,
        goal             TEXT NOT NULL,
        status           TEXT NOT NULL CHECK(status IN ('running', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
        started_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        completed_at     TEXT,
        tool_call_count  INTEGER NOT NULL DEFAULT 0,
        error            TEXT,
        was_detached     INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO runs (
        id, conversation_id, title, goal, status,
        started_at, updated_at, completed_at, tool_call_count, error, was_detached
      )
      SELECT
        id, conversation_id, title, goal, status,
        started_at, updated_at, completed_at, tool_call_count, error, was_detached
      FROM runs_old;

      DROP TABLE runs_old;

      CREATE INDEX IF NOT EXISTS idx_runs_conversation ON runs(conversation_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_updated_at ON runs(updated_at DESC);

      CREATE TABLE IF NOT EXISTS run_approvals (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id        TEXT NOT NULL,
        status        TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied')),
        action_type   TEXT NOT NULL,
        target        TEXT NOT NULL,
        summary       TEXT NOT NULL,
        request_json  TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL,
        resolved_at   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_run_approvals_run_id ON run_approvals(run_id, id ASC);
      CREATE INDEX IF NOT EXISTS idx_run_approvals_status ON run_approvals(status, created_at DESC);

      INSERT INTO schema_version (version) VALUES (12);
    `);
  }

  console.log(`[DB] Schema at version ${Math.max(currentVersion, 12)}`);
}
