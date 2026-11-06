import { Router } from 'express';
import { z } from 'zod';
import { idSchema } from '@kram/shared';
import { exportOwner, exportCsv } from './export';
import { recoveryHealth } from './health';
import { loadDemo, removeDemo } from './demo';
import { requestBackup } from './backup';

export const dataRouter = Router();
dataRouter.post('/demo/load', async (_req, res) => res.json(await loadDemo(String(res.locals.userId))));
dataRouter.post('/demo/remove', async (_req, res) => res.json(await removeDemo(String(res.locals.userId))));
dataRouter.post('/backup/run', async (req, res) => {
  const { clientEventId } = z.object({ clientEventId: idSchema }).parse(req.body);
  res.status(202).json(await requestBackup(String(res.locals.userId), clientEventId));
});
dataRouter.post('/export', async (req, res) => {
  const { format } = z.object({ format: z.enum(['json', 'csv']).default('json') }).parse(req.body ?? {});
  const snapshot = await exportOwner(String(res.locals.userId));
  const filename = `kram-export-${snapshot.exportedAt.slice(0, 10)}.${format}`;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (format === 'csv') res.type('text/csv').send(exportCsv(snapshot));
  else res.json(snapshot);
});
dataRouter.get('/data/health', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await recoveryHealth(String(res.locals.userId)));
});
