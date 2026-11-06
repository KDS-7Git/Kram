import { describe, expect, it } from 'vitest';
import { Settings } from 'luxon';
import { addDays } from '@kram/time';
import { expand, splitSeries, type RecurrenceSeries } from './index';
const series = (patch: Partial<RecurrenceSeries> = {}): RecurrenceSeries => ({ id: 'series', rrule: 'FREQ=DAILY;INTERVAL=2', dtstartLocal: '2026-11-05', tz: 'Asia/Kolkata', status: 'active', ...patch });
const dates = (value: RecurrenceSeries, from = '2026-11-05', to = '2026-11-15') => expand(value, from, to).map(item => item.localDate);
describe('calendar recurrence', () => {
  it('keeps alternate-day anchors through skips, pauses and holidays', () => {
    expect(dates(series({ exceptions: [{ date: '2026-11-07', kind: 'skip' }], pausedRanges: [{ start: '2026-11-09', end: '2026-11-10' }], holidays: ['2026-11-13'] }))).toEqual(['2026-11-05', '2026-11-11', '2026-11-15']);
  });
  it('expands weekday and numbered monthly golden schedules', () => {
    expect(dates(series({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' }))).toEqual(['2026-11-06', '2026-11-09', '2026-11-11', '2026-11-13']);
    expect(dates(series({ rrule: 'FREQ=MONTHLY;BYDAY=1SU', dtstartLocal: '2026-01-01' }), '2026-01-01', '2026-03-31')).toEqual(['2026-01-04', '2026-02-01', '2026-03-01']);
    expect(dates(series({ rrule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', dtstartLocal: '2026-01-01' }), '2026-01-01', '2026-03-31')).toEqual(['2026-01-30', '2026-02-27', '2026-03-31']);
  });
  it('skips short months and honors leap dates, COUNT, UNTIL and year boundaries', () => {
    expect(dates(series({ rrule: 'FREQ=MONTHLY', dtstartLocal: '2026-01-31' }), '2026-01-01', '2026-05-31')).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    expect(dates(series({ rrule: 'FREQ=YEARLY', dtstartLocal: '2024-02-29' }), '2024-01-01', '2030-01-01')).toEqual(['2024-02-29', '2028-02-29']);
    expect(dates(series({ rrule: 'FREQ=DAILY;COUNT=3', dtstartLocal: '2026-12-30' }), '2026-12-29', '2027-01-10')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
    expect(dates(series({ rrule: 'FREQ=DAILY;UNTIL=20261107' }))).toEqual(['2026-11-05', '2026-11-06', '2026-11-07']);
  });
  it('moves in/out of a window while retaining original identities', () => {
    const value = series({ exceptions: [{ date: '2026-11-05', kind: 'move', toDate: '2026-11-11' }, { date: '2026-11-11', kind: 'move', toDate: '2026-11-20' }] });
    expect(expand(value, '2026-11-10', '2026-11-12').map(item => [item.id, item.localDate])).toEqual([['series:2026-11-05', '2026-11-11']]);
    expect(dates(value)).toEqual(['2026-11-07', '2026-11-09', '2026-11-11', '2026-11-13', '2026-11-15']);
  });
  it('ignores stale exceptions and rejects duplicate or malformed exceptions', () => {
    expect(dates(series({ exceptions: [{ date: '2026-11-06', kind: 'move', toDate: '2026-11-10' }] }))).not.toContain('2026-11-10');
    expect(() => dates(series({ exceptions: [{ date: '2026-11-05', kind: 'skip' }, { date: '2026-11-05', kind: 'modify', override: {} }] }))).toThrow(/one exception/);
    expect(() => dates(series({ exceptions: [{ date: '2026-11-05', kind: 'modify', override: { qty: -1 } }] }))).toThrow();
  });
  it('resolves DST gaps to the first valid minute and folds to the first instant', () => {
    const gap = expand(series({ rrule: 'FREQ=DAILY', dtstartLocal: '2026-03-08', tz: 'America/New_York', startMin: 150 }), '2026-03-08', '2026-03-08')[0]!;
    expect(gap).toMatchObject({ startMin: 180, adjusted: true, ambiguous: false, instant: '2026-03-08T03:00:00.000-04:00' });
    const fold = expand(series({ dtstartLocal: '2026-11-01', tz: 'America/New_York', startMin: 90 }), '2026-11-01', '2026-11-01')[0]!;
    expect(fold).toMatchObject({ ambiguous: true, instant: '2026-11-01T01:30:00.000-04:00' });
  });
  it('splits finite series without recreating consumed COUNT and preserves history', () => {
    const { previous, next } = splitSeries(series({ rrule: 'FREQ=DAILY;COUNT=5' }), '2026-11-08', {}, 'next');
    expect(dates(previous)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07']);
    expect(dates(next)).toEqual(['2026-11-08', '2026-11-09']);
    expect(next.dtstartLocal).toBe('2026-11-08');
  });
  it('is clock independent, deterministic, sorted and stable across 200 window projections', () => {
    const old = Settings.now; Settings.now = () => { throw new Error('ambient clock'); };
    try {
      for (let seed = 1; seed <= 200; seed++) {
        const value = series({ rrule: `FREQ=DAILY;INTERVAL=${seed % 9 + 1}`, startMin: seed % 1440 });
        const whole = expand(value, '2026-11-05', '2027-03-01'), from = addDays('2026-11-05', seed % 70), to = addDays(from, seed % 20);
        const subset = expand(value, from, to);
        expect(subset).toEqual(whole.filter(item => item.localDate >= from && item.localDate <= to));
        expect(subset).toEqual(expand(value, from, to));
        expect(new Set(subset.map(item => item.id)).size).toBe(subset.length);
      }
    } finally { Settings.now = old; }
  });
});
it('preserves modified fields on a moved occurrence', () => {
  expect(expand(series({ exceptions: [{ date: '2026-11-05', kind: 'move', toDate: '2026-11-06', toStartMin: 600, override: { title: 'Edited then moved', estMinutes: 45 } }] }), '2026-11-05', '2026-11-06')).toMatchObject([{ title: 'Edited then moved', estMinutes: 45, startMin: 600, originalDate: '2026-11-05', localDate: '2026-11-06' }]);
});
