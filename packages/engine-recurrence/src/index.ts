import rrule from 'rrule';
import { DateTime } from 'luxon';
import { addDays, daysBetween, inDateRange, parseLocalDate, resolveLocalTime } from '@kram/time';
import type { Occurrence, RecurrenceException, RecurrenceSeries } from './types';
import { validateRRule } from './validation';

export const engineVersion = '0.2.0';
export type { OccurrenceFields, RecurrenceException, RecurrenceSeries, Occurrence } from './types';
export { validateRRule } from './validation';

function ruleFor(series: RecurrenceSeries) {
  const options = rrule.RRule.parseString(validateRRule(series.rrule));
  for (const key of ['byhour', 'byminute', 'bysecond'] as const) {
    const value = options[key];
    if (value != null && (Array.isArray(value) ? value : [value]).some(number => number !== 0)) throw new RangeError('Use startMin for the occurrence time; RRULE selects calendar dates.');
  }
  return new rrule.RRule({ ...options, dtstart: parseLocalDate(series.dtstartLocal).toJSDate(), byhour: [0], byminute: [0], bysecond: [0] }, true);
}
function dateOf(value: Date) { return DateTime.fromJSDate(value, { zone: 'UTC' }).toISODate()!; }
function fieldsValid(value: RecurrenceSeries | Occurrence) {
  if (value.startMin !== undefined && (!Number.isInteger(value.startMin) || value.startMin < 0 || value.startMin >= 1440)) throw new RangeError('Occurrence time must be a minute from 0 to 1439.');
  if (value.estMinutes !== undefined && (!Number.isInteger(value.estMinutes) || value.estMinutes < 1 || value.estMinutes > 960)) throw new RangeError('Occurrence estimate must be from 1 to 960 minutes.');
  if (value.qty !== undefined && (!Number.isFinite(value.qty) || value.qty <= 0 || value.qty > 1000000)) throw new RangeError('Occurrence quantity must be positive.');
}

/** Floating calendar arithmetic; local timezone resolution happens only after exceptions. */
export function expand(series: RecurrenceSeries, from: string, to: string): Occurrence[] {
  const span = daysBetween(from, to);
  if (span < 0 || span > 3660 || daysBetween(series.dtstartLocal, to) > 36600) throw new RangeError('Use an ordered window of at most ten years and an anchor within one hundred years.');
  fieldsValid(series);
  resolveLocalTime(series.dtstartLocal, series.startMin ?? 0, series.tz);
  if (series.until) parseLocalDate(series.until);
  const exceptions = new Map<string, RecurrenceException>();
  for (const exception of series.exceptions ?? []) {
    parseLocalDate(exception.date);
    if (exceptions.has(exception.date)) throw new RangeError('Only one exception may apply to an original occurrence date.');
    if (exception.kind === 'move') parseLocalDate(exception.toDate);
    exceptions.set(exception.date, exception);
  }
  for (const range of series.pausedRanges ?? []) inDateRange(from, range);
  const holidays = new Set(series.holidays ?? []);
  for (const holiday of holidays) parseLocalDate(holiday);
  const rule = ruleFor(series);
  if (series.status === 'paused' && !series.pausedRanges?.length) return [];
  const originals = new Set(rule.between(parseLocalDate(from).toJSDate(), parseLocalDate(to).toJSDate(), true).map(dateOf));
  for (const exception of exceptions.values()) {
    if (exception.kind !== 'move' || exception.toDate < from || exception.toDate > to) continue;
    const exact = rule.after(parseLocalDate(exception.date).toJSDate(), true);
    if (exact && dateOf(exact) === exception.date) originals.add(exception.date);
  }
  const output: Occurrence[] = [];
  for (const originalDate of originals) {
    if (originalDate < series.dtstartLocal || series.until && originalDate > series.until) continue;
    const exception = exceptions.get(originalDate);
    if (exception?.kind === 'skip') continue;
    const localDate = exception?.kind === 'move' ? exception.toDate : originalDate;
    if (localDate < from || localDate > to || holidays.has(localDate) || (series.pausedRanges ?? []).some(range => inDateRange(localDate, range))) continue;
    const occurrence: Occurrence = { id: `${series.id}:${originalDate}`, seriesId: series.id, ...(series.goalId ? { goalId: series.goalId } : {}),
      originalDate, localDate, title: series.title, startMin: series.startMin, estMinutes: series.estMinutes, qty: series.qty,
      adjusted: false, ambiguous: false, moved: exception?.kind === 'move' };
    if (exception?.kind === 'modify' || exception?.kind === 'move') Object.assign(occurrence, exception.override);
    if (exception?.kind === 'move' && exception.toStartMin !== undefined) occurrence.startMin = exception.toStartMin;
    fieldsValid(occurrence);
    if (occurrence.startMin !== undefined) {
      const resolved = resolveLocalTime(localDate, occurrence.startMin, series.tz);
      occurrence.instant = resolved.instant;
      occurrence.localDate = resolved.localDate;
      occurrence.startMin = resolved.startMin;
      occurrence.adjusted = resolved.adjusted;
      occurrence.ambiguous = resolved.ambiguous;
      if (occurrence.localDate < from || occurrence.localDate > to || holidays.has(occurrence.localDate) || (series.pausedRanges ?? []).some(range => inDateRange(occurrence.localDate, range))) continue;
    }
    output.push(occurrence);
  }
  return output.sort((a, b) => a.localDate.localeCompare(b.localDate) || (a.startMin ?? 0) - (b.startMin ?? 0) || a.originalDate.localeCompare(b.originalDate) || a.id.localeCompare(b.id));
}

/** Split deliberately establishes a new anchor while retaining the old series' history. */
export function splitSeries(series: RecurrenceSeries, from: string, patch: Partial<RecurrenceSeries>, nextId: string): { previous: RecurrenceSeries; next: RecurrenceSeries } {
  parseLocalDate(from);
  if (from < series.dtstartLocal || series.until && from > series.until) throw new RangeError('Split within the series lifetime.');
  const oldEnd = addDays(from, -1);
  let nextRule = patch.rrule ?? series.rrule;
  if (patch.rrule === undefined) {
    const rule = ruleFor(series), count = rule.options.count;
    if (count !== null) {
      const consumed = rule.between(parseLocalDate(series.dtstartLocal).toJSDate(), parseLocalDate(oldEnd).toJSDate(), true).length;
      if (consumed >= count) throw new RangeError('This finite series has no remaining occurrences.');
      nextRule = nextRule.replace(/COUNT=\d+/i, `COUNT=${count - consumed}`);
    }
  }
  const previous = { ...series, until: oldEnd, status: 'ended' as const };
  const next = { ...series, ...patch, id: nextId, rrule: validateRRule(nextRule), dtstartLocal: from, status: 'active' as const,
    exceptions: (series.exceptions ?? []).filter(exception => exception.date >= from), pausedRanges: (series.pausedRanges ?? []).filter(range => !range.end || range.end >= from) };
  return { previous, next };
}
