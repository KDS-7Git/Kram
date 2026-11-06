import { createHash } from 'node:crypto';
import type { Prisma, StreakRecord as StoredRecord } from '@prisma/client';
import { settingsSchema } from '@kram/shared';
import { addDays, dateRange, studyDate, weekday } from '@kram/time';
import { evaluateHistory, foldRun, resolveProgress, validateRule, type ProgressEvent, type StreakRule, type StreakRecord } from '@kram/streaks';
import { db } from '../db';
import { ApiError } from '../errors';
import { calendarDate, calendarString } from '../calendar';
import { json, lockOwner, newId, notFound, type Connection } from '../repository';
import { createStreakSchema, editStreakSchema, streakRuleSchema } from './validation';
import { storedProgressUnit, unreportedReviewTasks } from './history-context';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const include = { rules: { orderBy: { version: 'asc' as const } }, records: { include: { ruleVersion: true }, orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] } };
type Definition = Prisma.StreakDefGetPayload<{ include: typeof include }>;
const recordDto = (row: Definition['records'][number]) => ({ ...row, result: row.result as StreakRecord['result'], periodStart: calendarString(row.periodStart), periodEnd: calendarString(row.periodEnd), ruleVersion: row.ruleVersion.version });
export async function streakContext(userId: string, c: Connection = db, now = new Date()) {
  const owner = notFound(await c.user.findFirst({ where: { id: userId, isOwner: true } }), 'owner');
  const settings = settingsSchema.parse(owner.settings);
  return { settings, today: studyDate(now.getTime(), settings.timezone, settings.dayRollover) };
}
function ruleFor(definition: Definition, version: Definition['rules'][number]): StreakRule {
  return { ...streakRuleSchema.parse(version.rules), version: version.version, id: version.id, scope: definition.scope as StreakRule['scope'], scopeId: definition.scopeId };
}
export function definitionDto(row: Definition, today: string) {
  const latest = new Map<string, ReturnType<typeof recordDto>>();
  for (const record of row.records) latest.set(calendarString(record.periodStart), recordDto(record));
  const version = [...row.rules].reverse().find(version => calendarString(version.effectiveFrom) <= today) ?? row.rules[0];
  return { ...row, startDate: calendarString(row.startDate), rules: row.rules.map(v => ({ ...v, effectiveFrom: calendarString(v.effectiveFrom) })), rule: version ? { ...streakRuleSchema.parse(version.rules), ...ruleFor(row, version) } : null,
    summary: foldRun(row.records.map(recordDto)), records: [...latest.values()].filter(record => record.periodEnd >= addDays(today, -83)).sort((a, b) => a.periodStart.localeCompare(b.periodStart)) };
}
async function getDefinition(userId: string, id: string, c: Connection = db) { return notFound(await c.streakDef.findFirst({ where: { id, userId }, include }), 'streak'); }
async function validateScope(userId: string, scope: string, scopeId: string | null | undefined, rule: ReturnType<typeof streakRuleSchema.parse>, c: Connection) {
  if (scope === 'global') { if (scopeId) throw new ApiError('VALIDATION_FAILED', 'A global streak has no individual target.', 400); }
  else {
    if (!scopeId) throw new ApiError('VALIDATION_FAILED', 'Choose a streak target.', 400);
    const target = scope === 'goal' ? await c.goal.findFirst({ where: { id: scopeId, userId } }) : scope === 'skill' ? await c.skill.findFirst({ where: { id: scopeId, userId } }) : await c.profile.findFirst({ where: { id: scopeId, userId } });
    notFound(target, scope);
    if (target?.isDemo) throw new ApiError('DEMO_TARGET', 'Choose your own practice for a streak. Demo data stays outside progress records.', 400);
    if (rule.measure === 'quantity' && target && 'unit' in target && target.unit !== rule.unit) throw new ApiError('UNIT_MISMATCH', 'Choose the goal’s measurement unit.', 400);
  }
  try { validateRule({ ...rule, version: 1, scope: scope as StreakRule['scope'], scopeId }); } catch (error) { throw new ApiError('VALIDATION_FAILED', error instanceof Error ? error.message : 'Check the streak rule.', 400); }
}
export const streaks = {
  async list(userId: string) { const { today } = await streakContext(userId); return (await db.streakDef.findMany({ where: { userId }, include, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(row => definitionDto(row, today)); },
  async get(userId: string, id: string) { const { today } = await streakContext(userId); return definitionDto(await getDefinition(userId, id), today); },
  async records(userId: string, id: string) { return (await getDefinition(userId, id)).records.map(recordDto); },
  async create(userId: string, input: unknown, now = new Date()) {
    const value = createStreakSchema.parse(input);
    return db.$transaction(async tx => {
      await lockOwner(tx, userId); const { today, settings } = await streakContext(userId, tx, now);
      const start = value.startDate ?? today;
      if (start > today || start < addDays(today, -3660)) throw new ApiError('VALIDATION_FAILED', 'Choose a start date within the last ten years.', 400);
      const rule = { ...value.rule, weekStart: value.rule.weekStart ?? settings.weekStart, restWeekdays: value.rule.restWeekdays ?? settings.restDays };
      await validateScope(userId, value.scope, value.scopeId, rule, tx);
      const row = await tx.streakDef.create({ data: { id: newId(), userId, title: value.title, scope: value.scope, scopeId: value.scopeId ?? null, startDate: calendarDate(start) } });
      await tx.streakRuleVersion.create({ data: { id: newId(), userId, streakId: row.id, version: 1, effectiveFrom: row.startDate, rules: json(rule) } });
      await evaluateStreaks(userId, tx, now); return definitionDto(await getDefinition(userId, row.id, tx), today);
    }, { timeout: 60000 });
  },
  async edit(userId: string, id: string, input: unknown, now = new Date()) {
    const value = editStreakSchema.parse(input);
    return db.$transaction(async tx => {
      await lockOwner(tx, userId); const { today, settings } = await streakContext(userId, tx, now); const row = await getDefinition(userId, id, tx);
      if (value.rule) {
        const effective = value.effectiveFrom ?? addDays(today, 1), last = row.rules.at(-1)!;
        if (effective <= today || effective <= calendarString(last.effectiveFrom)) throw new ApiError('HISTORY_IMMUTABLE', 'Rule changes start on a future study date after the latest rule. Past records keep their original rules.', 409);
        const rule = { ...value.rule, weekStart: value.rule.weekStart ?? settings.weekStart, restWeekdays: value.rule.restWeekdays ?? settings.restDays };
        await validateScope(userId, row.scope, row.scopeId, rule, tx);
        await tx.streakRuleVersion.create({ data: { id: newId(), userId, streakId: id, version: last.version + 1, effectiveFrom: calendarDate(effective), rules: json(rule) } });
      } else if (value.effectiveFrom) throw new ApiError('VALIDATION_FAILED', 'An effective date requires a rule change.', 400);
      await tx.streakDef.update({ where: { id, userId }, data: { ...(value.title ? { title: value.title } : {}), ...(value.status ? { status: value.status } : {}) } });
      return definitionDto(await getDefinition(userId, id, tx), today);
    });
  },
};

/** Replay corrections over source history; only changed period hashes append rows. */
export async function evaluateStreaks(userId: string, c: Connection = db, now = new Date()): Promise<{ created: number; corrected: number }> {
  if (c === db) return db.$transaction(async tx => { await lockOwner(tx, userId); return evaluateStreaks(userId, tx, now); }, { timeout: 120000 });
  const { today, settings } = await streakContext(userId, c, now), to = addDays(today, -1);
  const definitions = await c.streakDef.findMany({ where: { userId, status: 'active', startDate: { lte: calendarDate(to) } }, include, orderBy: { id: 'asc' } });
  if (!definitions.length) return { created: 0, corrected: 0 };
  const rows = await c.progressEvent.findMany({ where: { userId, goal: { isDemo: false }, OR: [{ taskId: null }, { task: { isDemo: false } }] }, include: { goal: { include: { skill: true } }, task: true, ruleVersion: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const events: ProgressEvent[] = rows.map(row => ({ id: row.id, taskId: row.taskId, goalId: row.goalId, skillId: row.goal.skillId, profileId: row.goal.skill.profileId, kind: row.kind, minutes: row.minutes, qty: row.qty, unit: storedProgressUnit(row.ruleVersion?.rules, row.goal.unit), localDate: calendarString(row.localDate), occurredAt: row.occurredAt.toISOString(), createdAt: row.createdAt.toISOString(), sequence: row.sequence, correctsEventId: row.referenceEventId, reportedTotalMinutes: row.reportedTotalMinutes, reportedTotalQty: row.reportedTotalQty }));
  const from = definitions.map(row => calendarString(row.startDate)).sort()[0]!;
  const holidays = await c.holiday.findMany({ where: { userId, date: { gte: calendarDate(from), lte: calendarDate(to) } } });
  const breaks = await c.planningBreak.findMany({ where: { userId, fromDate: { lte: calendarDate(to) }, toDate: { gte: calendarDate(from) } } });
  const restDays = new Set(holidays.map(row => calendarString(row.date)));
  for (const pause of breaks) for (const date of dateRange(calendarString(pause.fromDate), calendarString(pause.toDate))) restDays.add(date);
  const reviews = await c.dailyReview.findMany({ where: { userId, date: { gte: calendarDate(from), lte: calendarDate(to) } } });
  const reviewTaskIds = [...new Set(reviews.flatMap(review => unreportedReviewTasks(review.summary) ?? []))];
  const tasks = await c.task.findMany({ where: { userId, isDemo: false, OR: [{ unverified: true }, { id: { in: reviewTaskIds } }] }, include: { goal: { include: { skill: true } } } });
  const synthesized: ProgressEvent[] = []; let created = 0, corrected = 0;
  // Goal/skill definitions precede profile/global counts of met sub-streaks.
  definitions.sort((a, b) => Number(['profile', 'global'].includes(a.scope)) - Number(['profile', 'global'].includes(b.scope)) || a.id.localeCompare(b.id));
  for (const definition of definitions) {
    const start = calendarString(definition.startDate);
    const belongs = (goalId: string, skillId: string, profileId: string) => definition.scope === 'global' || (definition.scope === 'goal' ? goalId : definition.scope === 'skill' ? skillId : profileId) === definition.scopeId;
    const unverifiedDates = new Set<string>();
    const relevantTasks = tasks.filter(task => belongs(task.goalId, task.goal.skillId, task.goal.skill.profileId));
    const coveredTasks = new Set<string>();
    for (const review of reviews) {
      const date = calendarString(review.date), ids = unreportedReviewTasks(review.summary);
      if (ids) {
        for (const id of ids) if (relevantTasks.some(task => task.id === id)) {
          coveredTasks.add(id);
          const reviewedAt = (review.closedAt ?? review.createdAt).toISOString();
          const reconciled = events.some(event => event.taskId === id && event.localDate === date && (event.createdAt ?? '') > reviewedAt && ['progress', 'completed', 'skipped', 'deferred', 'cancelled'].includes(event.kind));
          if (!reconciled) unverifiedDates.add(date);
        }
      } else if (review.state === 'unverified') {
        const unknown = relevantTasks.filter(task => task.unverified && (calendarString(task.earliestDate) === date || events.some(event => event.taskId === task.id && event.localDate === date)));
        if (unknown.length) { unverifiedDates.add(date); for (const task of unknown) coveredTasks.add(task.id); }
      }
    }
    // Older/manual flags without a review can describe an unreviewed work date,
    // but never override an explicitly closed, reported period.
    for (const task of relevantTasks.filter(task => task.unverified && !coveredTasks.has(task.id))) {
      const latestDate = events.filter(event => event.taskId === task.id && ['progress', 'completed'].includes(event.kind)).map(event => event.localDate).sort().at(-1);
      const date = latestDate ?? calendarString(task.deferredToDate ?? task.dueDate ?? task.earliestDate);
      const review = reviews.find(review => calendarString(review.date) === date);
      if (!review || review.state !== 'closed') unverifiedDates.add(date);
    }
    const scoped = [...events, ...synthesized].filter(event => belongs(event.goalId ?? '', event.skillId ?? '', event.profileId ?? ''));
    const versions = definition.rules.map(version => { const stored = streakRuleSchema.parse(version.rules); return { effectiveFrom: calendarString(version.effectiveFrom), rule: ruleFor(definition, version), weekStart: stored.weekStart ?? settings.weekStart, pausedRanges: stored.pausedRanges, restDays: new Set(dateRange(start, to).filter(date => stored.restWeekdays?.includes(weekday(date)))) }; });
    const evaluations = evaluateHistory({ from: start, to, rules: versions, events: scoped, restDays, weekStart: settings.weekStart, unverifiedDates });
    const active = resolveProgress(scoped), latest = new Map<string, StoredRecord>();
    for (const row of definition.records) latest.set(calendarString(row.periodStart), row);
    for (const evaluation of evaluations) {
      const version = definition.rules.find(row => row.version === evaluation.ruleVersion)!;
      const sourceHash = hash({ evaluation, versionId: version.id, events: active.filter(event => event.localDate >= evaluation.periodStart && event.localDate <= evaluation.periodEnd), rest: [...restDays].filter(date => date >= evaluation.periodStart && date <= evaluation.periodEnd).sort() });
      const previous = latest.get(evaluation.periodStart);
      if (previous?.sourceHash !== sourceHash) {
        const stored = await c.streakRecord.create({ data: { id: newId(), userId, streakId: definition.id, ruleVersionId: version.id, periodStart: calendarDate(evaluation.periodStart), periodEnd: calendarDate(evaluation.periodEnd), result: evaluation.result, value: evaluation.value, provisional: evaluation.provisional ?? false, reason: evaluation.reason, sourceHash, correctsRecordId: previous?.id ?? null, beforeReason: previous?.reason ?? null } });
        latest.set(evaluation.periodStart, stored); created++; if (previous) corrected++;
      }
      if (['goal', 'skill'].includes(definition.scope) && !evaluation.provisional && evaluation.result === 'met') {
        const goal = definition.scope === 'goal' ? rows.find(row => row.goalId === definition.scopeId)?.goal : null;
        const skill = definition.scope === 'skill' ? await c.skill.findFirst({ where: { id: definition.scopeId!, userId } }) : null;
        synthesized.push({ id: `${definition.id}:${evaluation.periodStart}`, taskId: `${definition.id}:${evaluation.periodStart}`, goalId: goal?.id, skillId: goal?.skillId ?? skill?.id, profileId: goal?.skill.profileId ?? skill?.profileId, kind: 'sub_streak_met', minutes: 0, qty: 1, localDate: evaluation.periodEnd });
      }
    }
  }
  return { created, corrected };
}

export function latestRecordFold(records: Array<StoredRecord & { ruleVersion: { version: number } }>): StreakRecord[] { return records.map(row => ({ result: row.result as StreakRecord['result'], reason: row.reason, value: row.value, provisional: row.provisional, periodStart: calendarString(row.periodStart), periodEnd: calendarString(row.periodEnd), ruleVersion: row.ruleVersion.version })); }
