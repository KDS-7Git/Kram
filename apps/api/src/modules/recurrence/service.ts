import { createHash } from 'node:crypto';
import { Prisma, type RecurrenceSeries as SeriesRow } from '@prisma/client';
import { z } from 'zod';
import { classDetailsSchema, dateSchema, goalSchema, holidaySchema, recurrenceExceptionSchema, recurrenceSeriesSchema } from '@kram/shared';
import { expand, splitSeries, validateRRule, type RecurrenceSeries as EngineSeries, type RecurrenceException as EngineException } from '@kram/recurrence';
import { conflicts, type Layer } from '@kram/timetable';
import { addDays, daysBetween, studyDate } from '@kram/time';
import { db } from '../../db';
import { calendarDate, calendarString, clock, currentStudyDate } from '../../calendar';
import { ApiError } from '../../errors';
import { json, lockOwner, newId, notFound, ownerWhere, type Connection } from '../../repository';
import { getSettings } from '../hierarchy/service';
import { refreshReminders } from '../notifications/service';

const pauseRangesSchema = z.array(z.object({ start: dateSchema, end: dateSchema.nullable().optional(), source: z.enum(['goal', 'series']).optional() }));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type IncludedSeries = SeriesRow & { exceptions: { date: Date; kind: string; override: Prisma.JsonValue; toDate: Date | null; toStartMin: number | null }[] };
export const seriesDto = (row: SeriesRow) => ({ ...row, classDetails: row.classDetails ? classDetailsSchema.parse(row.classDetails) : null, dtstartLocal: calendarString(row.dtstartLocal), effectiveFrom: calendarString(row.effectiveFrom), until: row.until ? calendarString(row.until) : null });
function engineSeries(row: IncludedSeries, holidays: string[]): EngineSeries {
  return { id: row.id, ...(row.goalId ? { goalId: row.goalId } : {}), title: row.title, rrule: row.rrule, dtstartLocal: calendarString(row.dtstartLocal), tz: row.tz,
    until: row.until ? calendarString(row.until) : null, status: row.status as EngineSeries['status'], ...(row.startMin === null ? {} : { startMin: row.startMin }), estMinutes: row.estMinutes, qty: row.qty,
    pausedRanges: z.array(z.object({ start: dateSchema, end: dateSchema.nullable().optional() })).parse(row.pausedRanges), holidays,
    exceptions: row.exceptions.map(value => recurrenceExceptionSchema.parse({ date: calendarString(value.date), kind: value.kind, override: value.override, toDate: value.toDate ? calendarString(value.toDate) : undefined, toStartMin: value.toStartMin ?? undefined }) as EngineException) };
}
function validRule(value: string) {
  try { return validateRRule(value); } catch (error) { throw new ApiError('VALIDATION_FAILED', error instanceof Error ? error.message : 'Use a valid recurrence rule.', 400); }
}
async function scopedInput(userId: string, input: unknown, c: Connection) {
  const value = recurrenceSeriesSchema.parse(input); value.rrule = validRule(value.rrule);
  if (value.goalId) {
    const goal = notFound(await c.goal.findFirst({ where: { id: value.goalId, userId, archivedAt: null, skill: { archivedAt: null, profile: { archivedAt: null } } } }), 'goal');
    if (goal.status !== 'active') throw new ApiError('GOAL_NOT_ACTIVE', 'Resume the goal before scheduling it.', 409);
    if (value.skillId && value.skillId !== goal.skillId) throw new ApiError('HIERARCHY_MISMATCH', 'Choose the goal’s skill.', 400);
    value.skillId = goal.skillId;
  }
  if (value.skillId) {
    const skill = notFound(await c.skill.findFirst({ where: { id: value.skillId, userId, archivedAt: null, profile: { archivedAt: null } } }), 'skill');
    if (value.profileId && value.profileId !== skill.profileId) throw new ApiError('HIERARCHY_MISMATCH', 'Choose the skill’s profile.', 400);
    value.profileId = skill.profileId;
  }
  if (value.profileId) notFound(await c.profile.findFirst({ where: { id: value.profileId, userId, archivedAt: null } }), 'profile');
  return value;
}

async function recordedGoalDates(userId: string, c: Connection) {
  const rows = await c.task.findMany({ where: { userId, archivedAt: null, OR: [{ eventVersion: { gt: 0 } }, { manualOverride: true }] }, include: { occurrence: true } });
  const dates = new Map<string, Set<string | null>>();
  for (const row of rows) for (const date of [calendarString(row.earliestDate), ...(row.occurrence ? [calendarString(row.occurrence.originalDate)] : [])]) {
    const key = `${row.goalId}:${date}`; if (!dates.has(key)) dates.set(key, new Set()); dates.get(key)!.add(row.occurrenceId);
  }
  return (goalId: string, original: string, local: string, ownId?: string) => [original, local].some(date => [...(dates.get(`${goalId}:${date}`) ?? [])].some(id => id !== ownId));
}
/** Map immutable effective-dated goal rules to anchored series; metadata edits retain the anchor. */
async function syncGoalSeries(userId: string, first: string, c: Connection) {
  const settings = await getSettings(userId, c);
  const goals = await c.goal.findMany({ where: { userId }, include: { skill: { include: { profile: true } }, rules: { orderBy: [{ effectiveFrom: 'asc' }, { version: 'asc' }] } } });
  for (const goal of goals) {
    for (let index = 0; index < goal.rules.length; index++) {
      const version = goal.rules[index]!, rules = goalSchema.parse(version.rules);
      if (rules.type !== 'recurring') continue;
      const next = goal.rules[index + 1];
      const end = [rules.dueDate, next ? addDays(calendarString(next.effectiveFrom), -1) : null].filter((date): date is string => Boolean(date)).sort()[0] ?? null;
      const current = await c.recurrenceSeries.findUnique({ where: { ruleVersionId: version.id } });
      const closed = goal.archivedAt || goal.status === 'completed' || goal.skill.archivedAt || goal.skill.profile.archivedAt;
      const pauses = current ? pauseRangesSchema.parse(current.pausedRanges) : [];
      if (goal.status === 'paused' && !pauses.some(range => !range.end && range.source === 'goal')) pauses.push({ start: first, end: null, source: 'goal' });
      if (goal.status === 'active') for (let index = pauses.length - 1; index >= 0; index--) { const pause = pauses[index]!; if (!pause.end && pause.source === 'goal') { if (first <= pause.start) pauses.splice(index, 1); else pause.end = addDays(first, -1); } }
      const status = closed ? 'ended' : goal.status === 'paused' || pauses.some(range => !range.end) ? 'paused' : 'active';
      const data = { title: rules.title, rrule: rules.rrule!, dtstartLocal: calendarDate(rules.startDate), effectiveFrom: version.effectiveFrom, tz: current?.tz ?? settings.timezone,
        until: end ? calendarDate(end) : null, status, pausedRanges: json(pauses) };
      if (!current) await c.recurrenceSeries.create({ data: { ...data, id: newId(), userId, goalId: goal.id, skillId: goal.skillId, profileId: goal.skill.profileId, ruleVersionId: version.id, kind: 'goal',
        estMinutes: rules.estMinutes, qty: rules.targetQty, unit: rules.unit, archivedAt: closed ? new Date() : null } });
      else {
        const unchanged = current.status === status && JSON.stringify(pauseRangesSchema.parse(current.pausedRanges)) === JSON.stringify(pauses) && (current.until ? calendarString(current.until) : null) === end;
        if (!unchanged) await c.recurrenceSeries.update({ where: { id: current.id }, data: { ...data, ...(closed ? { archivedAt: current.archivedAt ?? new Date() } : {}), version: { increment: 1 } } });
      }
    }
  }
}

/** Insert deterministic occurrence identities; only unstarted, unmodified projections can change. */
export async function materializeOccurrences(userId: string, from?: string, c: Connection = db, to?: string, strict = false): Promise<{ created: number; updated: number; conflicts: number }> {
  if (c === db) return db.$transaction(async tx => { await lockOwner(tx, userId); return materializeOccurrences(userId, from, tx, to, strict); }, { timeout: 30000 });
  const settings = await getSettings(userId, c), first = dateSchema.parse(from ?? studyDate(clock.now(), settings.timezone, settings.dayRollover)), last = dateSchema.parse(to ?? addDays(first, 20));
  if (daysBetween(first, last) < 0 || daysBetween(first, last) > 366) throw new ApiError('INVALID_DATE_RANGE', 'Choose a range of at most 366 days.', 400);
  await syncGoalSeries(userId, studyDate(clock.now(), settings.timezone, settings.dayRollover), c);
  const holidays = (await c.holiday.findMany({ where: { userId } })).map(row => calendarString(row.date));
  const series = await c.recurrenceSeries.findMany({ where: { userId }, include: { exceptions: true, goal: { include: { resources: true, skill: { include: { profile: true } } } } }, orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }] });
  const recorded = await recordedGoalDates(userId, c);
  let created = 0, updated = 0, conflictCount = 0;
  for (const row of series) {
    const closed = row.archivedAt || row.goal && (row.goal.status === 'completed' || row.goal.archivedAt || row.goal.skill.archivedAt || row.goal.skill.profile.archivedAt);
    const desired = closed ? [] : expand(engineSeries(row, holidays), first, last).filter(item => item.originalDate >= calendarString(row.effectiveFrom));
    const existing = await c.occurrence.findMany({ where: { userId, seriesId: row.id }, include: { tasks: true, slot: true } });
    const byDate = new Map(existing.map(item => [calendarString(item.originalDate), item]));
    const isProtected = (item: typeof existing[number]) => item.manualOverride || item.tasks.some(task => task.eventVersion > 0 || task.manualOverride);
    const wanted = new Set(desired.map(item => item.originalDate));
    // Remove old unstarted placements first, so a moved occurrence does not conflict with itself.
    for (const old of existing) {
      const original = calendarString(old.originalDate), local = calendarString(old.localDate);
      if (local < first || local > last || isProtected(old)) continue;
      const next = desired.find(item => item.originalDate === original);
      if (old.slot && (!next || next.localDate !== local || next.startMin !== old.slot.startMin || next.estMinutes !== old.slot.endMin - old.slot.startMin)) await c.timeSlot.update({ where: { id: old.slot.id }, data: { archivedAt: new Date(), version: { increment: 1 } } });
      if (!wanted.has(original)) {
        await c.task.updateMany({ where: { userId, occurrenceId: old.id, eventVersion: 0, manualOverride: false, archivedAt: null }, data: { archivedAt: new Date() } });
        if (old.status !== 'suppressed') await c.occurrence.update({ where: { id: old.id }, data: { status: 'suppressed', conflict: Prisma.JsonNull } });
      }
    }
    for (const value of desired) {
      const previous = byDate.get(value.originalDate); if (previous && isProtected(previous)) continue;
      // A rule version must not create a second commitment for recorded work.
      if (row.kind === 'goal' && row.goalId && recorded(row.goalId, value.originalDate, value.localDate, previous?.id)) {
        if (previous) { await c.task.updateMany({ where: { occurrenceId: previous.id, eventVersion: 0, manualOverride: false }, data: { archivedAt: new Date() } }); await c.occurrence.update({ where: { id: previous.id }, data: { status: 'suppressed' } }); }
        continue;
      }
      const sourceHash = hash(value);
      const data = { localDate: calendarDate(value.localDate), fields: json(value), sourceHash, moved: value.moved, adjusted: value.adjusted, ambiguous: value.ambiguous, status: 'scheduled', conflict: Prisma.JsonNull };
      const occurrence = previous ?? await c.occurrence.create({ data: { ...data, id: newId(), userId, seriesId: row.id, originalDate: calendarDate(value.originalDate) } });
      if (!previous) created++;
      else if (previous.sourceHash !== sourceHash || previous.status !== 'scheduled') { await c.occurrence.update({ where: { id: previous.id }, data }); updated++; }
      if (row.kind === 'goal' && row.goal && !row.goal.resources.length && value.localDate <= addDays(first, 13)) {
        const estimate = row.unit.toLowerCase() === 'minutes' ? Math.ceil(value.qty!) : value.estMinutes!;
        const chunks = Math.ceil(estimate / 960), keys = new Set<string>();
        for (let index = 0; index < chunks; index++) {
          const minutes = Math.min(960, estimate - index * 960), qty = value.qty! * minutes / estimate;
          const periodKey = `recurrence:${row.id}:${value.originalDate}:chunk:${index}`, materializationKey = hash([userId, row.goalId, periodKey]); keys.add(materializationKey);
          const task = previous?.tasks.find(task => task.materializationKey === materializationKey);
          const projection = { title: value.title!, estMinutes: minutes, remainingMinutes: minutes, qty, earliestDate: calendarDate(value.localDate), dueDate: calendarDate(value.localDate), archivedAt: null };
          if (!task) await c.task.create({ data: { ...projection, id: newId(), userId, goalId: row.goalId!, occurrenceId: occurrence.id, materializationKey, periodKey } });
          else if (previous!.sourceHash !== sourceHash || task.archivedAt) await c.task.update({ where: { id: task.id }, data: projection });
        }
        await c.task.updateMany({ where: { userId, occurrenceId: occurrence.id, materializationKey: { notIn: [...keys] }, eventVersion: 0, manualOverride: false, archivedAt: null }, data: { archivedAt: new Date() } });
      }
      if (row.kind === 'fixed' && value.startMin !== undefined) {
        const placement = { id: occurrence.id, date: value.localDate, startMin: value.startMin, endMin: value.startMin + value.estMinutes!, layer: row.layer as 'fixed' | 'unavailable', title: value.title!, skillId: row.skillId, profileId: row.profileId, goalId: row.goalId };
        if (placement.endMin > 1440) throw new ApiError('INVALID_OCCURRENCE_TIME', 'Keep this occurrence within one calendar day.', 400);
        const occupied = await c.timeSlot.findMany({ where: { userId, date: calendarDate(value.localDate), archivedAt: null, occurrenceId: { not: occurrence.id } } });
        // Nullable occurrence ids are included explicitly in PostgreSQL predicates.
        const manual = await c.timeSlot.findMany({ where: { userId, date: calendarDate(value.localDate), archivedAt: null, occurrenceId: null } });
        const collisions = conflicts([...([...occupied, ...manual].map(slot => ({ ...slot, layer: slot.layer as Layer, date: calendarString(slot.date) }))), placement]);
        if (collisions.length) {
          const detail = collisions.map(item => item.first.id === occurrence.id ? item.second : item.first).map(item => ({ id: item.id, title: item.title, date: item.date, startMin: item.startMin, endMin: item.endMin }));
          if (strict) throw new ApiError('SLOT_CONFLICT', 'A repeating commitment overlaps existing work.', 409, detail);
          await c.occurrence.update({ where: { id: occurrence.id }, data: { status: 'conflict', conflict: json(detail) } }); conflictCount++; continue;
        }
        const { id: _candidateId, ...slotPlacement } = placement;
        const slotData = { ...slotPlacement, date: calendarDate(value.localDate), archivedAt: null };
        if (!previous?.slot) await c.timeSlot.create({ data: { ...slotData, id: newId(), userId, occurrenceId: occurrence.id } });
        else if (previous.sourceHash !== sourceHash || previous.slot.archivedAt) await c.timeSlot.update({ where: { id: previous.slot.id }, data: { ...slotData, version: { increment: 1 } } });
      }
    }
  }
  await refreshReminders(userId, c);
  return { created, updated, conflicts: conflictCount };
}

function checkVersion(row: SeriesRow, version: number) { if (row.version !== version) throw new ApiError('VERSION_CONFLICT', 'This series changed. Reload it before editing.', 412); }
export const recurrence = {
  async get(userId: string, id: string, c: Connection = db) { return notFound(await c.recurrenceSeries.findFirst({ where: { id, ...ownerWhere(userId) }, include: { exceptions: true } }), 'series'); },
  async list(userId: string) { return (await db.recurrenceSeries.findMany({ where: { userId, archivedAt: null }, orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }] })).map(seriesDto); },
  async create(userId: string, input: unknown, connection: Connection = db, materialize = true) {
    const create = async (tx: Connection) => {
      await lockOwner(tx, userId); const value = await scopedInput(userId, input, tx);
      if (value.kind === 'goal') throw new ApiError('GOAL_RULE_REQUIRED', 'Create a recurring goal in Goals; its versioned rules create the series.', 400);
      const row = await tx.recurrenceSeries.create({ data: { ...value, classDetails: value.classDetails ? json(value.classDetails) : Prisma.DbNull, id: newId(), userId, dtstartLocal: calendarDate(value.dtstartLocal), effectiveFrom: calendarDate(value.dtstartLocal), until: value.until ? calendarDate(value.until) : null } });
      if (materialize) await materializeOccurrences(userId, undefined, tx, undefined, true); return seriesDto(row);
    };
    return connection === db ? db.$transaction(create, { timeout: 30000 }) : create(connection);
  },
  async exception(userId: string, id: string, input: unknown, version: number, connection: Connection = db, materialize = true) {
    const value = recurrenceExceptionSchema.parse(input), today = await currentStudyDate(userId, connection);
    if (value.date < today || value.kind === 'move' && value.toDate < today) throw new ApiError('HISTORY_PROTECTED', 'Change today or future occurrences; past work stays intact.', 409);
    const change = async (tx: Connection) => {
      await lockOwner(tx, userId); const row = await this.get(userId, id, tx); checkVersion(row, version);
      if (row.kind === 'goal' && value.kind === 'move' && value.toDate < calendarString(row.effectiveFrom)) throw new ApiError('RULE_DATE_PROTECTED', 'Move goal work on or after this rule’s effective date.', 409);
      const original = expand({ ...engineSeries(row, []), status: 'active', exceptions: [], pausedRanges: [], holidays: [] }, value.date, value.date);
      if (!original.length || value.date < calendarString(row.effectiveFrom)) throw new ApiError('OCCURRENCE_NOT_FOUND', 'This date is not an occurrence of the series.', 404);
      const old = await tx.occurrence.findUnique({ where: { seriesId_originalDate: { seriesId: id, originalDate: calendarDate(value.date) } }, include: { tasks: true } });
      if (old?.manualOverride || old?.tasks.some(task => task.eventVersion || task.manualOverride)) throw new ApiError('HISTORY_PROTECTED', 'This occurrence has work or an owner override. Correct the task history instead.', 409);
      const stored = row.exceptions.find(exception => calendarString(exception.date) === value.date);
      const existingFields = stored?.override && typeof stored.override === 'object' ? stored.override as Record<string, unknown> : {};
      const remainsMoved = value.kind === 'move' || value.kind === 'modify' && stored?.kind === 'move';
      const data = { kind: remainsMoved ? 'move' : value.kind,
        override: json(value.kind === 'skip' ? {} : { ...existingFields, ...value.override }),
        toDate: value.kind === 'move' ? calendarDate(value.toDate) : remainsMoved ? stored!.toDate : null,
        toStartMin: value.kind === 'move' ? value.toStartMin ?? stored?.toStartMin ?? null : remainsMoved && value.kind === 'modify' ? value.override.startMin ?? stored!.toStartMin : null };
      await tx.recurrenceException.upsert({ where: { seriesId_date: { seriesId: id, date: calendarDate(value.date) } }, create: { ...data, id: newId(), userId, seriesId: id, date: calendarDate(value.date) }, update: data });
      const changed = await tx.recurrenceSeries.update({ where: { id }, data: { version: { increment: 1 } } });
      const first = [today, value.date, ...(value.kind === 'move' ? [value.toDate] : [])].sort()[0]!;
      const last = [addDays(today, 20), value.date, ...(value.kind === 'move' ? [value.toDate] : [])].sort().at(-1)!;
      if (materialize) await materializeOccurrences(userId, first, tx, last, true); return seriesDto(await this.get(userId, changed.id, tx));
    };
    return connection === db ? db.$transaction(change, { timeout: 30000 }) : change(connection);
  },
  async split(userId: string, id: string, from: string, patch: Record<string, unknown>, version: number, connection: Connection = db, materialize = true) {
    const today = await currentStudyDate(userId, connection); dateSchema.parse(from);
    if (from < today) throw new ApiError('HISTORY_PROTECTED', 'Start future changes today or later.', 409);
    const change = async (tx: Connection) => {
      await lockOwner(tx, userId); const current = await this.get(userId, id, tx); checkVersion(current, version);
      let divided: ReturnType<typeof splitSeries>;
      try { divided = splitSeries(engineSeries(current, []), from, 'rrule' in patch ? { rrule: validRule(String(patch.rrule)) } : {}, newId()); }
      catch (error) { throw new ApiError('INVALID_SPLIT', error instanceof Error ? error.message : 'Split within the series lifetime.', 400); }
      if (current.kind === 'goal') {
        if (patch.type !== undefined && patch.type !== 'recurring') throw new ApiError('GOAL_RULE_REQUIRED', 'Change the goal type from Goals.', 400);
        const { goals } = await import('../goals/service');
        await goals.edit(userId, current.goalId!, { ...patch, type: 'recurring', effectiveFrom: from, startDate: from, rrule: divided.next.rrule }, tx, true);
        const goal = await tx.goal.findUniqueOrThrow({ where: { id: current.goalId! } });
        const rule = await tx.goalRuleVersion.findUniqueOrThrow({ where: { goalId_version: { goalId: goal.id, version: goal.ruleVersion } } });
        const following = await tx.recurrenceSeries.findUniqueOrThrow({ where: { ruleVersionId: rule.id } });
        await tx.recurrenceSeries.update({ where: { id: following.id }, data: { pausedRanges: json(divided.next.pausedRanges ?? []) } });
        for (const exception of current.exceptions.filter(value => calendarString(value.date) >= from)) await tx.recurrenceException.create({ data: { id: newId(), userId, seriesId: following.id, date: exception.date, kind: exception.kind, override: exception.override ?? {}, toDate: exception.toDate, toStartMin: exception.toStartMin } });
        if (materialize) await materializeOccurrences(userId, today, tx, addDays([today, from].sort().at(-1)!, 20), true);
        return { previous: seriesDto(await this.get(userId, id, tx)), next: seriesDto(await this.get(userId, following.id, tx)) };
      }
      if (patch.kind !== undefined && patch.kind !== current.kind) throw new ApiError('SERIES_KIND_PROTECTED', 'Create a new series to change its kind.', 400);
      const input = await scopedInput(userId, { ...seriesDto(current), ...patch, dtstartLocal: from }, tx);
      const { previous, next } = divided;
      const old = await tx.recurrenceSeries.update({ where: { id }, data: { until: calendarDate(previous.until!), status: 'ended', version: { increment: 1 } } });
      const following = await tx.recurrenceSeries.create({ data: { ...input, classDetails: input.classDetails ? json(input.classDetails) : Prisma.DbNull, rrule: next.rrule, pausedRanges: json(next.pausedRanges ?? []), id: next.id, userId, dtstartLocal: calendarDate(from), effectiveFrom: calendarDate(from), until: input.until ? calendarDate(input.until) : null } });
      for (const exception of current.exceptions.filter(value => calendarString(value.date) >= from)) await tx.recurrenceException.create({ data: { id: newId(), userId, seriesId: following.id, date: exception.date, kind: exception.kind, override: exception.override ?? {}, toDate: exception.toDate, toStartMin: exception.toStartMin } });
      if (materialize) await materializeOccurrences(userId, today, tx, addDays([today, from].sort().at(-1)!, 20), true);
      return { previous: seriesDto(old), next: seriesDto(following) };
    };
    return connection === db ? db.$transaction(change, { timeout: 30000 }) : change(connection);
  },
  async pause(userId: string, id: string, date: string, resume: boolean, version: number) {
    const today = await currentStudyDate(userId); dateSchema.parse(date);
    if (date < today) throw new ApiError('HISTORY_PROTECTED', 'Pause or resume today or later.', 409);
    return db.$transaction(async tx => {
      await lockOwner(tx, userId); const row = await this.get(userId, id, tx); checkVersion(row, version);
      const ranges = pauseRangesSchema.parse(row.pausedRanges);
      if (resume) { for (let index = ranges.length - 1; index >= 0; index--) { const range = ranges[index]!; if (!range.end) { if (date < range.start) throw new ApiError('INVALID_PAUSE', 'Resume on or after the pause starts.', 400); if (date === range.start) ranges.splice(index, 1); else range.end = addDays(date, -1); } } }
      else if (!ranges.some(range => !range.end)) ranges.push({ start: date, end: null, source: 'series' });
      const result = await tx.recurrenceSeries.update({ where: { id }, data: { pausedRanges: json(ranges), status: resume ? 'active' : 'paused', version: { increment: 1 } } });
      await materializeOccurrences(userId, today, tx, addDays(today, 20), true); return seriesDto(await this.get(userId, result.id, tx));
    });
  },
  async occurrences(userId: string, from: string, to: string, c: Connection = db) {
    if (daysBetween(dateSchema.parse(from), dateSchema.parse(to)) < 0 || daysBetween(from, to) > 366) throw new ApiError('INVALID_DATE_RANGE', 'Choose an ordered range of at most 366 days.', 400);
    const range = { gte: calendarDate(from), lte: calendarDate(to) };
    const rows = await c.occurrence.findMany({ where: { userId, OR: [{ localDate: range }, { originalDate: range }] }, include: { series: true, tasks: true, slot: true }, orderBy: [{ localDate: 'asc' }, { originalDate: 'asc' }, { id: 'asc' }] });
    const keys = new Set(rows.map(row => `${row.seriesId}:${calendarString(row.originalDate)}`));
    const result = rows.filter(row => calendarString(row.localDate) >= from && calendarString(row.localDate) <= to).map(row => ({ ...row, virtual: false, originalDate: calendarString(row.originalDate), localDate: calendarString(row.localDate), series: seriesDto(row.series), tasks: row.tasks.map(task => ({ ...task, earliestDate: calendarString(task.earliestDate), dueDate: task.dueDate ? calendarString(task.dueDate) : null })), slot: row.slot ? { ...row.slot, date: calendarString(row.slot.date), recurrenceSeriesId: row.seriesId, originalDate: calendarString(row.originalDate) } : null }));
    const holidays = (await c.holiday.findMany({ where: { userId } })).map(row => calendarString(row.date));
    const series = await c.recurrenceSeries.findMany({ where: { userId, archivedAt: null }, include: { exceptions: true }, orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }] });
    const recorded = await recordedGoalDates(userId, c);
    for (const row of series) for (const value of expand(engineSeries(row, holidays), from, to).filter(value => value.originalDate >= calendarString(row.effectiveFrom))) {
      if (keys.has(value.id) || row.kind === 'goal' && row.goalId && recorded(row.goalId, value.originalDate, value.localDate)) continue;
      const slot = row.kind === 'fixed' && value.startMin !== undefined ? { id: value.id, userId, date: value.localDate, startMin: value.startMin, endMin: value.startMin + value.estMinutes!, layer: row.layer, title: value.title!, profileId: row.profileId, skillId: row.skillId, goalId: row.goalId, taskId: null, pinned: false, version: row.version, templateId: null, applicationKey: null, occurrenceId: null, archivedAt: null, isDemo: false, createdAt: row.createdAt, updatedAt: row.updatedAt, recurrenceSeriesId: row.id, originalDate: value.originalDate } : null;
      result.push({ id: value.id, userId, seriesId: row.id, originalDate: value.originalDate, localDate: value.localDate, fields: json(value) as Prisma.JsonValue, sourceHash: hash(value), status: 'scheduled', conflict: null, virtual: true, manualOverride: false, adjusted: value.adjusted, ambiguous: value.ambiguous, moved: value.moved, createdAt: row.createdAt, updatedAt: row.updatedAt, tasks: [], series: seriesDto(row), slot });
    }
    result.sort((a, b) => a.localDate.localeCompare(b.localDate) || a.originalDate.localeCompare(b.originalDate) || a.id.localeCompare(b.id));
    // Read-only projection still exposes blocked work instead of silently hiding it.
    const occupied = (await c.timeSlot.findMany({ where: { userId, archivedAt: null, date: range } })).map(slot => ({ ...slot, date: calendarString(slot.date), layer: slot.layer as Layer }));
    for (const item of result) {
      if (!item.virtual || !item.slot) continue;
      const candidate = { ...item.slot, layer: item.slot.layer as Layer };
      const collisions = conflicts([...occupied.filter(slot => slot.date === item.localDate), candidate]);
      if (collisions.length) {
        item.status = 'conflict'; item.conflict = json(collisions.map(pair => pair.first.id === candidate.id ? pair.second : pair.first).map(slot => ({ id: slot.id, title: slot.title, date: slot.date, startMin: slot.startMin, endMin: slot.endMin }))) as Prisma.JsonValue;
      } else occupied.push(candidate);
    }
    return result;
  },
};
export const holidays = {
  list(userId: string) { return db.holiday.findMany({ where: ownerWhere(userId), orderBy: { date: 'asc' } }).then(rows => rows.map(row => ({ ...row, date: calendarString(row.date) }))); },
  async create(userId: string, input: unknown) {
    const value = holidaySchema.parse(input), today = await currentStudyDate(userId);
    if (value.date < today) throw new ApiError('HISTORY_PROTECTED', 'Declare holidays today or later.', 409);
    return db.$transaction(async tx => { await lockOwner(tx, userId); const row = await tx.holiday.upsert({ where: { userId_date: { userId, date: calendarDate(value.date) } }, create: { id: newId(), userId, title: value.title, date: calendarDate(value.date) }, update: { title: value.title } }); await materializeOccurrences(userId, today, tx); return { ...row, date: value.date }; });
  },
  async remove(userId: string, id: string) {
    return db.$transaction(async tx => { await lockOwner(tx, userId); const row = notFound(await tx.holiday.findFirst({ where: { id, userId } }), 'holiday'); if (calendarString(row.date) < await currentStudyDate(userId)) throw new ApiError('HISTORY_PROTECTED', 'Past holidays keep their history.', 409); await tx.holiday.delete({ where: { id: row.id } }); await materializeOccurrences(userId, undefined, tx); return { id }; });
  },
};
