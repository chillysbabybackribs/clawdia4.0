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

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

interface CalDay {
  date: Date;
  day: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  weekNum: number;
  isFirstOfRow: boolean;
}

function buildGrid(year: number, month: number): CalDay[][] {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  // Start grid on Sunday of the week containing the 1st
  const startDate = new Date(firstDay);
  startDate.setDate(firstDay.getDate() - firstDay.getDay());

  // End grid on Saturday of the week containing the last day
  const endDate = new Date(lastDay);
  endDate.setDate(lastDay.getDate() + (6 - lastDay.getDay()));

  const weeks: CalDay[][] = [];
  const cursor = new Date(startDate);

  while (cursor <= endDate) {
    const week: CalDay[] = [];
    for (let d = 0; d < 7; d++) {
      const isFirst = d === 0;
      const dateStr = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
      week.push({
        date: new Date(cursor),
        day: cursor.getDate(),
        isCurrentMonth: cursor.getMonth() === month,
        isToday: dateStr === todayStr,
        weekNum: getWeekNumber(cursor),
        isFirstOfRow: isFirst,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  return weeks;
}

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

  const weeks = useMemo(() => buildGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };
  const goToday = () => {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    setSelectedDate(today);
  };

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const selectedLabel = selectedDate
    ? selectedDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div className="flex flex-col h-full select-none" style={{ background: '#0d0d10' }}>

      {/* ── Month navigation header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '28px 48px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 28, fontWeight: 300, color: '#fff', letterSpacing: '-0.02em' }}>
            {MONTHS[viewMonth]}
          </span>
          <span style={{ fontSize: 18, fontWeight: 300, color: 'rgba(255,255,255,0.3)', letterSpacing: '-0.01em' }}>
            {viewYear}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={goToday}
            style={{
              padding: '4px 12px', borderRadius: 6,
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              cursor: 'pointer', transition: 'all 0.12s',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.4)';
              (e.currentTarget as HTMLElement).style.color = '#fff';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.2)';
              (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.7)';
            }}
          >
            Today
          </button>
          <button onClick={prevMonth} style={navBtnStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLElement).style.color = '#fff'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.4)'; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <button onClick={nextMonth} style={navBtnStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLElement).style.color = '#fff'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.4)'; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        </div>
      </div>

      {/* ── Calendar grid ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '0 48px 24px', minHeight: 0 }}>

        {/* Weekday headers + week# column */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '36px repeat(7, 1fr)',
          paddingTop: 20,
          paddingBottom: 8,
          marginBottom: 4,
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          flexShrink: 0,
        }}>
          <div /> {/* week# header — empty */}
          {WEEKDAYS.map((d, i) => (
            <div key={i} style={{
              textAlign: 'center',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.22)',
            }}>{d}</div>
          ))}
        </div>

        {/* Weeks */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-around', minHeight: 0 }}>
          {weeks.map((week, wi) => (
            <div key={wi} style={{
              display: 'grid',
              gridTemplateColumns: '36px repeat(7, 1fr)',
              flex: 1,
              alignItems: 'center',
            }}>
              {/* Week number */}
              <div style={{
                fontSize: 9,
                color: 'rgba(255,255,255,0.15)',
                textAlign: 'center',
                fontWeight: 500,
                letterSpacing: '0.04em',
              }}>
                {week[0].weekNum}
              </div>

              {/* Days */}
              {week.map((day, di) => {
                const isSelected = selectedDate ? isSameDay(day.date, selectedDate) : false;
                const isToday = day.isToday;
                const isCurrent = day.isCurrentMonth;

                let bg = 'transparent';
                let color = isCurrent ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.16)';
                let border = 'none';
                let fontWeight: number = 400;
                let boxShadow = 'none';

                if (isSelected) {
                  bg = 'transparent';
                  color = '#fff';
                  fontWeight = 700;
                  border = '1px solid rgba(255,255,255,0.6)';
                  boxShadow = 'none';
                } else if (isToday) {
                  color = '#fff';
                  fontWeight = 700;
                  border = '1px solid rgba(255,255,255,0.35)';
                  bg = 'rgba(255,255,255,0.05)';
                }

                const dateKey = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}-${String(day.date.getDate()).padStart(2, '0')}`;
                const dayEvents = eventsByDate.get(dateKey) || [];

                return (
                  <div
                    key={di}
                    onClick={() => setSelectedDate(day.date)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer',
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight,
                      color,
                      background: bg,
                      border,
                      boxShadow,
                      height: 'calc(100% - 6px)',
                      margin: '3px',
                      transition: 'background 0.1s, color 0.1s, box-shadow 0.1s',
                      position: 'relative',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) {
                        (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)';
                        if (!isToday) (e.currentTarget as HTMLElement).style.color = '#fff';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) {
                        (e.currentTarget as HTMLElement).style.background = isToday ? 'rgba(255,255,255,0.05)' : 'transparent';
                        (e.currentTarget as HTMLElement).style.color = color;
                      }
                    }}
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
                );
              })}
            </div>
          ))}
        </div>
      </div>

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
    </div>
  );
}

const navBtnStyle: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 7,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
  color: 'rgba(255,255,255,0.4)',
  transition: 'background 0.12s, color 0.12s',
};
