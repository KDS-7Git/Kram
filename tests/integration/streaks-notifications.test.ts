import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { devNull } from 'node:os';
import { v7 as uuid } from 'uuid';
import type { PrismaClient, Notification } from '@prisma/client';
import request, { type Agent } from 'supertest';
import type { Express } from 'express';
import { defaultSettings } from '@kram/shared';
let container: StartedTestContainer, db: PrismaClient, app: Express, agent: Agent, stub: Server;
let clock: { now: () => string }, previousClock: () => string, csrf = '', ownerId = '', foreignId = '', foreignGoal = '', goalId = '', profileId = '';
let streak: typeof import('../../apps/api/src/streaks/service'), full: typeof import('../../apps/api/src/streaks/full-notifications'), channels: typeof import('../../apps/api/src/streaks/channel-service'), crypto: typeof import('../../apps/api/src/streaks/channels');
const fixed = new Date('2026-11-06T12:00:00Z'), origin = 'http://localhost:8420', token = '123456789:disposable-test-bot-token-123456789';
const settings = { ...defaultSettings, timezone: 'UTC', dayRollover: 0, restDays: [], quietHours: { startMin: 0, endMin: 0 }, notificationsEnabled: false, planReadyMin: 720 };
const rule = { measure: 'minutes', threshold: 30, period: 'day', restWeekdays: [] };
const messages: { channel: string; body: Record<string, unknown> }[] = [];
let ntfyStatus = 200;
let linkingUpdateId = 1000;
const get = (path: string) => agent.get(`/api/v1${path}`);
const post = (path: string, body: Record<string, unknown> = {}) => agent.post(`/api/v1${path}`).set('Origin', origin).set('X-CSRF-Token', csrf).send(body);
async function task() { const id = uuid(); return db.task.create({ data: { id, userId: ownerId, goalId, title: 'Synthetic private task', estMinutes: 60, remainingMinutes: 60, earliestDate: new Date('2026-11-01'), dueDate: new Date('2026-11-08'), materializationKey: id, periodKey: id } }); }
async function progress(taskId: string, date: string, minutes: number, fields: Record<string, unknown> = {}) { const sequence = await db.progressEvent.count({ where: { taskId } }) + 1; return db.progressEvent.create({ data: { id: uuid(), userId: ownerId, goalId, taskId, kind: 'progress', minutes, qty: minutes, sequence, localDate: new Date(date), occurredAt: new Date(`${date}T12:00:00Z`), clientEventId: uuid(), timezone: 'UTC', ...fields } }); }
async function notification(channel = 'ntfy', taskId: string | null = null, fields: Record<string, unknown> = {}): Promise<Notification> { return db.notification.create({ data: { id: uuid(), userId: ownerId, channel, taskId, type: 'task_reminder', title: 'Synthetic private title', body: 'Synthetic private notes', scheduledFor: fixed, dedupeKey: uuid(), ...fields } }); }
async function enable(extra: Record<string, unknown> = {}) { await db.user.update({ where: { id: ownerId }, data: { settings: { ...settings, notificationsEnabled: true, ...extra } } }); }
async function link(chat = 42) { const code = await channels.linkTelegram(ownerId, { token }, fixed); const row = await db.userChannel.findFirstOrThrow({ where: { userId: ownerId, channel: 'telegram' } }); await channels.handleTelegramUpdate(row.id, { update_id: linkingUpdateId++, message: { text: code.command, chat: { id: chat, type: 'private' }, from: { id: chat } } }, fixed); return row.id; }
beforeAll(async () => {
  stub = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()); const telegram = req.url?.includes(`/bot${token}/`); messages.push({ channel: telegram ? 'telegram' : 'ntfy', body }); res.writeHead(telegram ? 200 : ntfyStatus, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(telegram ? { ok: true, result: req.url?.endsWith('/getUpdates') ? [] : { message_id: 9, id: 7 } } : { id: uuid(), topic: body.topic })); });
  stub.listen(0, '127.0.0.1'); await once(stub, 'listening'); const address = stub.address(); if (!address || typeof address === 'string') throw new Error('No stub port'); const base = `http://127.0.0.1:${address.port}`;
  container = await new GenericContainer('postgres:16-bookworm').withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'streaks-disposable-only', POSTGRES_DB: 'kram' }).withExposedPorts(5432).withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 }).withWaitStrategy(Wait.forHealthCheck()).start();
  Object.assign(process.env, { DOTENV_CONFIG_PATH: devNull, DATABASE_URL: `postgresql://kram:streaks-disposable-only@${container.getHost()}:${container.getMappedPort(5432)}/kram`, DATABASE_URL_FILE: '', NODE_ENV: 'test', APP_URL: origin, COOKIE_SECURE: 'false', SESSION_SECRET: 'streak-test-session-key-at-least32characters', SESSION_SECRET_FILE: '', ENCRYPTION_KEY: '77'.repeat(32), ENCRYPTION_KEY_FILE: '', OWNER_SETUP_TOKEN: '', OWNER_SETUP_TOKEN_FILE: '', LOG_LEVEL: 'silent', NTFY_BASE_URL: base, NTFY_TOPIC: 'disposable-ntfy-fixture', NTFY_TOKEN: 'disposable-private-ntfy-token', NTFY_TOKEN_FILE: '', TELEGRAM_TEST_BASE_URL: base });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: process.env, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db')); ({ clock } = await import('../../apps/api/src/calendar')); previousClock = clock.now; clock.now = () => fixed.toISOString();
  streak = await import('../../apps/api/src/streaks/service'); full = await import('../../apps/api/src/streaks/full-notifications'); channels = await import('../../apps/api/src/streaks/channel-service'); crypto = await import('../../apps/api/src/streaks/channels');
  const { createApp } = await import('../../apps/api/src/app'); app = createApp(); agent = request.agent(app); csrf = (await get('/auth/me').expect(200)).body.csrfToken;
  const auth = await post('/auth/setup', { email: 'streak-owner@kram.test', password: 'disposable-streak-owner-password-42' }).expect(201); ownerId = auth.body.user.id; csrf = auth.body.csrfToken;
  const foreign = await db.user.create({ data: { id: uuid(), email: 'streak-foreign@kram.test', passwordHash: 'fixture', isOwner: false, settings } }); foreignId = foreign.id;
  const p = await db.profile.create({ data: { id: uuid(), userId: foreignId, name: 'Foreign profile' } }), s = await db.skill.create({ data: { id: uuid(), userId: foreignId, profileId: p.id, name: 'Foreign skill' } }); foreignGoal = (await db.goal.create({ data: { id: uuid(), userId: foreignId, skillId: s.id, type: 'daily', title: 'Foreign goal', targetQty: 30, startDate: new Date('2026-11-01') } })).id;
}, 120000);
beforeEach(async () => {
  clock.now = () => fixed.toISOString(); messages.length = 0; ntfyStatus = 200;
  await db.user.update({ where: { id: ownerId }, data: { settings, timezone: 'UTC', dayRollover: 0 } });
  await db.streakDef.updateMany({ where: { userId: ownerId }, data: { status: 'archived' } }); await db.goal.updateMany({ where: { userId: ownerId }, data: { status: 'paused' } });
  await db.planningBreak.deleteMany({ where: { userId: ownerId } });
  await db.notification.updateMany({ where: { userId: ownerId, status: { in: ['pending', 'suppressed_quiet_hours'] } }, data: { status: 'cancelled', leaseId: null, leaseUntil: null } }); await db.reminderRule.updateMany({ where: { userId: ownerId }, data: { enabled: false } });
  await db.userChannel.deleteMany({ where: { userId: ownerId, channel: 'ntfy' } });
  await db.userChannel.updateMany({ where: { userId: ownerId, channel: 'telegram' }, data: { enabled: false, verifiedAt: null, linkCodeHash: null, linkExpiresAt: null } });
  const p = await db.profile.create({ data: { id: uuid(), userId: ownerId, name: 'Synthetic streak profile' } }); profileId = p.id;
  const skill = await db.skill.create({ data: { id: uuid(), userId: ownerId, profileId, name: 'Synthetic streak skill' } });
  goalId = (await db.goal.create({ data: { id: uuid(), userId: ownerId, skillId: skill.id, type: 'milestone', title: 'Synthetic streak goal', unit: 'minutes', targetQty: 60, startDate: new Date('2026-11-01'), dueDate: new Date('2026-11-08') } })).id;
});
afterAll(async () => { if (clock) clock.now = previousClock; if (app?.locals.closeSessions) await app.locals.closeSessions(); await db?.$disconnect(); await container?.stop(); if (stub?.listening) await new Promise<void>(resolve => stub.close(() => resolve())); });
describe('stored streak evaluation and correction', () => {
  it('replays closed periods, keeps hashes idempotent and preserves correction reasons', async () => {
    const t = await task(); const work = await progress(t.id, '2026-11-04', 30);
    const definition = await streak.streaks.create(ownerId, { title: 'Fixture daily', scope: 'goal', scopeId: goalId, startDate: '2026-11-04', rule }, fixed);
    expect(definition.records.map(row => row.result)).toEqual(['met', 'missed']);
    expect(await streak.evaluateStreaks(ownerId, db, fixed)).toEqual({ created: 0, corrected: 0 });
    await progress(t.id, '2026-11-06', 0, { kind: 'correction', qty: 0, referenceEventId: work.id });
    expect(await streak.evaluateStreaks(ownerId, db, fixed)).toEqual({ created: 1, corrected: 1 });
    const rows = await streak.streaks.records(ownerId, definition.id); expect(rows).toHaveLength(3); expect(rows.at(-1)).toMatchObject({ result: 'missed', correctsRecordId: definition.records[0]!.id, beforeReason: definition.records[0]!.reason });
    await expect(db.streakRecord.update({ where: { id: rows[0]!.id }, data: { reason: 'Rewrite' } })).rejects.toThrow(/append|immutable/i);
  });
  it('version edits preserve the past and reject a backdated change', async () => {
    const definition = await streak.streaks.create(ownerId, { title: 'Fixture rule version', scope: 'goal', scopeId: goalId, startDate: '2026-11-04', rule }, fixed);
    await expect(streak.streaks.edit(ownerId, definition.id, { rule: { ...rule, threshold: 45 }, effectiveFrom: '2026-11-05' }, fixed)).rejects.toMatchObject({ code: 'HISTORY_IMMUTABLE' });
    const changed = await streak.streaks.edit(ownerId, definition.id, { rule: { ...rule, threshold: 45 }, effectiveFrom: '2026-11-07' }, fixed); expect(changed.rules).toHaveLength(2); expect(changed.records).toEqual(definition.records);
    await expect(db.streakRuleVersion.delete({ where: { id: changed.rules[0]!.id } })).rejects.toThrow(/append|immutable/i);
  });
  it('marks missing review provisional and reconciles it without a fabricated miss', async () => {
    const t = await task(); await progress(t.id, '2026-11-05', 30); await db.task.update({ where: { id: t.id }, data: { unverified: true } });
    const definition = await streak.streaks.create(ownerId, { title: 'Provisional', scope: 'goal', scopeId: goalId, startDate: '2026-11-05', rule }, fixed); expect(definition.records[0]).toMatchObject({ provisional: true }); expect(definition.summary).toMatchObject({ met: 0, missed: 0 });
    await db.task.update({ where: { id: t.id }, data: { unverified: false } }); await streak.evaluateStreaks(ownerId, db, fixed); expect((await streak.streaks.get(ownerId, definition.id)).records[0]).toMatchObject({ result: 'met', provisional: false });
  });
  it('uses declared planning breaks as rest without changing historical rules', async () => {
    await db.planningBreak.create({ data: { id: uuid(), userId: ownerId, fromDate: new Date('2026-11-04'), toDate: new Date('2026-11-05'), reason: 'Synthetic break', choices: [] } });
    const definition = await streak.streaks.create(ownerId, { title: 'Break-aware', scope: 'goal', scopeId: goalId, startDate: '2026-11-04', rule }, fixed); expect(definition.records.map(row => row.result)).toEqual(['rest', 'rest']);
  });
  it('enforces owner scope through API and SQL ownership checks', async () => {
    await request(app).get('/api/v1/streaks').expect(401); await post('/streaks', { title: 'Foreign', scope: 'goal', scopeId: foreignGoal, rule }).expect(404);
    await expect(db.streakDef.create({ data: { id: uuid(), userId: ownerId, title: 'Foreign SQL', scope: 'goal', scopeId: foreignGoal, startDate: fixed } })).rejects.toThrow(/owner/i);
    await agent.post('/api/v1/channels/telegram/link-code').set('Origin', origin).send({ token }).expect(403);
    expect(JSON.stringify((await get('/channels').expect(200)).body)).not.toContain(token);
  });
  it('preserves reviewed progress when the same task has unknown work on a later day', async () => {
    const t = await task(); await progress(t.id, '2026-11-04', 30);
    await db.dailyReview.create({ data: { id: uuid(), userId: ownerId, date: new Date('2026-11-04'), state: 'closed', summary: { decisions: [{ taskId: t.id, decision: 'partial' }] }, closedAt: new Date() } });
    const definition = await streak.streaks.create(ownerId, { title: 'Cross-day practice', scope: 'goal', scopeId: goalId, startDate: '2026-11-04', rule }, fixed); const first = definition.records.find(row => row.periodStart === '2026-11-04')!; expect(first).toMatchObject({ result: 'met', value: 30, provisional: false });
    await db.task.update({ where: { id: t.id }, data: { unverified: true } }); await db.dailyReview.create({ data: { id: uuid(), userId: ownerId, date: new Date('2026-11-05'), state: 'unverified', summary: { unreported: 1, unreportedTaskIds: [t.id] } } });
    await streak.evaluateStreaks(ownerId, db, fixed); const after = await streak.streaks.get(ownerId, definition.id); expect(after.records.find(row => row.periodStart === '2026-11-04')).toEqual(first); expect(after.records.find(row => row.periodStart === '2026-11-05')).toMatchObject({ provisional: true });
    await progress(t.id, '2026-11-06', 10); await db.task.update({ where: { id: t.id }, data: { unverified: false } }); await streak.evaluateStreaks(ownerId, db, fixed); expect((await streak.streaks.get(ownerId, definition.id)).records.find(row => row.periodStart === '2026-11-05')).toMatchObject({ provisional: true });
    await db.dailyReview.update({ where: { userId_date: { userId: ownerId, date: new Date('2026-11-05') } }, data: { state: 'closed', summary: { decisions: [{ taskId: t.id, decision: 'partial' }] }, closedAt: new Date() } }); await streak.evaluateStreaks(ownerId, db, fixed); expect((await streak.streaks.get(ownerId, definition.id)).records.find(row => row.periodStart === '2026-11-05')).toMatchObject({ provisional: false, result: 'missed' });
  });
  it('keeps weekly records after the owner changes the current week-start setting', async () => {
    const t = await task(); await progress(t.id, '2026-10-27', 30);
    const definition = await streak.streaks.create(ownerId, { title: 'Stable weeks', scope: 'goal', scopeId: goalId, startDate: '2026-10-26', rule: { ...rule, period: 'week' } }, fixed); const records = await streak.streaks.records(ownerId, definition.id);
    await db.user.update({ where: { id: ownerId }, data: { settings: { ...settings, weekStart: 7 } } }); expect(await streak.evaluateStreaks(ownerId, db, fixed)).toEqual({ created: 0, corrected: 0 }); expect(await streak.streaks.records(ownerId, definition.id)).toEqual(records);
  });
  it('uses the goal rule stamped on old quantity progress after a later unit change', async () => {
    await db.goal.update({ where: { id: goalId }, data: { unit: 'pages' } }); const version = await db.goalRuleVersion.create({ data: { id: uuid(), userId: ownerId, goalId, version: 1, effectiveFrom: new Date('2026-11-01'), rules: { unit: 'pages' } } }); const t = await task(); await progress(t.id, '2026-11-05', 0, { qty: 10, ruleVersionId: version.id });
    const definition = await streak.streaks.create(ownerId, { title: 'Historical pages', scope: 'goal', scopeId: goalId, startDate: '2026-11-05', rule: { ...rule, measure: 'quantity', unit: 'pages', threshold: 10 } }, fixed); expect(definition.records[0]).toMatchObject({ result: 'met', value: 10 });
    await db.goal.update({ where: { id: goalId }, data: { unit: 'videos' } }); expect(await streak.evaluateStreaks(ownerId, db, fixed)).toEqual({ created: 0, corrected: 0 }); expect((await streak.streaks.get(ownerId, definition.id)).records).toEqual(definition.records);
  });
});
describe('private, explicit full notification delivery', () => {
  it('makes no outbound calls by default and preserves disabled-channel explicit tests', async () => {
    await notification(); await full.dispatchFullNotifications(fixed); await channels.pollTelegramUpdates(fixed); expect(messages).toHaveLength(0);
    await channels.patchChannel(ownerId, 'ntfy', { enabled: false }); const test = await channels.testChannel(ownerId, 'ntfy'); await full.dispatchFullNotifications(new Date(test.scheduledFor.getTime() + 1)); expect(messages.filter(message => message.channel === 'ntfy')).toHaveLength(1);
  });
  it('protects encrypted credentials with owner/channel associated data', async () => {
    const encrypted = crypto.encryptChannelConfig(ownerId, 'telegram', { token, chatId: '42' }); expect(encrypted).not.toContain(token); expect(crypto.decryptChannelConfig(ownerId, 'telegram', encrypted)).toEqual({ token, chatId: '42' });
    expect(() => crypto.decryptChannelConfig(foreignId, 'telegram', encrypted)).toThrow('unlocked'); expect(() => crypto.decryptChannelConfig(ownerId, 'ntfy', encrypted)).toThrow('unlocked');
  });
  it('links a private owner chat once, rejects group linking and expired codes', async () => {
    const code = await channels.linkTelegram(ownerId, { token }, fixed), row = await db.userChannel.findFirstOrThrow({ where: { userId: ownerId, channel: 'telegram' } });
    expect(await channels.handleTelegramUpdate(row.id, { update_id: 101, message: { text: code.command, chat: { id: 42, type: 'group' }, from: { id: 42 } } }, fixed)).toBe('ignored');
    expect(await channels.handleTelegramUpdate(row.id, { update_id: 102, message: { text: code.command, chat: { id: 42, type: 'private' }, from: { id: 42 } } }, fixed)).toBe('linked');
    expect(await channels.handleTelegramUpdate(row.id, { update_id: 103, message: { text: code.command, chat: { id: 99, type: 'private' }, from: { id: 99 } } }, fixed)).toBe('ignored');
    const encrypted = (await db.userChannel.findUniqueOrThrow({ where: { id: row.id } })).encryptedConfig; expect(crypto.decryptChannelConfig<{ chatId: string }>(ownerId, 'telegram', encrypted).chatId).toBe('42');
    const next = await channels.linkTelegram(ownerId, { token }, fixed); expect(await channels.handleTelegramUpdate(row.id, { update_id: 104, message: { text: next.command, chat: { id: 42, type: 'private' }, from: { id: 42 } } }, new Date(fixed.getTime() + 11 * 60000))).toBe('ignored');
  });
  it('routes per profile, projects once, and uses private Telegram text by default', async () => {
    await enable({ notificationPrivacy: false }); await link(); const t = await task();
    await db.task.update({ where: { id: t.id }, data: { dueDate: new Date('2026-11-06') } });
    await channels.saveRoute(ownerId, { profileId, type: 'task_reminder', channels: ['telegram'], topic: 'synthetic-private-profile-topic' });
    await db.reminderRule.create({ data: { id: uuid(), userId: ownerId, ownerType: 'task', ownerId: t.id, type: 'task_reminder', atLocal: 720, enabled: true } });
    const first = await full.refreshFullReminders(ownerId, db, fixed); expect(first.created).toBeGreaterThan(0); const count = await db.notification.count({ where: { userId: ownerId, dedupeKey: { startsWith: 'r:' } } }); await full.refreshFullReminders(ownerId, db, fixed); expect(await db.notification.count({ where: { userId: ownerId, dedupeKey: { startsWith: 'r:' } } })).toBe(count);
    await full.dispatchFullNotifications(fixed, 50); const taskRows = await db.notification.findMany({ where: { userId: ownerId, taskId: t.id, status: 'sent' } }); expect(taskRows.map(row => row.channel)).toEqual(['telegram']);
    expect(messages.some(message => message.channel === 'telegram' && String(message.body.text).includes('Kram reminder'))).toBe(true); expect(messages.some(message => String(message.body.text).includes(t.title))).toBe(false);
  });
  it('retries at 1, 5 and 30 minutes without failing over to another channel', async () => {
    await enable(); const row = await notification(); ntfyStatus = 503;
    await full.dispatchFullNotifications(fixed); expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).nextAttemptAt).toEqual(new Date(fixed.getTime() + 60000));
    await full.dispatchFullNotifications(new Date(fixed.getTime() + 60000)); expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).nextAttemptAt).toEqual(new Date(fixed.getTime() + 6 * 60000));
    await full.dispatchFullNotifications(new Date(fixed.getTime() + 6 * 60000)); await full.dispatchFullNotifications(new Date(fixed.getTime() + 36 * 60000)); expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('failed'); expect(messages.every(message => message.channel === 'ntfy')).toBe(true);
  });
  it('defers quiet messages and allows an opted-in urgent deadline', async () => {
    await enable({ quietHours: { startMin: 660, endMin: 780 }, allowUrgentDuringQuiet: true }); const quiet = await notification(), deadline = await notification('ntfy', null, { type: 'deadline' });
    await full.dispatchFullNotifications(fixed); expect((await db.notification.findUniqueOrThrow({ where: { id: quiet.id } })).status).toBe('suppressed_quiet_hours'); expect((await db.notification.findUniqueOrThrow({ where: { id: deadline.id } })).status).toBe('sent');
  });
  it('ignores foreign callbacks and records owner Done exactly once, cancelling all pending channels', async () => {
    await enable(); const channelId = await link(), t = await task(), row = await notification('telegram', t.id); await notification('ntfy', t.id);
    const callback = { update_id: 201, callback_query: { id: 'synthetic-callback', from: { id: 42 }, message: { chat: { id: 42, type: 'private' } }, data: `done:${row.id}` } };
    expect(await channels.handleTelegramUpdate(channelId, { ...callback, update_id: 200, callback_query: { ...callback.callback_query, from: { id: 99 }, message: { chat: { id: 99, type: 'private' } } } }, fixed)).toBe('ignored');
    expect(await channels.handleTelegramUpdate(channelId, callback, fixed)).toBe('completed'); expect(await channels.handleTelegramUpdate(channelId, callback, fixed)).toBe('duplicate'); expect(await db.progressEvent.count({ where: { taskId: t.id, kind: 'completed' } })).toBe(1); expect(await db.notification.count({ where: { taskId: t.id, status: 'pending' } })).toBe(0);
  });
  it('snoozes both channels and records Skip through the task event service', async () => {
    await enable(); const channelId = await link(), t = await task(), row = await notification('telegram', t.id), ntfy = await notification('ntfy', t.id);
    const callback = (updateId: number, command: string) => ({ update_id: updateId, callback_query: { id: `callback-${updateId}`, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } }, data: `${command}:${row.id}` } });
    expect(await channels.handleTelegramUpdate(channelId, callback(300, 'snooze'), fixed)).toBe('snoozed'); expect((await db.notification.findUniqueOrThrow({ where: { id: ntfy.id } })).nextAttemptAt).toEqual(new Date(fixed.getTime() + 15 * 60000));
    expect(await channels.handleTelegramUpdate(channelId, callback(301, 'skip'), fixed)).toBe('skipped'); expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('skipped');
  });
  it('preserves an operations source through repeated routing and assigns low health-report priority', async () => {
    await enable(); const source = await notification('ntfy', null, { type: 'healthcheck_report', dedupeKey: 'healthcheck-report:synthetic-test-hour' });
    await full.refreshFullReminders(ownerId, db, fixed); await full.refreshFullReminders(ownerId, db, fixed); await full.dispatchFullNotifications(fixed, 50);
    const delivered = await db.notification.findMany({ where: { userId: ownerId, type: 'healthcheck_report', status: 'sent' } }); expect(delivered).toHaveLength(1); expect(delivered[0]!.id).not.toBe(source.id); expect(messages.find(message => message.body.title === 'Kram reminder' && message.body.priority === 2)).toBeDefined();
  });
  it('excludes demo tasks and slots from delivery and real streaks', async () => {
    await enable(); const t = await task(); await db.task.update({ where: { id: t.id }, data: { isDemo: true } });
    await notification('ntfy', t.id); await db.reminderRule.create({ data: { id: uuid(), userId: ownerId, ownerType: 'task', ownerId: t.id, atLocal: 720 } });
    await full.refreshFullReminders(ownerId, db, fixed); await full.dispatchFullNotifications(fixed, 50); expect(await db.notification.count({ where: { taskId: t.id, status: 'sent' } })).toBe(0);
    await db.goal.update({ where: { id: goalId }, data: { isDemo: true } }); await expect(streak.streaks.create(ownerId, { title: 'Demo streak', scope: 'goal', scopeId: goalId, rule }, fixed)).rejects.toMatchObject({ code: 'DEMO_TARGET' });
  });
  it('queues deadline, overdue, review and proposal alerts with separate channel keys', async () => {
    await enable(); await link(); const t = await task(); await db.task.update({ where: { id: t.id }, data: { dueDate: new Date('2026-11-05') } });
    const p = await db.plan.upsert({ where: { userId: ownerId }, create: { id: uuid(), userId: ownerId }, update: {} }); const number = await db.planVersion.count({ where: { userId: ownerId } }) + 1;
    await db.planVersion.create({ data: { id: uuid(), userId: ownerId, planId: p.id, number, fromDate: new Date('2026-11-06'), toDate: new Date('2026-11-07'), algoVersion: 'fixture', inputsHash: uuid(), sourceHash: uuid(), config: {}, input: {}, result: { items: [], warnings: [{ goalId, code: 'FIXTURE_RISK', message: 'Synthetic feasibility warning.' }], changes: { requiresApproval: true, changes: [] } }, reason: 'Synthetic proposal', createdAt: fixed } });
    await full.refreshFullReminders(ownerId, db, fixed); const rows = await db.notification.findMany({ where: { userId: ownerId, status: 'pending', dedupeKey: { startsWith: 'r:' } } });
    for (const type of ['deadline', 'overdue', 'daily_review', 'schedule_changed', 'feasibility_warning']) expect(rows.some(row => row.type === type)).toBe(true);
    expect(rows.filter(row => row.type === 'deadline').map(row => row.channel).sort()).toEqual(['ntfy', 'telegram']); expect(new Set(rows.map(row => row.dedupeKey)).size).toBe(rows.length);
  });
  it('claims once under concurrent dispatch and maintains one future repeat', async () => {
    await enable(); const t = await task(); await db.task.update({ where: { id: t.id }, data: { dueDate: new Date('2026-11-06') } }); const reminder = await db.reminderRule.create({ data: { id: uuid(), userId: ownerId, ownerType: 'task', ownerId: t.id, atLocal: 720, repeatPolicy: 'until_completed' } });
    await full.refreshFullReminders(ownerId, db, fixed); await Promise.all([full.dispatchFullNotifications(fixed, 50), full.dispatchFullNotifications(fixed, 50)]); expect(await db.notification.count({ where: { taskId: t.id, reminderRuleId: reminder.id, status: 'sent' } })).toBe(1);
    await full.refreshFullReminders(ownerId, db, fixed); await full.refreshFullReminders(ownerId, db, fixed); expect(await db.notification.count({ where: { taskId: t.id, reminderRuleId: reminder.id, status: 'pending', dedupeKey: { contains: ':repeat:' } } })).toBe(1);
    await db.task.update({ where: { id: t.id }, data: { status: 'completed' } }); await full.refreshFullReminders(ownerId, db, fixed); expect(await db.notification.count({ where: { taskId: t.id, status: 'pending' } })).toBe(0);
  });
  it('emits an at-risk prompt only while useful work still fits the remaining day', async () => {
    await enable(); const t = await task(); await progress(t.id, '2026-11-06', 10);
    const definition = await streak.streaks.create(ownerId, { title: 'Useful late practice', scope: 'goal', scopeId: goalId, startDate: '2026-11-06', rule }, fixed);
    const evening = new Date('2026-11-06T20:00:00Z'); await full.refreshFullReminders(ownerId, db, evening); expect(await db.notification.count({ where: { userId: ownerId, type: 'streak_at_risk', ownerId: definition.id, status: 'pending' } })).toBe(1);
    await db.timeSlot.create({ data: { id: uuid(), userId: ownerId, date: new Date('2026-11-06'), startMin: 1200, endMin: 1380, layer: 'unavailable', title: 'Synthetic busy evening' } });
    await full.refreshFullReminders(ownerId, db, evening); expect(await db.notification.count({ where: { userId: ownerId, type: 'streak_at_risk', ownerId: definition.id, status: 'pending' } })).toBe(0);
  });
  it('reports the actual last accepted send for each channel and selected profile', async () => {
    const t = await task(); await notification('ntfy', t.id, { status: 'sent', sentAt: fixed }); await notification('telegram', t.id, { status: 'pending', sentAt: null });
    const status = await channels.channelStatus(ownerId, profileId); expect(status.find(row => row.id === 'ntfy')?.lastSentAt).toEqual(fixed); expect(status.find(row => row.id === 'telegram')?.lastSentAt).toBeNull();
    const foreign = await db.goal.findUniqueOrThrow({ where: { id: foreignGoal }, include: { skill: true } }); await expect(channels.channelStatus(ownerId, foreign.skill.profileId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const response = await get(`/channels?profileId=${profileId}`).expect(200); expect(response.body.find((row: { id: string }) => row.id === 'ntfy').lastSentAt).toBe(fixed.toISOString());
  });
});
