import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dateSchema, scheduleTemplateSchema, slotSchema } from '@kram/shared';
import { applyTemplate } from '@kram/timetable';
import { addDays } from '@kram/time';
import { db } from '../../db';
import { ApiError } from '../../errors';
import { calendarDate } from '../../calendar';
import { json, lockOwner, newId, notFound, ownerWhere, type Connection } from '../../repository';
import { refreshReminders } from '../notifications/service';
import { associations, assertNoConflict, slotDto } from './service';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function validateEntries(userId: string, value: ReturnType<typeof scheduleTemplateSchema.parse>, c: Connection) {
  const entries = [];
  for (const entry of value.entries) entries.push({ ...entry, ...await associations(userId, slotSchema.parse({ ...entry, date: '2026-01-05', taskId: null }), c) });
  try { applyTemplate({ id: 'validation', kind: value.kind, entries }, '2026-01-05'); } catch (error) { throw new ApiError('TEMPLATE_CONFLICT', error instanceof Error ? error.message : 'Resolve template conflicts.', 409); }
  return entries.map(({ date: _date, taskId: _task, ...entry }) => entry);
}
export const templates = {
  list(userId: string) { return db.scheduleTemplate.findMany({ where: { ...ownerWhere(userId), archivedAt: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }); },
  async get(userId: string, id: string, c: Connection = db) { return notFound(await c.scheduleTemplate.findFirst({ where: { id, ...ownerWhere(userId) } }), 'template'); },
  async create(userId: string, input: unknown) {
    const value = scheduleTemplateSchema.parse(input);
    return db.$transaction(async tx => { await lockOwner(tx, userId); const entries = await validateEntries(userId, value, tx); return tx.scheduleTemplate.create({ data: { id: newId(), userId, ...value, entries: json(entries) } }); });
  },
  async edit(userId: string, id: string, input: unknown, version: number) {
    const value = scheduleTemplateSchema.parse(input);
    return db.$transaction(async tx => { await lockOwner(tx, userId); const old = await this.get(userId, id, tx); if (old.version !== version) throw new ApiError('VERSION_CONFLICT', 'Reload this template before editing.', 412); if (old.archivedAt) throw new ApiError('TEMPLATE_ARCHIVED', 'Create a new template.', 409);
      const entries = await validateEntries(userId, value, tx); return tx.scheduleTemplate.update({ where: { id }, data: { ...value, entries: json(entries), version: { increment: 1 } } }); });
  },
  async apply(userId: string, id: string, anchor: string, version: number) {
    dateSchema.parse(anchor);
    return db.$transaction(async tx => {
      await lockOwner(tx, userId); const row = await this.get(userId, id, tx);
      if (row.archivedAt) throw new ApiError('TEMPLATE_ARCHIVED', 'Choose an active template.', 409);
      const key = hash([userId, id, anchor]);
      const applied = await tx.templateApplication.findUnique({ where: { key } });
      if (applied) return { reused: true, application: applied };
      if (row.version !== version) throw new ApiError('VERSION_CONFLICT', 'Reload this template before applying.', 412);
      const value = scheduleTemplateSchema.parse(row);
      const slots = applyTemplate({ id, kind: value.kind, entries: value.entries }, anchor);
      for (const [index, slot] of slots.entries()) {
        const data = await associations(userId, slotSchema.parse(slot), tx); await assertNoConflict(userId, data, tx);
        await tx.timeSlot.create({ data: { ...data, id: newId(), userId, date: calendarDate(data.date), templateId: id, applicationKey: hash([key, index]) } });
      }
      const application = await tx.templateApplication.create({ data: { id: newId(), userId, templateId: id, key, anchor: calendarDate(anchor), snapshot: json({ template: row, slots }) } });
      await refreshReminders(userId, tx); return { reused: false, application };
    });
  },
  async copy(userId: string, input: unknown) {
    const { source, target, days, requestId } = z.object({ source: dateSchema, target: dateSchema, days: z.union([z.literal(1), z.literal(7)]), requestId: z.uuid() }).parse(input);
    return db.$transaction(async tx => {
      await lockOwner(tx, userId); const key = hash([userId, 'copy', requestId]);
      const previous = await tx.templateApplication.findUnique({ where: { key } });
      if (previous) { const snapshot = previous.snapshot as { source?: string; target?: string; days?: number }; if (snapshot.source !== source || snapshot.target !== target || snapshot.days !== days) throw new ApiError('COPY_CONFLICT', 'Use a new request for different copy dates.', 409); return { reused: true, application: previous }; }
      const original = await tx.timeSlot.findMany({ where: { userId, archivedAt: null, date: { gte: calendarDate(source), lte: calendarDate(addDays(source, days - 1)) } }, orderBy: [{ date: 'asc' }, { startMin: 'asc' }, { id: 'asc' }] });
      for (const [index, slot] of original.entries()) {
        const day = Math.round((slot.date.getTime() - calendarDate(source).getTime()) / 86400000);
        const data = await associations(userId, slotSchema.parse({ ...slotDto(slot), date: addDays(target, day), taskId: null }), tx); await assertNoConflict(userId, data, tx);
        await tx.timeSlot.create({ data: { ...data, id: newId(), userId, date: calendarDate(data.date), applicationKey: hash([key, index]) } });
      }
      const application = await tx.templateApplication.create({ data: { id: newId(), userId, key, anchor: calendarDate(target), snapshot: json({ source, target, days, slots: original.map(slotDto) }) } });
      await refreshReminders(userId, tx); return { reused: false, application, count: original.length };
    });
  },
  async archive(userId: string, id: string, version: number) {
    return db.$transaction(async tx => { await lockOwner(tx, userId); const row = await this.get(userId, id, tx); if (row.version !== version) throw new ApiError('VERSION_CONFLICT', 'Reload this template before archiving.', 412); return tx.scheduleTemplate.update({ where: { id }, data: { archivedAt: row.archivedAt ?? new Date(), version: { increment: 1 } } }); });
  },
};
