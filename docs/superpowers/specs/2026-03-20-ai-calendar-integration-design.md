# AI Calendar Integration — Design Spec

**Date:** 2026-03-20
**Status:** Approved

---

## Summary

Integrate a fully AI-aware calendar into Clawdia. The AI can read, create, update, and delete calendar events via a CLI tool (`clawdia-cal`) using the existing CLIanything / `shell_exec` mechanism. Events are stored in a local SQLite database. The calendar UI updates live when events change, and today's schedule is automatically injected into the AI's context at the start of every run.

---

## Goals

- AI has full read/write control over the user's calendar via `clawdia-cal` CLI
- Calendar panel in the UI shows event dots on days and event details on selected date
- UI live-updates within ~200ms of any CLI write (no polling)
- Today's events are passively injected into the AI's system prompt on every run
- The calendar toggle button in ChatPanel header wires up the already-built Calendar.tsx

---

## Non-Goals

- External calendar sync (Google Calendar, iCal) — future work
- Recurring events — out of scope for v1
- Notifications / reminders — out of scope for v1

---

## Architecture

### Data store

A separate SQLite file at `~/.config/Clawdia/calendar.sqlite` (isolated from the main `data.sqlite`). Managed by `src/main/db/calendar.ts` using the existing `better-sqlite3` dependency.

**Table: `calendar_events`**

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `title` | TEXT NOT NULL | Event name |
| `date` | TEXT NOT NULL | ISO 8601: `YYYY-MM-DD` |
| `start_time` | TEXT | `HH:MM`, nullable = all-day |
| `duration` | INTEGER | minutes, nullable |
| `notes` | TEXT | optional |
| `created_at` | TEXT NOT NULL | ISO timestamp |
| `updated_at` | TEXT NOT NULL | ISO timestamp |

---

### CLI: `scripts/clawdia-cal`

Node.js script, executable, added to PATH via Electron's app launch environment or called with full path.

**Commands:**

```
clawdia-cal add "Title" --date YYYY-MM-DD [--time HH:MM] [--duration N] [--notes "..."]
clawdia-cal list [--date YYYY-MM-DD] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
clawdia-cal update <id> [--title "..."] [--date ...] [--time ...] [--duration ...] [--notes "..."]
clawdia-cal delete <id>
clawdia-cal get <id>
```

All commands output JSON to stdout. Errors output `{"error":"..."}` to stderr and exit 1.

Default for `list` with no args: today's events.

---

### Live update flow

1. CLI writes to `calendar.sqlite`
2. `src/main/calendar-watcher.ts` uses `fs.watch` on the file with 150ms debounce
3. On change: reads all events, pushes via `mainWindow.webContents.send('calendar:events-changed', events)`
4. `Calendar.tsx` subscribes via `window.clawdia.calendar.onEventsChanged(cb)` and calls `setEvents(events)`

Total latency: <200ms.

---

### IPC additions

**`src/shared/ipc-channels.ts`:**
- `CALENDAR_LIST: 'calendar:list'` — renderer requests current events
- `CALENDAR_EVENTS_CHANGED: 'calendar:events-changed'` — main pushes to renderer on change

**`src/main/preload.ts`** — new `window.clawdia.calendar` namespace:
- `list(from?, to?): Promise<CalendarEvent[]>`
- `onEventsChanged(cb): () => void` (returns unsubscribe fn)

---

### UI changes

**`Calendar.tsx`:**
- Accept `events: CalendarEvent[]` prop (or fetch via IPC on mount)
- Event dots: 1–3 small dots below the day number when events exist
- Selected date footer: expands to show event cards (title, time, duration) instead of just the date label
- Subscribes to `onEventsChanged` and updates local state

**`ChatPanel.tsx`:**
- Add calendar icon toggle button to header (next to settings)
- Render `<Calendar events={events} />` when `calendarOpen === true`

---

### AI context injection

In `src/main/agent/loop.ts`, before building the system prompt, run `clawdia-cal list` (today) and prepend:

```
Today is <weekday> <date>.
Your schedule today:
  - HH:MM  Title (N min)
  ...
```

If no events: `Today is <weekday> <date>. No events scheduled.`

---

### CLIanything registration

In `src/main/agent/tool-builder.ts`, extend the `shell_exec` tool description to mention `clawdia-cal`:

```
Use clawdia-cal to manage the user's calendar.
Commands: add, list, update, delete, get.
Example: clawdia-cal add "Meeting" --date 2026-03-21 --time 14:00 --duration 60
Always confirm with the user before deleting events.
```

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `scripts/clawdia-cal` | CLI entrypoint — parses args, calls db |
| Create | `src/main/db/calendar.ts` | SQLite CRUD layer for `calendar_events` |
| Create | `src/main/calendar-watcher.ts` | `fs.watch` + debounce + IPC push |
| Modify | `src/shared/ipc-channels.ts` | Add 2 new channel constants |
| Modify | `src/main/preload.ts` | Expose `window.clawdia.calendar.*` |
| Modify | `src/main/main.ts` | Register IPC handlers, start watcher |
| Modify | `src/renderer/components/Calendar.tsx` | Add events prop, dots, event list |
| Modify | `src/renderer/components/ChatPanel.tsx` | Toggle button + render Calendar |
| Modify | `src/main/agent/loop.ts` | Inject today's events into system prompt |
| Modify | `src/main/agent/tool-builder.ts` | Document clawdia-cal in shell_exec description |
