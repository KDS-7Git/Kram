import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { DateTime } from 'luxon';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import request, { type Agent } from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { v7 as uuid } from 'uuid';
import { defaultSettings, type CollegeSlotTemplate, type ClassTimetableInput, type RecurrenceSeries } from '@kram/shared';
import { addDays, weekday } from '@kram/time';

let container: StartedTestContainer, db: PrismaClient, app: Express, agent: Agent;
let csrf = '', userId = '', skillId = '', today = '';
let resetLimiter: () => Promise<void>;
const origin = 'http://localhost:8420', date = (value: string) => new Date(`${value}T00:00:00Z`);
const post = (path: string, body: object) => agent.post(`/api/v1${path}`).set('Origin', origin).set('X-CSRF-Token', csrf).send(body);
const erase = (kind: string, id: string, token: string) => agent.delete(`/api/v1/deletions/${kind}/${id}`).set('Origin', origin).set('X-CSRF-Token', csrf).send({ token });
const preview = async (kind: string, id: string) => (await agent.get(`/api/v1/deletions/${kind}/${id}`).expect(200)).body;
const meeting = (course: string, weekdays: number[], startMin: number, estMinutes = 50, type: 'lecture' | 'lab' = 'lecture') => ({ course, weekdays, startMin, estMinutes, type, slot: type === 'lab' ? 'L2' : 'A1' });
const sheet = (rows: ClassTimetableInput['rows'], patch: Partial<ClassTimetableInput> = {}): ClassTimetableInput => ({ requestId: uuid(), startDate: today, endDate: addDays(today, 40), effectiveFrom: today, rows, removed: [], ...patch });
const asRows = (rows: RecurrenceSeries[]): ClassTimetableInput['rows'] => rows.map(row => ({ id: row.id, version: row.version, course: row.title, type: row.classDetails!.type, slot: row.classDetails!.slot, assignment: row.classDetails!.assignment, weekdays: row.rrule.split('BYDAY=')[1]!.split(',').map(code => ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].indexOf(code) + 1), startMin: row.startMin!, estMinutes: row.estMinutes }));
const nextDay = (day: number) => addDays(today, (day - weekday(today) + 7) % 7);
async function goal(title = 'Synthetic practice') {
  const result = await post('/goals', { skillId, type: 'recurring', title, targetQty: 30, startDate: today, rrule: 'FREQ=DAILY' }).expect(201);
  const task = await db.task.findFirstOrThrow({ where: { goalId: result.body.id }, orderBy: { earliestDate: 'asc' } });
  return { id: result.body.id as string, task };
}
async function progress(taskId: string, minutes = 10) {
  return (await post(`/tasks/${taskId}/events`, { clientEventId: uuid(), kind: 'progress', minutes, occurredAt: DateTime.utc().toISO() }).expect(200)).body.event;
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-bookworm').withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'classes-disposable-only', POSTGRES_DB: 'kram_classes_test' }).withExposedPorts(5432)
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram_classes_test'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 }).withWaitStrategy(Wait.forHealthCheck()).start();
  Object.assign(process.env, { DATABASE_URL: `postgresql://kram:classes-disposable-only@${container.getHost()}:${container.getMappedPort(5432)}/kram_classes_test`, DATABASE_URL_FILE: '', DOTENV_CONFIG_PATH: devNull,
    NODE_ENV: 'test', APP_URL: origin, COOKIE_SECURE: 'false', SESSION_SECRET: 'classes-isolated-session-key-at-least-32', SESSION_SECRET_FILE: '', ENCRYPTION_KEY: '77'.repeat(32), ENCRYPTION_KEY_FILE: '', OWNER_SETUP_TOKEN: '', OWNER_SETUP_TOKEN_FILE: '', LOG_LEVEL: 'silent', NTFY_BASE_URL: '', NTFY_TOPIC: '', NTFY_TOKEN: '', NTFY_TOKEN_FILE: '' });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: process.env, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db')); app = (await import('../../apps/api/src/app')).createApp();
  ({ resetAuthLimiterForTests: resetLimiter } = await import('../../apps/api/src/modules/auth/router'));
}, 120000);
beforeEach(async () => {
  const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map(row => `"${row.tablename.replaceAll('"', '""')}"`).join(',')} CASCADE`);
  await resetLimiter(); agent = request.agent(app);
  csrf = (await agent.get('/api/v1/auth/me')).body.csrfToken;
  const setup = await post('/auth/setup', { email: 'classes-owner@kram.test', password: 'synthetic-classes-owner-password-42' }).expect(201);
  userId = setup.body.user.id; csrf = setup.body.csrfToken;
  const profileId = (await post('/profiles', { name: 'Learning fixture' }).expect(201)).body.id;
  skillId = (await post('/skills', { profileId, name: 'College fixture' }).expect(201)).body.id;
  today = (await agent.get('/api/v1/bootstrap').expect(200)).body.studyDate;
});
afterAll(async () => { await app?.locals.closeSessions?.(); await db?.$disconnect(); await container?.stop(); });

describe('semester class sheets', () => {
  it('saves variable weekday times and lab durations, repeats the semester, and retries without duplicates', async () => {
    const input = sheet([meeting('Networks', [1, 3], 480), meeting('Networks', [4], 660), meeting('Networks', [5], 840, 150, 'lab')]);
    const result = (await post('/recurrence/classes', input).expect(200)).body;
    expect(result.rows.map((row: RecurrenceSeries) => [row.rrule, row.estMinutes, row.classDetails])).toEqual([
      ['FREQ=WEEKLY;BYDAY=MO,WE', 50, { type: 'lecture', slot: 'A1' }],
      ['FREQ=WEEKLY;BYDAY=TH', 50, { type: 'lecture', slot: 'A1' }],
      ['FREQ=WEEKLY;BYDAY=FR', 150, { type: 'lab', slot: 'L2' }],
    ]);
    const retry = (await post('/recurrence/classes', input).expect(200)).body;
    expect(retry.reused).toBe(true); expect(retry.rows.map((row: RecurrenceSeries) => row.id)).toEqual(result.rows.map((row: RecurrenceSeries) => row.id));
    expect(await db.recurrenceSeries.count()).toBe(3);
    const future = addDays(today, 28);
    const projected = (await agent.get(`/api/v1/timetable/global?from=${future}&to=${addDays(future, 6)}`).expect(200)).body;
    expect(projected).toHaveLength(4); expect(projected.some((slot: { endMin: number; startMin: number }) => slot.endMin - slot.startMin === 150)).toBe(true);
    const noOp = (await post('/recurrence/classes', sheet(asRows(result.rows))).expect(200)).body;
    expect(noOp.rows.map((row: RecurrenceSeries) => [row.id, row.version])).toEqual(result.rows.map((row: RecurrenceSeries) => [row.id, row.version]));
    await post('/recurrence/classes', { ...input, endDate: addDays(input.endDate, 1) }).expect(409);
  });
  it('rejects overlapping rows before creating anything, including a far-future semester', async () => {
    const result = await post('/recurrence/classes', sheet([meeting('A', [1], 480), meeting('B', [1], 500, 120, 'lab')], { startDate: addDays(today, 90), endDate: addDays(today, 140) })).expect(409);
    expect(result.body.error.code).toBe('CLASS_CONFLICT');
    expect(await db.recurrenceSeries.count()).toBe(0); expect(await db.templateApplication.count()).toBe(0);
  });
  it('rejects foreign identities and stale versions atomically', async () => {
    const foreign = await db.user.create({ data: { id: uuid(), email: 'foreign-classes@kram.test', passwordHash: 'fixture-only', settings: defaultSettings, isOwner: false } });
    const row = await db.recurrenceSeries.create({ data: { id: uuid(), userId: foreign.id, title: 'Private foreign meeting', dtstartLocal: date(today), effectiveFrom: date(today), rrule: 'FREQ=WEEKLY;BYDAY=MO', tz: 'Asia/Kolkata', startMin: 480 } });
    await post('/recurrence/classes', sheet([meeting('New meeting', [2], 600), { ...meeting('Foreign', [1], 480), id: row.id, version: row.version }])).expect(404);
    expect(await db.recurrenceSeries.count({ where: { userId } })).toBe(0);
    const own = (await post('/recurrence/classes', sheet([meeting('Own', [1], 480)])).expect(200)).body.rows as RecurrenceSeries[];
    await post('/recurrence/classes', sheet([{ ...asRows(own)[0]!, version: own[0]!.version + 1 }])).expect(412);
    expect(await db.recurrenceSeries.count({ where: { userId } })).toBe(1);
  });
  it('exchanges meeting times in one save while retaining prior occurrences and IDs', async () => {
    const result = (await post('/recurrence/classes', sheet([meeting('First course', [weekday(today)], 540), meeting('Second course', [weekday(today)], 600)])).expect(200)).body;
    const old = await db.timeSlot.findMany({ where: { userId, date: date(today) }, orderBy: { startMin: 'asc' } });
    const from = addDays(today, 7);
    const changed = (await post('/recurrence/classes', sheet(asRows(result.rows).map((row, index) => ({ ...row, startMin: index ? 540 : 600 })), { effectiveFrom: from })).expect(200)).body;
    expect(changed.rows.every((row: RecurrenceSeries) => !result.rows.some((prior: RecurrenceSeries) => prior.id === row.id))).toBe(true);
    expect(await db.timeSlot.findMany({ where: { id: { in: old.map(row => row.id) } }, orderBy: { startMin: 'asc' } })).toEqual(old);
    const future = await db.timeSlot.findMany({ where: { userId, date: date(from), archivedAt: null }, orderBy: { startMin: 'asc' } });
    expect(future.map(row => [row.title, row.startMin])).toEqual([['Second course', 540], ['First course', 600]]);
  });
  it('stops removed weekly rows only from the change date, and rolls back collisions with personal blocks', async () => {
    const result = (await post('/recurrence/classes', sheet([meeting('History stays', [weekday(today)], 480)])).expect(200)).body;
    const from = addDays(today, 7), before = await db.timeSlot.findFirstOrThrow({ where: { date: date(today) } });
    await post('/recurrence/classes', sheet([], { effectiveFrom: from, removed: [{ id: result.rows[0].id, version: result.rows[0].version }] })).expect(200);
    expect(await db.timeSlot.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ archivedAt: null });
    expect(await db.timeSlot.count({ where: { date: date(from), archivedAt: null } })).toBe(0);
    await post('/timetable/slots', { date: nextDay(2), title: 'Personal appointment', startMin: 600, endMin: 630, layer: 'fixed' }).expect(201);
    const count = await db.recurrenceSeries.count();
    await post('/recurrence/classes', sheet([meeting('Would overlap', [2], 610)])).expect(409);
    expect(await db.recurrenceSeries.count()).toBe(count);
  });
});

describe('semester slot grids and course assignments', () => {
  const definitions = () => [1, 2, 3, 4].map((n, index) => ({ id: uuid(), group: 'Q', label: `Q${n}`, weekday: index + 1, startMin: 540 + index * 60, estMinutes: 50, type: 'lecture' as const, optional: n === 4 }));
  it('saves editable semester definitions with ownership, versioning, retries and portable export', async () => {
    const input = { id: uuid(), name: 'Semester one', periods: definitions() };
    const saved = (await post('/recurrence/college-slots', input).expect(200)).body as CollegeSlotTemplate;
    expect((await post('/recurrence/college-slots', input).expect(200)).body).toEqual(saved);
    expect((await agent.get('/api/v1/recurrence/college-slots').expect(200)).body).toEqual([saved]);
    const changed = (await post('/recurrence/college-slots', { ...saved, periods: saved.periods.map(row => ({ ...row, startMin: row.startMin + 10 })) }).expect(200)).body;
    expect(changed.version).toBe(2);
    await post('/recurrence/college-slots', { ...saved, name: 'Stale edit' }).expect(412);
    const nextSemester = { id: uuid(), name: 'Semester two', periods: definitions().map(row => ({ ...row, weekday: 6, startMin: row.startMin + 20 })) };
    await post('/recurrence/college-slots', nextSemester).expect(200);
    expect(await db.collegeSlotTemplate.count({ where: { userId } })).toBe(2);
    const { exportOwner } = await import('../../apps/api/src/data/export');
    expect((await exportOwner(userId)).tables.college_slot_template).toHaveLength(2);
    const foreign = await db.user.create({ data: { id: uuid(), email: 'foreign-grid@kram.test', passwordHash: 'fixture-only', settings: defaultSettings, isOwner: false } });
    const hidden = await db.collegeSlotTemplate.create({ data: { id: uuid(), userId: foreign.id, name: 'Foreign grid', periods: definitions() } });
    await post('/recurrence/college-slots', { ...input, id: hidden.id, version: 1 }).expect(404);
    expect((await agent.get('/api/v1/recurrence/college-slots').expect(200)).body).toHaveLength(2);
    await post('/recurrence/classes', sheet([{ ...meeting('Private grid', [1], 480), assignment: { id: uuid(), templateId: hidden.id, group: 'Q', meetingId: uuid() } }])).expect(404);
    await post('/recurrence/college-slots', { ...input, id: uuid(), periods: [{ ...input.periods[0], startMin: 1430 }] }).expect(400);
  });
  it('retains course grouping, fewer weekly meetings, FS moves and history across future changes', async () => {
    const template = (await post('/recurrence/college-slots', { id: uuid(), name: 'Flexible semester', periods: definitions() }).expect(200)).body as CollegeSlotTemplate;
    const assignmentId = uuid();
    const input = sheet(template.periods.filter(row => !row.optional).map(row => ({ course: 'Networks · CS313', type: row.type, slot: row.label, weekdays: [row.weekday], startMin: row.startMin, estMinutes: row.estMinutes, assignment: { id: assignmentId, templateId: template.id, group: row.group, meetingId: row.id } })));
    const saved = (await post('/recurrence/classes', input).expect(200)).body.rows as RecurrenceSeries[];
    expect(saved).toHaveLength(3);
    expect(saved.every(row => row.classDetails?.assignment?.id === assignmentId)).toBe(true);
    const noop = (await post('/recurrence/classes', sheet(asRows(saved))).expect(200)).body.rows as RecurrenceSeries[];
    expect(noop.map(row => [row.id, row.version])).toEqual(saved.map(row => [row.id, row.version]));
    await post('/recurrence/college-slots', { ...template, periods: template.periods.map(row => ({ ...row, startMin: row.startMin + 5 })) }).expect(200);
    expect((await agent.get('/api/v1/recurrence/series').expect(200)).body.map((row: RecurrenceSeries) => row.startMin).sort()).toEqual(saved.map(row => row.startMin).sort());
    const from = addDays(today, 7), before = await db.timeSlot.findMany({ where: { userId, date: { lt: date(from) } }, orderBy: { id: 'asc' } });
    const fewer = asRows(saved).slice(0, 2); fewer[1] = { ...fewer[1]!, slot: 'FS', weekdays: [5], startMin: 1020 };
    const changed = (await post('/recurrence/classes', sheet(fewer, { effectiveFrom: from, removed: [{ id: saved[2]!.id, version: saved[2]!.version }] })).expect(200)).body.rows as RecurrenceSeries[];
    expect(changed).toHaveLength(2);
    expect(changed.find(row => row.classDetails?.slot === 'FS')).toMatchObject({ rrule: 'FREQ=WEEKLY;BYDAY=FR', startMin: 1020, classDetails: { assignment: { id: assignmentId, group: 'Q' } } });
    expect(await db.timeSlot.findMany({ where: { userId, date: { lt: date(from) } }, orderBy: { id: 'asc' } })).toEqual(before);
    const projected = (await agent.get(`/api/v1/timetable/global?from=${from}&to=${addDays(from, 6)}`).expect(200)).body;
    expect(projected).toHaveLength(2);
    const fs = changed.find(row => row.classDetails?.slot === 'FS')!, friday = addDays(from, (5 - weekday(from) + 7) % 7);
    await post(`/recurrence/series/${fs.id}/exceptions`, { date: friday, kind: 'move', toDate: addDays(friday, 1), toStartMin: 960 }).set('If-Match', `"${fs.version}"`).expect(200);
    expect(await db.timeSlot.count({ where: { userId, date: date(addDays(friday, 1)), archivedAt: null, startMin: 960 } })).toBe(1);
    expect(await db.timeSlot.count({ where: { userId, date: date(addDays(friday, 7)), archivedAt: null, startMin: 1020 } })).toBe(1);
    const other = (await post('/recurrence/college-slots', { id: uuid(), name: 'Next semester', periods: [{ ...definitions()[0]!, weekday: 7, startMin: 900 }] }).expect(200)).body;
    expect(other.id).not.toBe(template.id);
    expect((await agent.get(`/api/v1/recurrence/series/${fs.id}`).expect(200)).body.classDetails.assignment.templateId).toBe(template.id);
  });
});

describe('college makeup days', () => {
  const rows = () => [meeting('Monday theory', [1], 480), meeting('Monday lab', [1], 600, 150, 'lab'), meeting('Tuesday theory', [2], 720), meeting('Saturday class', [6], 960)];
  it('replaces only classes and labs on one date, preserves appointments, and supports retries and a second replacement', async () => {
    await post('/recurrence/classes', sheet(rows())).expect(200);
    const target = nextDay(6);
    const appointment = (await post('/timetable/slots', { date: target, title: 'Personal appointment', startMin: 840, endMin: 870, layer: 'fixed' }).expect(201)).body;
    expect((await agent.get(`/api/v1/recurrence/classes/day?date=${target}`).expect(200)).body).toEqual({ weekday: null, meetings: [] });
    const input = { requestId: uuid(), date: target, weekday: 1 };
    const result = (await post('/recurrence/classes/day', input).expect(200)).body;
    expect(result).toMatchObject({ added: 2, removed: 1, reused: false });
    expect((await post('/recurrence/classes/day', input).expect(200)).body.reused).toBe(true);
    expect((await db.timeSlot.findMany({ where: { date: date(target), archivedAt: null }, orderBy: { startMin: 'asc' } })).map(row => row.title)).toEqual(['Monday theory', 'Monday lab', 'Personal appointment']);
    const firstPreview = (await agent.get(`/api/v1/recurrence/classes/day?date=${target}`).expect(200)).body;
    expect(firstPreview.weekday).toBe(1);
    expect(firstPreview.meetings.map((row: { title: string; startMin: number; endMin: number }) => [row.title, row.startMin, row.endMin])).toEqual([['Monday theory', 480, 530], ['Monday lab', 600, 750]]);
    expect(await db.timeSlot.findUniqueOrThrow({ where: { id: appointment.id } })).toMatchObject({ archivedAt: null });
    await post('/recurrence/classes/day', { requestId: uuid(), date: target, weekday: 2 }).expect(200);
    expect((await db.timeSlot.findMany({ where: { date: date(target), archivedAt: null }, orderBy: { startMin: 'asc' } })).map(row => row.title)).toEqual(['Tuesday theory', 'Personal appointment']);
    const secondPreview = (await agent.get(`/api/v1/recurrence/classes/day?date=${target}`).expect(200)).body;
    expect(secondPreview.weekday).toBe(2);
    expect(secondPreview.meetings.map((row: { title: string }) => row.title)).toEqual(['Tuesday theory']);
    expect(await db.timeSlot.count({ where: { date: date(addDays(target, 7)), title: 'Saturday class', archivedAt: null } })).toBe(1);
  });
  it('rolls back skipped classes as well as additions if a makeup meeting conflicts', async () => {
    await post('/recurrence/classes', sheet(rows())).expect(200);
    const target = nextDay(6);
    await post('/timetable/slots', { date: target, title: 'Personal collision', startMin: 490, endMin: 510, layer: 'fixed' }).expect(201);
    const before = await db.recurrenceSeries.findMany({ orderBy: { id: 'asc' } });
    await post('/recurrence/classes/day', { requestId: uuid(), date: target, weekday: 1 }).expect(409);
    expect(await db.recurrenceException.count()).toBe(0);
    expect(await db.recurrenceSeries.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await db.timeSlot.count({ where: { title: 'Saturday class', date: date(target), archivedAt: null } })).toBe(1);
    expect(await db.timeSlot.count({ where: { title: 'Monday theory', date: date(target), archivedAt: null } })).toBe(0);
  });
});

describe('confirmed permanent deletion', () => {
  it('deletes an archived template and its receipts while preserving applied blocks as independent placements', async () => {
    const template = (await post('/timetable/templates', { name: 'Disposable weekly blocks', kind: 'day', entries: [{ weekday: weekday(today), title: 'Applied lecture', startMin: 480, endMin: 530, layer: 'fixed' }] }).expect(201)).body;
    await post(`/timetable/templates/${template.id}/apply`, { anchor: today }).set('If-Match', `"${template.version}"`).expect(200);
    const applied = await db.timeSlot.findFirstOrThrow({ where: { userId, templateId: template.id } });
    await agent.delete(`/api/v1/timetable/templates/${template.id}`).set('Origin', origin).set('X-CSRF-Token', csrf).set('If-Match', `"${template.version}"`).expect(200);
    expect((await agent.get('/api/v1/timetable/templates').expect(200)).body).toEqual([]);
    const archived = (await agent.get('/api/v1/timetable/templates?archived=true').expect(200)).body;
    expect(archived.map((row: { id: string }) => row.id)).toEqual([template.id]);
    expect(archived[0].archivedAt).toBeTruthy();
    const reviewed = await preview('template', template.id);
    expect(reviewed.counts).toEqual([{ label: 'Template application records', count: 1 }, { label: 'Templates', count: 1 }]);
    await erase('template', template.id, reviewed.token).expect(200);
    await erase('template', template.id, reviewed.token).expect(200);
    expect(await db.scheduleTemplate.findUnique({ where: { id: template.id } })).toBeNull();
    expect(await db.templateApplication.count({ where: { templateId: template.id } })).toBe(0);
    expect(await db.timeSlot.findUniqueOrThrow({ where: { id: applied.id } })).toMatchObject({ id: applied.id, date: applied.date, title: applied.title, startMin: applied.startMin, endMin: applied.endMin, templateId: null, archivedAt: null, version: applied.version + 1 });
    expect((await agent.get(`/api/v1/timetable/global?from=${today}&to=${today}`).expect(200)).body).toHaveLength(1);
  });
  it('erases a goal and dependent history atomically, retains other goals/resources, and never regenerates the erased goal', async () => {
    const own = await goal('Erase this goal'), other = await goal('Keep this goal');
    const first = await progress(own.task.id);
    await post(`/tasks/${own.task.id}/events`, { clientEventId: uuid(), kind: 'correction', referenceEventId: first.id, explicitCorrection: true, occurredAt: DateTime.utc().toISO() }).expect(200);
    await progress(own.task.id, 5); await progress(other.task.id, 7);
    const resource = (await post('/resources', { skillId, goalId: own.id, goalIds: [own.id, other.id], type: 'book', title: 'Shared reference' }).expect(201)).body;
    const linkedSlot = (await post('/timetable/slots', { date: today, title: 'Goal work placement', startMin: 1080, endMin: 1110, layer: 'fixed', goalId: own.id }).expect(201)).body;
    const slotReminder = await db.reminderRule.create({ data: { id: uuid(), userId, ownerType: 'slot', ownerId: linkedSlot.id, offsetMin: -5 } });
    const streak = (await post('/streaks', { title: 'Goal streak fixture', scope: 'goal', scopeId: own.id, startDate: addDays(today, -1), rule: { threshold: 5 } }).expect(201)).body;
    const plan = await db.plan.create({ data: { id: uuid(), userId } });
    const version = await db.planVersion.create({ data: { id: uuid(), userId, planId: plan.id, number: 1, state: 'active', fromDate: date(today), toDate: date(addDays(today, 6)), algoVersion: 'fixture', inputsHash: 'fixture', sourceHash: 'fixture', config: {}, input: { goals: [{ id: own.id, title: 'Erase this goal' }] }, result: {}, reason: 'Synthetic plan' } });
    await db.plan.update({ where: { id: plan.id }, data: { activeVersionId: version.id } });
    await db.planItem.create({ data: { id: uuid(), userId, versionId: version.id, taskId: own.task.id, goalId: own.id, skillId, date: date(today), startMin: 1080, endMin: 1110, minutes: 30, workMinutes: 30, score: 1, explanation: 'Fixture' } });
    const rule = await db.reminderRule.create({ data: { id: uuid(), userId, ownerType: 'goal', ownerId: own.id, atLocal: 480 } });
    const notification = await db.notification.create({ data: { id: uuid(), userId, type: 'task_reminder', title: 'Erase related notification', body: 'Fixture', scheduledFor: new Date(), dedupeKey: uuid(), ownerType: 'goal', ownerId: own.id, reminderRuleId: rule.id, taskId: own.task.id } });
    await db.notificationAttempt.create({ data: { id: uuid(), userId, notificationId: notification.id, outcome: 'sent' } });
    const reviewed = await preview('goal', own.id);
    expect(reviewed.counts.some((row: { label: string; count: number }) => row.label === 'Linked saved plans' && row.count === 1)).toBe(true);
    expect(reviewed.counts).toContainEqual({ label: 'Reminder rules', count: 2 });
    await erase('goal', own.id, reviewed.token).expect(200); await erase('goal', own.id, reviewed.token).expect(200);
    expect(await db.goal.findUnique({ where: { id: own.id } })).toBeNull();
    for (const count of [await db.task.count({ where: { goalId: own.id } }), await db.progressEvent.count({ where: { goalId: own.id } }), await db.goalRuleVersion.count({ where: { goalId: own.id } }), await db.recurrenceSeries.count({ where: { goalId: own.id } }), await db.goalProgressCache.count({ where: { goalId: own.id } }), await db.planVersion.count({ where: { id: version.id } }), await db.notificationAttempt.count({ where: { notificationId: notification.id } }), await db.streakDef.count({ where: { id: streak.id } })]) expect(count).toBe(0);
    expect(await db.goalProgressCache.findUniqueOrThrow({ where: { goalId: other.id } })).toMatchObject({ minutes: 7 });
    expect(await db.resource.findUniqueOrThrow({ where: { id: resource.id } })).toMatchObject({ goalId: null });
    expect(await db.goalResource.count({ where: { resourceId: resource.id, goalId: other.id } })).toBe(1);
    await agent.get('/api/v1/bootstrap').expect(200); expect(await db.goal.findUnique({ where: { id: own.id } })).toBeNull();
    expect(await db.plan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({ activeVersionId: null });
    expect(await db.reminderRule.findUnique({ where: { id: slotReminder.id } })).toBeNull();
    expect(await db.timeSlot.findUnique({ where: { id: linkedSlot.id } })).toBeNull();
  });
  it('clears only a goal’s progress history and resets projections; retrying does not erase later work', async () => {
    const own = await goal(), other = await goal('Other practice');
    await progress(own.task.id); await progress(other.task.id, 7);
    const beforeTasks = await db.task.count({ where: { goalId: own.id } }), beforeRules = await db.goalRuleVersion.count({ where: { goalId: own.id } });
    const reviewed = await preview('goal-history', own.id);
    await erase('goal-history', own.id, reviewed.token).expect(200);
    expect(await db.task.findUniqueOrThrow({ where: { id: own.task.id } })).toMatchObject({ status: 'pending', actualMinutes: 0, completedQty: 0, eventVersion: 0, remainingMinutes: 30, timerStartedAt: null });
    expect(await db.task.count({ where: { goalId: own.id } })).toBe(beforeTasks);
    expect(await db.goalRuleVersion.count({ where: { goalId: own.id } })).toBe(beforeRules);
    expect(await db.progressEvent.count({ where: { goalId: own.id } })).toBe(0);
    await progress(own.task.id, 4); await erase('goal-history', own.id, reviewed.token).expect(200);
    expect(await db.goalProgressCache.findUniqueOrThrow({ where: { goalId: own.id } })).toMatchObject({ minutes: 4 });
    expect(await db.goalProgressCache.findUniqueOrThrow({ where: { goalId: other.id } })).toMatchObject({ minutes: 7 });
  });
  it('requires a current preview, protects normal append-only edits, and rejects foreign targets', async () => {
    const own = await goal(); const event = await progress(own.task.id);
    await expect(db.progressEvent.update({ where: { id: event.id }, data: { minutes: 99 } })).rejects.toThrow(/append.only/i);
    await expect(db.progressEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append.only/i);
    const reviewed = await preview('goal', own.id); await progress(own.task.id, 5);
    expect((await erase('goal', own.id, reviewed.token).expect(412)).body.error.code).toBe('DELETION_CHANGED');
    expect(await db.progressEvent.count({ where: { goalId: own.id } })).toBe(2);
    await agent.delete(`/api/v1/deletions/goal/${own.id}`).set('Origin', origin).set('X-CSRF-Token', csrf).send({}).expect(400);
    await agent.get(`/api/v1/deletions/goal/${uuid()}`).expect(404);
    await expect(db.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('kram.erase_owner', ${userId}, true), set_config('kram.erase_scope', '{"progress_event":[]}', true)`;
      await tx.progressEvent.delete({ where: { id: event.id } });
    })).rejects.toThrow(/append.only/i);
    await erase('goal', own.id, (await preview('goal', own.id)).token).expect(200);
    const other = await goal('Later goal'); const later = await progress(other.task.id);
    await expect(db.progressEvent.delete({ where: { id: later.id } })).rejects.toThrow(/append.only/i);
  });
  it('deletes one class pattern and its makeup blocks while retaining other patterns and their makeup tracking', async () => {
    const rows = (await post('/recurrence/classes', sheet([meeting('Erase class', [1], 480), meeting('Keep class', [1], 600)])).expect(200)).body.rows;
    const target = nextDay(6);
    await post('/recurrence/classes/day', { requestId: uuid(), date: target, weekday: 1 }).expect(200);
    const regular = await db.timeSlot.findFirstOrThrow({ where: { userId, title: 'Erase class' }, orderBy: { date: 'asc' } });
    const makeup = await db.timeSlot.findFirstOrThrow({ where: { userId, title: 'Erase class', date: date(target) } });
    const kept = await db.timeSlot.findFirstOrThrow({ where: { userId, title: 'Keep class', date: date(target) } });
    const reminderIds = [uuid(), uuid(), uuid()];
    await db.reminderRule.createMany({ data: [regular, makeup, kept].map((slot, index) => ({ id: reminderIds[index]!, userId, ownerType: 'slot', ownerId: slot.id, offsetMin: -5 })) });
    const reviewed = await preview('schedule', rows[0].id);
    expect(reviewed.counts).toContainEqual({ label: 'Reminder rules', count: 2 });
    await erase('schedule', rows[0].id, reviewed.token).expect(200);
    expect(await db.recurrenceSeries.findUnique({ where: { id: rows[0].id } })).toBeNull();
    expect(await db.timeSlot.count({ where: { title: 'Erase class' } })).toBe(0);
    expect(await db.timeSlot.count({ where: { title: 'Keep class', date: date(target), archivedAt: null } })).toBe(1);
    expect(await db.reminderRule.findMany({ where: { id: { in: reminderIds } } })).toMatchObject([{ id: reminderIds[2] }]);
    await post('/recurrence/classes/day', { requestId: uuid(), date: target, weekday: 1 }).expect(200);
    expect(await db.timeSlot.count({ where: { title: 'Keep class', date: date(target), archivedAt: null } })).toBe(1);
  });
});
