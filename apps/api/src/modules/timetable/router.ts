import { Router } from 'express';
import { z } from 'zod';
import { dateSchema, idSchema } from '@kram/shared';
import { iso } from '../../repository';
import { timetable, slotDto, slotEtag, expectedSlotVersion } from './service';
import { templates } from './templates';

export const timetableRouter = Router();
const owner = (res: { locals: Record<string, unknown> }) => String(res.locals.userId);
const rangeSchema = z.object({ from: dateSchema, to: dateSchema });
const bodySchema = z.record(z.string(), z.unknown());
timetableRouter.get('/timetable/day/:date', async (req, res) => {
  res.json(iso(await timetable.day(owner(res), dateSchema.parse(req.params.date))));
});
timetableRouter.get('/timetable/global', async (req, res) => {
  const { from, to } = rangeSchema.parse(req.query);
  res.json(iso(await timetable.global(owner(res), from, to)));
});
timetableRouter.get('/timetable/free/:date', async (req, res) => res.json(await timetable.free(owner(res), dateSchema.parse(req.params.date))));
timetableRouter.get('/timetable/slots/:id', async (req, res) => {
  const slot = await timetable.get(owner(res), idSchema.parse(req.params.id));
  res.setHeader('ETag', slotEtag(slot.version));
  res.json(iso(slotDto(slot)));
});
timetableRouter.post('/timetable/slots', async (req, res) => {
  const slot = await timetable.create(owner(res), req.body);
  res.setHeader('ETag', slotEtag(slot.version));
  res.status(201).json(iso(slot));
});
timetableRouter.patch('/timetable/slots/:id', async (req, res) => {
  const slot = await timetable.edit(owner(res), idSchema.parse(req.params.id), bodySchema.parse(req.body), expectedSlotVersion(req.get('If-Match')));
  res.setHeader('ETag', slotEtag(slot.version));
  res.json(iso(slot));
});
timetableRouter.delete('/timetable/slots/:id', async (req, res) => {
  const slot = await timetable.archive(owner(res), idSchema.parse(req.params.id), expectedSlotVersion(req.get('If-Match')));
  res.setHeader('ETag', slotEtag(slot.version));
  res.json(iso(slot));
});
timetableRouter.get('/timetable/templates', async (_req, res) => res.json(iso(await templates.list(owner(res)))));
timetableRouter.post('/timetable/templates', async (req, res) => res.status(201).json(iso(await templates.create(owner(res), req.body))));
timetableRouter.patch('/timetable/templates/:id', async (req, res) => res.json(iso(await templates.edit(owner(res), idSchema.parse(req.params.id), req.body, expectedSlotVersion(req.get('If-Match'))))));
timetableRouter.delete('/timetable/templates/:id', async (req, res) => res.json(iso(await templates.archive(owner(res), idSchema.parse(req.params.id), expectedSlotVersion(req.get('If-Match'))))));
timetableRouter.post('/timetable/templates/:id/apply', async (req, res) => { const { anchor } = z.object({ anchor: dateSchema }).parse(req.body); res.json(iso(await templates.apply(owner(res), idSchema.parse(req.params.id), anchor, expectedSlotVersion(req.get('If-Match'))))); });
timetableRouter.post('/timetable/copy', async (req, res) => res.json(iso(await templates.copy(owner(res), req.body))));
