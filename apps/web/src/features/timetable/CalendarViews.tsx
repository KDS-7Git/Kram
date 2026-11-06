import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import { dateRange, weekStartDate } from '@kram/time';
import type { Goal, Occurrence, TimeSlot } from '@kram/shared';
import { Card, Button } from '../../components/ui/kit';
import { useData } from '../../shared/data';
import { allocatedMinutes, calendarDate, clockLabel, duration } from '../../shared/format';

export type CalendarView = 'day' | 'week' | 'month' | 'agenda';
export const layerLabels = { unavailable: 'Unavailable', fixed: 'Fixed', pinned: 'Pinned', reserved: 'Reserved', flexible: 'Flexible' };
export const occurrenceLink = (item: { recurrenceSeriesId?: string; originalDate?: string; date: string }) => `/schedules?seriesId=${item.recurrenceSeriesId}&date=${item.originalDate || item.date}`;
export function calendarWindow(date: string, view: CalendarView, weekStart: 1 | 7) {
  const local = DateTime.fromISO(date, { zone: 'UTC' });
  if (view === 'week') { const from = weekStartDate(date, weekStart); return { from, to: DateTime.fromISO(from, { zone: 'UTC' }).plus({ days: 6 }).toISODate()! }; }
  if (view === 'month') return { from: weekStartDate(local.startOf('month').toISODate()!, weekStart), to: DateTime.fromISO(weekStartDate(local.endOf('month').toISODate()!, weekStart), { zone: 'UTC' }).plus({ days: 6 }).toISODate()! };
  return { from: date, to: view === 'agenda' ? local.plus({ days: 20 }).toISODate()! : date };
}
export function RecurringWork({ items }: { items: Occurrence[] }) {
  return items.length ? <ul className="calendar-work">{items.map(item => <li key={item.id}><Link to={`/schedules?seriesId=${item.seriesId}&date=${item.originalDate}`}>{item.fields.title}</Link><span className="caption">Repeating goal · {duration(item.fields.estMinutes)}{item.virtual ? ' · upcoming' : ''}</span></li>)}</ul> : null;
}
export function CalendarRange({ view, date, from, to, slots, occurrences, goals, onDate, onEdit }: {
  view: Exclude<CalendarView, 'day'>; date: string; from: string; to: string; slots: TimeSlot[]; occurrences: Occurrence[]; goals: Goal[]; onDate: (value: string) => void; onEdit: (slot: TimeSlot) => void;
}) {
  const data = useData();
  const days = dateRange(from, to).filter(day => view !== 'agenda' || slots.some(slot => slot.date === day) || occurrences.some(item => item.localDate === day && item.status !== 'suppressed') || goals.some(goal => goal.dueDate === day));
  const profileColor = (slot: TimeSlot): CSSProperties => { const profile = data.profiles.find(profile => profile.id === slot.profileId); return profile ? { borderInlineStartColor: `var(--profile-${profile.color})` } : {}; };
  return <div className={`calendar-range calendar-${view}`} aria-label={`${view} timetable`}>
    {!days.length && <Card><p className="muted">No blocks or deadlines in this range. Add a commitment or apply a weekly template.</p></Card>}
    {days.map(day => {
      const blocks = slots.filter(slot => slot.date === day), recurring = occurrences.filter(item => item.localDate === day && item.series.kind === 'goal' && item.status === 'scheduled'), deadlines = goals.filter(goal => goal.dueDate === day && !goal.archivedAt && goal.status === 'active');
      return <section key={day} className={`calendar-date${day === data.studyDate ? ' calendar-today' : ''}${view === 'month' && day.slice(0, 7) !== date.slice(0, 7) ? ' calendar-outside' : ''}`} aria-label={calendarDate(day)}>
        <Button variant="text" onClick={() => onDate(day)} aria-label={`Open day ${calendarDate(day)}`}><strong>{DateTime.fromISO(day).toFormat(view === 'month' ? 'ccc d' : 'ccc, d LLL')}</strong></Button>
        <p className="caption">{blocks.length} blocks · {duration(allocatedMinutes(blocks))} allocated</p>
        {view !== 'month' && <ul className="calendar-blocks">{blocks.map(slot => <li key={slot.id} style={profileColor(slot)}><button type="button" className="calendar-block" onClick={() => onEdit(slot)} aria-label={`Edit block ${slot.title} on ${calendarDate(day)}`}><strong>{slot.title}</strong><span className="caption">{clockLabel(slot.startMin, data.user.settings.clockFormat)}–{clockLabel(slot.endMin, data.user.settings.clockFormat)} · {layerLabels[slot.layer]}{slot.recurrenceSeriesId ? ' · repeats' : ''}</span></button>{slot.taskId && <Link className="caption" to={`/tasks/${slot.taskId}`}>Open task</Link>}</li>)}</ul>}
        {view === 'month' ? <><div className="calendar-profiles">{[...new Set(blocks.map(slot => slot.profileId).filter(Boolean))].map(id => { const profile = data.profiles.find(row => row.id === id); return profile ? <span className="caption" key={id} style={{ borderInlineStart: `3px solid var(--profile-${profile.color})`, paddingInlineStart: '.5rem' }}>{profile.name}</span> : null; })}</div>{blocks.some(slot => slot.recurrenceSeriesId) && <p className="caption">{blocks.filter(slot => slot.recurrenceSeriesId).length} repeating commitments</p>}{recurring.length > 0 && <p className="caption">{recurring.length} repeating goals</p>}</> : <RecurringWork items={recurring} />}
        {deadlines.map(goal => <Link className="calendar-deadline" key={goal.id} to={`/goals/${goal.id}`}>Due: {goal.title}</Link>)}
        {!blocks.length && !recurring.length && !deadlines.length && view !== 'month' && <p className="caption">Room to plan</p>}
      </section>;
    })}
  </div>;
}
