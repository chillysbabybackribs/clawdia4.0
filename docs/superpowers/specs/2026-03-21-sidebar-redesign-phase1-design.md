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
- `Ctrl+S` toggles the drawer open/closed. **Implementation:** remove `sidebarCollapsed` state and the `Ctrl+S` handler from `App.tsx`. The new `Sidebar.tsx` registers its own `keydown` listener for `Ctrl+S` and manages drawer-open state internally. `App.tsx` no longer passes `collapsed` or `onToggleCollapse` to `Sidebar`.
- Gear icon click calls `onViewChange('settings')` — this prop is retained from the current interface so `App.tsx` can render `SettingsView` as before.
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
  - `/ytdlp` — download media
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
- Clicking a file in Phase 1: **attaches it to the current chat as context** via a new IPC call `fs.readFile(path: string) → string` (reads file content on the main side, returns text). The renderer then calls `api.chat.addContext(content)` with the file text. This requires `fs.readFile` to be added to the IPC table, preload bridge, and main handler. Files larger than 100KB show a warning before attaching.
- Currently open/active file highlighted with accent left-border
- Back navigation: breadcrumb or back arrow at top of tree

**No file preview, no Monaco, no system default app open** — Phase 2.

---

### Desktop Drawer

**Purpose:** Live view of running GUI applications with basic controls.

**Header:** "Desktop"

**Body — Running Apps section:**
- Reads running GUI applications via a new IPC call: `desktop.listApps()` → `{ name: string, pid: number, windowId: string, memoryMB: number }[]`
- **Linux implementation:** `wmctrl -lp` (returns window ID + PID pairs) joined with `ps` for memory and process name. `windowId` is the X11 window ID string from `wmctrl`.
- **Non-Linux fallback:** returns `[]`. DesktopDrawer renders an "Available on Linux only" empty state.
- Each row: app icon (emoji fallback) + app name + PID + memory usage + Focus (↗) button + Kill (✕) button
- Focus button calls `desktop.focusApp(windowId: string)` → `wmctrl -ia <windowId>` (uses window ID, not PID)
- Kill button calls `desktop.killApp(pid: number)` → SIGTERM — no confirmation dialog in Phase 1
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
| `browser.listSessions()` | renderer → main | Returns `string[]` of normalized domains (lowercase, leading dot stripped) with active cookies. Uses `session.defaultSession.cookies.get({})`, groups by normalized `.domain`. |
| `browser.clearSession(domain: string)` | renderer → main | Enumerates all cookies for the domain via `cookies.get({ domain })`, removes each with `cookies.remove(url, name)`. Constructs URL as `https://<domain><path>`. |
| `fs.readDir(path: string)` | renderer → main | Returns `{ name: string, type: 'file' \| 'dir', path: string }[]`. Returns `[]` on permission error (no throw). |
| `fs.readFile(path: string)` | renderer → main | Returns file content as `string`. Throws if file exceeds 500KB (renderer shows warning). |
| `desktop.listApps()` | renderer → main | Returns `{ name: string, pid: number, windowId: string, memoryMB: number }[]` via `wmctrl -lp` + `ps`. Returns `[]` on non-Linux. |
| `desktop.focusApp(windowId: string)` | renderer → main | Calls `wmctrl -ia <windowId>`. Linux only. |
| `desktop.killApp(pid: number)` | renderer → main | Sends SIGTERM via `process.kill(pid)`. |

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

### App.tsx changes (minimal)

The following props are **dropped** from the Sidebar interface:
- `collapsed` — drawer state is now internal to `Sidebar.tsx`
- `onToggleCollapse` — replaced by internal `Ctrl+S` listener in `Sidebar.tsx`
- `activeView` — no longer read by Sidebar (Sidebar does not highlight a current view)

The following props are **retained**:
- `onNewChat` — New Agent button
- `onLoadConversation` — history row clicks
- `onOpenProcess` — agent row clicks
- `onViewChange` — used only for gear icon → `onViewChange('settings')`

The `sidebarCollapsed` state and `Ctrl+S` handler are **removed from `App.tsx`**.

### History refresh

`ChatDrawer` accepts a `chatKey: number` prop (the existing `chatKey` from `App.tsx` that increments on `handleNewChat`). When `chatKey` changes, `ChatDrawer` re-fetches `api.chat.list()`. This preserves the existing behavior without adding new IPC events.

### Unchanged components
- `ChatPanel.tsx` — no changes
- `BrowserPanel.tsx` — no changes
- `InputBar.tsx` — no changes
- All other panels — no changes

---

## Data Flow

```
App.tsx
  └── Sidebar.tsx (new)
        │   props: onNewChat, onLoadConversation, onOpenProcess, onViewChange, chatKey
        │   internal state: activeMode (DrawerMode), drawerOpen (boolean)
        │   registers own keydown listener for Ctrl+S
        ├── Rail.tsx
        │     └── emits: onModeChange(mode: DrawerMode)
        └── [ActiveDrawer].tsx
              ├── ChatDrawer
              │     props: onNewChat, onLoadConversation, onOpenProcess, chatKey
              │     uses: api.chat.list(), api.process.list(), api.process.onListChanged()
              │     re-fetches chat.list() when chatKey changes
              ├── AgentsDrawer
              │     props: onNewChat, onOpenProcess
              │     uses: api.process.list(), api.process.onListChanged(), api.process.cancel()
              ├── BrowserDrawer
              │     uses: api.browser.listSessions(), api.browser.clearSession()
              ├── FilesDrawer
              │     props: onAddContext (calls api.chat.addContext after fs.readFile)
              │     uses: api.fs.readDir(), api.fs.readFile(), api.chat.addContext()
              └── DesktopDrawer
                    uses: api.desktop.listApps(), api.desktop.focusApp(), api.desktop.killApp()
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
