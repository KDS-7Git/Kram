import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { v7 as uuid } from 'uuid';
import type { PrismaClient } from '@prisma/client';
import { defaultSettings, goalSchema } from '@kram/shared';

let container: StartedTestContainer, db: PrismaClient, userId: string, skillId: string;
let materialize: typeof import('../../apps/api/src/modules/tasks/materialization').materializeTasks;
let tasks: typeof import('../../apps/api/src/modules/tasks/service').tasks;
const settings = { ...defaultSettings, timezone: 'UTC', dayRollover: 0, quietHours: { startMin: 0, endMin: 0 } };
const date = (value: string) => new Date(`${value}T00:00:00Z`);

async function goal(extra: Record<string, unknown> = {}) {
  const rules = goalSchema.parse({ skillId, type: 'daily', title: 'Synthetic materialization goal', targetQty: 60, startDate: '2026-11-02', availableDays: [1, 2, 3, 4, 5, 6, 7], ...extra });
  const row = await db.goal.create({ data: { ...rules, id: uuid(), userId, startDate: date(rules.startDate), dueDate: rules.dueDate ? date(rules.dueDate) : null } });
  await db.goalRuleVersion.create({ data: { id: uuid(), userId, goalId: row.id, version: 1, effectiveFrom: row.startDate, rules } });
  return row;
}
async function resource(goalIds: string[]) {
  const row = await db.resource.create({ data: { id: uuid(), userId, skillId, title: 'Synthetic finite course', type: 'course' } });
  await db.goalResource.createMany({ data: goalIds.map(goalId => ({ id: uuid(), userId, goalId, resourceId: row.id })) });
  return row;
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-bookworm').withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'materialization-disposable-test', POSTGRES_DB: 'kram' }).withExposedPorts(5432)
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 }).withWaitStrategy(Wait.forHealthCheck()).start();
  Object.assign(process.env, { DOTENV_CONFIG_PATH: devNull, DATABASE_URL: `postgresql://kram:materialization-disposable-test@${container.getHost()}:${container.getMappedPort(5432)}/kram`, DATABASE_URL_FILE: '', NODE_ENV: 'test', SESSION_SECRET: 'materialization-test-session-secret-32', SESSION_SECRET_FILE: '', ENCRYPTION_KEY: '55'.repeat(32), ENCRYPTION_KEY_FILE: '', OWNER_SETUP_TOKEN_FILE: '', NTFY_BASE_URL: '', NTFY_TOPIC: '', NTFY_TOKEN: '', NTFY_TOKEN_FILE: '', LOG_LEVEL: 'silent' });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: process.env, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db')); ({ materializeTasks: materialize } = await import('../../apps/api/src/modules/tasks/materialization')); ({ tasks } = await import('../../apps/api/src/modules/tasks/service'));
  const { clock } = await import('../../apps/api/src/calendar'); clock.now = () => '2026-11-06T12:00:00.000Z';
  const owner = await db.user.create({ data: { id: uuid(), email: 'materialization-owner@kram.test', passwordHash: 'synthetic-unused-hash', settings, timezone: 'UTC', dayRollover: 0 } }); userId = owner.id;
  const profile = await db.profile.create({ data: { id: uuid(), userId, name: 'Synthetic materialization profile' } });
  const skill = await db.skill.create({ data: { id: uuid(), userId, profileId: profile.id, name: 'Synthetic materialization skill' } }); skillId = skill.id;
}, 120000);
beforeEach(async () => {
  await db.goal.updateMany({ where: { userId }, data: { status: 'archived', archivedAt: new Date() } });
  await db.reminderRule.updateMany({ where: { userId }, data: { enabled: false } });
  await db.user.update({ where: { id: userId }, data: { settings } });
});
afterAll(async () => { await db?.$disconnect(); await container?.stop(); });

describe('rolling task source projection', () => {
  it('creates exactly14 daily dates and reuses every key across concurrent reruns', async () => {
    const g = await goal(); const results = await Promise.all([materialize(userId, '2026-11-06'), materialize(userId, '2026-11-06')]);
    expect(results.map(result => result.created).sort((a, b) => a - b)).toEqual([0, 14]);
    const rows = await db.task.findMany({ where: { goalId: g.id }, orderBy: { earliestDate: 'asc' } }); expect(rows).toHaveLength(14);
    expect(rows[0]!.earliestDate.toISOString().slice(0, 10)).toBe('2026-11-06'); expect(rows.at(-1)!.earliestDate.toISOString().slice(0, 10)).toBe('2026-11-19');
    expect(rows.every(task => task.qty === 60 && task.remainingMinutes === 60)).toBe(true);
  });
  it('splits weekly quotas over eligible days and keeps each week total and deadline', async () => {
    const g = await goal({ type: 'weekly', targetQty: 90, availableDays: [1, 3, 5] }); await materialize(userId, '2026-11-02');
    const rows = await db.task.findMany({ where: { goalId: g.id }, orderBy: { earliestDate: 'asc' } }); expect(rows).toHaveLength(6);
    expect(rows.slice(0, 3).reduce((sum, task) => sum + task.qty, 0)).toBe(90); expect(rows.slice(3).reduce((sum, task) => sum + task.qty, 0)).toBe(90);
    expect(rows[0]!.dueDate?.toISOString().slice(0, 10)).toBe('2026-11-08'); expect(rows[3]!.dueDate?.toISOString().slice(0, 10)).toBe('2026-11-15');
    const ids = rows.map(task => task.id); await materialize(userId, '2026-11-09');
    expect(await db.task.count({ where: { id: { in: ids } } })).toBe(6); expect(await db.task.count({ where: { goalId: g.id } })).toBe(9);
  });
  it('resolves future rule criteria per date without applying them early', async () => {
    const g = await goal({ targetQty: 20 });
    const future = goalSchema.parse({ ...g, startDate: '2026-11-02', dueDate: null, targetQty: 40, availableDays: [1, 2, 3, 4, 5, 6, 7] });
    await db.goalRuleVersion.create({ data: { id: uuid(), userId, goalId: g.id, version: 2, effectiveFrom: date('2026-11-10'), rules: future } });
    await db.goal.update({ where: { id: g.id }, data: { targetQty: 40, ruleVersion: 2 } }); await materialize(userId, '2026-11-06');
    const rows = await db.task.findMany({ where: { goalId: g.id }, orderBy: { earliestDate: 'asc' } });
    expect(rows.slice(0, 4).map(task => task.qty)).toEqual([20, 20, 20, 20]); expect(rows.slice(4).every(task => task.qty === 40)).toBe(true);
  });
  it('preserves count units separately from estimates and splits oversized minute quotas', async () => {
    const count = await goal({ unit: 'pages', targetQty: 3, estMinutes: 30 }); const minutes = await goal({ targetQty: 1000 }); await materialize(userId, '2026-11-06');
    const page = await db.task.findFirstOrThrow({ where: { goalId: count.id } }); expect(page).toMatchObject({ qty: 3, estMinutes: 30 });
    const day = await db.task.findMany({ where: { goalId: minutes.id, earliestDate: date('2026-11-06') } }); expect(day).toHaveLength(2);
    expect(day.reduce((sum, task) => sum + task.qty, 0)).toBe(1000); expect(day.reduce((sum, task) => sum + task.estMinutes, 0)).toBe(1000); expect(day.every(task => task.estMinutes <= 960)).toBe(true);
  });
  it('creates only next leaves, orders prerequisites and advances after completion', async () => {
    const g = await goal(); const r = await resource([g.id]);
    const parent = await db.resourceItem.create({ data: { id: uuid(), userId, resourceId: r.id, title: 'Synthetic chapter', kind: 'chapter', estMinutes: 0 } });
    const ids = Array.from({ length: 17 }, () => uuid());
    await db.resourceItem.createMany({ data: ids.map((id, ordinal) => ({ id, userId, resourceId: r.id, parentItemId: parent.id, ordinal, title: `Synthetic video${ordinal}`, kind: 'video', estMinutes: 30 })) });
    await db.itemDependency.create({ data: { id: uuid(), userId, resourceId: r.id, itemId: ids[0]!, dependsOnItemId: ids[1]! } });
    await materialize(userId, '2026-11-06'); const rows = await db.task.findMany({ where: { goalId: g.id }, orderBy: { earliestDate: 'asc' } }); expect(rows).toHaveLength(14);
    expect(rows[0]!.itemId).toBe(ids[1]); expect(rows[1]!.itemId).toBe(ids[0]); expect(rows.every(task => task.itemId !== parent.id)).toBe(true);
    expect(await db.taskDependency.findFirst({ where: { taskId: rows[1]!.id, dependsOnTaskId: rows[0]!.id } })).not.toBeNull();
    await tasks.event(userId, rows[0]!.id, { clientEventId: uuid(), kind: 'completed', minutes: 30, occurredAt: '2026-11-06T12:00:00.000Z' });
    expect((await materialize(userId, '2026-11-06')).created).toBe(1); expect((await db.task.findUniqueOrThrow({ where: { id: rows[0]!.id } })).status).toBe('completed');
  });
  it('updates unstarted resource work while preserving the baseline of started tasks', async () => {
    const g = await goal(); const r = await resource([g.id]); const ids = [uuid(), uuid()];
    await db.resourceItem.createMany({ data: ids.map((id, ordinal) => ({ id, userId, resourceId: r.id, ordinal, title: `Synthetic original${ordinal}`, estMinutes: 60 })) });
    await materialize(userId, '2026-11-06'); const first = await db.task.findFirstOrThrow({ where: { itemId: ids[0] } }); const second = await db.task.findFirstOrThrow({ where: { itemId: ids[1] } });
    await tasks.event(userId, first.id, { clientEventId: uuid(), kind: 'progress', minutes: 40, occurredAt: '2026-11-06T12:00:00.000Z' });
    await db.resourceItem.updateMany({ where: { id: { in: ids } }, data: { title: 'Synthetic changed title', estMinutes: 80 } }); await materialize(userId, '2026-11-06');
    expect(await db.task.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ title: 'Synthetic original0', estMinutes: 60, actualMinutes: 40, remainingMinutes: 20 });
    expect(await db.task.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ title: 'Synthetic changed title', estMinutes: 80, remainingMinutes: 80 });
  });
  it('archives obsolete unstarted items and keeps started history after source archival', async () => {
    const g = await goal(); const r = await resource([g.id]); const ids = [uuid(), uuid()];
    await db.resourceItem.createMany({ data: ids.map((id, ordinal) => ({ id, userId, resourceId: r.id, ordinal, title: `Synthetic removable${ordinal}`, estMinutes: 60 })) });
    await materialize(userId, '2026-11-06'); const rows = await db.task.findMany({ where: { goalId: g.id }, orderBy: { sortOrder: 'asc' } });
    await tasks.event(userId, rows[0]!.id, { clientEventId: uuid(), kind: 'started', occurredAt: '2026-11-06T12:00:00.000Z' });
    await db.resource.update({ where: { id: r.id }, data: { archivedAt: new Date() } }); const result = await materialize(userId, '2026-11-06'); expect(result.archived).toBe(1);
    expect((await db.task.findUniqueOrThrow({ where: { id: rows[0]!.id } })).archivedAt).toBeNull(); expect((await db.task.findUniqueOrThrow({ where: { id: rows[1]!.id } })).archivedAt).not.toBeNull();
    expect(await db.progressEvent.count({ where: { taskId: rows[0]!.id } })).toBe(1);
  });
  it('keeps separate per-goal resource identities and prerequisite edges', async () => {
    const first = await goal(), second = await goal({ unit: 'videos', targetQty: 2 }); const r = await resource([first.id, second.id]); const ids = [uuid(), uuid()];
    await db.resourceItem.createMany({ data: ids.map((id, ordinal) => ({ id, userId, resourceId: r.id, ordinal, title: `Synthetic shared${ordinal}`, estMinutes: 30, qty: 1 })) });
    await db.itemDependency.create({ data: { id: uuid(), userId, resourceId: r.id, itemId: ids[1]!, dependsOnItemId: ids[0]! } }); await materialize(userId, '2026-11-06');
    for (const g of [first, second]) {
      const rows = await db.task.findMany({ where: { goalId: g.id }, orderBy: { sortOrder: 'asc' } }); expect(rows).toHaveLength(2);
      expect(await db.taskDependency.count({ where: { taskId: rows[1]!.id, dependsOnTaskId: rows[0]!.id } })).toBe(1); expect(rows[0]!.qty).toBe(g.id === first.id ? 30 : 1);
    }
  });
  it('respects pause/start/deadline and leaves recurring occurrence generation unresolved', async () => {
    const bounded = await goal({ startDate: '2026-11-10', dueDate: '2026-11-12' }); const recurring = await goal({ type: 'recurring', rrule: 'FREQ=DAILY;INTERVAL=2' }); const paused = await goal();
    await db.goal.update({ where: { id: paused.id }, data: { status: 'paused' } }); const result = await materialize(userId, '2026-11-06');
    expect(await db.task.count({ where: { goalId: bounded.id } })).toBe(3); expect(await db.task.count({ where: { goalId: paused.id } })).toBe(0); expect(await db.task.count({ where: { goalId: recurring.id } })).toBe(0); expect(result.unresolved).toBeGreaterThan(0);
  });
  it('keeps a completed or skipped finite goal closed across rolling horizons', async () => {
    const g = await goal({ type: 'milestone', targetQty: 1, unit: 'count' }); await materialize(userId, '2026-11-06'); const task = await db.task.findFirstOrThrow({ where: { goalId: g.id } });
    await tasks.event(userId, task.id, { clientEventId: uuid(), kind: 'skipped', occurredAt: '2026-11-06T12:00:00.000Z' });
    await materialize(userId, '2026-11-13'); expect(await db.task.count({ where: { goalId: g.id } })).toBe(1); expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('skipped');
  });
  it('materializes configuration created after the daily durable period already completed', async () => {
    const { MATERIALIZE_QUEUE } = await import('../../apps/api/src/jobs'); const { goals } = await import('../../apps/api/src/modules/goals/service');
    await db.jobRun.create({ data: { id: uuid(), userId, jobName: MATERIALIZE_QUEUE, periodKey: `${userId}:2026-11-06`, status: 'succeeded', startedAt: new Date(), finishedAt: new Date() } });
    const created = await goals.create(userId, { skillId, type: 'daily', title: 'Synthetic late-day configuration', targetQty: 15, startDate: '2026-11-06', availableDays: [1, 2, 3, 4, 5, 6, 7] });
    expect(await db.task.count({ where: { goalId: created.id, archivedAt: null } })).toBe(14);
    expect(created).toMatchObject({ progressQty: 0, progressMinutes: 0 });
    const row = await db.task.findFirstOrThrow({ where: { goalId: created.id } }); expect(row).toMatchObject({ qty: 15, remainingMinutes: 15 });
  });
  it('projects and cancels reminders atomically when notification settings change', async () => {
    const { setSettings } = await import('../../apps/api/src/modules/hierarchy/service');
    const rule = await db.reminderRule.create({ data: { id: uuid(), userId, ownerType: 'global', atLocal: 720 } });
    expect(await db.notification.count({ where: { reminderRuleId: rule.id } })).toBe(0);
    await setSettings(userId, { notificationsEnabled: true });
    expect(await db.notification.count({ where: { reminderRuleId: rule.id, status: 'pending' } })).toBeGreaterThan(0);
    await setSettings(userId, { notificationsEnabled: false });
    expect(await db.notification.count({ where: { reminderRuleId: rule.id, status: 'pending' } })).toBe(0);
    expect(await db.notification.count({ where: { reminderRuleId: rule.id, status: 'cancelled' } })).toBeGreaterThan(0);
  });
  it('rolls back task creation when reminder projection fails in the shared transaction', async () => {
    const g = await goal(); await db.user.update({ where: { id: userId }, data: { settings: { ...settings, notificationsEnabled: true } } });
    await db.reminderRule.create({ data: { id: uuid(), userId, ownerType: 'global', atLocal: 720 } });
    await db.$executeRawUnsafe("CREATE FUNCTION fixture_projection_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture reminder projection failure'; END $$");
    await db.$executeRawUnsafe('CREATE TRIGGER fixture_projection_failure BEFORE INSERT ON notification FOR EACH STATEMENT EXECUTE FUNCTION fixture_projection_failure()');
    try { await expect(materialize(userId, '2026-11-06')).rejects.toThrow('Fixture reminder projection failure'); expect(await db.task.count({ where: { goalId: g.id } })).toBe(0); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER fixture_projection_failure ON notification'); await db.$executeRawUnsafe('DROP FUNCTION fixture_projection_failure()'); }
    expect((await materialize(userId, '2026-11-06')).created).toBe(14);
  });
});
