import { describe, expect, it } from 'vitest';
import { Settings } from 'luxon';
import { validateRRule } from './index';

describe('stored recurrence-rule validation', () => {
  it('accepts the specified calendar patterns and normalizes rule names', () => {
    for (const rule of ['FREQ=DAILY', 'FREQ=DAILY;INTERVAL=2', 'FREQ=WEEKLY;BYDAY=MO,WE,FR', 'FREQ=WEEKLY;INTERVAL=2', 'FREQ=MONTHLY;BYDAY=1SU', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'FREQ=MONTHLY;BYMONTHDAY=31', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', 'FREQ=DAILY;COUNT=8', 'FREQ=DAILY;UNTIL=20260228', 'FREQ=DAILY;UNTIL=20260228T235959Z']) expect(validateRRule(rule)).toBe(rule);
    expect(validateRRule(' rrule:freq=weekly;byday=mo,fr ')).toBe('FREQ=WEEKLY;BYDAY=MO,FR');
  });

  it('rejects nonpositive, fractional and unsafe interval/count values', () => {
    for (const rule of ['FREQ=DAILY;INTERVAL=0', 'FREQ=DAILY;INTERVAL=-1', 'FREQ=DAILY;INTERVAL=1.5', 'FREQ=DAILY;INTERVAL=9007199254740992', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;COUNT=1.5', 'FREQ=DAILY;COUNT=1,2']) expect(() => validateRRule(rule)).toThrow(/Invalid recurrence/);
  });

  it('rejects invalid calendar dates rather than accepting library normalization', () => {
    for (const until of ['20260230', '20260230T000000Z', '20260431T000000Z', '20260228T240000Z', '20260228T006000Z', '20260228T000060Z', '2026-02-28']) expect(() => validateRRule(`FREQ=DAILY;UNTIL=${until}`)).toThrow(/UNTIL/);
    expect(validateRRule('FREQ=DAILY;UNTIL=20240229')).toBe('FREQ=DAILY;UNTIL=20240229');
  });

  it('enforces RFC numeric bounds and rule-part restrictions', () => {
    for (const rule of ['FREQ=DAILY;BYHOUR=25', 'FREQ=DAILY;BYMINUTE=80', 'FREQ=DAILY;BYSECOND=61', 'FREQ=DAILY;BYMONTH=13', 'FREQ=DAILY;BYMONTHDAY=0', 'FREQ=YEARLY;BYYEARDAY=-367', 'FREQ=YEARLY;BYWEEKNO=54', 'FREQ=MONTHLY;BYDAY=0MO', 'FREQ=MONTHLY;BYDAY=54MO', 'FREQ=MONTHLY;BYDAY=XX', 'FREQ=WEEKLY;BYDAY=1MO', 'FREQ=WEEKLY;BYMONTHDAY=5', 'FREQ=DAILY;BYSETPOS=-1', 'FREQ=DAILY;WKST=8MO', 'FREQ=DAILY;COUNT=5;UNTIL=20261105']) expect(() => validateRRule(rule)).toThrow(/Invalid recurrence/);
  });

  it('rejects missing, duplicate, unknown and subdaily rules before expansion', () => {
    for (const rule of ['', 'INTERVAL=2', 'FREQ=DAILY;FREQ=WEEKLY', 'FREQ=DAILY;UNKNOWN=1', 'FREQ=HOURLY', 'DTSTART:20261105\nRRULE:FREQ=DAILY', 'FREQ=DAILY;']) expect(() => validateRRule(rule)).toThrow(/Invalid recurrence/);
  });

  it('does not read the ambient clock during validation', () => {
    const now = Settings.now;
    try {
      Settings.now = () => { throw new Error('Unexpected live clock read'); };
      expect(validateRRule('FREQ=DAILY;INTERVAL=2')).toBe('FREQ=DAILY;INTERVAL=2');
      expect(validateRRule('FREQ=DAILY;UNTIL=20261105')).toBe('FREQ=DAILY;UNTIL=20261105');
    }
    finally { Settings.now = now; }
  });
});
