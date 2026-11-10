import { collegeSlotTemplateSchema } from '@kram/shared';
import { db } from '../../db';
import { ApiError } from '../../errors';
import { json, lockOwner } from '../../repository';

export const collegeSlots = {
  async list(userId: string) {
    return (await db.collegeSlotTemplate.findMany({ where: { userId }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] })).map(row => collegeSlotTemplateSchema.parse(row));
  },
  async save(userId: string, input: unknown) {
    const value = collegeSlotTemplateSchema.parse(input);
    return db.$transaction(async tx => {
      await lockOwner(tx, userId);
      const current = await tx.collegeSlotTemplate.findUnique({ where: { id: value.id } });
      if (current && current.userId !== userId || !current && value.version) throw new ApiError('NOT_FOUND', 'Slot grid not found.', 404);
      if (current) {
        // Retrying an unchanged save is safe, including a lost creation response.
        if (current.name === value.name && JSON.stringify(collegeSlotTemplateSchema.parse(current).periods) === JSON.stringify(value.periods)) return collegeSlotTemplateSchema.parse(current);
        if (current.version !== value.version) throw new ApiError('VERSION_CONFLICT', 'This slot grid changed. Reload it before saving.', 412);
        return collegeSlotTemplateSchema.parse(await tx.collegeSlotTemplate.update({ where: { id: current.id }, data: { name: value.name, periods: json(value.periods), version: { increment: 1 } } }));
      }
      return collegeSlotTemplateSchema.parse(await tx.collegeSlotTemplate.create({ data: { id: value.id, userId, name: value.name, periods: json(value.periods) } }));
    });
  },
};
