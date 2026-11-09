import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { classDaySchema, classTimetableSchema, classWeekdays, dateSchema } from '@kram/shared';
import { conflicts } from '@kram/timetable';
import { addDays, daysBetween, weekday } from '@kram/time';
import { db } from '../../db';
import { calendarDate, calendarString, currentStudyDate } from '../../calendar';
import { ApiError } from '../../errors';
import { json, lockOwner, newId, type Connection } from '../../repository';
import { getSettings } from '../hierarchy/service';
import { refreshReminders } from '../notifications/service';
import { assertNoConflict } from '../timetable/service';
import { materializeOccurrences, recurrence, seriesDto } from './service';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const codes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
type Meeting = ReturnType<typeof classTimetableSchema.parse>['rows'][number];
type Receipt = { operation: string; inputHash: string; ids?: string[]; slotIds?: string[]; sourceSeriesIds?: string[]; date?: string; weekday?: number; added?: number; removed?: number };

async function retry(userId: string, key: string, inputHash: string, c: Connection) {
  const row = await c.templateApplication.findFirst({ where: { userId, key } });
  if (!row) return null;
  const receipt = row.snapshot as Receipt;
  if (receipt.inputHash !== inputHash) throw new ApiError('REQUEST_CONFLICT', 'Use a new save request after changing the timetable.', 409);
  return receipt;
}
function weeklyConflicts(rows: Meeting[]) {
  const slots = rows.flatMap((row, index) => row.weekdays.map(day => ({ id: `${index}:${day}`, title: row.course, date: addDays('2026-01-05', day - 1), startMin: row.startMin, endMin: row.startMin + row.estMinutes, layer: 'fixed' as const })));
  const collisions = conflicts(slots);
  if (collisions.length) throw new ApiError('CLASS_CONFLICT', 'Some weekly meetings overlap. Adjust their days or times before saving.', 409,
    collisions.map(pair => ({ first: pair.first.title, second: pair.second.title, weekday: weekday(pair.first.date) })));
}
async function editable(userId: string, id: string, version: number, from: string, c: Connection) {
  const row = await recurrence.get(userId, id, c);
  if (row.version !== version) throw new ApiError('VERSION_CONFLICT', 'A meeting changed. Reload the timetable before saving.', 412);
  if (row.archivedAt || row.kind !== 'fixed' || row.layer !== 'fixed' || !classWeekdays(row.rrule, calendarString(row.dtstartLocal))) throw new ApiError('CLASS_RULE_REQUIRED', 'Choose an active weekly fixed commitment for this editor.', 409);
  if (row.until && calendarString(row.until) < from) throw new ApiError('CLASS_ENDED', 'This meeting has ended. Add a new meeting for the new semester.', 409);
  return row;
}
/** Release every changed row first so two meetings may exchange times in one save. */
async function release(userId: string, seriesId: string, from: string, today: string, c: Connection) {
  const where = { userId, seriesId, originalDate: { gte: calendarDate(from) }, localDate: { gte: calendarDate(today) } };
  const protectedRow = await c.occurrence.findFirst({ where: { ...where, OR: [{ manualOverride: true }, { tasks: { some: { OR: [{ eventVersion: { gt: 0 } }, { manualOverride: true }] } } }] } });
  if (protectedRow) throw new ApiError('HISTORY_PROTECTED', 'A future meeting has an individual timetable edit or recorded work. Resolve that meeting before changing its weekly row.', 409);
  await c.timeSlot.updateMany({ where: { userId, archivedAt: null, occurrence: where }, data: { archivedAt: new Date(), version: { increment: 1 } } });
  await c.occurrence.updateMany({ where, data: { status: 'suppressed', conflict: Prisma.JsonNull } });
}
async function savedRows(userId: string, ids: string[], c: Connection) {
  const rows = await c.recurrenceSeries.findMany({ where: { userId, id: { in: ids } } });
  const byId = new Map(rows.map(row => [row.id, seriesDto(row)]));
  return ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
}

export const classes = {
  async previewDay(userId: string, date: string) {
    dateSchema.parse(date);
    const applications = await db.templateApplication.findMany({ where: { userId, anchor: calendarDate(date), snapshot: { path: ['operation'], equals: 'class-day' } }, orderBy: { createdAt: 'desc' } });
    const slotIds = applications.flatMap(row => (row.snapshot as Receipt).slotIds ?? []);
    const meetings = await db.timeSlot.findMany({ where: { userId, date: calendarDate(date), archivedAt: null, id: { in: slotIds } }, select: { id: true, title: true, startMin: true, endMin: true }, orderBy: [{ startMin: 'asc' }, { id: 'asc' }] });
    return { weekday: meetings.length ? (applications[0]?.snapshot as Receipt | undefined)?.weekday ?? null : null, meetings };
  },
  async save(userId: string, input: unknown) {
    const value = classTimetableSchema.parse(input);
    for (const row of value.rows) row.weekdays.sort((a, b) => a - b);
    const inputHash = hash(value), key = hash([userId, 'class-timetable', value.requestId]);
    return db.$transaction(async tx => {
      await lockOwner(tx, userId);
      const previous = await retry(userId, key, inputHash, tx);
      if (previous) return { rows: await savedRows(userId, previous.ids ?? [], tx), reused: true };
      const today = await currentStudyDate(userId, tx);
      if (value.effectiveFrom < today) throw new ApiError('HISTORY_PROTECTED', 'Apply timetable changes today or later.', 409);
      const first = [today, value.startDate, value.effectiveFrom].sort().at(-1)!;
      const last = addDays(first, 20);
      if (daysBetween(today, last) > 366) throw new ApiError('INVALID_DATE_RANGE', 'Choose a semester start and change date within the next 346 days.', 400);
      weeklyConflicts(value.rows);
      const settings = await getSettings(userId, tx), result: string[] = [];
      const changes: { row: Meeting; current: Awaited<ReturnType<typeof editable>>; from: string; changed: boolean }[] = [];
      for (const row of value.rows) {
        if (!row.id) continue;
        const current = await editable(userId, row.id, row.version!, value.effectiveFrom, tx);
        const from = [first, calendarString(current.effectiveFrom)].sort().at(-1)!;
        const metadata = seriesDto(current).classDetails;
        const changed = current.title !== row.course || current.startMin !== row.startMin || current.estMinutes !== row.estMinutes ||
          JSON.stringify(classWeekdays(current.rrule, calendarString(current.dtstartLocal))) !== JSON.stringify(row.weekdays) ||
          (current.until ? calendarString(current.until) : null) !== value.endDate || metadata?.type !== row.type || metadata?.slot !== row.slot;
        changes.push({ row, current, from, changed });
      }
      const removals = [];
      for (const row of value.removed) {
        const current = await editable(userId, row.id, row.version, value.effectiveFrom, tx);
        removals.push({ current, from: [value.effectiveFrom, calendarString(current.effectiveFrom)].sort().at(-1)! });
      }
      for (const item of [...changes.filter(item => item.changed), ...removals]) await release(userId, item.current.id, item.from, today, tx);
      for (const item of removals) await tx.recurrenceSeries.update({ where: { id: item.current.id }, data: { until: calendarDate(addDays(item.from, -1)), status: 'ended', version: { increment: 1 } } });
      for (const row of value.rows) {
        const patch = { title: row.course, classDetails: { type: row.type, slot: row.slot }, rrule: `FREQ=WEEKLY;BYDAY=${row.weekdays.map(day => codes[day - 1]).join(',')}`, startMin: row.startMin, estMinutes: row.estMinutes, until: value.endDate };
        if (!row.id) result.push((await recurrence.create(userId, { ...patch, dtstartLocal: first, tz: settings.timezone }, tx, false)).id);
        else {
          const item = changes.find(item => item.current.id === row.id)!;
          result.push(item.changed ? (await recurrence.split(userId, row.id, item.from, patch, row.version!, tx, false)).next.id : row.id);
        }
      }
      await materializeOccurrences(userId, today, tx, last, true);
      await tx.templateApplication.create({ data: { id: newId(), userId, key, anchor: calendarDate(first), snapshot: json({ operation: 'class-timetable', inputHash, ids: result }) } });
      return { rows: await savedRows(userId, result, tx), reused: false };
    }, { timeout: 30000 });
  },

  async day(userId: string, input: unknown) {
    const value = classDaySchema.parse(input), inputHash = hash(value), key = hash([userId, 'class-day', value.requestId]);
    return db.$transaction(async tx => {
      await lockOwner(tx, userId);
      const previous = await retry(userId, key, inputHash, tx);
      if (previous) return { date: value.date, weekday: value.weekday, added: previous.added ?? 0, removed: previous.removed ?? 0, reused: true };
      const today = await currentStudyDate(userId, tx);
      if (value.date < today) throw new ApiError('HISTORY_PROTECTED', 'Replace today or a future college day.', 409);
      if (daysBetween(today, value.date) > 366) throw new ApiError('INVALID_DATE_RANGE', 'Choose a date within the next year.', 400);
      const rows = await tx.recurrenceSeries.findMany({ where: { userId, kind: 'fixed', classDetails: { not: Prisma.DbNull }, archivedAt: null, effectiveFrom: { lte: calendarDate(value.date) }, OR: [{ until: null }, { until: { gte: calendarDate(value.date) } }] }, include: { exceptions: true } });
      const active = rows.filter(row => {
        const pauses = row.pausedRanges as { start: string; end?: string | null }[];
        return !(row.status === 'paused' && !pauses.length) && !pauses.some(range => range.start <= value.date && (!range.end || range.end >= value.date));
      });
      const source = active.filter(row => classWeekdays(row.rrule, calendarString(row.dtstartLocal))?.includes(value.weekday));
      if (!source.length) throw new ApiError('NO_CLASS_DAY', 'No saved classes or labs meet on that weekday during this semester.', 409);
      let removed = 0;
      const oldApplications = await tx.templateApplication.findMany({ where: { userId, anchor: calendarDate(value.date), snapshot: { path: ['operation'], equals: 'class-day' } } });
      const oldIds = oldApplications.flatMap(row => (row.snapshot as Receipt).slotIds ?? []);
      const oldSlots = await tx.timeSlot.findMany({ where: { userId, id: { in: oldIds }, date: calendarDate(value.date), archivedAt: null } });
      if (oldSlots.some(slot => slot.version > 1 || slot.taskId || slot.pinned)) throw new ApiError('HISTORY_PROTECTED', 'A previous makeup block was edited individually. Resolve it before replacing the college day.', 409);
      if (oldSlots.length) {
        await tx.timeSlot.updateMany({ where: { userId, id: { in: oldSlots.map(slot => slot.id) } }, data: { archivedAt: new Date(), version: { increment: 1 } } });
        removed += oldSlots.length;
      }
      const targets = new Map<string, Set<string>>();
      for (const row of active) {
        const exception = row.exceptions.find(item => calendarString(item.date) === value.date);
        if (classWeekdays(row.rrule, calendarString(row.dtstartLocal))?.includes(weekday(value.date)) && exception?.kind !== 'skip' && !(exception?.kind === 'move' && exception.toDate && calendarString(exception.toDate) !== value.date)) targets.set(row.id, new Set([value.date]));
      }
      // Include meetings moved onto this date from another weekday.
      for (const item of await recurrence.occurrences(userId, value.date, value.date, tx)) {
        if (!item.series.classDetails || item.status === 'suppressed' || item.slot?.archivedAt) continue;
        if (!targets.has(item.seriesId)) targets.set(item.seriesId, new Set());
        targets.get(item.seriesId)!.add(item.originalDate);
      }
      for (const [id, dates] of targets) for (const date of dates) {
        const current = await recurrence.get(userId, id, tx);
        await recurrence.exception(userId, id, { date, kind: 'skip' }, current.version, tx, false); removed++;
      }
      await materializeOccurrences(userId, value.date, tx, value.date);
      const slotIds: string[] = [];
      for (const [index, row] of source.entries()) {
        const data = { date: value.date, startMin: row.startMin!, endMin: row.startMin! + row.estMinutes, layer: 'fixed' as const, title: row.title, profileId: row.profileId, skillId: row.skillId, goalId: row.goalId, taskId: null, pinned: false };
        await assertNoConflict(userId, data, tx);
        const slot = await tx.timeSlot.create({ data: { ...data, date: calendarDate(value.date), id: newId(), userId, applicationKey: hash([key, index]) } });
        slotIds.push(slot.id);
      }
      await tx.templateApplication.create({ data: { id: newId(), userId, key, anchor: calendarDate(value.date), snapshot: json({ operation: 'class-day', inputHash, slotIds, sourceSlots: slotIds.map((id, index) => ({ id, seriesId: source[index]!.id })), sourceSeriesIds: source.map(row => row.id), date: value.date, weekday: value.weekday, added: slotIds.length, removed }) } });
      await refreshReminders(userId, tx);
      return { date: value.date, weekday: value.weekday, added: slotIds.length, removed, reused: false };
    }, { timeout: 30000 });
  },
};
