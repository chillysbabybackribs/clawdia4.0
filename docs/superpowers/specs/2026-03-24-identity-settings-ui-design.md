# Identity Settings UI — Design Spec

**Date:** 2026-03-24
**Status:** Approved
**Scope:** Identity profile settings section, accounts table, credential vault UI, browser login auto-capture

---

## Overview

Add an Identity section to the existing Settings view that lets users configure the personal information Clawdia is allowed to use when acting on their behalf. The section covers three areas: the identity profile (personal details used for signups), an accounts table (all accounts Clawdia can access), and a credential vault (encrypted storage for passwords, API keys, and tokens).

Additionally, a browser login interceptor auto-captures credentials whenever the user logs into a site in Clawdia's persistent browser, populating the vault silently. Users can revoke any entry from the settings UI.

---

## Section 1 — Identity Profile Form

### Purpose
Lets the user set the personal details Clawdia fills into signup forms when provisioning accounts on their behalf.

### Fields
- **Full name** — text input
- **Email** — text input
- **Username pattern** — text input, placeholder "e.g. dp_, dp123" — Clawdia picks from this when choosing a handle
- **Date of birth** — text input, format YYYY-MM-DD — required by some services

### Behavior
- On mount, loads the default profile via `identityStore.getDefaultProfile()`
- All fields optional — blank fields are excluded from signup flows
- Single "Save Profile" button calls `identityStore.upsertProfile({ name: 'default', ..., isDefault: true })`
- Shows "Saved ✓" confirmation inline for 2 seconds (same pattern as existing Settings save button)

### Type Definitions

```typescript
interface IdentityProfile {
  id: number;
  name: string;
  fullName: string;
  email: string;
  usernamePattern: string;
  dateOfBirth: string;   // YYYY-MM-DD or empty string
  isDefault: boolean;
  createdAt: string;
}

interface UpsertProfileInput {
  name: string;           // 'default' for the default profile
  fullName?: string;
  email?: string;
  usernamePattern?: string;
  dateOfBirth?: string;   // YYYY-MM-DD
  isDefault?: boolean;
}
```

### IPC
- `IDENTITY_PROFILE_GET` → returns `IdentityProfile | null`
- `IDENTITY_PROFILE_SET` → takes `UpsertProfileInput`, returns `IdentityProfile`

---

## Section 2 — Accounts Table

### Purpose
View of all accounts Clawdia can access, with color-coded access type and the ability to manually add or remove accounts.

### Data model note — one account per service
The `managed_accounts` table enforces `UNIQUE(service_name)` — only one account per service is stored. The most recent upsert wins. This means if Clawdia auto-captures a login for "reddit.com" and the user also manually adds "reddit.com", the last write replaces the previous entry. This constraint is intentional and documented here so users understand it.

### Columns
- **Service** — service name (e.g. "reddit.com")
- **Username** — username or email used
- **Access** — color-coded pill: Session (green) / Vault (yellow) / Managed (red)

### Access type logic (display only — priority enforcement is in account-provisioner.ts)
- **Session** — a row exists in `managed_accounts` with status `active` AND the browser session partition has a live cookie for that domain (checked via `session.cookies.get`)
- **Vault** — a credential exists in `credential_vault` for this service but no live session
- **Managed** — account was provisioned by Clawdia (has a record in `managed_accounts`)

### Manual add
- "Add account manually" button opens an inline form below the table: service name, username, password fields
- On submit: calls `IDENTITY_ACCOUNT_ADD` with `SaveAccountInput`

### Delete
- Each row has a delete button that calls `IDENTITY_ACCOUNT_DELETE` with `serviceName`

### Type Definitions

```typescript
interface SaveAccountInput {
  serviceName: string;
  loginUrl?: string;
  username: string;
  emailUsed?: string;
  passwordPlain: string;   // renderer sends the raw password; main process encrypts before storage
  phoneUsed?: string;
  phoneMethod?: string;
  notes?: string;
}
```

**Security note on `SaveAccountInput`:** `passwordPlain` flows from the renderer to the main process here. This is the **only** direction where a raw password travels over IPC, and it is intentional — the user has just typed it into the manual-add form. The main process calls `identityStore.saveAccount(input)` which encrypts `passwordPlain` before writing to the database. The reverse direction (main → renderer) is always prohibited; the `ManagedAccountView` DTO ensures `passwordPlain` is never sent back.

### IPC
- `IDENTITY_ACCOUNTS_LIST` → returns `ManagedAccountView[]` (sanitised DTO — no passwords, see below)
- `IDENTITY_ACCOUNT_ADD` → takes `SaveAccountInput`, returns `ManagedAccountView`
- `IDENTITY_ACCOUNT_DELETE` → takes `serviceName: string`, returns `{ ok: true }`

### ManagedAccountView DTO
The renderer **never** receives `passwordPlain`. The IPC handler maps `ManagedAccount` to a safe DTO before returning:

```typescript
interface ManagedAccountView {
  id: number;
  serviceName: string;
  loginUrl: string;
  username: string;
  emailUsed: string;
  // passwordPlain intentionally omitted
  phoneUsed: string;
  phoneMethod: string;
  status: 'active' | 'suspended' | 'unverified';
  accessType: 'session' | 'vault' | 'managed';   // computed by main process before returning
  createdAt: string;
  notes: string;
}
```

`accessType` is computed by the main process in the `IDENTITY_ACCOUNTS_LIST` handler before sending the DTO. The renderer does not make a separate IPC call for cookie state. The detection logic mirrors what is described in the Access type logic section above: check `session.cookies.get` for a live cookie (→ `'session'`); else check `credential_vault` for a matching entry (→ `'vault'`); else default to `'managed'`.

The IPC handler in `main.ts` performs the strip and access-type computation:
```typescript
ipcMain.handle(IPC.IDENTITY_ACCOUNTS_LIST, () => {
  return identityStore.listAccounts().map(({ passwordPlain: _omit, ...view }) => view);
});
```

### New IdentityStore methods (Section 2)
- `listAccounts(): ManagedAccount[]` — SELECT * FROM managed_accounts, decrypt passwords (for internal use; IPC handler strips before sending to renderer)
- `getAccount(serviceName: string): ManagedAccount | null` — SELECT single row by service_name, decrypt `passwordPlain`
- `deleteAccount(serviceName: string): void` — DELETE FROM managed_accounts WHERE service_name = ?

---

## Section 3 — Credential Vault

### Purpose
View and manage all encrypted credentials stored on-device — API keys, passwords, OAuth tokens.

### Display
- Each entry shows: icon, label, type + service, masked value (last 4 chars visible), delete button
- Masked format: `••••••••••••[last4]`

### Add credential
- "Add credential" button expands an inline form: label, type (dropdown: api_key / session_token / app_password / oauth_token), service, value
- On submit: calls `identityStore.saveCredential(...)`

### Delete
- ✕ button calls `IDENTITY_CREDENTIAL_DELETE` → removes from DB

### IPC
- `IDENTITY_CREDENTIALS_LIST` → returns `{ label: string; type: string; service: string; maskedValue: string }[]` (never returns raw value)
- `IDENTITY_CREDENTIAL_ADD` → takes `label, type, service, valuePlain` (positional args), returns `{ ok: true }`
- `IDENTITY_CREDENTIAL_DELETE` → takes `label: string, service: string` (positional args), returns `{ ok: true }`

**Security note on `IDENTITY_CREDENTIAL_ADD`:** `valuePlain` flows from the renderer to the main process over IPC. This is intentional — the user has just typed the credential value into the add-credential form. The main process calls `identityStore.saveCredential(...)` which encrypts `valuePlain` before writing to the database. The reverse direction (main → renderer) is always prohibited; `IDENTITY_CREDENTIALS_LIST` returns only masked values.

**Security note:** The renderer never receives raw credential values. The main process returns only masked values for display. The `getCredential` method is for internal autonomy module use only — never exposed via IPC. The masking logic: `'•'.repeat(Math.max(0, val.length - 4)) + val.slice(-4)`.

### Schema reference
`credential_vault(label, service)` is the composite unique key — see the `credential_vault` table created in DB migration v24 in `src/main/db/database.ts`. The upsert-on-conflict and delete-by-label-and-service design in this spec depends on that composite key.

### New IdentityStore methods (Section 3)
- `listCredentials(): { label: string; type: string; service: string; maskedValue: string }[]` — SELECT all from credential_vault, decrypt each value in a local variable, compute the masked string, then discard the plaintext — do not return or log decrypted values
- `deleteCredential(label: string, service: string): void` — DELETE FROM credential_vault WHERE label = ? AND service = ?

---

## Section 4 — Browser Login Auto-Capture

### Purpose
Automatically detect when the user successfully logs into a site in Clawdia's persistent browser and save those credentials to the vault — so Clawdia can re-authenticate if the session expires.

### Scope
This implementation handles **full-page-navigation login flows only**. SPA-based login flows (sites that use `history.pushState` without a full page navigation — e.g. Twitter/X, some Google flows) do not trigger `did-navigate` and are **out of scope for this build**. They will be addressed in a follow-on spec once `did-navigate-in-page` interception patterns are established.

### Mechanism

The interceptor lives in `src/main/autonomy/login-interceptor.ts` and is initialized once after `initBrowser()` in `main.ts`.

**Step 1 — Install form submit listener on login pages:**
Listen on `webContents.on('dom-ready')` for the persistent browser partition. When the current URL matches a known login page pattern (contains `/login`, `/signin`, `/auth`, `/session`), inject a `submit` event listener via `executeJavaScript`:

```javascript
document.addEventListener('submit', (e) => {
  const form = e.target;
  const pw = form.querySelector('input[type=password]');
  const user = form.querySelector('input[type=email], input[type=text]');
  if (pw) {
    window.__clawdia_captured = { username: user?.value || '', password: pw.value };
  }
}, { capture: true, once: true });
```

This runs **while the login page DOM is live**, storing captured values before navigation begins. `window.__clawdia_captured` is cleared by the main process immediately after reading (Step 2).

**Step 2 — Read captured values on `will-navigate`:**
The `login-interceptor.ts` module maintains a `Map<number, { username: string; password: string; loginUrl: string }>` keyed by `webContents.id`. Listen on `webContents.on('will-navigate')` — this fires **before** navigation commits, while the current page's DOM is still accessible via `executeJavaScript`:

```typescript
webContents.on('will-navigate', async (event, targetUrl) => {
  const fromUrl = webContents.getURL();
  if (isLoginUrl(fromUrl) && fromUrl.startsWith('https://')) {
    const captured = await webContents.executeJavaScript('window.__clawdia_captured || null').catch(() => null);
    if (captured) {
      pendingCaptures.set(webContents.id, { ...captured, loginUrl: fromUrl });
      // Clear the value from page memory to reduce exposure window
      webContents.executeJavaScript('delete window.__clawdia_captured').catch(() => null);
    }
  }
});
```

**Security note on `window.__clawdia_captured`:** The captured credentials sit in the page's JavaScript heap from the time of form submit until `will-navigate` fires and the main process reads and deletes them. Third-party scripts loaded on the login page (analytics, tracking) could read this value during that window. The HTTPS-only requirement (already enforced above) reduces but does not eliminate this risk. This is acceptable for v1.

**Step 3 — Success detection:**
On `did-navigate`, if `pendingCaptures` has an entry for this `webContents.id` and the new URL is not a login/auth/2FA URL, treat as successful login. Save to vault and update account registry.

**Step 4 — Account registry update:**
If no `managed_accounts` row exists for this service (domain), insert one with `status: 'active'`, the captured username, and the domain as `service_name`.

**Step 5 — UI update:**
Emit `IDENTITY_ACCOUNTS_CHANGED` to the main application window:
```typescript
BrowserWindow.getAllWindows()[0]?.webContents.send(IPC_EVENTS.IDENTITY_ACCOUNTS_CHANGED);
```
This causes the accounts table in Settings to refresh in real-time if open.

### Limitations and edge cases
- **SPA logins**: `did-navigate` does not fire for `history.pushState` navigations — SPA logins are silently skipped (out of scope, noted above)
- **Fetch-based form submissions**: Some sites submit login forms via `fetch`/`XHR` and redirect client-side. These do not trigger `will-navigate` even on non-SPA pages. Only traditional `<form method=POST action=...>` submissions are reliably captured.
- **JS-rendered forms**: If a login page renders its form via JavaScript after `dom-ready`, the injected submit listener is installed before the form exists and will not fire. This is a known v1 limitation (acceptable given SPA flows are also out of scope).
- **Failed logins**: If `did-navigate` lands back on a login URL, discard the pending capture — do not save
- **2FA pages**: If the redirect lands on a `/2fa`, `/verify`, `/otp` URL, hold the pending capture in memory and wait for a subsequent `did-navigate` to a non-auth URL before saving
- **HTTPS only**: Only capture credentials from HTTPS pages — check `fromUrl.startsWith('https://')` in the `will-navigate` handler
- **Existing entries**: On conflict (`UNIQUE(label, service)` in `credential_vault`), update the existing row — always keep the most recent credentials
- **Rapid successive logins**: Rapid successive logins in the same browser window before `did-navigate` resolves for the first will overwrite the first pending capture. This is acceptable for v1.

### New File
`src/main/autonomy/login-interceptor.ts`

### Modified Files
- `src/main/main.ts` — call `initLoginInterceptor(browserSession)` after `initBrowser()`
- `src/shared/ipc-channels.ts` — add `IDENTITY_ACCOUNTS_CHANGED` to `IPC_EVENTS` (event channel, not invoke channel)

---

## Component Architecture

### New Files

| File | Purpose |
|------|---------|
| `src/renderer/components/IdentitySection.tsx` | React component — all three subsections rendered inside SettingsView |
| `src/main/autonomy/login-interceptor.ts` | Browser login detection and auto-capture |

### Modified Files

| File | Change |
|------|--------|
| `src/renderer/components/SettingsView.tsx` | Add `<IdentitySection />` as a new section |
| `src/main/main.ts` | Register new IPC handlers + call `initLoginInterceptor` |
| `src/shared/ipc-channels.ts` | Add 8 new `IPC` invoke channels + `IDENTITY_ACCOUNTS_CHANGED` to `IPC_EVENTS` (event, not invoke channel) |
| `src/main/preload.ts` | Expose `window.clawdia.identity.*` methods |
| `src/main/autonomy/identity-store.ts` | Add `listAccounts()`, `deleteAccount()`, `listCredentials()`, `deleteCredential()` methods |

### Preload API surface (`window.clawdia.identity`)

```typescript
identity: {
  getProfile: () => Promise<IdentityProfile | null>
  setProfile: (input: UpsertProfileInput) => Promise<IdentityProfile>
  listAccounts: () => Promise<ManagedAccountView[]>
  addAccount: (input: SaveAccountInput) => Promise<ManagedAccountView>
  deleteAccount: (serviceName: string) => Promise<{ ok: true }>
  listCredentials: () => Promise<{ label: string; type: string; service: string; maskedValue: string }[]>
  addCredential: (label: string, type: string, service: string, valuePlain: string) => Promise<{ ok: true }>
  deleteCredential: (label: string, service: string) => Promise<{ ok: true }>
  onAccountsChanged: (cb: () => void) => () => void   // returns cleanup function
}
```

**Note:** `onAccountsChanged` returns a cleanup function (consistent with all other event listeners in the preload). `IdentitySection.tsx` calls it in a `useEffect` cleanup to prevent listener accumulation across mount/unmount cycles.

---

## UI Design

### Layout
Follows the existing `SettingsView` pattern exactly:
- Section label (10px uppercase, muted color)
- Brief description text
- Form fields or table
- Action button(s)

### Access type pill colors (from design system tokens)
- **Session** — `status-success` green (`#4ade80`) with 10% opacity background
- **Vault** — `status-warning` yellow (`#fbbf24`) with 10% opacity background
- **Managed** — `accent` red (`#FF5061`) with 10% opacity background

### Tailwind design tokens used
- Surfaces: `bg-surface-0`, `bg-surface-1`
- Text: `text-text-primary`, `text-text-secondary`, `text-text-tertiary`, `text-text-muted`
- Border: `border-border`, `border-border-subtle`
- Accent: `text-accent`, `bg-accent`

---

## Testing

- Unit tests for `login-interceptor.ts`:
  - Pending-capture state machine (`will-navigate` stores, `did-navigate` saves)
  - Failed login: `did-navigate` back to login URL discards pending capture
  - 2FA hold: intermediate `/verify` URL delays save until second redirect
  - HTTPS-only guard: HTTP URLs skip capture
  - SPA non-firing: `did-navigate-in-page` does not trigger capture (confirming known limitation)
  - Cleanup: `window.__clawdia_captured` is deleted from page context after reading
- Unit tests for IPC handlers:
  - `IDENTITY_ACCOUNTS_LIST` never returns `passwordPlain` in response
  - `IDENTITY_CREDENTIALS_LIST` returns masked values only, never raw
  - `IDENTITY_ACCOUNT_ADD` encryption round-trip: stored `managed_accounts` row has encrypted `passwordPlain`; `identityStore.getAccount(serviceName)!.passwordPlain` returns the decrypted value (proving round-trip, not stored cleartext)
- `onAccountsChanged` cleanup test: calling the returned cleanup function removes the listener; mounting/unmounting `IdentitySection` multiple times does not accumulate listeners

---

## Out of Scope

- Multiple identity profiles / persona management (future)
- OAuth / SSO credential capture (different flow, deferred)
- SPA login auto-capture (`history.pushState` flows — follow-on spec)
- Browser password manager UI parity
- Credential sharing or sync across devices
