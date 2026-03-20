/**
 * Calendar DB — SQLite CRUD for calendar_events.
 * Uses a separate calendar.sqlite file in the same userData dir as data.sqlite.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';

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
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'calendar.sqlite');
}

export function getCalDb(): Database.Database {
  if (calDb) return calDb;
  const dbPath = getCalDbPath();
  calDb = new Database(dbPath);
  calDb.pragma('journal_mode = WAL');
  calDb.pragma('synchronous = NORMAL');
  calDb.pragma('foreign_keys = ON');
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
  calDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_cal_events_date ON calendar_events(date)
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
