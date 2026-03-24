# Clawdia Wallet — Design Spec

**Date:** 2026-03-24
**Status:** In Review
**Scope:** `src/main/db/database.ts`, `src/main/db/payment-methods.ts` (new), `src/main/db/spending-budgets.ts` (new), `src/main/db/spending-transactions.ts` (new), `src/main/agent/spending-budget.ts` (new), `src/main/agent/checkout-executor.ts` (new), `src/renderer/components/sidebar/Rail.tsx`, `src/renderer/components/Sidebar.tsx`, `src/renderer/components/sidebar/drawers/WalletDrawer.tsx` (new), `src/shared/ipc-channels.ts`

---

## Overview

The Clawdia Wallet gives users a first-class spending control layer. Users register their payment methods, set daily/weekly/monthly spend limits, and Clawdia executes purchases autonomously within those limits — using the user's existing saved payment methods inside authenticated browser sessions. No card numbers are typed at checkout; Clawdia selects from cards already on file at the merchant. A budget enforcement engine tracks every transaction, sends low-balance notifications, and blocks purchases that would exceed configured limits.

This is a permission and tracking layer, not a payment processor. Clawdia never holds funds and never stores CVVs.

---

## Future Extension: Crypto

The data model is designed to accommodate crypto as a first-class payment instrument in a future release. `payment_methods.method_type` (`card` | `crypto`) is present from day one. The wallet UI is built as a list of payment instruments, not a list of cards. Budget tracking is currency-aware with USD equivalents for crypto. No crypto functionality ships in this spec — the hooks are structural only.

---

## Data Model

Migration **v29** adds three new tables to the existing SQLite database. The final log line in `runMigrations()` (currently `Math.max(currentVersion, 28)`) must be updated to `Math.max(currentVersion, 29)` as part of this migration.

### `payment_methods`

Stores card identity metadata — enough to identify which saved card to select at merchant checkout. No full card numbers stored here.

```sql
CREATE TABLE IF NOT EXISTS payment_methods (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,          -- e.g. "Visa ••••4242"
  last_four       TEXT NOT NULL,          -- e.g. "4242"
  card_type       TEXT NOT NULL,          -- 'visa' | 'mastercard' | 'amex' | 'discover' | 'other'
  method_type     TEXT NOT NULL DEFAULT 'card',  -- 'card' | 'crypto' (future)
  expiry_month    INTEGER NOT NULL,
  expiry_year     INTEGER NOT NULL,
  billing_name    TEXT,
  source          TEXT NOT NULL,          -- 'browser_autofill' | 'manual'
  vault_ref       TEXT,                   -- credential_vault label for manually-entered full details
  is_preferred    INTEGER NOT NULL DEFAULT 0,  -- bool
  is_backup       INTEGER NOT NULL DEFAULT 0,  -- bool
  is_active       INTEGER NOT NULL DEFAULT 1,  -- bool, false = soft-deleted
  created_at      TEXT NOT NULL
);
```

For **manually-entered cards**: full card details (number, expiry, billing address) are stored encrypted in the existing `credential_vault` table with `type = 'payment_card'` and `service = 'wallet'`. The `vault_ref` column holds the `credential_vault.label` value; all lookups must pass `service = 'wallet'` to correctly resolve the `(label, service)` unique constraint. The `payment_methods` row holds only the reference metadata.

**Migration v29 must widen the `credential_vault` CHECK constraint** to include `'payment_card'` alongside the existing types (`api_key`, `session_token`, `app_password`, `oauth_token`). Because SQLite does not support `ALTER COLUMN`, this requires dropping and recreating `credential_vault` using the established pattern from migrations v12, v14, v22, and v23.

For **browser-autofill cards**: `vault_ref` is NULL. Only metadata is stored — enough to match against a card already saved at the merchant.

Only one row may have `is_preferred = 1` and one may have `is_backup = 1`. Enforced at the application layer.

---

### `spending_budgets`

```sql
CREATE TABLE IF NOT EXISTS spending_budgets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  period      TEXT NOT NULL,        -- 'daily' | 'weekly' | 'monthly'
  limit_usd   INTEGER NOT NULL,     -- in cents, e.g. 2000 = $20.00
  is_active   INTEGER NOT NULL DEFAULT 1,
  reset_day   INTEGER,              -- day of week (0=Sun) for weekly; day of month for monthly; NULL for daily
  created_at  TEXT NOT NULL
);
```

At most one active budget per period type. All active budgets are enforced simultaneously — the most restrictive one wins. A purchase is blocked if it would exceed **any** active budget.

---

### `spending_transactions`

```sql
CREATE TABLE IF NOT EXISTS spending_transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
  merchant          TEXT NOT NULL,
  amount_usd        INTEGER NOT NULL,   -- in cents
  description       TEXT,
  payment_method_id INTEGER REFERENCES payment_methods(id),
  status            TEXT NOT NULL,      -- 'pending' | 'completed' | 'failed' | 'refunded'
  is_estimated      INTEGER NOT NULL DEFAULT 0,  -- 1 = pre-task estimate, 0 = actual
  created_at        TEXT NOT NULL
);
```

**Estimated transactions:** Before executing any task that may involve a purchase, Clawdia writes a row with `is_estimated = 1` and `status = 'pending'`. This reserves the amount against active budgets immediately — preventing double-spend if two tasks run concurrently. On task completion: updated to `is_estimated = 0`, `status = 'completed'`, actual amount filled in. On failure/cancellation: row deleted.

---

## Budget Engine

**File:** `src/main/agent/spending-budget.ts`

```typescript
export interface BudgetCheckResult {
  allowed: boolean;
  remaining: number;        // cents remaining in most restrictive active budget
  blockedBy: 'daily' | 'weekly' | 'monthly' | null;
  periodSpent: number;      // cents spent in the blocking period
  periodLimit: number;      // cents limit for the blocking period
}

// Called before any purchase. Checks all active budgets.
export function checkBudget(amountUsdCents: number): BudgetCheckResult

// Called at task start — writes estimated transaction row, returns transaction id
export function reserveEstimate(runId: string, merchant: string, estimatedCents: number): number

// Called on purchase completion — updates estimated row to actual
export function confirmTransaction(transactionId: number, actualCents: number): void

// Called on task failure/cancellation — removes estimated reservation
export function cancelReservation(transactionId: number): void

// Called on app startup and hourly — clears elapsed period windows
export function resetExpiredPeriods(): void

// Returns remaining budget for each active period
export function getRemainingBudgets(): Array<{ period: string; remaining: number; limit: number; spent: number }>
```

**Period window calculation:**
- Daily: rolling 24 hours from midnight
- Weekly: sum of transactions since last `reset_day` occurrence (defaults to Monday)
- Monthly: sum of transactions since the `reset_day` of the current month (defaults to 1st)

Pending + completed transactions both count against the period. Failed and refunded transactions do not.

---

## Checkout Executor

**File:** `src/main/agent/checkout-executor.ts`

Handles the purchase flow inside an authenticated browser session. Called by the main agent loop when a task involves a purchase.

### Flow

```
checkoutExecutor(merchant, estimatedAmount, description)
  │
  ├─ 1. checkBudget(estimatedAmount)
  │      └─ blocked → notify spending.budget_exceeded, return failure
  │
  ├─ 2. reserveEstimate(runId, merchant, estimatedAmount)
  │
  ├─ 3. Scan checkout page for saved payment options
  │      └─ match against payment_methods by card_type + last_four
  │
  ├─ 4. Select preferred card if found, else backup card
  │      └─ neither found → notify spending.no_matching_card, cancelReservation, return failure
  │
  ├─ 5. Click saved payment option in merchant UI
  │
  ├─ 6. Check if CVV required
  │      └─ yes → trigger human_intervention('cvv_required', merchant, amount)
  │               wait for user CVV input (existing intervention system)
  │               enter CVV once, never persist
  │
  ├─ 7. Confirm purchase
  │
  ├─ 8. confirmTransaction(transactionId, actualAmount)
  │      └─ check if remaining < 20% of any active budget → notify spending.low_balance
  │
  └─ 9. notify spending.purchase_complete
```

### CVV Human Intervention

Uses the existing `run_human_interventions` system (same mechanism as CAPTCHA). Intervention type: `'cvv_required'`. Payload includes merchant name and purchase amount. The intervention notification reads: *"CVV required to complete purchase at [merchant] — $X.XX. Enter your card's 3-digit security code to proceed."*

CVV is received via the intervention resolution channel, used once to fill the field, and immediately discarded — never written to any store, log, or database.

---

## Notifications

Four new IPC notification events sent from main → renderer via existing `ipc-channels.ts`:

| Event | Trigger | Message |
|-------|---------|---------|
| `spending.purchase_complete` | Transaction confirmed | "Purchased [description] at [merchant] for $X.XX — $Y.YY remaining this month" |
| `spending.low_balance` | Remaining < 20% of any active limit after a purchase | "Spending limit running low — $Y.YY remaining [this week/month/today]" |
| `spending.budget_exceeded` | Purchase would exceed a limit | "Purchase blocked — $X.XX would exceed your [daily/weekly/monthly] limit ($Y.YY remaining)" |
| `spending.cvv_required` | CVV needed at checkout | Delivered via human_intervention system, not a toast |

---

## Wallet UI

### Rail Icon

**File:** `src/renderer/components/sidebar/Rail.tsx`

Add `'wallet'` to the `DrawerMode` union and `MODES` array. Wallet icon (credit card SVG) positioned in the main icon group, below `desktop`. Add a badge overlay on the rail icon showing remaining monthly budget (e.g. "$47") — updates reactively when transactions are recorded.

```typescript
export type DrawerMode = 'chat' | 'agents' | 'browser' | 'files' | 'desktop' | 'wallet';
```

**This is a three-part change to `Rail.tsx`:**
1. Extend the `DrawerMode` union with `'wallet'`
2. Add `{ mode: 'wallet', title: 'Wallet' }` to the `MODES` array
3. Add a `wallet` key to the `icons` object with a credit card SVG — **this is required**, as `Rail.tsx` renders icons via `icons[mode]` and `icons['wallet']` will be `undefined` (blank/crash) if the key is missing

### Sidebar Integration

**File:** `src/renderer/components/Sidebar.tsx`

Add `WalletDrawer` import and render branch for `activeMode === 'wallet'`. No other changes to `Sidebar.tsx`.

### WalletDrawer

**File:** `src/renderer/components/sidebar/drawers/WalletDrawer.tsx`

Three scrollable sections within the 210px drawer, separated by section headers:

**Section 1 — Payment Methods**

List of `payment_methods` rows. Each card shows:
- Card type icon + label ("Visa ••••4242")
- Expiry date
- `PREFERRED` or `BACKUP` badge if designated
- Source indicator (browser / manual)

Two action buttons at top:
- **Import from browser** — triggers IPC call to main process to scan Chrome/Firefox autofill data. Returns cards found. User checkboxes which to import. Imported cards written to `payment_methods` with `source = 'browser_autofill'`.
- **Add manually** — inline form: card number, expiry, billing name. On submit: full details encrypted into `credential_vault`, reference metadata written to `payment_methods` with `source = 'manual'`.

Right-click context menu on each card: Set as Preferred / Set as Backup / Remove.

**Section 2 — Spending Limits**

Three rows: Daily / Weekly / Monthly. Each row:
- Toggle (on/off)
- Dollar amount input (shown when active)
- "Remaining: $X.XX" live indicator (shown when active and transactions exist)

Below each active limit, a thin progress bar showing used/total for the current period (green → yellow → red as it fills).

**Section 3 — Transaction History**

Scrollable list, newest first. Each row:
- Merchant name + description
- Amount (right-aligned)
- Status badge: `completed` (green) / `pending` (yellow) / `failed` (red) / `estimated` (grey)
- Card used (last four)
- Timestamp

Running period total shown at section header: "This month: $52.40 / $200.00"

A "Settings →" link at the bottom deep-links to the wallet section in SettingsView (for users who discover the feature via settings rather than the rail icon).

---

## Browser Autofill Import

**File:** `src/main/agent/browser-card-scanner.ts` (new)

Reads Chrome's saved payment methods from the local profile SQLite database (`~/.config/google-chrome/Default/Web Data`). Extracts: name on card, last four digits, expiry month/year, card type (inferred from first digit/BIN prefix). Returns a list of `PaymentMethodCandidate[]` — user selects which to import via the WalletDrawer UI.

Firefox support: reads from `~/.mozilla/firefox/*/formhistory.sqlite` with the same extraction pattern.

**Important:** Chrome's `Web Data` database contains a `card_number_encrypted` column storing the full PAN encrypted with AES-256-GCM using the OS keychain — accessible to any process running as the same user. The scanner must explicitly read **only** the display metadata columns (`name_on_card`, `last_four`, `expiration_month`, `expiration_year`) and must never read or attempt to decrypt `card_number_encrypted`. This is an explicit implementation constraint, not a structural limitation of the database format.

---

## IPC Channels

New channels added to `src/shared/ipc-channels.ts`:

Channel names follow the existing `namespace:kebab-case` convention used throughout `ipc-channels.ts`.

```typescript
// Renderer → Main
'wallet:get-payment-methods'       // returns PaymentMethod[]
'wallet:add-manual-card'           // args: CardDetails → returns PaymentMethod
'wallet:import-browser-cards'      // returns PaymentMethodCandidate[]
'wallet:confirm-import'            // args: PaymentMethodCandidate[] → void
'wallet:set-preferred'             // args: id → void
'wallet:set-backup'                // args: id → void
'wallet:remove-card'               // args: id → void
'wallet:get-budgets'               // returns SpendingBudget[]
'wallet:set-budget'                // args: { period, limitUsd, resetDay? } → void
'wallet:disable-budget'            // args: period → void
'wallet:get-transactions'          // args: { limit? } → SpendingTransaction[]
'wallet:get-remaining-budgets'     // returns BudgetRemaining[]

// Main → Renderer (push notifications)
'spending:purchase-complete'
'spending:low-balance'
'spending:budget-exceeded'
```

---

## Error Handling

- **No payment methods configured** — checkout executor returns early with a clear error message in the run output: "No payment method configured. Open the Wallet to add a card."
- **No matching card at merchant** — executor cancels the reservation and surfaces: "Preferred card (Visa ••••4242) not found at checkout. You may need to save it at [merchant] first."
- **Budget exceeded** — reservation never written; run halts with notification before any browser interaction
- **CVV intervention timeout** — if user doesn't respond within 5 minutes, intervention resolves as cancelled, reservation deleted, run fails gracefully
- **Browser autofill scan fails** — silently returns empty list; user can still add cards manually
- **Transaction confirmation fails** — reservation remains as `pending`; user can manually resolve from transaction history

---

## Security

- CVV never persisted — received via intervention channel, used once, discarded
- Full card numbers stored only in `credential_vault` (AES-256-GCM via `safeStorage`) — same encryption as passwords
- `payment_methods` table contains no sensitive data — last four + expiry only
- `spending_transactions` contains no card numbers — only `payment_method_id` reference
- Browser autofill scanner reads display metadata only — the scanner explicitly skips `card_number_encrypted`; full PANs are never read or stored by Clawdia
- All wallet IPC channels validated in main process before executing — no renderer-side trust

---

## Testing

**`spending-budget.ts`**
- `checkBudget()` correctly sums pending + completed transactions for the current period
- `checkBudget()` returns blocked when any single active budget is exceeded
- `checkBudget()` returns the most restrictive blocking period
- `reserveEstimate()` + `confirmTransaction()` round-trip updates row correctly
- `cancelReservation()` removes the row
- `resetExpiredPeriods()` correctly clears elapsed daily/weekly/monthly windows

**`checkout-executor.ts`**
- Blocks immediately when `checkBudget` returns not allowed
- Matches preferred card at checkout by card_type + last_four
- Falls back to backup card when preferred not found
- Cancels reservation when neither card found
- Triggers human_intervention when CVV required
- Calls `confirmTransaction` with actual amount on success
- Fires `spending.low_balance` when remaining < 20% after purchase

**`payment-methods.ts` CRUD**
- Insert + retrieve round-trip
- Only one preferred and one backup at a time (application-layer enforcement)
- Soft-delete sets `is_active = 0`, not removed from DB

**`browser-card-scanner.ts`**
- Returns empty array when Chrome profile not found
- Returns empty array when Web Data file locked or unreadable
- Correctly parses masked card entries from Chrome Web Data schema

---

## Out of Scope

- Crypto payment instruments (data model hooks present; no functionality)
- Recurring subscription management
- Refund initiation (tracked in transactions table as `refunded` status, but Clawdia cannot initiate refunds)
- Per-merchant spending limits (global daily/weekly/monthly limits only)
- Multi-user / shared wallet
- Receipt parsing or itemized transaction details
- Cost-per-task analytics beyond transaction history
