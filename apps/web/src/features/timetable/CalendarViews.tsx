import { useEffect, useRef, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import { dateRange, weekStartDate, weekday } from '@kram/time';
import { AlertCircle, LockKeyhole, Pin } from 'lucide-react';
import type { Goal, Occurrence, TimeSlot } from '@kram/shared';
import { Card, Button } from '../../components/ui/kit';
import { useData } from '../../shared/data';
import { allocatedMinutes, calendarDate, clockLabel, duration } from '../../shared/format';

export type CalendarView = 'day' | 'week' | 'month' | 'agenda';
import { blockLanes, layerLabels } from './layout';
export { blockLanes, layerLabels } from './layout';
export const occurrenceLink = (item: { recurrenceSeriesId?: string; originalDate?: string; date: string }) => `/schedules?seriesId=${item.recurrenceSeriesId}&date=${item.originalDate || item.date}`;
export function calendarWindow(date: string, view: CalendarView, weekStart: 1 | 7) {
  const local = DateTime.fromISO(date, { zone: 'UTC' });
  if (view === 'week') { const from = weekStartDate(date, weekStart); return { from, to: DateTime.fromISO(from, { zone: 'UTC' }).plus({ days: 6 }).toISODate()! }; }
  if (view === 'month') return { from: weekStartDate(local.startOf('month').toISODate()!, weekStart), to: DateTime.fromISO(weekStartDate(local.endOf('month').toISODate()!, weekStart), { zone: 'UTC' }).plus({ days: 6 }).toISODate()! };
  return { from: date, to: view === 'agenda' ? local.plus({ days: 20 }).toISODate()! : date };
}

export function WeekStrip({ date, onDate }: { date: string; onDate: (value: string) => void }) {
  const data = useData();
  const strip = useRef<HTMLDivElement>(null);
  const range = calendarWindow(date, 'week', data.user.settings.weekStart);
  useEffect(() => {
    const group = strip.current;
    const selected = group?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (!group || !selected) return;
    const reveal = () => {
      const outer = group.getBoundingClientRect(), item = selected.getBoundingClientRect();
      if (item.left < outer.left) group.scrollLeft -= outer.left - item.left;
      else if (item.right > outer.right) group.scrollLeft += item.right - outer.right;
    };
    reveal();
    const resize = new ResizeObserver(reveal);
    resize.observe(group);
    resize.observe(selected);
    return () => resize.disconnect();
  }, [date, data.user.settings.weekStart]);
  return <div ref={strip} className="week-strip" role="group" aria-label="Choose a day this week">
    {dateRange(range.from, range.to).map(day => <button type="button" key={day} aria-pressed={day === date} aria-label={`Show ${calendarDate(day)}`} onClick={() => onDate(day)}><span>{DateTime.fromISO(day).toFormat('ccc')}</span><strong>{DateTime.fromISO(day).day}</strong>{data.user.settings.restDays.includes(weekday(day)) && <span className="sr-only">Rest day</span>}</button>)}
  </div>;
}
export function RecurringWork({ items }: { items: Occurrence[] }) {
  return items.length ? <ul className="calendar-work">{items.map(item => <li key={item.id}><Link to={`/schedules?seriesId=${item.seriesId}&date=${item.originalDate}`}>{item.fields.title}</Link><span className="caption">Repeating goal · {duration(item.fields.estMinutes)}{item.virtual ? ' · upcoming' : ''}</span></li>)}</ul> : null;
}
export function CalendarRange({ view, date, from, to, slots, allSlots = slots, occurrences, goals, now, onDate, onEdit }: {
  view: Exclude<CalendarView, 'day'>; date: string; from: string; to: string; slots: TimeSlot[]; allSlots?: TimeSlot[]; occurrences: Occurrence[]; goals: Goal[]; now: number; onDate: (value: string) => void; onEdit: (slot: TimeSlot) => void;
}) {
  const data = useData();
  const days = dateRange(from, to).filter(day => view !== 'agenda' || slots.some(slot => slot.date === day) || occurrences.some(item => item.localDate === day && item.status !== 'suppressed') || goals.some(goal => goal.dueDate === day));
  const profileColor = (slot: TimeSlot): CSSProperties => { const profile = data.profiles.find(profile => profile.id === slot.profileId); return profile ? { borderInlineStartColor: `var(--profile-${profile.color})` } : {}; };
  const localNow = DateTime.fromMillis(now).setZone(data.user.settings.timezone), minute = localNow.hour * 60 + localNow.minute;
  const start = Math.floor(Math.min(data.user.settings.wakingMin, ...allSlots.map(slot => slot.startMin)) / 60) * 60;
  const end = Math.ceil(Math.max(data.user.settings.sleepingMin, ...allSlots.map(slot => slot.endMin)) / 60) * 60;
  const hourHeight = 5.5; // rem; scales with text size
  const size = (minutes: number) => `${minutes / 60 * hourHeight}rem`;
  if (view === 'week') return <div className="week-calendar" aria-label="week timetable">
    <div className="week-grid" style={{ '--week-height': size(end - start) } as CSSProperties}>
      <div className="week-axis" aria-hidden="true"><div className="week-heading" />{Array.from({ length: (end - start) / 60 + 1 }, (_, i) => start + i * 60).map(value => <time key={value} style={{ top: `calc(4.5rem + ${size(value - start)})` }}>{clockLabel(value, data.user.settings.clockFormat)}</time>)}</div>
      {days.map(day => {
        const blocks = slots.filter(slot => slot.date === day), lanes = blockLanes(blocks, 30);
        const rest = data.user.settings.restDays.includes(weekday(day));
        return <section key={day} className={`week-column${day === localNow.toISODate() ? ' week-today' : ''}${rest ? ' week-rest' : ''}`} aria-label={calendarDate(day)}>
          <div className="week-heading"><Button variant="text" onClick={() => onDate(day)} aria-label={`Open day ${calendarDate(day)}`}><span>{DateTime.fromISO(day).toFormat('ccc')}<strong>{DateTime.fromISO(day).day}</strong></span></Button>{rest && <span className="caption">Rest day</span>}</div>
          <div className="week-day" style={{ height: size(end - start) }}>
            {Array.from({ length: (end - start) / 60 }, (_, i) => <i className="week-hour" aria-hidden="true" key={i} style={{ top: size(i * 60) }} />)}
            {blocks.map(slot => {
              const lane = lanes.get(slot.id)!;
              const current = day === localNow.toISODate() && minute >= slot.startMin && minute < slot.endMin;
              return <button type="button" key={slot.id} className={`week-block timeline-${slot.layer}${current ? ' block-current' : ''}`} style={{ ...profileColor(slot), top: size(slot.startMin - start), height: size(slot.endMin - slot.startMin), insetInlineStart: `calc(${lane.lane / lane.count * 100}% + 2px)`, width: `calc(${100 / lane.count}% - 4px)` }} onClick={() => onEdit(slot)} aria-label={`Edit block ${slot.title} on ${calendarDate(day)}, ${clockLabel(slot.startMin, data.user.settings.clockFormat)} to ${clockLabel(slot.endMin, data.user.settings.clockFormat)}, ${layerLabels[slot.layer]}${current ? ', current' : ''}${slot.taskId ? `, ${data.tasks.find(task => task.id === slot.taskId)?.status.replaceAll('_', ' ') || 'task'}` : ''}`}>
                <span className="week-block-title">{['fixed', 'unavailable'].includes(slot.layer) ? <LockKeyhole size={14} aria-hidden="true" strokeWidth={1.5} /> : slot.layer === 'pinned' ? <Pin size={14} aria-hidden="true" strokeWidth={1.5} /> : null}<strong>{slot.title}</strong></span><span className="caption">{clockLabel(slot.startMin, data.user.settings.clockFormat)} · {layerLabels[slot.layer]}</span>
              </button>;
            })}
            {day === localNow.toISODate() && minute >= start && minute < end && <div className="week-now" role="img" style={{ top: size(minute - start) }} aria-label={`Now ${clockLabel(minute, data.user.settings.clockFormat)}`} />}
          </div>
          <div className="week-footnotes">{!!blocks.length && <span className="caption">{blocks.length} {blocks.length === 1 ? 'block' : 'blocks'} · {duration(allocatedMinutes(blocks))}</span>}<RecurringWork items={occurrences.filter(item => item.localDate === day && item.series.kind === 'goal' && item.status === 'scheduled')} />{goals.filter(goal => goal.dueDate === day && goal.status === 'active').map(goal => <Link className="calendar-deadline" key={goal.id} to={`/goals/${goal.id}`}>Due: {goal.title}</Link>)}</div>
        </section>;
      })}
    </div>
    {slots.some(slot => slot.endMin - slot.startMin < 30) && <p className="caption">Short blocks are enlarged for readable controls. The printed times stay exact.</p>}
    <p className="calendar-legend caption"><span><LockKeyhole size={14} aria-hidden="true" />Fixed · locked</span><span>Flexible · outlined</span><span>Pinned · kept in place</span><span>Rest day · hatched column</span><Link to={`/plan?date=${date}&view=agenda`}>Open as agenda</Link></p>
  </div>;
  return <div className={view === 'month' ? 'month-view' : undefined}><div className={view === 'month' ? 'month-scroll' : undefined} role={view === 'month' ? 'region' : undefined} aria-label={view === 'month' ? 'Month calendar' : undefined} tabIndex={view === 'month' ? 0 : undefined}><div className={`calendar-range calendar-${view}`} aria-label={`${view} timetable`}>
    {view === 'month' && Array.from({ length: 7 }, (_, index) => <span key={index} className="month-weekday" aria-hidden="true">{DateTime.fromISO(weekStartDate(date, data.user.settings.weekStart)).plus({ days: index }).toFormat('ccc')}</span>)}
    {!days.length && <Card><p className="muted">No blocks or deadlines in this range. Add a commitment or apply a weekly template.</p></Card>}
    {days.map(day => {
      const blocks = slots.filter(slot => slot.date === day), recurring = occurrences.filter(item => item.localDate === day && item.series.kind === 'goal' && item.status === 'scheduled'), deadlines = goals.filter(goal => goal.dueDate === day && !goal.archivedAt && goal.status === 'active');
      return <section key={day} className={`calendar-date${day === data.studyDate ? ' calendar-today' : ''}${view === 'month' && day.slice(0, 7) !== date.slice(0, 7) ? ' calendar-outside' : ''}`} aria-label={calendarDate(day)}>
        <Button variant="text" onClick={() => onDate(day)} aria-label={`Open day ${calendarDate(day)}`}><strong>{DateTime.fromISO(day).toFormat(view === 'month' ? 'd' : 'ccc, d LLL')}</strong></Button>
        {view !== 'month' && <p className="caption">{blocks.length} {blocks.length === 1 ? 'block' : 'blocks'} · {duration(allocatedMinutes(blocks))} allocated</p>}
        {view === 'month' && !!blocks.length && <span className="calendar-load" role="img" data-level={Math.min(4, Math.ceil(allocatedMinutes(blocks) / 120))} aria-label={`${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'}, ${duration(allocatedMinutes(blocks))} allocated`}><i aria-hidden="true" /><span className="sr-only">{blocks.length} {blocks.length === 1 ? 'block' : 'blocks'} · {duration(allocatedMinutes(blocks))} allocated</span></span>}
        {view !== 'month' && <ul className="calendar-blocks">{blocks.map(slot => <li key={slot.id} style={profileColor(slot)}><button type="button" className="calendar-block" onClick={() => onEdit(slot)} aria-label={`Edit block ${slot.title} on ${calendarDate(day)}`}><strong>{slot.title}</strong><span className="caption">{clockLabel(slot.startMin, data.user.settings.clockFormat)}–{clockLabel(slot.endMin, data.user.settings.clockFormat)} · {layerLabels[slot.layer]}{slot.recurrenceSeriesId ? ' · repeats' : ''}</span></button>{slot.taskId && <Link className="caption" to={`/tasks/${slot.taskId}`}>Open task</Link>}</li>)}</ul>}
        {view === 'month' ? <><div className="calendar-profiles">{[...new Set(blocks.map(slot => slot.profileId).filter(Boolean))].map(id => { const profile = data.profiles.find(row => row.id === id); return profile ? <span className="calendar-profile-dot" role="img" key={id} title={profile.name} aria-label={profile.name} style={{ background: `var(--profile-${profile.color})` }} /> : null; })}</div>{!!recurring.length && <span className="calendar-recurring-mark" role="img" aria-label={`${recurring.length} repeating ${recurring.length === 1 ? 'goal' : 'goals'}`} title="Repeating work">↻</span>}</> : <RecurringWork items={recurring} />}
        {deadlines.map(goal => <Link className={`calendar-deadline${view === 'month' ? ' calendar-deadline-compact' : ''}`} key={goal.id} to={`/goals/${goal.id}`} aria-label={`Due: ${goal.title} on ${calendarDate(day)}`} title={view === 'month' ? `Due: ${goal.title}` : undefined}>{view === 'month' ? <><AlertCircle size={14} aria-hidden="true" />Due</> : `Due: ${goal.title}`}</Link>)}
        {!blocks.length && !recurring.length && !deadlines.length && view !== 'month' && <p className="caption">Room to plan</p>}
      </section>;
    })}
  </div></div>{view === 'month' && <p className="caption month-scroll-hint">Swipe the month grid, or <Link to={`/plan?date=${date}&view=agenda`}>open Agenda</Link>.</p>}</div>;
}
