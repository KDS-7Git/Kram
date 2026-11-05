import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import request, { type Agent, type Test } from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { v7 as uuid } from 'uuid';
import { defaultSettings, type TimeSlot } from '@kram/shared';
import { addDays, instantMillis, localToInstant, studyDate } from '@kram/time';

const origin = 'http://localhost:8420';
const future = addDays(studyDate(DateTime.utc().toISO()!, 'Asia/Kolkata', 240), 7);
let container: StartedTestContainer, db: PrismaClient, app: Express, agent: Agent;
let csrf = '', ownerId = '', profileId = '', otherProfileId = '', skillId = '', otherSkillId = '', goalId = '', otherGoalId = '';
let foreignProfileId = '', foreignSkillId = '', foreignGoalId = '', foreignTaskId = '', foreignSlotId = '';
const calendar = (date: string) => DateTime.fromISO(date, { zone: 'UTC' }).toJSDate();

function mutate(method: 'post' | 'patch' | 'delete', path: string, body: Record<string, unknown> = {}, version?: string): Test {
  const operation = method === 'post' ? agent.post(path) : method === 'patch' ? agent.patch(path) : agent.delete(path);
  operation.set('Origin', origin).set('X-CSRF-Token', csrf).send(body);
  if (version !== undefined) operation.set('If-Match', version);
  return operation;
}
const create = (body: Record<string, unknown>) => mutate('post', '/api/v1/timetable/slots', { date: future, startMin: 600, endMin: 630, title: 'Synthetic scheduled work', ...body });
const edit = (id: string, body: Record<string, unknown>, version?: string) => mutate('patch', `/api/v1/timetable/slots/${id}`, body, version);
const archive = (id: string, version?: string) => mutate('delete', `/api/v1/timetable/slots/${id}`, {}, version);
const get = (id: string) => agent.get(`/api/v1/timetable/slots/${id}`);
async function makeTask(fields: Record<string, unknown> = {}) {
  const id = uuid();
  return db.task.create({ data: { id, userId: ownerId, goalId, title: 'Synthetic manual task', estMinutes: 30, remainingMinutes: 30,
    qty: 1, earliestDate: calendar(future), dueDate: calendar(addDays(future, 2)), periodKey: `fixture:${id}`, materializationKey: `manual-test:${id}`, ...fields } });
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-bookworm')
    .withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'manual-timetable-disposable-only', POSTGRES_DB: 'kram' })
    .withExposedPorts(5432)
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 })
    .withWaitStrategy(Wait.forHealthCheck()).start();
  const url = `postgresql://kram:manual-timetable-disposable-only@${container.getHost()}:${container.getMappedPort(5432)}/kram`;
  Object.assign(process.env, { DOTENV_CONFIG_PATH: devNull, DATABASE_URL: url, DATABASE_URL_FILE: '', NODE_ENV: 'test', APP_URL: origin,
    COOKIE_SECURE: 'false', DEFAULT_TIMEZONE: 'Asia/Kolkata', SESSION_SECRET: 'manual-timetable-session-key-at-least32bytes', SESSION_SECRET_FILE: '',
    ENCRYPTION_KEY: '55'.repeat(32), ENCRYPTION_KEY_FILE: '', OWNER_SETUP_TOKEN: '', OWNER_SETUP_TOKEN_FILE: '', LOG_LEVEL: 'silent' });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: process.env, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db'));
  const { createApp } = await import('../../apps/api/src/app'); app = createApp();
  agent = request.agent(app);
  csrf = (await agent.get('/api/v1/auth/me').expect(200)).body.csrfToken;
  const owner = await mutate('post', '/api/v1/auth/setup', { email: 'manual-owner@kram.test', password: 'synthetic-manual-owner-password-42' }).expect(201);
  ownerId = owner.body.user.id; csrf = owner.body.csrfToken;
  profileId = (await mutate('post', '/api/v1/profiles', { name: 'Synthetic manual profile' }).expect(201)).body.id;
  otherProfileId = (await mutate('post', '/api/v1/profiles', { name: 'Synthetic other profile' }).expect(201)).body.id;
  skillId = (await mutate('post', '/api/v1/skills', { profileId, name: 'Synthetic manual skill' }).expect(201)).body.id;
  otherSkillId = (await mutate('post', '/api/v1/skills', { profileId: otherProfileId, name: 'Synthetic other skill' }).expect(201)).body.id;
  goalId = (await mutate('post', '/api/v1/goals', { skillId, type: 'daily', title: 'Synthetic manual goal', targetQty: 30, startDate: future }).expect(201)).body.id;
  otherGoalId = (await mutate('post', '/api/v1/goals', { skillId: otherSkillId, type: 'daily', title: 'Synthetic other goal', targetQty: 30, startDate: future }).expect(201)).body.id;
  const foreign = await db.user.create({ data: { id: uuid(), email: 'manual-foreign@kram.test', passwordHash: 'fixture-only', settings: defaultSettings, isOwner: false } });
  const foreignProfile = await db.profile.create({ data: { id: uuid(), userId: foreign.id, name: 'Foreign profile' } }); foreignProfileId = foreignProfile.id;
  const foreignSkill = await db.skill.create({ data: { id: uuid(), userId: foreign.id, profileId: foreignProfile.id, name: 'Foreign skill' } }); foreignSkillId = foreignSkill.id;
  const foreignGoal = await db.goal.create({ data: { id: uuid(), userId: foreign.id, skillId: foreignSkill.id, type: 'daily', title: 'Foreign goal', targetQty: 30, startDate: calendar(future) } }); foreignGoalId = foreignGoal.id;
  const foreignTask = await db.task.create({ data: { id: uuid(), userId: foreign.id, goalId: foreignGoal.id, title: 'Foreign task', estMinutes: 30, remainingMinutes: 30, earliestDate: calendar(future), periodKey: 'foreign', materializationKey: 'manual-foreign-task' } }); foreignTaskId = foreignTask.id;
  const foreignSlot = await db.timeSlot.create({ data: { id: uuid(), userId: foreign.id, date: calendar(future), startMin: 600, endMin: 630, title: 'Foreign slot' } }); foreignSlotId = foreignSlot.id;
}, 120000);
afterAll(async () => {
  const closeSessions: unknown = app?.locals.closeSessions;
  if (typeof closeSessions === 'function') await closeSessions();
  await db?.$disconnect(); await container?.stop();
});

describe('manual timetable storage and versioning', () => {
  it('authenticates before parsing IDs and hides every foreign reference', async () => {
    expect((await request(app).get('/api/v1/timetable/slots/not-an-id')).status).toBe(401);
    const foreign = await get(foreignSlotId); expect(foreign.status).toBe(404);
    expect((await edit(foreignSlotId, { title: 'Foreign edit' }, '"1"')).status).toBe(404);
    expect((await archive(foreignSlotId, '"1"')).status).toBe(404);
    const ownedTask = await makeTask();
    for (const fields of [{ profileId: foreignProfileId }, { skillId: foreignSkillId }, { goalId: foreignGoalId }, { taskId: foreignTaskId }, { taskId: ownedTask.id, goalId: foreignGoalId }]) {
      const response = await create(fields); expect(response.status).toBe(404); expect(response.body.error.code).toBe('NOT_FOUND');
    }
    const listed = (await agent.get(`/api/v1/timetable/day/${future}`).expect(200)).body as TimeSlot[];
    expect(listed.some(row => row.id === foreignSlotId)).toBe(false);
    expect((await db.timeSlot.findUniqueOrThrow({ where: { id: foreignSlotId } })).title).toBe('Foreign slot');
  });

  it('saves civil dates, infers a task hierarchy and returns a quoted ETag', async () => {
    const task = await makeTask();
    const response = await create({ taskId: task.id }).expect(201);
    expect(response.headers.etag).toBe('"1"');
    expect(response.body).toMatchObject({ taskId: task.id, goalId, skillId, profileId, date: future, version: 1, layer: 'flexible' });
    const saved = await get(response.body.id).expect(200); expect(saved.headers.etag).toBe('"1"');
    expect(saved.body.createdAt).toMatch(/Z$/);
  });

  it('requires strong If-Match values and increments versions on edit/archive', async () => {
    const response = await create({ date: addDays(future, 1) }).expect(201); const id = response.body.id;
    const missing = await edit(id, { title: 'Missing version' }); expect(missing.status).toBe(428); expect(missing.body.error.code).toBe('PRECONDITION_REQUIRED');
    for (const header of ['1', 'W/"1"', '*', '"0"', '"1","2"']) expect((await edit(id, { title: 'Malformed version' }, header)).status).toBe(400);
    const changed = await edit(id, { title: 'Saved version two' }, '"1"').expect(200);
    expect(changed.headers.etag).toBe('"2"'); expect(changed.body).toMatchObject({ version: 2, title: 'Saved version two' });
    const stale = await edit(id, { title: 'Stale overwrite' }, '"1"'); expect(stale.status).toBe(412); expect(stale.body.error.details.currentVersion).toBe(2);
    expect((await archive(id)).status).toBe(428); expect((await archive(id, '"1"')).status).toBe(412);
    const deleted = await archive(id, '"2"').expect(200); expect(deleted.headers.etag).toBe('"3"');
    expect(deleted.body.archivedAt).not.toBeNull(); expect((await get(id).expect(200)).body.title).toBe('Saved version two');
    expect((await agent.get(`/api/v1/timetable/day/${addDays(future, 1)}`).expect(200)).body).toEqual([]);
    expect((await edit(id, { title: 'Archived change' }, '"3"')).status).toBe(409);
  });

  it('serializes simultaneous edits so one stale version cannot overwrite the winner', async () => {
    const slot = (await create({ date: addDays(future, 2) }).expect(201)).body;
    const results = await Promise.all([edit(slot.id, { title: 'Concurrent first' }, '"1"'), edit(slot.id, { title: 'Concurrent second' }, '"1"')]);
    expect(results.map(row => row.status).sort()).toEqual([200, 412]);
    const winner = results.find(row => row.status === 200)!;
    expect((await get(slot.id).expect(200)).body).toMatchObject({ title: winner.body.title, version: 2 });
  });

  it('bounds inclusive global queries and validates ordered real calendar dates', async () => {
    const first = await create({ date: addDays(future, 3), startMin: 720, endMin: 750 }).expect(201);
    const second = await create({ date: addDays(future, 4), startMin: 660, endMin: 690 }).expect(201);
    const rows = (await agent.get(`/api/v1/timetable/global?from=${addDays(future, 3)}&to=${addDays(future, 4)}`).expect(200)).body as TimeSlot[];
    expect(rows.map(row => row.id)).toEqual([first.body.id, second.body.id]);
    for (const query of [`from=${addDays(future, 4)}&to=${future}`, `from=${future}&to=${addDays(future, 367)}`, 'from=2026-02-30&to=2026-03-01', `from=${future}`]) expect((await agent.get(`/api/v1/timetable/global?${query}`)).status).toBe(400);
  });
});

describe('manual occupancy and hierarchy rules', () => {
  it('allows touching intervals and separate dates but rejects hard occupancy overlaps', async () => {
    for (const [index, layer] of ['unavailable', 'fixed', 'pinned', 'flexible'].entries()) {
      const date = addDays(future, index + 5);
      await create({ date, layer, startMin: 600, endMin: 660 }).expect(201);
      await create({ date, startMin: 660, endMin: 690 }).expect(201);
      const overlap = await create({ date, startMin: 630, endMin: 680 }); expect(overlap.status).toBe(409); expect(overlap.body.error.code).toBe('SLOT_CONFLICT');
      expect(await db.timeSlot.count({ where: { userId: ownerId, date: calendar(date), archivedAt: null } })).toBe(2);
    }
  });

  it('allows only owning-skill flexible containment inside reserved time', async () => {
    const date = addDays(future, 9);
    await create({ date, layer: 'reserved', skillId, startMin: 540, endMin: 660 }).expect(201);
    await create({ date, skillId, startMin: 550, endMin: 580 }).expect(201);
    await create({ date, skillId, startMin: 600, endMin: 630 }).expect(201);
    await create({ date, layer: 'reserved', skillId, startMin: 540, endMin: 660 }).expect(201);
    for (const fields of [{ skillId: otherSkillId, startMin: 630, endMin: 650 }, { skillId, startMin: 650, endMin: 670 },
      { skillId, layer: 'pinned', startMin: 630, endMin: 650 }, { skillId, pinned: true, startMin: 630, endMin: 650 },
      { skillId: otherSkillId, layer: 'reserved', startMin: 580, endMin: 650 }, { layer: 'fixed', startMin: 630, endMin: 650 }]) {
      const response = await create({ date, ...fields }); expect(response.status).toBe(409); expect(response.body.error.code).toBe('SLOT_CONFLICT');
    }
    expect((await create({ date: addDays(future, 10), layer: 'reserved' })).status).toBe(400);
    await expect(db.timeSlot.create({ data: { id: uuid(), userId: ownerId, date: calendar(date), layer: 'reserved', skillId: otherSkillId,
      profileId: otherProfileId, startMin: 540, endMin: 650, title: 'Raw cross-skill reservation' } })).rejects.toThrow();
  });

  it('applies reserved containment checks in either creation direction', async () => {
    const date = addDays(future, 11);
    await create({ date, skillId, startMin: 600, endMin: 630 }).expect(201);
    await create({ date, layer: 'reserved', skillId, startMin: 580, endMin: 650 }).expect(201);
    const partial = await create({ date, layer: 'reserved', skillId, startMin: 610, endMin: 680 }); expect(partial.status).toBe(409);
  });

  it('rolls back rejected moves and frees archived occupancy without deleting history', async () => {
    const date = addDays(future, 12);
    const first = (await create({ date, startMin: 600, endMin: 630 }).expect(201)).body;
    const second = (await create({ date, startMin: 660, endMin: 690 }).expect(201)).body;
    expect((await edit(second.id, { startMin: 610, endMin: 640 }, '"1"')).status).toBe(409);
    expect((await get(second.id).expect(200)).body).toMatchObject({ startMin: 660, endMin: 690, version: 1 });
    await archive(first.id, '"1"').expect(200);
    await edit(second.id, { startMin: 600, endMin: 630 }, '"1"').expect(200);
    expect(await db.timeSlot.count({ where: { userId: ownerId, date: calendar(date) } })).toBe(2);
  });

  it('serializes overlapping creates into one saved block and a named conflict', async () => {
    const date = addDays(future, 13);
    const results = await Promise.all([create({ date, title: 'First simultaneous slot' }), create({ date, title: 'Second simultaneous slot' })]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(results.find(row => row.status === 409)!.body.error.code).toBe('SLOT_CONFLICT');
    expect(await db.timeSlot.count({ where: { userId: ownerId, date: calendar(date) } })).toBe(1);
  });

  it('rejects explicitly inconsistent owned hierarchy IDs before saving a slot', async () => {
    const task = await makeTask(); const date = addDays(future, 14);
    for (const fields of [{ taskId: task.id, goalId: otherGoalId }, { goalId, skillId: otherSkillId }, { skillId, profileId: otherProfileId }]) {
      const response = await create({ date, ...fields }); expect(response.status).toBe(400); expect(response.body.error.code).toBe('HIERARCHY_MISMATCH');
    }
    expect(await db.timeSlot.count({ where: { userId: ownerId, date: calendar(date) } })).toBe(0);
  });

  it('prevents new terminal/deferred task placements and keeps metadata edits on history', async () => {
    const date = addDays(future, 15), task = await makeTask();
    const existing = (await create({ date, taskId: task.id }).expect(201)).body;
    await db.task.update({ where: { id: task.id }, data: { status: 'completed', remainingMinutes: 0 } });
    expect((await edit(existing.id, { title: 'Retained completed-work note' }, '"1"')).status).toBe(200);
    expect((await edit(existing.id, { startMin: 660, endMin: 690 }, '"2"')).status).toBe(409);
    for (const status of ['completed', 'cancelled', 'skipped']) {
      const closed = await makeTask({ status }); const response = await create({ date: addDays(future, 16), taskId: closed.id });
      expect(response.status).toBe(409); expect(response.body.error.code).toBe('TASK_CLOSED');
    }
    const deferred = await makeTask({ status: 'deferred', deferredToDate: calendar(addDays(future, 18)) });
    expect((await create({ date: addDays(future, 17), taskId: deferred.id })).status).toBe(409);
    expect((await create({ date: addDays(future, 18), startMin: 90, endMin: 120, taskId: deferred.id })).status).toBe(409);
    await create({ date: addDays(future, 18), taskId: deferred.id }).expect(201);
    await create({ date: addDays(future, 19), startMin: 90, endMin: 120, taskId: deferred.id }).expect(201);
    expect((await create({ date: addDays(future, -1), taskId: (await makeTask()).id })).status).toBe(409);
  });

  it('rejects archived parents for new placements while preserving existing metadata', async () => {
    const p = await db.profile.create({ data: { id: uuid(), userId: ownerId, name: 'Archived slot parent' } });
    const s = await db.skill.create({ data: { id: uuid(), userId: ownerId, profileId: p.id, name: 'Archived slot skill' } });
    const date = addDays(future, 19), slot = (await create({ date, skillId: s.id }).expect(201)).body;
    await mutate('post', `/api/v1/profiles/${p.id}/archive`).expect(200);
    expect((await create({ date: addDays(future, 20), skillId: s.id })).status).toBe(409);
    await edit(slot.id, { title: 'Historical archived profile note' }, '"1"').expect(200);
    expect((await edit(slot.id, { startMin: 660, endMin: 690 }, '"2"')).status).toBe(409);
    const paused = await mutate('post', '/api/v1/goals', { skillId, type: 'daily', title: 'Paused placement fixture', targetQty: 30, startDate: future }).expect(201);
    await mutate('post', `/api/v1/goals/${paused.body.id}/pause`).expect(200);
    const pausedPlacement = await create({ date: addDays(future, 20), goalId: paused.body.id });
    expect(pausedPlacement.status).toBe(409); expect(pausedPlacement.body.error.code).toBe('GOAL_NOT_ACTIVE');
  });

  it('validates clock limits and enforces occupancy and ownership in PostgreSQL', async () => {
    const date = addDays(future, 21);
    for (const fields of [{ startMin: 600, endMin: 600 }, { startMin: -1 }, { startMin: 1440, endMin: 1441 }, { date: '2026-02-30' }]) expect((await create({ date, ...fields })).status).toBe(400);
    await create({ date, startMin: 1410, endMin: 1440 }).expect(201);
    await expect(db.timeSlot.create({ data: { id: uuid(), userId: ownerId, date: calendar(date), startMin: 1420, endMin: 1430, title: 'Raw conflicting occupancy' } })).rejects.toThrow();
    await expect(db.timeSlot.create({ data: { id: uuid(), userId: ownerId, profileId: foreignProfileId, date: calendar(addDays(future, 22)), startMin: 600, endMin: 630, title: 'Raw cross-owner reference' } })).rejects.toThrow();
  });
});

describe('atomic slot reminder projections', () => {
  it('refreshes offset reminders on create/move/archive and leaves failed moves unchanged', async () => {
    await db.user.update({ where: { id: ownerId }, data: { settings: { ...defaultSettings, notificationsEnabled: true } } });
    const task = await makeTask(), rule = await db.reminderRule.create({ data: { id: uuid(), userId: ownerId, ownerType: 'task', ownerId: task.id, offsetMin: -10, type: 'upcoming' } });
    const date = addDays(future, 23), slot = (await create({ date, taskId: task.id, startMin: 600, endMin: 630 }).expect(201)).body;
    const original = await db.notification.findFirstOrThrow({ where: { userId: ownerId, reminderRuleId: rule.id, status: 'pending' } });
    expect(original.scheduledFor.getTime()).toBe(instantMillis(localToInstant(date, 590, 'Asia/Kolkata')));
    await create({ date, startMin: 720, endMin: 750 }).expect(201);
    const before = await db.notification.findMany({ where: { reminderRuleId: rule.id }, orderBy: { id: 'asc' } });
    expect((await edit(slot.id, { startMin: 730, endMin: 760 }, '"1"')).status).toBe(409);
    expect(await db.notification.findMany({ where: { reminderRuleId: rule.id }, orderBy: { id: 'asc' } })).toEqual(before);
    await edit(slot.id, { startMin: 660, endMin: 690 }, '"1"').expect(200);
    expect((await db.notification.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('cancelled');
    const moved = await db.notification.findFirstOrThrow({ where: { userId: ownerId, reminderRuleId: rule.id, status: 'pending' } });
    expect(moved.id).not.toBe(original.id); expect(moved.scheduledFor.getTime()).toBe(instantMillis(localToInstant(date, 650, 'Asia/Kolkata')));
    await archive(slot.id, '"2"').expect(200);
    expect((await db.notification.findUniqueOrThrow({ where: { id: moved.id } })).status).toBe('cancelled');
    expect(await db.notification.count({ where: { reminderRuleId: rule.id } })).toBe(2);
    await db.reminderRule.update({ where: { id: rule.id }, data: { enabled: false } });
  });

  it('rolls back the slot when its reminder projection cannot be inserted', async () => {
    const task = await makeTask();
    const rule = await db.reminderRule.create({ data: { id: uuid(), userId: ownerId, ownerType: 'task', ownerId: task.id, offsetMin: -10, type: 'upcoming' } });
    const date = addDays(future, 24);
    await db.$executeRawUnsafe("CREATE FUNCTION manual_test_fail_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'manual-test projection failure'; END $$");
    await db.$executeRawUnsafe('CREATE TRIGGER manual_test_projection_failure BEFORE INSERT ON notification FOR EACH ROW EXECUTE FUNCTION manual_test_fail_notification()');
    try {
      const rejected = await create({ date, taskId: task.id }); expect(rejected.status).toBe(500); expect(rejected.body.error.code).toBe('INTERNAL_ERROR');
      expect(await db.timeSlot.count({ where: { userId: ownerId, date: calendar(date) } })).toBe(0);
      expect(await db.notification.count({ where: { reminderRuleId: rule.id } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER manual_test_projection_failure ON notification');
      await db.$executeRawUnsafe('DROP FUNCTION manual_test_fail_notification()');
    }
    await create({ date, taskId: task.id }).expect(201);
    expect(await db.notification.count({ where: { reminderRuleId: rule.id, status: 'pending' } })).toBe(1);
  });
});
