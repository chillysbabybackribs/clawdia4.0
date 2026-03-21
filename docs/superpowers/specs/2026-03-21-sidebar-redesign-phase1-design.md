# Sidebar Redesign — Phase 1: Icon Rail + Functional Drawers

**Date:** 2026-03-21
**Status:** Approved
**Phase:** 1 of 2 (Phase 2 = Monaco editor integration)

---

## Problem

The current sidebar is a passive list — it shows conversation history and running processes, but communicates nothing about what Clawdia can actually do. The app has major differentiators (multi-agent parallel execution, full desktop control, authenticated browser sessions requiring no API keys, complete filesystem access) that are completely invisible to the user. The sidebar wastes its persistent real estate on a narrow list when it could be a functional control surface that also teaches the product.

---

## Solution

Replace the current `Sidebar.tsx` with a two-part structure:

1. **Icon Rail** (48px wide) — vertical strip of mode icons, always visible
2. **Context Drawer** (~210px wide) — swaps content based on which rail icon is active

The drawer is not a help panel. It is a live, functional control surface for each capability domain, with "Try asking" examples as secondary content below the functional UI.

Total sidebar width: **258px** expanded (rail + drawer), collapsing to **48px** (rail only) when the drawer is toggled or a collapse gesture is used.

---

## Layout

```
┌─────────┬──────────────────┬──────────────────────┬───────────────────┐
│  Rail   │  Context Drawer  │     Chat Panel       │  Browser Panel    │
│  48px   │     210px        │      flex-1          │     flex-1.8      │
└─────────┴──────────────────┴──────────────────────┴───────────────────┘
```

The browser panel continues to work as before. The drawer replaces the old sidebar. No other panels change in Phase 1.

---

## Icon Rail

**Width:** 48px
**Background:** `#0a0a12`
**Border-right:** `1px solid #141420`

### Icons (top to bottom)

| Position | Icon | Mode | Tooltip |
|---|---|---|---|
| Top | C logo mark | — | — (brand, not clickable as nav) |
| Separator | — | — | — |
| 1 | Chat bubble | `chat` | Conversations |
| 2 | Lightning bolt | `agents` | Agents |
| 3 | Globe | `browser` | Browser Sessions |
| 4 | Folder | `files` | Files |
| 5 | Monitor | `desktop` | Desktop |
| Bottom | Gear | `settings` | Settings |

**Active state:** `background: #161624`, left-edge accent bar `2px solid #FF5061`, icon color `#ddd`
**Inactive state:** icon color `#333`, hover → `#666` with `background: #111120`
**Settings** opens the existing `SettingsView` (same behavior as current `Ctrl+,`).

### Behavior
- Clicking an active icon collapses the drawer (toggle)
- Clicking an inactive icon switches drawer content and expands if collapsed
- `Ctrl+S` continues to toggle drawer open/closed (same shortcut, new behavior)
- Default active icon on launch: `chat`

---

## Context Drawer

**Width:** 210px
**Background:** `#0c0c16`
**Border-right:** `1px solid #141420`

Each drawer has:
1. A **header** with title and optional action button
2. An optional **search input**
3. A **scrollable body** with live functional content
4. Optional **secondary section** — "Try asking" examples (text chips, not interactive in Phase 1)

---

### Chat Drawer

**Purpose:** Conversation history and active session management.

**Header:** "Conversations" + "+ New" button (accent-bordered, calls `onNewChat`)

**Search:** filters both active processes and history simultaneously (existing behavior, preserved)

**Body — Active section:**
- Lists processes with status `running | awaiting_approval | needs_human`
- Each row: colored status dot + summary text (truncated) + elapsed time + optional cancel arrow for `needs_human`
- Clicking a row attaches to that process (existing `process.attach()` behavior)

**Body — History section:**
- Conversation list, all entries (not capped at 3 like current)
- Each row: small dot + title (truncated) + relative time
- Clicking loads conversation (existing `onLoadConversation` behavior)
- Hover reveals delete button (×)
- Search filters this list

**No "Recently Completed" section** — completed processes are surfaced in the Agents drawer instead.

---

### Agents Drawer

**Purpose:** Live multi-agent control surface. Makes parallel execution visible and manageable.

**Header:** "Agents" + "+ Spawn" button

**New Agent button:** full-width accent button below header

**Body — Running section:**
- All processes with status `running | awaiting_approval | needs_human`
- Each row: status dot (red=running, amber=awaiting/needs_human) + summary + profile badge + elapsed time + tool count + ✕ cancel button
- `needs_human` rows show → arrow instead of ✕, clicking opens process detail
- `awaiting_approval` rows show inline Approve/Deny

**Body — Profiles section:**
- Static list of slash commands with one-line descriptions:
  - `/bloodhound` — web automation
  - `/filesystem` — file operations
  - `/extractor` — download media
  - `/general` — full capabilities
- Clicking a row prefills the chat input with the slash command

**Body — Completed Today section:**
- Processes completed in the last 5 hours (same `RECENT_COMPLETED_MAX_AGE_MS` constant)
- Muted styling, no actions

**Stats bar** (pinned to drawer bottom):
- 3 cells: Running count / Today count / Total count
- Pulls from `processes` state and `conversations` state

---

### Browser Drawer

**Purpose:** Expose and manage the authenticated session store — the app's biggest differentiator.

**Header:** "Browser Sessions"

**Search:** filters domain list

**Body — Active Sessions section:**
- Reads all domains with cookies from the Electron session cookie store via a new IPC call: `browser.listSessions()` → `string[]` (domain list)
- Each row: favicon (letter fallback) + domain name + "● Session active" status + "Clear" button
- "Clear" button calls `browser.clearSession(domain)` which clears all cookies for that domain
- List is read on drawer mount and refreshed when drawer becomes active
- Empty state: "No active sessions. Browse a site to create a session."

**Secondary section — note:**
- Small muted text: "Claude uses your existing sessions automatically. No API keys required."

**No credential management, no blocking, no adding credentials** — out of scope for Phase 1.

---

### Files Drawer

**Purpose:** Live, navigable filesystem tree. No file preview or Monaco in Phase 1.

**Header:** "Files"

**Search:** filters visible file/folder names

**Body — Pinned section:**
- Static pinned locations: Home (`~/`), Desktop (`~/Desktop`), Downloads (`~/Downloads`)
- Clicking a pinned location sets it as the tree root

**Body — Tree section:**
- Starts at user home directory (`~/`) by default
- Reads directory contents via a new IPC call: `fs.readDir(path)` → `{ name, type, path }[]`
- Folders are collapsible (click to expand/collapse, lazy-load children)
- Files show extension as a muted label
- Clicking a file in Phase 1: **attaches it to the current chat as context** (calls `onAddContext` with file path, the agent reads it via its existing `file_read` tool)
- Currently open/active file highlighted with accent left-border
- Back navigation: breadcrumb or back arrow at top of tree

**No file preview, no Monaco, no system default app open** — Phase 2.

---

### Desktop Drawer

**Purpose:** Live view of running GUI applications with basic controls.

**Header:** "Desktop"

**Body — Running Apps section:**
- Reads running GUI applications via a new IPC call: `desktop.listApps()` → `{ name, pid, memoryMB, icon? }[]`
- Implementation: shell command (`wmctrl -l` + `ps` on Linux, filtered to windowed apps)
- Each row: app icon (emoji fallback) + app name + PID + memory usage + Focus (↗) button + Kill (✕) button
- Focus button: brings app window to front via `wmctrl -ia <window_id>` or `app_control` tool
- Kill button: sends SIGTERM via `kill <pid>` — no confirmation dialog in Phase 1 (it's a power-user action)
- Refreshes every 5 seconds while drawer is active

**Body — System section:**
- CPU usage % (reads from `/proc/stat` or `top -bn1`)
- RAM used / total (reads from `/proc/meminfo`)
- Simple progress bars, updates every 5 seconds alongside app list

**Secondary section — "Try asking":**
- 2-3 static example prompts relevant to desktop control
- Non-interactive in Phase 1 (no prefill behavior)

---

## New IPC Calls Required

| Call | Direction | Description |
|---|---|---|
| `browser.listSessions()` | renderer → main | Returns `string[]` of domains with active cookies in Electron session |
| `browser.clearSession(domain: string)` | renderer → main | Clears all cookies for the given domain |
| `fs.readDir(path: string)` | renderer → main | Returns `{ name: string, type: 'file' \| 'dir', path: string }[]` |
| `desktop.listApps()` | renderer → main | Returns `{ name: string, pid: number, memoryMB: number }[]` from wmctrl/ps |
| `desktop.focusApp(pid: number)` | renderer → main | Brings app window to foreground |
| `desktop.killApp(pid: number)` | renderer → main | Sends SIGTERM to process |

All new IPC channels follow the existing pattern in `src/shared/ipc-channels.ts` and `src/main/preload.ts`.

---

## Components

### New / Replaced

| Component | Action | Description |
|---|---|---|
| `src/renderer/components/Sidebar.tsx` | **Replace entirely** | New rail + drawer shell |
| `src/renderer/components/sidebar/Rail.tsx` | **Create** | Icon rail, 48px |
| `src/renderer/components/sidebar/drawers/ChatDrawer.tsx` | **Create** | History + active sessions |
| `src/renderer/components/sidebar/drawers/AgentsDrawer.tsx` | **Create** | Live processes + profiles |
| `src/renderer/components/sidebar/drawers/BrowserDrawer.tsx` | **Create** | Cookie session manager |
| `src/renderer/components/sidebar/drawers/FilesDrawer.tsx` | **Create** | File tree |
| `src/renderer/components/sidebar/drawers/DesktopDrawer.tsx` | **Create** | Running apps + system stats |

### Unchanged
- `App.tsx` — `Sidebar` props interface changes minimally (drop `collapsed`/`onToggleCollapse`, add `activeDrawer` state internally)
- `ChatPanel.tsx` — no changes
- `BrowserPanel.tsx` — no changes
- `InputBar.tsx` — no changes
- All other panels — no changes

---

## Data Flow

```
App.tsx
  └── Sidebar.tsx (new)
        ├── Rail.tsx
        │     └── emits: onModeChange(mode: DrawerMode)
        └── [ActiveDrawer].tsx
              ├── ChatDrawer    → uses: api.chat.list(), api.process.list(), api.process.onListChanged()
              ├── AgentsDrawer  → uses: api.process.list(), api.process.onListChanged(), api.process.cancel()
              ├── BrowserDrawer → uses: api.browser.listSessions(), api.browser.clearSession()
              ├── FilesDrawer   → uses: api.fs.readDir()
              └── DesktopDrawer → uses: api.desktop.listApps(), api.desktop.focusApp(), api.desktop.killApp()
```

Active drawer mode is local state inside `Sidebar.tsx`. `App.tsx` does not need to know which drawer is open.

---

## What Does NOT Change in Phase 1

- Monaco editor — Phase 2
- File preview of any kind — Phase 2
- Calendar panel — unchanged
- Browser panel — unchanged
- ChatPanel — unchanged
- InputBar — unchanged
- WelcomeScreen — unchanged
- ProcessesPanel — unchanged (still reachable from Agents drawer via row click)
- ConversationsView — unchanged (still reachable via `Ctrl+H`)
- Keyboard shortcuts (except `Ctrl+S` now toggles drawer instead of sidebar collapse)

---

## Design Tokens (unchanged from existing)

- Accent: `#FF5061`
- Surface 0: `#0a0a12` (rail), `#0c0c16` (drawer)
- Border: `#141420`
- Text primary: `#ddd`
- Text secondary: `#666`
- Text muted: `#333`
- Running dot: `#FF5061` with glow
- Waiting dot: `#e8a020` with glow
- Done dot: `#3a6644`

---

## Out of Scope (Phase 2)

- Monaco editor panel replacing browser on file click
- File context auto-injection into agent on open
- File editing / saving from within Clawdia
- Session credential storage
- Site blocking
- Desktop app icon resolution beyond emoji fallback
- Drag-and-drop file attachment from file tree to chat
