import { DateTime } from 'luxon';
import type { DateRange, ResolvedLocalTime, WeekStart } from './types';

export const engineVersion = '0.1.0';
export type { Clock, WeekStart, DateRange, ResolvedLocalTime } from './types';

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const maxRangeDays = 36600;

function integer(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

/** A calendar date in floating UTC, never an event instant or the user's timezone. */
export function parseLocalDate(date: string): DateTime {
  if (!isoDatePattern.test(date)) throw new RangeError('Use a calendar date in YYYY-MM-DD form.');
  const [year, month, day] = date.split('-').map(Number);
  const parsed = DateTime.fromMillis(0, { zone: 'UTC' }).set({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 });
  if (!parsed.isValid || parsed.toISODate() !== date) throw new RangeError(`Invalid calendar date: ${date}.`);
  return parsed;
}

export const localDate = parseLocalDate;

export function addDays(date: string, count: number): string {
  if (!Number.isInteger(count)) throw new RangeError('Day count must be an integer.');
  const result = parseLocalDate(date).plus({ days: count }).toISODate();
  if (!result || !isoDatePattern.test(result)) throw new RangeError('Date is outside the supported calendar range.');
  return result;
}

export function daysBetween(from: string, to: string): number {
  return Math.round(parseLocalDate(to).diff(parseLocalDate(from), 'days').days);
}

/** Inclusive civil dates. Bounds prevent accidental unbounded materialization. */
export function dateRange(from: string, to: string): string[] {
  const days = daysBetween(from, to);
  if (days < 0) throw new RangeError('The end date must be on or after the start date.');
  if (days > maxRangeDays) throw new RangeError(`A date range may span at most ${maxRangeDays} days.`);
  return Array.from({ length: days + 1 }, (_, index) => addDays(from, index));
}

export function weekday(date: string): number { return parseLocalDate(date).weekday; }

export function weekStartDate(date: string, start: WeekStart = 1): string {
  if (start !== 1 && start !== 7) throw new RangeError('Week start must be Monday (1) or Sunday (7).');
  return addDays(date, -((weekday(date) - start + 7) % 7));
}

export function inDateRange(date: string, range: DateRange): boolean {
  parseLocalDate(date);
  parseLocalDate(range.start);
  const end = range.end;
  if (end !== undefined && end !== null) {
    parseLocalDate(end);
    if (end < range.start) throw new RangeError('A date range must end on or after its start.');
  }
  return date >= range.start && (end === undefined || end === null || date <= end);
}

function validateZone(timezone: string) {
  if (!DateTime.fromMillis(0, { zone: timezone }).isValid) throw new RangeError(`Invalid timezone: ${timezone}.`);
}

/**
 * Resolve civil time: gaps advance to the first valid minute; overlaps use the
 * earliest instant. Minute 1440 is the intentional next-midnight interval end.
 */
export function resolveLocalTime(date: string, minute: number, timezone = 'Asia/Kolkata'): ResolvedLocalTime {
  integer(minute, 0, 1440, 'Local minute');
  validateZone(timezone);
  const requested = parseLocalDate(date).plus({ minutes: minute });
  for (let advance = 0; advance <= 2880; advance++) {
    const desired = requested.plus({ minutes: advance });
    if (desired.year < 0 || desired.year > 9999) throw new RangeError('Local time is outside the supported calendar range.');
    const candidate = DateTime.fromMillis(0, { zone: timezone }).set({ year: desired.year, month: desired.month, day: desired.day, hour: desired.hour, minute: desired.minute, second: 0, millisecond: 0 });
    if (!candidate.isValid || candidate.year !== desired.year || candidate.month !== desired.month || candidate.day !== desired.day || candidate.hour !== desired.hour || candidate.minute !== desired.minute) continue;
    const offsets = candidate.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis());
    const first = offsets[0]!;
    return { instant: first.toISO()!, localDate: first.toISODate()!, startMin: first.hour * 60 + first.minute, adjusted: advance > 0, ambiguous: offsets.length > 1 };
  }
  throw new RangeError('No valid local time exists within two days of this minute.');
}

export function localToInstant(date: string, minute: number, timezone = 'Asia/Kolkata'): string {
  return resolveLocalTime(date, minute, timezone).instant;
}

export function localDateTime(date: string, minute: number, timezone = 'Asia/Kolkata'): DateTime {
  return instantValue(localToInstant(date, minute, timezone)).setZone(timezone);
}

function rolloverMinute(rollover: number | string): number {
  if (typeof rollover === 'number') return integer(rollover, 0, 1439, 'Day rollover');
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(rollover);
  if (!match) throw new RangeError('Day rollover must be minutes from midnight or HH:MM.');
  return Number(match[1]) * 60 + Number(match[2]);
}

function instantValue(instant: string | number | DateTime): DateTime {
  let parsed: DateTime;
  if (typeof instant === 'number') {
    if (!Number.isFinite(instant)) throw new RangeError('An instant must be finite.');
    parsed = DateTime.fromMillis(instant, { zone: 'UTC' });
  } else if (typeof instant === 'string') {
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(instant)) throw new RangeError('An event instant must include Z or a timezone offset.');
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):?(\d{2}))$/i.exec(instant);
    if (!match) throw new RangeError('Invalid event instant.');
    const hour = integer(Number(match[2]), 0, 23, 'Instant hour');
    const minute = integer(Number(match[3]), 0, 59, 'Instant minute');
    const second = integer(Number(match[4] ?? 0), 0, 59, 'Instant second');
    const millisecond = Number((match[5] ?? '').padEnd(3, '0').slice(0, 3));
    const offset = match[6]!.toUpperCase() === 'Z' ? 0 :
      (match[7] === '-' ? -1 : 1) * (integer(Number(match[8]), 0, 23, 'Offset hour') * 60 + integer(Number(match[9]), 0, 59, 'Offset minute'));
    parsed = parseLocalDate(match[1]!).plus({ hours: hour, minutes: minute - offset, seconds: second, milliseconds: millisecond });
  } else parsed = instant;
  if (!parsed.isValid) throw new RangeError('Invalid event instant.');
  return parsed;
}

/** Epoch milliseconds for explicit instants; never reads the current clock. */
export function instantMillis(instant: string | number | DateTime): number {
  return instantValue(instant).toMillis();
}

/** The only event-instant to study-date mapping. The application supplies now. */
export function studyDate(instant: string | number | DateTime, timezone = 'Asia/Kolkata', rollover: number | string = 240): string {
  validateZone(timezone);
  const value = instantValue(instant).setZone(timezone);
  const calendarDate = value.toISODate()!;
  const boundary = instantValue(localToInstant(calendarDate, rolloverMinute(rollover), timezone));
  if (value.toMillis() >= boundary.toMillis()) return calendarDate;
  let previous = addDays(calendarDate, -1);
  for (let skipped = 0; skipped < 3; skipped++) {
    if (resolveLocalTime(previous, 0, timezone).localDate === previous) return previous;
    previous = addDays(previous, -1);
  }
  throw new RangeError('Could not find a previous civil study day.');
}
