import {
  calendarAdd,
  calendarDelete,
  calendarGet,
  calendarList,
  calendarUpdate,
} from '../../../db/calendar';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function out(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseOptionalDuration(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('duration must be a non-negative number of minutes');
  }
  return Math.trunc(parsed);
}

function requireDate(value: unknown, fieldName: string): string {
  const date = asOptionalString(value);
  if (!date || !DATE_RE.test(date)) {
    throw new Error(`${fieldName} must be in YYYY-MM-DD format`);
  }
  return date;
}

function requireTime(value: unknown, fieldName: string): string {
  const time = asOptionalString(value);
  if (!time || !TIME_RE.test(time)) {
    throw new Error(`${fieldName} must be in HH:MM format`);
  }
  return time;
}

export async function executeCalendarManage(input: Record<string, any>): Promise<string> {
  try {
    const action = asOptionalString(input.action);
    if (!action) return '[Error] calendar_manage requires an action';

    switch (action) {
      case 'add': {
        const title = asOptionalString(input.title);
        if (!title) return '[Error] calendar_manage add requires title';
        const date = requireDate(input.date, 'date');
        const time = input.time == null ? undefined : requireTime(input.time, 'time');
        const duration = parseOptionalDuration(input.duration);
        const notes = asOptionalString(input.notes);
        return out(calendarAdd({ title, date, start_time: time, duration, notes }));
      }

      case 'list': {
        const date = input.date == null ? undefined : requireDate(input.date, 'date');
        const from = input.from == null ? undefined : requireDate(input.from, 'from');
        const to = input.to == null ? undefined : requireDate(input.to, 'to');
        return out(calendarList({ date, from, to }));
      }

      case 'get': {
        const id = asOptionalString(input.id);
        if (!id) return '[Error] calendar_manage get requires id';
        const event = calendarGet(id);
        return event ? out(event) : `[Error] No event found with id: ${id}`;
      }

      case 'update': {
        const id = asOptionalString(input.id);
        if (!id) return '[Error] calendar_manage update requires id';
        const next = calendarUpdate(id, {
          title: input.title !== undefined ? asOptionalString(input.title) : undefined,
          date: input.date !== undefined ? requireDate(input.date, 'date') : undefined,
          start_time: input.time !== undefined
            ? (input.time === null || input.time === '' ? null : requireTime(input.time, 'time'))
            : undefined,
          duration: input.duration !== undefined
            ? (input.duration === null || input.duration === '' ? null : parseOptionalDuration(input.duration) ?? null)
            : undefined,
          notes: input.notes !== undefined
            ? (input.notes === null ? null : asOptionalString(input.notes) ?? null)
            : undefined,
        });
        return next ? out(next) : `[Error] No event found with id: ${id}`;
      }

      case 'delete': {
        const id = asOptionalString(input.id);
        if (!id) return '[Error] calendar_manage delete requires id';
        return calendarDelete(id) ? out({ deleted: true, id }) : `[Error] No event found with id: ${id}`;
      }

      default:
        return `[Error] Unknown calendar_manage action: ${action}`;
    }
  } catch (err: any) {
    return `[Error] ${err?.message || String(err)}`;
  }
}
