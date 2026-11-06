import { resolveTaskEvents, type TaskStateEvent } from '@kram/shared';
import { DateTime } from 'luxon';
import { goalQuotaOutcomes, type QuotaOccurrence, type QuotaRuleSnapshot } from './periods';

export interface AnalyticsSkill { id: string; name: string; profileId: string; weeklyTargetMin: number }
export interface AnalyticsGoal { id: string; title: string; skillId: string; unit: string; targetQty: number; type: string; startDate?: string; dueDate?: string | null; availableDays?: number[]; rules?: QuotaRuleSnapshot[] }
export interface AnalyticsTask { id: string; goalId: string; title: string; estMinutes: number; kind: string; occurrenceId?: string | null; earliestDate?: string; unverified?: boolean; periodKey?: string }
export type AnalyticsEvent = TaskStateEvent & { unit?: string; ruleVersionId?: string | null };
export interface AnalyticsInput {
  weekStart: string;
  today?: string;
  skills: AnalyticsSkill[];
  goals: AnalyticsGoal[];
  tasks: AnalyticsTask[];
  /** Full authoritative task history, including corrections outside the requested week. */
  events: AnalyticsEvent[];
  occurrences?: QuotaOccurrence[];
}
const round = (value: number) => Math.round(value * 100) / 100;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Quantities are grouped only within a skill and an unchanged unit. Time is independent. */
export function analyticsReport(input: AnalyticsInput) {
  const start = DateTime.fromISO(input.weekStart, { zone: 'UTC' });
  if (!start.isValid || start.toISODate() !== input.weekStart) throw new Error('Choose a valid week start.');
  const weekEnd = start.plus({ days: 6 }).toISODate()!;
  const dates = Array.from({ length: 7 }, (_, index) => start.plus({ days: index }).toISODate()!);
  const byTask = new Map<string, AnalyticsEvent[]>();
  for (const event of input.events) {
    if (!event.taskId) continue;
    const events = byTask.get(event.taskId) ?? [];
    events.push(event); byTask.set(event.taskId, events);
  }
  const active = input.tasks.flatMap(task => resolveTaskEvents(byTask.get(task.id) ?? []).activeEvents) as AnalyticsEvent[];
  const rulesById = new Map(input.goals.flatMap(goal => goal.rules ?? []).filter(rule => rule.id).map(rule => [rule.id!, rule]));
  const goalsById = new Map(input.goals.map(goal => [goal.id, goal]));
  const tasksById = new Map(input.tasks.map(task => [task.id, task]));
  const work = active.filter(event => event.kind === 'progress' || event.kind === 'completed').map(event => ({ ...event,
    unit: event.unit ?? rulesById.get(event.ruleVersionId ?? '')?.rules.unit ?? goalsById.get(event.goalId)?.unit ?? '',
    occurrenceId: tasksById.get(event.taskId ?? '')?.occurrenceId,
    weeklyPeriodStart: tasksById.get(event.taskId ?? '')?.periodKey?.match(/^weekly:(\d{4}-\d{2}-\d{2}):/)?.[1] }));
  const weekly = work.filter(event => event.localDate >= input.weekStart && event.localDate <= weekEnd);
  const goals = input.goals.map(goal => {
    const history = work.filter(event => event.goalId === goal.id);
    const period = weekly.filter(event => event.goalId === goal.id);
    const amount = (events: typeof work) => events.filter(event => event.unit.trim().toLowerCase() === goal.unit.trim().toLowerCase()).reduce((sum, event) => sum + (goal.unit.toLowerCase() === 'minutes' ? event.minutes : event.qty), 0);
    const { rules: _rules, ...fields } = goal;
    return { ...fields, credited: round(amount(history)), weeklyCredited: round(amount(period)),
      periodOutcomes: goalQuotaOutcomes({ goal: { ...goal, startDate: goal.startDate ?? input.weekStart }, rules: goal.rules, occurrences: input.occurrences,
        work, weekStart: input.weekStart, today: input.today ?? input.weekStart,
        weeklyPeriods: input.tasks.filter(task => task.goalId === goal.id).flatMap(task => { const periodStart = task.periodKey?.match(/^weekly:(\d{4}-\d{2}-\d{2}):/)?.[1]; return periodStart ? [{ periodStart }] : []; }),
        unverifiedDates: new Set(input.tasks.filter(task => task.goalId === goal.id && task.unverified && task.earliestDate).map(task => task.earliestDate!)) }),
      weeklyMinutes: round(period.reduce((sum, event) => sum + event.minutes, 0)),
      days: dates.map(date => ({ date, minutes: round(period.filter(event => event.localDate === date).reduce((sum, event) => sum + event.minutes, 0)), credited: round(amount(period.filter(event => event.localDate === date))) })),
      weeklyCompletions: period.filter(event => event.kind === 'completed').length };
  });
  const skills = input.skills.map(skill => {
    const ids = new Set(input.goals.filter(goal => goal.skillId === skill.id).map(goal => goal.id));
    const events = weekly.filter(event => ids.has(event.goalId));
    const skillGoals = goals.filter(goal => goal.skillId === skill.id);
    const units = [...new Set(skillGoals.map(goal => goal.unit))].map(unit => ({ unit,
      credited: round(skillGoals.filter(goal => goal.unit === unit).reduce((sum, goal) => sum + goal.weeklyCredited, 0)) }));
    return { ...skill, minutes: round(events.reduce((sum, event) => sum + event.minutes, 0)),
      completions: events.filter(event => event.kind === 'completed').length,
      days: dates.map(date => ({ date, minutes: round(events.filter(event => event.localDate === date).reduce((sum, event) => sum + event.minutes, 0)) })), units };
  });
  const calibration = input.skills.flatMap(skill => {
    const ids = new Set(input.goals.filter(goal => goal.skillId === skill.id).map(goal => goal.id));
    const tasks = input.tasks.filter(task => ids.has(task.goalId));
    return [...new Set(tasks.map(task => task.kind))].map(kind => {
      const samples = tasks.filter(task => task.kind === kind && task.estMinutes > 0).flatMap(task => {
        const history = resolveTaskEvents(byTask.get(task.id) ?? []).activeEvents;
        const complete = history.find(event => event.kind === 'completed');
        if (!complete) return [];
        const actualMinutes = history.reduce((sum, event) => sum + (event.kind === 'progress' || event.kind === 'completed' ? event.minutes : 0), 0);
        if (actualMinutes <= 0) return [];
        return [{ taskId: task.id, title: task.title, completedAt: complete.occurredAt,
          estimateMinutes: task.estMinutes, actualMinutes: round(actualMinutes), ratio: actualMinutes / task.estMinutes }];
      }).sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.taskId.localeCompare(a.taskId)).slice(0, 10);
      const observedMedian = samples.length ? median(samples.map(sample => sample.ratio)) : null;
      return { skillId: skill.id, skillName: skill.name, kind, samples: samples.map(sample => ({ ...sample, ratio: round(sample.ratio) })),
        sampleCount: samples.length, ready: samples.length >= 5, observedMedian: observedMedian === null ? null : round(observedMedian),
        multiplier: samples.length >= 5 ? round(Math.min(2, Math.max(0.7, observedMedian!))) : 1 };
    });
  });
  return { weekStart: input.weekStart, weekEnd, skills, goals, calibration,
    days: dates.map(date => ({ date, minutes: round(weekly.filter(event => event.localDate === date).reduce((sum, event) => sum + event.minutes, 0)) })),
    totalMinutes: round(weekly.reduce((sum, event) => sum + event.minutes, 0)), completedTasks: weekly.filter(event => event.kind === 'completed').length };
}
export type AnalyticsReport = ReturnType<typeof analyticsReport>;
