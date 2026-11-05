import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { devNull, tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { v7 as uuid } from 'uuid';
import type { PrismaClient, Notification } from '@prisma/client';
import request, { type Agent } from 'supertest';
import argon2 from 'argon2';
import { defaultSettings, goalSchema } from '@kram/shared';
import { addDays } from '@kram/time';
import type { Express } from 'express';

let container: StartedTestContainer, db: PrismaClient, stub: Server, apiServer: Server, app: Express, agent: Agent, workspace: string, worker: ChildProcess | undefined;
let userId: string, taskId: string, goalId: string, csrf = '', stubUrl: string;
let service: typeof import('../../apps/api/src/modules/notifications/service');
let closeJobProducer: typeof import('../../apps/api/src/jobs').closeJobProducer;
const messages: { title: string; message: string; topic: string }[] = [];
let responseStatus = 200, invalidReceipt = false, waitForPublish: (() => void) | undefined, releasePublish: Promise<void> | undefined;
const token = 'disposable-local-ntfy-token-42';
const settings = { ...defaultSettings, timezone: 'UTC', dayRollover: 0, quietHours: { startMin: 0, endMin: 0 } };
const configure = () => Object.assign(process.env, { NTFY_BASE_URL: stubUrl, NTFY_TOPIC: 'private-fixture', NTFY_TOKEN: token, NTFY_TOKEN_FILE: '' });

async function notification(fields: Record<string, unknown> = {}): Promise<Notification> {
  return db.notification.create({ data: { id: uuid(), userId, type: 'task_reminder', title: 'Private learning title', body: 'Private learning notes', scheduledFor: new Date(), dedupeKey: uuid(), ...fields } });
}
async function enableNotifications(extra: Record<string, unknown> = {}) {
  await db.user.update({ where: { id: userId }, data: { settings: { ...settings, notificationsEnabled: true, ...extra } } });
}
async function reminderTask(workDate: string) {
  const id = uuid();
  return db.task.create({ data: { id, userId, goalId, title: 'Synthetic anchored reminder task', estMinutes: 30, remainingMinutes: 30, earliestDate: new Date(`${workDate}T00:00:00Z`), periodKey: `manual:${id}`, materializationKey: `manual:${id}` } });
}
async function stopWorker() {
  const running = worker; if (!running || running.exitCode !== null) return;
  running.kill('SIGTERM');
  await new Promise<void>(resolveDone => { running.once('close', () => resolveDone()); setTimeout(() => { running.kill('SIGKILL'); resolveDone(); }, 5000).unref(); });
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kram-notification-test-'));
  stub = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end(); return; }
    const message = JSON.parse(Buffer.concat(chunks).toString()) as typeof messages[number]; messages.push(message);
    waitForPublish?.(); if (releasePublish) await releasePublish;
    res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    res.end(invalidReceipt ? 'not a channel receipt' : JSON.stringify({ id: uuid(), event: 'message', topic: message.topic }));
  });
  stub.listen(0, '127.0.0.1'); await once(stub, 'listening');
  const address = stub.address(); if (!address || typeof address === 'string') throw new Error('Missing local stub port');
  stubUrl = `http://127.0.0.1:${address.port}/`;
  container = await new GenericContainer('postgres:16-bookworm')
    .withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'notification-disposable-test', POSTGRES_DB: 'kram' })
    .withBindMounts([{ source: workspace, target: workspace }]).withExposedPorts(5432)
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 }).withWaitStrategy(Wait.forHealthCheck()).start();
  const url = `postgresql://kram:notification-disposable-test@${container.getHost()}:${container.getMappedPort(5432)}/kram`;
  Object.assign(process.env, { DOTENV_CONFIG_PATH: devNull, DATABASE_URL: url, DATABASE_URL_FILE: '', NODE_ENV: 'test', COOKIE_SECURE: 'false', APP_URL: 'http://localhost:8420', LOG_LEVEL: 'silent', SESSION_SECRET: 'notification-test-session-key-at-least32', SESSION_SECRET_FILE: '', ENCRYPTION_KEY: '44'.repeat(32), ENCRYPTION_KEY_FILE: '', OWNER_SETUP_TOKEN: '', OWNER_SETUP_TOKEN_FILE: '', BACKUP_DIR: workspace, WORKER_HEALTH_FILE: join(workspace, 'worker-health.json'), NTFY_BASE_URL: '', NTFY_TOPIC: '', NTFY_TOKEN: '', NTFY_TOKEN_FILE: '' });
  for (const tool of ['pg_dump', 'pg_restore']) {
    const wrapper = join(workspace, tool);
    await writeFile(wrapper, `#!/bin/sh\nexec docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER -e PGPASSWORD -e PGDATABASE ${container.getId()} ${tool} "$@"\n`, { mode: 0o700 });
    process.env[tool === 'pg_dump' ? 'PG_DUMP_BIN' : 'PG_RESTORE_BIN'] = wrapper;
  }
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: process.env, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db'));
  service = await import('../../apps/api/src/modules/notifications/service');
  ({ closeJobProducer } = await import('../../apps/api/src/jobs'));
  const user = await db.user.create({ data: { id: uuid(), email: 'notification-owner@kram.test', passwordHash: await argon2.hash('disposable-notification-password-42'), settings, timezone: 'UTC', dayRollover: 0 } }); userId = user.id;
  const profile = await db.profile.create({ data: { id: uuid(), userId, name: 'Synthetic reminder profile' } });
  const skill = await db.skill.create({ data: { id: uuid(), userId, profileId: profile.id, name: 'Synthetic reminder skill' } });
  const input = goalSchema.parse({ skillId: skill.id, type: 'daily', title: 'Synthetic reminder goal', targetQty: 30, startDate: DateTime.utc().toISODate() });
  const goal = await db.goal.create({ data: { ...input, id: uuid(), userId, startDate: new Date(`${input.startDate}T00:00:00Z`), dueDate: null } }); goalId = goal.id;
  await db.goalRuleVersion.create({ data: { id: uuid(), userId, goalId, version: 1, effectiveFrom: goal.startDate, rules: input } });
  const task = await db.task.create({ data: { id: uuid(), userId, goalId, title: 'Synthetic task', estMinutes: 30, remainingMinutes: 30, earliestDate: goal.startDate, periodKey: uuid(), materializationKey: uuid() } }); taskId = task.id;
  const { createApp } = await import('../../apps/api/src/app'); app = createApp(); apiServer = createServer(app); apiServer.listen(0, '127.0.0.1'); await once(apiServer, 'listening'); agent = request.agent(apiServer);
  const me = await agent.get('/api/v1/auth/me').expect(200);
  const login = await agent.post('/api/v1/auth/login').set('Origin', 'http://localhost:8420').set('X-CSRF-Token', me.body.csrfToken).send({ email: user.email, password: 'disposable-notification-password-42' }).expect(200); csrf = login.body.csrfToken;
}, 120000);

beforeEach(async () => {
  messages.length = 0; responseStatus = 200; invalidReceipt = false; waitForPublish = undefined; releasePublish = undefined;
  await db.notification.updateMany({ where: { status: { in: ['pending', 'suppressed_quiet_hours'] } }, data: { status: 'cancelled', leaseId: null, leaseUntil: null } });
  await db.reminderRule.updateMany({ data: { enabled: false } });
  await db.user.update({ where: { id: userId }, data: { settings } });
  await db.task.update({ where: { id: taskId }, data: { status: 'pending', archivedAt: null } }); configure();
});

afterAll(async () => {
  await stopWorker();
  for (const server of [apiServer, stub]) if (server?.listening) await new Promise<void>((resolveDone, reject) => server.close(error => error ? reject(error) : resolveDone()));
  if (typeof app?.locals.closeSessions === 'function') await app.locals.closeSessions();
  await closeJobProducer?.(); await db?.$disconnect(); await container?.stop(); if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe('private durable ntfy delivery', () => {
  it('makes no outbound request by default and refuses an unconfigured channel test', async () => {
    Object.assign(process.env, { NTFY_TOPIC: '', NTFY_TOKEN: '' });
    const row = await notification(); await service.dispatchNotifications(new Date(Date.now() + 100));
    expect(messages).toHaveLength(0); expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('cancelled');
    await expect(service.queueTestNotification(userId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_CONFIGURED' });
  });
  it('queues an authenticated explicit test and bypasses disabled general delivery and quiet hours', async () => {
    await db.user.update({ where: { id: userId }, data: { settings: { ...settings, notificationsEnabled: false, quietHours: { startMin: 1, endMin: 1439 } } } });
    const queued = await agent.post('/api/v1/notifications/test').set('Origin', 'http://localhost:8420').set('X-CSRF-Token', csrf).send({}).expect(202);
    expect(queued.body).toMatchObject({ queued: true, notification: { status: 'pending', isTest: true } }); expect(messages).toHaveLength(0);
    await service.dispatchNotifications(new Date(Date.now() + 100));
    expect(messages).toHaveLength(1); expect(messages[0]?.title).toBe('Kram notification test');
    expect((await db.notification.findUniqueOrThrow({ where: { id: queued.body.notification.id } })).status).toBe('sent');
    expect((await agent.get('/api/v1/notifications/status').expect(200)).body).toMatchObject({ configured: true, topic: 'private-fixture' });
  });
  it('protects delivery actions with authentication, CSRF, strict input and owner scope', async () => {
    await request(apiServer).get('/api/v1/notifications/status').expect(401);
    await agent.post('/api/v1/notifications/test').set('Origin', 'http://localhost:8420').send({}).expect(403);
    await agent.post('/api/v1/notifications/test').set('Origin', 'http://localhost:8420').set('X-CSRF-Token', csrf).send({ topic: 'foreign-topic' }).expect(400);
    await agent.post('/api/v1/reminder-rules').set('Origin', 'http://localhost:8420').set('X-CSRF-Token', csrf).send({ ownerType: 'task', ownerId: uuid(), atLocal: 600 }).expect(404);
    expect(messages).toHaveLength(0);
  });
  it('uses a private credential file and a custom proxy path without exposing the token in status', async () => {
    const file = join(workspace, 'fixture-ntfy-token'); await writeFile(file, token, { mode: 0o600 });
    Object.assign(process.env, { NTFY_BASE_URL: `${stubUrl}custom/ntfy`, NTFY_TOKEN: 'wrong-environment-token', NTFY_TOKEN_FILE: file });
    const row = await service.queueTestNotification(userId); await service.dispatchNotifications(new Date(Date.now() + 100));
    expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('sent');
    const status = (await agent.get('/api/v1/notifications/status').expect(200)).body;
    expect(status.baseUrl).toBe(`${stubUrl}custom/ntfy/`); expect(JSON.stringify(status)).not.toContain(token);
    await writeFile(file, '', { mode: 0o600 }); process.env.NTFY_TOKEN = token;
    expect((await service.notificationStatus(userId)).configured).toBe(true);
  });
  it('rejects ambiguous channel URLs and records provider authentication failure', async () => {
    const { ntfyConfiguration } = await import('../../apps/api/src/modules/notifications/channel');
    for (const base of ['file:///tmp/ntfy', 'https://user:password@example.test', 'https://example.test?token=secret', 'https://example.test#topic']) {
      process.env.NTFY_BASE_URL = base; expect(ntfyConfiguration()).toMatchObject({ configured: false, errorCode: 'CHANNEL_CONFIG_INVALID' });
    }
    configure(); await enableNotifications(); responseStatus = 403; const row = await notification();
    await service.dispatchNotifications(new Date(Date.now() + 100));
    expect((await db.notificationAttempt.findFirstOrThrow({ where: { notificationId: row.id } })).errorCode).toBe('CHANNEL_AUTH_FAILED');
  });
  it('applies lock-screen privacy before provider acceptance and stores immutable attempts', async () => {
    await enableNotifications(); const row = await notification(); await service.dispatchNotifications(new Date(Date.now() + 100));
    expect(JSON.stringify(messages)).not.toContain('Private learning');
    const attempts = await db.notificationAttempt.findMany({ where: { notificationId: row.id } }); expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ outcome: 'accepted', httpStatus: 200 });
    await expect(db.notificationAttempt.update({ where: { id: attempts[0]!.id }, data: { outcome: 'changed' } })).rejects.toThrow('Append-only');
    await expect(db.notificationAttempt.delete({ where: { id: attempts[0]!.id } })).rejects.toThrow('Append-only');
  });
  it('suppresses quiet hours then sends at the first allowed minute without consuming a retry', async () => {
    await enableNotifications({ quietHours: { startMin: 600, endMin: 720 } });
    const now = DateTime.utc().set({ hour: 11, minute: 0, second: 0, millisecond: 0 }).toJSDate(); const row = await notification({ scheduledFor: now });
    await service.dispatchNotifications(now); const held = await db.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(held).toMatchObject({ status: 'suppressed_quiet_hours', attemptCount: 0 }); expect(held.nextAttemptAt?.getUTCHours()).toBe(12); expect(messages).toHaveLength(0);
    await service.dispatchNotifications(held.nextAttemptAt!); expect(messages).toHaveLength(1); expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).attemptCount).toBe(1);
  });
  it('delivers after overnight quiet hours and preserves retry eligibility after that delay', async () => {
    await enableNotifications({ quietHours: { startMin: 1320, endMin: 420 } });
    const now = DateTime.utc().set({ hour: 23, minute: 0, second: 0, millisecond: 0 }).toJSDate(); const row = await notification({ scheduledFor: now });
    await service.dispatchNotifications(now); const held = await db.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect((held.nextAttemptAt!.getTime() - now.getTime()) / 3600000).toBe(8); responseStatus = 500;
    await service.dispatchNotifications(held.nextAttemptAt!); const retry = await db.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(retry).toMatchObject({ status: 'pending', attemptCount: 1 }); responseStatus = 200;
    await service.dispatchNotifications(retry.nextAttemptAt!); expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('sent');
    expect(messages).toHaveLength(2);
  });
  it('keeps a quiet-delayed global reminder across the next study-day projection refresh', async () => {
    await enableNotifications({ quietHours: { startMin: 1320, endMin: 420 } });
    const now = DateTime.utc().set({ hour: 23, minute: 0, second: 0, millisecond: 0 }).toJSDate();
    const rule = await db.reminderRule.create({ data: { id: uuid(), userId, ownerType: 'global', atLocal: 1380, repeatPolicy: 'once' } });
    await service.refreshReminders(userId, db, now); await service.dispatchNotifications(now);
    const held = await db.notification.findFirstOrThrow({ where: { reminderRuleId: rule.id, status: 'suppressed_quiet_hours' } });
    const nextDay = new Date(now.getTime() + 7 * 3600000); await service.refreshReminders(userId, db, nextDay);
    expect((await db.notification.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('suppressed_quiet_hours');
    await service.dispatchNotifications(held.nextAttemptAt!); expect((await db.notification.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('sent');
    expect(messages).toHaveLength(1);
  });
  it('sends a task once reminder only once when unchanged work becomes overdue across days', async () => {
    await enableNotifications(); const task = await reminderTask('2026-11-06');
    const rule = await db.reminderRule.create({ data: { id: uuid(), userId, ownerType: 'task', ownerId: task.id, atLocal: 720, repeatPolicy: 'once' } });
    const first = new Date('2026-11-06T12:00:00Z');
    await service.refreshReminders(userId, db, first); await service.dispatchNotifications(first);
    expect(messages).toHaveLength(1);
    for (const day of [7, 8]) {
      const now = new Date(`2026-11-${day.toString().padStart(2, '0')}T12:00:00Z`);
      await service.refreshReminders(userId, db, now); await service.dispatchNotifications(now);
    }
    expect(messages).toHaveLength(1);
    expect(await db.notification.count({ where: { reminderRuleId: rule.id } })).toBe(1);
    expect(await db.notificationAttempt.count({ where: { notification: { reminderRuleId: rule.id } } })).toBe(1);
  });
  it('retains a task once reminder across overnight quiet hours without creating a shifted reminder', async () => {
    await enableNotifications({ quietHours: { startMin: 1320, endMin: 420 } });
    const task = await reminderTask('2026-11-06');
    const rule = await db.reminderRule.create({ data: { id: uuid(), userId, ownerType: 'task', ownerId: task.id, atLocal: 1380, repeatPolicy: 'once' } });
    const now = new Date('2026-11-06T23:00:00Z');
    await service.refreshReminders(userId, db, now); await service.dispatchNotifications(now);
    const held = await db.notification.findFirstOrThrow({ where: { reminderRuleId: rule.id, status: 'suppressed_quiet_hours' } });
    await service.refreshReminders(userId, db, new Date('2026-11-07T06:00:00Z'));
    expect((await db.notification.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('suppressed_quiet_hours');
    await service.dispatchNotifications(held.nextAttemptAt!);
    await service.refreshReminders(userId, db, new Date('2026-11-07T23:00:00Z'));
    await service.dispatchNotifications(new Date('2026-11-08T07:00:00Z'));
    expect(messages).toHaveLength(1);
    expect(await db.notification.count({ where: { reminderRuleId: rule.id } })).toBe(1);
  });
  it('does not fabricate a current-day once reminder for stale work without a prior projection', async () => {
    await enableNotifications(); const task = await reminderTask('2026-11-04');
    const rule = await db.reminderRule.create({ data: { id: uuid(), userId, ownerType: 'task', ownerId: task.id, atLocal: 720, repeatPolicy: 'once' } });
    const now = new Date('2026-11-06T12:00:00Z');
    await service.refreshReminders(userId, db, now); await service.dispatchNotifications(now);
    expect(messages).toHaveLength(0); expect(await db.notification.count({ where: { reminderRuleId: rule.id } })).toBe(0);
  });
  it('claims one row once across concurrent dispatchers', async () => {
    await enableNotifications(); const row = await notification(); const now = new Date(Date.now() + 100);
    await Promise.all([service.dispatchNotifications(now), service.dispatchNotifications(now)]);
    expect(messages).toHaveLength(1); expect(await db.notificationAttempt.count({ where: { notificationId: row.id } })).toBe(1);
  });
  it('recovers an expired lease while leaving a live lease claimed by another worker', async () => {
    await enableNotifications(); const now = new Date(); const live = await notification({ leaseId: uuid(), leaseUntil: new Date(now.getTime() + 120000) });
    const abandoned = await notification({ scheduledFor: new Date(now.getTime() - 1000), leaseId: uuid(), leaseUntil: new Date(now.getTime() - 1) });
    await service.dispatchNotifications(now);
    expect(messages).toHaveLength(1); expect((await db.notification.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('pending');
    expect((await db.notification.findUniqueOrThrow({ where: { id: abandoned.id } })).status).toBe('sent');
  });
  it('retries at1/5/30minutes and records a terminal fourth failure', async () => {
    await enableNotifications(); responseStatus = 500; const row = await notification(); const now = new Date(row.scheduledFor);
    await service.dispatchNotifications(now); let state = await db.notification.findUniqueOrThrow({ where: { id: row.id } }); expect(state.nextAttemptAt!.getTime() - now.getTime()).toBe(60000);
    expect((await service.dispatchNotifications(new Date(now.getTime() + 59000))).claimed).toBe(0);
    for (const delay of [5, 30, null]) { const due = state.nextAttemptAt!; await service.dispatchNotifications(due); state = await db.notification.findUniqueOrThrow({ where: { id: row.id } }); expect(state.nextAttemptAt ? (state.nextAttemptAt.getTime() - due.getTime()) / 60000 : null).toBe(delay); }
    expect(state).toMatchObject({ status: 'failed', attemptCount: 4 }); expect(messages).toHaveLength(4); expect(await db.notificationAttempt.count({ where: { notificationId: row.id } })).toBe(4);
  });
  it('rejects a successful HTTP response without an ntfy receipt', async () => {
    await enableNotifications(); invalidReceipt = true; const row = await notification(); await service.dispatchNotifications(new Date(Date.now() + 100));
    expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('pending');
    expect((await db.notificationAttempt.findFirstOrThrow({ where: { notificationId: row.id } })).errorCode).toBe('CHANNEL_RESPONSE_INVALID');
  });
  it('preserves cancellation while an accepted publish is already in flight', async () => {
    await enableNotifications(); const row = await notification({ taskId });
    let release: () => void = () => undefined; releasePublish = new Promise<void>(resolveDone => { release = resolveDone; });
    const begun = new Promise<void>(resolveDone => { waitForPublish = resolveDone; });
    const dispatch = service.dispatchNotifications(new Date(Date.now() + 100)); await begun;
    await db.$transaction(async tx => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`; await tx.task.update({ where: { id: taskId }, data: { status: 'completed' } }); await service.refreshReminders(userId, tx); });
    release(); await dispatch;
    expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('cancelled');
    expect((await db.notificationAttempt.findFirstOrThrow({ where: { notificationId: row.id } })).outcome).toBe('accepted');
  });
  it('repeats only open work and cancels the next repeat on completion', async () => {
    await enableNotifications(); const now = DateTime.utc(); const rule = await service.reminders.create(userId, { ownerType: 'task', ownerId: taskId, atLocal: now.hour * 60 + now.minute, repeatPolicy: 'until_completed' });
    const first = await db.notification.findFirstOrThrow({ where: { reminderRuleId: rule.id, status: 'pending' } }); await service.dispatchNotifications(first.scheduledFor);
    const repeat = await db.notification.findFirstOrThrow({ where: { reminderRuleId: rule.id, status: 'pending' } }); expect((repeat.scheduledFor.getTime() - first.scheduledFor.getTime()) / 60000).toBe(30);
    await db.task.update({ where: { id: taskId }, data: { status: 'completed' } }); await service.refreshReminders(userId);
    await service.dispatchNotifications(repeat.scheduledFor); expect(messages).toHaveLength(1); expect((await db.notification.findUniqueOrThrow({ where: { id: repeat.id } })).status).toBe('cancelled');
  });
  it('restores only one future repeat after completion is undone and preserves sent history', async () => {
    await enableNotifications(); const now = DateTime.utc();
    const rule = await service.reminders.create(userId, { ownerType: 'task', ownerId: taskId, atLocal: now.hour * 60 + now.minute, repeatPolicy: 'until_completed' });
    const initial = await db.notification.findFirstOrThrow({ where: { reminderRuleId: rule.id, status: 'pending' } }); await service.dispatchNotifications(initial.scheduledFor);
    await db.task.update({ where: { id: taskId }, data: { status: 'completed' } }); await service.refreshReminders(userId);
    await db.task.update({ where: { id: taskId }, data: { status: 'pending' } }); const resumedAt = new Date(initial.scheduledFor.getTime() + 10000);
    await service.refreshReminders(userId, db, resumedAt); await service.refreshReminders(userId, db, resumedAt);
    const renewed = await db.notification.findMany({ where: { reminderRuleId: rule.id, status: 'pending' } }); expect(renewed).toHaveLength(1);
    expect(renewed[0]!.scheduledFor.getTime() - resumedAt.getTime()).toBe(30 * 60000);
    expect((await db.notification.findUniqueOrThrow({ where: { id: initial.id } })).status).toBe('sent');
    expect(await db.notificationAttempt.count({ where: { notificationId: initial.id } })).toBe(1);
    await service.dispatchNotifications(renewed[0]!.scheduledFor); expect(messages).toHaveLength(2);
  });
  it('records successful durable completion once and never records a failed job as complete', async () => {
    const { runDurableJob } = await import('../../apps/worker/src/domain-jobs'); let executions = 0; const period = uuid();
    await runDurableJob('fixture-idempotency', period, userId, async () => { executions++; });
    expect((await runDurableJob('fixture-idempotency', period, userId, async () => { executions++; })).reused).toBe(true); expect(executions).toBe(1);
    const fact = await db.jobRun.findUniqueOrThrow({ where: { jobName_periodKey: { jobName: 'fixture-idempotency', periodKey: period } } });
    await expect(db.jobRun.update({ where: { id: fact.id }, data: { status: 'changed' } })).rejects.toThrow('Append-only');
    const failedPeriod = uuid();
    await expect(runDurableJob('fixture-failure', failedPeriod, userId, async () => { throw new Error('simulated job failure'); })).rejects.toThrow('simulated job failure');
    expect(await db.jobRun.count({ where: { jobName: 'fixture-failure' } })).toBe(0);
    expect((await runDurableJob('fixture-failure', failedPeriod, userId, async () => undefined)).reused).toBe(false);
  });
  it('delivers and catches up task jobs from the actual worker, then reuses completed periods after restart', async () => {
    const today = DateTime.utc().toISODate()!;
    const { MATERIALIZE_QUEUE } = await import('../../apps/api/src/jobs');
    await db.jobRun.create({ data: { id: uuid(), userId, jobName: MATERIALIZE_QUEUE, periodKey: `${userId}:${addDays(today, -2)}`, status: 'succeeded', startedAt: new Date(), finishedAt: new Date() } });
    const launchWorker = () => {
      let output = ''; worker = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'apps/worker/src/index.ts'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      worker.stdout?.on('data', chunk => { output += String(chunk); }); worker.stderr?.on('data', chunk => { output += String(chunk); });
      return () => output;
    };
    const waitForDeliveryAndPeriods = async (id: string, readOutput: () => string) => {
      const until = Date.now() + 25000;
      while (Date.now() < until) {
        const stored = await db.notification.findUniqueOrThrow({ where: { id } });
        const periods = await db.jobRun.count({ where: { userId, jobName: MATERIALIZE_QUEUE } });
        if (stored.status === 'sent' && periods === 3) { expect(worker?.exitCode).toBeNull(); return; }
        if (worker?.exitCode !== null) throw new Error(`Worker stopped: ${readOutput()}`);
        await new Promise(resolveDone => setTimeout(resolveDone, 100));
      }
      throw new Error(`Worker did not complete delivery/catch-up: ${readOutput()}`);
    };
    const first = await service.queueTestNotification(userId); await waitForDeliveryAndPeriods(first.id, launchWorker()); expect(messages).toHaveLength(1);
    const periods = await db.jobRun.findMany({ where: { userId, jobName: MATERIALIZE_QUEUE }, orderBy: { periodKey: 'asc' } });
    expect(periods.map(run => run.periodKey)).toEqual([-2, -1, 0].map(days => `${userId}:${addDays(today, days)}`));
    expect(periods[1]!.finishedAt!.getTime()).toBeLessThanOrEqual(periods[2]!.startedAt.getTime());
    const beforeRestart = await db.task.count({ where: { userId, goalId } }); expect(beforeRestart).toBeGreaterThan(1);
    await stopWorker(); const second = await service.queueTestNotification(userId); await waitForDeliveryAndPeriods(second.id, launchWorker());
    expect(messages).toHaveLength(2); expect(await db.task.count({ where: { userId, goalId } })).toBe(beforeRestart);
    expect(await db.jobRun.count({ where: { userId, jobName: MATERIALIZE_QUEUE } })).toBe(3);
  }, 60000);
});
