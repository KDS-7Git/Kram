import { Router } from 'express';
import { z } from 'zod';
import { idSchema, undoCompletionReference, TaskEventError } from '@kram/shared';
import { ApiError } from '../../errors';
import { db } from '../../db';
import { iso, ownerWhere } from '../../repository';
import { paginate } from '../../pagination';
import { goals } from '../goals/service';
import { tasks, taskDto, eventDto } from './service';
import { todaySummary } from './today';

export const tasksRouter = Router();
const owner = (res: { locals: Record<string, unknown> }) => String(res.locals.userId);
const bodySchema = z.record(z.string(), z.unknown());
tasksRouter.get('/today', async (_req, res) => res.json(iso(await todaySummary(owner(res)))));
tasksRouter.get('/tasks/today', async (_req, res) => res.json(iso((await todaySummary(owner(res))).tasks)));
tasksRouter.get('/tasks', async (req, res) => {
  const { now, today } = await tasks.context(owner(res));
  const goalId = req.query.goalId ? idSchema.parse(req.query.goalId) : undefined;
  if (goalId) await goals.get(owner(res), goalId);
  const rows = await tasks.list(owner(res), req.query.archived === 'true');
  res.json(iso(paginate(rows.filter((row) => !goalId || row.goalId === goalId).map((row) => taskDto(row, now, today)), req.query, res)));
});
tasksRouter.post('/tasks', async (req, res) => {
  const created = await tasks.create(owner(res), req.body);
  const { now, today } = await tasks.context(owner(res));
  res.status(201).json(iso(taskDto(await tasks.get(owner(res), created.id), now, today)));
});
tasksRouter.get('/tasks/:id', async (req, res) => {
  const row = await tasks.get(owner(res), idSchema.parse(req.params.id));
  const { now, today } = await tasks.context(owner(res));
  res.json(iso(taskDto(row, now, today)));
});
tasksRouter.patch('/tasks/:id', async (req, res) => {
  const row = await tasks.edit(owner(res), idSchema.parse(req.params.id), bodySchema.parse(req.body));
  const { now, today } = await tasks.context(owner(res));
  res.json(iso(taskDto(row, now, today)));
});
tasksRouter.get('/tasks/:id/events', async (req, res) => {
  const rows = await tasks.history(owner(res), idSchema.parse(req.params.id));
  res.json(iso(paginate(rows, req.query, res)));
});
tasksRouter.post('/tasks/:id/events', async (req, res) => {
  const body = bodySchema.parse(req.body);
  const key = req.get('Idempotency-Key');
  if (key && key !== body.clientEventId) throw new ApiError('IDEMPOTENCY_KEY_MISMATCH', 'Send the same client event identifier in the body and Idempotency-Key header.', 400);
  res.json(iso(await tasks.event(owner(res), idSchema.parse(req.params.id), body)));
});
tasksRouter.post('/tasks/:id/undo', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const value = z.object({ clientEventId: idSchema, explicitCorrection: z.boolean().default(false) }).parse(req.body);
  await tasks.get(owner(res), id);
  const previous = await db.progressEvent.findFirst({ where: { clientEventId: value.clientEventId, ...ownerWhere(owner(res)) } });
  if (previous && (previous.taskId !== id || previous.kind !== 'correction')) throw new ApiError('CLIENT_EVENT_CONFLICT', 'This event identifier was already used for another task decision.', 409);
  const { now } = await tasks.context(owner(res));
  try {
    const referenceEventId = previous?.referenceEventId ?? undoCompletionReference(await tasks.history(owner(res), id), { now, explicitCorrection: value.explicitCorrection });
    res.json(iso(await tasks.event(owner(res), id, { clientEventId: value.clientEventId, kind: 'correction', occurredAt: previous?.occurredAt.toISOString() ?? now, referenceEventId, explicitCorrection: value.explicitCorrection, note: 'Undo completion' })));
  } catch (error) {
    if (error instanceof TaskEventError) throw new ApiError(error.code, error.message, 409);
    throw error;
  }
});
tasksRouter.get('/goals/:id/events', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  await goals.get(owner(res), id);
  const rows = await db.progressEvent.findMany({ where: { goalId: id, ...ownerWhere(owner(res)) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  res.json(iso(paginate(rows.map(eventDto), req.query, res)));
});
