# AI Calendar Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing Calendar UI to a local SQLite store, expose a `clawdia-cal` CLI so the AI can manage events via `shell_exec`, and live-push changes to the renderer via `fs.watch` + IPC.

**Architecture:** `clawdia-cal` CLI writes to `~/.config/Clawdia/calendar.sqlite`. Electron main process watches that file and pushes changes to the renderer via IPC. `Calendar.tsx` renders event dots and a day-view event list. Today's events are injected into the AI's dynamic prompt on every run. The CLI is invoked via its absolute path (`/home/dp/Desktop/clawdia4.0/scripts/clawdia-cal`) — no PATH injection required. The AI uses `shell_exec` with the full path.

**Tech Stack:** better-sqlite3, Node.js crypto.randomUUID, Electron IPC (ipcMain/ipcRenderer), fs.watch, React useState/useEffect

---

## File Map

| Action | File |
|---|---|
| Create | `scripts/clawdia-cal` |
| Create | `src/main/db/calendar.ts` |
| Create | `src/main/calendar-watcher.ts` |
| Modify | `src/shared/ipc-channels.ts` |
| Modify | `src/main/preload.ts` |
| Modify | `src/main/main.ts` |
| Modify | `src/renderer/components/Calendar.tsx` |
| Modify | `src/main/agent/prompt-builder.ts` |
| Modify | `src/main/agent/tool-builder.ts` |

---

## Task 1: SQLite calendar DB layer

**Files:**
- Create: `src/main/db/calendar.ts`

- [ ] **Step 1: Create `src/main/db/calendar.ts`**

```typescript
/**
 * Calendar DB — SQLite CRUD for calendar_events.
 * Uses a separate calendar.sqlite file in the same userData dir as data.sqlite.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;       // YYYY-MM-DD
  start_time: string | null;  // HH:MM
  duration: number | null;    // minutes
  notes: string | null;
  created_at: string;
  updated_at: string;
}

let calDb: Database.Database | null = null;

function getCalDbPath(): string {
  if (process.env.CLAWDIA_CAL_DB_PATH) return process.env.CLAWDIA_CAL_DB_PATH;
  // Reuse same userData dir as main DB
  const { app } = require('electron');
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'calendar.sqlite');
}

export function getCalDb(): Database.Database {
  if (calDb) return calDb;
  const dbPath = getCalDbPath();
  calDb = new Database(dbPath);
  calDb.pragma('journal_mode = WAL');
  calDb.exec(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      date       TEXT NOT NULL,
      start_time TEXT,
      duration   INTEGER,
      notes      TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return calDb;
}

export function calendarAdd(opts: {
  title: string;
  date: string;
  start_time?: string;
  duration?: number;
  notes?: string;
}): CalendarEvent {
  const db = getCalDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO calendar_events (id, title, date, start_time, duration, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.title, opts.date, opts.start_time ?? null, opts.duration ?? null, opts.notes ?? null, now, now);
  return calendarGet(id)!;
}

export function calendarList(opts: { date?: string; from?: string; to?: string } = {}): CalendarEvent[] {
  const db = getCalDb();
  if (opts.date) {
    return db.prepare('SELECT * FROM calendar_events WHERE date = ? ORDER BY start_time ASC NULLS LAST').all(opts.date) as CalendarEvent[];
  }
  if (opts.from || opts.to) {
    const from = opts.from || '0000-01-01';
    const to = opts.to || '9999-12-31';
    return db.prepare('SELECT * FROM calendar_events WHERE date >= ? AND date <= ? ORDER BY date ASC, start_time ASC NULLS LAST').all(from, to) as CalendarEvent[];
  }
  // Default: today
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare('SELECT * FROM calendar_events WHERE date = ? ORDER BY start_time ASC NULLS LAST').all(today) as CalendarEvent[];
}

export function calendarGet(id: string): CalendarEvent | null {
  return (getCalDb().prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as CalendarEvent) || null;
}

export function calendarUpdate(id: string, opts: {
  title?: string;
  date?: string;
  start_time?: string | null;
  duration?: number | null;
  notes?: string | null;
}): CalendarEvent | null {
  const db = getCalDb();
  const existing = calendarGet(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE calendar_events
    SET title = ?, date = ?, start_time = ?, duration = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `).run(
    opts.title ?? existing.title,
    opts.date ?? existing.date,
    'start_time' in opts ? opts.start_time : existing.start_time,
    'duration' in opts ? opts.duration : existing.duration,
    'notes' in opts ? opts.notes : existing.notes,
    now,
    id
  );
  return calendarGet(id);
}

export function calendarDelete(id: string): boolean {
  const result = getCalDb().prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
  return result.changes > 0;
}

export function calendarListRange(from: string, to: string): CalendarEvent[] {
  return getCalDb().prepare(
    'SELECT * FROM calendar_events WHERE date >= ? AND date <= ? ORDER BY date ASC, start_time ASC NULLS LAST'
  ).all(from, to) as CalendarEvent[];
}

export function getCalDbFilePath(): string {
  return getCalDbPath();
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add src/main/db/calendar.ts
git commit -m "feat: add calendar SQLite DB layer (calendar_events table)"
```

---

## Task 2: `clawdia-cal` CLI

**Files:**
- Create: `scripts/clawdia-cal`

- [ ] **Step 1: Create `scripts/clawdia-cal`**

```javascript
#!/usr/bin/env node
/**
 * clawdia-cal — CLI for managing Clawdia calendar events.
 * Used by the AI via shell_exec. All output is JSON.
 *
 * Commands:
 *   add "Title" --date YYYY-MM-DD [--time HH:MM] [--duration N] [--notes "..."]
 *   list [--date YYYY-MM-DD] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   update <id> [--title "..."] [--date ...] [--time ...] [--duration N] [--notes "..."]
 *   delete <id>
 *   get <id>
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

// ── DB setup ──────────────────────────────────────────────────────────────────

function getDbPath() {
  if (process.env.CLAWDIA_CAL_DB_PATH) return process.env.CLAWDIA_CAL_DB_PATH;
  const dir = path.join(os.homedir(), '.config', 'Clawdia');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'calendar.sqlite');
}

function getDb() {
  const db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      date       TEXT NOT NULL,
      start_time TEXT,
      duration   INTEGER,
      notes      TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

// ── Arg parser ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[key] = val;
    } else {
      positional.push(argv[i]);
    }
    i++;
  }
  return { positional, flags };
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmdAdd(positional, flags) {
  const title = positional[0];
  if (!title) die('add requires a title as the first argument');
  if (!flags.date) die('add requires --date YYYY-MM-DD');
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO calendar_events (id, title, date, start_time, duration, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, title, flags.date,
    flags.time || null,
    flags.duration ? parseInt(flags.duration, 10) : null,
    flags.notes || null,
    now, now
  );
  const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  out(event);
}

function cmdList(flags) {
  const db = getDb();
  let rows;
  if (flags.date) {
    rows = db.prepare('SELECT * FROM calendar_events WHERE date = ? ORDER BY start_time ASC NULLS LAST').all(flags.date);
  } else if (flags.from || flags.to) {
    const from = flags.from || '0000-01-01';
    const to = flags.to || '9999-12-31';
    rows = db.prepare('SELECT * FROM calendar_events WHERE date >= ? AND date <= ? ORDER BY date ASC, start_time ASC NULLS LAST').all(from, to);
  } else {
    const today = new Date().toISOString().slice(0, 10);
    rows = db.prepare('SELECT * FROM calendar_events WHERE date = ? ORDER BY start_time ASC NULLS LAST').all(today);
  }
  out(rows);
}

function cmdUpdate(positional, flags) {
  const id = positional[0];
  if (!id) die('update requires an event id');
  const db = getDb();
  const existing = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  if (!existing) die(`No event found with id: ${id}`);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE calendar_events
    SET title = ?, date = ?, start_time = ?, duration = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `).run(
    flags.title !== undefined ? flags.title : existing.title,
    flags.date !== undefined ? flags.date : existing.date,
    flags.time !== undefined ? flags.time : existing.start_time,
    flags.duration !== undefined ? parseInt(flags.duration, 10) : existing.duration,
    flags.notes !== undefined ? flags.notes : existing.notes,
    now, id
  );
  out(db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id));
}

function cmdDelete(positional) {
  const id = positional[0];
  if (!id) die('delete requires an event id');
  const db = getDb();
  const result = db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
  if (result.changes === 0) die(`No event found with id: ${id}`);
  out({ deleted: true, id });
}

function cmdGet(positional) {
  const id = positional[0];
  if (!id) die('get requires an event id');
  const event = getDb().prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  if (!event) die(`No event found with id: ${id}`);
  out(event);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function die(msg) {
  process.stderr.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(1);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (!argv.length) {
  out({ usage: 'clawdia-cal <add|list|update|delete|get> [args]' });
  process.exit(0);
}

const command = argv[0];
const { positional, flags } = parseArgs(argv.slice(1));

try {
  switch (command) {
    case 'add':    cmdAdd(positional, flags); break;
    case 'list':   cmdList(flags); break;
    case 'update': cmdUpdate(positional, flags); break;
    case 'delete': cmdDelete(positional); break;
    case 'get':    cmdGet(positional); break;
    default:       die(`Unknown command: ${command}`);
  }
} catch (err) {
  die(err.message);
}
```

- [ ] **Step 2: Make executable**

```bash
chmod +x /home/dp/Desktop/clawdia4.0/scripts/clawdia-cal
```

- [ ] **Step 3: Smoke test — add an event**

```bash
cd /home/dp/Desktop/clawdia4.0
CLAWDIA_CAL_DB_PATH=/tmp/test-cal.sqlite node scripts/clawdia-cal add "Team standup" --date 2026-03-21 --time 10:00 --duration 30
```

Expected: JSON object with `id`, `title`, `date`, `start_time: "10:00"`, `duration: 30`

- [ ] **Step 4: Smoke test — list**

```bash
CLAWDIA_CAL_DB_PATH=/tmp/test-cal.sqlite node scripts/clawdia-cal list --date 2026-03-21
```

Expected: JSON array with the event added above

- [ ] **Step 5: Smoke test — update, delete**

```bash
# Grab the id from step 3 output and substitute below
CLAWDIA_CAL_DB_PATH=/tmp/test-cal.sqlite node scripts/clawdia-cal update <id> --title "Daily standup"
CLAWDIA_CAL_DB_PATH=/tmp/test-cal.sqlite node scripts/clawdia-cal delete <id>
```

Expected: update returns updated event; delete returns `{"deleted":true,"id":"..."}`

- [ ] **Step 6: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add scripts/clawdia-cal
git commit -m "feat: add clawdia-cal CLI for AI calendar management"
```

---

## Task 3: IPC channels + preload

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/main/preload.ts`

- [ ] **Step 1: Add calendar channels to `src/shared/ipc-channels.ts`**

In the `IPC` object, add after `POLICY_LIST`:
```typescript
  CALENDAR_LIST: 'calendar:list',
```

In `IPC_EVENTS`, add after `PROCESS_LIST_CHANGED`:
```typescript
  CALENDAR_EVENTS_CHANGED: 'calendar:events-changed',
```

- [ ] **Step 2: Add `window.clawdia.calendar` to `src/main/preload.ts`**

After the `run:` block (around line 80), add:
```typescript
  calendar: {
    list: (from?: string, to?: string) => invoke('calendar:list', from, to),
    onEventsChanged: (cb: (events: any[]) => void) => on('calendar:events-changed', cb),
  },
```

- [ ] **Step 3: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add src/shared/ipc-channels.ts src/main/preload.ts
git commit -m "feat: add calendar IPC channels and preload bindings"
```

---

## Task 4: Calendar file watcher

**Files:**
- Create: `src/main/calendar-watcher.ts`

- [ ] **Step 1: Create `src/main/calendar-watcher.ts`**

```typescript
/**
 * Calendar Watcher — watches calendar.sqlite for changes and pushes
 * updated events to the renderer via IPC.
 */

import * as fs from 'fs';
import type { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '../shared/ipc-channels';
import { calendarListRange, getCalDbFilePath } from './db/calendar';

const DEBOUNCE_MS = 150;

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function startCalendarWatcher(win: BrowserWindow): void {
  const dbPath = getCalDbFilePath();

  // Ensure the file exists before watching (it's created on first DB access)
  // We'll watch the directory instead so we catch file creation too
  const dir = require('path').dirname(dbPath);
  const filename = require('path').basename(dbPath);

  watcher = fs.watch(dir, (eventType, changedFile) => {
    if (changedFile !== filename && changedFile !== filename + '-wal') return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        // Push 3 months around today so the calendar can display current + nearby months
        const now = new Date();
        const from = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
        const to = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString().slice(0, 10);
        const events = calendarListRange(from, to);
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_EVENTS.CALENDAR_EVENTS_CHANGED, events);
        }
      } catch (err) {
        console.warn('[CalendarWatcher] Failed to push events:', err);
      }
    }, DEBOUNCE_MS);
  });

  watcher.on('error', (err) => console.warn('[CalendarWatcher] Watch error:', err));
  console.log('[CalendarWatcher] Watching', dir, 'for calendar changes');
}

export function stopCalendarWatcher(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (watcher) { watcher.close(); watcher = null; }
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add src/main/calendar-watcher.ts
git commit -m "feat: add calendar file watcher with IPC push"
```

---

## Task 5: Wire calendar into main.ts

**Files:**
- Modify: `src/main/main.ts`

- [ ] **Step 1: Add imports at top of `src/main/main.ts`**

After the existing imports, add:
```typescript
import { startCalendarWatcher, stopCalendarWatcher } from './calendar-watcher';
import { calendarList } from './db/calendar';
import { IPC } from '../shared/ipc-channels';
```

(Note: `IPC` is already imported — just add the other two)

- [ ] **Step 2: Start watcher in `ready-to-show` handler**

The existing handler around line 98:
```typescript
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (mainWindow) {
      initBrowser(mainWindow);
      initProcessManager(mainWindow);
    }
  });
```

Change to:
```typescript
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (mainWindow) {
      initBrowser(mainWindow);
      initProcessManager(mainWindow);
      startCalendarWatcher(mainWindow);
    }
  });
```

- [ ] **Step 3: Add IPC handler in `setupIpcHandlers()`**

After the `ipcMain.handle(IPC.POLICY_LIST, ...)` handler (near the end of `setupIpcHandlers`), add:
```typescript
  ipcMain.handle(IPC.CALENDAR_LIST, (_event, from?: string, to?: string) => {
    return calendarList(from && to ? { from, to } : {});
  });
```

- [ ] **Step 4: Stop watcher on app quit**

Find the `app.on('before-quit', ...)` or `app.on('will-quit', ...)` handler, or the `app.on('window-all-closed', ...)` handler, and add:
```typescript
app.on('will-quit', () => {
  stopCalendarWatcher();
});
```

If no `will-quit` handler exists, add it after the `second-instance` handler.

- [ ] **Step 5: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add src/main/main.ts
git commit -m "feat: register calendar IPC handler and start watcher on app ready"
```

---

## Task 6: Update Calendar.tsx with events

**Files:**
- Modify: `src/renderer/components/Calendar.tsx`

- [ ] **Step 1: Add CalendarEvent type and events prop**

Replace the opening of `Calendar.tsx` (the imports and interface section through `export default function Calendar()`) with:

```typescript
import React, { useState, useMemo, useEffect } from 'react';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  start_time: string | null;
  duration: number | null;
  notes: string | null;
}
```

- [ ] **Step 2: Update the `Calendar` component signature and add event state**

Replace:
```typescript
export default function Calendar() {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
```

With:
```typescript
export default function Calendar() {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);

  // Load events on mount and subscribe to live updates
  useEffect(() => {
    const api = (window as any).clawdia?.calendar;
    if (!api) return;

    // Initial load — 3 months around today
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const to = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString().slice(0, 10);
    api.list(from, to).then((evts: CalendarEvent[]) => setEvents(evts || []));

    // Live updates from watcher
    const unsub = api.onEventsChanged((evts: CalendarEvent[]) => setEvents(evts || []));
    return unsub;
  }, []);

  // Build a map of date string → events for fast lookup
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const evt of events) {
      const list = map.get(evt.date) || [];
      list.push(evt);
      map.set(evt.date, list);
    }
    return map;
  }, [events]);
```

- [ ] **Step 3: Add event dots to day cells**

In the day cell render, find this block (the return inside `week.map`):
```typescript
                return (
                  <div
                    key={di}
                    onClick={() => setSelectedDate(day.date)}
```

Replace with:
```typescript
                const dateKey = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}-${String(day.date.getDate()).padStart(2, '0')}`;
                const dayEvents = eventsByDate.get(dateKey) || [];

                return (
                  <div
                    key={di}
                    onClick={() => setSelectedDate(day.date)}
```

Then find the closing `</div>` of that day cell (after the `{day.day}` text) and replace it:

Find:
```typescript
                  >
                    {day.day}
                  </div>
```

Replace with:
```typescript
                  >
                    {day.day}
                    {dayEvents.length > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'center', gap: 2, position: 'absolute', bottom: 3, left: 0, right: 0 }}>
                        {dayEvents.slice(0, 3).map((_, i) => (
                          <div key={i} style={{ width: 4, height: 4, borderRadius: '50%', background: isSelected ? 'rgba(255,255,255,0.7)' : '#FF5061', opacity: 0.8 }} />
                        ))}
                      </div>
                    )}
                  </div>
```

Also add `position: 'relative'` to the day cell's style object so the absolute dots are positioned correctly.

- [ ] **Step 4: Replace the selected date footer with an event list**

Find the entire footer section:
```typescript
      {/* ── Selected date label ── */}
      <div style={{
        height: 44,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderTop: '1px solid rgba(255,255,255,0.04)',
      }}>
        {selectedLabel ? (
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.02em' }}>
            {selectedLabel}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Select a date
          </span>
        )}
      </div>
```

Replace with:
```typescript
      {/* ── Selected date + event list ── */}
      <div style={{
        flexShrink: 0,
        borderTop: '1px solid rgba(255,255,255,0.04)',
        maxHeight: 200,
        overflowY: 'auto',
        padding: selectedDate ? '12px 48px 16px' : '0 48px',
      }}>
        {selectedDate ? (() => {
          const dateKey = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`;
          const dayEvents = eventsByDate.get(dateKey) || [];
          return (
            <>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.04em', marginBottom: dayEvents.length ? 10 : 0 }}>
                {selectedLabel}
              </div>
              {dayEvents.length === 0 ? (
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.06em', textTransform: 'uppercase', paddingBottom: 4 }}>
                  No events
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {dayEvents.map(evt => (
                    <div key={evt.id} style={{
                      background: 'rgba(255,80,97,0.06)',
                      border: '1px solid rgba(255,80,97,0.15)',
                      borderRadius: 8,
                      padding: '7px 10px',
                    }}>
                      <div style={{ color: '#fff', fontSize: 12, fontWeight: 500 }}>{evt.title}</div>
                      {(evt.start_time || evt.duration) && (
                        <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, marginTop: 2 }}>
                          {evt.start_time}{evt.duration ? ` · ${evt.duration} min` : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          );
        })() : (
          <div style={{ height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Select a date
            </span>
          </div>
        )}
      </div>
```

- [ ] **Step 5: Build and check for TypeScript errors**

```bash
cd /home/dp/Desktop/clawdia4.0
npm run typecheck 2>&1 | head -40
```

Fix any errors before proceeding.

- [ ] **Step 6: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add src/renderer/components/Calendar.tsx
git commit -m "feat: Calendar.tsx shows event dots and event list, subscribes to live IPC updates"
```

---

## Task 7: Inject today's calendar into AI system prompt

**Files:**
- Modify: `src/main/agent/prompt-builder.ts`

- [ ] **Step 1: Add `calendarContext` to `buildDynamicPrompt` opts**

In `buildDynamicPrompt`, add `calendarContext?: string` to the opts type:

Find:
```typescript
  isGreeting?: boolean;
  performanceStance?: PerformanceStance;
```

Replace with:
```typescript
  calendarContext?: string;
  isGreeting?: boolean;
  performanceStance?: PerformanceStance;
```

- [ ] **Step 2: Inject calendarContext into lines**

Find:
```typescript
  if (opts.isGreeting) {
    lines.push('', 'The user sent a greeting. Reply in one sentence — acknowledge and ask what they need.');
  }
```

Add before it:
```typescript
  if (opts.calendarContext) lines.push('', opts.calendarContext);
```

- [ ] **Step 3: Build the calendar context string in `loop.ts`**

In `src/main/agent/loop.ts`, add import at top:
```typescript
import { calendarList } from '../db/calendar';
```

Then in the `buildDynamicPrompt` call (around line 299), add `calendarContext`:

Find:
```typescript
  const dynamicPrompt = buildDynamicPrompt({
    agentProfile: profile.agentProfile,
    model: modelId,
    toolGroup: profile.toolGroup,
    memoryContext: setup.memoryContext,
```

Replace with:
```typescript
  const calendarContext = (() => {
    try {
      const todayEvents = calendarList({});  // reads from calendar.sqlite directly — no subprocess
      const now = new Date();
      const weekday = now.toLocaleDateString([], { weekday: 'long' });
      const dateStr = now.toISOString().slice(0, 10);
      if (!todayEvents.length) return `Today is ${weekday} ${dateStr}. No events scheduled.`;
      const lines = todayEvents.map(e => {
        const time = e.start_time ? `${e.start_time}` : 'All day';
        const dur = e.duration ? ` (${e.duration} min)` : '';
        return `  - ${time}  ${e.title}${dur}`;
      });
      return `Today is ${weekday} ${dateStr}. Your schedule:\n${lines.join('\n')}`;
    } catch { return ''; }
  })();

  const dynamicPrompt = buildDynamicPrompt({
    agentProfile: profile.agentProfile,
    model: modelId,
    toolGroup: profile.toolGroup,
    calendarContext: calendarContext || undefined,
    memoryContext: setup.memoryContext,
```

- [ ] **Step 4: Build check**

```bash
cd /home/dp/Desktop/clawdia4.0
npm run typecheck 2>&1 | head -40
```

- [ ] **Step 5: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add src/main/agent/prompt-builder.ts src/main/agent/loop.ts
git commit -m "feat: inject today's calendar events into AI system prompt"
```

---

## Task 8: Document clawdia-cal in tool description

**Files:**
- Modify: `src/main/agent/tool-builder.ts`

- [ ] **Step 1: Extend `shell_exec` description**

Find:
```typescript
    description: 'Execute a bash command in a persistent shell session. The shell retains cwd between calls. Returns stdout, stderr, and exit code. Use for: installing packages, running builds, launching apps, system queries, git operations. Background GUI processes with & so the command returns.',
```

Replace with:
```typescript
    description: 'Execute a bash command in a persistent shell session. The shell retains cwd between calls. Returns stdout, stderr, and exit code. Use for: installing packages, running builds, launching apps, system queries, git operations. Background GUI processes with & so the command returns.\n\nUse ~/Desktop/clawdia4.0/scripts/clawdia-cal to manage the user\'s calendar: clawdia-cal add "Title" --date YYYY-MM-DD [--time HH:MM] [--duration N] [--notes "..."]; clawdia-cal list [--date YYYY-MM-DD]; clawdia-cal update <id> [--title ...] [--date ...] [--time ...] [--duration N]; clawdia-cal delete <id>; clawdia-cal get <id>. All output is JSON. Always confirm with the user before deleting events.',
```

- [ ] **Step 2: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add src/main/agent/tool-builder.ts
git commit -m "feat: document clawdia-cal in shell_exec tool description"
```

---

## Task 9: End-to-end verification

- [ ] **Step 1: Start the app in dev mode**

```bash
cd /home/dp/Desktop/clawdia4.0
npm run dev
```

- [ ] **Step 2: Add a test event via CLI while app is running**

```bash
node /home/dp/Desktop/clawdia4.0/scripts/clawdia-cal add "E2E test event" --date $(date +%Y-%m-%d) --time 15:00 --duration 45
```

- [ ] **Step 3: Verify live update**

Open the calendar panel in the app (click the date button in the header). Within ~200ms, a dot should appear on today's date. Click today — the event card should appear in the footer.

- [ ] **Step 4: Test AI awareness**

Send a message in the chat. The AI's first response should demonstrate awareness of today's events (it will be in the system prompt context).

- [ ] **Step 5: Test AI creating an event**

Ask the AI: "Add a reminder called 'Review design doc' for tomorrow at 9am, 30 minutes." Verify it calls `clawdia-cal add` and the event appears in the calendar UI.

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
cd /home/dp/Desktop/clawdia4.0
git add -p
git commit -m "fix: e2e calendar integration fixes"
```
