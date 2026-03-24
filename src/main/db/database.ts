/**
 * Database — SQLite via better-sqlite3.
 * Single database file at ~/.config/clawdia/data.sqlite
 * 
 * Tables:
 *   conversations    — id, title, created_at, updated_at (v1)
 *   messages         — id, conversation_id, role, content, tool_calls, attachments_json, created_at (v1, v21 attachments)
 *   messages_fts     — FTS5 on messages for cross-conversation recall (v6)
 *   user_memory      — id, category, key, value, source, confidence, created_at (v2)
 *   user_memory_fts  — FTS5 virtual table for relevance search (v2)
 *   app_registry     — id, profile_json, last_scanned (v3)
 *   coordinate_cache — app, window_key, element, x, y, confidence (v4)
 *   site_profiles    — domain, auth_status, visit_count, nav_hints, account_info (v7)
 *   browser_playbooks— domain, task_pattern, steps, success_count, fail_count (v8, v16 executor metadata)
 *   runs             — durable task runs for detached/reviewable execution history (v9)
 *   run_events       — structured durable run event log (v10)
 *   run_changes      — reviewable normalized change records (v11)
 *   run_approvals    — durable approval checkpoints for sensitive actions (v12)
 *   policy_profiles  — reusable policy bundles for tool governance (v13)
 *   run_human_interventions — durable human-required pauses for active runs (v14)
 *   run_file_locks   — active per-file write ownership for simultaneous runs (v15)
 *   filesystem_extractions — persistent extracted-text cache for local retrieval (v17)
 *   filesystem_extractions_fts — lexical index over extracted local text (v18)
 *   runs.provider/model — execution backend metadata (v19)
 *   runs.workflow_stage + run_artifacts — workflow planning state (v20)
 *   messages.attachments_json — uploaded image/file metadata for chat messages (v21)
 *   run_artifacts.kind widened for execution_graph_scaffold (v22)
 *   run_artifacts.kind widened for execution_graph_state (v23)
 *   identity_profiles, managed_accounts, credential_vault — identity & credential vault (v24)
 *   service_mentions — proactive service detection (v25)
 *   scheduled_tasks, scheduled_task_runs — task scheduler (v26)
 *   site_harnesses.intervention_hint + is_signup_harness — signup annotation (v27)
 *   task_sequences — distilled multi-surface task recordings for Bloodhound v2 (v28)
 *   audit_tool_telemetry — rolling per-tool runtime audit facts (v29)
 *   payment_methods, spending_budgets, spending_transactions — Clawdia Wallet (v30)
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

  if (currentVersion < 13) {
    console.log('[DB] Running migration v13: policy_profiles');
    db.exec(`
      CREATE TABLE IF NOT EXISTS policy_profiles (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        scope_type  TEXT NOT NULL CHECK(scope_type IN ('global', 'workspace', 'task_type')),
        scope_value TEXT,
        rules_json  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_policy_profiles_scope ON policy_profiles(scope_type, scope_value);

      INSERT INTO schema_version (version) VALUES (13);
    `);
  }

  if (currentVersion < 14) {
    console.log('[DB] Running migration v14: needs-human runs + run_human_interventions');
    db.exec(`
      ALTER TABLE runs RENAME TO runs_old;

      CREATE TABLE IF NOT EXISTS runs (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        title            TEXT NOT NULL,
        goal             TEXT NOT NULL,
        status           TEXT NOT NULL CHECK(status IN ('running', 'awaiting_approval', 'needs_human', 'completed', 'failed', 'cancelled')),
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

      CREATE TABLE IF NOT EXISTS run_human_interventions (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id             TEXT NOT NULL,
        status             TEXT NOT NULL CHECK(status IN ('pending', 'resolved', 'dismissed')),
        intervention_type  TEXT NOT NULL,
        target             TEXT,
        summary            TEXT NOT NULL,
        instructions       TEXT,
        request_json       TEXT NOT NULL DEFAULT '{}',
        created_at         TEXT NOT NULL,
        resolved_at        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_run_human_interventions_run_id
        ON run_human_interventions(run_id, id ASC);
      CREATE INDEX IF NOT EXISTS idx_run_human_interventions_status
        ON run_human_interventions(status, created_at DESC);

      INSERT INTO schema_version (version) VALUES (14);
    `);
  }

  if (currentVersion < 15) {
    console.log('[DB] Running migration v15: run_file_locks');
    db.exec(`
      CREATE TABLE IF NOT EXISTS run_file_locks (
        path            TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        acquired_at     TEXT NOT NULL,
        last_seen_at    TEXT NOT NULL,
        source_revision TEXT,
        lock_mode       TEXT NOT NULL DEFAULT 'write' CHECK(lock_mode IN ('write'))
      );

      CREATE INDEX IF NOT EXISTS idx_run_file_locks_run_id
        ON run_file_locks(run_id, acquired_at DESC);

      INSERT INTO schema_version (version) VALUES (15);
    `);
  }

  if (currentVersion < 16) {
    console.log('[DB] Running migration v16: browser_playbooks executor metadata');
    db.exec(`
      ALTER TABLE browser_playbooks ADD COLUMN agent_profile TEXT NOT NULL DEFAULT 'general';
      ALTER TABLE browser_playbooks ADD COLUMN success_rate REAL NOT NULL DEFAULT 1.0;
      ALTER TABLE browser_playbooks ADD COLUMN validation_runs INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE browser_playbooks ADD COLUMN avg_runtime_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE browser_playbooks ADD COLUMN avg_step_count REAL NOT NULL DEFAULT 0;
      ALTER TABLE browser_playbooks ADD COLUMN notes TEXT NOT NULL DEFAULT '[]';

      CREATE INDEX IF NOT EXISTS idx_playbook_agent_profile ON browser_playbooks(agent_profile, domain, success_count DESC);

      INSERT INTO schema_version (version) VALUES (16);
    `);
  }

  if (currentVersion < 17) {
    console.log('[DB] Running migration v17: filesystem extraction cache');
    db.exec(`
      CREATE TABLE IF NOT EXISTS filesystem_extractions (
        path             TEXT PRIMARY KEY,
        size_bytes       INTEGER NOT NULL,
        mtime_ms         REAL NOT NULL,
        extraction_type  TEXT NOT NULL CHECK(extraction_type IN ('text', 'pdf', 'unsupported')),
        text_content     TEXT,
        note             TEXT,
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_filesystem_extractions_updated
        ON filesystem_extractions(updated_at DESC);

      INSERT INTO schema_version (version) VALUES (17);
    `);
  }

  if (currentVersion < 18) {
    console.log('[DB] Running migration v18: filesystem extraction lexical index');
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS filesystem_extractions_fts USING fts5(
        path UNINDEXED,
        text_content
      );

      INSERT INTO filesystem_extractions_fts(rowid, path, text_content)
      SELECT rowid, path, COALESCE(text_content, '')
      FROM filesystem_extractions
      WHERE text_content IS NOT NULL;

      CREATE TRIGGER IF NOT EXISTS filesystem_extractions_fts_ai
      AFTER INSERT ON filesystem_extractions BEGIN
        INSERT INTO filesystem_extractions_fts(rowid, path, text_content)
        VALUES (new.rowid, new.path, COALESCE(new.text_content, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS filesystem_extractions_fts_ad
      AFTER DELETE ON filesystem_extractions BEGIN
        INSERT INTO filesystem_extractions_fts(filesystem_extractions_fts, rowid, path, text_content)
        VALUES('delete', old.rowid, old.path, COALESCE(old.text_content, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS filesystem_extractions_fts_au
      AFTER UPDATE ON filesystem_extractions BEGIN
        INSERT INTO filesystem_extractions_fts(filesystem_extractions_fts, rowid, path, text_content)
        VALUES('delete', old.rowid, old.path, COALESCE(old.text_content, ''));
        INSERT INTO filesystem_extractions_fts(rowid, path, text_content)
        VALUES (new.rowid, new.path, COALESCE(new.text_content, ''));
      END;

      INSERT INTO schema_version (version) VALUES (18);
    `);
  }

  if (currentVersion < 19) {
    console.log('[DB] Running migration v19: run provider/model metadata');
    db.exec(`
      ALTER TABLE runs ADD COLUMN provider TEXT;
      ALTER TABLE runs ADD COLUMN model TEXT;
      INSERT INTO schema_version (version) VALUES (19);
    `);
  }

  if (currentVersion < 20) {
    console.log('[DB] Running migration v20: workflow stages + run_artifacts');
    db.exec(`
      ALTER TABLE runs ADD COLUMN workflow_stage TEXT NOT NULL DEFAULT 'starting';

      CREATE TABLE IF NOT EXISTS run_artifacts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK(kind IN ('execution_plan')),
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_run_artifacts_run_id
        ON run_artifacts(run_id, id ASC);
      CREATE INDEX IF NOT EXISTS idx_run_artifacts_kind
        ON run_artifacts(kind, updated_at DESC);

      INSERT INTO schema_version (version) VALUES (20);
    `);
  }

  if (currentVersion < 21) {
    console.log('[DB] Running migration v21: message attachments');
    db.exec(`
      ALTER TABLE messages ADD COLUMN attachments_json TEXT;
      INSERT INTO schema_version (version) VALUES (21);
    `);
  }

  if (currentVersion < 22) {
    console.log('[DB] Running migration v22: widen run_artifacts kinds');
    db.exec(`
      ALTER TABLE run_artifacts RENAME TO run_artifacts_old;

      CREATE TABLE IF NOT EXISTS run_artifacts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK(kind IN ('execution_plan', 'execution_graph_scaffold')),
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      INSERT INTO run_artifacts (id, run_id, kind, title, body, created_at, updated_at)
      SELECT id, run_id, kind, title, body, created_at, updated_at
      FROM run_artifacts_old;

      DROP TABLE run_artifacts_old;

      CREATE INDEX IF NOT EXISTS idx_run_artifacts_run_id
        ON run_artifacts(run_id, id ASC);
      CREATE INDEX IF NOT EXISTS idx_run_artifacts_kind
        ON run_artifacts(kind, updated_at DESC);

      INSERT INTO schema_version (version) VALUES (22);
    `);
  }

  if (currentVersion < 23) {
    console.log('[DB] Running migration v23: widen run_artifacts kinds for graph state');
    db.exec(`
      ALTER TABLE run_artifacts RENAME TO run_artifacts_old;

      CREATE TABLE IF NOT EXISTS run_artifacts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK(kind IN ('execution_plan', 'execution_graph_scaffold', 'execution_graph_state')),
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      INSERT INTO run_artifacts (id, run_id, kind, title, body, created_at, updated_at)
      SELECT id, run_id, kind, title, body, created_at, updated_at
      FROM run_artifacts_old;

      DROP TABLE run_artifacts_old;

      CREATE INDEX IF NOT EXISTS idx_run_artifacts_run_id
        ON run_artifacts(run_id, id ASC);
      CREATE INDEX IF NOT EXISTS idx_run_artifacts_kind
        ON run_artifacts(kind, updated_at DESC);

      INSERT INTO schema_version (version) VALUES (23);
    `);
  }

  if (currentVersion < 24) {
    console.log('[DB] Running migration v24: autonomy identity + credential tables');
    db.exec(`
      CREATE TABLE IF NOT EXISTS identity_profiles (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT NOT NULL UNIQUE,
        full_name        TEXT NOT NULL DEFAULT '',
        email            TEXT NOT NULL DEFAULT '',
        username_pattern TEXT NOT NULL DEFAULT '',
        date_of_birth    TEXT,
        is_default       INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS managed_accounts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        service_name        TEXT NOT NULL,
        login_url           TEXT NOT NULL DEFAULT '',
        username            TEXT NOT NULL DEFAULT '',
        email_used          TEXT NOT NULL DEFAULT '',
        password_encrypted  TEXT NOT NULL DEFAULT '',
        phone_used          TEXT NOT NULL DEFAULT '',
        identity_profile_id INTEGER REFERENCES identity_profiles(id),
        phone_method        TEXT NOT NULL DEFAULT '',
        status              TEXT NOT NULL DEFAULT 'unverified'
                              CHECK(status IN ('active', 'suspended', 'unverified')),
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        notes               TEXT NOT NULL DEFAULT '',
        UNIQUE(service_name)
      );

      CREATE TABLE IF NOT EXISTS credential_vault (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        label            TEXT NOT NULL,
        type             TEXT NOT NULL
                           CHECK(type IN ('api_key','session_token','app_password','oauth_token','keychain_blob')),
        service          TEXT NOT NULL DEFAULT '',
        value_encrypted  TEXT NOT NULL,
        expires_at       TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(label, service)
      );

      INSERT INTO schema_version (version) VALUES (24);
    `);
  }

  if (currentVersion < 25) {
    console.log('[DB] Running migration v25: service_mentions for proactive detection');
    db.exec(`
      CREATE TABLE IF NOT EXISTS service_mentions (
        service_name  TEXT PRIMARY KEY,
        mention_count INTEGER NOT NULL DEFAULT 0,
        last_seen     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (25);
    `);
  }

  if (currentVersion < 26) {
    console.log('[DB] Running migration v26: scheduled_tasks + scheduled_task_runs');
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        cron_expr     TEXT,
        trigger_type  TEXT NOT NULL DEFAULT 'time'
                        CHECK(trigger_type IN ('time', 'completion')),
        trigger_after_task_id INTEGER REFERENCES scheduled_tasks(id),
        prompt        TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        approved      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id       INTEGER NOT NULL REFERENCES scheduled_tasks(id),
        status        TEXT NOT NULL CHECK(status IN ('running','completed','failed','skipped')),
        started_at    TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at  TEXT,
        result        TEXT,
        error         TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task_id
        ON scheduled_task_runs(task_id, started_at DESC);

      INSERT INTO schema_version (version) VALUES (26);
    `);
  }

  if (currentVersion < 27) {
    console.log('[DB] Running migration v27: site_harnesses intervention annotations');
    // site_harnesses may not exist yet on fresh installs (created lazily by ensureHarnessTable).
    // We create it if missing, then add the new columns via try/catch since SQLite
    // does not support IF NOT EXISTS on ALTER TABLE.
    db.exec(`
      CREATE TABLE IF NOT EXISTS site_harnesses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        action_name TEXT NOT NULL,
        url_pattern TEXT NOT NULL,
        fields_json TEXT NOT NULL,
        submit_json TEXT NOT NULL,
        verify_json TEXT NOT NULL DEFAULT '{}',
        success_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        last_used TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(domain, action_name)
      );
      CREATE INDEX IF NOT EXISTS idx_harness_domain ON site_harnesses(domain);
    `);
    // Add new columns — wrapped in individual try/catch since ALTER TABLE
    // fails if the column already exists (e.g. on a fresh install that just ran
    // ensureHarnessTable before this migration ran).
    try { db.exec(`ALTER TABLE site_harnesses ADD COLUMN intervention_hint TEXT`); } catch {}
    try { db.exec(`ALTER TABLE site_harnesses ADD COLUMN is_signup_harness INTEGER NOT NULL DEFAULT 0`); } catch {}
    db.exec(`INSERT INTO schema_version (version) VALUES (27)`);
  }

  if (currentVersion < 28) {
    console.log('[DB] Running migration v28: task_sequences');
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_sequences (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id           TEXT NOT NULL REFERENCES runs(id),
        goal             TEXT NOT NULL,
        goal_embedding   BLOB,
        embedding_dim    INTEGER,
        embedding_source TEXT,
        surfaces         TEXT NOT NULL DEFAULT '[]',
        steps            TEXT NOT NULL DEFAULT '[]',
        outcome          TEXT NOT NULL DEFAULT 'success',
        tool_call_count  INTEGER NOT NULL DEFAULT 0,
        duration_ms      INTEGER NOT NULL DEFAULT 0,
        success_count    INTEGER NOT NULL DEFAULT 0,
        fail_count       INTEGER NOT NULL DEFAULT 0,
        last_used        TEXT,
        created_at       TEXT NOT NULL
      );
      INSERT INTO schema_version (version) VALUES (28);
    `);
  }

  if (currentVersion < 29) {
    console.log('[DB] Running migration v29: audit_tool_telemetry');
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_tool_telemetry (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          TEXT NOT NULL REFERENCES runs(id),
        timestamp       TEXT NOT NULL,
        iteration_index INTEGER NOT NULL,
        tool_name       TEXT NOT NULL,
        tool_category   TEXT,
        success         INTEGER NOT NULL CHECK(success IN (0, 1)),
        duration_ms     INTEGER NOT NULL DEFAULT 0,
        error_type      TEXT,
        loop_outcome    TEXT CHECK(loop_outcome IN ('completed', 'failed', 'aborted', 'cancelled'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_tool_telemetry_timestamp
        ON audit_tool_telemetry(timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_tool_telemetry_run
        ON audit_tool_telemetry(run_id, timestamp ASC);
      CREATE INDEX IF NOT EXISTS idx_audit_tool_telemetry_tool
        ON audit_tool_telemetry(tool_name, timestamp DESC);
      INSERT INTO schema_version (version) VALUES (29);
    `);
  }

  if (currentVersion < 30) {
    console.log('[DB] Running migration v30: wallet tables + widen credential_vault type');
    db.exec(`
      -- Widen credential_vault CHECK to include payment_card
      -- SQLite requires drop + recreate to alter CHECK constraints
      -- Follow the RENAME TO _old pattern established in migrations v22 and v23
      ALTER TABLE credential_vault RENAME TO credential_vault_old;

      CREATE TABLE IF NOT EXISTS credential_vault (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        label            TEXT NOT NULL,
        type             TEXT NOT NULL
                           CHECK(type IN ('api_key','session_token','app_password','oauth_token','keychain_blob','payment_card')),
        service          TEXT NOT NULL DEFAULT '',
        value_encrypted  TEXT NOT NULL,
        expires_at       TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(label, service)
      );
      INSERT INTO credential_vault (id, label, type, service, value_encrypted, expires_at, created_at)
      SELECT id, label, type, service, value_encrypted, expires_at, created_at
      FROM credential_vault_old;
      DROP TABLE credential_vault_old;

      CREATE TABLE IF NOT EXISTS payment_methods (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        label           TEXT NOT NULL,
        last_four       TEXT NOT NULL,
        card_type       TEXT NOT NULL,
        method_type     TEXT NOT NULL DEFAULT 'card',
        expiry_month    INTEGER NOT NULL,
        expiry_year     INTEGER NOT NULL,
        billing_name    TEXT,
        source          TEXT NOT NULL,
        vault_ref       TEXT,
        is_preferred    INTEGER NOT NULL DEFAULT 0,
        is_backup       INTEGER NOT NULL DEFAULT 0,
        is_active       INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS spending_budgets (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        period      TEXT NOT NULL UNIQUE,
        limit_usd   INTEGER NOT NULL,
        is_active   INTEGER NOT NULL DEFAULT 1,
        reset_day   INTEGER,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS spending_transactions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
        merchant          TEXT NOT NULL,
        amount_usd        INTEGER NOT NULL,
        description       TEXT,
        payment_method_id INTEGER REFERENCES payment_methods(id) ON DELETE SET NULL,
        status            TEXT NOT NULL CHECK(status IN ('pending','completed','failed','refunded')),
        is_estimated      INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO schema_version (version) VALUES (30);
    `);
  }

  console.log(`[DB] Schema at version ${Math.max(currentVersion, 30)}`);
}
