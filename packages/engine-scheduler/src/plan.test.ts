import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addDays } from '@kram/time';
import { DateTime, Settings } from 'luxon';
import { assertPlan, calibration, defaultConfig, feasibility, plan, type PlanInput, type PlanItem, type Task } from './index';

const today = '2026-11-09';
function fixture(overrides: Partial<PlanInput> = {}): PlanInput {
  return { today, horizonDays: 3, mode: 'directed', tasks: [{ id: 'a', goalId: 'ga', estMinutes: 180, remainingMinutes: 180, status: 'pending', title: 'Read the course', supportsSplit: true }], goals: [{ id: 'ga', skillId: 'sa', dueDate: addDays(today, 2) }], skills: [{ id: 'sa' }], freeSlots: Object.fromEntries([0, 1, 2].map(day => [addDays(today, day), [{ date: addDays(today, day), startMin: 480, endMin: 600 }]])), config: { minBreak: 0, maxDailyMin: 120, maxWeeklyMin: 840, buffer: 0 }, ...overrides };
}
const task = (id: string, goalId = 'ga', minutes = 60, extra: Partial<Task> = {}): Task => ({ id, goalId, estMinutes: minutes, remainingMinutes: minutes, status: 'pending', supportsSplit: true, ...extra });
const sample = (actualMinutes: number, extra = {}) => ({ skillId: 'sa', kind: 'reading', actualMinutes, estMinutes: 60, ...extra });
const item = (patch: Partial<PlanItem> = {}): PlanItem => ({ taskId: 'a', goalId: 'ga', skillId: 'sa', date: today, startMin: 480, endMin: 540, minutes: 60, workMinutes: 60, score: 0, explanation: 'Accepted placement', ...patch });
const course = () => fixture({ horizonDays: 25, tasks: [...Array.from({ length: 60 }, (_, i) => task(`video-${String(i).padStart(2, '0')}`, 'ga', 35)), ...Array.from({ length: 12 }, (_, i) => task(`revision-${String(i).padStart(2, '0')}`, 'ga', 60))], goals: [{ id: 'ga', skillId: 'sa', dueDate: addDays(today, 24) }], freeSlots: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [addDays(today, i), [{ date: addDays(today, i), startMin: 480, endMin: 600 }]])) });

describe('scheduler correctness', () => {
  it('uses conservative defaults, preserves input and never reads a real clock', () => {
    expect(defaultConfig.usePriority).toBe(false);
    const input = fixture(), before = JSON.stringify(input), clock = Settings.now;
    Settings.now = () => { throw new Error('Implicit clock read'); };
    try { expect(plan(input).items).toHaveLength(3); expect(DateTime.fromMillis(0, { zone: 'UTC' }).isValid).toBe(true); } finally { Settings.now = clock; }
    expect(JSON.stringify(input)).toBe(before);
    expect(plan(input).changes.requiresApproval).toBe(true);
  });
  it('spreads on-track deadline work without overloading any day', () => {
    const result = plan(fixture());
    expect(result.items.map(value => [value.date, value.minutes])).toEqual([[today, 60], [addDays(today, 1), 60], [addDays(today, 2), 60]]);
    expect(result.unplaced).toEqual([]);
  });
  it('computes the 2,820 minute workload and 112.8 minute daily requirement over 25 eligible dates', () => {
    expect(feasibility(course())[0]).toMatchObject({ remainingMin: 2820, requiredPerDay: 112.8, eligibleDays: 25, feasible: true });
    expect(plan(course()).items.reduce((sum, value) => sum + value.workMinutes!, 0)).toBeCloseTo(2820);
  });
  it('calibrates the last ten valid completed skill/kind samples only after five observations', () => {
    expect(calibration([sample(78), sample(78), sample(78), sample(78)], 'sa', 'reading')).toBe(1);
    expect(calibration([sample(78), sample(78), sample(78), sample(78), sample(6000)], 'sa', 'reading')).toBe(1.3);
    expect(calibration(Array.from({ length: 10 }, (_, i) => sample(180, { completedAt: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z` })), 'sa', 'reading')).toBe(2);
    expect(calibration(Array.from({ length: 5 }, () => sample(1)), 'sa', 'reading')).toBe(0.7);
    expect(calibration([sample(78), sample(78), sample(78), sample(78), sample(78)], 'sa', 'video')).toBe(1);
  });
  it('orders completed calibration observations by their actual instant across timezone offsets', () => {
    const observations = [sample(120, { completedAt: '2026-11-10T00:00:00+14:00' }), ...Array.from({ length: 10 }, (_, index) => sample(index < 5 ? 42 : 78, { completedAt: '2026-11-09T11:00:00Z' }))];
    expect(calibration(observations, 'sa', 'reading')).toBe(1);
    expect(calibration([sample(120, { completedAt: 'invalid' }), ...Array.from({ length: 4 }, () => sample(78))], 'sa', 'reading')).toBe(1);
  });
  it('separates physical calibrated minutes from task work and keeps exact remainders', () => {
    const input = fixture({ tasks: [task('a', 'ga', 60, { kind: 'reading' })], history: { samples: Array.from({ length: 5 }, () => sample(78)) } });
    const result = plan(input);
    expect(result.items.reduce((sum, value) => sum + value.minutes, 0)).toBe(78);
    expect(result.items.reduce((sum, value) => sum + value.workMinutes!, 0)).toBeCloseTo(60);
    expect(result.unplaced).toEqual([]);
    assertPlan(input, result.items);
  });
  it.each([0.7, 2])('consumes a fractional remainder exactly at calibration %s without losing or inventing work', factor => {
    const input = fixture({ horizonDays: 1, tasks: [task('a', 'ga', 20.25)], goals: [{ id: 'ga', skillId: 'sa' }], history: { calibration: { sa: factor } } });
    const result = plan(input);
    expect(result.items[0]?.minutes).toBe(Math.ceil(20.25 * factor));
    expect(result.items[0]?.workMinutes).toBe(20.25);
    expect(result.unplaced).toEqual([]);
  });
  it('fills an evening reservation before open morning time but never starts its dependent earlier', () => {
    const input = fixture({ horizonDays: 1, goals: [{ id: 'ga', skillId: 'sa' }, { id: 'gb', skillId: 'sb' }], skills: [{ id: 'sa' }, { id: 'sb' }], tasks: [task('a'), task('b', 'gb')], dependencies: [{ taskId: 'b', dependsOnTaskId: 'a' }], freeSlots: { [today]: [{ date: today, startMin: 480, endMin: 540 }, { date: today, startMin: 1080, endMin: 1140, skillId: 'sa' }] } });
    const result = plan(input);
    expect(result.items.map(value => [value.taskId, value.startMin])).toEqual([['a', 1080]]);
    expect(result.unplaced).toEqual([expect.objectContaining({ taskId: 'b' })]);
  });
  it('does not unlock a dependent from a partial prerequisite or a skipped prerequisite', () => {
    const input = fixture({ horizonDays: 1, tasks: [task('a', 'ga', 180), task('b', 'ga', 30)], dependencies: [{ taskId: 'b', dependsOnTaskId: 'a' }] });
    expect(plan(input).items.every(value => value.taskId === 'a')).toBe(true);
    expect(plan(input).unplaced.find(value => value.taskId === 'b')?.code).toBe('BLOCKED_BY_DEP');
    expect(plan({ ...input, tasks: [task('a', 'ga', 180, { status: 'skipped' }), task('b', 'ga', 30)] }).unplaced[0]?.code).toBe('BLOCKED_BY_DEP');
  });
  it('honors completed prerequisites outside the rolling window and temporal chains', () => {
    const input = fixture({ horizonDays: 1, tasks: [task('a', 'ga', 30), task('b', 'ga', 30), task('c', 'ga', 30)], dependencies: [{ taskId: 'a', dependsOnTaskId: 'old' }, { taskId: 'b', dependsOnTaskId: 'a' }, { taskId: 'c', dependsOnTaskId: 'b' }], history: { completedTaskIds: ['old'] } });
    expect(plan(input).items.map(value => [value.taskId, value.startMin])).toEqual([['a', 480], ['b', 510], ['c', 540]]);
  });
  it('honors existing daily/user/skill weekly workload from before the planning horizon', () => {
    const input = fixture({ tasks: [task('a', 'ga', 180)], config: { maxDailyMin: 120, maxWeeklyMin: 200, minBreak: 0, buffer: 0 }, existingWork: [{ date: today, minutes: 100, skillId: 'sa', goalId: 'ga' }, { date: addDays(today, -1), minutes: 100, skillId: 'sa' }], skills: [{ id: 'sa', maxWeeklyMin: 150 }], today: addDays(today, 1), horizonDays: 2 });
    const result = plan(input);
    expect(result.items.reduce((sum, value) => sum + value.minutes, 0)).toBe(50);
  });
  it('resets user and skill weekly budgets on the configured week start', () => {
    const sunday = '2026-11-15', monday = addDays(sunday, 1);
    const input = fixture({ today: sunday, horizonDays: 2, tasks: [task('a', 'ga', 300)], goals: [{ id: 'ga', skillId: 'sa' }], skills: [{ id: 'sa', maxWeeklyMin: 120 }], freeSlots: { [sunday]: [{ date: sunday, startMin: 480, endMin: 600 }], [monday]: [{ date: monday, startMin: 480, endMin: 600 }] }, existingWork: [{ date: addDays(sunday, -1), minutes: 100, skillId: 'sa' }], config: { maxDailyMin: 120, maxWeeklyMin: 120, minBreak: 0, buffer: 0, weekStart: 1 } });
    expect(plan(input).items.map(value => [value.date, value.minutes])).toEqual([[sunday, 20], [monday, 120]]);
    expect(plan({ ...input, config: { ...input.config, weekStart: 7 } }).items.map(value => [value.date, value.minutes])).toEqual([[sunday, 120]]);
  });
  it('preserves valid frozen/pinned wall placements and counts their work only once', () => {
    const frozen = item({ date: addDays(today, 1), pinned: true }), input = fixture({ frozen: [frozen], previous: [frozen] });
    const result = plan(input);
    expect(result.items).toContainEqual(frozen);
    expect(result.items.reduce((sum, value) => sum + value.workMinutes!, 0)).toBe(180);
    expect(result.items.filter(value => value.date === frozen.date).every(value => value.endMin <= frozen.startMin || value.startMin >= frozen.endMin || value === frozen || value.taskId === frozen.taskId && value.startMin === frozen.startMin)).toBe(true);
  });
  it('protects overloaded frozen facts but adds no work on top of them', () => {
    const frozen = [item({ endMin: 600, minutes: 120, workMinutes: 120 }), item({ date: addDays(today, 1), endMin: 600, minutes: 120, workMinutes: 120 })];
    const result = plan(fixture({ tasks: [task('a', 'ga', 300)], frozen, config: { maxDailyMin: 60, maxWeeklyMin: 180, minBreak: 0, buffer: 0 } }));
    expect(result.items).toEqual(frozen);
    expect(result.warnings.some(value => value.code === 'EXISTING_WEEKLY_OVERLOAD')).toBe(true);
  });
  it('keeps a zero-work frozen interval occupied without delaying a completed prerequisite', () => {
    const frozen = [item({ endMin: 500, minutes: 20, workMinutes: 20 }), item({ date: addDays(today, 1), workMinutes: 0 })];
    const input = fixture({ tasks: [task('a', 'ga', 20), task('b', 'ga', 30)], goals: [{ id: 'ga', skillId: 'sa' }], frozen, dependencies: [{ taskId: 'b', dependsOnTaskId: 'a' }] });
    const result = plan(input);
    expect(result.items).toEqual([frozen[0], expect.objectContaining({ taskId: 'b', date: today, startMin: 500, workMinutes: 30 }), frozen[1]]);
  });
  it('rejects inconsistent frozen work instead of silently moving or overconsuming it', () => {
    expect(() => plan(fixture({ tasks: [task('a', 'ga', 20)], frozen: [item()] }))).toThrow(/Frozen work exceeds/);
    expect(() => plan(fixture({ frozen: [item(), item({ taskId: 'b' })], tasks: [task('a'), task('b')] }))).toThrow(/overlap/);
  });
  it('does not replan closed or paused work and respects earliest dates and rest gaps', () => {
    const input = fixture({ tasks: [task('a', 'ga', 30, { status: 'completed' }), task('b', 'ga', 30, { status: 'cancelled' }), task('c', 'gb', 30), task('d', 'ga', 30, { earliestDate: addDays(today, 2) })], goals: [{ id: 'ga', skillId: 'sa', dueDate: addDays(today, 2) }, { id: 'gb', skillId: 'sa', status: 'paused' }], freeSlots: { [today]: [{ date: today, startMin: 480, endMin: 600 }], [addDays(today, 2)]: [{ date: addDays(today, 2), startMin: 480, endMin: 600 }] } });
    const result = plan(input);
    expect(result.items).toEqual([expect.objectContaining({ taskId: 'd', date: addDays(today, 2) })]);
    expect(result.unplaced).toEqual([expect.objectContaining({ taskId: 'c', code: 'PAUSED_GOAL' })]);
  });
  it('requires a full fit for unsplittable tasks and leaves a partial 20-minute remainder', () => {
    const input = fixture({ tasks: [task('a', 'ga', 180, { supportsSplit: false }), task('b', 'ga', 60, { remainingMinutes: 20 })] });
    expect(plan(input).items.every(value => value.taskId === 'b')).toBe(true);
    expect(plan(input).items.reduce((sum, value) => sum + value.workMinutes!, 0)).toBe(20);
  });
  it('rejects partial non-splittable work and undersized unfinished chunks at the production assertion boundary', () => {
    expect(() => assertPlan(fixture({ tasks: [task('a', 'ga', 60, { supportsSplit: false })] }), [item({ endMin: 510, minutes: 30, workMinutes: 30 })])).toThrow(/complete fit/);
    expect(() => assertPlan(fixture({ tasks: [task('a', 'ga', 60)] }), [item({ endMin: 490, minutes: 10, workMinutes: 10 })])).toThrow(/short chunk/);
  });
  it('inserts actual break gaps without charging them as task work', () => {
    const input = fixture({ horizonDays: 1, tasks: [task('a', 'ga', 60, { supportsSplit: false }), task('b', 'ga', 60, { supportsSplit: false })], goals: [{ id: 'ga', skillId: 'sa' }], freeSlots: { [today]: [{ date: today, startMin: 480, endMin: 610 }] }, config: { maxDailyMin: 120, maxWeeklyMin: 840, minBreak: 10, breakAfter: 60, buffer: 0 } });
    expect(plan(input).items.map(value => [value.startMin, value.endMin])).toEqual([[480, 540], [550, 610]]);
  });
  it('applies the goal share while another eligible goal remains and releases it when that work finishes', () => {
    const input = fixture({ horizonDays: 1, tasks: [task('a', 'ga', 600), task('b', 'gb', 600)], goals: [{ id: 'ga', skillId: 'sa' }, { id: 'gb', skillId: 'sb' }], skills: [{ id: 'sa' }, { id: 'sb' }] });
    const result = plan(input);
    expect(result.items.find(value => value.taskId === 'a')?.minutes).toBe(72);
    expect(result.items.find(value => value.taskId === 'b')?.minutes).toBe(48);
    const completedCompetition = plan({ ...input, tasks: [task('a', 'ga', 600), task('b', 'gb', 15)] });
    expect(completedCompetition.items.filter(value => value.taskId === 'a').reduce((sum, value) => sum + value.minutes, 0)).toBe(105);
  });
  it('does not waive fairness after a greedy placement leaves too little room for its rival', () => {
    const input = fixture({ tasks: [task('a', 'ga', 19), task('b', 'gb', 31)], goals: [{ id: 'ga', skillId: 'sa' }, { id: 'gb', skillId: 'sb' }], skills: [{ id: 'sa' }, { id: 'sb' }], existingWork: [{ date: today, minutes: 6 }], config: { maxDailyMin: 30, maxWeeklyMin: 90, minBreak: 0, buffer: 0 } });
    const result = plan(input);
    expect(result.items.filter(value => value.taskId === 'a' && value.date === addDays(today, 1)).reduce((sum, value) => sum + value.minutes, 0)).toBe(18);
    expect(() => assertPlan(input, [item({ date: addDays(today, 1), minutes: 19, endMin: 499, workMinutes: 19 })])).toThrow(/starves/);
    expect(feasibility({ ...input, horizonDays: 1 })[0]?.availableMin).toBe(14.4);
  });
  it('allows a goal to finish the prerequisite that makes its rival eligible', () => {
    const input = fixture({ horizonDays: 1, tasks: [task('a', 'ga', 19), task('b', 'gb', 31)], goals: [{ id: 'ga', skillId: 'sa' }, { id: 'gb', skillId: 'sb' }], skills: [{ id: 'sa' }, { id: 'sb' }], dependencies: [{ taskId: 'b', dependsOnTaskId: 'a' }], config: { maxDailyMin: 30, maxWeeklyMin: 90, minBreak: 0, buffer: 0 } });
    expect(plan(input).items).toEqual([expect.objectContaining({ taskId: 'a', minutes: 19 })]);
  });
  it('reserves minimum weekly skill allocation ahead of ordinary ranking and warns on impossible minima', () => {
    const input = fixture({ horizonDays: 1, tasks: [task('a', 'ga', 300), task('b', 'gb', 300)], goals: [{ id: 'ga', skillId: 'sa' }, { id: 'gb', skillId: 'sb' }], skills: [{ id: 'sa' }, { id: 'sb', minWeeklyMin: 60 }] });
    expect(plan(input).items[0]?.taskId).toBe('b');
    expect(plan({ ...input, skills: [{ id: 'sa' }, { id: 'sb', minWeeklyMin: 200 }] }).warnings.some(value => value.code === 'MINIMUM_ALLOCATION_SHORTFALL')).toBe(true);
  });
  it('warns about an impossible minimum even when all of that skill’s remaining work fits on a later eligible weekday', () => {
    const input = fixture({ tasks: [task('a', 'ga', 20)], goals: [{ id: 'ga', skillId: 'sa' }], skills: [{ id: 'sa', availableDays: [3], minWeeklyMin: 60 }] });
    const result = plan(input);
    expect(result.unplaced).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'MINIMUM_ALLOCATION_SHORTFALL', shortfallMin: 40 }));
  });
  it('uses each goal’s own weekly target rather than other goals in the same skill', () => {
    const input = fixture({ horizonDays: 1, tasks: [task('a', 'ga', 30), task('b', 'gb', 30)], goals: [{ id: 'ga', skillId: 'sa', weeklyTargetMin: 60 }, { id: 'gb', skillId: 'sa', weeklyTargetMin: 60 }], existingWork: [{ date: today, minutes: 50, skillId: 'sa', goalId: 'ga' }], config: { maxDailyMin: 120, maxWeeklyMin: 840, usePriority: true, minBreak: 0, buffer: 0, weights: { deadline: 0, goal: 0, skill: 0, pressure: 0, dependency: 0, recency: 0, revision: 0, switching: 0, allocation: 1 } } });
    expect(plan(input).items[0]?.taskId).toBe('b');
  });
  it('retains feasible previous placements unless that would starve new eligible work', () => {
    const previous = item({ date: addDays(today, 1), startMin: 540, endMin: 600 });
    const input = fixture({ tasks: [task('a', 'ga', 60)], previous: [previous] });
    expect(plan(input).items).toContainEqual(previous);
    const crowded = fixture({ horizonDays: 1, tasks: [task('a', 'ga', 300), task('b', 'gb', 300)], goals: [{ id: 'ga', skillId: 'sa' }, { id: 'gb', skillId: 'sb' }], skills: [{ id: 'sa' }, { id: 'sb' }], previous: [item({ endMin: 600, minutes: 120, workMinutes: 120 })] });
    expect(plan(crowded).items.find(value => value.taskId === 'a')?.minutes).toBe(72);
  });
  it('moves an old placement when fresh scoring improves beyond the stability threshold', () => {
    const previous = item({ date: addDays(today, 1), startMin: 540, endMin: 600 });
    const input = fixture({ tasks: [task('a', 'ga', 60)], goals: [{ id: 'ga', skillId: 'sa' }], previous: [previous], config: { usePriority: true, stabilityThreshold: 1, minBreak: 0, buffer: 0, weights: { deadline: 0, goal: 0, skill: 0, pressure: 0, dependency: 0, recency: 1, revision: 0, switching: 0, allocation: 0 } } });
    expect(plan(input).items).toContainEqual(previous);
    expect(plan({ ...input, config: { ...input.config, stabilityThreshold: 0.15 } }).items).toEqual([expect.objectContaining({ date: today, startMin: 480, score: 1 })]);
  });
  it('prefers feasible historical placements while comparing the diff with the current active plan', () => {
    const current=item(),historical=item({date:addDays(today,1),startMin:540,endMin:600});
    const input=fixture({tasks:[task('a','ga',60)],goals:[{id:'ga',skillId:'sa'}],previous:[current],preferred:[historical]});
    const result=plan(input);
    expect(result.items).toContainEqual(historical);
    expect(result.changes.changes).toEqual([expect.objectContaining({kind:'moved',before:[current],after:[historical]})]);
  });
  it('keeps acceptance separate: directed proposes all changes, adaptive still protects today/tomorrow', () => {
    const input = fixture({ tasks: [task('a', 'ga', 60)] });
    const result = plan(input); expect(result.changes.requiresApproval).toBe(true);
    expect(plan({ ...input, mode: 'adaptive' }).changes.requiresApproval).toBe(true);
    const later = { ...input, mode: 'adaptive' as const, tasks: [task('a', 'ga', 60, { earliestDate: addDays(today, 2) })] };
    expect(plan(later).changes.requiresApproval).toBe(false);
    expect(plan({ ...input, previous: result.items }).changes.changes).toEqual([]);
  });
  it('warns with a numeric shortfall and never invents capacity beyond a deadline', () => {
    const input = fixture({ tasks: [task('a', 'ga', 1000)], goals: [{ id: 'ga', skillId: 'sa', dueDate: today }], horizonDays: 1, config: { buffer: 0.1, maxDailyMin: 120, maxWeeklyMin: 840, minBreak: 0 } });
    expect(plan(input).warnings).toContainEqual(expect.objectContaining({ code: 'INFEASIBLE_DEADLINE', shortfallMin: 892 }));
    expect(plan({ ...input, goals: [{ id: 'ga', skillId: 'sa', dueDate: addDays(today, -1) }] }).unplaced[0]?.code).toBe('BEYOND_DEADLINE');
  });
});

it('holds scheduler invariants over 250 generated capacity/workload snapshots', () => {
  fc.assert(fc.property(fc.array(fc.record({ minutes: fc.integer({ min: 1, max: 240 }), closed: fc.boolean(), skill: fc.boolean() }), { minLength: 1, maxLength: 12 }), fc.integer({ min: 30, max: 240 }), fc.integer({ min: 0, max: 30 }), (rows, dailyCap, occupied) => {
    const input = fixture({ horizonDays: 3, config: { maxDailyMin: dailyCap, maxWeeklyMin: dailyCap * 3, minBreak: 5, breakAfter: 60, buffer: 0 }, goals: [{ id: 'ga', skillId: 'sa' }, { id: 'gb', skillId: 'sb' }], skills: [{ id: 'sa' }, { id: 'sb' }], tasks: rows.map((row, index) => task(String(index), row.skill ? 'ga' : 'gb', row.minutes, { status: row.closed ? 'completed' : 'pending' })), existingWork: [{ date: today, minutes: occupied }] });
    const before = JSON.stringify(input), result = plan(input);
    expect(plan(input)).toEqual(result); expect(JSON.stringify(input)).toBe(before);
    assertPlan(input, result.items);
    for (const value of result.items) expect(input.tasks.find(task => task.id === value.taskId)?.status).toBe('pending');
    for (const task of input.tasks) expect(result.items.filter(value => value.taskId === task.id).reduce((sum, value) => sum + value.workMinutes!, 0)).toBeLessThanOrEqual(task.remainingMinutes + 0.000001);
    for (const day of [today, addDays(today, 1), addDays(today, 2)]) expect(result.items.filter(value => value.date === day).reduce((sum, value) => sum + value.minutes, day === today ? occupied : 0)).toBeLessThanOrEqual(dailyCap);
  }), { numRuns: 250, seed: 20261109 });
});
it('changing priority values leaves fully priority-off plans byte-identical', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 4, maxLength: 4 }), priorities => {
    const input = fixture({ tasks: [task('a', 'ga', 180), task('b', 'gb', 180)], goals: [{ id: 'ga', skillId: 'sa' }, { id: 'gb', skillId: 'sb' }], skills: [{ id: 'sa' }, { id: 'sb' }], config: { usePriority: false, minBreak: 0, maxDailyMin: 120, maxWeeklyMin: 840, buffer: 0 } });
    expect(plan({ ...input, goals: input.goals.map((goal, i) => ({ ...goal, priority: priorities[i] })), skills: input.skills.map((skill, i) => ({ ...skill, priority: priorities[i + 2] })) })).toEqual(plan(input));
  }), { numRuns: 100, seed: 20261109 });
});
it('preserves interval, dependency, frozen and calibrated-work invariants over 150 generated chains', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 90 }), { minLength: 2, maxLength: 8 }), fc.integer({ min: 30, max: 120 }), fc.constantFrom(0.7, 1, 1.3, 2), (minutes, dailyCap, factor) => {
    const tasks = minutes.map((value, index) => task(String(index), 'ga', value));
    const frozenWall = Math.ceil(minutes[0]! * factor), frozen = item({ taskId: '0', endMin: 480 + frozenWall, minutes: frozenWall, workMinutes: minutes[0], pinned: true });
    const input = fixture({ tasks, goals: [{ id: 'ga', skillId: 'sa' }], skills: [{ id: 'sa', maxDailyMin: dailyCap, maxWeeklyMin: dailyCap * 2 }], frozen: [frozen], dependencies: tasks.slice(1).map((value, index) => ({ taskId: value.id, dependsOnTaskId: String(index) })), config: { maxDailyMin: dailyCap, maxWeeklyMin: dailyCap * 2, minBreak: 5, breakAfter: 60, buffer: 0 }, history: { calibration: { sa: factor } } });
    const result = plan(input);
    expect(result.items).toContainEqual(frozen);
    for (let index = 1; index < result.items.length; index++) {
      const previous = result.items[index - 1]!, current = result.items[index]!;
      expect(previous.date < current.date || previous.endMin <= current.startMin).toBe(true);
    }
    for (const value of result.items.filter(value => value.taskId !== '0')) {
      const prerequisite = String(Number(value.taskId) - 1), prior = result.items.filter(value => value.taskId === prerequisite);
      expect(prior.reduce((sum, value) => sum + value.workMinutes!, 0)).toBeCloseTo(tasks[Number(prerequisite)]!.remainingMinutes);
      expect(prior.every(previous => previous.date < value.date || previous.date === value.date && previous.endMin <= value.startMin)).toBe(true);
    }
    for (const task of tasks) expect(result.items.filter(value => value.taskId === task.id).reduce((sum, value) => sum + value.workMinutes!, 0)).toBeLessThanOrEqual(task.remainingMinutes + 0.000001);
    expect(result.items.reduce((sum, value) => sum + value.minutes, 0)).toBeLessThanOrEqual(Math.max(dailyCap * 2, frozenWall));
    expect(plan(input)).toEqual(result);
  }), { numRuns: 150, seed: 20261109 });
});

const goldens: Record<string, PlanInput> = {
  'single-goal-on-track': fixture(),
  'course-60-videos-25-days': course(),
  'infeasible-deadline': fixture({ tasks: [task('a', 'ga', 600)], horizonDays: 1 }),
  'missed-day-partial': fixture({ tasks: [task('a', 'ga', 60, { remainingMinutes: 20, status: 'partial' })] }),
  'two-skills-contention': fixture({ tasks: [task('a', 'ga', 300), task('b', 'gb', 300)], goals: [{ id: 'ga', skillId: 'sa' }, { id: 'gb', skillId: 'sb' }], skills: [{ id: 'sa' }, { id: 'sb' }] }),
  'reserved-window-fill': fixture({ horizonDays: 1, freeSlots: { [today]: [{ date: today, startMin: 480, endMin: 540 }, { date: today, startMin: 1080, endMin: 1140, skillId: 'sa' }] } }),
  'dependency-chain': fixture({ tasks: [task('a', 'ga', 30), task('b', 'ga', 30)], dependencies: [{ taskId: 'b', dependsOnTaskId: 'a' }] }),
  'freeze-window-proposal': fixture({ frozen: [item({ pinned: true })], previous: [item({ pinned: true })] }),
  'break-week': fixture({ freeSlots: { [today]: [{ date: today, startMin: 480, endMin: 600 }] } }),
  'calibration-1-3x': fixture({ tasks: [task('a', 'ga', 180, { kind: 'reading' })], history: { samples: Array.from({ length: 5 }, () => sample(78)) } }),
  'priority-off': fixture({ tasks: [task('a', 'ga', 180), task('b', 'gb', 180)], goals: [{ id: 'ga', skillId: 'sa', priority: 1 }, { id: 'gb', skillId: 'sb', priority: 5 }], skills: [{ id: 'sa' }, { id: 'sb' }] }),
  'priority-mixed': fixture({ tasks: [task('a', 'ga', 180), task('b', 'gb', 180)], goals: [{ id: 'ga', skillId: 'sa', priority: 1, usePriority: 'off' }, { id: 'gb', skillId: 'sb', priority: 5, usePriority: 'on' }], skills: [{ id: 'sa' }, { id: 'sb' }] }),
};
for (const [name, input] of Object.entries(goldens)) it(`golden: ${name}`, () => { expect(JSON.stringify({ input, result: plan(input), feasibility: feasibility(input) }, null, 2)).toMatchSnapshot(); });
