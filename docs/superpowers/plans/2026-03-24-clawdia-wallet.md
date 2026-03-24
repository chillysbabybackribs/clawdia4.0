# Clawdia Wallet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a spending control layer that lets users register payment methods, set daily/weekly/monthly spend limits, and have Clawdia execute purchases autonomously inside authenticated browser sessions.

**Architecture:** Three DB tables (payment_methods, spending_budgets, spending_transactions) in migration v29. A budget engine enforces limits before any purchase. A checkout executor runs the payment flow inside the browser session, using cards already saved at the merchant. A WalletDrawer in the sidebar rail provides full visibility and control.

**Tech Stack:** TypeScript, better-sqlite3 (synchronous DB), Electron safeStorage (encryption), React + Tailwind (UI), existing human-intervention system for CVV fallback.

---

## File Map

| File | Status | Responsibility |
|------|--------|---------------|
| `src/main/db/database.ts` | Modify | Add migration v29 (3 new tables + widen credential_vault CHECK) |
| `src/main/db/payment-methods.ts` | Create | CRUD for payment_methods table |
| `src/main/db/spending-budgets.ts` | Create | CRUD for spending_budgets table |
| `src/main/db/spending-transactions.ts` | Create | CRUD for spending_transactions table |
| `src/main/agent/spending-budget.ts` | Create | Budget enforcement engine (checkBudget, reserve, confirm, cancel) |
| `src/main/agent/browser-card-scanner.ts` | Create | Read Chrome/Firefox autofill metadata (display columns only, never card_number_encrypted) |
| `src/main/agent/checkout-executor.ts` | Create | Purchase flow: budget check → card selection → CVV fallback → confirm |
| `src/shared/ipc-channels.ts` | Modify | Add wallet:* and spending:* channel constants |
| `src/main/main.ts` | Modify | Register wallet IPC handlers; wire spending notification emitters |
| `src/renderer/components/sidebar/Rail.tsx` | Modify | Add 'wallet' to DrawerMode, MODES array, and icons object |
| `src/renderer/components/Sidebar.tsx` | Modify | Import and render WalletDrawer |
| `src/renderer/components/sidebar/drawers/WalletDrawer.tsx` | Create | Three-panel wallet UI (payment methods, budgets, transaction history) |
| `src/main/preload.ts` | Modify | Add `wallet` namespace exposing all wallet IPC methods to renderer |
| `src/main/autonomy/identity-store.ts` | Modify | Widen `SaveCredentialInput.type` union to include `'payment_card'` |
| `tests/db/payment-methods.test.ts` | Create | DB layer unit tests |
| `tests/db/spending-budgets.test.ts` | Create | DB layer unit tests |
| `tests/db/spending-transactions.test.ts` | Create | DB layer unit tests |
| `tests/agent/spending-budget.test.ts` | Create | Budget engine unit tests |
| `tests/agent/browser-card-scanner.test.ts` | Create | Scanner unit tests |

---

## Task 1: Database migration v29

**Files:**
- Modify: `src/main/db/database.ts`

The migration does three things: (1) drops and recreates `credential_vault` to widen the CHECK constraint to include `'payment_card'`, (2) creates three new tables, (3) updates the log line. Follow the drop-and-recreate pattern from migration v23 (lines 583–609).

- [ ] **Step 1: Add migration v29 block**

Open `src/main/db/database.ts`. After the closing `}` of the `if (currentVersion < 28)` block (line ~758), add:

```typescript
if (currentVersion < 29) {
  console.log('[DB] Running migration v29: wallet tables + widen credential_vault type');
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
      created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS spending_budgets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      period      TEXT NOT NULL UNIQUE,
      limit_usd   INTEGER NOT NULL,
      is_active   INTEGER NOT NULL DEFAULT 1,
      reset_day   INTEGER,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS spending_transactions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
      merchant          TEXT NOT NULL,
      amount_usd        INTEGER NOT NULL,
      description       TEXT,
      payment_method_id INTEGER REFERENCES payment_methods(id) ON DELETE SET NULL,
      status            TEXT NOT NULL,
      is_estimated      INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL
    );

    INSERT INTO schema_version (version) VALUES (29);
  `);
}
```

- [ ] **Step 2: Update the version log line**

Find the line (currently ~762):
```typescript
console.log(`[DB] Schema at version ${Math.max(currentVersion, 28)}`);
```
Change to:
```typescript
console.log(`[DB] Schema at version ${Math.max(currentVersion, 29)}`);
```

- [ ] **Step 3: Run the app to verify migration runs cleanly**

```bash
cd /home/dp/Desktop/clawdia4.0
npm run dev 2>&1 | grep "\[DB\]"
```
Expected output includes:
```
[DB] Running migration v29: wallet tables + widen credential_vault type
[DB] Schema at version 29
```

- [ ] **Step 4: Commit**

```bash
git add src/main/db/database.ts
git commit -m "feat: add migration v29 — wallet tables + widen credential_vault type"
```

---

## Task 2: DB layer — payment-methods.ts

**Files:**
- Create: `src/main/db/payment-methods.ts`
- Create: `tests/db/payment-methods.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/db/payment-methods.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/main/db/database';

// Use an in-memory DB for tests
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});
afterEach(() => db.close());

// We'll inject db via a test helper — see implementation note below
import {
  insertPaymentMethod,
  getPaymentMethod,
  listPaymentMethods,
  setPreferred,
  setBackup,
  softDeletePaymentMethod,
} from '../../src/main/db/payment-methods';

describe('payment-methods', () => {
  const base = {
    label: 'Visa ••••4242',
    lastFour: '4242',
    cardType: 'visa' as const,
    expiryMonth: 12,
    expiryYear: 2027,
    source: 'manual' as const,
  };

  it('inserts and retrieves a payment method', () => {
    const id = insertPaymentMethod(base);
    const pm = getPaymentMethod(id);
    expect(pm).not.toBeNull();
    expect(pm!.lastFour).toBe('4242');
    expect(pm!.isActive).toBe(true);
  });

  it('lists only active methods', () => {
    const id = insertPaymentMethod(base);
    softDeletePaymentMethod(id);
    expect(listPaymentMethods()).toHaveLength(0);
  });

  it('soft delete sets is_active = 0, does not remove row', () => {
    const id = insertPaymentMethod(base);
    softDeletePaymentMethod(id);
    // Direct DB read to confirm row still exists
    const row = db.prepare('SELECT is_active FROM payment_methods WHERE id = ?').get(id) as any;
    expect(row.is_active).toBe(0);
  });

  it('only one preferred at a time', () => {
    const id1 = insertPaymentMethod(base);
    const id2 = insertPaymentMethod({ ...base, label: 'MC ••••1111', lastFour: '1111', cardType: 'mastercard' });
    setPreferred(id1);
    setPreferred(id2);
    const methods = listPaymentMethods();
    const preferred = methods.filter(m => m.isPreferred);
    expect(preferred).toHaveLength(1);
    expect(preferred[0].id).toBe(id2);
  });

  it('only one backup at a time', () => {
    const id1 = insertPaymentMethod(base);
    const id2 = insertPaymentMethod({ ...base, label: 'MC ••••1111', lastFour: '1111', cardType: 'mastercard' });
    setBackup(id1);
    setBackup(id2);
    const methods = listPaymentMethods();
    const backup = methods.filter(m => m.isBackup);
    expect(backup).toHaveLength(1);
    expect(backup[0].id).toBe(id2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/dp/Desktop/clawdia4.0
npx jest tests/db/payment-methods.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement payment-methods.ts**

Create `src/main/db/payment-methods.ts`:

```typescript
import { getDb } from './database';

export type CardType = 'visa' | 'mastercard' | 'amex' | 'discover' | 'other';
export type PaymentSource = 'browser_autofill' | 'manual';

export interface PaymentMethod {
  id: number;
  label: string;
  lastFour: string;
  cardType: CardType;
  methodType: 'card' | 'crypto';
  expiryMonth: number;
  expiryYear: number;
  billingName?: string;
  source: PaymentSource;
  vaultRef?: string;
  isPreferred: boolean;
  isBackup: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface NewPaymentMethod {
  label: string;
  lastFour: string;
  cardType: CardType;
  methodType?: 'card' | 'crypto';
  expiryMonth: number;
  expiryYear: number;
  billingName?: string;
  source: PaymentSource;
  vaultRef?: string;
}

interface PaymentMethodRow {
  id: number;
  label: string;
  last_four: string;
  card_type: string;
  method_type: string;
  expiry_month: number;
  expiry_year: number;
  billing_name: string | null;
  source: string;
  vault_ref: string | null;
  is_preferred: number;
  is_backup: number;
  is_active: number;
  created_at: string;
}

function toRecord(row: PaymentMethodRow): PaymentMethod {
  return {
    id: row.id,
    label: row.label,
    lastFour: row.last_four,
    cardType: row.card_type as CardType,
    methodType: row.method_type as 'card' | 'crypto',
    expiryMonth: row.expiry_month,
    expiryYear: row.expiry_year,
    billingName: row.billing_name ?? undefined,
    source: row.source as PaymentSource,
    vaultRef: row.vault_ref ?? undefined,
    isPreferred: row.is_preferred === 1,
    isBackup: row.is_backup === 1,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  };
}

export function insertPaymentMethod(pm: NewPaymentMethod): number {
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO payment_methods
      (label, last_four, card_type, method_type, expiry_month, expiry_year,
       billing_name, source, vault_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pm.label, pm.lastFour, pm.cardType, pm.methodType ?? 'card',
    pm.expiryMonth, pm.expiryYear, pm.billingName ?? null,
    pm.source, pm.vaultRef ?? null, now,
  );
  return Number(result.lastInsertRowid);
}

export function getPaymentMethod(id: number): PaymentMethod | null {
  const row = getDb()
    .prepare('SELECT * FROM payment_methods WHERE id = ?')
    .get(id) as PaymentMethodRow | undefined;
  return row ? toRecord(row) : null;
}

export function listPaymentMethods(): PaymentMethod[] {
  const rows = getDb()
    .prepare('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY id ASC')
    .all() as PaymentMethodRow[];
  return rows.map(toRecord);
}

export function setPreferred(id: number): void {
  const db = getDb();
  db.prepare('UPDATE payment_methods SET is_preferred = 0').run();
  db.prepare('UPDATE payment_methods SET is_preferred = 1 WHERE id = ?').run(id);
}

export function setBackup(id: number): void {
  const db = getDb();
  db.prepare('UPDATE payment_methods SET is_backup = 0').run();
  db.prepare('UPDATE payment_methods SET is_backup = 1 WHERE id = ?').run(id);
}

export function softDeletePaymentMethod(id: number): void {
  getDb().prepare('UPDATE payment_methods SET is_active = 0 WHERE id = ?').run(id);
}

export function getPreferredMethod(): PaymentMethod | null {
  const row = getDb()
    .prepare('SELECT * FROM payment_methods WHERE is_preferred = 1 AND is_active = 1')
    .get() as PaymentMethodRow | undefined;
  return row ? toRecord(row) : null;
}

export function getBackupMethod(): PaymentMethod | null {
  const row = getDb()
    .prepare('SELECT * FROM payment_methods WHERE is_backup = 1 AND is_active = 1')
    .get() as PaymentMethodRow | undefined;
  return row ? toRecord(row) : null;
}
```

**Implementation note:** The tests import `getDb()` which uses the singleton. For unit tests, either (a) call `initDb(':memory:')` before the tests if such a function exists, or (b) mock `getDb` to return the test DB. Check `src/main/db/database.ts` for how the DB singleton is initialized — adapt accordingly.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tests/db/payment-methods.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS all 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/db/payment-methods.ts tests/db/payment-methods.test.ts
git commit -m "feat: add payment-methods DB layer"
```

---

## Task 3: DB layer — spending-budgets.ts and spending-transactions.ts

**Files:**
- Create: `src/main/db/spending-budgets.ts`
- Create: `src/main/db/spending-transactions.ts`
- Create: `tests/db/spending-budgets.test.ts`
- Create: `tests/db/spending-transactions.test.ts`

- [ ] **Step 1: Write failing tests for spending-budgets**

Create `tests/db/spending-budgets.test.ts`:

```typescript
import {
  upsertBudget,
  getBudget,
  listActiveBudgets,
  disableBudget,
} from '../../src/main/db/spending-budgets';

describe('spending-budgets', () => {
  it('upserts and retrieves a budget', () => {
    upsertBudget({ period: 'monthly', limitUsd: 20000 });
    const b = getBudget('monthly');
    expect(b).not.toBeNull();
    expect(b!.limitUsd).toBe(20000);
    expect(b!.isActive).toBe(true);
  });

  it('upsert overwrites existing budget for same period', () => {
    upsertBudget({ period: 'daily', limitUsd: 1000 });
    upsertBudget({ period: 'daily', limitUsd: 2000 });
    expect(listActiveBudgets().filter(b => b.period === 'daily')).toHaveLength(1);
    expect(getBudget('daily')!.limitUsd).toBe(2000);
  });

  it('disableBudget sets is_active = 0', () => {
    upsertBudget({ period: 'weekly', limitUsd: 5000 });
    disableBudget('weekly');
    expect(getBudget('weekly')!.isActive).toBe(false);
    expect(listActiveBudgets().filter(b => b.period === 'weekly')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Write failing tests for spending-transactions**

Create `tests/db/spending-transactions.test.ts`:

```typescript
import {
  insertTransaction,
  getTransaction,
  updateTransactionToActual,
  deleteTransaction,
  listTransactions,
  sumPeriodSpend,
} from '../../src/main/db/spending-transactions';

describe('spending-transactions', () => {
  it('inserts and retrieves a transaction', () => {
    const id = insertTransaction({ merchant: 'Amazon', amountUsd: 999, isEstimated: true });
    const tx = getTransaction(id);
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe('pending');
    expect(tx!.isEstimated).toBe(true);
  });

  it('updateTransactionToActual sets isEstimated false and status completed', () => {
    const id = insertTransaction({ merchant: 'Amazon', amountUsd: 999, isEstimated: true });
    updateTransactionToActual(id, 1050);
    const tx = getTransaction(id);
    expect(tx!.amountUsd).toBe(1050);
    expect(tx!.isEstimated).toBe(false);
    expect(tx!.status).toBe('completed');
  });

  it('deleteTransaction removes the row', () => {
    const id = insertTransaction({ merchant: 'Test', amountUsd: 100, isEstimated: true });
    deleteTransaction(id);
    expect(getTransaction(id)).toBeNull();
  });

  it('sumPeriodSpend counts pending + completed, not failed', () => {
    const since = new Date(Date.now() - 1000).toISOString();
    insertTransaction({ merchant: 'A', amountUsd: 500, isEstimated: false, status: 'completed' });
    insertTransaction({ merchant: 'B', amountUsd: 300, isEstimated: true, status: 'pending' });
    insertTransaction({ merchant: 'C', amountUsd: 200, isEstimated: false, status: 'failed' });
    expect(sumPeriodSpend(since)).toBe(800); // 500 + 300, not 200
  });
});
```

- [ ] **Step 3: Run both test files to verify they fail**

```bash
npx jest tests/db/spending-budgets.test.ts tests/db/spending-transactions.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL — modules not found

- [ ] **Step 4: Implement spending-budgets.ts**

Create `src/main/db/spending-budgets.ts`:

```typescript
import { getDb } from './database';

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

export interface SpendingBudget {
  id: number;
  period: BudgetPeriod;
  limitUsd: number;   // cents
  isActive: boolean;
  resetDay?: number;
  createdAt: string;
}

interface SpendingBudgetRow {
  id: number;
  period: string;
  limit_usd: number;
  is_active: number;
  reset_day: number | null;
  created_at: string;
}

function toRecord(row: SpendingBudgetRow): SpendingBudget {
  return {
    id: row.id,
    period: row.period as BudgetPeriod,
    limitUsd: row.limit_usd,
    isActive: row.is_active === 1,
    resetDay: row.reset_day ?? undefined,
    createdAt: row.created_at,
  };
}

export function upsertBudget(input: { period: BudgetPeriod; limitUsd: number; resetDay?: number }): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO spending_budgets (period, limit_usd, is_active, reset_day, created_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(period) DO UPDATE SET limit_usd = excluded.limit_usd,
      reset_day = excluded.reset_day, is_active = 1
  `).run(input.period, input.limitUsd, input.resetDay ?? null, now);
}

export function getBudget(period: BudgetPeriod): SpendingBudget | null {
  const row = getDb()
    .prepare('SELECT * FROM spending_budgets WHERE period = ?')
    .get(period) as SpendingBudgetRow | undefined;
  return row ? toRecord(row) : null;
}

export function listActiveBudgets(): SpendingBudget[] {
  const rows = getDb()
    .prepare('SELECT * FROM spending_budgets WHERE is_active = 1')
    .all() as SpendingBudgetRow[];
  return rows.map(toRecord);
}

export function disableBudget(period: BudgetPeriod): void {
  getDb().prepare('UPDATE spending_budgets SET is_active = 0 WHERE period = ?').run(period);
}
```

**Note:** `upsertBudget` uses `ON CONFLICT(period)` which requires a UNIQUE constraint on `period`. Add `UNIQUE(period)` to the migration v29 `spending_budgets` table definition if not already present. Check the migration and add it if missing.

- [ ] **Step 5: Implement spending-transactions.ts**

Create `src/main/db/spending-transactions.ts`:

```typescript
import { getDb } from './database';

export type TransactionStatus = 'pending' | 'completed' | 'failed' | 'refunded';

export interface SpendingTransaction {
  id: number;
  runId?: string;
  merchant: string;
  amountUsd: number;  // cents
  description?: string;
  paymentMethodId?: number;
  status: TransactionStatus;
  isEstimated: boolean;
  createdAt: string;
}

export interface NewTransaction {
  runId?: string;
  merchant: string;
  amountUsd: number;
  description?: string;
  paymentMethodId?: number;
  isEstimated: boolean;
  status?: TransactionStatus;
}

interface SpendingTransactionRow {
  id: number;
  run_id: string | null;
  merchant: string;
  amount_usd: number;
  description: string | null;
  payment_method_id: number | null;
  status: string;
  is_estimated: number;
  created_at: string;
}

function toRecord(row: SpendingTransactionRow): SpendingTransaction {
  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    merchant: row.merchant,
    amountUsd: row.amount_usd,
    description: row.description ?? undefined,
    paymentMethodId: row.payment_method_id ?? undefined,
    status: row.status as TransactionStatus,
    isEstimated: row.is_estimated === 1,
    createdAt: row.created_at,
  };
}

export function insertTransaction(tx: NewTransaction): number {
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO spending_transactions
      (run_id, merchant, amount_usd, description, payment_method_id, status, is_estimated, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tx.runId ?? null, tx.merchant, tx.amountUsd,
    tx.description ?? null, tx.paymentMethodId ?? null,
    tx.status ?? 'pending', tx.isEstimated ? 1 : 0, now,
  );
  return Number(result.lastInsertRowid);
}

export function getTransaction(id: number): SpendingTransaction | null {
  const row = getDb()
    .prepare('SELECT * FROM spending_transactions WHERE id = ?')
    .get(id) as SpendingTransactionRow | undefined;
  return row ? toRecord(row) : null;
}

export function updateTransactionToActual(id: number, actualCents: number): void {
  getDb().prepare(`
    UPDATE spending_transactions
    SET amount_usd = ?, is_estimated = 0, status = 'completed'
    WHERE id = ?
  `).run(actualCents, id);
}

export function deleteTransaction(id: number): void {
  getDb().prepare('DELETE FROM spending_transactions WHERE id = ?').run(id);
}

export function listTransactions(limit = 50): SpendingTransaction[] {
  const rows = getDb()
    .prepare('SELECT * FROM spending_transactions ORDER BY id DESC LIMIT ?')
    .all(limit) as SpendingTransactionRow[];
  return rows.map(toRecord);
}

// Sum pending + completed transactions since `since` ISO string
export function sumPeriodSpend(since: string): number {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) as total
    FROM spending_transactions
    WHERE created_at >= ?
      AND status IN ('pending', 'completed')
  `).get(since) as { total: number };
  return row.total;
}
```

- [ ] **Step 6: Run both test files to verify they pass**

```bash
npx jest tests/db/spending-budgets.test.ts tests/db/spending-transactions.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS all tests

- [ ] **Step 7: Commit**

```bash
git add src/main/db/spending-budgets.ts src/main/db/spending-transactions.ts \
        tests/db/spending-budgets.test.ts tests/db/spending-transactions.test.ts
git commit -m "feat: add spending-budgets and spending-transactions DB layers"
```

---

## Task 4: Budget engine — spending-budget.ts

**Files:**
- Create: `src/main/agent/spending-budget.ts`
- Create: `tests/agent/spending-budget.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent/spending-budget.test.ts`:

```typescript
import {
  checkBudget,
  reserveEstimate,
  confirmTransaction,
  cancelReservation,
  getRemainingBudgets,
  resetExpiredPeriods,
} from '../../src/main/agent/spending-budget';
import { upsertBudget } from '../../src/main/db/spending-budgets';
import { insertTransaction } from '../../src/main/db/spending-transactions';

describe('spending-budget engine', () => {
  beforeEach(() => {
    // Set up a clean monthly budget of $100 (10000 cents)
    upsertBudget({ period: 'monthly', limitUsd: 10000 });
  });

  it('allows purchase within budget', () => {
    const result = checkBudget(5000);
    expect(result.allowed).toBe(true);
    expect(result.blockedBy).toBeNull();
    expect(result.remaining).toBe(10000);
  });

  it('blocks purchase that would exceed monthly budget', () => {
    // Spend 8000 first
    insertTransaction({ merchant: 'A', amountUsd: 8000, isEstimated: false, status: 'completed' });
    const result = checkBudget(3000);
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe('monthly');
    expect(result.remaining).toBe(2000);
  });

  it('most restrictive budget blocks (daily tighter than monthly)', () => {
    upsertBudget({ period: 'daily', limitUsd: 1000 });
    insertTransaction({ merchant: 'A', amountUsd: 800, isEstimated: false, status: 'completed' });
    const result = checkBudget(500);
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe('daily');
  });

  it('failed transactions do not count against budget', () => {
    insertTransaction({ merchant: 'A', amountUsd: 9000, isEstimated: false, status: 'failed' });
    const result = checkBudget(9000);
    expect(result.allowed).toBe(true);
  });

  it('pending (estimated) transactions count against budget', () => {
    insertTransaction({ merchant: 'A', amountUsd: 9000, isEstimated: true, status: 'pending' });
    const result = checkBudget(2000);
    expect(result.allowed).toBe(false);
  });

  it('reserveEstimate + confirmTransaction round-trip', () => {
    const id = reserveEstimate('run-1', 'Amazon', 2000);
    confirmTransaction(id, 2100);
    const result = checkBudget(7500);
    expect(result.allowed).toBe(true); // 2100 spent, 7900 left, 7500 fits
    const result2 = checkBudget(8000);
    expect(result2.allowed).toBe(false); // 2100 + 8000 > 10000
  });

  it('cancelReservation removes the estimated row', () => {
    const id = reserveEstimate('run-2', 'Test', 5000);
    cancelReservation(id);
    const result = checkBudget(9999);
    expect(result.allowed).toBe(true);
  });

  it('getRemainingBudgets returns correct remaining for active budgets', () => {
    insertTransaction({ merchant: 'A', amountUsd: 3000, isEstimated: false, status: 'completed' });
    const budgets = getRemainingBudgets();
    const monthly = budgets.find(b => b.period === 'monthly');
    expect(monthly).toBeDefined();
    expect(monthly!.remaining).toBe(7000);
    expect(monthly!.spent).toBe(3000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest tests/agent/spending-budget.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL

- [ ] **Step 3: Implement spending-budget.ts**

Create `src/main/agent/spending-budget.ts`:

```typescript
import { listActiveBudgets, type BudgetPeriod } from '../db/spending-budgets';
import {
  insertTransaction,
  updateTransactionToActual,
  deleteTransaction,
  sumPeriodSpend,
} from '../db/spending-transactions';

export interface BudgetCheckResult {
  allowed: boolean;
  remaining: number;      // cents remaining in most restrictive active budget
  blockedBy: BudgetPeriod | null;
  periodSpent: number;
  periodLimit: number;
}

function periodStartIso(period: BudgetPeriod, resetDay?: number): string {
  const now = new Date();
  if (period === 'daily') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  if (period === 'weekly') {
    const day = resetDay ?? 1; // default Monday
    const start = new Date(now);
    const diff = (start.getDay() - day + 7) % 7;
    start.setDate(start.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  // monthly
  const start = new Date(now);
  start.setDate(resetDay ?? 1);
  start.setHours(0, 0, 0, 0);
  // If we haven't reached reset_day yet this month, go back one month
  if (start > now) {
    start.setMonth(start.getMonth() - 1);
  }
  return start.toISOString();
}

export function checkBudget(amountUsdCents: number): BudgetCheckResult {
  const budgets = listActiveBudgets();
  let mostRestrictive: BudgetCheckResult = {
    allowed: true,
    remaining: Infinity,
    blockedBy: null,
    periodSpent: 0,
    periodLimit: 0,
  };

  for (const budget of budgets) {
    const since = periodStartIso(budget.period, budget.resetDay);
    const spent = sumPeriodSpend(since);
    const remaining = budget.limitUsd - spent;
    const wouldExceed = spent + amountUsdCents > budget.limitUsd;

    if (wouldExceed) {
      // Return the most restrictive (least remaining)
      if (remaining < mostRestrictive.remaining || mostRestrictive.allowed) {
        mostRestrictive = {
          allowed: false,
          remaining,
          blockedBy: budget.period,
          periodSpent: spent,
          periodLimit: budget.limitUsd,
        };
      }
    } else if (mostRestrictive.allowed && remaining < mostRestrictive.remaining) {
      mostRestrictive = {
        allowed: true,
        remaining,
        blockedBy: null,
        periodSpent: spent,
        periodLimit: budget.limitUsd,
      };
    }
  }

  if (mostRestrictive.remaining === Infinity) {
    // No budgets configured — allow by default
    mostRestrictive.remaining = Infinity;
    mostRestrictive.allowed = true;
  }

  return mostRestrictive;
}

export function reserveEstimate(runId: string, merchant: string, estimatedCents: number): number {
  return insertTransaction({
    runId,
    merchant,
    amountUsd: estimatedCents,
    isEstimated: true,
    status: 'pending',
  });
}

export function confirmTransaction(transactionId: number, actualCents: number): void {
  updateTransactionToActual(transactionId, actualCents);
}

export function cancelReservation(transactionId: number): void {
  deleteTransaction(transactionId);
}

export function resetExpiredPeriods(): void {
  // No-op: period windows are calculated dynamically from created_at.
  // This function is called on startup and hourly as a hook for future cleanup.
  // For now, old transactions naturally fall outside the rolling window.
}

export function getRemainingBudgets(): Array<{ period: string; remaining: number; limit: number; spent: number }> {
  const budgets = listActiveBudgets();
  return budgets.map(budget => {
    const since = periodStartIso(budget.period, budget.resetDay);
    const spent = sumPeriodSpend(since);
    return {
      period: budget.period,
      remaining: budget.limitUsd - spent,
      limit: budget.limitUsd,
      spent,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tests/agent/spending-budget.test.ts --no-coverage 2>&1 | tail -15
```
Expected: PASS all 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/spending-budget.ts tests/agent/spending-budget.test.ts
git commit -m "feat: add spending-budget engine with checkBudget, reserve, confirm, cancel"
```

---

## Task 5: Browser card scanner

**Files:**
- Create: `src/main/agent/browser-card-scanner.ts`
- Create: `tests/agent/browser-card-scanner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent/browser-card-scanner.test.ts`:

```typescript
import { scanBrowserCards } from '../../src/main/agent/browser-card-scanner';
import * as fs from 'fs';

// Mock fs.existsSync and better-sqlite3 for unit tests
jest.mock('fs');
jest.mock('better-sqlite3');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('browser-card-scanner', () => {
  it('returns empty array when Chrome profile not found', async () => {
    mockFs.existsSync.mockReturnValue(false);
    const cards = await scanBrowserCards();
    expect(cards).toEqual([]);
  });

  it('returns empty array when Web Data file read fails', async () => {
    mockFs.existsSync.mockReturnValue(true);
    // better-sqlite3 mock throws on open
    const Database = require('better-sqlite3');
    Database.mockImplementation(() => { throw new Error('locked'); });
    const cards = await scanBrowserCards();
    expect(cards).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest tests/agent/browser-card-scanner.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL

- [ ] **Step 3: Implement browser-card-scanner.ts**

Create `src/main/agent/browser-card-scanner.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { NewPaymentMethod, CardType } from '../db/payment-methods';

export type PaymentMethodCandidate = NewPaymentMethod & { browserSource: 'chrome' | 'firefox' };

const CHROME_WEB_DATA_PATHS = [
  path.join(os.homedir(), '.config/google-chrome/Default/Web Data'),
  path.join(os.homedir(), '.config/chromium/Default/Web Data'),
  path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default/Web Data'), // macOS
];

function inferCardType(nameOnCard: string, lastFour: string): CardType {
  // Infer by BIN first digit heuristic (last_four only — use name as fallback)
  if (nameOnCard.toLowerCase().includes('visa')) return 'visa';
  if (nameOnCard.toLowerCase().includes('mastercard') || nameOnCard.toLowerCase().includes('master')) return 'mastercard';
  if (nameOnCard.toLowerCase().includes('amex') || nameOnCard.toLowerCase().includes('american express')) return 'amex';
  if (nameOnCard.toLowerCase().includes('discover')) return 'discover';
  return 'other';
}

function scanChrome(): PaymentMethodCandidate[] {
  for (const webDataPath of CHROME_WEB_DATA_PATHS) {
    if (!fs.existsSync(webDataPath)) continue;
    try {
      // Open read-only copy to avoid locking the live file
      const tmpPath = path.join(os.tmpdir(), `clawdia-webdata-${Date.now()}.db`);
      fs.copyFileSync(webDataPath, tmpPath);
      const db = new Database(tmpPath, { readonly: true });

      // CRITICAL: Only read display metadata columns. Never read card_number_encrypted.
      const rows = db.prepare(`
        SELECT name_on_card, last_four, expiration_month, expiration_year
        FROM credit_cards
        WHERE use_count > 0
      `).all() as Array<{
        name_on_card: string;
        last_four: string;
        expiration_month: number;
        expiration_year: number;
      }>();

      db.close();
      fs.unlinkSync(tmpPath);

      return rows.map(row => ({
        label: `${inferCardType(row.name_on_card, row.last_four)} ••••${row.last_four}`,
        lastFour: row.last_four,
        cardType: inferCardType(row.name_on_card, row.last_four),
        expiryMonth: row.expiration_month,
        expiryYear: row.expiration_year,
        billingName: row.name_on_card || undefined,
        source: 'browser_autofill' as const,
        browserSource: 'chrome' as const,
      }));
    } catch {
      // Locked or unreadable — silently return empty
      return [];
    }
  }
  return [];
}

export async function scanBrowserCards(): Promise<PaymentMethodCandidate[]> {
  const results: PaymentMethodCandidate[] = [];
  try {
    results.push(...scanChrome());
  } catch {
    // Never throw — return whatever we got
  }
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tests/agent/browser-card-scanner.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/browser-card-scanner.ts tests/agent/browser-card-scanner.test.ts
git commit -m "feat: add browser-card-scanner (Chrome autofill, display metadata only)"
```

---

## Task 6: IPC channels

**Files:**
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Add wallet and spending channels to IPC constant objects**

Open `src/shared/ipc-channels.ts`. Add to the `IPC` object (after the IDENTITY entries):

```typescript
  // Wallet
  WALLET_GET_PAYMENT_METHODS: 'wallet:get-payment-methods',
  WALLET_ADD_MANUAL_CARD: 'wallet:add-manual-card',
  WALLET_IMPORT_BROWSER_CARDS: 'wallet:import-browser-cards',
  WALLET_CONFIRM_IMPORT: 'wallet:confirm-import',
  WALLET_SET_PREFERRED: 'wallet:set-preferred',
  WALLET_SET_BACKUP: 'wallet:set-backup',
  WALLET_REMOVE_CARD: 'wallet:remove-card',
  WALLET_GET_BUDGETS: 'wallet:get-budgets',
  WALLET_SET_BUDGET: 'wallet:set-budget',
  WALLET_DISABLE_BUDGET: 'wallet:disable-budget',
  WALLET_GET_TRANSACTIONS: 'wallet:get-transactions',
  WALLET_GET_REMAINING_BUDGETS: 'wallet:get-remaining-budgets',
```

Add to the `IPC_EVENTS` object (after IDENTITY_ACCOUNTS_CHANGED):

```typescript
  // Spending events (pushed from main to renderer)
  SPENDING_PURCHASE_COMPLETE: 'spending:purchase-complete',
  SPENDING_LOW_BALANCE: 'spending:low-balance',
  SPENDING_BUDGET_EXCEEDED: 'spending:budget-exceeded',
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0
npx tsc -p tsconfig.main.json --noEmit 2>&1 | head -20
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-channels.ts
git commit -m "feat: add wallet and spending IPC channel constants"
```

---

## Task 7: IPC handlers in main process

**Files:**
- Modify: `src/main/main.ts`

- [ ] **Step 1: Widen SaveCredentialInput type in identity-store.ts**

Open `src/main/autonomy/identity-store.ts`. Find the `SaveCredentialInput` interface (line ~62):

```typescript
export interface SaveCredentialInput {
  label: string;
  type: 'api_key' | 'session_token' | 'app_password' | 'oauth_token';
  service?: string;
  valuePlain: string;
  expiresAt?: string;
}
```

Change the `type` union to include `'payment_card'`:

```typescript
  type: 'api_key' | 'session_token' | 'app_password' | 'oauth_token' | 'payment_card';
```

- [ ] **Step 2: Register all wallet IPC handlers**

Open `src/main/main.ts`. Import the new modules and register handlers. Find the section where other IPC handlers are registered (search for `ipcMain.handle`) and add:

```typescript
import { IPC, IPC_EVENTS } from '../shared/ipc-channels';
import {
  insertPaymentMethod, listPaymentMethods, setPreferred, setBackup,
  softDeletePaymentMethod,
} from './db/payment-methods';
import { upsertBudget, listActiveBudgets, disableBudget } from './db/spending-budgets';
import { listTransactions } from './db/spending-transactions';
import { getRemainingBudgets } from './agent/spending-budget';
import { scanBrowserCards } from './agent/browser-card-scanner';
import { identityStore } from './autonomy/identity-store';

// Wallet handlers
ipcMain.handle(IPC.WALLET_GET_PAYMENT_METHODS, () => listPaymentMethods());

ipcMain.handle(IPC.WALLET_ADD_MANUAL_CARD, (_e, input: {
  label: string; lastFour: string; cardType: string;
  expiryMonth: number; expiryYear: number; billingName?: string;
  cardNumber: string; // full PAN — encrypted into vault, never stored raw
}) => {
  // Store full details encrypted in credential_vault
  const vaultLabel = `payment_card_${input.lastFour}_${Date.now()}`;
  identityStore.saveCredential({
    label: vaultLabel,
    type: 'payment_card',
    service: 'wallet',
    valuePlain: JSON.stringify({ cardNumber: input.cardNumber, expiryMonth: input.expiryMonth, expiryYear: input.expiryYear, billingName: input.billingName }),
  });
  // Store metadata in payment_methods
  const id = insertPaymentMethod({
    label: input.label,
    lastFour: input.lastFour,
    cardType: input.cardType as any,
    expiryMonth: input.expiryMonth,
    expiryYear: input.expiryYear,
    billingName: input.billingName,
    source: 'manual',
    vaultRef: vaultLabel,
  });
  return listPaymentMethods().find(m => m.id === id);
});

ipcMain.handle(IPC.WALLET_IMPORT_BROWSER_CARDS, () => scanBrowserCards());

ipcMain.handle(IPC.WALLET_CONFIRM_IMPORT, (_e, candidates: any[]) => {
  for (const c of candidates) {
    insertPaymentMethod({
      label: c.label,
      lastFour: c.lastFour,
      cardType: c.cardType,
      expiryMonth: c.expiryMonth,
      expiryYear: c.expiryYear,
      billingName: c.billingName,
      source: 'browser_autofill',
    });
  }
});

ipcMain.handle(IPC.WALLET_SET_PREFERRED, (_e, id: number) => setPreferred(id));
ipcMain.handle(IPC.WALLET_SET_BACKUP, (_e, id: number) => setBackup(id));
ipcMain.handle(IPC.WALLET_REMOVE_CARD, (_e, id: number) => softDeletePaymentMethod(id));

ipcMain.handle(IPC.WALLET_GET_BUDGETS, () => listActiveBudgets());
ipcMain.handle(IPC.WALLET_SET_BUDGET, (_e, input: { period: string; limitUsd: number; resetDay?: number }) =>
  upsertBudget(input as any));
ipcMain.handle(IPC.WALLET_DISABLE_BUDGET, (_e, period: string) => disableBudget(period as any));

ipcMain.handle(IPC.WALLET_GET_TRANSACTIONS, (_e, args?: { limit?: number }) =>
  listTransactions(args?.limit));
ipcMain.handle(IPC.WALLET_GET_REMAINING_BUDGETS, () => getRemainingBudgets());
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc -p tsconfig.main.json --noEmit 2>&1 | head -20
```
Expected: no errors (fix any import issues that arise)

- [ ] **Step 4: Commit**

```bash
git add src/main/main.ts src/main/autonomy/identity-store.ts
git commit -m "feat: register wallet IPC handlers; widen SaveCredentialInput type for payment_card"
```

---

## Task 8: Rail icon + Sidebar wiring

**Files:**
- Modify: `src/renderer/components/sidebar/Rail.tsx`
- Modify: `src/renderer/components/Sidebar.tsx`

- [ ] **Step 1: Add wallet namespace to preload.ts**

Open `src/main/preload.ts`. The preload exposes a structured namespace per feature (chat, browser, identity, etc.). Add a `wallet` namespace at the end of the `contextBridge.exposeInMainWorld('clawdia', { ... })` object, before the closing `});`:

```typescript
  wallet: {
    getPaymentMethods: () => invoke('wallet:get-payment-methods'),
    addManualCard: (input: any) => invoke('wallet:add-manual-card', input),
    importBrowserCards: () => invoke('wallet:import-browser-cards'),
    confirmImport: (candidates: any[]) => invoke('wallet:confirm-import', candidates),
    setPreferred: (id: number) => invoke('wallet:set-preferred', id),
    setBackup: (id: number) => invoke('wallet:set-backup', id),
    removeCard: (id: number) => invoke('wallet:remove-card', id),
    getBudgets: () => invoke('wallet:get-budgets'),
    setBudget: (input: any) => invoke('wallet:set-budget', input),
    disableBudget: (period: string) => invoke('wallet:disable-budget', period),
    getTransactions: (args?: { limit?: number }) => invoke('wallet:get-transactions', args),
    getRemainingBudgets: () => invoke('wallet:get-remaining-budgets'),
    onPurchaseComplete: (cb: (payload: any) => void) => on('spending:purchase-complete', cb),
    onLowBalance: (cb: (payload: any) => void) => on('spending:low-balance', cb),
    onBudgetExceeded: (cb: (payload: any) => void) => on('spending:budget-exceeded', cb),
  },
```

**WalletDrawer must call `api.wallet.getPaymentMethods()` etc. — not `api.ipc(...)`**. The existing drawer pattern uses `(window as any).clawdia` as `api` and then calls structured methods like `api.process.list()`. WalletDrawer follows the same pattern.

- [ ] **Step 2: Add wallet to Rail.tsx (three-part change)**

Open `src/renderer/components/sidebar/Rail.tsx`.

**Part 1** — extend `DrawerMode` union (line 3):
```typescript
export type DrawerMode = 'chat' | 'agents' | 'browser' | 'files' | 'desktop' | 'wallet';
```

**Part 2** — add wallet icon to `icons` object (after the `desktop` entry, before `settings`):
```typescript
  wallet: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
      <line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  ),
```

**Part 3** — add wallet to `MODES` array (after `desktop`):
```typescript
  { mode: 'wallet', title: 'Wallet' },
```

- [ ] **Step 2: Add WalletDrawer to Sidebar.tsx**

Open `src/renderer/components/Sidebar.tsx`.

Add import after the other drawer imports:
```typescript
import WalletDrawer from './sidebar/drawers/WalletDrawer';
```

Add render branch inside the drawer container (after the `desktop` branch):
```typescript
{activeMode === 'wallet' && <WalletDrawer />}
```

- [ ] **Step 4: Create a stub WalletDrawer so the app compiles**

Create `src/renderer/components/sidebar/drawers/WalletDrawer.tsx` with a placeholder:
```typescript
import React from 'react';

export default function WalletDrawer() {
  return (
    <div className="flex flex-col h-full p-3 text-text-muted text-xs">
      <div className="font-semibold text-text-primary mb-3">Wallet</div>
      <div>Loading...</div>
    </div>
  );
}
```

- [ ] **Step 5: Run the app and verify wallet icon appears in rail**

```bash
npm run dev
```
Click the wallet (credit card) icon in the sidebar rail. Verify the "Wallet" drawer opens with the placeholder text. Verify no console errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/preload.ts \
        src/renderer/components/sidebar/Rail.tsx \
        src/renderer/components/Sidebar.tsx \
        src/renderer/components/sidebar/drawers/WalletDrawer.tsx
git commit -m "feat: add wallet preload namespace, rail icon, and stub WalletDrawer"
```

---

## Task 9: WalletDrawer — full implementation

**Files:**
- Modify: `src/renderer/components/sidebar/drawers/WalletDrawer.tsx`

Replace the stub with the full three-panel implementation.

- [ ] **Step 1: Implement the full WalletDrawer**

Replace the stub content of `WalletDrawer.tsx` with:

```typescript
import React, { useState, useEffect, useCallback } from 'react';

const api = (window as any).clawdia;

interface PaymentMethod {
  id: number;
  label: string;
  lastFour: string;
  cardType: string;
  expiryMonth: number;
  expiryYear: number;
  source: string;
  isPreferred: boolean;
  isBackup: boolean;
}

interface Budget {
  period: string;
  limitUsd: number;
  isActive: boolean;
  resetDay?: number;
}

interface Transaction {
  id: number;
  merchant: string;
  amountUsd: number;
  description?: string;
  status: string;
  isEstimated: boolean;
  createdAt: string;
  paymentMethodId?: number;
}

interface RemainingBudget {
  period: string;
  remaining: number;
  limit: number;
  spent: number;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function StatusBadge({ status, isEstimated }: { status: string; isEstimated: boolean }) {
  const label = isEstimated ? 'estimated' : status;
  const color = {
    completed: 'text-green-400',
    pending: 'text-yellow-400',
    failed: 'text-red-400',
    estimated: 'text-text-muted',
    refunded: 'text-blue-400',
  }[label] ?? 'text-text-muted';
  return <span className={`text-[10px] font-medium uppercase ${color}`}>{label}</span>;
}

function BudgetBar({ spent, limit }: { spent: number; limit: number }) {
  const pct = Math.min(100, Math.round((spent / limit) * 100));
  const color = pct < 60 ? 'bg-green-500' : pct < 85 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="w-full h-[3px] bg-surface-1 rounded-full mt-1">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function WalletDrawer() {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [remaining, setRemaining] = useState<RemainingBudget[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [importCandidates, setImportCandidates] = useState<PaymentMethod[] | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({ label: '', lastFour: '', cardType: 'visa', expiryMonth: '', expiryYear: '', billingName: '', cardNumber: '' });

  const reload = useCallback(async () => {
    const [m, b, r, t] = await Promise.all([
      api.wallet.getPaymentMethods(),
      api.wallet.getBudgets(),
      api.wallet.getRemainingBudgets(),
      api.wallet.getTransactions({ limit: 30 }),
    ]);
    setMethods(m ?? []);
    setBudgets(b ?? []);
    setRemaining(r ?? []);
    setTransactions(t ?? []);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleImport = async () => {
    const candidates = await api.wallet.importBrowserCards();
    setImportCandidates(candidates ?? []);
  };

  const handleConfirmImport = async (selected: PaymentMethod[]) => {
    await api.wallet.confirmImport(selected);
    setImportCandidates(null);
    reload();
  };

  const handleAddManual = async () => {
    await api.wallet.addManualCard({
      ...addForm,
      expiryMonth: Number(addForm.expiryMonth),
      expiryYear: Number(addForm.expiryYear),
    });
    setShowAddForm(false);
    setAddForm({ label: '', lastFour: '', cardType: 'visa', expiryMonth: '', expiryYear: '', billingName: '', cardNumber: '' });
    reload();
  };

  const setBudgetValue = async (period: string, limitUsd: number) => {
    await api.wallet.setBudget({ period, limitUsd });
    reload();
  };

  const toggleBudget = async (period: string, current?: Budget) => {
    if (current?.isActive) {
      await api.wallet.disableBudget(period);
    } else {
      await api.wallet.setBudget({ period, limitUsd: 10000 }); // default $100
    }
    reload();
  };

  const periods = ['daily', 'weekly', 'monthly'] as const;

  return (
    <div className="flex flex-col h-full overflow-y-auto text-xs text-text-primary">

      {/* ── Section 1: Payment Methods ── */}
      <div className="px-3 pt-3 pb-2">
        <div className="font-semibold text-[11px] uppercase tracking-wide text-text-muted mb-2">Payment Methods</div>

        <div className="flex gap-1 mb-2">
          <button onClick={handleImport}
            className="flex-1 text-[11px] px-2 py-1 rounded bg-surface-1 hover:bg-surface-2 text-text-primary">
            Import from browser
          </button>
          <button onClick={() => setShowAddForm(v => !v)}
            className="flex-1 text-[11px] px-2 py-1 rounded bg-surface-1 hover:bg-surface-2 text-text-primary">
            Add manually
          </button>
        </div>

        {/* Import candidates */}
        {importCandidates !== null && (
          <div className="mb-2 p-2 bg-surface-1 rounded">
            <div className="text-text-muted mb-1">Found {importCandidates.length} card(s)</div>
            {importCandidates.length === 0
              ? <div className="text-text-muted">No saved cards found in browser.</div>
              : importCandidates.map((c, i) => (
                <div key={i} className="flex items-center gap-1 mb-1">
                  <input type="checkbox" defaultChecked id={`imp-${i}`} />
                  <label htmlFor={`imp-${i}`} className="text-text-primary">{c.label}</label>
                </div>
              ))
            }
            <div className="flex gap-1 mt-1">
              <button onClick={() => handleConfirmImport(importCandidates)}
                className="text-[11px] px-2 py-0.5 rounded bg-accent text-white">Import</button>
              <button onClick={() => setImportCandidates(null)}
                className="text-[11px] px-2 py-0.5 rounded bg-surface-2 text-text-muted">Cancel</button>
            </div>
          </div>
        )}

        {/* Manual add form */}
        {showAddForm && (
          <div className="mb-2 p-2 bg-surface-1 rounded flex flex-col gap-1">
            <input placeholder="Label (e.g. Visa ••••4242)" value={addForm.label}
              onChange={e => setAddForm(f => ({ ...f, label: e.target.value }))}
              className="w-full bg-surface-0 border border-border rounded px-2 py-1 text-xs" />
            <input placeholder="Card number" value={addForm.cardNumber} type="password"
              onChange={e => setAddForm(f => ({ ...f, cardNumber: e.target.value, lastFour: e.target.value.slice(-4) }))}
              className="w-full bg-surface-0 border border-border rounded px-2 py-1 text-xs" />
            <div className="flex gap-1">
              <input placeholder="MM" value={addForm.expiryMonth} maxLength={2}
                onChange={e => setAddForm(f => ({ ...f, expiryMonth: e.target.value }))}
                className="w-12 bg-surface-0 border border-border rounded px-2 py-1 text-xs" />
              <input placeholder="YYYY" value={addForm.expiryYear} maxLength={4}
                onChange={e => setAddForm(f => ({ ...f, expiryYear: e.target.value }))}
                className="w-16 bg-surface-0 border border-border rounded px-2 py-1 text-xs" />
              <select value={addForm.cardType} onChange={e => setAddForm(f => ({ ...f, cardType: e.target.value }))}
                className="flex-1 bg-surface-0 border border-border rounded px-1 py-1 text-xs">
                {['visa','mastercard','amex','discover','other'].map(t => (
                  <option key={t} value={t}>{capitalize(t)}</option>
                ))}
              </select>
            </div>
            <input placeholder="Name on card (optional)" value={addForm.billingName}
              onChange={e => setAddForm(f => ({ ...f, billingName: e.target.value }))}
              className="w-full bg-surface-0 border border-border rounded px-2 py-1 text-xs" />
            <div className="flex gap-1">
              <button onClick={handleAddManual}
                className="text-[11px] px-2 py-0.5 rounded bg-accent text-white">Save</button>
              <button onClick={() => setShowAddForm(false)}
                className="text-[11px] px-2 py-0.5 rounded bg-surface-2 text-text-muted">Cancel</button>
            </div>
          </div>
        )}

        {/* Card list */}
        {methods.length === 0
          ? <div className="text-text-muted py-2">No cards added yet.</div>
          : methods.map(m => (
            <div key={m.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
              <div>
                <div className="text-text-primary">{m.label}</div>
                <div className="text-text-muted text-[10px]">
                  {m.expiryMonth}/{m.expiryYear} · {m.source === 'browser_autofill' ? 'browser' : 'manual'}
                </div>
              </div>
              <div className="flex gap-1">
                {m.isPreferred && <span className="text-[9px] font-bold text-accent uppercase">Preferred</span>}
                {m.isBackup && <span className="text-[9px] font-bold text-yellow-400 uppercase">Backup</span>}
                <button onClick={async () => { await api.wallet.setPreferred(m.id); reload(); }}
                  className="text-[10px] text-text-muted hover:text-text-primary px-1">★</button>
                <button onClick={async () => { await api.wallet.removeCard(m.id); reload(); }}
                  className="text-[10px] text-text-muted hover:text-red-400 px-1">✕</button>
              </div>
            </div>
          ))
        }
      </div>

      <div className="h-px bg-border mx-3" />

      {/* ── Section 2: Spending Limits ── */}
      <div className="px-3 py-2">
        <div className="font-semibold text-[11px] uppercase tracking-wide text-text-muted mb-2">Spending Limits</div>
        {periods.map(period => {
          const budget = budgets.find(b => b.period === period);
          const rem = remaining.find(r => r.period === period);
          return (
            <div key={period} className="mb-2">
              <div className="flex items-center justify-between">
                <span className="text-text-primary">{capitalize(period)}</span>
                <div className="flex items-center gap-2">
                  {budget?.isActive && rem && (
                    <span className="text-text-muted">{formatCents(rem.remaining)} left</span>
                  )}
                  <button
                    onClick={() => toggleBudget(period, budget)}
                    className={`w-8 h-4 rounded-full transition-colors ${budget?.isActive ? 'bg-accent' : 'bg-surface-2'}`}
                  >
                    <span className={`block w-3 h-3 rounded-full bg-white mx-0.5 transition-transform ${budget?.isActive ? 'translate-x-4' : ''}`} />
                  </button>
                </div>
              </div>
              {budget?.isActive && (
                <div className="flex items-center gap-1 mt-1">
                  <span className="text-text-muted">$</span>
                  <input
                    type="number"
                    defaultValue={(budget.limitUsd / 100).toFixed(0)}
                    onBlur={e => setBudgetValue(period, Math.round(Number(e.target.value) * 100))}
                    className="w-20 bg-surface-0 border border-border rounded px-1 py-0.5 text-xs"
                  />
                </div>
              )}
              {budget?.isActive && rem && (
                <BudgetBar spent={rem.spent} limit={rem.limit} />
              )}
            </div>
          );
        })}
      </div>

      <div className="h-px bg-border mx-3" />

      {/* ── Section 3: Transaction History ── */}
      <div className="px-3 py-2 flex-1">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-[11px] uppercase tracking-wide text-text-muted">Transactions</div>
          {remaining.find(r => r.period === 'monthly') && (
            <div className="text-[10px] text-text-muted">
              {formatCents(remaining.find(r => r.period === 'monthly')!.spent)} / {formatCents(remaining.find(r => r.period === 'monthly')!.limit)} this month
            </div>
          )}
        </div>
        {transactions.length === 0
          ? <div className="text-text-muted py-2">No transactions yet.</div>
          : transactions.map(tx => (
            <div key={tx.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
              <div>
                <div className="text-text-primary">{tx.merchant}</div>
                {tx.description && <div className="text-text-muted text-[10px]">{tx.description}</div>}
                <div className="text-text-muted text-[10px]">
                  {new Date(tx.createdAt).toLocaleDateString()}
                </div>
              </div>
              <div className="text-right">
                <div className="text-text-primary">{formatCents(tx.amountUsd)}</div>
                <StatusBadge status={tx.status} isEstimated={tx.isEstimated} />
              </div>
            </div>
          ))
        }
      </div>

    </div>
  );
}
```

**Note:** All IPC calls use `api.wallet.*` methods exposed via `preload.ts` (added in Task 8 Step 1). This matches the pattern used by all other drawers (`api.process.list()`, `api.identity.listAccounts()`, etc.).

- [ ] **Step 2: Run the app and verify all three panels render**

```bash
npm run dev
```
Open the Wallet drawer and verify:
- Payment methods section shows "No cards added yet" + two buttons
- Spending limits shows Daily/Weekly/Monthly toggles
- Transactions shows "No transactions yet"

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/sidebar/drawers/WalletDrawer.tsx
git commit -m "feat: implement WalletDrawer with payment methods, budgets, and transaction history"
```

---

## Task 10: Wire spending notifications

**Files:**
- Modify: `src/main/main.ts`

The spending notification events (`spending:purchase-complete`, `spending:low-balance`, `spending:budget-exceeded`) need to be emitted from the main process to the renderer window.

- [ ] **Step 1: Add a spendingNotify helper and export it**

In `src/main/main.ts`, after the main window is created, add:

```typescript
// spending notification emitter — called by checkout-executor
export function emitSpendingEvent(event: string, payload: Record<string, any>): void {
  mainWindow?.webContents.send(event, payload);
}
```

- [ ] **Step 2: Wire resetExpiredPeriods to run on startup and hourly**

```typescript
import { resetExpiredPeriods } from './agent/spending-budget';

// On app ready (inside app.whenReady):
resetExpiredPeriods();
setInterval(resetExpiredPeriods, 60 * 60 * 1000); // hourly
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc -p tsconfig.main.json --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/main/main.ts
git commit -m "feat: add spending notification emitter and hourly budget reset"
```

---

## Task 11: Checkout executor

**Files:**
- Create: `src/main/agent/checkout-executor.ts`

This is the purchase flow orchestrator. It is called by the agent loop when a task requires a purchase. It does not run tests automatically (it drives browser automation) — manual testing is described below.

- [ ] **Step 1: Implement checkout-executor.ts**

Create `src/main/agent/checkout-executor.ts`:

```typescript
import { checkBudget, reserveEstimate, confirmTransaction, cancelReservation, getRemainingBudgets } from './spending-budget';
import { listPaymentMethods, getPreferredMethod, getBackupMethod, type PaymentMethod } from '../db/payment-methods';
import { createRunHumanIntervention, resolveRunHumanIntervention } from '../db/run-human-interventions';
import { emitSpendingEvent } from '../main';
import { IPC_EVENTS } from '../../shared/ipc-channels';

export interface CheckoutOptions {
  runId: string;
  merchant: string;
  estimatedCents: number;
  description?: string;
  /** Execute callback: given the selected card, perform the actual checkout in the browser */
  execute: (card: PaymentMethod, getCvv: () => Promise<string | null>) => Promise<{ actualCents: number }>;
}

export interface CheckoutResult {
  success: boolean;
  error?: string;
  transactionId?: number;
}

const CVV_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function runCheckout(opts: CheckoutOptions): Promise<CheckoutResult> {
  const { runId, merchant, estimatedCents, description, execute } = opts;

  // 1. Budget pre-check
  const budgetCheck = checkBudget(estimatedCents);
  if (!budgetCheck.allowed) {
    emitSpendingEvent(IPC_EVENTS.SPENDING_BUDGET_EXCEEDED, {
      merchant,
      amountCents: estimatedCents,
      blockedBy: budgetCheck.blockedBy,
      remainingCents: budgetCheck.remaining,
    });
    return { success: false, error: `Purchase blocked — ${budgetCheck.blockedBy} spending limit reached ($${(budgetCheck.remaining / 100).toFixed(2)} remaining)` };
  }

  // 2. Check payment methods configured
  const preferred = getPreferredMethod();
  const backup = getBackupMethod();
  if (!preferred && !backup) {
    return { success: false, error: 'No payment method configured. Open the Wallet to add a card.' };
  }

  // 3. Reserve the estimated amount
  const transactionId = reserveEstimate(runId, merchant, estimatedCents);

  try {
    // 4. Provide CVV getter that triggers human intervention if needed
    let cvvInterventionId: number | null = null;
    const getCvv = async (): Promise<string | null> => {
      const intervention = createRunHumanIntervention(runId, {
        interventionType: 'unknown', // extend interventionType union if needed
        target: merchant,
        summary: `CVV required to complete purchase at ${merchant} — $${(estimatedCents / 100).toFixed(2)}`,
        instructions: 'Enter the 3-digit security code from the back of your card.',
        request: { merchant, amountCents: estimatedCents },
      });
      cvvInterventionId = intervention.id;

      // Poll for resolution (max 5 minutes)
      const deadline = Date.now() + CVV_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        const updated = await import('../db/run-human-interventions').then(m =>
          m.getRunHumanInterventionRecord(intervention.id));
        if (updated?.status === 'resolved') {
          return (updated.request as any).cvv ?? null;
        }
        if (updated?.status === 'dismissed') return null;
      }
      // Timeout — dismiss
      resolveRunHumanIntervention(intervention.id, 'dismissed');
      return null;
    };

    // 5. Execute the purchase (caller-provided browser automation)
    const card = preferred ?? backup!;
    const { actualCents } = await execute(card, getCvv);

    // 6. Confirm transaction
    confirmTransaction(transactionId, actualCents);

    // 7. Check low-balance notification
    const budgets = getRemainingBudgets();
    for (const b of budgets) {
      if (b.limit > 0 && b.remaining / b.limit < 0.2) {
        emitSpendingEvent(IPC_EVENTS.SPENDING_LOW_BALANCE, {
          period: b.period,
          remainingCents: b.remaining,
          limitCents: b.limit,
        });
      }
    }

    // 8. Purchase complete notification
    const monthlyRemaining = budgets.find(b => b.period === 'monthly');
    emitSpendingEvent(IPC_EVENTS.SPENDING_PURCHASE_COMPLETE, {
      merchant,
      description,
      amountCents: actualCents,
      remainingCents: monthlyRemaining?.remaining,
    });

    return { success: true, transactionId };

  } catch (err: any) {
    cancelReservation(transactionId);
    return { success: false, error: err.message ?? 'Checkout failed', transactionId };
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc -p tsconfig.main.json --noEmit 2>&1 | head -20
```
Fix any type errors that arise.

- [ ] **Step 3: Manual smoke test**

With the app running, open the Wallet drawer, add a test card (use a fake number — this is just metadata), set a monthly budget. Then ask Clawdia to make a simulated purchase and verify:
- Budget pre-check fires correctly
- Transaction appears in the history panel as `pending`

- [ ] **Step 4: Commit**

```bash
git add src/main/agent/checkout-executor.ts
git commit -m "feat: add checkout-executor with budget check, card selection, CVV intervention"
```

---

## Task 12: Full integration smoke test

- [ ] **Step 1: Run all new tests together**

```bash
npx jest tests/db/payment-methods.test.ts \
         tests/db/spending-budgets.test.ts \
         tests/db/spending-transactions.test.ts \
         tests/agent/spending-budget.test.ts \
         tests/agent/browser-card-scanner.test.ts \
         --no-coverage 2>&1 | tail -20
```
Expected: all tests pass

- [ ] **Step 2: Run the full test suite to check for regressions**

```bash
npx jest --no-coverage 2>&1 | tail -20
```
Expected: no regressions

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: Clawdia Wallet — payment methods, budgets, transactions, checkout executor, wallet UI"
```
