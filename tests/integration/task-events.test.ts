import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import request, { type Agent, type Test } from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { v7 as uuid } from 'uuid';
import { defaultSettings, type Task } from '@kram/shared';

const origin = 'http://localhost:8420', fixedNow = '2026-11-06T12:00:00+05:30';
let container: StartedTestContainer, db: PrismaClient, app: Express, agent: Agent;
let clock: { now: () => string }, originalNow: () => string;
let csrf = '', ownerId = '', skillId = '', minuteGoalId = '', countGoalId = '', foreignGoalId = '', foreignTaskId = '', foreignEventId = '';
function mutate(method: 'post' | 'patch', path: string, body: Record<string, unknown> = {}): Test {
  const operation = method === 'post' ? agent.post(`/api/v1${path}`) : agent.patch(`/api/v1${path}`);
  return operation.set('Origin', origin).set('X-CSRF-Token', csrf).send(body);
}
const get = (path: string) => agent.get(`/api/v1${path}`);
const post = (path: string, body: Record<string, unknown> = {}) => mutate('post', path, body);
const patch = (path: string, body: Record<string, unknown> = {}) => mutate('patch', path, body);
async function makeTask(fields: Record<string, unknown> = {}): Promise<Task> {
  return (await post('/tasks', { goalId: minuteGoalId, title: 'Synthetic event task', estMinutes: 60, earliestDate: '2026-11-05', dueDate: '2026-11-10', ...fields }).expect(201)).body as Task;
}
const event = (id: string, kind: string, fields: Record<string, unknown> = {}) => post(`/tasks/${id}/events`, { clientEventId: uuid(), kind, occurredAt: '2026-11-06T10:00:00+05:30', ...fields });
const correction = (id: string, referenceEventId: string, fields: Record<string, unknown> = {}) => event(id, 'correction', { referenceEventId, ...fields });

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-bookworm')
    .withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'task-events-disposable-only', POSTGRES_DB: 'kram' })
    .withExposedPorts(5432)
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 })
    .withWaitStrategy(Wait.forHealthCheck()).start();
  const url = `postgresql://kram:task-events-disposable-only@${container.getHost()}:${container.getMappedPort(5432)}/kram`;
  Object.assign(process.env, { DOTENV_CONFIG_PATH: devNull, DATABASE_URL: url, DATABASE_URL_FILE: '', NODE_ENV: 'test', APP_URL: origin,
    COOKIE_SECURE: 'false', DEFAULT_TIMEZONE: 'Asia/Kolkata', SESSION_SECRET: 'task-event-session-key-at-least32characters', SESSION_SECRET_FILE: '',
    ENCRYPTION_KEY: '66'.repeat(32), ENCRYPTION_KEY_FILE: '', OWNER_SETUP_TOKEN: '', OWNER_SETUP_TOKEN_FILE: '', LOG_LEVEL: 'silent' });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: process.env, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db'));
  ({ clock } = await import('../../apps/api/src/calendar')); originalNow = clock.now; clock.now = () => fixedNow;
  const { createApp } = await import('../../apps/api/src/app'); app = createApp(); agent = request.agent(app);
  csrf = (await get('/auth/me').expect(200)).body.csrfToken;
  const owner = await post('/auth/setup', { email: 'task-events-owner@kram.test', password: 'synthetic-task-event-owner-password-42' }).expect(201);
  ownerId = owner.body.user.id; csrf = owner.body.csrfToken;
  const profile = await post('/profiles', { name: 'Synthetic event profile' }).expect(201);
  skillId = (await post('/skills', { profileId: profile.body.id, name: 'Synthetic event skill' }).expect(201)).body.id;
  minuteGoalId = (await post('/goals', { skillId, type: 'daily', title: 'Synthetic minute goal', targetQty: 60, unit: 'minutes', startDate: '2026-11-05' }).expect(201)).body.id;
  countGoalId = (await post('/goals', { skillId, type: 'weekly', title: 'Synthetic question goal', targetQty: 10, unit: 'questions', startDate: '2026-11-05' }).expect(201)).body.id;
  const foreign = await db.user.create({ data: { id: uuid(), email: 'task-events-foreign@kram.test', passwordHash: 'fixture-only', isOwner: false, settings: defaultSettings } });
  const foreignProfile = await db.profile.create({ data: { id: uuid(), userId: foreign.id, name: 'Foreign event profile' } });
  const foreignSkill = await db.skill.create({ data: { id: uuid(), userId: foreign.id, profileId: foreignProfile.id, name: 'Foreign event skill' } });
  const goal = await db.goal.create({ data: { id: uuid(), userId: foreign.id, skillId: foreignSkill.id, type: 'daily', title: 'Foreign event goal', targetQty: 30, startDate: new Date('2026-11-05T00:00:00Z') } }); foreignGoalId = goal.id;
  const task = await db.task.create({ data: { id: uuid(), userId: foreign.id, goalId: goal.id, title: 'Foreign event task', estMinutes: 30, remainingMinutes: 30, earliestDate: new Date('2026-11-05T00:00:00Z'), periodKey: 'foreign', materializationKey: 'task-event-foreign' } }); foreignTaskId = task.id;
  const stored = await db.progressEvent.create({ data: { id: uuid(), userId: foreign.id, taskId: task.id, goalId: goal.id, sequence: 1, kind: 'progress', minutes: 10, clientEventId: uuid(), occurredAt: new Date('2026-11-05T12:00:00Z'), localDate: new Date('2026-11-05T00:00:00Z'), timezone: 'UTC' } }); foreignEventId = stored.id;
}, 120000);
beforeEach(() => { if (clock) clock.now = () => fixedNow; });
afterAll(async () => {
  if (clock && originalNow) clock.now = originalNow;
  const closeSessions: unknown = app?.locals.closeSessions;
  if (typeof closeSessions === 'function') await closeSessions();
  await db?.$disconnect(); await container?.stop();
});

describe('authenticated append-only task events', () => {
  it('protects task identifiers and foreign task/goal/event references', async () => {
    expect((await request(app).get('/api/v1/tasks/not-a-uuid')).status).toBe(401);
    expect((await get(`/tasks/${foreignTaskId}`)).status).toBe(404);
    expect((await event(foreignTaskId, 'progress', { minutes: 5 })).status).toBe(404);
    expect((await post('/tasks', { goalId: foreignGoalId, title: 'Foreign task creation', estMinutes: 30, earliestDate: '2026-11-05' })).status).toBe(404);
    const owned = await makeTask();
    expect((await correction(owned.id, foreignEventId, { explicitCorrection: true })).status).toBe(404);
    const other = await makeTask(), otherEvent = await event(other.id, 'progress', { minutes: 5 }).expect(200);
    expect((await correction(owned.id, otherEvent.body.event.id, { explicitCorrection: true })).status).toBe(404);
    expect(await db.progressEvent.count({ where: { taskId: owned.id } })).toBe(0);
  });

  it('records 40 of 60 minutes, derives remainder20 and preserves quantity units', async () => {
    const beforeCache = await db.goalProgressCache.findUnique({ where: { goalId: minuteGoalId } });
    const task = await makeTask(); expect(task.qty).toBe(60);
    const partial = await event(task.id, 'progress', { minutes: 40 }).expect(200);
    expect(partial.body.task).toMatchObject({ status: 'partial', actualMinutes: 40, completedQty: 40, remainingMinutes: 20 });
    const complete = await event(task.id, 'completed', { minutes: 60 }).expect(200);
    expect(complete.body.event).toMatchObject({ minutes: 20, qty: 20 });
    expect(complete.body.task).toMatchObject({ status: 'completed', actualMinutes: 60, completedQty: 60, remainingMinutes: 0 });
    expect(await db.goalProgressCache.findUniqueOrThrow({ where: { goalId: minuteGoalId } })).toMatchObject({
      minutes: (beforeCache?.minutes ?? 0) + 60, qty: (beforeCache?.qty ?? 0) + 60, completions: (beforeCache?.completions ?? 0) + 1,
    });
    const count = await makeTask({ goalId: countGoalId, qty: 10 });
    const countPartial = await event(count.id, 'progress', { minutes: 25, qty: 4 }).expect(200);
    expect(countPartial.body.task).toMatchObject({ actualMinutes: 25, completedQty: 4, remainingMinutes: 36 });
    const countDone = await event(count.id, 'completed', { minutes: 60, qty: 10 }).expect(200);
    expect(countDone.body.event).toMatchObject({ minutes: 35, qty: 6 });
    expect(countDone.body.task).toMatchObject({ actualMinutes: 60, completedQty: 10, remainingMinutes: 0 });
    const cache = await db.goalProgressCache.findUniqueOrThrow({ where: { goalId: countGoalId } });
    expect(cache).toMatchObject({ minutes: 60, qty: 10, completions: 1 });
  });

  it('fills remaining count on completion when omitted and respects explicit zero quantity', async () => {
    const count = await makeTask({ goalId: countGoalId, qty: 8 });
    await event(count.id, 'progress', { minutes: 10, qty: 3 }).expect(200);
    const done = await event(count.id, 'completed', { minutes: 15 }).expect(200);
    expect(done.body.event).toMatchObject({ qty: 5, minutes: 5 }); expect(done.body.task).toMatchObject({ completedQty: 8, actualMinutes: 15 });
    const explicit = await makeTask({ goalId: countGoalId, qty: 8 });
    const zero = await event(explicit.id, 'completed', { minutes: 10, qty: 0 }).expect(200);
    expect(zero.body.task).toMatchObject({ status: 'completed', completedQty: 0, actualMinutes: 10, remainingMinutes: 0 });
  });

  it('preserves fractional logged minutes and quantity exactly in durable caches', async () => {
    const task = await makeTask({ goalId: countGoalId, qty: 10 });
    const response = await event(task.id, 'progress', { minutes: 0.5, qty: 0 }).expect(200);
    expect(response.body.task).toMatchObject({ actualMinutes: 0.5, completedQty: 0, remainingMinutes: 59.5 });
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).remainingMinutes).toBe(59.5);
    const minuteTask = await makeTask();
    const time = await event(minuteTask.id, 'progress', { minutes: 0.5, qty: 0 }).expect(200);
    expect(time.body.task).toMatchObject({ actualMinutes: 0.5, completedQty: 0.5, remainingMinutes: 59.5 });
  });

  it('rejects below-progress completion totals and preserves actual time when omitted', async () => {
    const task = await makeTask({ goalId: countGoalId, qty: 10 });
    await event(task.id, 'progress', { minutes: 40, qty: 6 }).expect(200);
    for (const fields of [{ minutes: 35, qty: 10 }, { minutes: 60, qty: 5 }]) {
      const rejected = await event(task.id, 'completed', fields); expect(rejected.status).toBe(400); expect(rejected.body.error.code).toBe('INVALID_COMPLETION_TOTAL');
    }
    expect(await db.progressEvent.count({ where: { taskId: task.id } })).toBe(1);
    const done = await event(task.id, 'completed', { qty: 10 }).expect(200);
    expect(done.body.event).toMatchObject({ minutes: 0, qty: 4 });
    expect(done.body.task).toMatchObject({ status: 'completed', actualMinutes: 40, completedQty: 10 });
  });

  it('accepts cumulative completion totals while bounding each new contribution to one day', async () => {
    const task = await makeTask();
    await event(task.id, 'progress', { minutes: 1440 }).expect(200);
    const done = await event(task.id, 'completed', { minutes: 1500 }).expect(200);
    expect(done.body.task.actualMinutes).toBe(1500); expect(done.body.event.minutes).toBe(60);
    const fresh = await makeTask();
    expect((await event(fresh.id, 'completed', { minutes: 1441 })).status).toBe(400);
    expect(await db.progressEvent.count({ where: { taskId: fresh.id } })).toBe(0);
  });

  it('rejects invalid timestamps/amounts without appending or changing cache state', async () => {
    const task = await makeTask();
    for (const fields of [{ minutes: -1 }, { qty: -1 }, { occurredAt: '2026-11-06T12:00:00' }, { occurredAt: '2026-11-06T12:05:00.001+05:30' }, { minutes: 1441 }]) {
      const result = await event(task.id, 'progress', fields); expect(result.status).toBe(400);
    }
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).eventVersion).toBe(0);
    expect(await db.progressEvent.count({ where: { taskId: task.id } })).toBe(0);
    const edge = await event(task.id, 'progress', { minutes: 1, occurredAt: '2026-11-06T12:05:00+05:30' }).expect(200);
    expect(edge.body.task.actualMinutes).toBe(1);
  });

  it('rejects event and baseline edits that contradict stored task state', async () => {
    const task = await makeTask();
    expect((await event(task.id, 'paused')).status).toBe(400);
    await event(task.id, 'started').expect(200);
    expect((await event(task.id, 'started')).status).toBe(400);
    expect((await event(task.id, 'deferred', { toDate: '2026-11-07' })).status).toBe(400);
    expect((await patch(`/tasks/${task.id}`, { estMinutes: 80 })).status).toBe(409);
    await patch(`/tasks/${task.id}`, { title: 'Saved event task title' }).expect(200);
    expect((await get(`/tasks/${task.id}`).expect(200)).body.estMinutes).toBe(60);
  });

  it('preserves an owner-edited generated task across source refresh and rolling windows', async () => {
    const generated = await db.task.findFirstOrThrow({ where: { goalId: minuteGoalId, earliestDate: new Date('2026-11-06T00:00:00Z'), archivedAt: null, periodKey: { startsWith: 'daily:' } } });
    expect(generated.manualOverride).toBe(false);
    const empty = await patch(`/tasks/${generated.id}`, { manualOverride: true }).expect(200);
    expect(empty.body.manualOverride).toBe(false);
    const saved = await patch(`/tasks/${generated.id}`, { title: 'Owner-adjusted generated session', estMinutes: 75, qty: 2, earliestDate: '2026-11-07', dueDate: '2026-11-09', supportsSplit: false, sortOrder: 7 }).expect(200);
    expect(saved.body).toMatchObject({ manualOverride: true, estMinutes: 75, qty: 75, remainingMinutes: 75, earliestDate: '2026-11-07', dueDate: '2026-11-09' });
    expect(await db.progressEvent.count({ where: { taskId: generated.id } })).toBe(0);
    const { materializeTasks } = await import('../../apps/api/src/modules/tasks/materialization');
    await materializeTasks(ownerId, '2026-11-06');
    await materializeTasks(ownerId, '2026-11-07');
    expect((await get(`/tasks/${generated.id}`).expect(200)).body).toMatchObject({
      title: 'Owner-adjusted generated session', estMinutes: 75, qty: 75, remainingMinutes: 75,
      earliestDate: '2026-11-07', dueDate: '2026-11-09', supportsSplit: false, sortOrder: 7, manualOverride: true, archivedAt: null,
    });
    const attemptToClear = await patch(`/tasks/${generated.id}`, { manualOverride: false }).expect(200);
    expect(attemptToClear.body.manualOverride).toBe(true);
  });

  it('keeps an owner override when its unstarted resource item is archived', async () => {
    const goal = (await post('/goals', { skillId, type: 'milestone', title: 'Synthetic override course', unit: 'videos', targetQty: 1, startDate: '2026-11-06' }).expect(201)).body;
    const resource = await db.resource.create({ data: { id: uuid(), userId: ownerId, skillId, title: 'Synthetic override resource', type: 'course' } });
    await db.goalResource.create({ data: { id: uuid(), userId: ownerId, goalId: goal.id, resourceId: resource.id } });
    const item = await db.resourceItem.create({ data: { id: uuid(), userId: ownerId, resourceId: resource.id, title: 'Synthetic removable item', estMinutes: 30 } });
    const { materializeTasks } = await import('../../apps/api/src/modules/tasks/materialization');
    await materializeTasks(ownerId, '2026-11-06');
    const generated = await db.task.findFirstOrThrow({ where: { goalId: goal.id, itemId: item.id, archivedAt: null } });
    await patch(`/tasks/${generated.id}`, { title: 'Retained owner session' }).expect(200);
    await db.resourceItem.update({ where: { id: item.id }, data: { archivedAt: new Date() } });
    await materializeTasks(ownerId, '2026-11-06');
    expect((await get(`/tasks/${generated.id}`).expect(200)).body).toMatchObject({ title: 'Retained owner session', manualOverride: true, archivedAt: null, estMinutes: 30, qty: 1 });
  });

  it('allows metadata edits on started minute quota work with a fractional quantity baseline', async () => {
    const taskId = uuid();
    await db.task.create({ data: { id: taskId, userId: ownerId, goalId: minuteGoalId, title: 'Fractional generated quota', estMinutes: 7, remainingMinutes: 7, qty: 20 / 3, earliestDate: new Date('2026-11-06T00:00:00Z'), periodKey: `weekly:fixture:${taskId}`, materializationKey: `fixture:${taskId}` } });
    await event(taskId, 'progress', { minutes: 1 }).expect(200);
    const saved = await patch(`/tasks/${taskId}`, { title: 'Renamed fractional quota', qty: 0.1 }).expect(200);
    expect(saved.body).toMatchObject({ title: 'Renamed fractional quota', estMinutes: 7, qty: 20 / 3, actualMinutes: 1, remainingMinutes: 6, manualOverride: true });
  });
});

describe('client replay and event concurrency', () => {
  it('rejects mismatched idempotency headers and pages only the selected goal history', async () => {
    const task = await makeTask();
    const mismatch = await event(task.id, 'progress', { minutes: 5 }).set('Idempotency-Key', uuid());
    expect(mismatch.status).toBe(400); expect(mismatch.body.error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    await event(task.id, 'progress', { minutes: 5 }).expect(200);
    await event(task.id, 'progress', { minutes: 10 }).expect(200);
    const page = await get(`/goals/${minuteGoalId}/events?limit=1`).expect(200);
    expect(page.body).toHaveLength(1); expect(page.headers['x-next-cursor']).toEqual(expect.any(String));
    expect(page.body[0].goalId).toBe(minuteGoalId);
    expect((await get(`/goals/${foreignGoalId}/events`)).status).toBe(404);
  });

  it('replays one client event once and recognizes equivalent instant offsets', async () => {
    const task = await makeTask(), clientEventId = uuid();
    const first = await event(task.id, 'progress', { minutes: 10, clientEventId }).expect(200);
    const replay = await event(task.id, 'progress', { minutes: 10, clientEventId, occurredAt: '2026-11-06T04:30:00Z' }).expect(200);
    expect(replay.body.replayed).toBe(true); expect(replay.body.event.id).toBe(first.body.event.id); expect(replay.body.task.actualMinutes).toBe(10);
    const conflict = await event(task.id, 'progress', { minutes: 11, clientEventId }); expect(conflict.status).toBe(409); expect(conflict.body.error.code).toBe('CLIENT_EVENT_CONFLICT');
    expect(await db.progressEvent.count({ where: { taskId: task.id } })).toBe(1);
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).eventVersion).toBe(1);
  });

  it('serializes identical concurrent replay into one append and one replay', async () => {
    const task = await makeTask(), clientEventId = uuid();
    const results = await Promise.all([event(task.id, 'progress', { minutes: 20, clientEventId }), event(task.id, 'progress', { minutes: 20, clientEventId })]);
    expect(results.map(row => row.status)).toEqual([200, 200]); expect(results.filter(row => row.body.replayed)).toHaveLength(1);
    expect(await db.progressEvent.count({ where: { taskId: task.id } })).toBe(1);
    expect((await get(`/tasks/${task.id}`).expect(200)).body.actualMinutes).toBe(20);
  });

  it('adds different concurrent progress deltas with distinct append sequences', async () => {
    const task = await makeTask();
    const results = await Promise.all([event(task.id, 'progress', { minutes: 20 }), event(task.id, 'progress', { minutes: 15 })]);
    expect(results.map(row => row.status)).toEqual([200, 200]);
    expect((await get(`/tasks/${task.id}`).expect(200)).body).toMatchObject({ actualMinutes: 35, completedQty: 35, remainingMinutes: 25 });
    const events = await db.progressEvent.findMany({ where: { taskId: task.id }, orderBy: { sequence: 'asc' } });
    expect(events.map(row => row.sequence)).toEqual([1, 2]); expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).eventVersion).toBe(2);
  });

  it('rejects a conflicting concurrent nonce without losing the winning contribution', async () => {
    const task = await makeTask(), clientEventId = uuid();
    const results = await Promise.all([event(task.id, 'progress', { minutes: 20, clientEventId }), event(task.id, 'progress', { minutes: 30, clientEventId })]);
    expect(results.map(row => row.status).sort()).toEqual([200, 409]);
    const winning = results.find(row => row.status === 200)!.body.event.minutes;
    expect((await get(`/tasks/${task.id}`).expect(200)).body.actualMinutes).toBe(winning);
    expect(await db.progressEvent.count({ where: { taskId: task.id } })).toBe(1);
  });
});

describe('durable timers and terminal decisions', () => {
  it('persists start/pause/resume segments without counting stopwatch time twice', async () => {
    const task = await makeTask();
    await event(task.id, 'started', { occurredAt: '2026-11-06T10:00:00+05:30' }).expect(200);
    const running = (await get(`/tasks/${task.id}`).expect(200)).body;
    expect(running).toMatchObject({ status: 'in_progress', timerElapsedMinutes: 120, actualMinutes: 0 });
    await event(task.id, 'paused', { occurredAt: '2026-11-06T10:20:00+05:30' }).expect(200);
    expect((await get(`/tasks/${task.id}`).expect(200)).body).toMatchObject({ timerStartedAt: null, timerAccumulatedMinutes: 20, timerElapsedMinutes: 20 });
    await event(task.id, 'resumed', { occurredAt: '2026-11-06T10:30:00+05:30' }).expect(200);
    const completed = await event(task.id, 'completed', { occurredAt: '2026-11-06T10:40:00+05:30', minutes: 30 }).expect(200);
    expect(completed.body.task).toMatchObject({ status: 'completed', timerElapsedMinutes: 30, actualMinutes: 30, timerStartedAt: null });
    expect(await db.progressEvent.count({ where: { taskId: task.id } })).toBe(4);
  });

  it('computes overdue and deferred-date return while keeping skipped/cancelled tasks closed', async () => {
    const task = await makeTask({ dueDate: '2026-11-05' });
    expect((await get(`/tasks/${task.id}`).expect(200)).body.overdue).toBe(true);
    await event(task.id, 'deferred', { toDate: '2026-11-07' }).expect(200);
    expect((await get(`/tasks/${task.id}`).expect(200)).body.status).toBe('deferred');
    clock.now = () => '2026-11-07T12:00:00+05:30';
    expect((await get(`/tasks/${task.id}`).expect(200)).body.status).toBe('pending');
    for (const kind of ['skipped', 'cancelled']) {
      const terminal = await makeTask(); await event(terminal.id, kind).expect(200);
      expect((await event(terminal.id, 'progress', { minutes: 10 })).status).toBe(409);
      expect((await get(`/tasks/${terminal.id}`).expect(200)).body.overdue).toBe(false);
    }
  });
});

describe('corrections, immutable study dates and owner safeguards', () => {
  it.each(['paused goal', 'archived goal', 'archived skill', 'archived profile'])('blocks new timers under a %s while retaining replay and history cleanup', async ancestor => {
    const profile = (await post('/profiles', { name: `Synthetic timer ancestor ${ancestor}` }).expect(201)).body;
    const skill = (await post('/skills', { profileId: profile.id, name: 'Synthetic ancestor timer skill' }).expect(201)).body;
    const goal = (await post('/goals', { skillId: skill.id, type: 'daily', title: 'Synthetic ancestor timer goal', targetQty: 60, startDate: '2026-11-06' }).expect(201)).body;
    const pending = await makeTask({ goalId: goal.id }), running = await makeTask({ goalId: goal.id });
    const startInput = { clientEventId: uuid(), kind: 'started', occurredAt: '2026-11-06T10:00:00+05:30' };
    const started = await post(`/tasks/${running.id}/events`, startInput).expect(200);
    const target = ancestor.includes('goal') ? `/goals/${goal.id}/${ancestor.startsWith('paused') ? 'pause' : 'archive'}`
      : ancestor.includes('skill') ? `/skills/${skill.id}/archive` : `/profiles/${profile.id}/archive`;
    await post(target).expect(200);
    const blockedStart = await event(pending.id, 'started').expect(409);
    expect(blockedStart.body.error.code).toBe(ancestor.includes('goal') ? 'GOAL_NOT_ACTIVE' : 'ARCHIVED_PARENT');
    expect(await db.progressEvent.count({ where: { taskId: pending.id } })).toBe(0);
    const replay = await post(`/tasks/${running.id}/events`, startInput).expect(200);
    expect(replay.body).toMatchObject({ replayed: true, event: { id: started.body.event.id } });
    await event(running.id, 'paused', { occurredAt: '2026-11-06T10:10:00+05:30' }).expect(200);
    await event(running.id, 'resumed', { occurredAt: '2026-11-06T10:20:00+05:30' }).expect(409);
    await event(running.id, 'progress', { minutes: 5, occurredAt: '2026-11-06T10:30:00+05:30' }).expect(200);
    const done = await event(running.id, 'completed', { minutes: 10, occurredAt: '2026-11-06T10:40:00+05:30' }).expect(200);
    expect(done.body.task).toMatchObject({ status: 'completed', actualMinutes: 10, timerStartedAt: null });
    const undo = await correction(running.id, done.body.event.id, { explicitCorrection: true }).expect(200);
    expect(undo.body.task).toMatchObject({ status: 'partial', actualMinutes: 5, timerStartedAt: null });
    await event(running.id, 'cancelled').expect(200);
  });

  it('replays a dedicated undo request with its original server timestamp', async () => {
    const task = await makeTask();
    const done = await event(task.id, 'completed', { minutes: 40 }).expect(200);
    const clientEventId = uuid();
    const first = await post(`/tasks/${task.id}/undo`, { clientEventId }).expect(200);
    expect(first.body.event.referenceEventId).toBe(done.body.event.id); expect(first.body.task.status).toBe('pending');
    clock.now = () => '2026-11-06T12:09:00+05:30';
    const replay = await post(`/tasks/${task.id}/undo`, { clientEventId }).expect(200);
    expect(replay.body.replayed).toBe(true); expect(replay.body.event.id).toBe(first.body.event.id);
    expect(await db.progressEvent.count({ where: { taskId: task.id } })).toBe(2);
  });

  it('protects task quantity history when a goal unit change would mix measurements', async () => {
    const before = (await get(`/goals/${minuteGoalId}`).expect(200)).body;
    const rejected = await patch(`/goals/${minuteGoalId}`, { unit: 'questions', title: 'Rejected mixed-unit rename' });
    expect(rejected.status).toBe(409); expect(rejected.body.error.code).toBe('UNIT_HISTORY_PROTECTED');
    expect((await get(`/goals/${minuteGoalId}`).expect(200)).body).toMatchObject({ unit: 'minutes', title: before.title, ruleVersion: before.ruleVersion });
  });

  it('retracts partial progress, supports correction chains and updates durable caches', async () => {
    const before = await db.goalProgressCache.findUniqueOrThrow({ where: { goalId: countGoalId } });
    const task = await makeTask({ goalId: countGoalId, qty: 10 });
    const first = await event(task.id, 'progress', { minutes: 40, qty: 6 }).expect(200);
    const retract = await correction(task.id, first.body.event.id).expect(200);
    expect(retract.body.task).toMatchObject({ status: 'pending', actualMinutes: 0, completedQty: 0, remainingMinutes: 60 });
    expect(await db.goalProgressCache.findUniqueOrThrow({ where: { goalId: countGoalId } })).toMatchObject({ minutes: before.minutes, qty: before.qty, completions: before.completions });
    const restore = await correction(task.id, retract.body.event.id).expect(200);
    expect(restore.body.task).toMatchObject({ status: 'partial', actualMinutes: 40, completedQty: 6, remainingMinutes: 24 });
    expect(await db.goalProgressCache.findUniqueOrThrow({ where: { goalId: countGoalId } })).toMatchObject({ minutes: before.minutes + 40, qty: before.qty + 6, completions: before.completions });
    const persisted = await db.progressEvent.findUniqueOrThrow({ where: { id: first.body.event.id } });
    expect(persisted).toMatchObject({ kind: 'progress', minutes: 40, qty: 6 });
    expect((await correction(task.id, first.body.event.id, { minutes: 1 })).status).toBe(409);
  });

  it('preserves a completion total after earlier progress correction in task caches and weekly summaries', async () => {
    const baseline = (await get('/today').expect(200)).body.weekly.minutes;
    const cache = await db.goalProgressCache.findUniqueOrThrow({ where: { goalId: countGoalId } });
    const task = await makeTask({ goalId: countGoalId, qty: 10 });
    const progress = await event(task.id, 'progress', { minutes: 40, qty: 4 }).expect(200);
    const completed = await event(task.id, 'completed', { minutes: 60, qty: 10 }).expect(200);
    expect(completed.body.event).toMatchObject({ minutes: 20, qty: 6, reportedTotalMinutes: 60, reportedTotalQty: 10 });
    const retract = await correction(task.id, progress.body.event.id).expect(200);
    expect(retract.body.task).toMatchObject({ status: 'completed', actualMinutes: 60, completedQty: 10 });
    expect((await get('/today').expect(200)).body.weekly.minutes).toBe(baseline + 60);
    expect(await db.goalProgressCache.findUniqueOrThrow({ where: { goalId: countGoalId } })).toMatchObject({ minutes: cache.minutes + 60, qty: cache.qty + 10 });
    await correction(task.id, retract.body.event.id).expect(200);
    expect((await get(`/tasks/${task.id}`).expect(200)).body).toMatchObject({ actualMinutes: 60, completedQty: 10 });
    expect((await get('/today').expect(200)).body.weekly.minutes).toBe(baseline + 60);
    expect(await db.progressEvent.findUniqueOrThrow({ where: { id: completed.body.event.id } })).toMatchObject({ minutes: 20, qty: 6, reportedTotalMinutes: 60, reportedTotalQty: 10 });
  });

  it('keeps later completion totals when an earlier completion undo is corrected', async () => {
    const baseline = (await get('/today').expect(200)).body.weekly.minutes;
    const task = await makeTask();
    const first = await event(task.id, 'completed', { minutes: 60 }).expect(200);
    const undo = await correction(task.id, first.body.event.id).expect(200);
    const second = await event(task.id, 'completed', { minutes: 70 }).expect(200);
    const restored = await correction(task.id, undo.body.event.id).expect(200);
    expect(restored.body.task).toMatchObject({ status: 'completed', actualMinutes: 70, completedQty: 70 });
    expect((await get('/today').expect(200)).body.weekly.minutes).toBe(baseline + 70);
    expect(await db.progressEvent.findUniqueOrThrow({ where: { id: second.body.event.id } })).toMatchObject({ minutes: 70, qty: 70, reportedTotalMinutes: 70, reportedTotalQty: 70 });
    expect((await correction(task.id, first.body.event.id).expect(409)).body.error.code).toBe('CORRECTION_REQUIRED');
    const explicitEarlier = await correction(task.id, first.body.event.id, { explicitCorrection: true }).expect(200);
    expect(explicitEarlier.body.task).toMatchObject({ status: 'completed', actualMinutes: 70, completedQty: 70 });
    expect((await get('/today').expect(200)).body.weekly.minutes).toBe(baseline + 70);
  });

  it('retains implicit count completion totals while omitted time remains without an observation', async () => {
    const count = await makeTask({ goalId: countGoalId, qty: 10 });
    const countProgress = await event(count.id, 'progress', { minutes: 40, qty: 4 }).expect(200);
    const countDone = await event(count.id, 'completed').expect(200);
    expect(countDone.body.event).toMatchObject({ minutes: 0, qty: 6, reportedTotalMinutes: null, reportedTotalQty: 10 });
    expect((await correction(count.id, countProgress.body.event.id).expect(200)).body.task).toMatchObject({ status: 'completed', actualMinutes: 0, completedQty: 10 });
    const minute = await makeTask();
    const minuteProgress = await event(minute.id, 'progress', { minutes: 40 }).expect(200);
    const minuteDone = await event(minute.id, 'completed').expect(200);
    expect(minuteDone.body.event).toMatchObject({ minutes: 0, qty: 0, reportedTotalMinutes: null, reportedTotalQty: null });
    expect((await correction(minute.id, minuteProgress.body.event.id).expect(200)).body.task).toMatchObject({ status: 'completed', actualMinutes: 0, completedQty: 0 });
  });

  it('completes an over-target cumulative count without fabricating an out-of-range observation', async () => {
    const task = await makeTask({ goalId: countGoalId, qty: 10 });
    await event(task.id, 'progress', { qty: 1000000 }).expect(200);
    await event(task.id, 'progress', { qty: 1000000 }).expect(200);
    expect((await event(task.id, 'completed', { qty: 1000000 })).body.error.code).toBe('INVALID_COMPLETION_TOTAL');
    const done = await event(task.id, 'completed').expect(200);
    expect(done.body.task).toMatchObject({ status: 'completed', completedQty: 2000000, actualMinutes: 0 });
    expect(done.body.event).toMatchObject({ qty: 0, reportedTotalQty: 10, reportedTotalMinutes: null });
  });

  it('uses server receipt for exact ten-minute undo and requires an explicit late correction', async () => {
    const task = await makeTask();
    await event(task.id, 'progress', { minutes: 40 }).expect(200);
    const done = await event(task.id, 'completed', { minutes: 60, occurredAt: '2026-11-05T10:00:00+05:30' }).expect(200);
    clock.now = () => '2026-11-06T12:10:00+05:30';
    const undo = await correction(task.id, done.body.event.id).expect(200); expect(undo.body.task).toMatchObject({ status: 'partial', actualMinutes: 40, remainingMinutes: 20 });
    clock.now = () => fixedNow;
    const lateTask = await makeTask(), late = await event(lateTask.id, 'completed', { minutes: 20 }).expect(200);
    clock.now = () => '2026-11-06T12:10:00.001+05:30';
    const expired = await correction(lateTask.id, late.body.event.id); expect(expired.status).toBe(409); expect(expired.body.error.code).toBe('UNDO_WINDOW_EXPIRED');
    expect(await db.progressEvent.count({ where: { taskId: lateTask.id } })).toBe(1);
    const explicit = await correction(lateTask.id, late.body.event.id, { explicitCorrection: true }).expect(200); expect(explicit.body.task.status).toBe('pending');
  });

  it('keeps original timezone/study date and uses historical effective rule IDs after settings edits', async () => {
    const goal = await post('/goals', { skillId, type: 'daily', title: 'Historical event rule', targetQty: 20, startDate: '2026-11-05' }).expect(201);
    const rules = (await get(`/goals/${goal.body.id}/rules`).expect(200)).body;
    await patch(`/goals/${goal.body.id}`, { targetQty: 45, effectiveFrom: '2026-11-06' }).expect(200);
    const task = await makeTask({ goalId: goal.body.id });
    const original = await event(task.id, 'progress', { minutes: 10, occurredAt: '2026-11-06T01:30:00+05:30' }).expect(200);
    expect(original.body.event.localDate).toBe('2026-11-05');
    const stored = await db.progressEvent.findUniqueOrThrow({ where: { id: original.body.event.id } });
    expect(stored.ruleVersionId).toBe(rules[0].id); expect(stored.timezone).toBe('Asia/Kolkata');
    await patch('/settings', { timezone: 'Asia/Tokyo', dayRollover: 0 }).expect(200);
    try {
      const next = await event(task.id, 'progress', { minutes: 5, occurredAt: '2026-11-06T01:30:00+05:30' }).expect(200);
      expect(next.body.event.localDate).toBe('2026-11-06');
      const unchanged = await db.progressEvent.findUniqueOrThrow({ where: { id: original.body.event.id } });
      expect(unchanged).toEqual(stored);
    } finally { await patch('/settings', { timezone: 'Asia/Kolkata', dayRollover: 240 }).expect(200); }
  });

  it('enforces append-only event history, same-owner relationships and critical amounts in PostgreSQL', async () => {
    const task = await makeTask(), response = await event(task.id, 'progress', { minutes: 5 }).expect(200);
    await expect(db.progressEvent.update({ where: { id: response.body.event.id }, data: { minutes: 50 } })).rejects.toThrow('Append-only');
    await expect(db.progressEvent.delete({ where: { id: response.body.event.id } })).rejects.toThrow('Append-only');
    const base = { id: uuid(), userId: ownerId, taskId: task.id, goalId: minuteGoalId, sequence: 99, kind: 'progress', clientEventId: uuid(), occurredAt: new Date('2026-11-06T04:30:00Z'), localDate: new Date('2026-11-06T00:00:00Z'), timezone: 'Asia/Kolkata' };
    await expect(db.progressEvent.create({ data: { ...base, minutes: -1 } })).rejects.toThrow();
    await expect(db.progressEvent.create({ data: { ...base, taskId: foreignTaskId } })).rejects.toThrow();
    await expect(db.progressEvent.create({ data: { ...base, goalId: foreignGoalId } })).rejects.toThrow();
    await expect(db.progressEvent.create({ data: { ...base, kind: 'correction', referenceEventId: foreignEventId } })).rejects.toThrow();
    await expect(db.progressEvent.create({ data: { ...base, reportedTotalMinutes: 20 } })).rejects.toThrow();
    await expect(db.progressEvent.create({ data: { ...base, kind: 'completed', reportedTotalMinutes: -1 } })).rejects.toThrow();
    await expect(db.progressEvent.create({ data: { ...base, kind: 'completed', reportedTotalQty: 1000001 } })).rejects.toThrow();
    expect((await db.progressEvent.findUniqueOrThrow({ where: { id: response.body.event.id } })).minutes).toBe(5);
  });
});

describe('Today study-day and weekly summaries', () => {
  it('includes the next civil night, excludes future work, and replays corrected weekly minutes', async () => {
    const baseline = (await get('/today').expect(200)).body;
    const current = await makeTask();
    const future = await makeTask({ earliestDate: '2026-11-08' });
    const past = await makeTask();
    await event(past.id, 'completed', { minutes: 10, occurredAt: '2026-11-05T10:00:00+05:30' }).expect(200);
    const day = await post('/timetable/slots', { date: '2026-11-06', startMin: 1320, endMin: 1350, taskId: current.id, title: 'Current civil evening' }).expect(201);
    const night = await post('/timetable/slots', { date: '2026-11-07', startMin: 90, endMin: 120, taskId: current.id, title: 'Next civil night' }).expect(201);
    const earlier = await post('/timetable/slots', { date: '2026-11-06', startMin: 60, endMin: 90, layer: 'fixed', title: 'Previous study night' }).expect(201);
    const work = await event(current.id, 'progress', { minutes: 7 }).expect(200);
    const today = (await get('/today').expect(200)).body;
    expect(today.studyDate).toBe('2026-11-06'); expect(today.weekly.minutes).toBe(baseline.weekly.minutes + 17);
    expect(today.slots.map((slot: { id: string }) => slot.id)).toEqual([day.body.id, night.body.id]);
    expect(today.slots.some((slot: { id: string }) => slot.id === earlier.body.id)).toBe(false);
    expect(today.tasks.some((task: { id: string }) => task.id === future.id || task.id === past.id)).toBe(false);
    expect(today.tasks.some((task: { id: string }) => task.id === current.id)).toBe(true);
    await correction(current.id, work.body.event.id).expect(200);
    clock.now = () => '2026-11-07T01:30:00+05:30';
    const late = (await get('/today').expect(200)).body;
    expect(late.studyDate).toBe('2026-11-06'); expect(late.weekly.minutes).toBe(baseline.weekly.minutes + 10);
    expect(late.slots.map((slot: { id: string }) => slot.id)).toEqual([day.body.id, night.body.id]);
    expect((await get('/tasks/today').expect(200)).body.some((task: { id: string }) => task.id === current.id)).toBe(true);
  });
});
