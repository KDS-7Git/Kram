import { Router } from 'express';
import { z } from 'zod';
import { dateSchema, idSchema } from '@kram/shared';
import { iso } from '../../repository';
import { recurrence, holidays, seriesDto } from './service';
import { expectedSlotVersion } from '../timetable/service';

export const recurrenceRouter = Router();
const owner = (res: { locals: Record<string, unknown> }) => String(res.locals.userId);
recurrenceRouter.get('/recurrence/series', async (_req, res) => res.json(iso(await recurrence.list(owner(res)))));
recurrenceRouter.post('/recurrence/series', async (req, res) => { const row = await recurrence.create(owner(res), req.body); res.setHeader('ETag', `"${row.version}"`); res.status(201).json(iso(row)); });
recurrenceRouter.get('/recurrence/series/:id', async (req, res) => { const row = await recurrence.get(owner(res), idSchema.parse(req.params.id)); res.setHeader('ETag', `"${row.version}"`); res.json(iso(seriesDto(row))); });
recurrenceRouter.post('/recurrence/series/:id/exceptions', async (req, res) => { const row = await recurrence.exception(owner(res), idSchema.parse(req.params.id), req.body, expectedSlotVersion(req.get('If-Match'))); res.json(iso(row)); });
recurrenceRouter.post('/recurrence/series/:id/future', async (req, res) => { const input = z.object({ from: dateSchema, changes: z.record(z.string(), z.unknown()) }).parse(req.body); res.json(iso(await recurrence.split(owner(res), idSchema.parse(req.params.id), input.from, input.changes, expectedSlotVersion(req.get('If-Match'))))); });
for (const action of ['pause', 'resume'] as const) recurrenceRouter.post(`/recurrence/series/:id/${action}`, async (req, res) => { const { date } = z.object({ date: dateSchema }).parse(req.body); res.json(iso(await recurrence.pause(owner(res), idSchema.parse(req.params.id), date, action === 'resume', expectedSlotVersion(req.get('If-Match'))))); });
recurrenceRouter.get('/recurrence/occurrences', async (req, res) => { const { from, to } = z.object({ from: dateSchema, to: dateSchema }).parse(req.query); res.json(iso(await recurrence.occurrences(owner(res), from, to))); });
recurrenceRouter.get('/holidays', async (_req, res) => res.json(iso(await holidays.list(owner(res)))));
recurrenceRouter.post('/holidays', async (req, res) => res.status(201).json(iso(await holidays.create(owner(res), req.body))));
recurrenceRouter.delete('/holidays/:id', async (req, res) => res.json(await holidays.remove(owner(res), idSchema.parse(req.params.id))));
