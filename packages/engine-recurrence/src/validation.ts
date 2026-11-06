import rrule from 'rrule';
import { parseLocalDate } from '@kram/time';

const weekdays = '(?:MO|TU|WE|TH|FR|SA|SU)';
const fields = new Set(['FREQ', 'UNTIL', 'COUNT', 'INTERVAL', 'BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS', 'WKST']);

function invalid(message: string): never { throw new RangeError(`Invalid recurrence rule: ${message}`); }

function integerList(value: string, field: string, min: number, max: number, zero = true) {
  for (const part of value.split(',')) {
    if (!/^[+-]?\d+$/.test(part)) invalid(`${field} must contain integers.`);
    const number = Number(part);
    if (!Number.isSafeInteger(number) || number < min || number > max || (!zero && number === 0)) invalid(`${field} is outside its permitted range.`);
  }
}

function until(value: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value);
  if (!match) invalid('UNTIL must be a basic ISO calendar date or date-time.');
  try { parseLocalDate(`${match[1]}-${match[2]}-${match[3]}`); } catch { invalid('UNTIL must be a real calendar date.'); }
  if (match[4] !== undefined) {
    integerList(match[4], 'UNTIL hour', 0, 23);
    integerList(match[5]!, 'UNTIL minute', 0, 59);
    integerList(match[6]!, 'UNTIL second', 0, 59);
  }
}

/** Validate a date-based RFC 5545 RRULE without expanding it or reading a clock. */
export function validateRRule(input: string): string {
  const value = input.trim().toUpperCase().replace(/^RRULE:/, '');
  if (!value || /\s/.test(value)) invalid('Use one RRULE without embedded whitespace.');
  const parts = new Map<string, string>();
  for (const part of value.split(';')) {
    const match = /^([A-Z]+)=([^=]+)$/.exec(part);
    if (!match || !fields.has(match[1]!)) invalid('Use supported RFC 5545 rule fields.');
    if (parts.has(match[1]!)) invalid(`${match[1]} may only appear once.`);
    parts.set(match[1]!, match[2]!);
  }
  const frequency = parts.get('FREQ');
  if (!frequency || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(frequency)) invalid('Calendar recurrence supports DAILY, WEEKLY, MONTHLY or YEARLY.');
  for (const field of ['INTERVAL', 'COUNT']) {
    const value = parts.get(field);
    if (value !== undefined) {
      if (value.includes(',')) invalid(`${field} must be one positive integer.`);
      integerList(value, field, 1, Number.MAX_SAFE_INTEGER);
    }
  }
  if (parts.has('COUNT') && parts.has('UNTIL')) invalid('Choose COUNT or UNTIL, not both.');
  if (parts.has('UNTIL')) until(parts.get('UNTIL')!);
  const bounds: [string, number, number, boolean][] = [
    ['BYSECOND', 0, 60, true], ['BYMINUTE', 0, 59, true], ['BYHOUR', 0, 23, true],
    ['BYMONTH', 1, 12, true], ['BYMONTHDAY', -31, 31, false], ['BYYEARDAY', -366, 366, false],
    ['BYWEEKNO', -53, 53, false], ['BYSETPOS', -366, 366, false],
  ];
  for (const [field, min, max, zero] of bounds) if (parts.has(field)) integerList(parts.get(field)!, field, min, max, zero);
  for (const field of ['BYHOUR', 'BYMINUTE', 'BYSECOND']) if (parts.has(field) && parts.get(field)!.split(',').some(value => Number(value) !== 0)) invalid('Use the separate start time; RRULE selects calendar dates.');
  if (parts.has('WKST') && !new RegExp(`^${weekdays}$`).test(parts.get('WKST')!)) invalid('WKST must be a weekday.');
  if (parts.has('BYDAY')) for (const day of parts.get('BYDAY')!.split(',')) {
    const match = new RegExp(`^([+-]?\\d+)?(${weekdays})$`).exec(day);
    if (!match) invalid('BYDAY must contain weekdays with optional valid ordinals.');
    if (match[1] !== undefined) {
      integerList(match[1], 'BYDAY ordinal', -53, 53, false);
      if (!['MONTHLY', 'YEARLY'].includes(frequency) || parts.has('BYWEEKNO')) invalid('Numbered BYDAY requires monthly or yearly recurrence without BYWEEKNO.');
    }
  }
  if (parts.has('BYWEEKNO') && frequency !== 'YEARLY') invalid('BYWEEKNO requires YEARLY recurrence.');
  if (parts.has('BYYEARDAY') && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) invalid('BYYEARDAY requires YEARLY recurrence.');
  if (parts.has('BYMONTHDAY') && frequency === 'WEEKLY') invalid('BYMONTHDAY cannot be used with WEEKLY recurrence.');
  if (parts.has('BYSETPOS') && ![...parts.keys()].some((field) => field.startsWith('BY') && field !== 'BYSETPOS')) invalid('BYSETPOS requires another BY field.');
  try { rrule.RRule.parseString(value); } catch { invalid('The recurrence library could not parse this rule.'); }
  return value;
}
