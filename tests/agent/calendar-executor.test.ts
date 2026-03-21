import { beforeEach, describe, expect, it, vi } from 'vitest';

const calendarAdd = vi.fn();
const calendarDelete = vi.fn();
const calendarGet = vi.fn();
const calendarList = vi.fn();
const calendarUpdate = vi.fn();

vi.mock('../../src/main/db/calendar', () => ({
  calendarAdd: (...args: any[]) => calendarAdd(...args),
  calendarDelete: (...args: any[]) => calendarDelete(...args),
  calendarGet: (...args: any[]) => calendarGet(...args),
  calendarList: (...args: any[]) => calendarList(...args),
  calendarUpdate: (...args: any[]) => calendarUpdate(...args),
}));

describe('calendar-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds a calendar event without shell quoting risk', async () => {
    calendarAdd.mockReturnValue({
      id: 'evt1',
      title: `Daniel's reminder`,
      date: '2026-03-22',
      start_time: '09:00',
      duration: 30,
      notes: null,
    });

    const { executeCalendarManage } = await import('../../src/main/agent/executors/core/calendar-executor');
    const raw = await executeCalendarManage({
      action: 'add',
      title: `Daniel's reminder`,
      date: '2026-03-22',
      time: '09:00',
      duration: 30,
    });

    expect(calendarAdd).toHaveBeenCalledWith({
      title: `Daniel's reminder`,
      date: '2026-03-22',
      start_time: '09:00',
      duration: 30,
      notes: undefined,
    });
    expect(JSON.parse(raw).title).toBe(`Daniel's reminder`);
  });

  it('validates date format and returns an error string', async () => {
    const { executeCalendarManage } = await import('../../src/main/agent/executors/core/calendar-executor');
    const raw = await executeCalendarManage({
      action: 'add',
      title: 'Bad date',
      date: 'tomorrow',
    });

    expect(raw).toContain('[Error]');
    expect(calendarAdd).not.toHaveBeenCalled();
  });

  it('lists calendar events by range', async () => {
    calendarList.mockReturnValue([{ id: 'evt1', title: 'Standup', date: '2026-03-22' }]);
    const { executeCalendarManage } = await import('../../src/main/agent/executors/core/calendar-executor');
    const raw = await executeCalendarManage({
      action: 'list',
      from: '2026-03-22',
      to: '2026-03-30',
    });

    expect(calendarList).toHaveBeenCalledWith({ date: undefined, from: '2026-03-22', to: '2026-03-30' });
    expect(JSON.parse(raw)).toHaveLength(1);
  });
});
