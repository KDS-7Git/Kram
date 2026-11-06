import { slotSchema, dateSchema } from '@kram/shared';
import { daysBetween, localToInstant, studyDate } from '@kram/time';
import type { TimeSlot } from '@prisma/client';
import { db } from '../../db';
import { ApiError } from '../../errors';
import { calendarDate, calendarString } from '../../calendar';
import { json, lockOwner, newId, notFound, ownerWhere, type Connection } from '../../repository';
import { profiles, skills, getSettings } from '../hierarchy/service';
import { goals } from '../goals/service';
import { tasks } from '../tasks/service';
import { refreshReminders } from '../notifications/service';
import { recurrence } from '../recurrence/service';
import { conflicts, freeSlots, type Layer } from '@kram/timetable';
import { weekday } from '@kram/time';

type SlotInput = ReturnType<typeof slotSchema.parse>;
export const slotDto = (row: TimeSlot) => ({ ...row, date: calendarString(row.date) });
export const slotEtag = (version: number) => `"${version}"`;

export function expectedSlotVersion(header: string | undefined): number {
  if (header === undefined) throw new ApiError('PRECONDITION_REQUIRED', 'Reload this slot and send its If-Match version before changing it.', 428);
  const match = /^"([1-9]\d*)"$/.exec(header.trim());
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new ApiError('INVALID_PRECONDITION', 'Use the quoted ETag returned for this slot.', 400);
  return Number(match[1]);
}
function assertVersion(row: TimeSlot, expected: number) {
  if (row.version !== expected) throw new ApiError('VERSION_CONFLICT', 'This slot changed. Reload it before saving your edit.', 412, { currentVersion: row.version });
}
function isNewPlacement(data: SlotInput, previous?: TimeSlot) {
  return !previous || data.date !== calendarString(previous.date) || data.startMin !== previous.startMin || data.endMin !== previous.endMin ||
    data.layer !== previous.layer || data.pinned !== previous.pinned || data.taskId !== previous.taskId ||
    data.goalId !== previous.goalId || data.skillId !== previous.skillId || data.profileId !== previous.profileId;
}
export async function associations(userId: string, data: SlotInput, c: Connection, previous?: TimeSlot) {
  const value = { ...data };
  if (value.layer === 'pinned' || (value.layer === 'flexible' && value.pinned)) { value.layer = 'pinned'; value.pinned = true; }
  // Scope every explicit reference before testing relationships between them.
  const [specifiedProfile, specifiedSkill, specifiedGoal, task] = await Promise.all([
    value.profileId ? profiles.get(userId, value.profileId, c) : null,
    value.skillId ? skills.get(userId, value.skillId, c) : null,
    value.goalId ? goals.get(userId, value.goalId, c) : null,
    value.taskId ? tasks.get(userId, value.taskId, c) : null,
  ]);
  if (task) {
    if (value.goalId && value.goalId !== task.goalId) throw new ApiError('HIERARCHY_MISMATCH', 'Choose the task’s own goal.', 400);
    value.goalId = task.goalId;
    if (['unavailable', 'reserved'].includes(value.layer)) throw new ApiError('INVALID_SLOT_LAYER', 'Place task work in a fixed, pinned or flexible slot.', 400);
  }
  const goal = specifiedGoal ?? (value.goalId ? await goals.get(userId, value.goalId, c) : null);
  if (goal) {
    if (value.skillId && value.skillId !== goal.skillId) throw new ApiError('HIERARCHY_MISMATCH', 'Choose the goal’s own skill.', 400);
    value.skillId = goal.skillId;
  }
  const skill = specifiedSkill ?? (value.skillId ? await skills.get(userId, value.skillId, c) : null);
  if (skill) {
    if (value.profileId && value.profileId !== skill.profileId) throw new ApiError('HIERARCHY_MISMATCH', 'Choose the skill’s own profile.', 400);
    value.profileId = skill.profileId;
  }
  const profile = specifiedProfile ?? (value.profileId ? await profiles.get(userId, value.profileId, c) : null);
  const placement = isNewPlacement(value, previous);
  if (placement && (profile?.archivedAt || skill?.archivedAt || goal?.archivedAt || task?.archivedAt || task?.item?.archivedAt || task?.item?.resource.archivedAt)) throw new ApiError('ARCHIVED_PARENT', 'Choose unarchived parents and material for new work.', 409);
  if (placement && goal && goal.status !== 'active') throw new ApiError('GOAL_NOT_ACTIVE', 'Resume this goal before placing new work.', 409);
  if (placement && task && ['completed', 'cancelled', 'skipped'].includes(task.status)) throw new ApiError('TASK_CLOSED', 'A completed, skipped or cancelled task cannot receive a new placement.', 409);
  if (placement && task) {
    const settings = await getSettings(userId, c);
    const workDate = studyDate(localToInstant(value.date, value.startMin, settings.timezone), settings.timezone, settings.dayRollover);
    if (workDate < calendarString(task.earliestDate) || (task.deferredToDate && workDate < calendarString(task.deferredToDate))) throw new ApiError('TASK_NOT_AVAILABLE', 'Place this task on or after its available study date.', 409);
  }
  if (value.layer === 'reserved' && !value.skillId) throw new ApiError('RESERVED_SKILL_REQUIRED', 'Choose the skill that owns this reserved time.', 400);
  return value;
}
function overlapAllowed(a: SlotInput, b: TimeSlot) {
  if (a.layer !== 'reserved' && b.layer !== 'reserved') return false;
  if (!a.skillId || !b.skillId || a.skillId !== b.skillId) return false;
  if (a.layer === 'reserved' && b.layer === 'reserved') return true;
  const reserved = a.layer === 'reserved' ? a : b;
  const work = a.layer === 'reserved' ? b : a;
  return work.layer === 'flexible' && !work.pinned && work.startMin >= reserved.startMin && work.endMin <= reserved.endMin;
}
export async function assertNoConflict(userId: string, data: SlotInput, c: Connection, excludingId?: string) {
  const rows = await c.timeSlot.findMany({ where: { ...ownerWhere(userId), date: calendarDate(data.date), archivedAt: null,
    ...(excludingId ? { id: { not: excludingId } } : {}), startMin: { lt: data.endMin }, endMin: { gt: data.startMin } }, orderBy: [{ startMin: 'asc' }, { id: 'asc' }] });
  const conflicts = rows.filter((row) => !overlapAllowed(data, row));
  if (conflicts.length) throw new ApiError('SLOT_CONFLICT', 'This time overlaps an existing slot. Move it or adjust its boundaries.', 409,
    conflicts.map((row) => ({ id: row.id, title: row.title, date: calendarString(row.date), startMin: row.startMin, endMin: row.endMin, layer: row.layer })));
}
function normalizeDatabaseConflict(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (/23P01|exclusion constraint/i.test(message)) throw new ApiError('SLOT_CONFLICT', 'Another slot now occupies this time. Reload the timetable.', 409);
  throw error;
}

export const timetable = {
  async get(userId: string, id: string, c: Connection = db) {
    return notFound(await c.timeSlot.findFirst({ where: { id, ...ownerWhere(userId) } }), 'time slot');
  },
  async day(userId: string, date: string, c: Connection = db) {
    dateSchema.parse(date); return this.global(userId, date, date, c);
  },
  async global(userId: string, from: string, to: string, c: Connection = db) {
    const span = daysBetween(dateSchema.parse(from), dateSchema.parse(to));
    if (span < 0 || span > 366) throw new ApiError('INVALID_DATE_RANGE', 'Choose an ordered range spanning at most 366 days.', 400);
    const slots = (await c.timeSlot.findMany({ where: { ...ownerWhere(userId), archivedAt: null, date: { gte: calendarDate(from), lte: calendarDate(to) } }, include: { occurrence: true }, orderBy: [{ date: 'asc' }, { startMin: 'asc' }, { id: 'asc' }] })).map(slot => ({ ...slotDto(slot), ...(slot.occurrence ? { recurrenceSeriesId: slot.occurrence.seriesId, originalDate: calendarString(slot.occurrence.originalDate) } : {}) }));
    for (const occurrence of await recurrence.occurrences(userId, from, to, c)) {
      if (!occurrence.virtual || !occurrence.slot || occurrence.status !== 'scheduled') continue;
      const slot = occurrence.slot;
      if (conflicts([...slots.filter(existing => existing.date === slot.date).map(existing => ({ ...existing, layer: existing.layer as Layer })), { ...slot, layer: slot.layer as Layer }]).length) continue;
      slots.push({ ...slot, virtual: true } as typeof slots[number]);
    }
    return slots.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin || a.id.localeCompare(b.id));
  },
  async free(userId: string, date: string) {
    const settings = await getSettings(userId), slots = await this.day(userId, date);
    return freeSlots({ date, wakingWindow: { startMin: settings.wakingMin, endMin: settings.sleepingMin }, slots: slots.map(slot => ({ ...slot, layer: slot.layer as Layer })), maxDailyMin: settings.maxDailyMin, minFreeTime: settings.minFreeMin, minBreak: settings.minBreakMin, breakAfter: settings.breakAfterMin, restDay: settings.restDays.includes(weekday(date)) });
  },
  async create(userId: string, input: unknown) {
    const parsed = slotSchema.parse(input);
    try {
      return await db.$transaction(async (tx) => {
        await lockOwner(tx, userId);
        const data = await associations(userId, parsed, tx);
        await assertNoConflict(userId, data, tx);
        const row = await tx.timeSlot.create({ data: { ...data, date: calendarDate(data.date), id: newId(), userId } });
        await refreshReminders(userId, tx);
        return slotDto(row);
      });
    } catch (error) { return normalizeDatabaseConflict(error); }
  },
  async edit(userId: string, id: string, input: Record<string, unknown>, expectedVersion: number) {
    try {
      return await db.$transaction(async (tx) => {
        await lockOwner(tx, userId);
        const current = await this.get(userId, id, tx);
        assertVersion(current, expectedVersion);
        if (current.archivedAt) throw new ApiError('SLOT_ARCHIVED', 'This slot is archived. Create a new slot for new work.', 409);
        const data = await associations(userId, slotSchema.parse({ ...slotDto(current), ...input }), tx, current);
        await assertNoConflict(userId, data, tx, id);
        const row = await tx.timeSlot.update({ where: { id, userId, version: expectedVersion }, data: { ...data, date: calendarDate(data.date), version: { increment: 1 } } });
        if (row.occurrenceId) {
          const occurrence = await tx.occurrence.findUniqueOrThrow({ where: { id: row.occurrenceId } });
          await tx.occurrence.update({ where: { id: occurrence.id }, data: { manualOverride: true, localDate: row.date, moved: calendarString(occurrence.originalDate) !== data.date,
            fields: json({ ...(occurrence.fields as Record<string, unknown>), title: row.title, startMin: row.startMin, estMinutes: row.endMin - row.startMin, localDate: data.date }) } });
        }
        await refreshReminders(userId, tx);
        return slotDto(row);
      });
    } catch (error) { return normalizeDatabaseConflict(error); }
  },
  async archive(userId: string, id: string, expectedVersion: number) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const current = await this.get(userId, id, tx);
      assertVersion(current, expectedVersion);
      if (current.archivedAt) throw new ApiError('SLOT_ARCHIVED', 'This slot is already archived.', 409);
      const row = await tx.timeSlot.update({ where: { id, userId, version: expectedVersion }, data: { archivedAt: new Date(), version: { increment: 1 } } });
      if (row.occurrenceId) await tx.occurrence.update({ where: { id: row.occurrenceId }, data: { manualOverride: true, status: 'suppressed' } });
      await refreshReminders(userId, tx);
      return slotDto(row);
    });
  },
};
