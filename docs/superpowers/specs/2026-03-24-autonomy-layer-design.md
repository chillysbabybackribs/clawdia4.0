# Clawdia Autonomy Layer — Design Spec

**Date:** 2026-03-24
**Status:** Approved
**Scope:** Email/identity provisioning, credential vault, human-in-the-loop intervention, phone verification, proactive account preparation, scheduled autonomous tasks

---

## Overview

The Autonomy Layer gives Clawdia the ability to self-provision access to new services without user intervention — handling signup, email verification, phone verification, and credential storage as a seamless sub-flow within any task. It also adds a scheduling system for recurring autonomous work and a proactive account preparation system that gets ahead of user needs.

The foundation is a secure local identity and credential store. Everything else builds on top of it.

---

## Pre-Build Validation Gate

**The Bloodhound system (browser_playbooks) must be validated before this build begins.**

The autonomy layer depends on Bloodhound's playbook record/replay system for signup form execution. Bloodhound is the canonical name for the system; its data lives in the `browser_playbooks` SQLite table and the site harness logic lives in `src/main/browser/site-harness.ts`. If it has gaps or bugs, the provisioning flow will fail in hard-to-debug ways.

Before implementation starts:
- Audit existing playbook record/replay end-to-end on at least 3 real sites
- Verify harness storage, retrieval, and replay work correctly in `site-harness.ts`
- Identify and fix any gaps
- Only proceed to autonomy layer implementation once Bloodhound is confirmed reliable

---

## Section 1 — Identity & Credential Vault

### Purpose
Secure local storage for all identity profiles, managed accounts, and credentials Clawdia needs to operate autonomously.

### Data Model

**Identity Profiles**
- `id`, `name` (e.g. "default", "agent"), `full_name`, `email`, `username_patterns`, `date_of_birth`, `is_default`
- Default profile represents the user (real name, real info)
- Agent profiles represent Clawdia-managed personas (used only when explicitly requested)

**Account Registry**
- `id`, `service_name`, `login_url`, `username`, `email_used`, `password_encrypted`, `phone_used`, `identity_profile_id`, `status` (active/suspended/unverified), `created_at`, `notes`
- One row per service account Clawdia has created or been given access to

**Credential Vault**
- `id`, `label`, `type` (api_key/session_token/app_password/oauth_token), `service`, `value_encrypted`, `expires_at`, `created_at`

### Storage Architecture

All vault and identity tables are added to the **existing single SQLite database** (`~/.config/clawdia/data.sqlite`) as new migration versions, consistent with the established pattern in `database.ts`. This avoids introducing a second database singleton.

Encryption is handled at the application layer: sensitive fields (`password_encrypted`, `value_encrypted`) are encrypted/decrypted in `identity-store.ts` before any read/write. The database itself stores only ciphertext for these fields.

### Security
- All encrypted fields use AES-256-GCM
- Encryption key managed via Electron's built-in `safeStorage` API (`safeStorage.encryptString` / `safeStorage.decryptString`) — available in Electron 15+, requires no native addon or rebuild step, and uses the OS keychain automatically (Linux `libsecret`, macOS Keychain, Windows DPAPI). The encrypted key blob is stored in a single `keychain_blob` row in the vault table and loaded once at startup.
- Master key is never written to disk in plaintext or logged
- Clawdia never logs, streams, or displays raw credential values

### Dependency Note
No new native addons required. `safeStorage` is part of Electron's existing API surface. Do NOT use `keytar` — it is not in `package.json` and would require adding a native rebuild step to the build pipeline.

### New File
`src/main/autonomy/identity-store.ts`

### Modified Files
- `src/main/db/database.ts` — add new migration version with tables: `identity_profiles`, `managed_accounts`, `credential_vault`

---

## Section 2 — Account Provisioning Flow

### Purpose
When Clawdia needs to perform a task on a service and no account exists, it provisions one autonomously and resumes the original task.

### Flow

1. **Registry check** — before executing any service task, query the `managed_accounts` table by service name. If active account exists, proceed normally.

2. **Signup decision** — if no account exists, pause original task and enter provisioning flow. Log the decision in chat: "No account found for [service] — provisioning now."

3. **Email selection:**
   - Default (important accounts): navigate to Gmail or Yahoo in browser, use primary address or create alias
   - Low-stakes (one-time verification): call temp-mail API for throwaway address
   - Per-service override configurable in settings

4. **Identity selection:**
   - Default: user's real identity profile
   - Override: named agent persona (must be explicitly specified by user or task config)

5. **Signup execution:**
   - Navigate to signup page
   - Fill form using selected identity profile
   - Generate strong password, store immediately in vault (before submission)
   - Submit form
   - Bloodhound saves this as a new playbook entry in `browser_playbooks` via `site-harness.ts` — future signups for this service replay the playbook at near-zero token cost

6. **Verification handling** — see Section 3 (Email) and Section 4 (Phone)

7. **Registry save** — write new account record (encrypted password, email used, phone used, status: active) to `managed_accounts`

8. **Resume original task** — hand back to the original task flow with the new account active

### Failure Handling
- CAPTCHA, phone required, unexpected form → human-in-the-loop (Section 5)
- Signup page not found → surface to user with clear error, do not loop
- Email verification not received within 5 minutes → alert user, pause task

### New File
`src/main/autonomy/account-provisioner.ts`

### Implementation Note
Build account-provisioner and email-monitor (Section 3) together as a single implementation step — the provisioner is incomplete without verification handling.

---

## Section 3 — Email Verification Handling

### Purpose
Monitor an inbox mid-task to receive and act on verification emails during signup flows.

### Approach

**Persistent email (Gmail/Yahoo):**
- Clawdia navigates to the inbox in the browser panel
- Polls for new emails matching the service name / sender domain on a 15-second interval
- Extracts verification link or code from email body
- Clicks link or enters code to complete verification
- Returns to provisioning flow

**Temp-mail API:**
- On address creation, store the temp-mail session token
- Poll the temp-mail API (mail.tm or Guerrilla Mail) for incoming messages
- Extract verification link or code
- No browser navigation needed — pure API call

**Playbook annotation:**
- After first successful verification on a service, note the sender domain and subject pattern in the `browser_playbooks` entry so future verifications are found instantly

### New File
`src/main/autonomy/email-monitor.ts`

---

## Section 4 — Phone Verification Handling

### Purpose
Handle SMS verification codes required by some services during signup.

### Priority Chain

1. **Google Voice** — navigate to voice.google.com in browser (uses existing authenticated session), read SMS, extract code, enter it. Zero external dependencies.

2. **Twilio fallback** — for services that block Google Voice, use a provisioned Twilio number. Poll Twilio REST API for incoming SMS, extract code. Costs fractions of a cent per message. Twilio credentials stored in credential vault.

3. **Human-in-the-loop fallback** — if neither is available or both are blocked, pause and alert user (Section 5 pattern). User enters real number and receives code manually. Clawdia auto-resumes after code entry detected.

### Account Registry Integration
- Store which phone method was used per service in the `managed_accounts` record
- On future signups for same service, use the known-working method first

### New File
`src/main/autonomy/phone-verifier.ts`

---

## Section 5 — Human-in-the-Loop Intervention

### Purpose
When Clawdia hits a blocker it cannot resolve autonomously (CAPTCHA, unexpected form, bot detection, phone required), it pauses gracefully, alerts the user in chat, waits for manual resolution, and auto-resumes.

### Flow

1. **Pause** — freeze current task state. Browser panel stays on the exact page requiring human input.

2. **Alert in chat** — post a clear, specific message via the existing intervention system, e.g.:
   > "I hit a CAPTCHA on Reddit's signup page and can't continue automatically. The browser is paused on that page — please solve it and click Continue, then I'll pick up from here."

3. **Watch for completion** — poll the BrowserView's `webContents` from the main process using `executeJavaScript` on a short interval (e.g. 1 second), returning a boolean indicating whether the blocking element is gone or the page has advanced. This is consistent with the patterns already used in `src/main/browser/waits.ts` (`waitForSelector`, `waitForDomSettled`). Do NOT inject `ipcRenderer.send` into third-party page content — the BrowserView has no preload and `ipcRenderer` is not available there. When the poll resolves true, call `resolveHumanIntervention` in the main process to resume the task.

4. **Auto-resume** — on resolution signal, post "Got it, continuing..." in chat and resume from exact pause point. No re-navigation, no repeated steps.

5. **Playbook annotation** — note in the `browser_playbooks` entry for this service that this step required human intervention. Future runs warn proactively: "Reddit signup usually needs a CAPTCHA — I'll pause there and wait for you."

### New Intervention Types
Extend the `interventionType` union in `src/main/db/run-human-interventions.ts`:
- Add `'phone_required'` — service requires SMS verification with no automated path
- Add `'unexpected_form'` — signup form shape doesn't match known playbook

`captcha` already exists in the union and requires no change.

### Modified Files
- `src/main/agent/human-intervention-manager.ts` — handle new intervention types; add polling-based DOM resolution via `executeJavaScript` on BrowserView `webContents` (consistent with `waits.ts` patterns) that calls `resolveHumanIntervention` when the blocking element is gone
- `src/main/db/run-human-interventions.ts` — extend `interventionType` union with `'phone_required' | 'unexpected_form'`

---

## Section 6 — Proactive Account Preparation

### Purpose
Detect services the user frequently references and pre-create accounts in the background before they're needed.

### Flow

1. **Usage pattern detection** — on each conversation message save, scan the message content against a known-services allowlist (curated list of common service names: Reddit, Twitter, LinkedIn, GitHub, etc.) using regex/string matching. Increment a mention counter per service in a dedicated `service_mentions` table (`service_name TEXT PRIMARY KEY, mention_count INTEGER, last_seen TEXT`). Do NOT add this to `site_profiles` — that table is managed by `upsertSiteProfile` in `src/main/db/site-profiles.ts` which replaces the entire row on every upsert (triggered on every browser navigation), which would silently overwrite mention counts. A standalone table avoids this conflict entirely. FTS5 is not needed — it's an allowlist match, not free-form NLP.

2. **Proactive suggestion** — when a service crosses 3 mentions with no entry in `managed_accounts`, surface a non-blocking notification in chat:
   > "I've noticed you reference Reddit often but don't have an account set up. Want me to create one in the background so it's ready when you need it?"

3. **Background provisioning** — if approved (or auto-provision enabled in settings), run the full signup flow as a background task via `process-manager.ts`. Report back on completion: "Reddit account ready."

4. **Explicit batch provisioning** — user can say "pre-create accounts on these services" and Clawdia works through the list autonomously, pausing only for human-in-the-loop moments.

### New File
`src/main/autonomy/proactive-detector.ts`

### Modified Files
- `src/main/db/database.ts` — add standalone `service_mentions` table in a new migration version

---

## Section 7 — Scheduled Autonomous Tasks

### Purpose
Allow Clawdia to run jobs on a recurring basis without user initiation.

### Scope
This section covers **time-based scheduling only** for the initial build. Event-based triggers (price drops, email arrival, etc.) require persistent background watcher infrastructure that does not currently exist and would be a significant separate build. Event-based scheduling is explicitly deferred to a future spec.

### Trigger Types (Initial Build)
- **Time-based** — fixed schedule (every N minutes, daily at time X, specific day/time) using `node-cron`
- **Completion-triggered** — one task finishing automatically queues the next (account created → immediately run the original task that needed it)

### Execution

- Scheduled tasks run as background agents via the existing `process-manager.ts`
- Browser panel only surfaces for human-in-the-loop moments
- All other execution is silent and non-interrupting

### Audit Log

- Every scheduled task execution logged to a new `scheduled_task_runs` table: timestamp, task name, actions taken, success/failure
- Visible in a dedicated "Activity" panel in the UI
- Retained for 30 days — enforced by an eviction call (`evictOldScheduledTaskRuns`) registered in `task-scheduler.ts` at scheduler init time, consistent with the `evictOldRuns` pattern in `src/main/db/runs.ts`

### Guardrails

- Tasks involving spending money, sending messages to other people, or deletion require one-time explicit approval before running on a schedule
- Whitelisted tasks run fully autonomously
- All scheduled tasks can be paused, edited, or deleted at any time

### New File
`src/main/autonomy/task-scheduler.ts`

### Modified Files
- `src/main/db/database.ts` — add `scheduled_tasks` and `scheduled_task_runs` tables in a new migration version

---

## Component Summary

### New Files
| File | Purpose |
|------|---------|
| `src/main/autonomy/identity-store.ts` | Identity profiles, account registry, credential vault — encrypted R/W |
| `src/main/autonomy/account-provisioner.ts` | Full signup flow orchestration |
| `src/main/autonomy/email-monitor.ts` | Inbox polling — Gmail/Yahoo browser + temp-mail API |
| `src/main/autonomy/phone-verifier.ts` | Google Voice + Twilio SMS handling |
| `src/main/autonomy/proactive-detector.ts` | Usage pattern analysis + background provisioning suggestions |
| `src/main/autonomy/task-scheduler.ts` | Time-based cron + completion-triggered scheduling |

### Modified Files
| File | Change |
|------|--------|
| `src/main/db/database.ts` | Add migration versions: `identity_profiles`, `managed_accounts`, `credential_vault`, `service_mentions` (standalone table), `scheduled_tasks`, `scheduled_task_runs` |
| `src/main/db/run-human-interventions.ts` | Extend `interventionType` union: add `'phone_required' \| 'unexpected_form'` |
| `src/main/agent/human-intervention-manager.ts` | Add new intervention types; add MutationObserver injection + IPC resolution path for auto-resume |
| `src/main/browser/site-harness.ts` | Add intervention annotation to playbook entries; add signup harness type |
| `src/main/main.ts` | Wire autonomy module initialization |

### Integrates With (No Changes Needed)
- Bloodhound system (`browser_playbooks` table + `site-harness.ts`) — playbook record/replay for signup forms
- `process-manager.ts` — background task execution
- Browser session system — persistent `persist:browser` partition
- Existing SQLite infrastructure (`database.ts` singleton)

---

## Implementation Order

1. **Validate Bloodhound** — confirm playbook record/replay works reliably on 3+ real sites (`site-harness.ts`)
2. **DB migrations** — add all new tables in `database.ts` as new migration versions
3. **Identity store + credential vault** — `identity-store.ts` with `keytar` encryption (foundation everything else depends on)
4. **Account provisioner + email monitor** — implement together as a unit; provisioner is incomplete without verification
5. **Human-in-the-loop new types** — extend `run-human-interventions.ts` union + MutationObserver/IPC auto-resume in `human-intervention-manager.ts`
6. **Phone verifier** — Google Voice browser path first, Twilio fallback second
7. **Site-harness annotations** — intervention annotations + signup harness type in `site-harness.ts`
8. **Proactive detector** — allowlist-based mention counting + background provisioning suggestion
9. **Task scheduler** — `node-cron` time-based + completion-triggered scheduling
10. **UI: Activity panel** — scheduled task visibility
11. **End-to-end test** — full signup flow on 3 real services covering: happy path, CAPTCHA intervention, phone verification

---

## Out of Scope (Future)
- Event-based scheduling (price monitoring, email triggers) — requires separate background watcher infrastructure
- Multi-user identity management
- OAuth/SSO flows (handled separately by existing browser session system)
- Account health monitoring (detecting bans/suspensions)
- Proxy/IP rotation for account creation at scale
