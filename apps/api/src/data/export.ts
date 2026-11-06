import { Prisma } from '@prisma/client';
import { db } from '../db';
import { notFound, ownerWhere } from '../repository';
import { portable, type PortableExport } from './format';
export { portable, exportCsv, csvCell, type PortableExport } from './format';

const excludedModels = new Set(['Session', 'AuthLockout', 'SystemMeta']);
type Delegate = { findMany(options: { where: { userId: string }; orderBy?: { id: 'asc' } }): Promise<unknown[]> };
/** A repeatable-read snapshot includes every owner-scoped domain model, including archives. */
export async function exportOwner(userId: string): Promise<PortableExport> {
  ownerWhere(userId);
  return db.$transaction(async tx => {
    const account = notFound(await tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, timezone: true, dayRollover: true, settings: true, createdAt: true } }), 'account');
    const tables: Record<string, unknown[]> = {};
    for (const model of Prisma.dmmf.datamodel.models) {
      if (excludedModels.has(model.name) || !model.fields.some(field => field.name === 'userId' && field.kind === 'scalar')) continue;
      const delegate = (tx as unknown as Record<string, Delegate>)[model.name[0]!.toLowerCase() + model.name.slice(1)]!;
      const rows = await delegate.findMany({ where: ownerWhere(userId), ...(model.fields.some(field => field.name === 'id') ? { orderBy: { id: 'asc' as const } } : {}) });
      tables[model.dbName ?? model.name] = rows.map(portable);
    }
    return { format: 'kram-portable', formatVersion: 1, exportedAt: new Date().toISOString(), account: portable(account), tables };
  }, { isolationLevel: 'RepeatableRead', timeout: 120_000 });
}
