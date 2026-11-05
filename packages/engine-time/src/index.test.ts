import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DateTime, Settings } from 'luxon';
import { addDays, dateRange, daysBetween, inDateRange, localDate, localDateTime, localToInstant, parseLocalDate, resolveLocalTime, studyDate, weekday, weekStartDate } from './index';

describe('event study dates', () => {
  it('assigns late-night work to the previous study day and closes exactly at rollover', () => {
    expect(studyDate('2026-11-06T01:30:00+05:30', 'Asia/Kolkata', 240)).toBe('2026-11-05');
    expect(studyDate('2026-11-06T00:00:00+05:30', 'Asia/Kolkata', '04:00')).toBe('2026-11-05');
    expect(studyDate('2026-11-06T03:59:59+05:30', 'Asia/Kolkata', 240)).toBe('2026-11-05');
    expect(studyDate('2026-11-06T04:00:00+05:30', 'Asia/Kolkata', 240)).toBe('2026-11-06');
    expect(studyDate('2026-11-06T00:00:00+05:30', 'Asia/Kolkata', 0)).toBe('2026-11-06');
  });

  it('accepts explicit instant representations and applies the selected timezone', () => {
    const value = DateTime.fromISO('2026-11-06T01:30:00+05:30', { setZone: true });
    expect(studyDate(value, 'Asia/Kolkata')).toBe('2026-11-05');
    expect(studyDate(value.toMillis(), 'Asia/Kolkata')).toBe('2026-11-05');
    expect(studyDate('2026-11-05T23:00:00Z', 'Asia/Kolkata')).toBe('2026-11-06');
    expect(studyDate('2026-11-05T23:00:00Z', 'UTC')).toBe('2026-11-05');
  });

  it('does not subtract elapsed hours across spring-forward or fall-back', () => {
    expect(studyDate('2026-03-08T03:30:00-04:00', 'America/New_York', 240)).toBe('2026-03-07');
    expect(studyDate('2026-03-08T04:30:00-04:00', 'America/New_York', 240)).toBe('2026-03-08');
    expect(studyDate('2026-11-01T03:30:00-05:00', 'America/New_York', 240)).toBe('2026-10-31');
    expect(studyDate('2026-11-01T04:00:00-05:00', 'America/New_York', 240)).toBe('2026-11-01');
  });

  it('uses the first rollover instant inside a fall-back overlap', () => {
    expect(studyDate('2026-11-01T01:00:00-04:00', 'America/New_York', 90)).toBe('2026-10-31');
    expect(studyDate('2026-11-01T01:30:00-04:00', 'America/New_York', 90)).toBe('2026-11-01');
    expect(studyDate('2026-11-01T01:00:00-05:00', 'America/New_York', 90)).toBe('2026-11-01');
  });

  it('moves a rollover in a spring-forward gap to the first valid minute', () => {
    expect(studyDate('2026-03-08T01:59:59-05:00', 'America/New_York', 150)).toBe('2026-03-07');
    expect(studyDate('2026-03-08T03:00:00-04:00', 'America/New_York', 150)).toBe('2026-03-08');
  });

  it('does not fabricate a study date for a wholly skipped civil day', () => {
    expect(studyDate('2011-12-31T01:30:00+14:00', 'Pacific/Apia', 240)).toBe('2011-12-29');
    expect(studyDate('2011-12-31T04:00:00+14:00', 'Pacific/Apia', 240)).toBe('2011-12-31');
  });

  it('rejects ambiguous input timestamps, invalid zones and invalid rollover values', () => {
    expect(() => studyDate('2026-11-05T18:00:00', 'Asia/Kolkata')).toThrow(/offset/);
    expect(() => studyDate('invalidZ', 'Asia/Kolkata')).toThrow(/instant/);
    expect(() => studyDate(Number.NaN, 'UTC')).toThrow(/finite/);
    expect(() => studyDate('2026-11-05T18:00:00Z', 'Mars/Phobos')).toThrow(/timezone/);
    expect(() => studyDate('2026-11-05T18:00:00Z', 'UTC', 1440)).toThrow(/rollover/);
    expect(() => studyDate('2026-11-05T18:00:00Z', 'UTC', '24:00')).toThrow(/rollover/);
  });
});

describe('calendar helpers and local-time resolution', () => {
  it('validates real ISO calendar dates independently of any zone', () => {
    expect(parseLocalDate('2024-02-29').zoneName).toBe('UTC');
    expect(localDate('2026-11-05').toISODate()).toBe('2026-11-05');
    for (const invalid of ['2026-02-29', '2026-04-31', '2026-2-5', '2026-11-05T00:00:00Z']) expect(() => parseLocalDate(invalid)).toThrow();
    expect(() => addDays('9999-12-31', 1)).toThrow(/range/);
    expect(() => addDays('2026-11-05', 0.5)).toThrow(/integer/);
  });

  it('preserves inclusive date ranges, leap days and recurrence anchors across zone skips', () => {
    expect(dateRange('2024-02-28', '2024-03-01')).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
    expect(dateRange('2026-11-05', '2026-11-05')).toEqual(['2026-11-05']);
    expect(addDays('2011-12-29', 1)).toBe('2011-12-30');
    expect(daysBetween('2026-11-05', '2026-11-08')).toBe(3);
    expect(daysBetween('2026-11-08', '2026-11-05')).toBe(-3);
    expect(() => dateRange('2026-11-06', '2026-11-05')).toThrow(/end date/);
    expect(() => dateRange('2000-01-01', '2200-01-01')).toThrow(/at most/);
  });

  it('uses the configured Monday or Sunday week and inclusive open pause ranges', () => {
    expect(weekday('2026-11-05')).toBe(4);
    expect(weekStartDate('2026-11-05', 1)).toBe('2026-11-02');
    expect(weekStartDate('2026-11-05', 7)).toBe('2026-11-01');
    expect(weekStartDate('2027-01-01', 7)).toBe('2026-12-27');
    expect(inDateRange('2026-11-05', { start: '2026-11-05', end: '2026-11-05' })).toBe(true);
    expect(inDateRange('2026-12-05', { start: '2026-11-05' })).toBe(true);
    expect(inDateRange('2026-12-05', { start: '2026-11-05', end: null })).toBe(true);
    expect(inDateRange('2026-11-04', { start: '2026-11-05' })).toBe(false);
    expect(() => inDateRange('2026-11-05', { start: '2026-11-05', end: '' })).toThrow(/calendar date/);
    expect(() => inDateRange('2026-11-05', { start: '2026-11-05', end: '2026-11-04' })).toThrow(/end on or after/);
  });

  it('resolves ordinary local time and the explicit end-of-day boundary', () => {
    expect(resolveLocalTime('2026-11-05', 1110, 'Asia/Kolkata')).toEqual({ instant: '2026-11-05T18:30:00.000+05:30', localDate: '2026-11-05', startMin: 1110, adjusted: false, ambiguous: false });
    expect(localToInstant('2026-11-05', 1110, 'Asia/Kolkata')).toBe('2026-11-05T18:30:00.000+05:30');
    expect(resolveLocalTime('2026-11-05', 1440, 'Asia/Kolkata')).toMatchObject({ localDate: '2026-11-06', startMin: 0, adjusted: false });
    expect(localDateTime('2026-11-05', 1110, 'Asia/Kolkata').minute).toBe(30);
  });

  it('advances spring gaps to 03:00 and resolves fall overlaps to the earlier instant', () => {
    expect(resolveLocalTime('2026-03-08', 150, 'America/New_York')).toEqual({ instant: '2026-03-08T03:00:00.000-04:00', localDate: '2026-03-08', startMin: 180, adjusted: true, ambiguous: false });
    expect(resolveLocalTime('2026-11-01', 90, 'America/New_York')).toEqual({ instant: '2026-11-01T01:30:00.000-04:00', localDate: '2026-11-01', startMin: 90, adjusted: false, ambiguous: true });
  });

  it('flags a skipped civil date without shifting its requested anchor', () => {
    expect(resolveLocalTime('2011-12-30', 540, 'Pacific/Apia')).toEqual({ instant: '2011-12-31T00:00:00.000+14:00', localDate: '2011-12-31', startMin: 0, adjusted: true, ambiguous: false });
  });

  it('has no result dependency on Luxon’s ambient current season or default zone', () => {
    const originalNow = Settings.now;
    const originalZone = Settings.defaultZone;
    const winter = DateTime.fromISO('2026-01-01T00:00:00Z').toMillis();
    const summer = DateTime.fromISO('2026-07-01T00:00:00Z').toMillis();
    try {
      Settings.now = () => winter;
      Settings.defaultZone = 'Asia/Kolkata';
      const first = resolveLocalTime('2026-11-01', 90, 'America/New_York');
      Settings.now = () => summer;
      Settings.defaultZone = 'Pacific/Apia';
      expect(resolveLocalTime('2026-11-01', 90, 'America/New_York')).toEqual(first);
    } finally { Settings.now = originalNow; Settings.defaultZone = originalZone; }
  });

  it('preserves civil-date arithmetic and rollover boundaries over generated dates', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 7000 }), fc.integer({ min: -100, max: 100 }), fc.integer({ min: 0, max: 1439 }), (offset, delta, rollover) => {
      const date = addDays('2010-01-01', offset);
      expect(daysBetween(date, addDays(date, delta))).toBe(delta);
      const boundary = localToInstant(date, rollover, 'Asia/Kolkata');
      expect(studyDate(boundary, 'Asia/Kolkata', rollover)).toBe(date);
      if (rollover > 0) expect(studyDate(DateTime.fromISO(boundary, { setZone: true }).minus({ seconds: 1 }), 'Asia/Kolkata', rollover)).toBe(addDays(date, -1));
    }), { numRuns: 200, seed: 20261105 });
  });
});
