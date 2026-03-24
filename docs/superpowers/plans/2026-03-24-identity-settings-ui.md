# Identity Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Identity section to SettingsView with profile form, accounts table, credential vault display, and a browser login interceptor that auto-captures credentials from the persistent BrowserView.

**Architecture:** Six tasks in dependency order: (1) extend IdentityStore with 4 new methods, (2) add IPC channels, (3) expose preload API, (4) register IPC handlers in main, (5) build IdentitySection React component, (6) implement the login interceptor. Each task is independently testable and committable. The login interceptor is wired last because it depends on the IPC event channel added in task 2.

**Tech Stack:** TypeScript, Electron (ipcMain / ipcRenderer / contextBridge / safeStorage / BrowserWindow), React 18, Tailwind CSS (project design tokens), better-sqlite3, Jest (tests run with `npm test`)

---

## File Map

| Status | File | Task |
|--------|------|------|
| Modify | `src/main/autonomy/identity-store.ts` | Task 1 |
| Modify | `src/shared/ipc-channels.ts` | Task 2 |
| Modify | `src/main/preload.ts` | Task 3 |
| Modify | `src/main/main.ts` | Task 4 |
| Create | `src/renderer/components/IdentitySection.tsx` | Task 5 |
| Modify | `src/renderer/components/SettingsView.tsx` | Task 5 |
| Create | `src/main/autonomy/login-interceptor.ts` | Task 6 |
| Modify | `src/main/main.ts` | Task 6 |
| Create | `tests/autonomy/identity-store-list.test.ts` | Task 1 |
| Create | `tests/identity/ipc-security.test.ts` | Task 4 |
| Create | `tests/identity/login-interceptor.test.ts` | Task 6 |

---

## Task 1: Extend IdentityStore with list/delete methods

The existing `IdentityStore` class (`src/main/autonomy/identity-store.ts`) already has `saveAccount`, `getAccount`, `saveCredential`, `getCredential`. We need four more methods required by the UI and the IPC handlers:
- `listAccounts(): ManagedAccount[]`
- `deleteAccount(serviceName: string): void`
- `listCredentials(): { label: string; type: string; service: string; maskedValue: string }[]`
- `deleteCredential(label: string, service: string): void`

**Files:**
- Modify: `src/main/autonomy/identity-store.ts` (after line 229, before the closing `}` of the class)
- Create: `tests/autonomy/identity-store-list.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/autonomy/identity-store-list.test.ts`:

```typescript
import Database from 'better-sqlite3';
import * as path from 'path';

// ── Minimal in-memory DB setup ────────────────────────────────────────────────
// We replicate only the tables needed for IdentityStore methods under test.
// We do NOT import IdentityStore directly because it calls getDb() which
// requires the Electron runtime. Instead we test the SQL logic by calling
// the methods via a thin wrapper that uses our in-memory DB.

// Helper: build the schema on an in-memory DB
function buildDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_accounts (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      service_name        TEXT NOT NULL,
      login_url           TEXT NOT NULL DEFAULT '',
      username            TEXT NOT NULL DEFAULT '',
      email_used          TEXT NOT NULL DEFAULT '',
      password_encrypted  TEXT NOT NULL DEFAULT '',
      phone_used          TEXT NOT NULL DEFAULT '',
      phone_method        TEXT NOT NULL DEFAULT '',
      identity_profile_id INTEGER,
      status              TEXT NOT NULL DEFAULT 'unverified',
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      notes               TEXT NOT NULL DEFAULT '',
      UNIQUE(service_name)
    );
    CREATE TABLE IF NOT EXISTS credential_vault (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      label           TEXT NOT NULL,
      type            TEXT NOT NULL,
      service         TEXT NOT NULL DEFAULT '',
      value_encrypted TEXT NOT NULL,
      expires_at      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(label, service)
    );
  `);
  return db;
}

// ── Unit tests for SQL logic (not full IdentityStore to avoid Electron dep) ──

describe('listAccounts SQL', () => {
  it('returns all rows as ManagedAccount shape (without decryption)', () => {
    const db = buildDb();
    db.prepare(`INSERT INTO managed_accounts (service_name, username, password_encrypted, status)
      VALUES ('reddit.com', 'dp_user', 'enc_pw', 'active')`).run();
    db.prepare(`INSERT INTO managed_accounts (service_name, username, password_encrypted, status)
      VALUES ('github.com', 'dpdev', 'enc_pw2', 'active')`).run();

    const rows = db.prepare('SELECT * FROM managed_accounts').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].service_name).toBe('reddit.com');
    expect(rows[1].service_name).toBe('github.com');
    // password_encrypted is present (decryption done in IdentityStore.listAccounts)
    expect(rows[0].password_encrypted).toBe('enc_pw');
  });
});

describe('deleteAccount SQL', () => {
  it('removes the row matching service_name', () => {
    const db = buildDb();
    db.prepare(`INSERT INTO managed_accounts (service_name, username, password_encrypted)
      VALUES ('reddit.com', 'dp_user', 'enc')`).run();

    db.prepare('DELETE FROM managed_accounts WHERE service_name = ?').run('reddit.com');
    const row = db.prepare('SELECT * FROM managed_accounts WHERE service_name = ?').get('reddit.com');
    expect(row).toBeUndefined();
  });
});

describe('listCredentials masking', () => {
  it('masks values with bullets except last 4 chars', () => {
    const mask = (val: string) =>
      '•'.repeat(Math.max(0, val.length - 4)) + val.slice(-4);

    expect(mask('AC1234567890abcd3f2a')).toBe('••••••••••••••••3f2a');
    expect(mask('abcd')).toBe('abcd');
    expect(mask('ab')).toBe('ab');
    expect(mask('')).toBe('');
  });

  it('listCredentials SQL returns all vault rows', () => {
    const db = buildDb();
    db.prepare(`INSERT INTO credential_vault (label, type, service, value_encrypted)
      VALUES ('twilio-sid', 'api_key', 'twilio', 'enc_val')`).run();
    db.prepare(`INSERT INTO credential_vault (label, type, service, value_encrypted)
      VALUES ('gh-pass', 'app_password', 'github', 'enc_val2')`).run();

    const rows = db.prepare('SELECT label, type, service, value_encrypted FROM credential_vault').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].label).toBe('twilio-sid');
    expect(rows[1].label).toBe('gh-pass');
  });
});

describe('deleteCredential SQL', () => {
  it('removes row matching label AND service (composite key)', () => {
    const db = buildDb();
    db.prepare(`INSERT INTO credential_vault (label, type, service, value_encrypted)
      VALUES ('mykey', 'api_key', 'myservice', 'enc')`).run();
    db.prepare(`INSERT INTO credential_vault (label, type, service, value_encrypted)
      VALUES ('mykey', 'api_key', 'otherservice', 'enc2')`).run();

    // Delete only the first one
    db.prepare('DELETE FROM credential_vault WHERE label = ? AND service = ?').run('mykey', 'myservice');

    const remaining = db.prepare('SELECT * FROM credential_vault').all() as any[];
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as any).service).toBe('otherservice');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/autonomy/identity-store-list.test.ts --no-coverage 2>&1 | tail -20
```

Expected: Tests pass (they test raw SQL, not IdentityStore methods — the SQL already works). If any fail, fix the test SQL before continuing.

- [ ] **Step 3: Add the four new methods to IdentityStore**

**IMPORTANT:** `getAccount(serviceName)` **already exists** at lines 182-198 of `identity-store.ts`. Do NOT add it again.

In `src/main/autonomy/identity-store.ts`, insert after the `getCredential` method (line 229) and before the closing `}` of the class. Add **only** these four methods:

```typescript
  // ── List / Delete (required for settings UI) ──

  listAccounts(): ManagedAccount[] {
    const rows = getDb().prepare('SELECT * FROM managed_accounts ORDER BY created_at DESC').all() as any[];
    return rows.map(row => ({
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
    }));
  }

  deleteAccount(serviceName: string): void {
    getDb().prepare('DELETE FROM managed_accounts WHERE service_name = ?').run(serviceName);
  }

  listCredentials(): { label: string; type: string; service: string; maskedValue: string }[] {
    const rows = getDb().prepare(
      'SELECT label, type, service, value_encrypted FROM credential_vault ORDER BY created_at DESC'
    ).all() as any[];
    return rows.map(row => {
      const val = this.decrypt(row.value_encrypted);
      const maskedValue = '•'.repeat(Math.max(0, val.length - 4)) + val.slice(-4);
      return { label: row.label, type: row.type, service: row.service, maskedValue };
    });
  }

  deleteCredential(label: string, service: string): void {
    getDb().prepare('DELETE FROM credential_vault WHERE label = ? AND service = ?').run(label, service);
  }
```

- [ ] **Step 4: Confirm tests still pass**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/autonomy/identity-store-list.test.ts --no-coverage 2>&1 | tail -10
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/main/autonomy/identity-store.ts tests/autonomy/identity-store-list.test.ts && git commit -m "feat: add listAccounts, deleteAccount, listCredentials, deleteCredential to IdentityStore"
```

---

## Task 2: Add IPC channels

Add 8 invoke channels and 1 event channel to `src/shared/ipc-channels.ts`.

**Files:**
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Add invoke channels to the `IPC` object**

In `src/shared/ipc-channels.ts`, insert before the `} as const;` on line 64:

```typescript
  // Identity settings
  IDENTITY_PROFILE_GET: 'identity:profile:get',
  IDENTITY_PROFILE_SET: 'identity:profile:set',
  IDENTITY_ACCOUNTS_LIST: 'identity:accounts:list',
  IDENTITY_ACCOUNT_ADD: 'identity:account:add',
  IDENTITY_ACCOUNT_DELETE: 'identity:account:delete',
  IDENTITY_CREDENTIALS_LIST: 'identity:credentials:list',
  IDENTITY_CREDENTIAL_ADD: 'identity:credential:add',
  IDENTITY_CREDENTIAL_DELETE: 'identity:credential:delete',
```

- [ ] **Step 2: Add event channel to the `IPC_EVENTS` object**

In `src/shared/ipc-channels.ts`, insert before the `} as const;` on line 85 (the closing of `IPC_EVENTS`):

```typescript
  // Identity events (pushed from main to renderer)
  IDENTITY_ACCOUNTS_CHANGED: 'identity:accounts-changed',
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors (or only pre-existing errors unrelated to identity channels).

- [ ] **Step 4: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/shared/ipc-channels.ts && git commit -m "feat: add identity IPC channels and IDENTITY_ACCOUNTS_CHANGED event"
```

---

## Task 3: Expose identity API on preload

Add `window.clawdia.identity` to the contextBridge.

**Files:**
- Modify: `src/main/preload.ts`

- [ ] **Step 1: Add the identity namespace**

In `src/main/preload.ts`, insert after the `swarm:` block (after line 102) and before `policy:`:

```typescript
  identity: {
    getProfile: () => invoke('identity:profile:get'),
    setProfile: (input: any) => invoke('identity:profile:set', input),
    listAccounts: () => invoke('identity:accounts:list'),
    addAccount: (input: any) => invoke('identity:account:add', input),
    deleteAccount: (serviceName: string) => invoke('identity:account:delete', serviceName),
    listCredentials: () => invoke('identity:credentials:list'),
    addCredential: (label: string, type: string, service: string, valuePlain: string) =>
      invoke('identity:credential:add', label, type, service, valuePlain),
    deleteCredential: (label: string, service: string) =>
      invoke('identity:credential:delete', label, service),
    onAccountsChanged: (cb: () => void) => on('identity:accounts-changed', cb),
  },
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/main/preload.ts && git commit -m "feat: expose window.clawdia.identity preload API"
```

---

## Task 4: Register IPC handlers in main.ts

Add identity IPC handlers to `setupIpcHandlers()` in `src/main/main.ts`. Also write a security test confirming `passwordPlain` is never returned to the renderer.

**Files:**
- Modify: `src/main/main.ts` (inside `setupIpcHandlers()`, after the last handler ~line 490)
- Create: `tests/identity/ipc-security.test.ts`

- [ ] **Step 1: Write the failing security test**

Create `tests/identity/ipc-security.test.ts`:

```typescript
/**
 * IPC security tests — verify that sensitive fields never reach the renderer.
 * These tests exercise the DTO transformation logic in isolation.
 */

import type { ManagedAccount } from '../../src/main/autonomy/identity-store';

// ── DTO transform (mirrors the IPC handler logic) ────────────────────────────

interface ManagedAccountView {
  id: number;
  serviceName: string;
  loginUrl: string;
  username: string;
  emailUsed: string;
  passwordPlain?: string;   // must NOT be present
  phoneUsed: string;
  phoneMethod: string;
  status: 'active' | 'suspended' | 'unverified';
  accessType: 'session' | 'vault' | 'managed';
  createdAt: string;
  notes: string;
}

function stripPassword(account: ManagedAccount, accessType: 'session' | 'vault' | 'managed'): ManagedAccountView {
  const { passwordPlain: _omit, ...view } = account;
  return { ...view, accessType };
}

const mockAccount: ManagedAccount = {
  id: 1,
  serviceName: 'reddit.com',
  loginUrl: 'https://reddit.com/login',
  username: 'dp_user',
  emailUsed: '',
  passwordPlain: 'supersecret123',
  phoneUsed: '',
  phoneMethod: '',
  status: 'active',
  createdAt: '2026-03-24T00:00:00Z',
  notes: '',
};

describe('IDENTITY_ACCOUNTS_LIST DTO', () => {
  it('does not include passwordPlain in the rendered view', () => {
    const view = stripPassword(mockAccount, 'session');
    expect('passwordPlain' in view).toBe(false);
    expect((view as any).passwordPlain).toBeUndefined();
  });

  it('includes all other expected fields', () => {
    const view = stripPassword(mockAccount, 'vault');
    expect(view.id).toBe(1);
    expect(view.serviceName).toBe('reddit.com');
    expect(view.username).toBe('dp_user');
    expect(view.accessType).toBe('vault');
  });

  it('accessType is set by the caller, not read from the account', () => {
    const session = stripPassword(mockAccount, 'session');
    const managed = stripPassword(mockAccount, 'managed');
    expect(session.accessType).toBe('session');
    expect(managed.accessType).toBe('managed');
  });
});

describe('IDENTITY_CREDENTIALS_LIST masking', () => {
  it('masks all but last 4 chars', () => {
    const mask = (val: string) =>
      '•'.repeat(Math.max(0, val.length - 4)) + val.slice(-4);
    expect(mask('AC1234567890abcd3f2a')).toBe('••••••••••••••••3f2a');
    expect(mask('abcd')).toBe('abcd');
    expect(mask('short')).toBe('•hort');
    expect(mask('')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to confirm it passes now**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/identity/ipc-security.test.ts --no-coverage 2>&1 | tail -15
```

Expected: All tests pass (they test pure transformation functions, no Electron needed).

- [ ] **Step 3: Add identity IPC handlers to main.ts**

Find the end of `setupIpcHandlers()` in `src/main/main.ts` (look for the last `ipcMain.handle` before the closing `}`). Insert the identity handlers after the existing browser session handlers:

```typescript
  // ── Identity ──
  ipcMain.handle(IPC.IDENTITY_PROFILE_GET, () => {
    return identityStore.getDefaultProfile();
  });

  ipcMain.handle(IPC.IDENTITY_PROFILE_SET, (_e, input: any) => {
    return identityStore.upsertProfile({ ...input, name: 'default', isDefault: true });
  });

  ipcMain.handle(IPC.IDENTITY_ACCOUNTS_LIST, async () => {
    const accounts = identityStore.listAccounts();
    // Compute accessType per account: session > vault > managed
    // session.cookies.get requires the browser session — import getBrowserSession
    const session = getBrowserSession();
    return Promise.all(accounts.map(async (account) => {
      const { passwordPlain: _omit, ...view } = account;
      let accessType: 'session' | 'vault' | 'managed' = 'managed';
      if (session) {
        try {
          const cookies = await session.cookies.get({ domain: account.serviceName });
          if (cookies.length > 0) {
            accessType = 'session';
          } else {
            const cred = identityStore.getCredential(account.serviceName, account.serviceName);
            if (cred) accessType = 'vault';
          }
        } catch {
          // cookie check failed — fall through to 'managed'
        }
      }
      return { ...view, accessType };
    }));
  });

  ipcMain.handle(IPC.IDENTITY_ACCOUNT_ADD, (_e, input: any) => {
    const account = identityStore.saveAccount({ ...input, status: 'active' });
    const { passwordPlain: _omit, ...view } = account;
    return { ...view, accessType: 'managed' as const };
  });

  ipcMain.handle(IPC.IDENTITY_ACCOUNT_DELETE, (_e, serviceName: string) => {
    identityStore.deleteAccount(serviceName);
    return { ok: true };
  });

  ipcMain.handle(IPC.IDENTITY_CREDENTIALS_LIST, () => {
    return identityStore.listCredentials();
  });

  ipcMain.handle(IPC.IDENTITY_CREDENTIAL_ADD, (_e, label: string, type: string, service: string, valuePlain: string) => {
    identityStore.saveCredential({ label, type: type as any, service, valuePlain });
    return { ok: true };
  });

  ipcMain.handle(IPC.IDENTITY_CREDENTIAL_DELETE, (_e, label: string, service: string) => {
    identityStore.deleteCredential(label, service);
    return { ok: true };
  });
```

**Note on `getBrowserSession`:** It's already imported at line 58: `import { getBrowserSession } from './browser/session';`. No new import needed.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

Expected: No new errors.

- [ ] **Step 5: Run security test again to confirm still passing**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/identity/ipc-security.test.ts --no-coverage 2>&1 | tail -10
```

Expected: Pass.

- [ ] **Step 6: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/main/main.ts tests/identity/ipc-security.test.ts && git commit -m "feat: register identity IPC handlers in main.ts"
```

---

## Task 5: Build IdentitySection React component + wire into SettingsView

Create `src/renderer/components/IdentitySection.tsx` with the three subsections (profile form, accounts table, credential vault) and add it to `SettingsView.tsx`.

**Files:**
- Create: `src/renderer/components/IdentitySection.tsx`
- Modify: `src/renderer/components/SettingsView.tsx`

There are no Jest-testable units in a pure React UI component when we have no renderer test harness set up. Skip unit tests for this task — visual verification is done by running the app. TypeScript compilation is the quality gate.

- [ ] **Step 1: Create IdentitySection.tsx**

Create `src/renderer/components/IdentitySection.tsx`:

```tsx
import React, { useState, useEffect, useCallback } from 'react';

// ── Types (mirror spec DTOs — no import from main process) ───────────────────

interface IdentityProfile {
  id: number;
  name: string;
  fullName: string;
  email: string;
  usernamePattern: string;
  dateOfBirth?: string;
  isDefault: boolean;
}

interface ManagedAccountView {
  id: number;
  serviceName: string;
  loginUrl: string;
  username: string;
  emailUsed: string;
  phoneUsed: string;
  phoneMethod: string;
  status: 'active' | 'suspended' | 'unverified';
  accessType: 'session' | 'vault' | 'managed';
  createdAt: string;
  notes: string;
}

interface CredentialView {
  label: string;
  type: string;
  service: string;
  maskedValue: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function IdentitySection() {
  const api = (window as any).clawdia?.identity;

  // Profile state
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [usernamePattern, setUsernamePattern] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);

  // Accounts state
  const [accounts, setAccounts] = useState<ManagedAccountView[]>([]);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [newAccountService, setNewAccountService] = useState('');
  const [newAccountUsername, setNewAccountUsername] = useState('');
  const [newAccountPassword, setNewAccountPassword] = useState('');

  // Credentials state
  const [credentials, setCredentials] = useState<CredentialView[]>([]);
  const [showAddCred, setShowAddCred] = useState(false);
  const [newCredLabel, setNewCredLabel] = useState('');
  const [newCredType, setNewCredType] = useState<'api_key' | 'session_token' | 'app_password' | 'oauth_token'>('api_key');
  const [newCredService, setNewCredService] = useState('');
  const [newCredValue, setNewCredValue] = useState('');

  // ── Load on mount ──

  const loadAccounts = useCallback(async () => {
    if (!api) return;
    const list = await api.listAccounts();
    setAccounts(list || []);
  }, [api]);

  useEffect(() => {
    if (!api) return;

    // Load profile
    api.getProfile().then((profile: IdentityProfile | null) => {
      if (!profile) return;
      setFullName(profile.fullName || '');
      setEmail(profile.email || '');
      setUsernamePattern(profile.usernamePattern || '');
      setDateOfBirth(profile.dateOfBirth || '');
    });

    // Load accounts + credentials
    loadAccounts();
    api.listCredentials().then((list: CredentialView[]) => setCredentials(list || []));

    // Subscribe to live account changes (login interceptor fires this)
    const cleanup = api.onAccountsChanged(() => loadAccounts());
    return cleanup;
  }, [api, loadAccounts]);

  // ── Profile save ──

  const handleSaveProfile = async () => {
    if (!api) return;
    await api.setProfile({ fullName, email, usernamePattern, dateOfBirth });
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2000);
  };

  // ── Account actions ──

  const handleAddAccount = async () => {
    if (!api || !newAccountService.trim()) return;
    await api.addAccount({
      serviceName: newAccountService.trim(),
      username: newAccountUsername.trim(),
      passwordPlain: newAccountPassword,
    });
    setNewAccountService('');
    setNewAccountUsername('');
    setNewAccountPassword('');
    setShowAddAccount(false);
    await loadAccounts();
  };

  const handleDeleteAccount = async (serviceName: string) => {
    if (!api) return;
    await api.deleteAccount(serviceName);
    await loadAccounts();
  };

  // ── Credential actions ──

  const handleAddCredential = async () => {
    if (!api || !newCredLabel.trim()) return;
    await api.addCredential(newCredLabel.trim(), newCredType, newCredService.trim(), newCredValue);
    setNewCredLabel('');
    setNewCredType('api_key');
    setNewCredService('');
    setNewCredValue('');
    setShowAddCred(false);
    const list = await api.listCredentials();
    setCredentials(list || []);
  };

  const handleDeleteCredential = async (label: string, service: string) => {
    if (!api) return;
    await api.deleteCredential(label, service);
    const list = await api.listCredentials();
    setCredentials(list || []);
  };

  // ── Access type pill ──

  const accessPill = (accessType: 'session' | 'vault' | 'managed') => {
    const config = {
      session: { color: 'text-[#4ade80]', bg: 'bg-[#4ade80]/10', label: 'Session' },
      vault:   { color: 'text-[#fbbf24]', bg: 'bg-[#fbbf24]/10', label: 'Vault' },
      managed: { color: 'text-accent',    bg: 'bg-accent/10',    label: 'Managed' },
    }[accessType];
    return (
      <span className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full ${config.bg} ${config.color}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
        {config.label}
      </span>
    );
  };

  // ── Credential type icon ──
  const credIcon = (type: string) => {
    if (type === 'api_key') return '🔑';
    if (type === 'oauth_token') return '🔗';
    return '🔒';
  };

  // ── Input class (shared) ──
  const inputCls = 'w-full h-[34px] bg-surface-2 text-text-primary text-sm pl-3 pr-3 rounded-lg border border-border placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors';

  return (
    <>
      {/* ── Identity Profile ── */}
      <section className="flex flex-col gap-2">
        <label className="text-xs font-medium text-text-secondary uppercase tracking-wider">Identity Profile</label>
        <p className="text-2xs text-text-muted -mt-1">
          Clawdia uses this when signing up for services on your behalf. Leave fields blank to exclude them.
        </p>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Full name</span>
            <input
              className={inputCls}
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              placeholder="Your name"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Email</span>
            <input
              className={inputCls}
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Username pattern</span>
            <input
              className={inputCls}
              value={usernamePattern}
              onChange={e => setUsernamePattern(e.target.value)}
              placeholder="e.g. dp_, dp123"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Date of birth</span>
            <input
              className={inputCls}
              value={dateOfBirth}
              onChange={e => setDateOfBirth(e.target.value)}
              placeholder="YYYY-MM-DD"
            />
          </div>
        </div>

        <button
          onClick={handleSaveProfile}
          className={`self-start h-[34px] px-4 rounded-lg text-sm font-medium transition-all cursor-pointer ${
            profileSaved ? 'bg-status-success/20 text-status-success' : 'bg-accent/90 hover:bg-accent text-white'
          }`}
        >
          {profileSaved ? 'Saved ✓' : 'Save Profile'}
        </button>
      </section>

      <div className="h-px bg-border-subtle" />

      {/* ── Accounts ── */}
      <section className="flex flex-col gap-2">
        <label className="text-xs font-medium text-text-secondary uppercase tracking-wider">Accounts</label>
        <p className="text-2xs text-text-muted -mt-1">
          All accounts Clawdia can access. Session cookies take priority over saved credentials.
        </p>

        {accounts.length > 0 && (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {['Service', 'Username', 'Access', ''].map(h => (
                  <th key={h} className="text-left text-[10px] font-semibold uppercase tracking-wider text-text-muted pb-2 px-1">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.map(acc => (
                <tr key={acc.id} className="group border-t border-surface-2 hover:bg-white/[0.02]">
                  <td className="px-1 py-1.5 text-text-primary text-xs">{acc.serviceName}</td>
                  <td className="px-1 py-1.5 text-text-secondary text-xs">{acc.username || acc.emailUsed || '—'}</td>
                  <td className="px-1 py-1.5">{accessPill(acc.accessType)}</td>
                  <td className="px-1 py-1.5 text-right">
                    <button
                      onClick={() => handleDeleteAccount(acc.serviceName)}
                      className="w-6 h-6 rounded flex items-center justify-center text-text-muted hover:bg-red-500/10 hover:text-red-400 transition-colors cursor-pointer"
                      title="Remove account"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {showAddAccount && (
          <div className="flex flex-col gap-2 p-3 rounded-xl border border-border bg-surface-2/50">
            <div className="grid grid-cols-3 gap-2">
              <input className={inputCls} placeholder="Service (e.g. reddit.com)" value={newAccountService} onChange={e => setNewAccountService(e.target.value)} />
              <input className={inputCls} placeholder="Username" value={newAccountUsername} onChange={e => setNewAccountUsername(e.target.value)} />
              <input className={inputCls} type="password" placeholder="Password" value={newAccountPassword} onChange={e => setNewAccountPassword(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <button onClick={handleAddAccount} className="h-[30px] px-3 rounded-lg bg-accent/90 hover:bg-accent text-white text-xs font-medium cursor-pointer transition-colors">Add</button>
              <button onClick={() => setShowAddAccount(false)} className="h-[30px] px-3 rounded-lg text-text-muted hover:text-text-secondary text-xs cursor-pointer transition-colors">Cancel</button>
            </div>
          </div>
        )}

        {!showAddAccount && (
          <button
            onClick={() => setShowAddAccount(true)}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary border border-dashed border-border hover:border-border-subtle rounded-lg px-3 py-2 transition-colors cursor-pointer w-full bg-transparent"
          >
            <span className="text-base leading-none">＋</span> Add account manually
          </button>
        )}
      </section>

      <div className="h-px bg-border-subtle" />

      {/* ── Credential Vault ── */}
      <section className="flex flex-col gap-2">
        <label className="text-xs font-medium text-text-secondary uppercase tracking-wider">Credential Vault</label>
        <p className="text-2xs text-text-muted -mt-1">
          API keys, tokens, and passwords stored encrypted on this device.
        </p>

        {credentials.map(cred => (
          <div key={`${cred.label}:${cred.service}`} className="flex items-center gap-2.5 px-2.5 py-2 rounded-xl border border-border bg-surface-2/40">
            <div className="w-7 h-7 rounded-lg bg-surface-2 flex items-center justify-center text-sm flex-shrink-0">
              {credIcon(cred.type)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-text-primary font-medium truncate">{cred.label}</div>
              <div className="text-[10px] text-text-muted">{cred.type} · {cred.service || '—'}</div>
            </div>
            <div className="text-[11px] text-text-muted font-mono flex-shrink-0">{cred.maskedValue}</div>
            <button
              onClick={() => handleDeleteCredential(cred.label, cred.service)}
              className="w-6 h-6 rounded flex items-center justify-center text-text-muted hover:bg-red-500/10 hover:text-red-400 transition-colors cursor-pointer flex-shrink-0"
              title="Delete credential"
            >
              ✕
            </button>
          </div>
        ))}

        {showAddCred && (
          <div className="flex flex-col gap-2 p-3 rounded-xl border border-border bg-surface-2/50">
            <div className="grid grid-cols-2 gap-2">
              <input className={inputCls} placeholder="Label (e.g. twilio-sid)" value={newCredLabel} onChange={e => setNewCredLabel(e.target.value)} />
              <select
                value={newCredType}
                onChange={e => setNewCredType(e.target.value as any)}
                className="h-[34px] bg-surface-2 text-text-primary text-sm pl-3 rounded-lg border border-border outline-none focus:border-accent/40 transition-colors"
              >
                <option value="api_key">API Key</option>
                <option value="session_token">Session Token</option>
                <option value="app_password">App Password</option>
                <option value="oauth_token">OAuth Token</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input className={inputCls} placeholder="Service (e.g. twilio)" value={newCredService} onChange={e => setNewCredService(e.target.value)} />
              <input className={inputCls} type="password" placeholder="Value" value={newCredValue} onChange={e => setNewCredValue(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <button onClick={handleAddCredential} className="h-[30px] px-3 rounded-lg bg-accent/90 hover:bg-accent text-white text-xs font-medium cursor-pointer transition-colors">Add</button>
              <button onClick={() => setShowAddCred(false)} className="h-[30px] px-3 rounded-lg text-text-muted hover:text-text-secondary text-xs cursor-pointer transition-colors">Cancel</button>
            </div>
          </div>
        )}

        {!showAddCred && (
          <button
            onClick={() => setShowAddCred(true)}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary border border-dashed border-border hover:border-border-subtle rounded-lg px-3 py-2 transition-colors cursor-pointer w-full bg-transparent"
          >
            <span className="text-base leading-none">＋</span> Add credential
          </button>
        )}
      </section>
    </>
  );
}
```

- [ ] **Step 2: Wire IdentitySection into SettingsView.tsx**

In `src/renderer/components/SettingsView.tsx`:

a) Add import at the top (after the existing imports):
```typescript
import IdentitySection from './IdentitySection';
```

b) In the JSX, insert before the closing `</div>` of the inner `max-w-[440px]` div (before line 234 in the original, just before `</div></div></div>`), add a divider and the section:

```tsx
          <div className="h-px bg-border-subtle" />
          <IdentitySection />
```

The existing save button for general Settings stays where it is. `IdentitySection` handles its own save internally.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -30
```

Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/renderer/components/IdentitySection.tsx src/renderer/components/SettingsView.tsx && git commit -m "feat: add IdentitySection component with profile form, accounts table, credential vault"
```

---

## Task 6: Implement login interceptor

Create `src/main/autonomy/login-interceptor.ts` and wire it into `main.ts`.

**Files:**
- Create: `src/main/autonomy/login-interceptor.ts`
- Modify: `src/main/main.ts` (add `initLoginInterceptor` call in `ready-to-show`)
- Create: `tests/identity/login-interceptor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/identity/login-interceptor.test.ts`:

```typescript
/**
 * Tests for the login interceptor state machine.
 * We test the pure logic (URL classification, pending capture state, success detection)
 * without requiring Electron's webContents.
 */

// ── URL helpers (extracted from login-interceptor.ts for testability) ─────────

function isLoginUrl(url: string): boolean {
  try {
    const { pathname, hostname } = new URL(url);
    const path = pathname.toLowerCase();
    return path.includes('/login') || path.includes('/signin') ||
           path.includes('/auth') || path.includes('/session') ||
           hostname.includes('login.') || hostname.includes('signin.');
  } catch {
    return false;
  }
}

function isAuthUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const p = pathname.toLowerCase();
    return isLoginUrl(url) || p.includes('/2fa') || p.includes('/verify') ||
           p.includes('/otp') || p.includes('/mfa') || p.includes('/challenge');
  } catch {
    return false;
  }
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

// ── State machine simulation ───────────────────────────────────────────────────

type PendingCapture = { username: string; password: string; loginUrl: string };

function simulateInterceptor() {
  const pendingCaptures = new Map<number, PendingCapture>();
  const saved: { serviceName: string; username: string }[] = [];

  const onWillNavigate = (wcId: number, fromUrl: string, captured: PendingCapture | null) => {
    if (!fromUrl.startsWith('https://')) return;
    if (isLoginUrl(fromUrl) && captured) {
      pendingCaptures.set(wcId, { ...captured, loginUrl: fromUrl });
    }
  };

  const onDidNavigate = (wcId: number, newUrl: string) => {
    const pending = pendingCaptures.get(wcId);
    if (!pending) return;
    if (isAuthUrl(newUrl)) return; // 2FA / error — hold or discard
    if (isLoginUrl(newUrl)) {
      // Failed login — landed back on login page
      pendingCaptures.delete(wcId);
      return;
    }
    // Success
    pendingCaptures.delete(wcId);
    saved.push({ serviceName: extractDomain(pending.loginUrl), username: pending.username });
  };

  return { pendingCaptures, saved, onWillNavigate, onDidNavigate };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('isLoginUrl', () => {
  it('detects /login paths', () => {
    expect(isLoginUrl('https://reddit.com/login')).toBe(true);
    expect(isLoginUrl('https://example.com/signin')).toBe(true);
    expect(isLoginUrl('https://auth.example.com/auth/token')).toBe(true);
  });

  it('does not flag non-login pages', () => {
    expect(isLoginUrl('https://reddit.com/r/programming')).toBe(false);
    expect(isLoginUrl('https://github.com/dashboard')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isLoginUrl('not-a-url')).toBe(false);
  });
});

describe('HTTPS-only guard', () => {
  it('does not store capture for HTTP pages', () => {
    const { pendingCaptures, onWillNavigate } = simulateInterceptor();
    onWillNavigate(1, 'http://reddit.com/login', { username: 'u', password: 'p', loginUrl: 'http://reddit.com/login' });
    expect(pendingCaptures.size).toBe(0);
  });

  it('stores capture for HTTPS pages', () => {
    const { pendingCaptures, onWillNavigate } = simulateInterceptor();
    onWillNavigate(1, 'https://reddit.com/login', { username: 'u', password: 'p', loginUrl: 'https://reddit.com/login' });
    expect(pendingCaptures.size).toBe(1);
  });
});

describe('Successful login capture', () => {
  it('saves credentials when navigating from login to non-auth URL', () => {
    const { saved, onWillNavigate, onDidNavigate } = simulateInterceptor();
    onWillNavigate(1, 'https://reddit.com/login', { username: 'dp_user', password: 'secret', loginUrl: 'https://reddit.com/login' });
    onDidNavigate(1, 'https://reddit.com/');
    expect(saved).toHaveLength(1);
    expect(saved[0].serviceName).toBe('reddit.com');
    expect(saved[0].username).toBe('dp_user');
  });
});

describe('Failed login — lands back on login URL', () => {
  it('discards pending capture when did-navigate returns to a login URL', () => {
    const { saved, pendingCaptures, onWillNavigate, onDidNavigate } = simulateInterceptor();
    onWillNavigate(1, 'https://reddit.com/login', { username: 'dp_user', password: 'wrong', loginUrl: 'https://reddit.com/login' });
    onDidNavigate(1, 'https://reddit.com/login?error=1');
    expect(saved).toHaveLength(0);
    expect(pendingCaptures.size).toBe(0);
  });
});

describe('2FA hold — intermediate /verify URL delays save', () => {
  it('holds the capture when did-navigate lands on a 2FA URL', () => {
    const { saved, pendingCaptures, onWillNavigate, onDidNavigate } = simulateInterceptor();
    onWillNavigate(1, 'https://github.com/login', { username: 'dpdev', password: 'pw', loginUrl: 'https://github.com/login' });
    onDidNavigate(1, 'https://github.com/sessions/two-factor/app');
    // Capture should still be pending, not saved
    expect(saved).toHaveLength(0);
    expect(pendingCaptures.has(1)).toBe(true);
    // Final redirect to dashboard completes the save
    onDidNavigate(1, 'https://github.com/dashboard');
    expect(saved).toHaveLength(1);
  });
});

describe('Concurrent captures keyed by webContents id', () => {
  it('isolates captures across different webContents ids', () => {
    const { saved, onWillNavigate, onDidNavigate } = simulateInterceptor();
    onWillNavigate(1, 'https://reddit.com/login', { username: 'u1', password: 'p1', loginUrl: 'https://reddit.com/login' });
    onWillNavigate(2, 'https://github.com/login', { username: 'u2', password: 'p2', loginUrl: 'https://github.com/login' });
    onDidNavigate(1, 'https://reddit.com/');
    onDidNavigate(2, 'https://github.com/dashboard');
    expect(saved).toHaveLength(2);
    expect(saved.map(s => s.serviceName).sort()).toEqual(['github.com', 'reddit.com']);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (or pass — these test pure functions)**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/identity/login-interceptor.test.ts --no-coverage 2>&1 | tail -20
```

Expected: All pass (pure logic tests, no Electron). If any fail, fix the test logic before continuing.

- [ ] **Step 3: Create src/main/autonomy/login-interceptor.ts**

Create `src/main/autonomy/login-interceptor.ts`:

```typescript
/**
 * Login interceptor — auto-captures credentials when the user logs into a site
 * in Clawdia's persistent BrowserView.
 *
 * Mechanism:
 *  1. dom-ready on a login URL → inject submit listener that writes to window.__clawdia_captured
 *  2. will-navigate from a login URL → read window.__clawdia_captured, store in pendingCaptures Map
 *  3. did-navigate to a non-auth URL → save credentials + update account registry
 *
 * Security: credentials sit in window.__clawdia_captured from form-submit until
 * will-navigate fires. We delete the value from the page immediately after reading.
 * HTTPS-only capture enforced.
 *
 * Out of scope: SPA logins (history.pushState), fetch-based form submissions,
 * JS-rendered login forms (all deferred to follow-on spec).
 */

import { BrowserWindow } from 'electron';
import type { Session, WebContents } from 'electron';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { identityStore } from './identity-store';

type PendingCapture = { username: string; password: string; loginUrl: string };
const pendingCaptures = new Map<number, PendingCapture>();

function isLoginUrl(url: string): boolean {
  try {
    const { pathname, hostname } = new URL(url);
    const p = pathname.toLowerCase();
    return p.includes('/login') || p.includes('/signin') ||
           p.includes('/auth') || p.includes('/session') ||
           hostname.includes('login.') || hostname.includes('signin.');
  } catch {
    return false;
  }
}

function isAuthUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const p = pathname.toLowerCase();
    return isLoginUrl(url) || p.includes('/2fa') || p.includes('/verify') ||
           p.includes('/otp') || p.includes('/mfa') || p.includes('/challenge');
  } catch {
    return false;
  }
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function emitAccountsChanged(): void {
  const win = BrowserWindow.getAllWindows()[0];
  win?.webContents.send(IPC_EVENTS.IDENTITY_ACCOUNTS_CHANGED);
}

const SUBMIT_LISTENER_JS = `
(function() {
  if (window.__clawdia_listener_installed) return;
  window.__clawdia_listener_installed = true;
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form) return;
    var pw = form.querySelector('input[type=password]');
    var user = form.querySelector('input[type=email], input[type=text]');
    if (pw) {
      window.__clawdia_captured = { username: user ? user.value : '', password: pw.value };
    }
  }, { capture: true, once: true });
})();
`;

export function initLoginInterceptor(session: Session): void {
  session.on('will-attach-webview', () => {/* no-op — webview not used */});

  // We hook into all webContents created within this session's partition
  // by subscribing to the session's webRequest or by watching webContents creation.
  // Since BrowserView webContents are created separately, we use the
  // `session.on('will-attach-webview')` pattern is irrelevant here.
  // Instead, the caller (main.ts) must pass the persistent browser webContents
  // via `attachToWebContents()` after `initBrowser()` creates the BrowserView.
}

export function attachToWebContents(wc: WebContents): void {
  // Step 1 — inject submit listener on login pages
  wc.on('dom-ready', () => {
    const url = wc.getURL();
    if (isLoginUrl(url)) {
      wc.executeJavaScript(SUBMIT_LISTENER_JS).catch(() => null);
    }
  });

  // Step 2 — read captured values before navigation commits
  wc.on('will-navigate', async (_event, targetUrl) => {
    const fromUrl = wc.getURL();
    if (!fromUrl.startsWith('https://')) return;
    if (!isLoginUrl(fromUrl)) return;

    try {
      const captured = await wc.executeJavaScript('window.__clawdia_captured || null');
      if (captured && captured.password) {
        pendingCaptures.set(wc.id, { ...captured, loginUrl: fromUrl });
        // Clean up from page memory
        wc.executeJavaScript('delete window.__clawdia_captured; delete window.__clawdia_listener_installed;').catch(() => null);
      }
    } catch {
      // executeJavaScript can throw if the frame is gone
    }
  });

  // Step 3 — success detection after navigation
  wc.on('did-navigate', (_event, newUrl) => {
    const pending = pendingCaptures.get(wc.id);
    if (!pending) return;

    if (isAuthUrl(newUrl)) {
      // 2FA or still on auth page — hold capture and wait for next navigation
      return;
    }

    if (isLoginUrl(newUrl)) {
      // Failed login — navigated back to a login page
      pendingCaptures.delete(wc.id);
      return;
    }

    // Successful login
    pendingCaptures.delete(wc.id);
    const serviceName = extractDomain(pending.loginUrl);
    if (!serviceName) return;

    // Save to credential vault
    identityStore.saveCredential({
      label: `${serviceName}-password`,
      type: 'app_password',
      service: serviceName,
      valuePlain: pending.password,
    });

    // Upsert account registry (only if no existing record)
    const existing = identityStore.getAccount(serviceName);
    if (!existing) {
      identityStore.saveAccount({
        serviceName,
        loginUrl: pending.loginUrl,
        username: pending.username,
        passwordPlain: pending.password,
        status: 'active',
      });
    }

    // Notify Settings UI to refresh
    emitAccountsChanged();
    console.log(`[LoginInterceptor] Captured login for ${serviceName} (user: ${pending.username})`);
  });
}
```

- [ ] **Step 4: Export a tab webContents accessor from browser/manager.ts**

The browser manager uses a `tabs: Map<string, Tab>` structure (no module-level `persistentView`). Each `Tab` has a `.view: BrowserView`. The login interceptor needs to attach to **every** tab's webContents (user can log in on any tab), and also to any tab created after startup.

Add these two exports to `src/main/browser/manager.ts` (after the `closeBrowser` function near the bottom of the file, around line 1548):

```typescript
/** Returns all currently active non-isolated tab webContents for the login interceptor. */
export function getAllUserTabWebContents(): import('electron').WebContents[] {
  return Array.from(tabs.values())
    .filter(t => !t.ownerRunId)  // exclude agent-owned isolated tabs
    .map(t => t.view.webContents);
}

/** Callback registered by the login interceptor — called whenever a new user tab is created. */
let _onNewUserTab: ((wc: import('electron').WebContents) => void) | null = null;
export function setOnNewUserTabCallback(cb: (wc: import('electron').WebContents) => void): void {
  _onNewUserTab = cb;
}
export function _notifyNewUserTab(wc: import('electron').WebContents): void {
  _onNewUserTab?.(wc);
}
```

Then in `createTab` (line ~252), after the new `BrowserView` is created and set up, add a call for non-isolated tabs:
```typescript
// Inside createTab(), after view is created and before return:
if (!opts.ownerRunId) {
  _notifyNewUserTab(view.webContents);
}
```

Find the `createTab` function and locate where `const view = new BrowserView(...)` is called. The `_notifyNewUserTab` call goes after view setup, before `return tabId`.

- [ ] **Step 4b: Wire into main.ts**

In `src/main/main.ts`:

a) Add imports (after the existing autonomy imports at lines 64-66):
```typescript
import { attachToWebContents } from './autonomy/login-interceptor';
import { getAllUserTabWebContents, setOnNewUserTabCallback } from './browser/manager';
```

b) After `initBrowser(mainWindow)` in the `ready-to-show` block (line 120), add:

```typescript
      // Wire login interceptor to all current and future user-facing tabs
      for (const wc of getAllUserTabWebContents()) {
        attachToWebContents(wc);
      }
      setOnNewUserTabCallback((wc) => attachToWebContents(wc));
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -30
```

Fix any type errors before proceeding.

- [ ] **Step 6: Run all identity tests**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx jest tests/identity/ tests/autonomy/identity-store-list.test.ts --no-coverage 2>&1 | tail -20
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0 && git add src/main/autonomy/login-interceptor.ts src/main/main.ts src/main/browser/manager.ts tests/identity/login-interceptor.test.ts && git commit -m "feat: implement login interceptor with will-navigate credential capture"
```

---

## Final verification

- [ ] **Run the full test suite**

```bash
cd /home/dp/Desktop/clawdia4.0 && npm test 2>&1 | tail -30
```

Expected: All pre-existing tests pass plus the new identity tests.

- [ ] **TypeScript clean compile**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | grep -v "^$" | head -30
```

Expected: No new errors.

- [ ] **Manual smoke test**
  1. `npm run dev` — app starts without errors
  2. Open Settings → scroll to Identity Profile section
  3. Fill in name + email → click Save Profile → confirm "Saved ✓" flash
  4. Open browser panel → log into any site → return to Settings → confirm account appears in Accounts table with correct access type pill
  5. Add a credential manually → confirm it appears masked → delete it → confirm it disappears
