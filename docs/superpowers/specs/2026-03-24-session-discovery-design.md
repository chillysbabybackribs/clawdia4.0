# Session Discovery — Design Spec

**Date:** 2026-03-24
**Status:** In Review
**Scope:** Auto-populate the Identity Accounts table from existing browser session cookies

---

## Overview

The Identity Accounts table currently shows only accounts explicitly saved to `managed_accounts` (via manual add or the login interceptor). However, the user may already be logged into many sites in Clawdia's persistent browser (`persist:browser` partition). This spec adds **session discovery**: on every `IDENTITY_ACCOUNTS_LIST` request, the main process scans all cookies, extracts unique domains, and merges them with the managed accounts list — so sites the user is already logged into appear automatically, no action required.

Nothing is written to the database. Discovered sessions are computed fresh on each call and discarded after the IPC response is sent.

This design should reuse a shared domain-discovery helper rather than duplicating cookie-scan logic in multiple IPC handlers. `browser:list-sessions` already scans the same cookie jar; session discovery should build on the same normalization and filtering path so the two features stay aligned.

---

## Design

### Core change — extend `IDENTITY_ACCOUNTS_LIST`

The existing handler:
1. Fetches all rows from `managed_accounts`
2. For each row, checks cookies to compute `accessType` (`session` / `vault` / `managed`)
3. Returns `ManagedAccountView[]`

Extended handler:
1. Fetches all rows from `managed_accounts` — build a Set of their **normalized** `serviceName` values (apply `normalizeCookieDomain` to each `serviceName` before inserting into the Set, so `www.reddit.com` and `reddit.com` both map to the same key)
2. Get the browser session via `getBrowserSession()` — **if it returns null/undefined, skip the cookie scan and return only the managed rows**
3. Calls a shared helper such as `listSessionDomains(session)` which internally does `session.cookies.get({})`, normalizes domains, and filters noise. Per-account `accessType` computation for managed rows (checking `session.cookies.get({ domain: account.serviceName })` and `credential_vault`) is **unchanged** — the bulk cookie scan is used only for discovering new domains, not for replacing per-account access type logic.
4. Extracts unique normalized domains from the helper result
5. For domains **not already in the managed Set**, create a synthetic `ManagedAccountView` with `source: 'session'`
6. Returns the merged list: managed rows first, synthetic session rows appended

### DTO change — add `source` field

Add `source: 'managed' | 'session'` to `ManagedAccountView`:

```typescript
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
  source: 'managed' | 'session';   // NEW
  createdAt: string;
  notes: string;
}
```

For synthetic session-only rows:
- `id: 0` — **not used as a React key**; the renderer must key on `serviceName` (or `source + serviceName`) for these rows to avoid duplicate-key warnings (see Renderer change section)
- `serviceName`: normalized domain (e.g. `"protonmail.com"`)
- `loginUrl: ''`
- `username: ''`
- `emailUsed: ''`, `phoneUsed: ''`, `phoneMethod: ''`, `notes: ''`
- `status: 'active'`
- `accessType: 'session'`
- `source: 'session'`
- `createdAt: ''`

For managed rows returned from `IDENTITY_ACCOUNTS_LIST`, set `source: 'managed'`.

For consistency, `IDENTITY_ACCOUNT_ADD` should also return `source: 'managed'` in its response payload even though the current renderer reloads the list immediately after add.

### Domain normalization

```typescript
function normalizeCookieDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\./, '').replace(/^www\./, '');
}
```

Applied to `cookie.domain` for each cookie before deduplication, and to each `account.serviceName` when building the exclusion Set.

The existing per-account `accessType` cookie lookup (`session.cookies.get({ domain: account.serviceName })`) does **not** apply normalization — it uses the literal stored `serviceName`. This is intentional: the stored value was chosen by the user or the interceptor and is expected to match what Electron's cookie store recognizes. Normalization is only applied for deduplication between the two lists.

### Noise filtering

Not all cookie domains are useful accounts. Filter out:
- Domains that contain no dot (e.g. `localhost`) — check `!domain.includes('.')`
- Domains whose first label is purely numeric (e.g. `192.168.1.1`) — check `/^\d+\./.test(domain)`
- Known tracker/ad/CDN domains that are not first-party logins (static blocklist): `doubleclick.net`, `google-analytics.com`, `googleapis.com`, `gstatic.com`, `cloudflare.com`, `cloudfront.net`, `fastly.net`, `akamai.net`, `akamaihdp.net`, `amazon-adsystem.com`, `adsymptotic.com`, `scorecardresearch.com`, `quantserve.com`, `moatads.com`

This static blocklist reduces noise without requiring a separate service registry.

Implementation detail: keep the blocklist and normalization logic in the shared helper used by both `browser:list-sessions` and `IDENTITY_ACCOUNTS_LIST`, so the browser settings view and the identity settings view do not diverge over time.

### Renderer change — hide delete for session-only rows

`IdentitySection.tsx` changes required:

1. **Update the `ManagedAccountView` interface** at the top of the file — add `source: 'managed' | 'session'` to the interface declaration (without this, `acc.source` references below will be TypeScript errors).

2. **Update the table row `key` prop** to `acc.source === 'session' ? acc.serviceName : String(acc.id)` — synthetic rows share `id: 0` and would produce duplicate React keys if keyed by `id` alone.

3. **Hide the delete button** for rows where `source === 'session'` — there is no `managed_accounts` row to delete.

The current "Add account manually" form remains a global action below the table. This spec does **not** add row-level promotion, prefill, or one-click "save this session as managed" behavior.

---

## Data flow

```
IDENTITY_ACCOUNTS_LIST request
  → identityStore.listAccounts()                       // managed_accounts rows
  → for each managed row: compute accessType (unchanged — per-account cookie + vault check)
  → normalize serviceName values → build exclusion Set
  → session = getBrowserSession()
  → if session is null: return managedRows only
  → listSessionDomains(session)                        // shared helper used by browser:list-sessions too
  → filter: already in exclusion Set
  → for each remaining domain: build synthetic ManagedAccountView (source:'session')
  → return [...managedRows, ...syntheticRows]
```

---

## Files changed

| File | Change |
|------|--------|
| `src/main/main.ts` | Extract shared session-domain helper, reuse it in `browser:list-sessions`, extend `IDENTITY_ACCOUNTS_LIST`, and return `source` for account DTOs |
| `src/renderer/components/IdentitySection.tsx` | Hide delete button when `source === 'session'` |
| `tests/identity/ipc-security.test.ts` | Update DTO expectations for `source` |
| `tests/...` | Add focused tests for session-domain discovery and merged account listing |

No changes to `identity-store.ts`, `ipc-channels.ts`, or `preload.ts` are required.

---

## Testing

- Unit test the shared session-domain helper:
  - Leading dot, uppercase, and `www.` domains normalize to a single lowercase key
  - Known tracker domains (e.g. `doubleclick.net`) are excluded
  - Domains without a dot (e.g. `localhost`) are excluded
  - Numeric hosts (e.g. `192.168.1.1`) are excluded

- Unit or integration test for `IDENTITY_ACCOUNTS_LIST` merge logic:
  - Given 2 managed accounts and 5 cookie domains (2 overlap, 3 new), returns 5 rows total
  - Synthetic rows have `source: 'session'`, managed rows have `source: 'managed'`
  - Managed rows always appear before synthetic rows in the response
  - If `getBrowserSession()` is unavailable, only managed rows are returned
  - `IDENTITY_ACCOUNT_ADD` returns `source: 'managed'`

- DTO security test update:
  - `passwordPlain` is still omitted
  - `source` is present on the renderer-facing DTO

- Renderer test if the repo already has a renderer test harness; otherwise defer renderer coverage and verify via a narrow manual check:
  - Delete button is rendered for `source: 'managed'` rows
  - Delete button is hidden for `source: 'session'` rows

---

## Out of scope

- Persisting discovered sessions to `managed_accounts`
- Inferring username from cookies (cookie values are opaque)
- Deduplicating subdomains (e.g. `mail.google.com` and `accounts.google.com` both appear — grouping under `google.com` is a future enhancement)
- Auto-refreshing the accounts table when cookies change (requires cookie change listener; deferred)
- Row-level promotion UX for session-only entries
