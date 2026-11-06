import { describe, expect, it } from 'vitest';
import { analyticsReport, type AnalyticsInput } from '../../apps/api/src/analytics/report';
import { csvCell, exportCsv, portable, type PortableExport } from '../../apps/api/src/data/format';
import { portableCsv } from '../../apps/web/src/features/data/download';
import type { TaskStateEvent } from '@kram/shared';
import { goalQuotaOutcomes, type QuotaGoal, type QuotaRuleSnapshot } from '../../apps/api/src/analytics/periods';
import { adjacentAnalyticsWeek, analyticsWeekStart, selectedAnalyticsWeek } from '../../apps/web/src/features/analytics/week';

const event = (id: string, taskId = 'task', fields: Partial<TaskStateEvent> = {}): TaskStateEvent => ({ id, taskId, goalId: 'goal', clientEventId: id, kind: 'progress', minutes: 10, qty: 2, occurredAt: '2026-11-03T10:00:00Z', createdAt: '2026-11-03T10:00:00Z', localDate: '2026-11-03', referenceEventId: null, toDate: null, ...fields });
const fixture = (): AnalyticsInput => ({ weekStart: '2026-11-02', skills: [{ id: 'skill', name: 'Practice', profileId: 'profile', weeklyTargetMin: 150 }], goals: [{ id: 'goal', title: 'Questions', skillId: 'skill', unit: 'questions', targetQty: 10, type: 'weekly' }, { id: 'pages', title: 'Reading', skillId: 'skill', unit: 'pages', targetQty: 20, type: 'milestone' }], tasks: [{ id: 'task', goalId: 'goal', title: 'Sample', estMinutes: 30, kind: 'task' }, { id: 'reading', goalId: 'pages', title: 'Reading sample', estMinutes: 30, kind: 'task' }], events: [] });

describe('weekly analytics', () => {
  it('uses a configured Sunday week for report links, navigation and later-corrected original dates', () => {
    const input = fixture(); input.weekStart = selectedAnalyticsWeek('2026-11-06', '2026-11-06', 7); input.today = '2026-11-10';
    input.events = [event('before', 'task', { localDate: '2026-10-31', minutes: 7, qty: 1 }), event('sunday', 'task', { localDate: '2026-11-01', minutes: 20, qty: 4 }), event('saturday', 'task', { localDate: '2026-11-07', minutes: 10, qty: 2 }), event('after', 'task', { localDate: '2026-11-08', minutes: 30, qty: 6 }), event('correction', 'task', { kind: 'correction', referenceEventId: 'sunday', localDate: '2026-11-09', minutes: 0, qty: 0 })];
    const report = analyticsReport(input);
    expect(report).toMatchObject({ weekStart: '2026-11-01', weekEnd: '2026-11-07', totalMinutes: 10 });
    expect(report.days.map(day => day.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
    expect(report.goals[0]?.weeklyCredited).toBe(2);
    expect(adjacentAnalyticsWeek(report.weekStart, -1, 7)).toBe('2026-10-25'); expect(adjacentAnalyticsWeek(report.weekStart, 1, 7)).toBe('2026-11-08');
    expect(analyticsWeekStart('2026-11-01', 7)).toBe('2026-11-01'); expect(analyticsWeekStart('2026-11-01', 1)).toBe('2026-10-26');
    expect(selectedAnalyticsWeek('invalid', '2026-11-06', 7)).toBe('2026-11-01');
  });
  it('keeps questions/pages separate and uses recorded local date rather than browser timezone', () => {
    const input = fixture(); input.events = [event('q', 'task'), event('p', 'reading', { goalId: 'pages', minutes: 20, qty: 5, occurredAt: '2026-11-01T23:55:00Z', localDate: '2026-11-02' })];
    const report = analyticsReport(input);
    expect(report.skills[0]?.units).toEqual([{ unit: 'questions', credited: 2 }, { unit: 'pages', credited: 5 }]);
    expect(report.totalMinutes).toBe(30); expect(report.days[0]?.minutes).toBe(20);
    expect(report).not.toHaveProperty('percentage');
  });
  it('resolves corrections made outside the week and retains observed completion totals', () => {
    const input = fixture(); input.events = [event('part', 'task', { minutes: 40, qty: 4 }), event('done', 'task', { kind: 'completed', minutes: 20, qty: 6, reportedTotalMinutes: 60, reportedTotalQty: 10 }), event('retract', 'task', { kind: 'correction', minutes: 0, qty: 0, referenceEventId: 'part', localDate: '2026-11-10', occurredAt: '2026-11-10T10:00:00Z', createdAt: '2026-11-10T10:00:00Z' })];
    const report = analyticsReport(input); expect(report.totalMinutes).toBe(60); expect(report.goals[0]?.weeklyCredited).toBe(10); expect(report.completedTasks).toBe(1);
    input.events.push(event('undo', 'task', { kind: 'correction', minutes: 0, qty: 0, referenceEventId: 'done', localDate: '2026-11-10' }));
    expect(analyticsReport(input).totalMinutes).toBe(0); expect(analyticsReport(input).completedTasks).toBe(0);
  });
  it('uses latest ten completed samples, median and bounds, with default until five', () => {
    const input = fixture(); input.tasks = Array.from({ length: 11 }, (_, index) => ({ id: `t${index}`, goalId: 'goal', title: `Task ${index}`, estMinutes: 10, kind: 'lab' }));
    input.events = input.tasks.map((task, index) => event(task.id, task.id, { kind: 'completed', minutes: index ? 30 : 1, qty: 1, occurredAt: `2026-11-${String(index + 1).padStart(2, '0')}T10:00:00Z`, localDate: `2026-11-${String(index + 1).padStart(2, '0')}` }));
    const row = analyticsReport(input).calibration[0]!; expect(row.sampleCount).toBe(10); expect(row.multiplier).toBe(2); expect(row.observedMedian).toBe(3); expect(row.samples.map(sample => sample.taskId)).not.toContain('t0');
    input.tasks = input.tasks.slice(0, 4); input.events = input.events.slice(0, 4);
    expect(analyticsReport(input).calibration[0]).toMatchObject({ ready: false, multiplier: 1, sampleCount: 4 });
  });
  it('uses time for minute goals without mixing a count field', () => {
    const input = fixture(); input.goals[0]!.unit = 'minutes'; input.events = [event('one', 'task', { minutes: 12.5, qty: 999 })];
    expect(analyticsReport(input).goals[0]).toMatchObject({ credited: 12.5, weeklyCredited: 12.5 });
  });
});
describe('original goal quota periods', () => {
  const daily: QuotaGoal = { id: 'goal', title: 'Practice', type: 'daily', unit: 'questions', targetQty: 10, startDate: '2026-10-25', availableDays: [1, 3, 5] };
  const rule: QuotaRuleSnapshot = { id: 'rule', effectiveFrom: '2026-10-25', rules: daily };
  it('compares daily quantities with each eligible day and keeps current/unverified periods open', () => {
    const rows = goalQuotaOutcomes({ goal: daily, rules: [rule], weekStart: '2026-11-01', today: '2026-11-06', unverifiedDates: new Set(['2026-11-04']), work: [{ goalId: 'goal', localDate: '2026-11-02', unit: 'questions', qty: 20, minutes: 10 }, { goalId: 'goal', localDate: '2026-11-04', unit: 'questions', qty: 5, minutes: 10 }, { goalId: 'goal', localDate: '2026-11-06', unit: 'questions', qty: 4, minutes: 10 }] });
    expect(rows.map(row => [row.periodStart, row.targetQty, row.creditedQty, row.status])).toEqual([['2026-11-02', 10, 20, 'met'], ['2026-11-04', 10, 5, 'provisional'], ['2026-11-06', 10, 4, 'in_progress']]);
  });
  it('preserves the original weekly identity/unit/target after settings and rule changes, without crediting late work', () => {
    const goal: QuotaGoal = { ...daily, type: 'weekly', unit: 'questions', targetQty: 100 };
    const original: QuotaRuleSnapshot = { id: 'original', effectiveFrom: '2026-10-25', rules: { ...daily, type: 'weekly', unit: 'pages', targetQty: 10 } };
    const revised: QuotaRuleSnapshot = { id: 'revised', effectiveFrom: '2026-11-04', rules: goal };
    const rows = goalQuotaOutcomes({ goal, rules: [original, revised], weekStart: '2026-11-01', today: '2026-11-10', weeklyPeriods: [{ periodStart: '2026-11-02', periodEnd: '2026-11-08', ruleVersionId: 'original' }], work: [
      { goalId: 'goal', localDate: '2026-11-03', unit: 'pages', qty: 4, minutes: 10, weeklyPeriodStart: '2026-11-02' },
      { goalId: 'goal', localDate: '2026-11-08', unit: 'pages', qty: 3, minutes: 10, weeklyPeriodStart: '2026-11-02' },
      { goalId: 'goal', localDate: '2026-11-09', unit: 'pages', qty: 50, minutes: 10, weeklyPeriodStart: '2026-11-02' },
      { goalId: 'goal', localDate: '2026-11-04', unit: 'questions', qty: 100, minutes: 10, weeklyPeriodStart: '2026-11-02' },
    ] });
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ periodKey: 'weekly:2026-11-02', ruleVersionId: 'original', periodStart: '2026-11-02', periodEnd: '2026-11-08', unit: 'pages', targetQty: 10, creditedQty: 7, shortfallQty: 3, status: 'shortfall' });
  });
  it('honors immutable paused status/ranges without treating current goal status as past pause history', () => {
    const rows = goalQuotaOutcomes({ goal: { ...daily, status: 'paused' }, rules: [rule, { id: 'paused', effectiveFrom: '2026-11-04', rules: { ...daily, status: 'paused' } }], weekStart: '2026-11-01', today: '2026-11-10', work: [] });
    expect(rows.map(row => row.periodStart)).toEqual(['2026-11-02']);
    const ranges = goalQuotaOutcomes({ goal: daily, rules: [{ ...rule, rules: { ...daily, pausedRanges: [{ start: '2026-11-04', end: '2026-11-06' }] } }], weekStart: '2026-11-01', today: '2026-11-10', work: [] });
    expect(ranges.map(row => row.periodStart)).toEqual(['2026-11-02']);
    expect(goalQuotaOutcomes({ goal: { ...daily, status: 'paused' }, rules: [rule], weekStart: '2026-11-01', today: '2026-11-10', work: [] })).toHaveLength(3);
  });
  it('keeps moved occurrence snapshot targets separate and does not count skipped or ambiguous work twice', () => {
    const goal: QuotaGoal = { ...daily, type: 'recurring', unit: 'questions', targetQty: 100 };
    const rows = goalQuotaOutcomes({ goal, rules: [{ ...rule, rules: { ...daily, type: 'recurring', unit: 'pages', targetQty: 5 } }], weekStart: '2026-11-01', today: '2026-11-10', occurrences: [
      { id: 'first', originalDate: '2026-11-01', localDate: '2026-11-04', status: 'scheduled', fields: { qty: 5, unit: 'pages' } },
      { id: 'second', originalDate: '2026-11-02', localDate: '2026-11-04', status: 'scheduled', fields: { qty: 2, unit: 'pages' } },
      { id: 'skipped', originalDate: '2026-11-06', localDate: '2026-11-06', status: 'skipped', fields: { qty: 100, unit: 'questions' } },
    ], work: [{ goalId: 'goal', localDate: '2026-11-04', unit: 'pages', qty: 4, minutes: 10, occurrenceId: 'first' }, { goalId: 'goal', localDate: '2026-11-04', unit: 'pages', qty: 2, minutes: 10, occurrenceId: 'second' }, { goalId: 'goal', localDate: '2026-11-04', unit: 'pages', qty: 100, minutes: 10 }] });
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ occurrenceId: 'first', originalDate: '2026-11-01', unit: 'pages', targetQty: 5, creditedQty: 4, status: 'provisional' }); expect(rows[1]).toMatchObject({ occurrenceId: 'second', targetQty: 2, creditedQty: 2, status: 'met' });
  });
});
describe('portable exports', () => {
  it('removes credentials recursively while retaining Unicode notes, timestamps and archives', () => {
    expect(portable({ id: 'owner', passwordHash: 'never-export', settings: { theme: 'dark', ntfyToken: 'never-export' }, records: [{ title: 'अभ्यास', archivedAt: new Date('2026-11-01T00:00:00Z'), note: 'ordinary note', requestHash: 'private' }] })).toEqual({ id: 'owner', settings: { theme: 'dark' }, records: [{ title: 'अभ्यास', archivedAt: '2026-11-01T00:00:00.000Z', note: 'ordinary note' }] });
  });
  it('guards spreadsheet formulas, quotes, newlines and schema-independent nested fields', () => {
    for (const value of ['=SUM(A1)', ' +1', '\t@SUM(A1)', '-3']) expect(csvCell(value)).toMatch(/^"'/);
    expect(csvCell('A "quote"\nline')).toBe('"A ""quote""\nline"');
    const snapshot: PortableExport = { format: 'kram-portable', formatVersion: 1, exportedAt: '2026-11-06T00:00:00Z', account: { id: 'owner' }, tables: { progress_event: [{ id: 'event', qty: 0.5, note: '=attack', fields: { label: 'अभ्यास' } }] } };
    expect(exportCsv(snapshot)).toContain('"\'=attack"'); expect(exportCsv(snapshot)).toContain('अभ्यास'); expect(portableCsv(snapshot)).toBe(exportCsv(snapshot));
  });
});
