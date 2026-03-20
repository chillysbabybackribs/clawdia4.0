/**
 * Calendar Watcher — watches calendar.sqlite for changes and pushes
 * updated events to the renderer via IPC.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '../shared/ipc-channels';
import { calendarListRange, getCalDbFilePath } from './db/calendar';

const DEBOUNCE_MS = 150;

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function startCalendarWatcher(win: BrowserWindow): void {
  const dbPath = getCalDbFilePath();

  // Watch the directory so we catch file creation (calendar.sqlite may not exist yet on first run)
  const dir = path.dirname(dbPath);
  const filename = path.basename(dbPath);

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
