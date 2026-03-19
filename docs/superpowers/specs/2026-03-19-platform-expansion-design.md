# Clawdia Platform Expansion — Design Spec

**Date:** 2026-03-19
**Status:** Approved for planning
**Author:** dp + Claude

---

## Overview

Clawdia 4.0 is a fully local, session-native, full-OS AI automation agent for Linux. This spec defines a platform expansion across six subsystems that together transform Clawdia from a desktop-only tool into a remotely accessible, mobile-aware platform — while preserving its core architectural advantages: local execution, authenticated browser sessions, complete OS access, and user privacy.

---

## Competitive Context

Clawdia's primary differentiators vs. the field (Open Interpreter, Claude Computer Use, OpenAI Operator, Google Mariner, Manus, Browser Use):

1. **Authenticated browser session** — rides the user's real cookies/session, never blocked by anti-bot systems. No competitor matches this.
2. **Fully local execution** — no screenshots transmitted to cloud, no cloud VM, no data-center IP addresses.
3. **Complete OS control** — shell, files, every desktop app via CLI-Anything/a11y/DBus/GUI. Not browser-only, not Mac-only.
4. **CLI-Anything harness auto-generation** — structured deterministic app control, not coordinate-clicking.
5. **Linux-native** — the only serious AI agent targeting Linux desktop as a first-class platform.

---

## Subsystems

### A. Async Runs + Background Autonomy

**What:** Tasks run in the background without requiring the user to keep the chat window focused. The agent works autonomously and notifies the user on completion, failure, or when approval is needed.

**Current state and migration path:**

The DB already has `runs`, `run_events`, `run_changes`, and `run_approvals` tables (migration v12). The `process-manager.ts` module already provides `registerProcess`, `detachCurrent`, `attachTo`, and `routeEvent`. In `main.ts`, `registerProcess` returns a `processId` that is currently passed directly as `runId` to `runAgentLoop` — these two ID spaces are conflated.

**ID unification decision:** `processId` and `runId` are unified into a single `runId` (UUID). `process-manager.ts` is refactored to use `runId` as its key. The `runs` table `id` column IS the process key. No separate process ID concept survives.

**DB schema migration (v13):**
- Add `pending` to the `status` CHECK constraint on the `runs` table: `CHECK(status IN ('pending','running','awaiting_approval','completed','failed','cancelled'))`
- The sequential queue uses `pending` status for runs waiting to execute

**Run lifecycle:**
1. `chat:send` IPC creates a run record with status `pending`
2. Queue runner picks it up, sets status `running`, starts agent loop
3. Loop runs entirely in main process — IPC events stream to renderer but loop does not depend on IPC connection staying alive
4. On tool call requiring approval: loop calls `requestApproval(runId, action)` → status → `awaiting_approval` → loop suspends via existing `waitIfPaused` mechanism → emits IPC event + desktop notification
5. On approval resolution (approve/reject from UI or PWA): loop resumes or aborts
6. On completion: status → `completed` or `failed`, desktop notification fired

**Approval interrupt contract (tool executor → loop → UI):**
- Tool executors that require approval call a shared `needsApproval(runId, actionDesc, riskLevel)` async function before executing
- `needsApproval` writes an `approval_request` to `run_approvals` table, sets run status to `awaiting_approval`, calls `pause()` on the run's cancel controller, then awaits resolution
- Resolution comes via IPC from renderer: `approvals:resolve` with `{ runId, approved: boolean }`
- `needsApproval` resolves with `true` (approved) or `false` (rejected) — executor proceeds or throws `ApprovalRejected`
- UI receives `run:awaiting_approval` IPC event with `{ runId, actionDesc, riskLevel }` → shows approval modal

**Approval policy (default):**
- Destructive filesystem ops outside workspace → require approval
- `git push` → require approval
- Package installs (apt, pip, npm, flatpak) → require approval
- External API calls that post/purchase/modify accounts → require approval
- All others → auto-approve

**UI:**
- Run status indicator in sidebar (running spinner, completed checkmark, approval badge)
- Approval modal: shows the pending action, risk level, Approve/Reject buttons
- Run detail view: timeline of events, file diffs, command outputs, browser actions

---

### B. PWA Mobile Interface

**What:** A Progressive Web App installable on any phone that gives the user a live window into their Clawdia instance — run timelines, task input, approval actions, file previews, conversation history.

**Local HTTPS server (Electron main process):**
- Express server bound to `127.0.0.1` on a fixed port stored in Electron store (default: `47821`, configurable)
- TLS: `mkcert` generates a local CA + cert at first launch; cert stored in `~/.config/clawdia/tls/`. mkcert installs the CA into the system trust store so Chrome/Firefox trust it without warnings
- Port conflicts: if `47821` is taken, increment until a free port is found; persist the chosen port
- CORS: only allow the PWA's own origin (the Cloudflare-hosted PWA URL, set at build time) + `localhost` for dev. All other origins rejected.
- WebSocket endpoint at `wss://localhost:47821/ws` — streams run events to connected clients

**Remote access (away from home network):**
- A Cloudflare Worker (`clawdia-relay`) acts as a WebSocket proxy/relay
- Clawdia desktop maintains a persistent outbound WebSocket to the Worker, authenticated by HMAC of `instanceId + timestamp` using a relay secret derived from the Anthropic API key
- PWA connects to the Worker, which identifies the target instance by `instanceId` (stored in PWA at pairing time) and pipes the WebSocket frames
- The Worker sees encrypted WebSocket frames only — message content is end-to-end encrypted between desktop and PWA using a shared key derived from the pairing token (XChaCha20-Poly1305)
- OTP emails are sent by the Cloudflare Worker (see Subsystem C) — the Worker therefore does see the user's registered email address. This is acceptable: the Worker is Clawdia-operated infrastructure, not a third party, and the email is required for auth delivery. This is documented in the privacy policy.

**PWA capabilities:**
- View active and recent runs with live event timeline
- Submit new tasks (text input)
- Approve/reject pending approval checkpoints
- View file diffs and command output
- View conversation history
- Start/end remote sessions
- Push notifications for run completion, approval requests, alerts

**Push notifications:**
- Desktop generates VAPID key pair at first launch, stores in Electron store
- PWA calls `pushManager.subscribe({ applicationServerKey: vapidPublicKey })` — returns a push subscription endpoint (browser's push service, e.g., FCM for Chrome)
- PWA sends subscription to desktop via the local/relay WebSocket at pairing time; desktop stores it in Electron store
- To send a push: desktop makes an outbound HTTPS POST to the subscription endpoint with a VAPID-signed payload — this is a direct internet call from the desktop, not through the relay
- Push payload: `{ type, runId, message }` — minimal, no sensitive data in push body

**Pairing flow:**
1. User enables Mobile Access in Clawdia settings
2. Clawdia generates: `instanceId` (UUID), `pairingToken` (32 random bytes, base64url), QR code encoding `{ instanceId, pairingToken, localServerUrl, vapidPublicKey }`
3. User scans QR code — PWA loads from Cloudflare Pages (static hosting)
4. PWA stores `{ instanceId, pairingToken, vapidPublicKey }` in IndexedDB
5. PWA prompts push notification permission, subscribes, sends subscription to desktop
6. User taps "Add to Home Screen"

**Pairing token revocation:**
- User can "Unpair all devices" in Clawdia settings — generates a new `instanceId` + `pairingToken`, invalidates all existing PWA sessions
- Lost/stolen phone: user unpairs from desktop, re-pairs with new device

**Tech stack:**
- React + Vite PWA (Workbox service worker), hosted on Cloudflare Pages
- WebSocket for real-time events (local or via relay)
- Web Push API for notifications (VAPID)
- Cloudflare Workers (free tier) for relay + OTP email dispatch

---

### C. Secure Remote Session

**What:** A hardened authentication system that controls when remote access is active, proves user identity before granting access, and protects the physical machine when a remote session is running.

**Auth flow:**
1. User taps "Start Session" in PWA
2. PWA sends `session:start` to desktop via relay WebSocket (authenticated by pairing token)
3. Cloudflare Worker sends 6-digit OTP to user's registered email via Resend API (free tier: 3,000 emails/month). The Worker holds the OTP in KV store with a 10-minute TTL keyed by `instanceId`
4. User enters OTP in PWA; PWA sends it to Worker for verification
5. Worker verifies OTP against KV store, deletes it on match, signals desktop: "OTP verified"
6. Desktop prompts: "Enter your PIN" — PWA shows PIN entry screen
7. User enters 4-6 digit PIN; PWA sends to desktop (encrypted via pairing-derived key)
8. Desktop verifies PIN against bcrypt hash in Electron store
9. Desktop issues a session token (32 random bytes, base64url), stores it with expiry in Electron store, sends to PWA
10. PWA stores session token in IndexedDB; all subsequent requests carry it

**Session token properties:**
- Format: 32 random bytes, base64url encoded
- Storage: PWA stores in IndexedDB (not localStorage — more secure, not accessible via XSS)
- Expiry: configurable (default 8 hours), enforced by desktop on every request
- Mid-session expiry: desktop sends `session:expired` event via WebSocket → PWA shows re-auth screen
- Revocation: "End Session" from either end deletes token from desktop Electron store immediately

**Desktop security when session is active:**

Lock mechanism with fallback chain:
1. Try `loginctl lock-session` (systemd/logind — works on X11 and most Wayland compositors)
2. If exit code ≠ 0, try `xdg-screensaver lock` (X11 fallback)
3. If exit code ≠ 0, try `dbus-send --session --dest=org.gnome.ScreenSaver ... Lock` (GNOME fallback)
4. If all fail: session start is **blocked** — desktop returns error to PWA: "Cannot lock desktop. Remote session requires screen lock. Check your display manager supports loginctl or xdg-screensaver."
5. Lock success is verified by checking if the screensaver/lock is active (`loginctl show-session` or polling `xdg-screensaver status`) before confirming session start to PWA

Additional protections:
- Clawdia UI shows "Remote Session Active — [End Session]" lock overlay locally
- Physical activity detection: `xinput` event monitoring detects mouse/keyboard input; if detected while session active → PWA receives `physical_activity_detected` alert
- Inactivity timeout: if no commands received for configurable duration (default 15 min), session auto-terminates + desktop locks

**Session kill switch:**
- PWA home screen always shows "End Session" button regardless of current view
- Desktop "End Session" button visible on the local lock overlay
- Ending a session also terminates any active WebRTC call

**Security model:**
- Layer 1: Possession — phone with PWA + pairing token (stored in IndexedDB, not synced to cloud)
- Layer 2: Knowledge — email OTP (proves identity anchor; email is not stored on device)
- Layer 3: Knowledge — PIN/password (proves intentional session start; stored as bcrypt hash only)
- Layer 4: Physical protection — desktop locks before session is confirmed
- Layer 5: Activity alerts — physical presence detection via xinput

---

### D. Voice Interface (WebRTC)

**What:** Native voice calling between the PWA and the Electron desktop app, with zero third-party telephony. No Twilio, no phone numbers, no per-minute cost. The user speaks to Clawdia from their phone; Clawdia listens, acts, and responds — all audio stays in the encrypted peer-to-peer stream.

**Architecture:**

Both the PWA (mobile browser) and Electron app (Chromium under the hood) are WebRTC-capable. The Cloudflare Worker already brokering the WebSocket relay is extended to also handle WebRTC signaling (SDP offer/answer + ICE candidate exchange). Once the handshake completes, the Worker steps aside — audio flows peer-to-peer, encrypted, directly between phone and desktop.

**Call flow:**
1. User taps "Call" in PWA (only available during an active session)
2. PWA creates a WebRTC `RTCPeerConnection`, generates SDP offer, sends to desktop via relay WebSocket
3. Desktop accepts, sends SDP answer back through relay
4. ICE candidates exchanged through relay until a direct peer-to-peer path is established
5. Audio stream opens — phone microphone → desktop; desktop TTS audio → phone speaker only
6. Desktop receives audio stream, pipes to STT (whisper.cpp running locally — included in v1 for voice)
7. Transcribed text processed as a task by the agent loop
8. Clawdia narrates progress and results via TTS (local TTS: Piper, fast and offline)
9. TTS audio sent back through WebRTC audio track to phone speaker only — desktop is silent

**Audio routing — desktop is silent:**
- Remote user hears Clawdia through their phone speaker only
- Desktop speakers are muted for the WebRTC audio track
- Desktop shows visual session active screen + live task progress
- Anyone physically at the desktop sees what's happening but hears nothing

**STT/TTS (local, no cloud):**
- STT: `whisper.cpp` (C++ port of OpenAI Whisper, runs locally, ~150MB model for good accuracy)
- TTS: `Piper` (fast local neural TTS, ~50MB model, natural voice quality)
- Both run as child processes spawned by the Electron main process
- First launch: models downloaded once to `~/.config/clawdia/models/`

**Call UX:**
- PWA shows a call screen: waveform animation while Clawdia is listening, spinner while processing, waveform while Clawdia is speaking
- User can speak follow-up commands without hanging up — call stays live for multi-step tasks
- "End Call" button always visible
- Text input still available during a call — user can switch between voice and text mid-session

**Tech stack:**
- WebRTC (native browser API in PWA + Electron's Chromium)
- Cloudflare Worker extended for SDP/ICE signaling (adds ~20 lines to existing relay Worker)
- whisper.cpp for local STT
- Piper for local TTS
- No Twilio, no phone number, no external telephony provider

---

### E. Harness Library

**What:** A two-phase system for CLI-Anything harness sharing. Phase 1: personal sync across machines. Phase 2: community registry.

**Phase 1 — Personal Sync:**
- Harnesses stored in `~/.config/clawdia/harnesses/`
- Sync target: user's private GitHub repo (Clawdia creates it via GitHub API on first sync setup, or user provides an existing repo URL)
- On harness install/update: `git add . && git commit && git push` to sync repo (via `simple-git` npm package in main process)
- On new machine setup: clone sync repo, run `pip install` for each harness, register in `app_registry`
- No daemon needed — sync happens on each harness change event

**Phase 2 — Community Registry:**
- GitHub org `clawdia-harnesses` hosts one repo per app
- Standard repo structure: `harness.json` (metadata), `harness.py` (CLI-Anything plugin), `README.md`
- Clawdia in-app harness browser: search (via Cloudflare Worker + KV index), preview, one-click install
- `clawdia harness` CLI: `search`, `install`, `publish`, `update`
- Registry index maintained in Cloudflare KV (updated by GitHub Actions on PR merge)
- Harness ratings: GitHub stars on the harness repo
- Install counts: tracked in Cloudflare KV, incremented on each `clawdia harness install`

**Registry governance:**
- Open submission via PR to `clawdia-harnesses/registry`
- Automated safety check: GitHub Actions runs the harness in a Docker container with the target app installed, executes a standard test suite (defined in `harness.json` `test_commands` field), must pass before merge
- Verified badge: harnesses maintained by app vendors or Clawdia team, reviewed manually

**Harness metadata schema:**
```json
{
  "name": "gimp",
  "displayName": "GIMP",
  "version": "1.0.0",
  "author": "dp",
  "description": "Image editing via Script-Fu batch API",
  "tested_versions": ["2.10", "3.0"],
  "capabilities": ["image_edit", "export", "batch_process"],
  "install": "pip install cli-anything-gimp",
  "requires": ["gimp"],
  "test_commands": ["cli-anything gimp --test"],
  "stars": 0,
  "installs": 0
}
```

---

### F. Playbook Surfacing

**What:** Surface the existing `browser_playbooks` table as a usable feature.

**Current state:** `browser_playbooks` table has `domain`, `task`, `steps` (JSON), `success_count`, `fail_count`. `loop.ts` already calls `savePlaybook` after successful browser tasks with 2+ tool calls (line 491). No UI exists.

**Recording behavior (clarified):**
- Automatic recording is already happening via `savePlaybook` — this is not new behavior
- "Record mode" in the UI is a toggle that makes recording explicit and visible to the user, not a different code path
- Conflict resolution: if `(domain, task)` already exists, the new steps REPLACE the existing steps (not append) — the DB has a UNIQUE constraint on `(domain, task)`, so this is an UPSERT

**UI design:**
- Playbooks section in sidebar, grouped by domain
- Each playbook shows: task description, domain, success rate (`success_count / (success_count + fail_count)`), last run timestamp
- "Run" button: sends the playbook task as a new chat message (Clawdia re-executes via normal loop, not step-replay)
- "Edit" button: opens JSON editor for the steps array (advanced users)
- "Delete" button: removes from DB
- Export: download as `.clawdia-playbook.json`
- Import: drag-and-drop or file picker, validates schema before inserting

---

## Build Order

1. **Async Runs** (Subsystem A) — unifies processId/runId, adds `pending` status, defines approval interrupt contract. Foundation for everything.
2. **PWA + Local Server + Cloudflare Worker** (Subsystems B + relay) — built together; Worker is needed for remote PWA access and OTP email from day one
3. **Secure Remote Session** (Subsystem C) — auth layer on top of PWA + Worker
4. **Voice Interface** (Subsystem D) — WebRTC peer connection via existing relay Worker + local whisper.cpp STT + Piper TTS
5. **Playbook Surfacing** (Subsystem F) — self-contained UI, can be built in parallel after step 1
6. **Harness Library Phase 1** (Subsystem E) — personal sync, self-contained
7. **Harness Library Phase 2** (Subsystem E) — community registry, requires external GitHub org + Worker KV setup

---

## Non-Goals (v1)

- Concurrent runs (v1 is sequential queue)
- Cloud STT/TTS — voice is fully local (whisper.cpp + Piper)
- Telephony / phone numbers / SMS — voice is WebRTC only
- Self-hosted relay alternative
- Windows/Mac support (Linux only)
- Native mobile app (PWA only)
- Wake-on-LAN (v2)
- Multi-device pairing (v2 — one PWA per Clawdia instance in v1)

---

## Infrastructure Summary

| Component | Technology | Cost | Operated by |
|---|---|---|---|
| Relay WebSocket + WebRTC signaling | Cloudflare Worker | Free (100k req/day) | Clawdia |
| OTP email | Resend API via Worker | Free (3k/month) | Clawdia |
| Push notification routing | Browser push services (FCM etc.) | Free | Browser vendor |
| PWA hosting | Cloudflare Pages | Free | Clawdia |
| Registry index | Cloudflare KV | Free (100k reads/day) | Clawdia |
| Harness safety CI | GitHub Actions | Free (public repos) | Clawdia |
| Voice (STT) | whisper.cpp (local) | Free | Local (user's machine) |
| Voice (TTS) | Piper (local) | Free | Local (user's machine) |
| Voice transport | WebRTC peer-to-peer | Free | Peer-to-peer (no server) |
| TLS cert | mkcert (local CA) | Free | Local (user's machine) |
