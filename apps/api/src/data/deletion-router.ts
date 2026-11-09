import { Router } from 'express';
import { deletionKindSchema, idSchema } from '@kram/shared';
import { deletion } from './deletion';

export const deletionRouter = Router();
const owner = (res: { locals: Record<string, unknown> }) => String(res.locals.userId);
deletionRouter.get('/deletions/:kind/:id', async (req, res) => res.json(await deletion.preview(owner(res), deletionKindSchema.parse(req.params.kind), idSchema.parse(req.params.id))));
deletionRouter.delete('/deletions/:kind/:id', async (req, res) => res.json(await deletion.remove(owner(res), deletionKindSchema.parse(req.params.kind), idSchema.parse(req.params.id), req.body)));
