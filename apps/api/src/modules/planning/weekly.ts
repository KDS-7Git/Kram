import { z } from 'zod';
import { dateSchema, goalSchema, type Settings } from '@kram/shared';
import { addDays, daysBetween, instantMillis, localToInstant, studyDate, weekday, weekStartDate } from '@kram/time';
import { foldRun, resolveProgress, type ProgressEvent, type StreakRecord } from '@kram/streaks';
import { db } from '../../db';
import { ApiError } from '../../errors';
import { calendarDate, calendarString, clock } from '../../calendar';
import type { Transaction } from '../../repository';
import { goalQuotaOutcomes } from '../../analytics/periods';
import { storedProgressUnit, unreportedReviewTasks } from '../../streaks/history-context';
import { getSettings } from '../hierarchy/service';

export const weeklyRequestSchema = z.object({ reviewedWeek: dateSchema, targetWeek: dateSchema });
const historicalQuotaStateSchema = z.object({ status: z.string().optional(), pausedRanges: z.array(z.object({ start: dateSchema, end: dateSchema.nullable().optional() })).optional() });
export type WeeklyRequest = z.infer<typeof weeklyRequestSchema>;
export type WeeklyStoredMetadata = WeeklyRequest & { summary?: WeeklyReviewReport };
export interface WeeklyReviewReport {
  weekStart: string; weekEnd: string; currentWeekStart: string; today: string; complete: boolean; targetWeekStart: string; targetWeekEnd: string;
  profiles: { id: string; name: string; plannedMinutes: number; actualMinutes: number }[];
  skills: { id: string; name: string; profileId: string; plannedMinutes: number; actualMinutes: number }[];
  quotas: ReturnType<typeof goalQuotaOutcomes>;
  streaks: { id: string; title: string; beforeCurrent: number; afterCurrent: number; delta: number; best: number; met: number; missed: number; provisional: number }[];
  backlog: { tasks: { id: string; title: string; status: string; remainingMinutes: number; dueDate: string | null }[]; remainingMinutes: number };
  deadlines: { goalId: string; title: string; dueDate: string; remainingMinutes: number; availableMinutes: number; shortfallMin: number; feasible: boolean; message: string }[];
  checkedThrough: string; proposal: { id: string; number: number; state: string } | null;
}

export function weeklyMetadata(input: unknown): WeeklyStoredMetadata | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).weeklyReview;
  const parsed = weeklyRequestSchema.safeParse(value);
  return parsed.success ? { ...parsed.data, summary: (value as WeeklyStoredMetadata).summary } : undefined;
}

/** A completed historical review allocates the current week; the closing week allocates the next. */
export function weeklyIdentity(settings: Settings, today: string, request: WeeklyRequest): WeeklyRequest {
  const current = weekStartDate(today, settings.weekStart);
  if (weekday(request.reviewedWeek) !== settings.weekStart || request.reviewedWeek > current || daysBetween(request.reviewedWeek, current) > 371)
    throw new ApiError('REVIEW_WEEK', 'Choose a configured review week within the last year.', 400);
  const target = [current, addDays(request.reviewedWeek, 7)].sort().at(-1)!;
  if (request.targetWeek !== target) throw new ApiError('REVIEW_WEEK', 'The allocation week changed. Reload the weekly review.', 409);
  return request;
}

export function weeklyReviewDue(week: string, settings: Settings): string {
  const end = addDays(week, 6), date = settings.dailyReviewMin < settings.dayRollover ? addDays(end, 1) : end;
  return localToInstant(date, settings.dailyReviewMin, settings.timezone);
}

/** Read-only report; generation saves this decision summary inside the immutable version input. */
export async function weeklyReview(userId: string, requestedWeek?: string, c?: Transaction, includeProposal = true): Promise<WeeklyReviewReport> {
  if (!c) return db.$transaction(tx => weeklyReview(userId, requestedWeek, tx, includeProposal), { isolationLevel: 'RepeatableRead', timeout: 60000 });
  const settings = await getSettings(userId, c), today = studyDate(clock.now(), settings.timezone, settings.dayRollover);
  const currentWeekStart = weekStartDate(today, settings.weekStart);
  const closingNow = today === addDays(currentWeekStart, 6) && instantMillis(clock.now()) >= instantMillis(weeklyReviewDue(currentWeekStart, settings));
  const weekStart = dateSchema.parse(requestedWeek ?? (closingNow ? currentWeekStart : addDays(currentWeekStart, -7)));
  const targetWeekStart = [currentWeekStart, addDays(weekStart, 7)].sort().at(-1)!;
  weeklyIdentity(settings, today, { reviewedWeek: weekStart, targetWeek: targetWeekStart });
  const weekEnd = addDays(weekStart, 6), targetWeekEnd = addDays(targetWeekStart, 6);
  const [profiles, skills, goals, tasks, slots, rows, definitions, reviews, occurrences, versions] = await Promise.all([
    c.profile.findMany({ where: { userId, isDemo: false }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    c.skill.findMany({ where: { userId, isDemo: false, profile: { isDemo: false } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    c.goal.findMany({ where: { userId, isDemo: false, skill: { isDemo: false, profile: { isDemo: false } } }, include: { rules: { orderBy: [{ effectiveFrom: 'asc' }, { version: 'asc' }] } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    c.task.findMany({ where: { userId, isDemo: false, goal: { isDemo: false } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    c.timeSlot.findMany({ where: { userId, isDemo: false, archivedAt: null, date: { gte: calendarDate(weekStart), lte: calendarDate(addDays(weekEnd, 1)) }, layer: { notIn: ['unavailable', 'reserved'] } }, orderBy: [{ date: 'asc' }, { startMin: 'asc' }, { id: 'asc' }] }),
    c.progressEvent.findMany({ where: { userId, goal: { isDemo: false }, OR: [{ taskId: null }, { task: { isDemo: false } }] }, include: { goal: { include: { skill: true } }, ruleVersion: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    c.streakDef.findMany({ where: { userId, startDate: { lte: calendarDate(weekEnd) } }, include: { records: { include: { ruleVersion: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    c.dailyReview.findMany({ where: { userId, date: { gte: calendarDate(weekStart), lte: calendarDate(weekEnd) } } }),
    c.occurrence.findMany({ where: { userId, localDate: { gte: calendarDate(weekStart), lte: calendarDate(weekEnd) }, series: { kind: 'goal', goal: { isDemo: false } } }, include: { series: true } }),
    includeProposal ? c.planVersion.findMany({ where: { userId }, orderBy: { number: 'desc' }, take: 200 }) : Promise.resolve([]),
  ]);
  const events: ProgressEvent[] = rows.map(row => ({ id: row.id, taskId: row.taskId, goalId: row.goalId, skillId: row.goal.skillId, profileId: row.goal.skill.profileId, kind: row.kind, minutes: row.minutes, qty: row.qty,
    localDate: calendarString(row.localDate), unit: storedProgressUnit(row.ruleVersion?.rules, row.goal.unit), createdAt: row.createdAt.toISOString(), occurredAt: row.occurredAt.toISOString(), sequence: row.sequence, correctsEventId: row.referenceEventId,
    reportedTotalMinutes: row.reportedTotalMinutes, reportedTotalQty: row.reportedTotalQty }));
  const surviving = resolveProgress(events), work = surviving.filter(event => ['progress', 'completed'].includes(event.kind));
  const weekWork = work.filter(event => event.localDate >= weekStart && event.localDate <= weekEnd);
  const byGoal = new Map(goals.map(goal => [goal.id, goal])), bySkill = new Map(skills.map(skill => [skill.id, skill])), byTask = new Map(tasks.map(task => [task.id, task]));
  const round = (n: number) => Math.round(n * 100) / 100;
  const weekSlots = slots.filter(slot => { const date = studyDate(localToInstant(calendarString(slot.date), slot.startMin, settings.timezone), settings.timezone, settings.dayRollover); return date >= weekStart && date <= weekEnd; });
  const slotSkill = (slot: typeof slots[number]) => slot.skillId ?? byGoal.get(slot.goalId ?? byTask.get(slot.taskId ?? '')?.goalId ?? '')?.skillId;
  const slotProfile = (slot: typeof slots[number]) => slot.profileId ?? bySkill.get(slotSkill(slot) ?? '')?.profileId;
  const profileRows = profiles.map(profile => ({ id: profile.id, name: profile.name,
    plannedMinutes: weekSlots.filter(slot => slotProfile(slot) === profile.id).reduce((sum, slot) => sum + slot.endMin - slot.startMin, 0),
    actualMinutes: round(weekWork.filter(event => event.profileId === profile.id).reduce((sum, event) => sum + event.minutes, 0)) }));
  const skillRows = skills.map(skill => ({ id: skill.id, name: skill.name, profileId: skill.profileId,
    plannedMinutes: weekSlots.filter(slot => slotSkill(slot) === skill.id).reduce((sum, slot) => sum + slot.endMin - slot.startMin, 0),
    actualMinutes: round(weekWork.filter(event => event.skillId === skill.id).reduce((sum, event) => sum + event.minutes, 0)) }));
  const unknownByGoal = new Map<string, Set<string>>();
  for (const review of reviews) {
    const date = calendarString(review.date), reviewedAt = (review.closedAt ?? review.createdAt).toISOString();
    const storedIds = unreportedReviewTasks(review.summary);
    const ids = storedIds ?? (review.state === 'unverified' ? tasks.filter(task => task.unverified && (calendarString(task.earliestDate) === date || surviving.some(event => event.taskId === task.id && event.localDate === date))).map(task => task.id) : []);
    for (const id of ids) {
      const task = byTask.get(id);
      if (!task || surviving.some(event => event.taskId === id && event.localDate === date && (event.createdAt ?? '') > reviewedAt && ['progress', 'completed', 'skipped', 'deferred', 'cancelled'].includes(event.kind))) continue;
      const dates = unknownByGoal.get(task.goalId) ?? new Set<string>(); dates.add(date); unknownByGoal.set(task.goalId, dates);
    }
  }
  for (const task of tasks.filter(task => task.unverified)) {
    const date = work.filter(event => event.taskId === task.id).map(event => event.localDate).sort().at(-1) ?? calendarString(task.deferredToDate ?? task.dueDate ?? task.earliestDate);
    if (date < weekStart || date > weekEnd || reviews.some(review => calendarString(review.date) === date)) continue;
    const dates = unknownByGoal.get(task.goalId) ?? new Set<string>(); dates.add(date); unknownByGoal.set(task.goalId, dates);
  }
  const quotas = goals.flatMap(goal => goalQuotaOutcomes({ goal: { ...goal, startDate: calendarString(goal.startDate), dueDate: goal.dueDate ? calendarString(goal.dueDate) : null },
    rules: goal.rules.map(rule => ({ id: rule.id, version: rule.version, effectiveFrom: calendarString(rule.effectiveFrom), rules: { ...goalSchema.parse(rule.rules), ...historicalQuotaStateSchema.parse(rule.rules) } })),
    weeklyPeriods: [...new Set(tasks.filter(task => task.goalId === goal.id).flatMap(task => { const match = /^weekly:(\d{4}-\d{2}-\d{2}):/.exec(task.periodKey); return match ? [match[1]!] : []; }))].map(periodStart => ({ periodStart })),
    occurrences: occurrences.filter(row => row.series.goalId === goal.id).map(row => ({ id: row.id, goalId: goal.id, localDate: calendarString(row.localDate), originalDate: calendarString(row.originalDate), status: row.status,
      fields: { ...(row.fields as { qty?: number }), unit: row.series.unit } })),
    work: work.filter(event => event.goalId === goal.id).map(event => ({ goalId: goal.id, localDate: event.localDate, unit: event.unit ?? goal.unit, minutes: event.minutes, qty: event.qty, occurrenceId: byTask.get(event.taskId ?? '')?.occurrenceId ?? undefined,
      weeklyPeriodStart: /^weekly:(\d{4}-\d{2}-\d{2}):/.exec(byTask.get(event.taskId ?? '')?.periodKey ?? '')?.[1] })),
    weekStart, today, unverifiedDates: unknownByGoal.get(goal.id) }));
  const streakRows = definitions.map(definition => {
    const records: StreakRecord[] = definition.records.map(record => ({ periodStart: calendarString(record.periodStart), periodEnd: calendarString(record.periodEnd), result: record.result as StreakRecord['result'], reason: record.reason, value: record.value, provisional: record.provisional, ruleVersion: record.ruleVersion.version }));
    const before = foldRun(records.filter(record => record.periodEnd < weekStart)), after = foldRun(records.filter(record => record.periodEnd <= weekEnd));
    return { id: definition.id, title: definition.title, beforeCurrent: before.current, afterCurrent: after.current, delta: after.current - before.current, best: after.best, met: after.met - before.met, missed: after.missed - before.missed, provisional: after.provisional - before.provisional };
  });
  const activeGoals = new Set(goals.filter(goal => goal.status === 'active' && !goal.archivedAt && !bySkill.get(goal.skillId)?.archivedAt && !profiles.find(profile => profile.id === bySkill.get(goal.skillId)?.profileId)?.archivedAt).map(goal => goal.id));
  const deferred = tasks.filter(task => activeGoals.has(task.goalId) && !task.archivedAt && task.status === 'deferred').map(task => ({ id: task.id, title: task.title, status: task.status, remainingMinutes: task.remainingMinutes, dueDate: task.dueDate ? calendarString(task.dueDate) : null }));
  const futureGoals = goals.filter(goal => activeGoals.has(goal.id) && goal.dueDate && calendarString(goal.dueDate) >= today && calendarString(goal.dueDate) <= addDays(today, 365));
  const checkedThrough = [addDays(today, settings.horizonDays - 1), ...futureGoals.map(goal => calendarString(goal.dueDate!))].sort().at(-1)!;
  // Planning consumes this report; load its feasibility service only when the
  // report runs, so bundled startup never evaluates their schemas in a cycle.
  const estimates = futureGoals.length ? await (await import('./service')).planningFeasibility(userId, c, checkedThrough) : [];
  const deadlines = estimates.filter(estimate => futureGoals.some(goal => goal.id === estimate.goalId) && estimate.remainingMin > 0 && !estimate.feasible).map(estimate => {
    const goal = byGoal.get(estimate.goalId)!;
    return { goalId: goal.id, title: goal.title, dueDate: calendarString(goal.dueDate!), remainingMinutes: estimate.remainingMin, availableMinutes: estimate.availableMin, shortfallMin: estimate.shortfallMin, feasible: estimate.feasible,
      message: `The estimated allocation is short by ${round(estimate.shortfallMin)} minutes before this deadline. Review the target, date or available time.` };
  });
  const saved = versions.find(version => { const metadata = weeklyMetadata(version.input); return metadata?.reviewedWeek === weekStart && metadata.targetWeek === targetWeekStart; });
  return { weekStart, weekEnd, currentWeekStart, today, complete: weekEnd < today, targetWeekStart, targetWeekEnd, profiles: profileRows, skills: skillRows, quotas, streaks: streakRows,
    backlog: { tasks: deferred, remainingMinutes: round(deferred.reduce((sum, task) => sum + task.remainingMinutes, 0)) }, deadlines, checkedThrough,
    proposal: saved ? { id: saved.id, number: saved.number, state: saved.state } : null };
}
