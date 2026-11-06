import { addDays, dateRange, daysBetween, parseLocalDate, weekday, weekStartDate } from '@kram/time';
import type { GoalFeasibility, GoalMeta, PlanChange, PlanInput, PlanItem, PlanResult, SchedulerConfig, SkillMeta, Slot, Task, UnplacedCode, Warning } from './types';
import { calibrationFor, clamp, closedStatuses, configuration, effectiveDeadline, priorityEnabled, round } from './policy';

const epsilon = 0.000001;
const samePlacement = (a: PlanItem, b: PlanItem) => a.taskId === b.taskId && a.goalId === b.goalId && a.skillId === b.skillId && a.date === b.date && a.startMin === b.startMin && a.endMin === b.endMin && Math.abs((a.workMinutes ?? a.minutes) - (b.workMinutes ?? b.minutes)) < epsilon && !!a.pinned === !!b.pinned;
const byTime = (a: PlanItem | Slot, b: PlanItem | Slot) => a.date.localeCompare(b.date) || a.startMin - b.startMin || a.endMin - b.endMin;
const openGoal = (goal: GoalMeta) => !goal.status || goal.status === 'active';
function validNumber(value: number, label: string) { if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a non-negative finite number.`); }
function validInterval(item: Slot | PlanItem) { parseLocalDate(item.date); if (!Number.isInteger(item.startMin) || !Number.isInteger(item.endMin) || item.startMin < 0 || item.endMin > 1440 || item.endMin <= item.startMin) throw new RangeError('Use an increasing scheduler interval inside one civil day.'); }
interface Context {
  input: PlanInput; config: SchedulerConfig; days: string[];
  tasks: Map<string, Task>; goals: Map<string, GoalMeta>; skills: Map<string, SkillMeta>;
  taskList: Task[]; tasksByGoal: Map<string, Task[]>;
  factors: Map<string, number>; deps: Map<string, string[]>; completed: Set<string>;
  slots: Map<string, Slot[]>; enabled: boolean;
  weeks: Map<string, string>; eligibility: Map<string, boolean>;
}
function context(input: PlanInput): Context {
  parseLocalDate(input.today);
  const horizon = input.horizonDays ?? 14;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 366) throw new RangeError('Planning horizon must be between 1 and 366 civil days.');
  if (input.mode && !['directed', 'adaptive', 'balanced', 'deadline'].includes(input.mode)) throw new RangeError('Unknown planning mode.');
  const days = dateRange(input.today, addDays(input.today, horizon - 1)), config = configuration(input);
  const unique = <T extends { id: string }>(rows: T[], label: string) => { const values = new Map<string, T>(); for (const row of rows) { if (!row.id || values.has(row.id)) throw new RangeError(`Duplicate or missing ${label} identifier.`); values.set(row.id, row); } return values; };
  const tasks = unique(input.tasks, 'task'), goals = unique(input.goals, 'goal'), skills = unique(input.skills, 'skill');
  const factors = new Map<string, number>(), factorsByKind = new Map<string, number>(), deps = new Map<string, string[]>(), completed = new Set(input.history?.completedTaskIds ?? []), slots = new Map<string, Slot[]>();
  for (const task of tasks.values()) {
    validNumber(task.remainingMinutes, 'Task remainder'); validNumber(task.estMinutes, 'Task estimate');
    if (!goals.has(task.goalId) || !skills.has(task.skillId ?? goals.get(task.goalId)!.skillId)) throw new RangeError('Every scheduler task needs its goal and skill metadata.');
    if (task.earliestDate) parseLocalDate(task.earliestDate); if (task.dueDate) parseLocalDate(task.dueDate);
    const skillId = task.skillId ?? goals.get(task.goalId)!.skillId;
    const factorKey=JSON.stringify([skillId,task.kind??null]);
    let factor=factorsByKind.get(factorKey);if(factor===undefined){factor=calibrationFor(input,task,skillId);factorsByKind.set(factorKey,factor);}factors.set(task.id,factor);
    if (task.status === 'completed') completed.add(task.id);
  }
  for (const goal of goals.values()) {
    if (!skills.has(goal.skillId)) throw new RangeError('Every scheduler goal needs its skill metadata.');
    if (goal.dueDate) parseLocalDate(goal.dueDate);
    for (const value of [goal.maxDailyMin, goal.weeklyTargetMin]) if (value !== undefined) validNumber(value, 'Goal capacity');
    if (goal.availableDays?.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new RangeError('Goal weekdays must be from 1 to 7.');
  }
  for (const skill of skills.values()) {
    for (const value of [skill.maxDailyMin, skill.maxWeeklyMin, skill.minWeeklyMin, skill.weeklyTargetMin, skill.allocationWeight]) if (value !== undefined) validNumber(value, 'Skill allocation');
    if (skill.availableDays?.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new RangeError('Skill weekdays must be from 1 to 7.');
  }
  for (const dep of input.dependencies ?? []) { const list = deps.get(dep.taskId) ?? []; if (!list.includes(dep.dependsOnTaskId)) list.push(dep.dependsOnTaskId); deps.set(dep.taskId, list.sort()); }
  for (const date of days) {
    const available = (input.freeSlots[date] ?? []).map(slot => ({ ...slot })).sort(byTime);
    for (let i = 0; i < available.length; i++) {
      const slot = available[i]!; validInterval(slot);
      if (slot.date !== date || slot.skillId && !skills.has(slot.skillId)) throw new RangeError('Free intervals need their matching date and a known reserved skill.');
      if (i && available[i - 1]!.endMin > slot.startMin) throw new RangeError('Free scheduler intervals must be disjoint.');
    }
    slots.set(date, available);
  }
  for (const existing of input.existingWork ?? []) { parseLocalDate(existing.date); validNumber(existing.minutes, 'Existing workload'); if (existing.skillId && !skills.has(existing.skillId) || existing.goalId && !goals.has(existing.goalId)) throw new RangeError('Existing workload needs known skill and goal identifiers.'); }
  const taskList = [...tasks.values()], tasksByGoal = new Map<string, Task[]>();
  for (const task of taskList) { const rows = tasksByGoal.get(task.goalId) ?? []; rows.push(task); tasksByGoal.set(task.goalId, rows); }
  return { input, config, days, tasks, taskList, tasksByGoal, goals, skills, factors, deps, completed, slots, weeks: new Map(), eligibility: new Map(), enabled: input.tasks.some(task => !closedStatuses.has(task.status) && priorityEnabled(input, goals.get(task.goalId)!, skills.get(task.skillId ?? goals.get(task.goalId)!.skillId)!)) };
}
function eligible(ctx: Context, task: Task, date: string) {
  const cacheKey = key(task.id, date), cached = ctx.eligibility.get(cacheKey); if (cached !== undefined) return cached;
  const goal = ctx.goals.get(task.goalId)!, skill = ctx.skills.get(task.skillId ?? goal.skillId)!;
  const due = effectiveDeadline(task, goal), day = weekday(date);
  const value = !closedStatuses.has(task.status) && task.status !== 'paused' && openGoal(goal) && (!task.earliestDate || task.earliestDate <= date) && (!due || date <= due) && (!goal.availableDays || goal.availableDays.includes(day)) && (!skill.availableDays || skill.availableDays.includes(day));
  ctx.eligibility.set(cacheKey, value); return value;
}
function weekOf(ctx: Context, date: string) { let week = ctx.weeks.get(date); if (week === undefined) { week = weekStartDate(date, ctx.config.weekStart); ctx.weeks.set(date, week); } return week; }
function subtract(slots: Slot[], busy: Slot[]): Slot[] {
  let result = slots.map(slot => ({ ...slot }));
  for (const taken of busy) result = result.flatMap(slot => {
    if (slot.date !== taken.date || slot.endMin <= taken.startMin || slot.startMin >= taken.endMin) return [slot];
    return [{ ...slot, endMin: Math.min(slot.endMin, taken.startMin) }, { ...slot, startMin: Math.max(slot.startMin, taken.endMin) }].filter(value => value.endMin > value.startMin);
  });
  return result.sort(byTime);
}
interface Totals { day: Map<string, number>; week: Map<string, number>; skillDay: Map<string, number>; skillWeek: Map<string, number>; goalDay: Map<string, number>; goalWeek: Map<string, number>; goalFlexibleDay: Map<string, number> }
const key = (scope: string, period: string) => `${scope}\u0000${period}`;
const get = (map: Map<string, number>, value: string) => map.get(value) ?? 0;
function totals(ctx: Context, items: PlanItem[]): Totals {
  const values: Totals = { day: new Map(), week: new Map(), skillDay: new Map(), skillWeek: new Map(), goalDay: new Map(), goalWeek: new Map(), goalFlexibleDay: new Map() };
  for (const item of ctx.input.existingWork ?? []) account(ctx, values, item, false);
  for (const item of items) account(ctx, values, item, !item.pinned);
  return values;
}
function account(ctx: Context, values: Totals, item: { date: string; minutes: number; goalId?: string; skillId?: string }, flexible: boolean) {
  const week = weekOf(ctx, item.date), add = (map: Map<string, number>, value: string) => map.set(value, round(get(map, value) + item.minutes));
  add(values.day, item.date); add(values.week, week);
  if (item.skillId) { add(values.skillDay, key(item.skillId, item.date)); add(values.skillWeek, key(item.skillId, week)); }
  if (item.goalId) { add(values.goalDay, key(item.goalId, item.date)); add(values.goalWeek, key(item.goalId, week)); if (flexible) add(values.goalFlexibleDay, key(item.goalId, item.date)); }
}
function capacity(ctx: Context, values: Totals, task: Task, date: string) {
  const goal = ctx.goals.get(task.goalId)!, skill = ctx.skills.get(task.skillId ?? goal.skillId)!, week = weekOf(ctx, date);
  return Math.max(0, Math.min(ctx.config.maxDailyMin - get(values.day, date), ctx.config.maxWeeklyMin - get(values.week, week), (skill.maxDailyMin ?? 1440) - get(values.skillDay, key(skill.id, date)), (skill.maxWeeklyMin ?? 10080) - get(values.skillWeek, key(skill.id, week)), (goal.maxDailyMin ?? 1440) - get(values.goalDay, key(goal.id, date))));
}
function wallWork(ctx: Context, task: Task, workMinutes: number) { return Math.ceil(round(workMinutes * ctx.factors.get(task.id)!)); }
function consumed(ctx: Context, item: PlanItem) { return item.workMinutes ?? round(item.minutes / ctx.factors.get(item.taskId)!); }
function dependenciesMet(ctx: Context, task: Task, date: string, minute: number, remaining: Map<string, number>, items: PlanItem[]) {
  return (ctx.deps.get(task.id) ?? []).every(id => {
    if (ctx.completed.has(id)) return true;
    if (!ctx.tasks.has(id) || (remaining.get(id) ?? Infinity) > epsilon) return false;
    const previous = items.filter(item => item.taskId === id && consumed(ctx, item) > epsilon).sort(byTime).at(-1);
    return !!previous && (previous.date < date || previous.date === date && previous.endMin <= minute);
  });
}
function baseFrozen(ctx: Context): PlanItem[] {
  const result: PlanItem[] = [];
  for (const item of [...(ctx.input.frozen ?? [])].sort(byTime)) {
    validInterval(item); validNumber(item.minutes, 'Frozen minutes'); validNumber(item.workMinutes ?? item.minutes, 'Frozen work');
    const task = ctx.tasks.get(item.taskId);
    if (!task || closedStatuses.has(task.status) || task.status === 'paused' || !openGoal(ctx.goals.get(task.goalId)!)) continue;
    if (!ctx.days.includes(item.date)) continue;
    if (item.goalId !== task.goalId || item.skillId !== (task.skillId ?? ctx.goals.get(task.goalId)!.skillId) || Math.abs(item.minutes - (item.endMin - item.startMin)) > epsilon) throw new RangeError('Frozen placements must match their task, skill and interval.');
    if (result.some(previous => previous.date === item.date && previous.startMin < item.endMin && previous.endMin > item.startMin)) throw new RangeError('Frozen placements overlap; reconcile the accepted timetable first.');
    result.push({ ...item });
  }
  const work = new Map<string, number>();
  for (const item of result) work.set(item.taskId, round(get(work, item.taskId) + consumed(ctx, item)));
  for (const [id, amount] of work) if (amount > ctx.tasks.get(id)!.remainingMinutes + epsilon) throw new RangeError('Frozen work exceeds the current task remainder; adapt the snapshot without moving its wall times.');
  return result;
}

/** Capacity estimate before application; includes existing weekly occupancy and
 * frozen allocations without counting their occupied intervals twice. */
export function feasibility(input: PlanInput): GoalFeasibility[] {
  const ctx = context(input), frozen = baseFrozen(ctx), base = totals(ctx, frozen), free = new Map<string, Slot[]>();
  for (const date of ctx.days) free.set(date, subtract(ctx.slots.get(date)!, frozen.filter(item => item.date === date)));
  return [...ctx.goals.values()].filter(openGoal).sort((a, b) => a.id.localeCompare(b.id)).map(goal => {
    const tasks = (ctx.tasksByGoal.get(goal.id) ?? []).filter(task => !closedStatuses.has(task.status) && task.status !== 'paused');
    const remainingMin = round(tasks.reduce((sum, task) => sum + task.remainingMinutes * ctx.factors.get(task.id)!, 0));
    let availableMin = 0, eligibleDays = 0;
    const weekUsed = new Map<string, number>(), skillWeekUsed = new Map<string, number>();
    for (const date of ctx.days) {
      const candidates = tasks.filter(task => eligible(ctx, task, date));
      if (!candidates.length) continue;
      eligibleDays++;
      const skill = ctx.skills.get(goal.skillId)!, week = weekOf(ctx, date), ownFrozen = frozen.filter(item => item.date === date && item.goalId === goal.id).reduce((sum, item) => sum + item.minutes, 0);
      const slots = free.get(date)!.filter(slot => !slot.skillId || slot.skillId === goal.skillId);
      const physical = slots.reduce((sum, slot) => sum + slot.endMin - slot.startMin, 0);
      const competitor = ctx.taskList.some(task => task.goalId !== goal.id && task.remainingMinutes > 0 && eligible(ctx, task, date));
      const ownProtected = frozen.filter(item => item.date === date && !item.pinned).reduce((sum, item) => sum + item.minutes, 0);
      const flexible = Math.max(0, Math.min(free.get(date)!.reduce((sum, slot) => sum + slot.endMin - slot.startMin, 0) + ownProtected, ctx.config.maxDailyMin - get(base.day, date) + ownProtected, ctx.config.maxWeeklyMin - get(base.week, week) - get(weekUsed, week) + ownProtected));
      const share = competitor ? Math.max(0, flexible * ctx.config.maxGoalShare - get(base.goalFlexibleDay, key(goal.id, date))) : physical;
      const budget = Math.max(0, Math.min(physical, share, ctx.config.maxDailyMin - get(base.day, date), ctx.config.maxWeeklyMin - get(base.week, week) - get(weekUsed, week), (skill.maxDailyMin ?? 1440) - get(base.skillDay, key(skill.id, date)), (skill.maxWeeklyMin ?? 10080) - get(base.skillWeek, key(skill.id, week)) - get(skillWeekUsed, week), (goal.maxDailyMin ?? 1440) - get(base.goalDay, key(goal.id, date))));
      availableMin += budget + ownFrozen; weekUsed.set(week, get(weekUsed, week) + budget); skillWeekUsed.set(week, get(skillWeekUsed, week) + budget);
    }
    availableMin = round(availableMin);
    const buffered = availableMin * (1 - ctx.config.buffer), shortfallMin = round(Math.max(0, remainingMin - buffered));
    return { goalId: goal.id, remainingMin, availableMin, shortfallMin, requiredPerDay: eligibleDays ? round(remainingMin / eligibleDays) : remainingMin, eligibleDays, feasible: shortfallMin <= epsilon };
  });
}

interface Run { items: PlanItem[]; remaining: Map<string, number>; warnings: Warning[] }
function run(ctx: Context, frozen: PlanItem[], estimates: GoalFeasibility[], anchors: PlanItem[] = []): Run {
  const items = [...frozen.map(item => ({ ...item })), ...anchors.map(item => ({ ...item }))].sort(byTime), values = totals(ctx, items);
  const remaining = new Map([...ctx.tasks.values()].map(task => [task.id, task.remainingMinutes]));
  for (const item of items) remaining.set(item.taskId, round(remaining.get(item.taskId)! - consumed(ctx, item)));
  const warnings: Warning[] = frozen.filter(item => !eligible(ctx, ctx.tasks.get(item.taskId)!, item.date)).map(item => ({ goalId: item.goalId, code: 'FROZEN_ELIGIBILITY_CONFLICT', message: `${ctx.tasks.get(item.taskId)!.title ?? item.taskId} has a protected placement outside its current eligibility. Review it before moving the time.` })), free = new Map<string, Slot[]>(), flexible = new Map<string, number>();
  for (const date of ctx.days) {
    const occupied = items.filter(item => item.date === date);
    const intervals = subtract(ctx.slots.get(date)!, occupied.map(item => ({ ...item, endMin: Math.min(1440, item.endMin + (item.minutes >= ctx.config.breakAfter ? ctx.config.minBreak : 0)) })));
    free.set(date, intervals);
    flexible.set(date, intervals.reduce((sum, slot) => sum + slot.endMin - slot.startMin, 0) + occupied.filter(item => !item.pinned).reduce((sum, item) => sum + item.minutes, 0));
    if (get(values.day, date) > ctx.config.maxDailyMin) warnings.push({ code: 'EXISTING_DAILY_OVERLOAD', message: `${date} already has ${round(get(values.day, date))} min committed, above the ${ctx.config.maxDailyMin} min daily limit.` });
  }
  const estimateByGoal = new Map(estimates.map(value => [value.goalId, value]));
  const unblocks = (id: string) => {
    const seen = new Set<string>(), todo = [id];
    while (todo.length) { const next = todo.pop()!; for (const [dependent, deps] of ctx.deps) if (deps.includes(next) && dependent !== id && !seen.has(dependent)) { seen.add(dependent); todo.push(dependent); } }
    return seen.size;
  };
  const descendants = new Map([...ctx.tasks.keys()].map(id => [id, unblocks(id)])), maxDescendants = Math.max(1, ...descendants.values());
  const allocationWeight = Math.max(1, [...ctx.skills.values()].reduce((sum, skill) => sum + (skill.allocationWeight ?? 1), 0));
  const manualOrder = (a: Task, b: Task) => {
    const ga = ctx.goals.get(a.goalId)!, gb = ctx.goals.get(b.goalId)!, sa = ctx.skills.get(a.skillId ?? ga.skillId)!, sb = ctx.skills.get(b.skillId ?? gb.skillId)!;
    return (effectiveDeadline(a, ga) ?? '9999-12-31').localeCompare(effectiveDeadline(b, gb) ?? '9999-12-31') || (sa.order ?? sa.sortOrder ?? 0) - (sb.order ?? sb.sortOrder ?? 0) || (ga.order ?? ga.sortOrder ?? 0) - (gb.order ?? gb.sortOrder ?? 0) || (a.order ?? a.sortOrder ?? 0) - (b.order ?? b.sortOrder ?? 0) || a.id.localeCompare(b.id);
  };
  const score = (task: Task, date: string, minute: number) => {
    if (!ctx.enabled) return 0;
    const goal = ctx.goals.get(task.goalId)!, skill = ctx.skills.get(task.skillId ?? goal.skillId)!, enabled = priorityEnabled(ctx.input, goal, skill), due = effectiveDeadline(task, goal), estimate = estimateByGoal.get(goal.id), week = weekOf(ctx, date);
    const required = (ctx.tasksByGoal.get(goal.id) ?? []).reduce((sum, item) => sum + Math.max(0, remaining.get(item.id) ?? 0) * ctx.factors.get(item.id)!, 0);
    const daily = estimate && estimate.eligibleDays ? estimate.availableMin / estimate.eligibleDays : Math.max(1, ctx.config.maxDailyMin);
    const slack = due ? daysBetween(date, due) + 1 - required / Math.max(1, daily) : 30;
    const urgency = due ? slack <= 0 ? 1 : 4 / (slack + 4) : 0;
    const last = ctx.input.history?.lastPractice?.[skill.id], recency = enabled ? last ? clamp(daysBetween(last, date) / 14) : 1 : 0;
    const prior = items.filter(item => item.date === date && item.endMin <= minute).sort(byTime).at(-1);
    const allocationTarget = goal.weeklyTargetMin || Math.max(1, skill.minWeeklyMin || skill.weeklyTargetMin || ctx.config.maxWeeklyMin * (skill.allocationWeight ?? 1) / allocationWeight);
    const allocated = goal.weeklyTargetMin ? get(values.goalWeek, key(goal.id, week)) : get(values.skillWeek, key(skill.id, week));
    const weight = ctx.config.weights;
    return round(weight.deadline * urgency + weight.goal * clamp(((enabled ? goal.priority ?? 3 : 3) - 1) / 4) + weight.skill * clamp(((enabled ? skill.priority ?? 3 : 3) - 1) / 4) + weight.pressure * clamp(required / Math.max(1, estimate?.availableMin ?? daily)) + weight.dependency * (descendants.get(task.id)! / maxDescendants) + weight.recency * recency + weight.revision * (enabled && task.revisionDue ? 1 : 0) - weight.switching * (prior && prior.skillId !== skill.id ? 1 : 0) + weight.allocation * clamp(1 - allocated / allocationTarget));
  };
  const candidateSize = (task: Task, date: string, minute: number, slot: Slot, withShare: boolean) => {
    if ((remaining.get(task.id) ?? 0) <= epsilon || !eligible(ctx, task, date) || !dependenciesMet(ctx, task, date, minute, remaining, items)) return 0;
    const goal = ctx.goals.get(task.goalId)!, skillId = task.skillId ?? goal.skillId;
    if (slot.skillId && slot.skillId !== skillId) return 0;
    const full = wallWork(ctx, task, remaining.get(task.id)!), budget = capacity(ctx, values, task, date);
    let allowed = Math.floor(Math.min(slot.endMin - minute, budget));
    if (withShare) allowed = Math.min(allowed, Math.floor(Math.max(0, (flexible.get(date) ?? 0) * ctx.config.maxGoalShare - get(values.goalFlexibleDay, key(goal.id, date)))));
    if (task.supportsSplit === false) return full <= allowed ? full : 0;
    if (full <= allowed) return full;
    return allowed >= ctx.config.minChunk ? allowed : 0;
  };
  const initialItems = new Set(items);
  const competes = (other: Task, goalId: string, date: string, minute: number) => {
    if ((remaining.get(other.id) ?? 0) <= epsilon || !eligible(ctx, other, date) || !dependenciesMet(ctx, other, date, minute, remaining, items)) return false;
    // Compare with the time this goal has already taken restored. A greedy
    // placement must not make a rival ineligible merely by leaving a fragment
    // shorter than its minimum chunk or whole non-splittable task.
    const alternative = items.filter(item => initialItems.has(item) || item.date !== date || item.goalId !== goalId);
    const budget = capacity(ctx, totals(ctx, alternative), other, date), full = wallWork(ctx, other, remaining.get(other.id)!);
    const occupied = alternative.filter(item => item.date === date && !initialItems.has(item)).map(item => ({ ...item, endMin: Math.min(1440, item.endMin + (item.minutes >= ctx.config.breakAfter ? ctx.config.minBreak : 0)) }));
    return subtract(free.get(date)!, occupied).some(slot => (!slot.skillId || slot.skillId === (other.skillId ?? ctx.goals.get(other.goalId)!.skillId)) && (full <= Math.min(budget, slot.endMin - slot.startMin) || other.supportsSplit !== false && Math.min(budget, slot.endMin - slot.startMin) >= ctx.config.minChunk));
  };
  for (const date of ctx.days) {
    const ownProtected = items.filter(item => item.date === date && !item.pinned).reduce((sum, item) => sum + item.minutes, 0);
    flexible.set(date, Math.max(0, Math.min(flexible.get(date)!, ctx.config.maxDailyMin - get(values.day, date) + ownProtected, ctx.config.maxWeeklyMin - get(values.week, weekOf(ctx, date)) + ownProtected)));
    const dailyPlaced = new Map<string, number>();
    const intervals = [...free.get(date)!].sort((a, b) => Number(!!b.skillId) - Number(!!a.skillId) || a.startMin - b.startMin);
    for (const slot of intervals) {
      let minute = slot.startMin;
      while (minute < slot.endMin) {
        const raw = ctx.taskList.filter(task => candidateSize(task, date, minute, slot, false) > 0);
        if (!raw.length) break;
        const competition = new Map<string, boolean>(), pacing = new Map<string, number>();
        const deficit = (task: Task) => {
          const skill = ctx.skills.get(task.skillId ?? ctx.goals.get(task.goalId)!.skillId)!;
          return Math.max(0, (skill.minWeeklyMin ?? 0) - get(values.skillWeek, key(skill.id, weekOf(ctx, date))));
        };
        const candidates = raw.map(task => {
          const goal = ctx.goals.get(task.goalId)!, skillId = task.skillId ?? goal.skillId;
          let others = competition.get(goal.id);
          if (others === undefined) { others = ctx.taskList.some(other => other.goalId !== task.goalId && competes(other, task.goalId, date, minute)); competition.set(goal.id, others); }
          let size = candidateSize(task, date, minute, slot, others);
          if (task.supportsSplit !== false && deficit(task) > 0) size = Math.min(size, Math.max(ctx.config.minChunk, Math.ceil(deficit(task))));
          // Pace deadline work across remaining eligible dates. This is a soft
          // target: whole non-splittable tasks and hard weekly minima may exceed it.
          const due = effectiveDeadline(task, goal);
          if (due && task.supportsSplit !== false && deficit(task) <= 0) {
            const paceKey = key(goal.id, skillId);
            let pace = pacing.get(paceKey);
            if (pace === undefined) {
              const goalTasks = ctx.tasksByGoal.get(goal.id) ?? [];
              const futureDays = ctx.days.filter(day => day >= date && goalTasks.some(item => remaining.get(item.id)! > epsilon && eligible(ctx, item, day) && free.get(day)!.some(interval => !interval.skillId || interval.skillId === skillId)));
              const work = goalTasks.reduce((sum, item) => sum + Math.max(0, remaining.get(item.id) ?? 0) * ctx.factors.get(item.id)!, 0) + get(dailyPlaced, goal.id);
              pace = Math.max(ctx.config.minChunk, Math.ceil(work / Math.max(1, futureDays.length) / ctx.config.minChunk) * ctx.config.minChunk); pacing.set(paceKey, pace);
            }
            const left = Math.max(0, pace - get(dailyPlaced, goal.id));
            size = Math.min(size, left);
          }
          if (size < ctx.config.minChunk && size < wallWork(ctx, task, remaining.get(task.id)!)) size = 0;
          return { task, size, score: ctx.enabled ? score(task, date, minute) : 0, deficit: deficit(task) };
        }).filter(candidate => candidate.size > 0);
        if (!candidates.length) break;
        candidates.sort((a, b) => Number(b.deficit > 0) - Number(a.deficit > 0) || b.score - a.score || manualOrder(a.task, b.task));
        const { task, size, score: itemScore } = candidates[0]!;
        place(task, size, date, minute, slot, itemScore, candidates[1]?.task);
        minute += size + (size >= ctx.config.breakAfter ? ctx.config.minBreak : 0);
      }
    }
    function place(task: Task, size: number, day: string, startMin: number, slot: Slot, itemScore: number, runner?: Task) {
      const goal = ctx.goals.get(task.goalId)!, skillId = task.skillId ?? goal.skillId, due = effectiveDeadline(task, goal), last = ctx.input.history?.lastPractice?.[skillId];
      const workMinutes = Math.min(remaining.get(task.id)!, round(size / ctx.factors.get(task.id)!));
      const goalWork = round((ctx.tasksByGoal.get(goal.id) ?? []).filter(value => !closedStatuses.has(value.status)).reduce((sum, value) => sum + Math.max(0, remaining.get(value.id) ?? 0) * ctx.factors.get(value.id)!, 0));
      const reasons = [slot.skillId ? `Reserved time for ${skillId}` : 'Open time within your capacity', due ? `deadline in ${daysBetween(day, due)} days with ${goalWork} min of goal work left` : 'your manual order', ctx.factors.get(task.id) !== 1 ? `estimate adjusted ${ctx.factors.get(task.id)}× from completed work` : undefined, ctx.enabled && priorityEnabled(ctx.input, goal, ctx.skills.get(skillId)!) && last ? `last practiced ${Math.max(0, daysBetween(last, day))} days ago` : undefined, runner ? `runner-up: ${runner.title ?? runner.id}${ctx.enabled ? ` (score ${score(runner, day, startMin)})` : ''}` : undefined].filter(Boolean).join('; ');
      const item: PlanItem = { taskId: task.id, goalId: goal.id, skillId, date: day, startMin, endMin: startMin + size, minutes: size, workMinutes, score: itemScore, explanation: reasons };
      items.push(item); remaining.set(task.id, round(remaining.get(task.id)! - workMinutes)); account(ctx, values, item, true); dailyPlaced.set(goal.id, get(dailyPlaced, goal.id) + size);
    }
  }
  for (const week of [...new Set(ctx.days.map(date => weekOf(ctx, date)))].sort()) {
    if (get(values.week, week) > ctx.config.maxWeeklyMin) warnings.push({ code: 'EXISTING_WEEKLY_OVERLOAD', message: `The week of ${week} already has ${round(get(values.week, week))} min committed, above the ${ctx.config.maxWeeklyMin} min weekly limit.` });
    for (const skill of ctx.skills.values()) {
      const amount = get(values.skillWeek, key(skill.id, week));
      if (amount > (skill.maxWeeklyMin ?? Infinity)) warnings.push({ code: 'EXISTING_SKILL_OVERLOAD', message: `${skill.id} already exceeds its weekly capacity in the week of ${week}.` });
      if ((skill.minWeeklyMin ?? 0) > amount && ctx.taskList.some(task => (task.skillId ?? ctx.goals.get(task.goalId)!.skillId) === skill.id && task.remainingMinutes > epsilon && ctx.days.some(date => weekOf(ctx, date) === week && eligible(ctx, task, date)))) warnings.push({ code: 'MINIMUM_ALLOCATION_SHORTFALL', message: `${skill.id} is short by ${round(skill.minWeeklyMin! - amount)} min of its minimum for the week of ${week}.`, shortfallMin: round(skill.minWeeklyMin! - amount) });
    }
  }
  return { items: items.sort((a, b) => byTime(a, b) || a.taskId.localeCompare(b.taskId)), remaining, warnings };
}

function anchorPrevious(ctx: Context, frozen: PlanItem[]): PlanItem[] {
  const anchors: PlanItem[] = [], work = new Map<string, number>();
  for (const item of frozen) work.set(item.taskId, get(work, item.taskId) + consumed(ctx, item));
  for (const item of [...(ctx.input.preferred ?? ctx.input.previous ?? [])].sort((a, b) => byTime(a, b) || a.taskId.localeCompare(b.taskId))) {
    const task = ctx.tasks.get(item.taskId);
    if (!task || !ctx.days.includes(item.date) || !eligible(ctx, task, item.date) || frozen.some(value => samePlacement(value, item))) continue;
    try { validInterval(item); } catch { continue; }
    if (item.goalId !== task.goalId || item.skillId !== (task.skillId ?? ctx.goals.get(task.goalId)!.skillId) || item.minutes !== item.endMin - item.startMin || item.workMinutes !== undefined && (!Number.isFinite(item.workMinutes) || item.workMinutes < 0)) continue;
    if (![...frozen, ...anchors].every(other => other.date !== item.date || other.endMin <= item.startMin || other.startMin >= item.endMin)) continue;
    if (!ctx.slots.get(item.date)!.some(slot => slot.startMin <= item.startMin && slot.endMin >= item.endMin && (!slot.skillId || slot.skillId === item.skillId))) continue;
    const amount = consumed(ctx, item); if (!Number.isFinite(amount) || amount <= epsilon || get(work, item.taskId) + amount > task.remainingMinutes + epsilon) continue;
    const values = totals(ctx, [...frozen, ...anchors]); if (capacity(ctx, values, task, item.date) < item.minutes) continue;
    anchors.push({ ...item }); work.set(item.taskId, get(work, item.taskId) + amount);
  }
  // A retained dependent cannot reserve an early position while its prerequisite
  // still needs unplaced work. Remove those anchors until the graph stabilises.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = anchors.length - 1; i >= 0; i--) {
      const item = anchors[i]!, dependencies = ctx.deps.get(item.taskId) ?? [];
      if (dependencies.some(id => !ctx.completed.has(id) && (get(work, id) + epsilon < (ctx.tasks.get(id)?.remainingMinutes ?? Infinity) || [...frozen, ...anchors].some(value => value.taskId === id && consumed(ctx, value) > epsilon && (value.date > item.date || value.date === item.date && value.endMin > item.startMin))))) {
        anchors.splice(i, 1); work.set(item.taskId, get(work, item.taskId) - consumed(ctx, item)); changed = true;
      }
    }
  }
  return anchors;
}
function unplacedCode(ctx: Context, task: Task, result: Run): UnplacedCode {
  const goal = ctx.goals.get(task.goalId)!;
  if (!openGoal(goal) || task.status === 'paused') return 'PAUSED_GOAL';
  if ((ctx.deps.get(task.id) ?? []).some(id => !ctx.completed.has(id) && (!ctx.tasks.has(id) || (result.remaining.get(id) ?? Infinity) > epsilon))) return 'BLOCKED_BY_DEP';
  const due = effectiveDeadline(task, goal);
  if (due && (due < ctx.input.today || due <= ctx.days.at(-1)! && !ctx.days.some(date => eligible(ctx, task, date)))) return 'BEYOND_DEADLINE';
  if ((ctx.input.frozen ?? []).some(item => item.taskId === task.id && !eligible(ctx, task, item.date))) return 'FROZEN_CONFLICT';
  return 'NO_CAPACITY';
}
const reason: Record<UnplacedCode, string> = { PAUSED_GOAL: 'This goal or task is paused. Resume it before planning more work.', BLOCKED_BY_DEP: 'A prerequisite still needs to finish before this task can begin.', BEYOND_DEADLINE: 'No eligible date remains before the deadline. Extend the date or reduce the remaining scope.', FROZEN_CONFLICT: 'The protected placement conflicts with this task’s eligibility. Review the placement before changing it.', NO_CAPACITY: 'There is not enough eligible time within the configured capacity. Move a commitment, extend the date or reduce scope.' };
function changes(input: PlanInput, items: PlanItem[]): PlanResult['changes'] {
  const old = input.previous ?? [], ids = [...new Set([...old.map(item => item.taskId), ...items.map(item => item.taskId)])].sort(), result: PlanChange[] = [];
  for (const id of ids) {
    const before = old.filter(item => item.taskId === id).sort(byTime), after = items.filter(item => item.taskId === id).sort(byTime);
    if (before.length === after.length && before.every((item, i) => samePlacement(item, after[i]!))) continue;
    result.push({ taskId: id, kind: before.length ? after.length ? 'moved' : 'removed' : 'added', ...(before.length ? { before } : {}), ...(after.length ? { after } : {}), reason: after[0]?.explanation ?? 'Recorded state or eligibility removed this task from open work.' });
  }
  const tomorrow = addDays(input.today, 1), frozenChangeCount = result.filter(change => [...(change.before ?? []), ...(change.after ?? [])].some(item => item.date >= input.today && item.date <= tomorrow || item.pinned)).length;
  return { changes: result, requiresApproval: result.length > 0 && ((input.mode ?? 'directed') === 'directed' || frozenChangeCount > 0), frozenChangeCount };
}
/** Deterministic allocation. The application owns input hashing and acceptance. */
export function plan(input: PlanInput): PlanResult {
  const ctx = context(input), frozen = baseFrozen(ctx), estimates = feasibility(input), fresh = run(ctx, frozen, estimates), anchors = anchorPrevious(ctx, frozen);
  let selected = fresh;
  if (anchors.length) {
    const stable = run(ctx, frozen, estimates, anchors);
    const openWork = (result: Run) => [...ctx.tasks.values()].filter(task => !closedStatuses.has(task.status) && openGoal(ctx.goals.get(task.goalId)!)).reduce((sum, task) => sum + Math.max(0, result.remaining.get(task.id) ?? 0) * ctx.factors.get(task.id)!, 0);
    const quality = (result: Run) => result.items.reduce((sum, item) => sum + item.score * item.minutes, 0) / Math.max(1, result.items.reduce((sum, item) => sum + item.minutes, 0));
    try {
      assertPlan(input, stable.items);
      if (openWork(stable) <= openWork(fresh) + epsilon && quality(fresh) - quality(stable) <= ctx.config.stabilityThreshold) selected = stable;
    } catch { /* Previous placements became infeasible; use the fresh plan. */ }
  }
  const warnings = [...selected.warnings, ...estimates.filter(estimate => !estimate.feasible && estimate.remainingMin > 0).map(estimate => ({ goalId: estimate.goalId, code: 'INFEASIBLE_DEADLINE', message: `${estimate.goalId} needs ${round(estimate.remainingMin)} min, with ${round(estimate.availableMin * (1 - ctx.config.buffer))} min available after the buffer; short by ${estimate.shortfallMin} min.`, shortfallMin: estimate.shortfallMin }))];
  const result: PlanResult = { items: selected.items, unplaced: [...ctx.tasks.values()].filter(task => !closedStatuses.has(task.status) && selected.remaining.get(task.id)! > epsilon).sort((a, b) => a.id.localeCompare(b.id)).map(task => { const code = unplacedCode(ctx, task, selected); return { taskId: task.id, code, reason: reason[code], remainingMinutes: round(selected.remaining.get(task.id)!) }; }), warnings: warnings.sort((a, b) => (a.goalId ?? '').localeCompare(b.goalId ?? '') || a.code.localeCompare(b.code) || a.message.localeCompare(b.message)), changes: changes(input, selected.items), algoVersion: ctx.config.algoVersion };
  assertPlan(input, result.items); return result;
}
/** Cheap production assertions protect accepted output independently of ranking. */
export function assertPlan(input: PlanInput, items: PlanItem[]) {
  const ctx = context(input), sorted = [...items].sort(byTime), work = new Map<string, number>(), totalsByDate = totals(ctx, items), frozen = baseFrozen(ctx), fixedTotals = totals(ctx, frozen);
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i]!, task = ctx.tasks.get(item.taskId);
    validInterval(item);
    if (!task || closedStatuses.has(task.status) || task.status === 'paused' || !openGoal(ctx.goals.get(task.goalId)!)) throw new RangeError('A plan cannot place closed or paused work.');
    if (item.goalId !== task.goalId || item.skillId !== (task.skillId ?? ctx.goals.get(task.goalId)!.skillId) || item.minutes !== item.endMin - item.startMin || !Number.isFinite(item.score) || !Number.isFinite(consumed(ctx, item)) || consumed(ctx, item) < 0 || consumed(ctx, item) === 0 && !(input.frozen ?? []).some(value => samePlacement(value, item))) throw new RangeError('A plan placement has inconsistent task, duration or score metadata.');
    if (sorted.slice(0, i).some(other => other.date === item.date && other.endMin > item.startMin && other.startMin < item.endMin)) throw new RangeError('Produced plan items overlap.');
    work.set(item.taskId, round(get(work, item.taskId) + consumed(ctx, item)));
    if (get(work, item.taskId) > task.remainingMinutes + epsilon) throw new RangeError('Produced task work exceeds its remaining minutes.');
    const protectedItem = (input.frozen ?? []).some(value => samePlacement(value, item));
    if (!protectedItem && !eligible(ctx, task, item.date)) throw new RangeError('Produced work is outside task eligibility.');
    if (!protectedItem && !ctx.slots.get(item.date)?.some(slot => slot.startMin <= item.startMin && slot.endMin >= item.endMin && (!slot.skillId || slot.skillId === item.skillId))) throw new RangeError('Produced work is outside a compatible free interval.');
  }
  for (const item of sorted) for (const id of ctx.deps.get(item.taskId) ?? []) {
    if (ctx.completed.has(id)) continue;
    const prior = sorted.filter(value => value.taskId === id && consumed(ctx, value) > epsilon).at(-1);
    if (!prior || get(work, id) + epsilon < (ctx.tasks.get(id)?.remainingMinutes ?? Infinity) || prior.date > item.date || prior.date === item.date && prior.endMin > item.startMin) throw new RangeError('Produced work precedes an incomplete prerequisite.');
  }
  for (const task of ctx.taskList) {
    const normal = sorted.filter(item => item.taskId === task.id && !frozen.some(value => samePlacement(value, item)));
    if (task.supportsSplit === false && normal.length && (normal.length !== 1 || get(work, task.id) + epsilon < task.remainingMinutes)) throw new RangeError('Non-splittable work needs one complete fit.');
    const short = normal.filter(item => item.minutes < ctx.config.minChunk);
    if (short.length && (short.length > 1 || get(work, task.id) + epsilon < task.remainingMinutes)) throw new RangeError('A short chunk must finish the task remainder.');
  }
  for (const date of ctx.days) {
    if (get(totalsByDate.day, date) > Math.max(ctx.config.maxDailyMin, get(fixedTotals.day, date)) + epsilon) throw new RangeError('Produced work exceeds daily capacity.');
    const week = weekOf(ctx, date);
    if (get(totalsByDate.week, week) > Math.max(ctx.config.maxWeeklyMin, get(fixedTotals.week, week)) + epsilon) throw new RangeError('Produced work exceeds weekly capacity.');
    for (const skill of ctx.skills.values()) {
      if (get(totalsByDate.skillDay, key(skill.id, date)) > Math.max(skill.maxDailyMin ?? Infinity, get(fixedTotals.skillDay, key(skill.id, date))) + epsilon || get(totalsByDate.skillWeek, key(skill.id, week)) > Math.max(skill.maxWeeklyMin ?? Infinity, get(fixedTotals.skillWeek, key(skill.id, week))) + epsilon) throw new RangeError('Produced work exceeds skill capacity.');
    }
  }
  for (const date of ctx.days) {
    const available = subtract(ctx.slots.get(date)!, frozen.filter(item => item.date === date).map(item => ({ ...item, endMin: Math.min(1440, item.endMin + (item.minutes >= ctx.config.breakAfter ? ctx.config.minBreak : 0)) })));
    const ownProtected = frozen.filter(item => item.date === date && !item.pinned).reduce((sum, item) => sum + item.minutes, 0);
    const week = weekOf(ctx, date);
    const earlierWork = sorted.filter(item => item.date < date && weekOf(ctx, item.date) === week && !frozen.some(value => samePlacement(value, item))).reduce((sum, item) => sum + item.minutes, 0);
    const flexible = Math.max(0, Math.min(available.reduce((sum, slot) => sum + slot.endMin - slot.startMin, 0) + ownProtected, ctx.config.maxDailyMin - get(fixedTotals.day, date) + ownProtected, ctx.config.maxWeeklyMin - get(fixedTotals.week, week) - earlierWork + ownProtected));
    for (const goal of ctx.goals.values()) {
      if (get(totalsByDate.goalDay, key(goal.id, date)) > Math.max(goal.maxDailyMin ?? Infinity, get(fixedTotals.goalDay, key(goal.id, date))) + epsilon) throw new RangeError('Produced work exceeds goal daily capacity.');
      const share = Math.max(flexible * ctx.config.maxGoalShare, get(fixedTotals.goalFlexibleDay, key(goal.id, date)));
      if (get(totalsByDate.goalFlexibleDay, key(goal.id, date)) <= share + epsilon) continue;
      const plannedThroughDay = sorted.filter(item => item.date <= date || frozen.some(value => samePlacement(value, item)));
      const dayWork = new Map<string, number>(); for (const item of plannedThroughDay) dayWork.set(item.taskId, get(dayWork, item.taskId) + consumed(ctx, item));
      const remaining = new Map([...ctx.tasks.values()].map(task => [task.id, Math.max(0, task.remainingMinutes - get(dayWork, task.id))]));
      const alternative = plannedThroughDay.filter(item => item.date !== date || item.goalId !== goal.id || frozen.some(value => samePlacement(value, item))), alternativeTotals = totals(ctx, alternative);
      const intervals = subtract(available, alternative.filter(item => item.date === date && !frozen.some(value => samePlacement(value, item))).map(item => ({ ...item, endMin: Math.min(1440, item.endMin + (item.minutes >= ctx.config.breakAfter ? ctx.config.minBreak : 0)) })));
      let used = get(fixedTotals.goalFlexibleDay, key(goal.id, date));
      for (const item of sorted.filter(value => value.date === date && value.goalId === goal.id && !value.pinned && !frozen.some(protectedItem => samePlacement(protectedItem, value)))) {
        used += item.minutes; if (used <= share + epsilon) continue;
        const prefixWork = new Map<string, number>(); for (const value of sorted.filter(value => value.date < date || value.date === date && value.endMin <= item.startMin || frozen.some(protectedItem => samePlacement(protectedItem, value)))) prefixWork.set(value.taskId, get(prefixWork, value.taskId) + consumed(ctx, value));
        const before = new Map([...ctx.tasks.values()].map(task => [task.id, Math.max(0, task.remainingMinutes - get(prefixWork, task.id))]));
        const competitor = [...ctx.tasks.values()].some(task => task.goalId !== goal.id && remaining.get(task.id)! > epsilon && eligible(ctx, task, date) && dependenciesMet(ctx, task, date, item.startMin, before, sorted) && intervals.some(slot => { const budget = Math.min(capacity(ctx, alternativeTotals, task, date), slot.endMin - slot.startMin), full = wallWork(ctx, task, remaining.get(task.id)!); return (!slot.skillId || slot.skillId === (task.skillId ?? ctx.goals.get(task.goalId)!.skillId)) && (full <= budget || task.supportsSplit !== false && budget >= ctx.config.minChunk); }));
        if (competitor) throw new RangeError('Produced work starves another eligible goal beyond the daily flexible share.');
      }
    }
  }
  for (const frozen of baseFrozen(ctx)) if (!items.some(item => samePlacement(item, frozen))) throw new RangeError('Protected frozen work changed.');
}
