import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { DateTime } from 'luxon';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import request, { type Agent } from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { v7 as uuid } from 'uuid';
import { defaultSettings } from '@kram/shared';
import { addDays, studyDate, weekStartDate } from '@kram/time';
import { expand } from '@kram/recurrence';
let container: StartedTestContainer, db: PrismaClient, app: Express, agent: Agent;
let csrf = '', ownerId = '', profileId = '', skillId = '';
let materialize: typeof import('../../apps/api/src/modules/recurrence/service').materializeOccurrences;
const origin = 'http://localhost:8420', today = studyDate(DateTime.utc().toISO()!), anchor = addDays(today, 2);
const date = (value: string) => DateTime.fromISO(value, { zone: 'UTC' }).toJSDate();
const mutate = (method: 'post' | 'patch' | 'delete', path: string, body: object, version?: number) => {
  const operation = method === 'post' ? agent.post(path) : method === 'patch' ? agent.patch(path) : agent.delete(path);
  operation.set('Origin', origin).set('X-CSRF-Token', csrf).send(body);
  if (version !== undefined) operation.set('If-Match', `"${version}"`);
  return operation;
};
const fixed = (title: string, startMin: number, patch: Record<string, unknown> = {}) => mutate('post', '/api/v1/recurrence/series', { title, dtstartLocal: anchor, rrule: 'FREQ=DAILY;INTERVAL=2', startMin, estMinutes: 30, ...patch });
const exception = (id: string, body: object, version: number) => mutate('post', `/api/v1/recurrence/series/${id}/exceptions`, body, version);
beforeAll(async () => {
  container = await new GenericContainer('postgres:16-bookworm').withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'recurrence-disposable-only', POSTGRES_DB: 'kram' }).withExposedPorts(5432)
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 }).withWaitStrategy(Wait.forHealthCheck()).start();
  Object.assign(process.env, { DATABASE_URL: `postgresql://kram:recurrence-disposable-only@${container.getHost()}:${container.getMappedPort(5432)}/kram`, DATABASE_URL_FILE: '', DOTENV_CONFIG_PATH: devNull,
    NODE_ENV: 'test', APP_URL: origin, COOKIE_SECURE: 'false', SESSION_SECRET: 'recurrence-session-key-at-least-32', SESSION_SECRET_FILE: '', ENCRYPTION_KEY: '88'.repeat(32), ENCRYPTION_KEY_FILE: '', OWNER_SETUP_TOKEN: '', OWNER_SETUP_TOKEN_FILE: '', LOG_LEVEL: 'silent', NTFY_BASE_URL: '', NTFY_TOPIC: '', NTFY_TOKEN: '', NTFY_TOKEN_FILE: '' });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: process.env, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db')); ({ materializeOccurrences: materialize } = await import('../../apps/api/src/modules/recurrence/service'));
  app = (await import('../../apps/api/src/app')).createApp(); agent = request.agent(app);
  csrf = (await agent.get('/api/v1/auth/me')).body.csrfToken;
  const result = await mutate('post', '/api/v1/auth/setup', { email: 'recurrence-owner@kram.test', password: 'synthetic-recurrence-password-42' }).expect(201);
  ownerId = result.body.user.id; csrf = result.body.csrfToken;
  profileId = (await mutate('post', '/api/v1/profiles', { name: 'Synthetic recurrence profile' }).expect(201)).body.id;
  skillId = (await mutate('post', '/api/v1/skills', { profileId, name: 'Synthetic recurrence skill' }).expect(201)).body.id;
}, 120000);
afterAll(async () => { await app?.locals.closeSessions?.(); await db?.$disconnect(); await container?.stop(); });

it('upgrades populated task storage without changing progress, owners or placements', async () => {
  await db.$executeRawUnsafe('CREATE DATABASE recurrence_upgrade_fixture');
  const url = new URL(process.env.DATABASE_URL!); url.pathname = '/recurrence_upgrade_fixture';
  const client = new pg.Client({ connectionString: url.toString() }); await client.connect();
  try {
    const root = 'apps/api/prisma/migrations', current = '202611060006_recurrence_timetable';
    for (const name of (await readdir(root)).filter(name => /^\d/.test(name) && name < current).sort()) await client.query(await readFile(`${root}/${name}/migration.sql`, 'utf8'));
    const owner = uuid(), profile = uuid(), skill = uuid(), goal = uuid(), task = uuid(), event = uuid(), slot = uuid();
    await client.query('INSERT INTO app_user (id,email,"passwordHash",settings,"updatedAt") VALUES ($1,$2,$3,$4,NOW())', [owner, 'upgrade-fixture@kram.test', 'synthetic-upgrade-only', defaultSettings]);
    await client.query('INSERT INTO profile (id,"userId",name,"updatedAt") VALUES ($1,$2,$3,NOW())', [profile, owner, 'Preserved profile']);
    await client.query('INSERT INTO skill (id,"userId","profileId",name,"updatedAt") VALUES ($1,$2,$3,$4,NOW())', [skill, owner, profile, 'Preserved skill']);
    await client.query('INSERT INTO goal (id,"userId","skillId",type,title,"targetQty","startDate","updatedAt") VALUES ($1,$2,$3,$4,$5,30,$6,NOW())', [goal, owner, skill, 'daily', 'Preserved goal', today]);
    await client.query('INSERT INTO task (id,"userId","goalId",title,"estMinutes","remainingMinutes",qty,"completedQty","actualMinutes","earliestDate","periodKey","materializationKey","eventVersion","manualOverride","updatedAt") VALUES ($1,$2,$3,$4,30,20,30,10,10,$5,$6,$7,1,true,NOW())', [task, owner, goal, 'Recorded work', today, 'manual:upgrade', 'upgrade-fixture-key']);
    await client.query('INSERT INTO progress_event (id,"userId","taskId","goalId",kind,sequence,minutes,qty,"occurredAt","localDate",timezone,"clientEventId") VALUES ($1,$2,$3,$4,$5,1,10,10,NOW(),$6,$7,$8)', [event, owner, task, goal, 'progress', today, 'Asia/Kolkata', uuid()]);
    await client.query('INSERT INTO time_slot (id,"userId",date,"startMin","endMin",layer,title,"taskId","updatedAt") VALUES ($1,$2,$3,600,630,$4,$5,$6,NOW())', [slot, owner, today, 'fixed', 'Preserved placement', task]);
    const tables = ['app_user', 'profile', 'skill', 'goal', 'task', 'progress_event', 'time_slot'];
    const before = [];
    for (const table of tables) before.push(await client.query(`SELECT to_jsonb(row) AS value FROM ${table} row`));
    await client.query(await readFile(`${root}/${current}/migration.sql`, 'utf8'));
    for (const [index, table] of tables.entries()) {
      const after = (await client.query(`SELECT to_jsonb(row) - 'occurrenceId' - 'applicationKey' AS value FROM ${table} row`)).rows;
      expect(after).toEqual(before[index]!.rows);
    }
    expect((await client.query('SELECT "occurrenceId" FROM task')).rows).toEqual([{ occurrenceId: null }]);
    expect((await client.query('SELECT COUNT(*)::int AS count FROM recurrence_series')).rows[0].count).toBe(0);
    await expect(client.query('UPDATE progress_event SET minutes=99')).rejects.toThrow(/append.only|immutable|history/i);
  } finally { await client.end(); }
});

describe('anchored recurrence persistence', () => {
  it('materializes recurring goals on exact dates with a separate task horizon and reuses identities', async () => {
    const goal = await mutate('post', '/api/v1/goals', { skillId, type: 'recurring', title: 'Alternate practice', targetQty: 40, startDate: anchor, rrule: 'FREQ=DAILY;INTERVAL=2' }).expect(201);
    const series = await db.recurrenceSeries.findFirstOrThrow({ where: { goalId: goal.body.id } });
    const expected = expand({ id: series.id, rrule: series.rrule, dtstartLocal: anchor, tz: series.tz, status: 'active' }, today, addDays(today, 20));
    expect((await db.occurrence.findMany({ where: { seriesId: series.id }, orderBy: { localDate: 'asc' } })).map(item => item.localDate.toISOString().slice(0, 10))).toEqual(expected.map(item => item.localDate));
    expect((await db.task.findMany({ where: { goalId: goal.body.id }, orderBy: { earliestDate: 'asc' } })).map(task => task.earliestDate.toISOString().slice(0, 10))).toEqual(expected.filter(item => item.localDate <= addDays(today, 13)).map(item => item.localDate));
    const ids = (await db.occurrence.findMany({ where: { seriesId: series.id } })).map(item => item.id).sort();
    await materialize(ownerId, today); await materialize(ownerId, today);
    expect((await db.occurrence.findMany({ where: { seriesId: series.id } })).map(item => item.id).sort()).toEqual(ids);
  });
  it('creates fixed weekdays and rejects a conflicting series atomically', async () => {
    const row = (await fixed('Weekday commitment', 480, { rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' }).expect(201)).body;
    const slots = await db.timeSlot.findMany({ where: { occurrence: { seriesId: row.id } }, orderBy: { date: 'asc' } });
    expect(slots.map(slot => slot.date.toISOString().slice(0, 10))).toEqual(expand({ ...row, status: 'active' }, today, addDays(today, 20)).map(item => item.localDate));
    const before = await db.timeSlot.count();
    await fixed('Conflicting commitment', 490, { rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' }).expect(409);
    expect(await db.recurrenceSeries.count({ where: { title: 'Conflicting commitment' } })).toBe(0); expect(await db.timeSlot.count()).toBe(before);
  });
  it('skips one occurrence without shifting its alternate-day rhythm', async () => {
    const row = (await fixed('Skip a single day', 540).expect(201)).body;
    await exception(row.id, { date: anchor, kind: 'skip' }, row.version).expect(200);
    const slots = await db.timeSlot.findMany({ where: { occurrence: { seriesId: row.id }, archivedAt: null }, orderBy: { date: 'asc' } });
    expect(slots[0]!.date.toISOString().slice(0, 10)).toBe(addDays(anchor, 2));
    expect((await db.recurrenceSeries.findUniqueOrThrow({ where: { id: row.id } })).dtstartLocal).toEqual(date(anchor));
  });
  it('moves one occurrence while retaining its identity and slot id', async () => {
    const row = (await fixed('Move one day', 600).expect(201)).body;
    const old = await db.occurrence.findUniqueOrThrow({ where: { seriesId_originalDate: { seriesId: row.id, originalDate: date(anchor) } }, include: { slot: true } });
    await exception(row.id, { date: anchor, kind: 'move', toDate: addDays(anchor, 1), toStartMin: 630 }, row.version).expect(200);
    const current = await db.occurrence.findUniqueOrThrow({ where: { id: old.id }, include: { slot: true } });
    expect(current.localDate).toEqual(date(addDays(anchor, 1))); expect(current.originalDate).toEqual(date(anchor)); expect(current.slot!.id).toBe(old.slot!.id); expect(current.slot!.startMin).toBe(630);
    expect(await db.occurrence.count({ where: { seriesId: row.id, originalDate: date(anchor) } })).toBe(1);
  });
  it('edits one occurrence and preserves every other occurrence', async () => {
    const row = (await fixed('Edit one day', 690).expect(201)).body;
    await exception(row.id, { date: anchor, kind: 'modify', override: { title: 'One longer session', estMinutes: 40 } }, row.version).expect(200);
    const first = await db.occurrence.findUniqueOrThrow({ where: { seriesId_originalDate: { seriesId: row.id, originalDate: date(anchor) } }, include: { slot: true } });
    expect(first.slot).toMatchObject({ title: 'One longer session', startMin: 690, endMin: 730 });
    const following = await db.occurrence.findUniqueOrThrow({ where: { seriesId_originalDate: { seriesId: row.id, originalDate: date(addDays(anchor, 2)) } }, include: { slot: true } });
    expect(following.slot!.title).toBe('Edit one day');
  });
  it('keeps occurrence edits through moves and keeps the destination through later edits', async () => {
    const row = (await fixed('Edit then move', 420).expect(201)).body;
    const edited = (await exception(row.id, { date: anchor, kind: 'modify', override: { title: 'One edited appointment', estMinutes: 40 } }, row.version).expect(200)).body;
    const moved = (await exception(row.id, { date: anchor, kind: 'move', toDate: addDays(anchor, 1) }, edited.version).expect(200)).body;
    await exception(row.id, { date: anchor, kind: 'modify', override: { estMinutes: 45 } }, moved.version).expect(200);
    const value = await db.occurrence.findUniqueOrThrow({ where: { seriesId_originalDate: { seriesId: row.id, originalDate: date(anchor) } }, include: { slot: true } });
    expect(value.localDate).toEqual(date(addDays(anchor, 1)));
    expect(value.slot).toMatchObject({ title: 'One edited appointment', startMin: 420, endMin: 465 });
  });
  it('protects recorded task work from recurrence regeneration and exceptions', async () => {
    const goal = (await mutate('post', '/api/v1/goals', { skillId, type: 'recurring', title: 'Recorded recurring task', targetQty: 30, startDate: today, rrule: 'FREQ=DAILY' }).expect(201)).body;
    const task = await db.task.findFirstOrThrow({ where: { goalId: goal.id, earliestDate: date(today) } });
    await mutate('post', `/api/v1/tasks/${task.id}/events`, { clientEventId: uuid(), kind: 'progress', minutes: 10, occurredAt: DateTime.utc().toISO() }).expect(200);
    const series = await db.recurrenceSeries.findFirstOrThrow({ where: { goalId: goal.id } });
    await exception(series.id, { date: today, kind: 'skip' }, series.version).expect(409);
    await materialize(ownerId, today);
    expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ actualMinutes: 10, remainingMinutes: 20, archivedAt: null });
  });
  it('splits future commitments and keeps prior slot history intact', async () => {
    const row = (await fixed('Split the future', 780, { rrule: 'FREQ=DAILY;COUNT=8' }).expect(201)).body;
    const old = await db.timeSlot.findFirstOrThrow({ where: { occurrence: { seriesId: row.id, originalDate: date(anchor) } } });
    const result = (await mutate('post', `/api/v1/recurrence/series/${row.id}/future`, { from: addDays(anchor, 3), changes: { title: 'Future title' } }, row.version).expect(200)).body;
    expect(result.next.rrule).toContain('COUNT=5');
    expect(await db.timeSlot.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ archivedAt: null, title: old.title });
    expect((await db.recurrenceSeries.findUniqueOrThrow({ where: { id: row.id } })).until).toEqual(date(addDays(anchor, 2)));
  });
  it('pauses and resumes without shifting the anchor', async () => {
    const row = (await fixed('Pause rhythm', 840).expect(201)).body;
    const paused = (await mutate('post', `/api/v1/recurrence/series/${row.id}/pause`, { date: addDays(anchor, 2) }, row.version).expect(200)).body;
    const resumed = (await mutate('post', `/api/v1/recurrence/series/${row.id}/resume`, { date: addDays(anchor, 5) }, paused.version).expect(200)).body;
    expect(resumed.dtstartLocal).toBe(anchor);
    const dates = (await db.timeSlot.findMany({ where: { occurrence: { seriesId: row.id }, archivedAt: null }, orderBy: { date: 'asc' } })).map(slot => slot.date.toISOString().slice(0, 10));
    expect(dates).not.toContain(addDays(anchor, 2)); expect(dates).not.toContain(addDays(anchor, 4)); expect(dates).toContain(addDays(anchor, 6));
  });
  it('preserves direct timetable overrides across subsequent materialization', async () => {
    const row = (await fixed('Owner timetable override', 900).expect(201)).body;
    const slot = await db.timeSlot.findFirstOrThrow({ where: { occurrence: { seriesId: row.id, originalDate: date(anchor) } } });
    await mutate('patch', `/api/v1/timetable/slots/${slot.id}`, { title: 'Owner changed this one' }, slot.version).expect(200);
    await materialize(ownerId, today);
    expect((await db.timeSlot.findUniqueOrThrow({ where: { id: slot.id } })).title).toBe('Owner changed this one');
    expect((await db.occurrence.findUniqueOrThrow({ where: { id: slot.occurrenceId! } })).manualOverride).toBe(true);
  });
  it('suppresses holidays and restores unstarted projections with the same identity', async () => {
    const row = (await fixed('Holiday-aware rhythm', 960).expect(201)).body;
    const occurrence = await db.occurrence.findUniqueOrThrow({ where: { seriesId_originalDate: { seriesId: row.id, originalDate: date(anchor) } }, include: { slot: true } });
    const holiday = (await mutate('post', '/api/v1/holidays', { date: anchor, title: 'Synthetic holiday' }).expect(201)).body;
    expect((await db.timeSlot.findUniqueOrThrow({ where: { id: occurrence.slot!.id } })).archivedAt).not.toBeNull();
    await mutate('delete', `/api/v1/holidays/${holiday.id}`, {}).expect(200);
    expect((await db.timeSlot.findUniqueOrThrow({ where: { id: occurrence.slot!.id } })).archivedAt).toBeNull();
  });
  it('rejects stale series edits and invalid occurrence dates', async () => {
    const row = (await fixed('Versioned rhythm', 1020).expect(201)).body;
    await exception(row.id, { date: addDays(anchor, 1), kind: 'skip' }, row.version).expect(404);
    await exception(row.id, { date: anchor, kind: 'skip' }, row.version).expect(200);
    await exception(row.id, { date: addDays(anchor, 2), kind: 'skip' }, row.version).expect(412);
  });
  it('splits goal rules atomically, keeps the remaining COUNT and rejects concurrent stale edits', async () => {
    const goal = (await mutate('post', '/api/v1/goals', { skillId, type: 'recurring', title: 'Finite goal rhythm', targetQty: 30, startDate: anchor, rrule: 'FREQ=DAILY;COUNT=8' }).expect(201)).body;
    const series = await db.recurrenceSeries.findFirstOrThrow({ where: { goalId: goal.id } });
    const from = addDays(anchor, 3);
    const attempts = await Promise.all([1, 2].map(index => mutate('post', `/api/v1/recurrence/series/${series.id}/future`, { from, changes: { title: `Future finite goal ${index}` } }, series.version)));
    expect(attempts.map(result => result.status).sort()).toEqual([200, 412]);
    const next = attempts.find(result => result.status === 200)!.body.next;
    expect(next).toMatchObject({ dtstartLocal: from, rrule: 'FREQ=DAILY;COUNT=5' });
    expect(await db.goalRuleVersion.count({ where: { goalId: goal.id } })).toBe(2);
    expect((await db.task.findMany({ where: { goalId: goal.id, archivedAt: null } })).map(task => task.earliestDate.toISOString().slice(0, 10)).sort()).toEqual(Array.from({ length: 8 }, (_, index) => addDays(anchor, index)));
  });
  it('preserves started work without duplicating its day on a goal rule change', async () => {
    const goal = (await mutate('post', '/api/v1/goals', { skillId, type: 'recurring', title: 'Progress across versions', targetQty: 30, startDate: today, rrule: 'FREQ=DAILY' }).expect(201)).body;
    const task = await db.task.findFirstOrThrow({ where: { goalId: goal.id, earliestDate: date(today) } });
    await mutate('post', `/api/v1/tasks/${task.id}/events`, { clientEventId: uuid(), kind: 'progress', minutes: 10, occurredAt: DateTime.utc().toISO() }).expect(200);
    await mutate('patch', `/api/v1/goals/${goal.id}`, { title: 'Edited goal metadata', targetQty: 45 }).expect(200);
    await materialize(ownerId, today);
    expect(await db.task.count({ where: { goalId: goal.id, earliestDate: date(today), archivedAt: null } })).toBe(1);
    expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ actualMinutes: 10, remainingMinutes: 20, archivedAt: null });
    const occurrences = (await agent.get(`/api/v1/recurrence/occurrences?from=${today}&to=${today}`).expect(200)).body.filter((row: { series: { goalId: string } }) => row.series.goalId === goal.id);
    expect(occurrences).toHaveLength(1);
  });
  it('restores same-day pauses and goal pauses without losing anchor or task identity', async () => {
    const goal = (await mutate('post', '/api/v1/goals', { skillId, type: 'recurring', title: 'Same day pause', targetQty: 30, startDate: today, rrule: 'FREQ=DAILY;INTERVAL=2' }).expect(201)).body;
    const original = await db.task.findFirstOrThrow({ where: { goalId: goal.id, earliestDate: date(today) } });
    let row = await db.recurrenceSeries.findFirstOrThrow({ where: { goalId: goal.id } });
    const paused = (await mutate('post', `/api/v1/recurrence/series/${row.id}/pause`, { date: today }, row.version).expect(200)).body;
    await mutate('post', `/api/v1/recurrence/series/${row.id}/resume`, { date: today }, paused.version).expect(200);
    expect(await db.task.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ archivedAt: null });
    await mutate('post', `/api/v1/goals/${goal.id}/pause`, {}).expect(200);
    expect((await db.task.findUniqueOrThrow({ where: { id: original.id } })).archivedAt).not.toBeNull();
    await mutate('post', `/api/v1/goals/${goal.id}/resume`, {}).expect(200);
    row = await db.recurrenceSeries.findUniqueOrThrow({ where: { id: row.id } });
    expect(row.dtstartLocal).toEqual(date(today)); expect(row.pausedRanges).toEqual([]);
    expect(await db.task.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ archivedAt: null });
  });
  it('projects distant occurrences read-only and reports their conflicts', async () => {
    const row = (await fixed('Far future appointment', 1350).expect(201)).body, future = addDays(anchor, 70);
    await mutate('post', '/api/v1/timetable/slots', { date: future, title: 'Distant manual appointment', layer: 'fixed', startMin: 1350, endMin: 1380 }).expect(201);
    const before = { occurrences: await db.occurrence.count(), slots: await db.timeSlot.count() };
    const result = await agent.get(`/api/v1/recurrence/occurrences?from=${future}&to=${addDays(future, 2)}`).expect(200);
    const rows = result.body.filter((item: { seriesId: string }) => item.seriesId === row.id);
    expect(rows[0]).toMatchObject({ virtual: true, status: 'conflict', conflict: [{ title: 'Distant manual appointment' }] });
    expect(rows[1]).toMatchObject({ virtual: true, status: 'scheduled' });
    const slots = (await agent.get(`/api/v1/timetable/global?from=${future}&to=${addDays(future, 2)}`).expect(200)).body;
    expect(slots.filter((slot: { recurrenceSeriesId: string }) => slot.recurrenceSeriesId === row.id)).toHaveLength(1);
    expect({ occurrences: await db.occurrence.count(), slots: await db.timeSlot.count() }).toEqual(before);
  });
  it('keeps a moved-out occurrence out of its original window and protects past holidays', async () => {
    const row = (await fixed('Moved outside window', 180).expect(201)).body, destination = addDays(anchor, 51);
    await exception(row.id, { date: anchor, kind: 'move', toDate: destination }, row.version).expect(200);
    const original = (await agent.get(`/api/v1/recurrence/occurrences?from=${anchor}&to=${anchor}`).expect(200)).body;
    expect(original.some((item: { seriesId: string }) => item.seriesId === row.id)).toBe(false);
    const moved = (await agent.get(`/api/v1/recurrence/occurrences?from=${destination}&to=${destination}`).expect(200)).body;
    expect(moved.find((item: { seriesId: string; originalDate: string }) => item.seriesId === row.id && item.originalDate === anchor)).toMatchObject({ localDate: destination, moved: true });
    const holiday = await db.holiday.create({ data: { id: uuid(), userId: ownerId, date: date(addDays(today, -1)), title: 'Historical holiday fixture' } });
    await mutate('delete', `/api/v1/holidays/${holiday.id}`, {}).expect(409);
  });
  it('retains a past anchor while materializing only the rolling window', async () => {
    const past = addDays(today, -60), row = (await fixed('Past anchor new series', 240, { dtstartLocal: past }).expect(201)).body;
    const rows = await db.occurrence.findMany({ where: { seriesId: row.id }, orderBy: { localDate: 'asc' } });
    expect(row.dtstartLocal).toBe(past); expect(rows[0]!.localDate).toEqual(date(today));
    expect(rows.at(-1)!.localDate).toEqual(date(addDays(today, 20)));
  });
});

describe('templates, copy and ownership', () => {
  const week = weekStartDate(addDays(today, 100));
  const blueprint = { name: 'Synthetic weekly template', kind: 'week', entries: [{ weekday: 1, startMin: 1140, endMin: 1200, title: 'Monday practice', layer: 'reserved', skillId }, { weekday: 3, startMin: 1140, endMin: 1200, title: 'Wednesday practice', layer: 'fixed' }] };
  it('applies a week once and keeps prior applications independent of template edits', async () => {
    const row = (await mutate('post', '/api/v1/timetable/templates', { ...blueprint, entries: blueprint.entries.map(entry => ({ ...entry, ...(entry.layer === 'reserved' ? { skillId } : {}) })) }).expect(201)).body;
    await mutate('post', `/api/v1/timetable/templates/${row.id}/apply`, { anchor: week }, row.version).expect(200);
    const before = await db.timeSlot.findMany({ where: { templateId: row.id } }); expect(before).toHaveLength(2);
    const edited = (await mutate('patch', `/api/v1/timetable/templates/${row.id}`, { ...row, name: 'Edited template', entries: row.entries.map((entry: object) => ({ ...entry, startMin: 1200, endMin: 1260 })) }, row.version).expect(200)).body;
    const retry = await mutate('post', `/api/v1/timetable/templates/${row.id}/apply`, { anchor: week }, row.version).expect(200); expect(retry.body.reused).toBe(true);
    expect(await db.timeSlot.findMany({ where: { templateId: row.id } })).toEqual(before);
    await mutate('post', `/api/v1/timetable/templates/${row.id}/apply`, { anchor: addDays(week, 7) }, edited.version).expect(200);
    expect(await db.timeSlot.count({ where: { templateId: row.id } })).toBe(4);
  });
  it('rolls an entire template application back on a conflict', async () => {
    const target = addDays(week, 21);
    await mutate('post', '/api/v1/timetable/slots', { date: target, startMin: 1230, endMin: 1260, title: 'Existing hard block', layer: 'fixed' }).expect(201);
    const row = (await mutate('post', '/api/v1/timetable/templates', { name: 'Atomic day template', kind: 'day', entries: [{ weekday: 1, startMin: 1140, endMin: 1200, title: 'First new block', layer: 'fixed' }, { weekday: 1, startMin: 1230, endMin: 1260, title: 'Second new block', layer: 'fixed' }] }).expect(201)).body;
    await mutate('post', `/api/v1/timetable/templates/${row.id}/apply`, { anchor: target }, row.version).expect(409);
    expect(await db.timeSlot.count({ where: { templateId: row.id } })).toBe(0); expect(await db.templateApplication.count({ where: { templateId: row.id } })).toBe(0);
  });
  it('copies placements without progress or recurrence links and deduplicates retries', async () => {
    const target = addDays(week, 42), requestId = uuid();
    const count = await db.timeSlot.count({ where: { date: date(anchor), archivedAt: null } });
    const first = await mutate('post', '/api/v1/timetable/copy', { source: anchor, target, days: 1, requestId }).expect(200); expect(first.body.count).toBe(count);
    expect(await db.timeSlot.count({ where: { date: date(target) } })).toBe(count);
    expect((await db.timeSlot.findMany({ where: { date: date(target) } })).every(slot => !slot.taskId && !slot.occurrenceId)).toBe(true);
    const retry = await mutate('post', '/api/v1/timetable/copy', { source: anchor, target, days: 1, requestId }).expect(200); expect(retry.body.reused).toBe(true);
    await mutate('post', '/api/v1/timetable/copy', { source: anchor, target: addDays(target, 1), days: 1, requestId }).expect(409);
  });
  it('enforces owner boundaries for new routes and database references', async () => {
    const foreign = await db.user.create({ data: { id: uuid(), email: 'recurrence-foreign@kram.test', passwordHash: 'fixture-only', isOwner: false, settings: defaultSettings } });
    const profile = await db.profile.create({ data: { id: uuid(), userId: foreign.id, name: 'Foreign profile' } });
    const series = await db.recurrenceSeries.create({ data: { id: uuid(), userId: foreign.id, title: 'Foreign series', rrule: 'FREQ=DAILY', dtstartLocal: date(anchor), effectiveFrom: date(anchor), tz: 'Asia/Kolkata', startMin: 600 } });
    await agent.get(`/api/v1/recurrence/series/${series.id}`).expect(404);
    await exception(series.id, { date: anchor, kind: 'skip' }, series.version).expect(404);
    await fixed('Foreign parent attempt', 1080, { profileId: profile.id }).expect(404);
    await expect(db.recurrenceSeries.create({ data: { id: uuid(), userId: ownerId, profileId: profile.id, title: 'Invalid owner reference', rrule: 'FREQ=DAILY', dtstartLocal: date(anchor), effectiveFrom: date(anchor), tz: 'Asia/Kolkata', startMin: 600 } })).rejects.toThrow();
    await mutate('post', '/api/v1/timetable/templates', { name: 'Foreign template reference', entries: [{ weekday: 1, startMin: 600, endMin: 660, title: 'Foreign owner', profileId: profile.id }] }).expect(404);
  });
  it('copies all seven dates and retains immutable application evidence', async () => {
    const source = addDays(week, 70), target = addDays(source, 7);
    for (const offset of [0, 2, 6]) await mutate('post', '/api/v1/timetable/slots', { date: addDays(source, offset), title: `Week copy day ${offset}`, layer: 'fixed', startMin: 300, endMin: 330 }).expect(201);
    const result = (await mutate('post', '/api/v1/timetable/copy', { source, target, days: 7, requestId: uuid() }).expect(200)).body;
    expect(result.count).toBe(3);
    expect((await db.timeSlot.findMany({ where: { userId: ownerId, date: { gte: date(target), lte: date(addDays(target, 6)) } }, orderBy: { date: 'asc' } })).map(slot => slot.date.toISOString().slice(0, 10))).toEqual([target, addDays(target, 2), addDays(target, 6)]);
    await expect(db.templateApplication.update({ where: { id: result.application.id }, data: { snapshot: {} } })).rejects.toThrow(/append.only|immutable|history/i);
  });
});
