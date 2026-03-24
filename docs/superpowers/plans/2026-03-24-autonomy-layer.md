# Clawdia Autonomy Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Clawdia the ability to self-provision accounts on any web service — handling signup, email/phone verification, credential storage, and auto-resume after human intervention — plus a task scheduler for recurring autonomous work.

**Architecture:** A new `src/main/autonomy/` module provides six focused files. All data persists in the existing single SQLite database (`~/.config/clawdia/data.sqlite`) via new migration versions. Encryption uses Electron's built-in `safeStorage` API — no new native addons. The human-in-the-loop auto-resume mechanism extends the existing `human-intervention-manager.ts` pattern using `executeJavaScript` polling on the BrowserView's `webContents`, consistent with patterns already in `src/main/browser/waits.ts`.

**Tech Stack:** TypeScript, better-sqlite3, Electron `safeStorage`, `node-cron`, `fetch` (Node 18 built-in for temp-mail/Twilio APIs)

**Spec:** `docs/superpowers/specs/2026-03-24-autonomy-layer-design.md`

---

## Pre-Build Gate: Validate Bloodhound

Before any code is written, the Bloodhound playbook system must be verified working end-to-end. The entire provisioning flow depends on it.

### Task 0: Validate Bloodhound Playbook Record/Replay

**Files:**
- Read: `src/main/browser/site-harness.ts`
- Read: `src/main/db/browser-playbooks.ts`
- Read: `tests/db/browser-playbooks.test.ts`

- [ ] **Step 1: Run existing Bloodhound tests**

```bash
npx vitest run tests/db/browser-playbooks.test.ts
```

Expected: All tests PASS. If any fail, fix them before proceeding.

- [ ] **Step 2: Manually verify harness save/load on a real site**

Start Clawdia in dev mode and complete a browser form (e.g. a Reddit post or GitHub issue). Then inspect the DB:

```bash
sqlite3 ~/.config/Clawdia/data.sqlite "SELECT domain, task_pattern, success_count, json_array_length(steps) as step_count FROM browser_playbooks ORDER BY created_at DESC LIMIT 5;"
```

Expected: A row appears with `success_count >= 1` and `step_count > 0`.

- [ ] **Step 3: Verify replay works**

Repeat the same task. Confirm in the Clawdia console that the playbook replay path is taken (`[Bloodhound] Replaying playbook` log line or equivalent) and the task completes without LLM exploration.

- [ ] **Step 4: Document any gaps found**

If record or replay is broken, fix `src/main/browser/site-harness.ts` and/or `src/main/db/browser-playbooks.ts` before continuing. Commit fixes:

```bash
git add src/main/browser/site-harness.ts src/main/db/browser-playbooks.ts
git commit -m "fix: repair Bloodhound playbook record/replay"
```

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/main/db/database.ts` | Modify | Add migration versions v24–v27: autonomy tables + site_harnesses columns |
| `src/main/autonomy/identity-store.ts` | Create | Identity profiles, managed accounts, credential vault — encrypted R/W via `safeStorage` |
| `src/main/autonomy/email-monitor.ts` | Create | Inbox polling: Gmail/Yahoo browser + temp-mail API |
| `src/main/autonomy/account-provisioner.ts` | Create | Full signup flow orchestration |
| `src/main/db/run-human-interventions.ts` | Modify | Extend `interventionType` union with `'phone_required' \| 'unexpected_form'` |
| `src/main/agent/human-intervention-manager.ts` | Modify | Add DOM-polling auto-resume for provisioning blockers |
| `src/main/autonomy/phone-verifier.ts` | Create | Google Voice + Twilio SMS handling |
| `src/main/browser/site-harness.ts` | Modify | Add `interventionHint` and `signupHarness` type annotation |
| `src/main/autonomy/proactive-detector.ts` | Create | Allowlist mention counting + background provisioning suggestion |
| `src/main/autonomy/task-scheduler.ts` | Create | `node-cron` time-based + completion-triggered scheduling |
| `src/main/main.ts` | Modify | Wire autonomy module initialization |
| `tests/autonomy/identity-store.test.ts` | Create | Unit tests for identity-store vault R/W |
| `tests/autonomy/account-provisioner.test.ts` | Create | Unit tests for provisioner flow logic |
| `tests/autonomy/proactive-detector.test.ts` | Create | Unit tests for mention counting |
| `tests/autonomy/task-scheduler.test.ts` | Create | Unit tests for scheduler logic |

---

## Task 1: DB Migrations — Autonomy Tables

**Files:**
- Modify: `src/main/db/database.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/autonomy/db-migrations.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/autonomy/db-migrations.test.ts
```

Expected: FAIL — tables do not exist yet.

- [ ] **Step 3: Add migrations v24–v27 to `database.ts`**

Add the following blocks inside `runMigrations`, immediately after the `currentVersion < 23` block (before the final `console.log`). Also update the header comment to document the new tables.

```typescript
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
```

Also update the final log line:
```typescript
  console.log(`[DB] Schema at version ${Math.max(currentVersion, 26)}`);
```

And add the new tables to the header comment block.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/autonomy/db-migrations.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 5: Run full test suite to check no regressions**

```bash
npx vitest run
```

Expected: All existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/db/database.ts tests/autonomy/db-migrations.test.ts
git commit -m "feat: add autonomy layer DB migrations (v24-v26)"
```

---

## Task 2: Identity Store + Credential Vault

**Files:**
- Create: `src/main/autonomy/identity-store.ts`
- Create: `tests/autonomy/identity-store.test.ts`

The `safeStorage` API is an Electron main-process API. Since tests run outside Electron (via vitest + Node), mock `safeStorage` in tests. The actual encryption only matters in production.

- [ ] **Step 1: Write the failing tests**

Create `tests/autonomy/identity-store.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Mock safeStorage — not available outside Electron
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (val: string) => Buffer.from(val + ':encrypted'),
    decryptString: (buf: Buffer) => buf.toString().replace(':encrypted', ''),
  },
  app: {
    getPath: () => os.tmpdir(),
  },
}));

let tmpPath: string;
beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `clawdia-vault-test-${Date.now()}.sqlite`);
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

describe('IdentityStore', () => {
  it('creates and retrieves a default identity profile', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const store = new IdentityStore();
    const profile = store.upsertProfile({ name: 'default', fullName: 'Test User', email: 'test@example.com', isDefault: true });
    expect(profile.id).toBeGreaterThan(0);
    const fetched = store.getDefaultProfile();
    expect(fetched?.fullName).toBe('Test User');
  });

  it('saves and retrieves a managed account', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const store = new IdentityStore();
    store.saveAccount({ serviceName: 'reddit', loginUrl: 'https://reddit.com/login', username: 'testuser', emailUsed: 'test@example.com', passwordPlain: 'secret123', status: 'active' });
    const account = store.getAccount('reddit');
    expect(account?.username).toBe('testuser');
    expect(account?.passwordPlain).toBe('secret123');
  });

  it('encrypts passwords at rest', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const store = new IdentityStore();
    store.saveAccount({ serviceName: 'github', loginUrl: 'https://github.com/login', username: 'dev', emailUsed: 'dev@example.com', passwordPlain: 'mypassword', status: 'active' });
    // Read raw DB value — should NOT be the plaintext password
    const db = new Database(tmpPath);
    const row = db.prepare('SELECT password_encrypted FROM managed_accounts WHERE service_name = ?').get('github') as any;
    expect(row.password_encrypted).not.toBe('mypassword');
    expect(row.password_encrypted).toContain(':encrypted'); // mock marker
    db.close();
  });

  it('saves and retrieves a credential vault entry', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const store = new IdentityStore();
    store.saveCredential({ label: 'twilio-sid', type: 'api_key', service: 'twilio', valuePlain: 'AC123' });
    const val = store.getCredential('twilio-sid', 'twilio');
    expect(val).toBe('AC123');
  });

  it('returns null for unknown account', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const store = new IdentityStore();
    expect(store.getAccount('nonexistent')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/autonomy/identity-store.test.ts
```

Expected: FAIL — `identity-store.ts` does not exist.

- [ ] **Step 3: Implement `identity-store.ts`**

Create `src/main/autonomy/identity-store.ts`:

```typescript
/**
 * IdentityStore — encrypted identity profiles, managed accounts, credential vault.
 *
 * Encryption: Electron's safeStorage API (OS keychain backed).
 * The master key is derived once per session and cached in memory.
 * All sensitive DB fields store base64-encoded encrypted buffers.
 */
import { safeStorage } from 'electron';
import { getDb } from '../db/database';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IdentityProfile {
  id: number;
  name: string;
  fullName: string;
  email: string;
  usernamePattern: string;
  dateOfBirth?: string;
  isDefault: boolean;
}

export interface UpsertProfileInput {
  name: string;
  fullName?: string;
  email?: string;
  usernamePattern?: string;
  dateOfBirth?: string;
  isDefault?: boolean;
}

export interface ManagedAccount {
  id: number;
  serviceName: string;
  loginUrl: string;
  username: string;
  emailUsed: string;
  /** Decrypted password — never stored in plaintext */
  passwordPlain: string;
  phoneUsed: string;
  phoneMethod: string;
  status: 'active' | 'suspended' | 'unverified';
  createdAt: string;
  notes: string;
}

export interface SaveAccountInput {
  serviceName: string;
  loginUrl?: string;
  username?: string;
  emailUsed?: string;
  passwordPlain: string;
  phoneUsed?: string;
  phoneMethod?: string;
  identityProfileId?: number;
  status?: ManagedAccount['status'];
  notes?: string;
}

export interface SaveCredentialInput {
  label: string;
  type: 'api_key' | 'session_token' | 'app_password' | 'oauth_token';
  service?: string;
  valuePlain: string;
  expiresAt?: string;
}

// ─── IdentityStore ────────────────────────────────────────────────────────────

export class IdentityStore {
  private encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: store as-is in test/CI environments where keychain unavailable.
      // Production always has encryption available on desktop Electron.
      return value;
    }
    return safeStorage.encryptString(value).toString('base64');
  }

  private decrypt(encrypted: string): string {
    if (!safeStorage.isEncryptionAvailable()) return encrypted;
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return '';
    }
  }

  // ── Identity Profiles ──

  upsertProfile(input: UpsertProfileInput): IdentityProfile {
    const db = getDb();
    if (input.isDefault) {
      db.prepare('UPDATE identity_profiles SET is_default = 0').run();
    }
    const result = db.prepare(`
      INSERT INTO identity_profiles (name, full_name, email, username_pattern, date_of_birth, is_default)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        full_name = excluded.full_name,
        email = excluded.email,
        username_pattern = excluded.username_pattern,
        date_of_birth = excluded.date_of_birth,
        is_default = excluded.is_default
    `).run(
      input.name,
      input.fullName ?? '',
      input.email ?? '',
      input.usernamePattern ?? '',
      input.dateOfBirth ?? null,
      input.isDefault ? 1 : 0,
    );
    const id = result.lastInsertRowid as number || (db.prepare('SELECT id FROM identity_profiles WHERE name = ?').get(input.name) as any).id;
    return this.getProfileById(id)!;
  }

  getDefaultProfile(): IdentityProfile | null {
    const row = getDb().prepare('SELECT * FROM identity_profiles WHERE is_default = 1 LIMIT 1').get() as any;
    return row ? this.rowToProfile(row) : null;
  }

  getProfileByName(name: string): IdentityProfile | null {
    const row = getDb().prepare('SELECT * FROM identity_profiles WHERE name = ?').get(name) as any;
    return row ? this.rowToProfile(row) : null;
  }

  getProfileById(id: number): IdentityProfile | null {
    const row = getDb().prepare('SELECT * FROM identity_profiles WHERE id = ?').get(id) as any;
    return row ? this.rowToProfile(row) : null;
  }

  private rowToProfile(row: any): IdentityProfile {
    return {
      id: row.id,
      name: row.name,
      fullName: row.full_name,
      email: row.email,
      usernamePattern: row.username_pattern,
      dateOfBirth: row.date_of_birth ?? undefined,
      isDefault: row.is_default === 1,
    };
  }

  // ── Managed Accounts ──

  saveAccount(input: SaveAccountInput): ManagedAccount {
    const db = getDb();
    const encrypted = this.encrypt(input.passwordPlain);
    db.prepare(`
      INSERT INTO managed_accounts
        (service_name, login_url, username, email_used, password_encrypted,
         phone_used, phone_method, identity_profile_id, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_name) DO UPDATE SET
        login_url = excluded.login_url,
        username = excluded.username,
        email_used = excluded.email_used,
        password_encrypted = excluded.password_encrypted,
        phone_used = excluded.phone_used,
        phone_method = excluded.phone_method,
        identity_profile_id = excluded.identity_profile_id,
        status = excluded.status,
        notes = excluded.notes
    `).run(
      input.serviceName,
      input.loginUrl ?? '',
      input.username ?? '',
      input.emailUsed ?? '',
      encrypted,
      input.phoneUsed ?? '',
      input.phoneMethod ?? '',
      input.identityProfileId ?? null,
      input.status ?? 'unverified',
      input.notes ?? '',
    );
    return this.getAccount(input.serviceName)!;
  }

  getAccount(serviceName: string): ManagedAccount | null {
    const row = getDb().prepare('SELECT * FROM managed_accounts WHERE service_name = ?').get(serviceName) as any;
    if (!row) return null;
    return {
      id: row.id,
      serviceName: row.service_name,
      loginUrl: row.login_url,
      username: row.username,
      emailUsed: row.email_used,
      passwordPlain: this.decrypt(row.password_encrypted),
      phoneUsed: row.phone_used,
      phoneMethod: row.phone_method,
      status: row.status,
      createdAt: row.created_at,
      notes: row.notes,
    };
  }

  updateAccountStatus(serviceName: string, status: ManagedAccount['status']): void {
    getDb().prepare('UPDATE managed_accounts SET status = ? WHERE service_name = ?').run(status, serviceName);
  }

  // ── Credential Vault ──

  saveCredential(input: SaveCredentialInput): void {
    const encrypted = this.encrypt(input.valuePlain);
    getDb().prepare(`
      INSERT INTO credential_vault (label, type, service, value_encrypted, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(label, service) DO UPDATE SET
        value_encrypted = excluded.value_encrypted,
        expires_at = excluded.expires_at
    `).run(
      input.label,
      input.type,
      input.service ?? '',
      encrypted,
      input.expiresAt ?? null,
    );
  }

  getCredential(label: string, service = ''): string | null {
    const row = getDb().prepare(
      'SELECT value_encrypted FROM credential_vault WHERE label = ? AND service = ?'
    ).get(label, service) as any;
    if (!row) return null;
    return this.decrypt(row.value_encrypted);
  }
}

// Singleton for use across the autonomy module
export const identityStore = new IdentityStore();
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/autonomy/identity-store.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/autonomy/identity-store.ts tests/autonomy/identity-store.test.ts
git commit -m "feat: add IdentityStore with safeStorage encryption"
```

---

## Task 3: Email Monitor

**Files:**
- Create: `src/main/autonomy/email-monitor.ts`

Email monitor has no unit tests here — it drives the BrowserView (for Gmail/Yahoo) and calls external APIs (temp-mail). These are integration-tested in Task 10. For now we implement the module.

- [ ] **Step 1: Implement `email-monitor.ts`**

Create `src/main/autonomy/email-monitor.ts`:

```typescript
/**
 * EmailMonitor — watches an inbox for verification emails during signup flows.
 *
 * Two modes:
 *   - browser: navigates to Gmail/Yahoo in the BrowserView and polls for new mail
 *   - tempmail: polls mail.tm API for a throwaway address
 */
import type { BrowserView } from 'electron';
import { wait } from '../browser/waits';

const TEMPMAIL_BASE = 'https://api.mail.tm';
const POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 5 * 60 * 1_000; // 5 minutes

// ─── Temp-mail ────────────────────────────────────────────────────────────────

export interface TempMailbox {
  address: string;
  token: string;
}

export async function createTempMailbox(): Promise<TempMailbox> {
  // Get available domain
  const domainsRes = await fetch(`${TEMPMAIL_BASE}/domains`);
  const domains = await domainsRes.json() as any;
  const domain = domains['hydra:member']?.[0]?.domain;
  if (!domain) throw new Error('No temp-mail domains available');

  const username = `clawdia${Date.now()}`;
  const password = `Tmp${Math.random().toString(36).slice(2, 10)}!`;
  const address = `${username}@${domain}`;

  await fetch(`${TEMPMAIL_BASE}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });

  const tokenRes = await fetch(`${TEMPMAIL_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  const tokenData = await tokenRes.json() as any;
  return { address, token: tokenData.token };
}

/** Poll temp-mail inbox until a message matching `senderDomain` arrives. Returns the message body. */
export async function waitForTempMail(mailbox: TempMailbox, senderDomain: string): Promise<string | null> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${TEMPMAIL_BASE}/messages`, {
      headers: { Authorization: `Bearer ${mailbox.token}` },
    });
    const data = await res.json() as any;
    const messages: any[] = data['hydra:member'] ?? [];
    const match = messages.find((m: any) =>
      m.from?.address?.includes(senderDomain) || m.subject?.toLowerCase().includes(senderDomain.split('.')[0])
    );
    if (match) {
      // Fetch full message body
      const msgRes = await fetch(`${TEMPMAIL_BASE}/messages/${match.id}`, {
        headers: { Authorization: `Bearer ${mailbox.token}` },
      });
      const msg = await msgRes.json() as any;
      return msg.text ?? msg.html ?? '';
    }
    await wait(POLL_INTERVAL_MS);
  }
  return null;
}

// ─── Browser inbox (Gmail/Yahoo) ──────────────────────────────────────────────

/** Navigate to Gmail inbox and wait for a verification email from `senderDomain`. Returns the email body text. */
export async function waitForGmailVerification(view: BrowserView, senderDomain: string): Promise<string | null> {
  const wc = view.webContents;
  const deadline = Date.now() + MAX_WAIT_MS;

  // Navigate to Gmail if not already there
  const currentUrl = wc.getURL();
  if (!currentUrl.includes('mail.google.com')) {
    wc.loadURL('https://mail.google.com/mail/u/0/#inbox');
    await wait(3000);
  }

  while (Date.now() < deadline) {
    try {
      // Look for an unread email row matching the sender domain
      const found = await wc.executeJavaScript(`(() => {
        const rows = Array.from(document.querySelectorAll('[role="row"]'));
        return rows.some(row => row.textContent && row.textContent.toLowerCase().includes(${JSON.stringify(senderDomain.split('.')[0])}));
      })()`);

      if (found) {
        // Click the matching row
        await wc.executeJavaScript(`(() => {
          const rows = Array.from(document.querySelectorAll('[role="row"]'));
          const match = rows.find(row => row.textContent && row.textContent.toLowerCase().includes(${JSON.stringify(senderDomain.split('.')[0])}));
          if (match) (match as HTMLElement).click();
        })()`);
        await wait(2000);
        // Extract body text
        const body = await wc.executeJavaScript(`document.querySelector('[role="main"]')?.innerText ?? ''`);
        return body as string;
      }
    } catch { /* ignore JS errors, keep polling */ }

    // Reload inbox to check for new mail
    wc.loadURL('https://mail.google.com/mail/u/0/#inbox');
    await wait(POLL_INTERVAL_MS);
  }
  return null;
}

// ─── Code/link extraction ─────────────────────────────────────────────────────

/** Extract a numeric OTP code from email body text. Returns null if not found. */
export function extractOtpCode(body: string): string | null {
  const match = body.match(/\b(\d{4,8})\b/);
  return match?.[1] ?? null;
}

/** Extract a verification link from email body text. Returns null if not found. */
export function extractVerificationLink(body: string): string | null {
  const urlMatch = body.match(/https?:\/\/[^\s"'<>]+(?:verif|confirm|activate|token)[^\s"'<>]*/i);
  return urlMatch?.[0] ?? null;
}
```

- [ ] **Step 2: TypeScript compile check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: No errors in `email-monitor.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/main/autonomy/email-monitor.ts
git commit -m "feat: add EmailMonitor for browser + temp-mail inbox polling"
```

---

## Task 4: Account Provisioner

**Files:**
- Create: `src/main/autonomy/account-provisioner.ts`
- Create: `tests/autonomy/account-provisioner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/autonomy/account-provisioner.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => os.tmpdir() },
}));

let tmpPath: string;
beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `clawdia-prov-test-${Date.now()}.sqlite`);
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

describe('AccountProvisioner', () => {
  it('returns existing account without provisioning if active', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const { AccountProvisioner } = await import('../../src/main/autonomy/account-provisioner');

    const store = new IdentityStore();
    store.saveAccount({ serviceName: 'reddit', passwordPlain: 'existing', status: 'active' });

    const provisioner = new AccountProvisioner(store);
    const result = await provisioner.ensureAccount('reddit');
    expect(result.status).toBe('existing');
    expect(result.account?.serviceName).toBe('reddit');
  });

  it('calls signupFn when no account exists', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const { AccountProvisioner } = await import('../../src/main/autonomy/account-provisioner');

    const store = new IdentityStore();
    store.upsertProfile({ name: 'default', fullName: 'Test User', email: 'test@example.com', isDefault: true });

    const mockSignup = vi.fn().mockResolvedValue({ username: 'testuser', password: 'newpass', email: 'test@example.com' });
    const provisioner = new AccountProvisioner(store);

    const result = await provisioner.ensureAccount('newservice', {
      loginUrl: 'https://newservice.com/login',
      signupFn: mockSignup,
    });

    expect(mockSignup).toHaveBeenCalledOnce();
    expect(result.status).toBe('provisioned');
    expect(store.getAccount('newservice')?.status).toBe('active');
  });

  it('returns needs_human when signupFn throws InterventionNeeded', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const { AccountProvisioner, InterventionNeeded } = await import('../../src/main/autonomy/account-provisioner');

    const store = new IdentityStore();
    const provisioner = new AccountProvisioner(store);

    const mockSignup = vi.fn().mockRejectedValue(new InterventionNeeded('captcha', 'Please solve the CAPTCHA'));
    const result = await provisioner.ensureAccount('captchasite', { signupFn: mockSignup });

    expect(result.status).toBe('needs_human');
    expect(result.interventionType).toBe('captcha');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/autonomy/account-provisioner.test.ts
```

Expected: FAIL — `account-provisioner.ts` does not exist.

- [ ] **Step 3: Implement `account-provisioner.ts`**

Create `src/main/autonomy/account-provisioner.ts`:

```typescript
/**
 * AccountProvisioner — orchestrates the full account signup flow.
 *
 * Usage:
 *   const result = await provisioner.ensureAccount('reddit', { loginUrl, signupFn });
 *   if (result.status === 'existing' || result.status === 'provisioned') {
 *     // proceed with task using result.account
 *   } else if (result.status === 'needs_human') {
 *     // pause and request human intervention
 *   }
 */
import type { ManagedAccount } from './identity-store';
import type { IdentityStore } from './identity-store';

// ─── InterventionNeeded ───────────────────────────────────────────────────────

export class InterventionNeeded extends Error {
  constructor(
    public readonly interventionType: 'captcha' | 'phone_required' | 'unexpected_form',
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = 'InterventionNeeded';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignupResult {
  username: string;
  password: string;
  email: string;
  phoneUsed?: string;
  phoneMethod?: string;
}

export interface EnsureAccountOptions {
  loginUrl?: string;
  /** Called when no account exists. Should navigate signup form and return credentials used. */
  signupFn?: (profile: { fullName: string; email: string; usernamePattern: string }) => Promise<SignupResult>;
  /** Override identity profile name. Defaults to 'default'. */
  identityProfileName?: string;
}

export type EnsureAccountResult =
  | { status: 'existing'; account: ManagedAccount }
  | { status: 'provisioned'; account: ManagedAccount }
  | { status: 'needs_human'; interventionType: 'captcha' | 'phone_required' | 'unexpected_form'; message: string }
  | { status: 'failed'; error: string };

// ─── AccountProvisioner ───────────────────────────────────────────────────────

export class AccountProvisioner {
  constructor(private readonly store: IdentityStore) {}

  async ensureAccount(serviceName: string, opts: EnsureAccountOptions = {}): Promise<EnsureAccountResult> {
    // 1. Check registry
    const existing = this.store.getAccount(serviceName);
    if (existing && existing.status === 'active') {
      return { status: 'existing', account: existing };
    }

    // 2. No active account — provision
    console.log(`[Autonomy] No active account for ${serviceName} — provisioning`);

    const profileName = opts.identityProfileName ?? 'default';
    const profile = this.store.getProfileByName(profileName) ?? this.store.getDefaultProfile();
    const identityInput = {
      fullName: profile?.fullName ?? '',
      email: profile?.email ?? '',
      usernamePattern: profile?.usernamePattern ?? '',
    };

    try {
      if (!opts.signupFn) {
        return { status: 'failed', error: `No signup function provided for ${serviceName}` };
      }

      // 3. Run signup (may throw InterventionNeeded)
      const signupResult = await opts.signupFn(identityInput);

      // 4. Save to registry
      const account = this.store.saveAccount({
        serviceName,
        loginUrl: opts.loginUrl ?? '',
        username: signupResult.username,
        emailUsed: signupResult.email,
        passwordPlain: signupResult.password,
        phoneUsed: signupResult.phoneUsed ?? '',
        phoneMethod: signupResult.phoneMethod ?? '',
        identityProfileId: profile?.id,
        status: 'active',
      });

      console.log(`[Autonomy] Account provisioned for ${serviceName}: ${signupResult.username}`);
      return { status: 'provisioned', account };

    } catch (err) {
      if (err instanceof InterventionNeeded) {
        console.log(`[Autonomy] Human intervention needed for ${serviceName}: ${err.interventionType}`);
        return { status: 'needs_human', interventionType: err.interventionType, message: err.userMessage };
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Autonomy] Signup failed for ${serviceName}: ${msg}`);
      return { status: 'failed', error: msg };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/autonomy/account-provisioner.test.ts
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/autonomy/account-provisioner.ts tests/autonomy/account-provisioner.test.ts
git commit -m "feat: add AccountProvisioner with InterventionNeeded error"
```

---

## Task 5: Human-in-the-Loop — New Types + DOM Polling Auto-Resume

**Files:**
- Modify: `src/main/db/run-human-interventions.ts` (line 20)
- Modify: `src/main/agent/human-intervention-manager.ts`

- [ ] **Step 1: Write failing test for new intervention types**

Create `tests/autonomy/intervention-types.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

const run = vi.fn();
const get = vi.fn();
const prepare = vi.fn(() => ({ run, get }));
vi.mock('../../src/main/db/database', () => ({ getDb: () => ({ prepare }) }));

describe('intervention type union', () => {
  it('accepts phone_required as a valid intervention type', async () => {
    const { createRunHumanIntervention } = await import('../../src/main/db/run-human-interventions');
    // NOTE: vitest transpiles with esbuild and strips types, so this test only
    // validates runtime acceptance. TypeScript compile-time checking is validated
    // separately via `tsc --noEmit` in Step 6.
    get.mockReturnValue({ id: 1, run_id: 'r1', status: 'pending', intervention_type: 'phone_required', target: null, summary: 'test', instructions: null, request_json: '{}', created_at: '2026-01-01', resolved_at: null });
    expect(() => createRunHumanIntervention('r1', {
      interventionType: 'phone_required',
      summary: 'Service requires a phone number',
    })).not.toThrow();
  });

  it('accepts unexpected_form as a valid intervention type', async () => {
    const { createRunHumanIntervention } = await import('../../src/main/db/run-human-interventions');
    get.mockReturnValue({ id: 2, run_id: 'r1', status: 'pending', intervention_type: 'unexpected_form', target: null, summary: 'test', instructions: null, request_json: '{}', created_at: '2026-01-01', resolved_at: null });
    expect(() => createRunHumanIntervention('r1', {
      interventionType: 'unexpected_form',
      summary: 'Signup form did not match known pattern',
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails (TypeScript compile error)**

```bash
npx vitest run tests/autonomy/intervention-types.test.ts
```

Expected: FAIL — TypeScript rejects `'phone_required'` and `'unexpected_form'` as invalid intervention types.

- [ ] **Step 3: Extend the `interventionType` union in `run-human-interventions.ts`**

In `src/main/db/run-human-interventions.ts`, line 20, change:

```typescript
  interventionType: 'password' | 'otp' | 'captcha' | 'native_dialog' | 'site_confirmation' | 'conflict_resolution' | 'manual_takeover' | 'unknown';
```

to:

```typescript
  interventionType: 'password' | 'otp' | 'captcha' | 'native_dialog' | 'site_confirmation' | 'conflict_resolution' | 'manual_takeover' | 'phone_required' | 'unexpected_form' | 'unknown';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/autonomy/intervention-types.test.ts
```

Expected: Both tests PASS.

- [ ] **Step 5: Add `watchForInterventionResolution` to `human-intervention-manager.ts`**

Add the following export at the bottom of `src/main/agent/human-intervention-manager.ts`:

```typescript
/**
 * Poll the BrowserView's webContents to detect when a DOM blocker is resolved.
 * Uses executeJavaScript polling — consistent with waits.ts patterns.
 * When the selector disappears (or page navigates), calls resolveHumanIntervention.
 *
 * @param view         The BrowserView currently showing the blocked page
 * @param interventionId  The ID of the pending intervention record
 * @param blockerSelector CSS selector for the element that indicates the blocker is present.
 *                        When this element is gone, the blocker is resolved.
 * @param timeoutMs    Max time to wait before giving up (default 10 minutes)
 */
export async function watchForInterventionResolution(
  view: import('electron').BrowserView,
  interventionId: number,
  blockerSelector: string,
  timeoutMs = 10 * 60 * 1_000,
): Promise<'resolved' | 'timeout'> {
  const { wait } = await import('../browser/waits');
  const deadline = Date.now() + timeoutMs;
  const wc = view.webContents;

  while (Date.now() < deadline) {
    if (wc.isDestroyed()) break;
    try {
      const blockerStillPresent = await wc.executeJavaScript(`
        (() => !!document.querySelector(${JSON.stringify(blockerSelector)}))()
      `);
      if (!blockerStillPresent) {
        resolveHumanIntervention(interventionId);
        return 'resolved';
      }
    } catch {
      // Page navigated or context destroyed — treat as resolved
      resolveHumanIntervention(interventionId);
      return 'resolved';
    }
    await wait(1_000);
  }

  return 'timeout';
}
```

- [ ] **Step 6: TypeScript compile check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: No errors.

- [ ] **Step 7: Run full test suite**

```bash
npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/db/run-human-interventions.ts src/main/agent/human-intervention-manager.ts tests/autonomy/intervention-types.test.ts
git commit -m "feat: extend intervention types + add DOM polling auto-resume"
```

---

## Task 6: Phone Verifier

**Files:**
- Create: `src/main/autonomy/phone-verifier.ts`

- [ ] **Step 1: Implement `phone-verifier.ts`**

Create `src/main/autonomy/phone-verifier.ts`:

```typescript
/**
 * PhoneVerifier — handles SMS verification codes during signup.
 *
 * Priority:
 *   1. Google Voice (browser, zero external deps)
 *   2. Twilio (REST API, credentials from vault)
 *   3. Human-in-the-loop fallback
 */
import type { BrowserView } from 'electron';
import { wait } from '../browser/waits';
import { identityStore } from './identity-store';

const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 3 * 60 * 1_000;

// ─── Google Voice ─────────────────────────────────────────────────────────────

/**
 * Navigate to voice.google.com and wait for an SMS from `senderPattern`.
 * Returns the SMS body text, or null on timeout.
 */
export async function waitForGoogleVoiceSms(view: BrowserView, senderPattern: string): Promise<string | null> {
  const wc = view.webContents;
  const currentUrl = wc.getURL();
  if (!currentUrl.includes('voice.google.com')) {
    wc.loadURL('https://voice.google.com/u/0/messages');
    await wait(3000);
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const found = await wc.executeJavaScript(`(() => {
        const items = Array.from(document.querySelectorAll('[data-item-id]'));
        return items.some(el => el.textContent?.toLowerCase().includes(${JSON.stringify(senderPattern.toLowerCase())}));
      })()`);

      if (found) {
        await wc.executeJavaScript(`(() => {
          const items = Array.from(document.querySelectorAll('[data-item-id]'));
          const match = items.find(el => el.textContent?.toLowerCase().includes(${JSON.stringify(senderPattern.toLowerCase())}));
          if (match) (match as HTMLElement).click();
        })()`);
        await wait(1500);
        const text = await wc.executeJavaScript(`document.querySelector('gv-message-item')?.innerText ?? ''`);
        return text as string;
      }
    } catch { /* keep polling */ }

    wc.loadURL('https://voice.google.com/u/0/messages');
    await wait(POLL_INTERVAL_MS);
  }
  return null;
}

// ─── Twilio ───────────────────────────────────────────────────────────────────

/**
 * Poll Twilio REST API for an incoming SMS.
 * Credentials must be stored in the vault under labels 'twilio-account-sid' and 'twilio-auth-token'.
 * The Twilio phone number must be stored under 'twilio-phone-number'.
 */
export async function waitForTwilioSms(senderPattern: string): Promise<string | null> {
  const sid = identityStore.getCredential('twilio-account-sid', 'twilio');
  const token = identityStore.getCredential('twilio-auth-token', 'twilio');
  if (!sid || !token) {
    console.warn('[PhoneVerifier] Twilio credentials not found in vault');
    return null;
  }

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?Direction=inbound&PageSize=5`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      const data = await res.json() as any;
      const messages: any[] = data.messages ?? [];
      const match = messages.find((m: any) =>
        m.body?.toLowerCase().includes(senderPattern.toLowerCase()) ||
        m.from?.includes(senderPattern)
      );
      if (match) return match.body as string;
    } catch (err) {
      console.error('[PhoneVerifier] Twilio poll error:', err);
    }
    await wait(POLL_INTERVAL_MS);
  }
  return null;
}

// ─── Code extraction (reuse from email-monitor pattern) ──────────────────────

export function extractSmsCode(body: string): string | null {
  const match = body.match(/\b(\d{4,8})\b/);
  return match?.[1] ?? null;
}
```

- [ ] **Step 2: TypeScript compile check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/autonomy/phone-verifier.ts
git commit -m "feat: add PhoneVerifier (Google Voice + Twilio)"
```

---

## Task 7: Site-Harness Annotations

**Files:**
- Modify: `src/main/browser/site-harness.ts`
- Modify: `src/main/db/database.ts` (migration v27 — add columns to `site_harnesses`)

The `site_harnesses` table is created by `ensureHarnessTable()` in `site-harness.ts` outside the versioned migration system. Existing users already have this table without the new columns. We need a versioned migration to `ALTER TABLE` and add the columns, plus update the TypeScript interface and `rowToHarness` mapping.

- [ ] **Step 1: Add migration v27 to `database.ts`**

Add the following block inside `runMigrations`, after the `currentVersion < 26` block (before the final `console.log`):

```typescript
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
```

Also update the final log line:
```typescript
  console.log(`[DB] Schema at version ${Math.max(currentVersion, 27)}`);
```

And add to the header comment block:
```
 *   site_harnesses.intervention_hint + is_signup_harness — signup annotation (v27)
```

- [ ] **Step 2: Add `interventionHint` and `isSignupHarness` to the `SiteHarness` interface**

In `src/main/browser/site-harness.ts`, find the `SiteHarness` interface and add after `failCount`:

```typescript
  /** If this harness required human intervention, describes what step and why. */
  interventionHint?: string;
  /** True if this harness was learned from a signup flow (vs. a regular form). */
  isSignupHarness?: boolean;
```

- [ ] **Step 3: Update `rowToHarness` to map the new columns**

In `site-harness.ts`, find the `rowToHarness` function and add the new fields to its return object:

```typescript
  interventionHint: row.intervention_hint ?? undefined,
  isSignupHarness: row.is_signup_harness === 1,
```

- [ ] **Step 4: Update `saveHarness` INSERT to persist the new fields**

In `site-harness.ts`, find the `saveHarness` function's INSERT statement. Add `intervention_hint, is_signup_harness` to the column list and the corresponding values from the harness object:

```typescript
  // In the INSERT:
  intervention_hint, is_signup_harness
  // In the VALUES:
  ${JSON.stringify(harness.interventionHint ?? null)},
  ${harness.isSignupHarness ? 1 : 0}
```

- [ ] **Step 5: TypeScript compile check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: No errors.

- [ ] **Step 6: Run full test suite**

```bash
npx vitest run
```

Expected: All tests PASS (the new optional fields are backwards compatible).

- [ ] **Step 7: Commit**

```bash
git add src/main/browser/site-harness.ts src/main/db/database.ts
git commit -m "feat: add interventionHint + isSignupHarness to SiteHarness (migration v27)"
```

---

## Task 8: Proactive Detector

**Files:**
- Create: `src/main/autonomy/proactive-detector.ts`
- Create: `tests/autonomy/proactive-detector.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/autonomy/proactive-detector.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (b: Buffer) => b.toString() },
  app: { getPath: () => os.tmpdir() },
}));

let tmpPath: string;
beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `clawdia-detect-test-${Date.now()}.sqlite`);
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

describe('ProactiveDetector', () => {
  it('detects service mentions in message text', async () => {
    const { ProactiveDetector } = await import('../../src/main/autonomy/proactive-detector');
    const detector = new ProactiveDetector();
    detector.recordMentions('I want to post something on Reddit today');
    const count = detector.getMentionCount('reddit');
    expect(count).toBe(1);
  });

  it('increments count across multiple messages', async () => {
    const { ProactiveDetector } = await import('../../src/main/autonomy/proactive-detector');
    const detector = new ProactiveDetector();
    detector.recordMentions('Let me check Reddit');
    detector.recordMentions('Can you post to Reddit for me?');
    detector.recordMentions('Reddit has a lot of info on this');
    expect(detector.getMentionCount('reddit')).toBe(3);
  });

  it('returns services over threshold', async () => {
    const { ProactiveDetector } = await import('../../src/main/autonomy/proactive-detector');
    const detector = new ProactiveDetector();
    for (let i = 0; i < 3; i++) detector.recordMentions('post to Reddit');
    const suggestions = detector.getServicesOverThreshold(3);
    expect(suggestions).toContain('reddit');
  });

  it('does not suggest services already in managed_accounts', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const { ProactiveDetector } = await import('../../src/main/autonomy/proactive-detector');
    const store = new IdentityStore();
    store.saveAccount({ serviceName: 'reddit', passwordPlain: 'pass', status: 'active' });
    const detector = new ProactiveDetector(store);
    for (let i = 0; i < 5; i++) detector.recordMentions('Reddit is great');
    const suggestions = detector.getServicesOverThreshold(3);
    expect(suggestions).not.toContain('reddit');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/autonomy/proactive-detector.test.ts
```

Expected: FAIL — `proactive-detector.ts` does not exist.

- [ ] **Step 3: Implement `proactive-detector.ts`**

Create `src/main/autonomy/proactive-detector.ts`:

```typescript
/**
 * ProactiveDetector — tracks how often services are mentioned in conversation
 * and suggests pre-creating accounts before they're needed.
 *
 * Service detection uses an allowlist + case-insensitive regex — no LLM required.
 */
import { getDb } from '../db/database';
import type { IdentityStore } from './identity-store';

// Expand this list as needed. Keys are canonical service names (lowercase).
const SERVICE_PATTERNS: Record<string, RegExp> = {
  reddit:    /\breddit\b/i,
  twitter:   /\btwitter\b|\bx\.com\b/i,
  linkedin:  /\blinkedin\b/i,
  github:    /\bgithub\b/i,
  youtube:   /\byoutube\b/i,
  instagram: /\binstagram\b/i,
  facebook:  /\bfacebook\b/i,
  tiktok:    /\btiktok\b/i,
  discord:   /\bdiscord\b/i,
  slack:     /\bslack\b/i,
  notion:    /\bnotion\b/i,
  trello:    /\btrello\b/i,
  jira:      /\bjira\b/i,
  amazon:    /\bamazon\b/i,
  ebay:      /\bebay\b/i,
};

export class ProactiveDetector {
  constructor(private readonly store?: IdentityStore) {}

  /** Scan a message for service mentions and persist counts to DB. */
  recordMentions(messageText: string): void {
    const db = getDb();
    for (const [service, pattern] of Object.entries(SERVICE_PATTERNS)) {
      if (pattern.test(messageText)) {
        db.prepare(`
          INSERT INTO service_mentions (service_name, mention_count, last_seen)
          VALUES (?, 1, datetime('now'))
          ON CONFLICT(service_name) DO UPDATE SET
            mention_count = mention_count + 1,
            last_seen = datetime('now')
        `).run(service);
      }
    }
  }

  /** Get the current mention count for a service. */
  getMentionCount(serviceName: string): number {
    const row = getDb()
      .prepare('SELECT mention_count FROM service_mentions WHERE service_name = ?')
      .get(serviceName) as any;
    return row?.mention_count ?? 0;
  }

  /**
   * Returns service names that:
   *   1. Have >= `threshold` mentions
   *   2. Do NOT have an active account in managed_accounts
   */
  getServicesOverThreshold(threshold = 3): string[] {
    const rows = getDb()
      .prepare('SELECT service_name FROM service_mentions WHERE mention_count >= ?')
      .all(threshold) as any[];

    return rows
      .map((r: any) => r.service_name as string)
      .filter((service) => {
        if (!this.store) return true;
        const account = this.store.getAccount(service);
        return !account || account.status !== 'active';
      });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/autonomy/proactive-detector.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/autonomy/proactive-detector.ts tests/autonomy/proactive-detector.test.ts
git commit -m "feat: add ProactiveDetector for service mention tracking"
```

---

## Task 9: Task Scheduler

**Files:**
- Create: `src/main/autonomy/task-scheduler.ts`
- Create: `tests/autonomy/task-scheduler.test.ts`

**Note:** `node-cron` needs to be installed. Add it before writing code.

- [ ] **Step 1: Install `node-cron`**

```bash
npm install node-cron
npm install --save-dev @types/node-cron
```

Expected: Package installed, no peer dep errors.

- [ ] **Step 2: Write the failing tests**

Create `tests/autonomy/task-scheduler.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run tests/autonomy/task-scheduler.test.ts
```

Expected: FAIL — `task-scheduler.ts` does not exist.

- [ ] **Step 4: Implement `task-scheduler.ts`**

Create `src/main/autonomy/task-scheduler.ts`:

```typescript
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
    getDb().prepare(`DELETE FROM scheduled_task_runs WHERE started_at < datetime('now', '-30 days')`).run();
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
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/autonomy/task-scheduler.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 6: Run full test suite**

```bash
npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/autonomy/task-scheduler.ts tests/autonomy/task-scheduler.test.ts package.json package-lock.json
git commit -m "feat: add TaskScheduler with node-cron + 30-day eviction"
```

---

## Task 10: Wire Autonomy Module into `main.ts`

**Files:**
- Modify: `src/main/main.ts`

- [ ] **Step 1: Add autonomy imports to `main.ts`**

Near the top import block of `src/main/main.ts`, add:

```typescript
import { identityStore } from './autonomy/identity-store';
import { proactiveDetector } from './autonomy/proactive-detector';
import { taskScheduler } from './autonomy/task-scheduler';
```

Where `proactiveDetector` is the singleton — add it to `proactive-detector.ts`:

```typescript
// At the bottom of proactive-detector.ts
export const proactiveDetector = new ProactiveDetector(identityStore);
```

And ensure `identity-store.ts` already exports `identityStore` (it does from Task 2).

- [ ] **Step 2: Hook `proactiveDetector.recordMentions` into the message-save path**

In `src/main/main.ts`, find line 192 (the `addMessage(conversationId, 'user', message.trim(), ...)` call inside the `IPC.SEND_MESSAGE` handler). Add the following line immediately after it:

```typescript
addMessage(conversationId, 'user', message.trim(), undefined, safeAttachments);
proactiveDetector.recordMentions(message.trim()); // ← add this line
```

The variable at that callsite is `message` (not `content`) and the role is hardcoded as the literal `'user'` — do not use a `role` variable, it does not exist in that scope.

- [ ] **Step 3: Initialize the task scheduler at app ready**

Inside the `app.whenReady()` block in `main.ts`, after `initProcessManager(mainWindow)` is called, add:

```typescript
// Initialize task scheduler — runs stored cron jobs
taskScheduler.start(async (prompt, taskId) => {
  // Run as a detached background agent in a synthetic conversation
  console.log(`[Scheduler] Running task ${taskId}: ${prompt.slice(0, 60)}`);
  // TODO (Phase 2): wire to process-manager background dispatch
});
```

- [ ] **Step 4: TypeScript compile check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/main.ts src/main/autonomy/proactive-detector.ts
git commit -m "feat: wire autonomy module into main process init"
```

---

## Task 10b: Email + SMS Extraction Unit Tests

The pure-logic extraction functions in `email-monitor.ts` and `phone-verifier.ts` have no external dependencies and can be tested in full isolation.

**Files:**
- Create: `tests/autonomy/email-utils.test.ts`

- [ ] **Step 1: Write the tests**

Create `tests/autonomy/email-utils.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { extractOtpCode, extractVerificationLink } from '../../src/main/autonomy/email-monitor';
import { extractSmsCode } from '../../src/main/autonomy/phone-verifier';

describe('extractOtpCode', () => {
  it('extracts a 6-digit code from a typical verification email', () => {
    expect(extractOtpCode('Your verification code is 482910. Use it within 10 minutes.')).toBe('482910');
  });

  it('extracts a 4-digit code', () => {
    expect(extractOtpCode('Your PIN is 7842')).toBe('7842');
  });

  it('returns null when no code is present', () => {
    expect(extractOtpCode('Welcome to the service! Click the link below.')).toBeNull();
  });
});

describe('extractVerificationLink', () => {
  it('extracts a verification link containing "verify"', () => {
    const body = 'Click here to verify your email: https://example.com/verify?token=abc123';
    expect(extractVerificationLink(body)).toBe('https://example.com/verify?token=abc123');
  });

  it('extracts a confirmation link', () => {
    const body = 'Confirm your account: https://app.example.com/confirm/xyz789 — link expires in 24h';
    expect(extractVerificationLink(body)).toBe('https://app.example.com/confirm/xyz789');
  });

  it('returns null when no verification link is present', () => {
    expect(extractVerificationLink('Thanks for signing up!')).toBeNull();
  });
});

describe('extractSmsCode', () => {
  it('extracts a 6-digit SMS code', () => {
    expect(extractSmsCode('Your Reddit code is 293847')).toBe('293847');
  });

  it('returns null when no code is present', () => {
    expect(extractSmsCode('No code here')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/autonomy/email-utils.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/autonomy/email-utils.test.ts
git commit -m "test: add extraction unit tests for email-monitor and phone-verifier"
```

---

## Task 11: End-to-End Integration Test (Manual)

This task has no automated test — it requires a running Clawdia instance and real browser sessions.

- [ ] **Step 1: Start Clawdia in dev mode**

```bash
npm run dev
```

- [ ] **Step 2: Test identity store via console**

Open the **main process** DevTools (not the renderer — `identity-store` is a main-process module with no Node access from the renderer). In Electron dev mode, the main process DevTools can be opened via the app menu or by adding `mainWindow.webContents.openDevTools()` temporarily. Then run:

```javascript
const { identityStore } = require('./dist/main/autonomy/identity-store');
identityStore.upsertProfile({ name: 'default', fullName: 'Your Name', email: 'you@gmail.com', isDefault: true });
identityStore.getDefaultProfile(); // Should return profile
```

- [ ] **Step 3: Test account provisioning — happy path**

Ask Clawdia: `"Create an account on mail.tm for me"`

Expected:
1. Clawdia checks `managed_accounts` — no entry for `mail.tm`
2. Logs "No active account for mail.tm — provisioning now"
3. Navigates to mail.tm signup
4. Fills form with your identity profile
5. Completes email verification
6. Saves account to `managed_accounts`
7. Reports success in chat

Verify in DB:
```bash
sqlite3 ~/.config/Clawdia/data.sqlite "SELECT service_name, username, status FROM managed_accounts;"
```

- [ ] **Step 4: Test human-in-the-loop pause/resume**

Ask Clawdia to sign up for a service that requires a CAPTCHA (e.g. Reddit).

Expected:
1. Clawdia fills the form
2. Hits the CAPTCHA step
3. Posts in chat: "I hit a CAPTCHA on Reddit's signup page..."
4. Browser panel is paused on the CAPTCHA page
5. You solve the CAPTCHA
6. Clawdia auto-resumes within 1–2 seconds
7. Completes signup

- [ ] **Step 5: Test proactive detection**

Mention "Reddit" 3+ times in conversation. Check DB:

```bash
sqlite3 ~/.config/Clawdia/data.sqlite "SELECT service_name, mention_count FROM service_mentions;"
```

Expected: `reddit` row with `mention_count >= 3`.

- [ ] **Step 6: Test task scheduler**

Via DevTools console, create a test task:

```javascript
const { taskScheduler } = require('./dist/main/autonomy/task-scheduler');
taskScheduler.createTask({ name: 'Test job', cronExpr: '* * * * *', prompt: 'Say hello' });
taskScheduler.listTasks(); // Should return the task
```

Wait 1 minute and check runs:

```bash
sqlite3 ~/.config/Clawdia/data.sqlite "SELECT task_id, status, started_at FROM scheduled_task_runs ORDER BY started_at DESC LIMIT 5;"
```

---

## Task 12: Final Cleanup + Full Test Run

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: All tests PASS with no failures.

- [ ] **Step 2: TypeScript full compile**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: No errors.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: Clawdia Autonomy Layer — complete implementation"
```

---

## Summary

| Task | Description | Tests |
|------|-------------|-------|
| 0 | Validate Bloodhound | Manual |
| 1 | DB migrations v24–v27 | `db-migrations.test.ts` |
| 2 | Identity store + vault | `identity-store.test.ts` |
| 3 | Email monitor | TypeScript check only |
| 4 | Account provisioner | `account-provisioner.test.ts` |
| 5 | HitL new types + DOM polling | `intervention-types.test.ts` |
| 6 | Phone verifier | TypeScript check only |
| 7 | Site-harness annotations + migration v27 | TypeScript check + full suite |
| 8 | Proactive detector | `proactive-detector.test.ts` |
| 9 | Task scheduler | `task-scheduler.test.ts` |
| 10 | Wire into main.ts | TypeScript check |
| 10b | Email + SMS extraction unit tests | `email-utils.test.ts` |
| 11 | E2E manual integration | Manual |
| 12 | Final cleanup | Full suite |
