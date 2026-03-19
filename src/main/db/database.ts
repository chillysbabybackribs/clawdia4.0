/**
 * Database — SQLite via better-sqlite3.
 * Single database file at ~/.config/clawdia/data.sqlite
 * 
 * Tables:
 *   conversations  — id, title, created_at, updated_at
 *   messages       — id, conversation_id, role, content, tool_calls, created_at
 *   user_memory    — id, category, key, value, source, confidence, created_at
 *   user_memory_fts — FTS5 virtual table for relevance search
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

let db: Database.Database | null = null;

function getDbPath(): string {
  const configDir = path.join(app.getPath('userData'));
  fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, 'data.sqlite');
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  console.log(`[DB] Opening database at ${dbPath}`);
  db = new Database(dbPath);

  // Performance: WAL mode + synchronous NORMAL
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    console.log('[DB] Database closed');
  }
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

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
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'extracted',
        confidence INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(category, key)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_category ON user_memory(category);

      CREATE VIRTUAL TABLE IF NOT EXISTS user_memory_fts
        USING fts5(key, value, content=user_memory, content_rowid=id);

      -- Keep FTS5 in sync
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON user_memory BEGIN
        INSERT INTO user_memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON user_memory BEGIN
        INSERT INTO user_memory_fts(user_memory_fts, rowid, key, value) VALUES('delete', old.id, old.key, old.value);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON user_memory BEGIN
        INSERT INTO user_memory_fts(user_memory_fts, rowid, key, value) VALUES('delete', old.id, old.key, old.value);
        INSERT INTO user_memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
      END;

      INSERT INTO schema_version (version) VALUES (2);
    `);
  }

  console.log(`[DB] Schema at version ${Math.max(currentVersion, 2)}`);
}
