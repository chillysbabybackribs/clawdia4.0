# Session Discovery — Design Spec

**Date:** 2026-03-24
**Status:** Draft
**Scope:** Auto-populate the Identity Accounts table from existing browser session cookies

---

## Overview

The Identity Accounts table currently shows only accounts explicitly saved to `managed_accounts` (via manual add or the login interceptor). However, the user may already be logged into many sites in Clawdia's persistent browser (`persist:browser` partition). This spec adds **session discovery**: on every `IDENTITY_ACCOUNTS_LIST` request, the main process scans all cookies, extracts unique domains, and merges them with the managed accounts list — so sites the user is already logged into appear automatically, no action required.

Nothing is written to the database. Discovered sessions are computed fresh on each call and discarded after the IPC response is sent.

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
3. Calls `session.cookies.get({})` — get all cookies. Per-account `accessType` computation for managed rows (checking `session.cookies.get({ domain: account.serviceName })` and `credential_vault`) is **unchanged** — the bulk `cookies.get({})` call is used only for discovering new domains, not for replacing per-account access type logic.
4. Extracts unique normalized domains from cookie `.domain` field (apply `normalizeCookieDomain`)
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

### Domain normalization

```typescript
function normalizeCookieDomain(domain: string): string {
  return domain.replace(/^\./, '').replace(/^www\./, '');
}
```

Applied to `cookie.domain` for each cookie before deduplication.

### Noise filtering

Not all cookie domains are useful accounts. Filter out:
- Domains that contain no dot (e.g. `localhost`) — check `!domain.includes('.')`
- Domains whose first label is purely numeric (e.g. `192.168.1.1`) — check `/^\d+\./.test(domain)`
- Known tracker/ad/CDN domains that are not first-party logins (static blocklist): `doubleclick.net`, `google-analytics.com`, `googleapis.com`, `gstatic.com`, `cloudflare.com`, `cloudfront.net`, `fastly.net`, `akamai.net`, `akamaihdp.net`, `amazon-adsystem.com`, `adsymptotic.com`, `scorecardresearch.com`, `quantserve.com`, `moatads.com`

This static blocklist reduces noise without requiring a separate service registry.

### Renderer change — hide delete for session-only rows

`IdentitySection.tsx` already renders a delete button per row. For rows where `source === 'session'`, hide the delete button (there is no `managed_accounts` row to delete).

The table row `key` prop must be updated to use `acc.source === 'session' ? acc.serviceName : String(acc.id)` — synthetic rows share `id: 0` and would produce duplicate React keys if keyed by `id` alone.

The "Add Account" inline form remains available for all rows — the user can promote a session-only entry to a managed account by filling in credentials.

---

## Data flow

```
IDENTITY_ACCOUNTS_LIST request
  → identityStore.listAccounts()                       // managed_accounts rows
  → for each managed row: compute accessType (unchanged — per-account cookie + vault check)
  → normalize serviceName values → build exclusion Set
  → session = getBrowserSession()
  → if session is null: return managedRows only
  → session.cookies.get({})                            // all cookies for domain discovery
  → normalize cookie domains
  → filter: no dot, numeric IP, blocklist domains
  → filter: already in exclusion Set
  → for each remaining domain: build synthetic ManagedAccountView (source:'session')
  → return [...managedRows, ...syntheticRows]
```

---

## Files changed

| File | Change |
|------|--------|
| `src/main/main.ts` | Extend `IDENTITY_ACCOUNTS_LIST` handler to merge synthetic session rows |
| `src/renderer/components/IdentitySection.tsx` | Hide delete button when `source === 'session'` |

No changes to `identity-store.ts`, `ipc-channels.ts`, or `preload.ts`.

---

## Testing

- Unit test for `IDENTITY_ACCOUNTS_LIST` handler:
  - Given 2 managed accounts and 5 cookie domains (2 overlap, 3 new), returns 5 rows total
  - Synthetic rows have `source: 'session'`, managed rows have `source: 'managed'`
  - Known tracker domains (e.g. `doubleclick.net`) are excluded from results
  - Domains without a dot (e.g. `localhost`) are excluded
  - Managed rows always appear before synthetic rows in the response

- Renderer test:
  - Delete button is rendered for `source: 'managed'` rows
  - Delete button is hidden for `source: 'session'` rows

---

## Out of scope

- Persisting discovered sessions to `managed_accounts`
- Inferring username from cookies (cookie values are opaque)
- Deduplicating subdomains (e.g. `mail.google.com` and `accounts.google.com` both appear — grouping under `google.com` is a future enhancement)
- Auto-refreshing the accounts table when cookies change (requires cookie change listener; deferred)
