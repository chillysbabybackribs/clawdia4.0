# Sidebar Redesign Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current passive sidebar with an icon rail + functional context drawer that exposes Clawdia's core capabilities (agents, browser sessions, filesystem, desktop control) as live, interactive control surfaces.

**Architecture:** A 48px icon rail selects which 210px drawer is shown; drawer content is live data (processes, cookies, file tree, running apps). All drawer state is internal to `Sidebar.tsx` — `App.tsx` is minimally changed. Seven new IPC handlers are added to `main.ts`/`preload.ts` for fs, desktop, and browser session APIs.

**Tech Stack:** React + TypeScript, Electron IPC (contextBridge pattern), Tailwind CSS, existing `window.clawdia` API bridge, `wmctrl` + `/proc` for desktop/system stats (Linux).

---

## File Map

### Modified
- `src/shared/ipc-channels.ts` — add 7 new channel constants
- `src/main/preload.ts` — expose new `fs`, `desktop`, `browser.listSessions`, `browser.clearSession` APIs
- `src/main/main.ts` — register 7 new IPC handlers
- `src/renderer/App.tsx` — remove `sidebarCollapsed` state + `Ctrl+S` handler, update `Sidebar` props
- `src/renderer/components/Sidebar.tsx` — full replacement (rail shell + drawer switcher)

### Created
- `src/renderer/components/sidebar/Rail.tsx` — 48px icon rail
- `src/renderer/components/sidebar/drawers/ChatDrawer.tsx` — history + active sessions
- `src/renderer/components/sidebar/drawers/AgentsDrawer.tsx` — live processes + slash profiles
- `src/renderer/components/sidebar/drawers/BrowserDrawer.tsx` — cookie session manager
- `src/renderer/components/sidebar/drawers/FilesDrawer.tsx` — navigable file tree
- `src/renderer/components/sidebar/drawers/DesktopDrawer.tsx` — running apps + system stats

---

## Task 1: New IPC Channel Constants

**Files:**
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Add constants to the IPC object in `ipc-channels.ts`**

Open `src/shared/ipc-channels.ts`. Append these entries inside the `IPC` const object after the last existing entry:

```typescript
  // Filesystem
  FS_READ_DIR: 'fs:read-dir',
  FS_READ_FILE: 'fs:read-file',
  // Desktop
  DESKTOP_LIST_APPS: 'desktop:list-apps',
  DESKTOP_FOCUS_APP: 'desktop:focus-app',
  DESKTOP_KILL_APP: 'desktop:kill-app',
  // Browser sessions
  BROWSER_LIST_SESSIONS: 'browser:list-sessions',
  BROWSER_CLEAR_SESSION: 'browser:clear-session',
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors related to `ipc-channels.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-channels.ts
git commit -m "feat: add IPC channel constants for fs, desktop, browser sessions"
```

---

## Task 2: Main Process IPC Handlers

**Files:**
- Modify: `src/main/main.ts`

These handlers run in the Electron main process where Node.js APIs are available.

- [ ] **Step 1: Add imports at the top of `main.ts`**

Find the existing imports block. Add after the last import:

```typescript
import { execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
```

(Some of these may already be imported — skip duplicates.)

- [ ] **Step 2: Register `fs:read-dir` handler**

Find where IPC handlers are registered in `main.ts` (look for `ipcMain.handle`). Add:

```typescript
ipcMain.handle('fs:read-dir', async (_event, dirPath: string) => {
  try {
    const resolved = dirPath.startsWith('~')
      ? dirPath.replace('~', os.homedir())
      : dirPath;
    const entries = fsSync.readdirSync(resolved, { withFileTypes: true });
    return entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      path: path.join(resolved, e.name),
    }));
  } catch {
    return [];
  }
});
```

- [ ] **Step 3: Register `fs:read-file` handler**

```typescript
ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
  const resolved = filePath.startsWith('~')
    ? filePath.replace('~', os.homedir())
    : filePath;
  const stat = fsSync.statSync(resolved);
  if (stat.size > 500 * 1024) {
    throw new Error(`File too large: ${Math.round(stat.size / 1024)}KB (max 500KB)`);
  }
  return fsSync.readFileSync(resolved, 'utf-8');
});
```

- [ ] **Step 4: Register `desktop:list-apps` handler**

```typescript
ipcMain.handle('desktop:list-apps', async () => {
  if (process.platform !== 'linux') return null; // null = not supported (vs [] = supported but no windows)
  try {
    // wmctrl -lp: window-id desktop pid machine title
    const wmctrlOut = execSync('wmctrl -lp 2>/dev/null', { encoding: 'utf-8' });
    const lines = wmctrlOut.trim().split('\n').filter(Boolean);
    const apps: { name: string; pid: number; windowId: string; memoryMB: number }[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const windowId = parts[0];
      const pid = parseInt(parts[2], 10);
      if (!pid || pid <= 0) continue;
      // Get process name from /proc
      try {
        const comm = fsSync.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
        const statm = fsSync.readFileSync(`/proc/${pid}/statm`, 'utf-8').trim();
        const pages = parseInt(statm.split(' ')[1], 10);
        const memoryMB = Math.round((pages * 4096) / (1024 * 1024));
        const title = parts.slice(4).join(' ');
        apps.push({ name: title || comm, pid, windowId, memoryMB });
      } catch {
        continue;
      }
    }
    // Deduplicate by pid, keep first window per pid
    const seen = new Set<number>();
    return apps.filter(a => { if (seen.has(a.pid)) return false; seen.add(a.pid); return true; });
  } catch {
    return [];
  }
});
```

- [ ] **Step 5: Register `desktop:focus-app` handler**

```typescript
ipcMain.handle('desktop:focus-app', async (_event, windowId: string) => {
  if (process.platform !== 'linux') return;
  try {
    execSync(`wmctrl -ia ${windowId}`);
  } catch { /* ignore */ }
});
```

- [ ] **Step 6: Register `desktop:kill-app` handler**

```typescript
ipcMain.handle('desktop:kill-app', async (_event, pid: number) => {
  try {
    process.kill(pid, 'SIGTERM');
  } catch { /* process may already be gone */ }
});
```

- [ ] **Step 7: Register `browser:list-sessions` handler**

This uses Electron's `session` module. Find where `session` is already imported or add it:

```typescript
import { session } from 'electron'; // may already be imported
```

Then add the handler:

```typescript
ipcMain.handle('browser:list-sessions', async () => {
  const cookies = await session.defaultSession.cookies.get({});
  const domains = new Set<string>();
  for (const cookie of cookies) {
    // Normalize: strip leading dot, lowercase
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    if (domain) domains.add(domain);
  }
  return Array.from(domains).sort();
});
```

- [ ] **Step 8: Register `browser:clear-session` handler**

```typescript
ipcMain.handle('browser:clear-session', async (_event, domain: string) => {
  const cookies = await session.defaultSession.cookies.get({ domain });
  for (const cookie of cookies) {
    const cookieDomain = cookie.domain.replace(/^\./, '');
    const url = `https://${cookieDomain}${cookie.path || '/'}`;
    await session.defaultSession.cookies.remove(url, cookie.name);
  }
});
```

- [ ] **Step 9: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors in `main.ts`.

- [ ] **Step 10: Commit**

```bash
git add src/main/main.ts
git commit -m "feat: add IPC handlers for fs, desktop, and browser session APIs"
```

---

## Task 3: Preload Bridge

**Files:**
- Modify: `src/main/preload.ts`

- [ ] **Step 1: Add `fs` namespace to the `contextBridge.exposeInMainWorld` call**

Find the closing `});` of the `contextBridge.exposeInMainWorld('clawdia', {` call. Add before it:

```typescript
  fs: {
    readDir: (dirPath: string) => invoke('fs:read-dir', dirPath),
    readFile: (filePath: string) => invoke('fs:read-file', filePath),
  },
  desktop: {
    listApps: () => invoke('desktop:list-apps'),
    focusApp: (windowId: string) => invoke('desktop:focus-app', windowId),
    killApp: (pid: number) => invoke('desktop:kill-app', pid),
  },
```

- [ ] **Step 2: Add `listSessions` and `clearSession` to the existing `browser` namespace**

Find the `browser: {` block. Append inside it (before the closing `},`):

```typescript
    listSessions: () => invoke('browser:list-sessions'),
    clearSession: (domain: string) => invoke('browser:clear-session', domain),
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/main/preload.ts
git commit -m "feat: expose fs, desktop, and browser session APIs via preload bridge"
```

---

## Task 4: Rail Component

**Files:**
- Create: `src/renderer/components/sidebar/Rail.tsx`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p /home/dp/Desktop/clawdia4.0/src/renderer/components/sidebar/drawers
```

- [ ] **Step 2: Create `Rail.tsx`**

```tsx
import React from 'react';

export type DrawerMode = 'chat' | 'agents' | 'browser' | 'files' | 'desktop';

interface RailProps {
  activeMode: DrawerMode | null; // null = drawer closed
  onModeChange: (mode: DrawerMode) => void;
  onSettings: () => void;
}

function RailIcon({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`no-drag relative flex items-center justify-center w-[34px] h-[34px] rounded-lg transition-all cursor-pointer flex-shrink-0
        ${active
          ? 'bg-[#161624] text-text-primary'
          : 'text-[#333] hover:text-[#666] hover:bg-[#111120]'
        }`}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-[16px] bg-accent rounded-r-[2px]" />
      )}
      {children}
    </button>
  );
}

// SVG icons
const icons = {
  chat: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  agents: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  browser: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  files: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h6l2 3h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    </svg>
  ),
  desktop: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

const MODES: { mode: DrawerMode; title: string }[] = [
  { mode: 'chat', title: 'Conversations' },
  { mode: 'agents', title: 'Agents' },
  { mode: 'browser', title: 'Browser Sessions' },
  { mode: 'files', title: 'Files' },
  { mode: 'desktop', title: 'Desktop' },
];

export default function Rail({ activeMode, onModeChange, onSettings }: RailProps) {
  return (
    <div className="flex flex-col items-center w-[48px] flex-shrink-0 py-2.5 gap-1 bg-[#0a0a12] border-r border-[#141420]">
      {/* Brand */}
      <div className="drag-region flex items-center justify-center w-[28px] h-[28px] rounded-lg bg-accent flex-shrink-0 mb-2">
        <span className="text-[11px] font-black text-white select-none">C</span>
      </div>

      <div className="w-[18px] h-px bg-[#161622] flex-shrink-0" />

      {/* Mode icons */}
      {MODES.map(({ mode, title }) => (
        <RailIcon
          key={mode}
          active={activeMode === mode}
          onClick={() => onModeChange(mode)}
          title={title}
        >
          {icons[mode]}
        </RailIcon>
      ))}

      <div className="flex-1" />

      {/* Settings */}
      <RailIcon active={false} onClick={onSettings} title="Settings">
        {icons.settings}
      </RailIcon>
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/sidebar/Rail.tsx
git commit -m "feat: add Rail component for sidebar icon navigation"
```

---

## Task 5: ChatDrawer

**Files:**
- Create: `src/renderer/components/sidebar/drawers/ChatDrawer.tsx`

- [ ] **Step 1: Create `ChatDrawer.tsx`**

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import type { ProcessInfo } from '../../../../shared/types';

interface ConvItem {
  id: string;
  title: string;
  updatedAt: string;
}

interface ChatDrawerProps {
  onNewChat: () => void;
  onLoadConversation: (id: string, buffer?: any[] | null) => void;
  onOpenProcess: (id: string) => void;
  chatKey: number;
}

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'Now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function convTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(isoDate).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function StatusDot({ status }: { status: ProcessInfo['status'] }) {
  if (status === 'running') {
    return <span className="w-[7px] h-[7px] rounded-full bg-accent flex-shrink-0 shadow-[0_0_5px_rgba(255,80,97,0.5)]" />;
  }
  if (status === 'awaiting_approval' || status === 'needs_human') {
    return <span className="w-[7px] h-[7px] rounded-full bg-[#e8a020] flex-shrink-0 shadow-[0_0_5px_rgba(232,160,32,0.4)]" />;
  }
  return <span className="w-[7px] h-[7px] rounded-full bg-[#1e1e2e] flex-shrink-0" />;
}

export default function ChatDrawer({ onNewChat, onLoadConversation, onOpenProcess, chatKey }: ChatDrawerProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [conversations, setConversations] = useState<ConvItem[]>([]);
  const [search, setSearch] = useState('');

  const api = (window as any).clawdia;

  // Load processes
  useEffect(() => {
    if (!api) return;
    api.process.list().then(setProcesses).catch(() => {});
    return api.process.onListChanged(setProcesses);
  }, []);

  // Load conversations — refresh when chatKey changes
  const loadConvs = useCallback(async () => {
    if (!api) return;
    try { setConversations(await api.chat.list() || []); } catch {}
  }, []);

  useEffect(() => { loadConvs(); }, [loadConvs, chatKey]);

  const handleDeleteConv = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!api) return;
    await api.chat.delete(id);
    setConversations(prev => prev.filter(c => c.id !== id));
  };

  const handleProcessClick = async (proc: ProcessInfo) => {
    if (!api) return;
    if (['running', 'awaiting_approval', 'needs_human'].includes(proc.status)) {
      const result = await api.process.attach(proc.id);
      onLoadConversation(proc.conversationId, result?.buffer || null);
    } else {
      onOpenProcess(proc.id);
    }
  };

  const active = processes.filter(p => ['running', 'awaiting_approval', 'needs_human'].includes(p.status));
  const q = search.toLowerCase();
  const filteredActive = q ? active.filter(p => p.summary.toLowerCase().includes(q)) : active;
  const filteredConvs = q ? conversations.filter(c => c.title.toLowerCase().includes(q)) : conversations;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-[#141420] flex-shrink-0">
        <span className="text-[11px] font-semibold text-text-primary">Conversations</span>
        <button
          onClick={onNewChat}
          className="no-drag text-[10px] text-accent border border-accent/20 bg-accent/[0.06] rounded px-2 py-0.5 hover:bg-accent/10 transition-colors cursor-pointer"
        >
          + New
        </button>
      </div>

      {/* Search */}
      <div className="px-2.5 py-2 flex-shrink-0">
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary/40 pointer-events-none">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-[26px] pl-7 pr-2 rounded bg-white/[0.04] border border-[#1a1a2a] text-[11px] text-text-primary placeholder-text-secondary/40 outline-none focus:border-accent/30 transition-all"
          />
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
        {/* Active */}
        {filteredActive.length > 0 && (
          <div className="mb-1">
            <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">Active</div>
            {filteredActive.map(proc => (
              <button key={proc.id} onClick={() => handleProcessClick(proc)}
                className="no-drag w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04] transition-colors cursor-pointer">
                <StatusDot status={proc.status} />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-text-primary truncate">{proc.summary.slice(0, 30)}</div>
                  <div className="text-[9px] text-text-secondary/50 mt-0.5">{timeAgo(proc.startedAt)}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* History */}
        {filteredConvs.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">History</div>
            {filteredConvs.map(conv => (
              <div key={conv.id} role="button" tabIndex={0}
                onClick={() => onLoadConversation(conv.id)}
                onKeyDown={e => { if (e.key === 'Enter') onLoadConversation(conv.id); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.04] transition-colors cursor-pointer group outline-none">
                <span className="w-[4px] h-[4px] rounded-full bg-[#1e1e2e] flex-shrink-0" />
                <span className="flex-1 text-[11px] text-text-secondary/60 truncate">{conv.title}</span>
                <span className="text-[9px] text-text-secondary/30 flex-shrink-0">{convTimeAgo(conv.updatedAt)}</span>
                <button
                  onClick={e => handleDeleteConv(conv.id, e)}
                  className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-all cursor-pointer"
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {filteredActive.length === 0 && filteredConvs.length === 0 && (
          <div className="px-3 py-4 text-[11px] text-text-secondary/30 text-center">
            {search ? 'No results' : 'No conversations yet'}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/sidebar/drawers/ChatDrawer.tsx
git commit -m "feat: add ChatDrawer — conversation history and active sessions"
```

---

## Task 6: AgentsDrawer

**Files:**
- Create: `src/renderer/components/sidebar/drawers/AgentsDrawer.tsx`

- [ ] **Step 1: Create `AgentsDrawer.tsx`**

```tsx
import React, { useState, useEffect } from 'react';
import type { ProcessInfo } from '../../../../shared/types';

interface AgentsDrawerProps {
  onNewChat: () => void;
  onOpenProcess: (id: string) => void;
}

const RECENT_MAX_AGE_MS = 5 * 60 * 60 * 1000;

const PROFILES = [
  { cmd: '/bloodhound', desc: 'web automation' },
  { cmd: '/filesystem', desc: 'file operations' },
  { cmd: '/ytdlp', desc: 'download media' },
  { cmd: '/general', desc: 'full capabilities' },
];

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'Now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function StatusDot({ status }: { status: ProcessInfo['status'] }) {
  if (status === 'running') {
    return <span className="w-[7px] h-[7px] rounded-full bg-accent flex-shrink-0 mt-[5px] shadow-[0_0_5px_rgba(255,80,97,0.5)]" />;
  }
  if (status === 'awaiting_approval' || status === 'needs_human') {
    return <span className="w-[7px] h-[7px] rounded-full bg-[#e8a020] flex-shrink-0 mt-[5px] shadow-[0_0_5px_rgba(232,160,32,0.4)]" />;
  }
  return <span className="w-[7px] h-[7px] rounded-full bg-[#3a6644] flex-shrink-0 mt-[5px]" />;
}

export default function AgentsDrawer({ onNewChat, onOpenProcess }: AgentsDrawerProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const api = (window as any).clawdia;

  useEffect(() => {
    if (!api) return;
    api.process.list().then(setProcesses).catch(() => {});
    return api.process.onListChanged(setProcesses);
  }, []);

  const prefillInput = (cmd: string) => {
    // Dispatch a custom event that InputBar listens to
    window.dispatchEvent(new CustomEvent('clawdia:prefill-input', { detail: cmd }));
  };

  const handleCancel = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!api) return;
    await api.process.cancel(id).catch(() => {});
  };

  const running = processes.filter(p => ['running', 'awaiting_approval', 'needs_human'].includes(p.status));
  const completedToday = processes.filter(p =>
    !['running', 'awaiting_approval', 'needs_human'].includes(p.status) &&
    (Date.now() - (p.completedAt || p.startedAt)) <= RECENT_MAX_AGE_MS
  );

  const totalCount = processes.length;
  const todayCount = processes.filter(p => {
    const ts = p.completedAt || p.startedAt;
    return Date.now() - ts < 86400000;
  }).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-[#141420] flex-shrink-0">
        <span className="text-[11px] font-semibold text-text-primary">Agents</span>
        <button onClick={onNewChat}
          className="no-drag text-[10px] text-accent border border-accent/20 bg-accent/[0.06] rounded px-2 py-0.5 hover:bg-accent/10 transition-colors cursor-pointer">
          + Spawn
        </button>
      </div>

      {/* New agent button */}
      <div className="px-2.5 py-2 flex-shrink-0">
        <button onClick={onNewChat}
          className="no-drag w-full py-1.5 rounded-lg bg-accent/[0.08] border border-accent/20 text-[11px] font-semibold text-accent hover:bg-accent/[0.12] transition-colors cursor-pointer">
          + New Agent
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto min-h-0">

        {/* Running */}
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">
          Running {running.length > 0 && `(${running.length})`}
        </div>
        {running.length === 0 && (
          <div className="px-3 pb-2 text-[11px] text-text-secondary/30">No active agents</div>
        )}
        {running.map(proc => (
          <div key={proc.id} className="flex items-start gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors group">
            <StatusDot status={proc.status} />
            <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onOpenProcess(proc.id)}>
              <div className="text-[11px] text-text-primary truncate">{proc.summary.slice(0, 30)}</div>
              <div className="text-[9px] text-text-secondary/40 mt-0.5">
                {proc.agentProfile && <span className="mr-1.5 uppercase">{proc.agentProfile}</span>}
                {timeAgo(proc.startedAt)} · {proc.toolCallCount} tools
              </div>
            </div>
            <button
              onClick={e => proc.status === 'needs_human' ? onOpenProcess(proc.id) : handleCancel(e, proc.id)}
              className="no-drag flex-shrink-0 text-[10px] text-text-secondary/30 hover:text-text-secondary transition-colors cursor-pointer mt-0.5"
            >
              {proc.status === 'needs_human' ? '→' : '✕'}
            </button>
          </div>
        ))}

        <div className="h-px bg-[#111120] my-1" />

        {/* Profiles */}
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">Profiles</div>
        {PROFILES.map(({ cmd, desc }) => (
          <button key={cmd} onClick={() => prefillInput(cmd)}
            className="no-drag w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.04] transition-colors cursor-pointer text-left">
            <span className="text-[10px] text-accent font-mono font-semibold flex-shrink-0">{cmd}</span>
            <span className="text-[10px] text-text-secondary/40">{desc}</span>
          </button>
        ))}

        {completedToday.length > 0 && (
          <>
            <div className="h-px bg-[#111120] my-1" />
            <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">Completed Today</div>
            {completedToday.map(proc => (
              <button key={proc.id} onClick={() => onOpenProcess(proc.id)}
                className="no-drag w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.04] transition-colors cursor-pointer">
                <span className="w-[7px] h-[7px] rounded-full bg-[#3a6644] flex-shrink-0" />
                <span className="flex-1 text-[11px] text-text-secondary/50 truncate">{proc.summary.slice(0, 30)}</span>
                <span className="text-[9px] text-text-secondary/30 flex-shrink-0">{timeAgo(proc.completedAt || proc.startedAt)}</span>
              </button>
            ))}
          </>
        )}
      </div>

      {/* Stats bar */}
      <div className="flex border-t border-[#111120] flex-shrink-0">
        {[
          { val: running.length, key: 'Running' },
          { val: todayCount, key: 'Today' },
          { val: totalCount, key: 'Total' },
        ].map(({ val, key }, i) => (
          <div key={key} className={`flex-1 py-1.5 text-center ${i < 2 ? 'border-r border-[#111120]' : ''}`}>
            <div className="text-[12px] font-semibold text-text-secondary/60">{val}</div>
            <div className="text-[8px] text-text-secondary/30 uppercase tracking-wide">{key}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add `prefill-input` event listener to `InputBar.tsx`**

In `src/renderer/components/InputBar.tsx`, find the `useEffect` that focuses the textarea. Add a new `useEffect` below it:

```tsx
useEffect(() => {
  const handler = (e: Event) => {
    const cmd = (e as CustomEvent<string>).detail;
    setText(cmd + ' ');
    textareaRef.current?.focus();
  };
  window.addEventListener('clawdia:prefill-input', handler);
  return () => window.removeEventListener('clawdia:prefill-input', handler);
}, []);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/sidebar/drawers/AgentsDrawer.tsx src/renderer/components/InputBar.tsx
git commit -m "feat: add AgentsDrawer with live processes, profiles, stats bar; wire prefill-input event"
```

---

## Task 7: BrowserDrawer

**Files:**
- Create: `src/renderer/components/sidebar/drawers/BrowserDrawer.tsx`

- [ ] **Step 1: Create `BrowserDrawer.tsx`**

```tsx
import React, { useState, useEffect, useCallback } from 'react';

export default function BrowserDrawer() {
  const [domains, setDomains] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const api = (window as any).clawdia;

  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      const list = await api.browser.listSessions();
      setDomains(list || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleClear = async (domain: string) => {
    if (!api) return;
    await api.browser.clearSession(domain).catch(() => {});
    setDomains(prev => prev.filter(d => d !== domain));
  };

  const filtered = search
    ? domains.filter(d => d.includes(search.toLowerCase()))
    : domains;

  // First letter as favicon fallback
  const favicon = (domain: string) => domain.replace(/^www\./, '')[0]?.toUpperCase() || '?';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-3 border-b border-[#141420] flex-shrink-0">
        <div className="text-[11px] font-semibold text-text-primary mb-2">Browser Sessions</div>
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary/40 pointer-events-none">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text" placeholder="Filter sites..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full h-[26px] pl-7 pr-2 rounded bg-white/[0.04] border border-[#1a1a2a] text-[11px] text-text-primary placeholder-text-secondary/40 outline-none focus:border-accent/30 transition-all"
          />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">
          Active Sessions {!loading && `(${filtered.length})`}
        </div>

        {loading && (
          <div className="px-3 py-2 text-[11px] text-text-secondary/30">Loading...</div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-text-secondary/30">
            {search ? 'No matching sites' : 'No active sessions. Browse a site to create one.'}
          </div>
        )}

        {filtered.map(domain => (
          <div key={domain} className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.04] transition-colors group">
            <div className="w-[18px] h-[18px] rounded bg-[#141420] flex items-center justify-center text-[10px] font-semibold text-text-secondary/50 flex-shrink-0">
              {favicon(domain)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-text-secondary/80 truncate">{domain}</div>
              <div className="text-[9px] text-[#3a6644] mt-0.5">● Session active</div>
            </div>
            <button
              onClick={() => handleClear(domain)}
              className="no-drag flex-shrink-0 text-[9px] text-text-secondary/30 border border-[#1e1e2e] rounded px-1.5 py-0.5 hover:text-accent hover:border-accent/30 hover:bg-accent/[0.06] transition-all cursor-pointer opacity-0 group-hover:opacity-100"
            >
              Clear
            </button>
          </div>
        ))}

        <div className="h-px bg-[#111120] my-2" />
        <div className="px-3 pb-3 text-[10px] text-text-secondary/30 leading-relaxed">
          Claude uses your existing sessions automatically. No API keys required.
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/sidebar/drawers/BrowserDrawer.tsx
git commit -m "feat: add BrowserDrawer — live authenticated session manager"
```

---

## Task 8: FilesDrawer

**Files:**
- Create: `src/renderer/components/sidebar/drawers/FilesDrawer.tsx`

- [ ] **Step 1: Create `FilesDrawer.tsx`**

```tsx
import React, { useState, useEffect, useCallback } from 'react';

interface FsEntry {
  name: string;
  type: 'file' | 'dir';
  path: string;
}

interface TreeNode extends FsEntry {
  children?: TreeNode[];
  expanded?: boolean;
}

interface FilesDrawerProps {
  onAddContext: (text: string, filePath: string) => void;
}

const PINNED = [
  { label: 'Home', path: '~' },
  { label: 'Desktop', path: '~/Desktop' },
  { label: 'Downloads', path: '~/Downloads' },
];

const FILE_ICON: Record<string, string> = {
  ts: '📘', tsx: '📘', js: '📄', jsx: '📄', json: '📋',
  md: '📝', txt: '📝', py: '🐍', sh: '⚙', css: '🎨',
  html: '🌐', pdf: '📕', png: '🖼', jpg: '🖼', jpeg: '🖼',
  zip: '📦', tar: '📦', gz: '📦',
};

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return FILE_ICON[ext] || '📄';
}

export default function FilesDrawer({ onAddContext }: FilesDrawerProps) {
  const [root, setRoot] = useState('~');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FsEntry[]>>({});
  const [search, setSearch] = useState('');
  const [attaching, setAttaching] = useState<string | null>(null);
  const api = (window as any).clawdia;

  const loadDir = useCallback(async (dirPath: string) => {
    if (!api) return;
    try {
      const items: FsEntry[] = await api.fs.readDir(dirPath);
      // Sort: dirs first, then files, both alphabetical
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(items);
    } catch {}
  }, []);

  useEffect(() => { loadDir(root); }, [root, loadDir]);

  const toggleDir = async (entry: FsEntry) => {
    if (expanded[entry.path]) {
      setExpanded(prev => { const n = { ...prev }; delete n[entry.path]; return n; });
    } else {
      const children: FsEntry[] = await api.fs.readDir(entry.path) || [];
      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setExpanded(prev => ({ ...prev, [entry.path]: children }));
    }
  };

  const handleFileClick = async (entry: FsEntry) => {
    setAttaching(entry.path);
    try {
      const content: string = await api.fs.readFile(entry.path);
      onAddContext(content, entry.path);
    } catch (err: any) {
      if (err?.message?.includes('too large')) {
        alert(`File too large to attach (max 500KB): ${entry.name}`);
      }
    }
    setAttaching(null);
  };

  const filteredEntries = search
    ? entries.filter(e => e.name.toLowerCase().includes(search.toLowerCase()))
    : entries;

  function renderEntry(entry: FsEntry, depth = 0): React.ReactNode {
    const isExpanded = !!expanded[entry.path];
    const children = expanded[entry.path] || [];
    const indent = depth * 12;

    return (
      <React.Fragment key={entry.path}>
        <div
          role="button"
          onClick={() => entry.type === 'dir' ? toggleDir(entry) : handleFileClick(entry)}
          className="flex items-center gap-1.5 px-2 py-[3px] hover:bg-white/[0.04] transition-colors cursor-pointer group"
          style={{ paddingLeft: `${8 + indent}px` }}
        >
          <span className="text-[11px] flex-shrink-0">
            {entry.type === 'dir' ? (isExpanded ? '📂' : '📁') : fileIcon(entry.name)}
          </span>
          <span className={`text-[11px] flex-1 truncate ${entry.type === 'dir' ? 'text-text-secondary/60' : 'text-text-secondary/50'}`}>
            {entry.name}
          </span>
          {entry.type === 'file' && (
            <span className="text-[9px] text-text-secondary/20 flex-shrink-0">
              {entry.name.split('.').pop()?.toLowerCase()}
            </span>
          )}
          {attaching === entry.path && (
            <span className="text-[9px] text-accent flex-shrink-0">...</span>
          )}
        </div>
        {isExpanded && children.map(child => renderEntry(child, depth + 1))}
      </React.Fragment>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-3 border-b border-[#141420] flex-shrink-0">
        <div className="text-[11px] font-semibold text-text-primary mb-2">Files</div>
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary/40 pointer-events-none">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text" placeholder="Search files..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full h-[26px] pl-7 pr-2 rounded bg-white/[0.04] border border-[#1a1a2a] text-[11px] text-text-primary placeholder-text-secondary/40 outline-none focus:border-accent/30 transition-all"
          />
        </div>
      </div>

      {/* Pinned */}
      <div className="flex-shrink-0">
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">Pinned</div>
        {PINNED.map(({ label, path }) => (
          <button key={path} onClick={() => { setRoot(path); setExpanded({}); setSearch(''); }}
            className={`no-drag w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.04] transition-colors cursor-pointer
              ${root === path ? 'text-text-primary' : 'text-text-secondary/50'}`}>
            <span className="text-[11px]">
              {label === 'Home' ? '🏠' : label === 'Desktop' ? '🖥' : '⬇'}
            </span>
            <span className="text-[11px]">{label}</span>
          </button>
        ))}
        <div className="h-px bg-[#111120] my-1" />
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider truncate">{root}</div>
        {filteredEntries.map(entry => renderEntry(entry))}
        {filteredEntries.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-text-secondary/30">
            {search ? 'No matches' : 'Empty folder'}
          </div>
        )}
        <div className="h-px bg-[#111120] my-2" />
        <div className="px-3 pb-3 text-[10px] text-text-secondary/30">Click a file to add it to the current chat as context.</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/sidebar/drawers/FilesDrawer.tsx
git commit -m "feat: add FilesDrawer — navigable file tree with chat context attachment"
```

---

## Task 9: DesktopDrawer

**Files:**
- Create: `src/renderer/components/sidebar/drawers/DesktopDrawer.tsx`

- [ ] **Step 1: Create `DesktopDrawer.tsx`**

```tsx
import React, { useState, useEffect, useCallback } from 'react';

interface AppInfo {
  name: string;
  pid: number;
  windowId: string;
  memoryMB: number;
}

interface SystemStats {
  cpuPercent: number;
  ramUsedGB: number;
  ramTotalGB: number;
}

export default function DesktopDrawer() {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [platformChecked, setPlatformChecked] = useState(false);
  const [isLinux, setIsLinux] = useState(true);
  const api = (window as any).clawdia;

  const refresh = useCallback(async () => {
    if (!api) return;
    const list = await api.desktop.listApps().catch(() => [] as AppInfo[]);
    if (!platformChecked) {
      // The main process returns [] on non-Linux AND on Linux with no windows.
      // We distinguish by checking if wmctrl is available via a sentinel value.
      // The handler sets list to null (not []) on non-Linux — check for null.
      // Implementation note: update desktop:list-apps handler to return null on
      // non-Linux instead of [] so we can distinguish from "no windows open".
      // See Task 2 Step 4 — change: `if (process.platform !== 'linux') return null;`
      setIsLinux(list !== null);
      setPlatformChecked(true);
    }
    setApps(list || []);
  }, [platformChecked]);

  // System stats via IPC — read /proc on main side
  // For simplicity in Phase 1, stats are omitted from IPC (no new handler needed)
  // The drawer shows app list; stats row is left as a visual placeholder

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleFocus = async (windowId: string) => {
    await api.desktop.focusApp(windowId).catch(() => {});
  };

  const handleKill = async (pid: number) => {
    await api.desktop.killApp(pid).catch(() => {});
    setApps(prev => prev.filter(a => a.pid !== pid));
  };

  if (!isLinux) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-3 border-b border-[#141420]">
          <div className="text-[11px] font-semibold text-text-primary">Desktop</div>
        </div>
        <div className="flex-1 flex items-center justify-center px-4 text-center">
          <div className="text-[11px] text-text-secondary/30 leading-relaxed">
            Desktop control is available on Linux only.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-3 border-b border-[#141420] flex-shrink-0">
        <div className="text-[11px] font-semibold text-text-primary">Desktop</div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-3 py-1.5 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">
          Running Apps {apps.length > 0 && `(${apps.length})`}
        </div>

        {apps.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-text-secondary/30">No windowed apps detected</div>
        )}

        {apps.map(app => (
          <div key={app.pid} className="flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors group">
            <div className="w-[22px] h-[22px] rounded bg-[#141420] flex items-center justify-center text-[11px] flex-shrink-0">
              🖥
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-text-secondary/80 truncate">{app.name}</div>
              <div className="text-[9px] text-text-secondary/30 mt-0.5">PID {app.pid} · {app.memoryMB} MB</div>
            </div>
            <div className="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => handleFocus(app.windowId)}
                title="Focus"
                className="no-drag w-[20px] h-[20px] flex items-center justify-center rounded bg-[#141420] border border-[#1e1e2e] text-[10px] text-text-secondary/40 hover:text-text-secondary hover:bg-[#1e1e30] transition-all cursor-pointer"
              >
                ↗
              </button>
              <button
                onClick={() => handleKill(app.pid)}
                title="Kill"
                className="no-drag w-[20px] h-[20px] flex items-center justify-center rounded bg-[#141420] border border-[#1e1e2e] text-[10px] text-text-secondary/40 hover:text-accent hover:border-accent/30 hover:bg-accent/[0.06] transition-all cursor-pointer"
              >
                ✕
              </button>
            </div>
          </div>
        ))}

        <div className="h-px bg-[#111120] my-2" />
        <div className="px-3 pb-1 text-[9px] font-semibold text-text-secondary/40 uppercase tracking-wider">Try asking</div>
        {[
          '"Open VS Code and find all TODOs"',
          '"Open Spotify and play something"',
          '"Take a screenshot of this window"',
        ].map(prompt => (
          <div key={prompt} className="px-3 py-1 text-[10px] text-text-secondary/30 italic">{prompt}</div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/sidebar/drawers/DesktopDrawer.tsx
git commit -m "feat: add DesktopDrawer — live running apps with focus/kill controls"
```

---

## Task 10: New Sidebar Shell

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`

This replaces the entire file.

- [ ] **Step 1: Replace `Sidebar.tsx` entirely**

```tsx
import React, { useState, useEffect } from 'react';
import type { View } from '../App';
import Rail, { type DrawerMode } from './sidebar/Rail';
import ChatDrawer from './sidebar/drawers/ChatDrawer';
import AgentsDrawer from './sidebar/drawers/AgentsDrawer';
import BrowserDrawer from './sidebar/drawers/BrowserDrawer';
import FilesDrawer from './sidebar/drawers/FilesDrawer';
import DesktopDrawer from './sidebar/drawers/DesktopDrawer';

interface SidebarProps {
  onViewChange: (view: View) => void;
  onNewChat: () => void;
  onLoadConversation: (conversationId: string, buffer?: Array<{ type: string; data: any }> | null) => void;
  onOpenProcess: (processId: string) => void;
  chatKey: number;
}

export default function Sidebar({
  onViewChange, onNewChat, onLoadConversation, onOpenProcess, chatKey,
}: SidebarProps) {
  const [activeMode, setActiveMode] = useState<DrawerMode>('chat');
  const [drawerOpen, setDrawerOpen] = useState(true);

  // Ctrl+S toggles drawer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && !e.shiftKey) {
        e.preventDefault();
        setDrawerOpen(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleModeChange = (mode: DrawerMode) => {
    if (activeMode === mode) {
      setDrawerOpen(v => !v); // toggle if clicking active
    } else {
      setActiveMode(mode);
      setDrawerOpen(true);
    }
  };

  const handleAddContext = async (text: string, _filePath: string) => {
    const api = (window as any).clawdia;
    if (!api) return;
    await api.chat.addContext(text).catch(() => {});
  };

  return (
    <nav className="flex h-full flex-shrink-0">
      <Rail
        activeMode={drawerOpen ? activeMode : null}
        onModeChange={handleModeChange}
        onSettings={() => onViewChange('settings')}
      />

      {drawerOpen && (
        <div className="w-[210px] flex-shrink-0 bg-[#0c0c16] border-r border-[#141420] flex flex-col overflow-hidden">
          {activeMode === 'chat' && (
            <ChatDrawer
              onNewChat={onNewChat}
              onLoadConversation={onLoadConversation}
              onOpenProcess={onOpenProcess}
              chatKey={chatKey}
            />
          )}
          {activeMode === 'agents' && (
            <AgentsDrawer
              onNewChat={onNewChat}
              onOpenProcess={onOpenProcess}
            />
          )}
          {activeMode === 'browser' && <BrowserDrawer />}
          {activeMode === 'files' && <FilesDrawer onAddContext={handleAddContext} />}
          {activeMode === 'desktop' && <DesktopDrawer />}
        </div>
      )}
    </nav>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat: replace Sidebar with rail + context drawer shell"
```

---

## Task 11: Update App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Remove `sidebarCollapsed` state**

Find and remove this line:
```tsx
const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
```

- [ ] **Step 2: Remove `Ctrl+S` handler from `App.tsx`**

Find the keyboard handler `useEffect`. Remove this line from inside it:
```tsx
if (ctrl && e.key === 's' && !e.shiftKey) { e.preventDefault(); setSidebarCollapsed(v => !v); }
```

- [ ] **Step 3: Update the `<Sidebar>` JSX**

Replace the current `<Sidebar ... />` usage with:

```tsx
<Sidebar
  onViewChange={setActiveView}
  onNewChat={handleNewChat}
  onLoadConversation={handleLoadConversation}
  onOpenProcess={handleOpenProcess}
  chatKey={chatKey}
/>
```

Remove any props that are gone: `activeView`, `collapsed`, `onToggleCollapse`, `activeProcessId`.

- [ ] **Step 4: Verify TypeScript compiles with no errors**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit 2>&1
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: update App.tsx — remove sidebarCollapsed, wire new Sidebar props"
```

---

## Task 12: Smoke Test

- [ ] **Step 1: Build and launch the app**

```bash
cd /home/dp/Desktop/clawdia4.0 && npm run dev
```

- [ ] **Step 2: Verify rail renders**

Confirm: 48px icon rail visible on left, C logo at top, 5 mode icons + gear at bottom.

- [ ] **Step 3: Test drawer switching**

Click each rail icon: Chat → Agents → Browser → Files → Desktop. Confirm drawer content changes each time.

- [ ] **Step 4: Test drawer toggle**

Click the active icon — confirm drawer collapses to rail-only. Click it again — drawer reopens. Press `Ctrl+S` — toggles drawer. Confirm `Ctrl+S` no longer has any effect in `App.tsx`.

- [ ] **Step 5: Test Chat drawer**

Confirm history loads, search filters, clicking a conversation loads it, delete button appears on hover.

- [ ] **Step 6: Test Agents drawer**

Start a task. Confirm it appears in Running section. Confirm slash commands are clickable and prefill the input bar.

- [ ] **Step 7: Test Browser drawer**

Browse to any site in the browser panel. Click Browser drawer — confirm the domain appears in Active Sessions. Click "Clear" — confirm it disappears.

- [ ] **Step 8: Test Files drawer**

Confirm home directory loads. Click a folder — confirm it expands. Click a text file — confirm chat receives a context injection.

- [ ] **Step 9: Test Desktop drawer**

Confirm running apps list appears (on Linux). Click ↗ on an app — confirm it comes to front. Confirm ✕ sends SIGTERM.

- [ ] **Step 10: Test Settings navigation**

Click gear icon — confirm `SettingsView` opens. Press Escape — returns to chat.

- [ ] **Step 11: Final commit**

```bash
git add -A
git commit -m "feat: sidebar redesign phase 1 complete — rail + functional drawers"
```
