import { addDays, studyDate, weekStartDate } from '@kram/time';
import { goalSchema } from '@kram/shared';
import { db } from '../db';
import { calendarDate, calendarString, clock } from '../calendar';
import { ownerWhere } from '../repository';
import { getSettings } from '../modules/hierarchy/service';
import { eventDto } from '../modules/tasks/service';
import { analyticsReport } from './report';

function savedRules(input: unknown) {
  const parsed = goalSchema.parse(input), raw = input as Record<string, unknown>;
  const pausedRanges = Array.isArray(raw.pausedRanges) ? raw.pausedRanges.flatMap(value => {
    if (!value || typeof value !== 'object' || !('start' in value) || typeof value.start !== 'string') return [];
    const end = 'end' in value && typeof value.end === 'string' ? value.end : null;
    return [{ start: value.start, end }];
  }) : undefined;
  return { ...parsed, ...(typeof raw.status === 'string' ? { status: raw.status } : {}), ...(pausedRanges ? { pausedRanges } : {}) };
}

export async function overview(userId: string, requestedWeek?: string) {
  const settings = await getSettings(userId);
  const today = studyDate(clock.now(), settings.timezone, settings.dayRollover);
  const weekStart = weekStartDate(requestedWeek ?? today, settings.weekStart);
  return db.$transaction(async tx => {
    const [skills, goals, tasks, events, occurrences] = await Promise.all([
      tx.skill.findMany({ where: ownerWhere(userId), orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
      tx.goal.findMany({ where: ownerWhere(userId), include: { rules: { orderBy: [{ effectiveFrom: 'asc' }, { version: 'asc' }] } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
      tx.task.findMany({ where: ownerWhere(userId), include: { item: { select: { kind: true } } } }),
      tx.progressEvent.findMany({ where: { ...ownerWhere(userId), taskId: { not: null } }, orderBy: [{ taskId: 'asc' }, { sequence: 'asc' }, { id: 'asc' }] }),
      tx.occurrence.findMany({ where: { ...ownerWhere(userId), localDate: { gte: calendarDate(weekStart), lte: calendarDate(addDays(weekStart, 6)) }, series: { goalId: { not: null } } }, include: { series: { select: { goalId: true } } } }),
    ]);
    return { ...analyticsReport({ weekStart, today, skills,
      goals: goals.map(goal => ({ ...goal, startDate: calendarString(goal.startDate), dueDate: goal.dueDate ? calendarString(goal.dueDate) : null,
        rules: goal.rules.map(rule => ({ id: rule.id, version: rule.version, effectiveFrom: calendarString(rule.effectiveFrom), rules: savedRules(rule.rules) })) })),
      tasks: tasks.map(task => ({ ...task, earliestDate: calendarString(task.earliestDate), kind: task.item?.kind ?? 'task' })),
      events: events.map(event => ({ ...eventDto(event), taskId: event.taskId! })),
      occurrences: occurrences.map(occurrence => { const fields = occurrence.fields as Record<string, unknown>; return {
        id: occurrence.id, goalId: occurrence.series.goalId!, localDate: calendarString(occurrence.localDate), originalDate: calendarString(occurrence.originalDate), status: occurrence.status,
        fields: { ...(typeof fields.qty === 'number' ? { qty: fields.qty } : {}), ...(typeof fields.unit === 'string' ? { unit: fields.unit } : {}) } }; }) }), timezone: settings.timezone, today };
  }, { isolationLevel: 'RepeatableRead' });
}
