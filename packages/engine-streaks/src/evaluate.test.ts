import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addDays, dateRange, studyDate } from '@kram/time';
import { evaluateHistory, evaluatePeriod, foldRun, resolveProgress, streakAtRisk } from './index';
import type { ProgressEvent, StreakRule } from './types';
const rule: StreakRule = { scope: 'goal', scopeId: 'g', measure: 'minutes', threshold: 30, period: 'day', version: 1, countPartial: true, restPolicy: 'skip', gracePerMonth: 0 };
const event = (id: string, date = '2026-11-06', minutes = 30, fields: Partial<ProgressEvent> = {}): ProgressEvent => ({ id, goalId: 'g', taskId: 't', kind: 'progress', minutes, qty: 0, localDate: date, ...fields });
const evaluate = (fields: Partial<Parameters<typeof evaluatePeriod>[0]> = {}) => evaluatePeriod({ rule, period: { kind: 'day', start: '2026-11-06', end: '2026-11-06' }, events: [], ...fields });
describe('streak period policies', () => {
  it('counts meaningful units at threshold, keeps quantities scoped, and rejects mixed units', () => {
    expect(evaluate({ events: [event('a', undefined, 29.99)] }).result).toBe('missed');
    expect(evaluate({ events: [event('a')] })).toMatchObject({ result: 'met', value: 30 });
    const pages = { ...rule, measure: 'quantity' as const, threshold: 10, unit: 'pages' };
    expect(evaluate({ rule: pages, events: [event('a', undefined, 0, { qty: 10, unit: 'pages' })] }).result).toBe('met');
    expect(() => evaluate({ rule: pages, events: [event('a', undefined, 0, { qty: 10, unit: 'videos' })] })).toThrow('unrelated');
    expect(() => evaluate({ rule: { ...pages, scope: 'global' } })).toThrow('one goal');
  });
  it('honors pause, rest, ineligible days and partial policy', () => {
    expect(evaluate({ events: [event('a')], pausedRanges: [{ start: '2026-11-01' }] }).result).toBe('paused');
    expect(evaluate({ restDays: new Set(['2026-11-06']) }).result).toBe('rest');
    expect(evaluate({ rule: { ...rule, restPolicy: 'miss' }, restDays: new Set(['2026-11-06']) }).result).toBe('missed');
    expect(evaluate({ rule: { ...rule, eligibleDays: [1, 2] } }).result).toBe('rest');
    expect(evaluate({ rule: { ...rule, countPartial: false }, events: [event('a')] }).result).toBe('missed');
    expect(evaluate({ rule: { ...rule, countPartial: false }, events: [event('a', undefined, 10), event('b', undefined, 20, { kind: 'completed' })] }).value).toBe(30);
  });
  it('does not count unverified periods as success, miss or grace', () => {
    const result = evaluate({ rule: { ...rule, gracePerMonth: 2 }, graceTokensLeft: 2, events: [event('a', undefined, 30, { unverified: true })] });
    expect(result).toMatchObject({ provisional: true, value: 0 });
    expect(foldRun([{ ...result, periodStart: '2026-11-06', periodEnd: '2026-11-06', ruleVersion: 1 }])).toMatchObject({ current: 0, missed: 0, grace: 0, provisional: 1 });
  });
  it('retracts and restores events and preserves completion totals after corrections', () => {
    const work = event('a', undefined, 10, { sequence: 1 });
    const complete = event('b', undefined, 20, { kind: 'completed', sequence: 2, reportedTotalMinutes: 30 });
    const retract = event('c', '2026-11-07', 0, { kind: 'correction', sequence: 3, correctsEventId: 'a' });
    expect(evaluate({ events: [work, complete, retract] }).value).toBe(30);
    const undo = event('d', '2026-11-08', 0, { kind: 'correction', sequence: 4, correctsEventId: 'c' });
    expect(resolveProgress([undo, complete, work, retract]).filter(e => e.kind !== 'correction').map(e => e.minutes)).toEqual([10, 20]);
    expect(() => resolveProgress([event('bad', undefined, 0, { kind: 'correction', correctsEventId: 'missing' })])).toThrow('same task');
  });
  it('counts profile/global completion as met sub-streaks, never heterogeneous task units', () => {
    const global = { ...rule, scope: 'global' as const, measure: 'completion' as const, threshold: 1 };
    expect(evaluate({ rule: global, events: [event('a', undefined, 0, { kind: 'completed', qty: 50, unit: 'pages' })] }).value).toBe(0);
    expect(evaluate({ rule: global, events: [event('s', undefined, 0, { kind: 'sub_streak_met', qty: 1 })] }).value).toBe(1);
  });
});
describe('history, rules and run replay', () => {
  it('resets grace in the calendar month and preserves historical rule versions', () => {
    const records = evaluateHistory({ from: '2026-10-30', to: '2026-11-03', events: [], rules: [{ effectiveFrom: '2026-10-30', rule: { ...rule, gracePerMonth: 1 } }, { effectiveFrom: '2026-11-02', rule: { ...rule, version: 2, threshold: 45, gracePerMonth: 2 } }] });
    expect(records.map(r => [r.result, r.ruleVersion])).toEqual([['grace', 1], ['missed', 1], ['grace', 1], ['grace', 2], ['missed', 2]]);
  });
  it('closes weeks only at week end and honors the owner week start', () => {
    const input = { from: '2026-11-02', to: '2026-11-07', rules: [{ effectiveFrom: '2026-11-02', rule: { ...rule, period: 'week' as const } }], events: [event('a')] };
    expect(evaluateHistory(input)).toEqual([]);
    expect(evaluateHistory({ ...input, to: '2026-11-08' })[0]).toMatchObject({ periodEnd: '2026-11-08', result: 'met' });
    expect(evaluateHistory({ ...input, to: '2026-11-14', weekStart: 7 })[0]).toMatchObject({ periodStart: '2026-11-08', periodEnd: '2026-11-14' });
  });
  it('replays grace consumption after a late verified contribution', () => {
    const input = { from: '2026-11-04', to: '2026-11-05', rules: [{ effectiveFrom: '2026-11-04', rule: { ...rule, gracePerMonth: 1 } }], events: [] as ProgressEvent[] };
    expect(evaluateHistory(input).map(record => record.result)).toEqual(['grace', 'missed']);
    expect(evaluateHistory({ ...input, events: [event('late', '2026-11-04')] }).map(record => record.result)).toEqual(['met', 'grace']);
  });
  it('keeps historical week boundaries from the stored rule snapshot', () => {
    const input = { from: '2026-10-26', to: '2026-11-05', rules: [{ effectiveFrom: '2026-10-26', weekStart: 1 as const, rule: { ...rule, period: 'week' as const } }], events: [event('practice', '2026-10-27')] };
    expect(evaluateHistory({ ...input, weekStart: 7 })).toEqual(evaluateHistory({ ...input, weekStart: 1 }));
    expect(evaluateHistory({ ...input, weekStart: 7 })[0]).toMatchObject({ periodStart: '2026-10-26', periodEnd: '2026-11-01' });
  });
  it('keeps rest and pause neutral and picks the latest correction in a run', () => {
    const records = evaluateHistory({ from: '2026-11-01', to: '2026-11-05', rules: [{ effectiveFrom: '2026-11-01', rule }], events: [event('a', '2026-11-01'), event('b', '2026-11-04')], restDays: new Set(['2026-11-02']), pausedRanges: [{ start: '2026-11-03', end: '2026-11-03' }] });
    expect(foldRun(records)).toMatchObject({ current: 0, best: 2 });
    expect(foldRun([...records, { ...records[4]!, result: 'met' }])).toMatchObject({ current: 3, best: 3 });
  });
  it('replays a full year identically and never mutates input (property)', () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 120 }), { minLength: 365, maxLength: 365 }), amounts => {
      const events = amounts.map((minutes, index) => event(String(index), addDays('2025-01-01', index), minutes));
      const input = { from: '2025-01-01', to: '2025-12-31', rules: [{ effectiveFrom: '2025-01-01', rule: { ...rule, gracePerMonth: 1 } }], events };
      const snapshot = JSON.stringify(input);
      const records = evaluateHistory(input);
      expect(records).toHaveLength(365); expect(evaluateHistory(input)).toEqual(records); expect(JSON.stringify(input)).toBe(snapshot);
      expect(foldRun(records).best).toBeLessThanOrEqual(dateRange(input.from, input.to).length);
    }), { numRuns: 12 });
  });
  it('uses supplied study dates across 01:30 and 04:00 rollover', () => {
    expect(studyDate('2026-11-07T01:30:00Z', 'UTC', 240)).toBe('2026-11-06');
    expect(studyDate('2026-11-07T04:00:00Z', 'UTC', 240)).toBe('2026-11-07');
  });
  it('sends at-risk prompts only when the remaining work fits eligible free capacity', () => {
    const input = { rule, verifiedValue: 10, eligible: true, freeMinutes: 20, qualifyingMinutes: 30, remainingValue: 30 };
    expect(streakAtRisk(input)).toBe(true);
    for (const change of [{ freeMinutes: 19 }, { eligible: false }, { provisional: true }, { remainingValue: 19 }, { verifiedValue: 30 }]) expect(streakAtRisk({ ...input, ...change })).toBe(false);
  });
});
