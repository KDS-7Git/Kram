import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import request, { type Agent } from 'supertest';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { v7 } from 'uuid';
import pg from 'pg';

let container: StartedTestContainer, workspace: string, backupDir: string, offsiteDir: string, db: PrismaClient, app: Express, agent: Agent, csrf: string, userId: string, taskId: string;
const origin = 'http://localhost:8420';
const post = (path: string, body = {}) => agent.post(`/api/v1${path}`).set('Origin', origin).set('X-CSRF-Token', csrf).send(body);
const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['infra/backup/recovery.mjs', ...args], { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kram-encrypted-recovery-')); backupDir = join(workspace, 'backups'); offsiteDir = join(workspace, 'offsite'); await mkdir(backupDir); await mkdir(offsiteDir);
  container = await new GenericContainer('postgres:16-bookworm').withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'disposable-encrypted-recovery-test', POSTGRES_DB: 'kram' })
    .withBindMounts([{ source: workspace, target: workspace }]).withExposedPorts(5432)
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 }).withWaitStrategy(Wait.forHealthCheck()).start();
  const ageInstall = await container.exec(['sh', '-c', 'apt-get update -qq && apt-get install -y -qq age >/dev/null']);
  if (ageInstall.exitCode !== 0) throw new Error('Could not install age inside the disposable recovery fixture');
  for (const tool of ['pg_dump', 'pg_restore', 'age']) {
    const wrapper = join(workspace, tool);
    await writeFile(wrapper, `#!/bin/sh\nexec docker exec -i -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER -e PGPASSWORD -e PGDATABASE ${container.getId()} ${tool} "$@"\n`, { mode: 0o700 });
    process.env[tool === 'pg_dump' ? 'PG_DUMP_BIN' : tool === 'pg_restore' ? 'PG_RESTORE_BIN' : 'AGE_BIN'] = wrapper;
  }
  const identity = join(workspace, 'disposable-age-identity');
  const keygen = await container.exec(['age-keygen', '-o', identity]); if (keygen.exitCode !== 0) throw new Error('Disposable age key generation failed');
  const recipient = (await container.exec(['age-keygen', '-y', identity])).output.trim();
  const url = `postgresql://kram:disposable-encrypted-recovery-test@${container.getHost()}:${container.getMappedPort(5432)}/kram`;
  Object.assign(process.env, { DOTENV_CONFIG_PATH: devNull, DATABASE_URL: url, DATABASE_URL_FILE: '', NODE_ENV: 'test', APP_URL: origin, COOKIE_SECURE: 'false', DEFAULT_TIMEZONE: 'Asia/Kolkata', SESSION_SECRET: 'encrypted-recovery-fixture-session-secret-at-least32chars', SESSION_SECRET_FILE: '', ENCRYPTION_KEY: '77'.repeat(32), ENCRYPTION_KEY_FILE: '', OWNER_SETUP_TOKEN: '', OWNER_SETUP_TOKEN_FILE: '', LOG_LEVEL: 'silent', BACKUP_MODE: 'local', BACKUP_DIR: backupDir, BACKUP_AGE_RECIPIENT: recipient, BACKUP_AGE_RECIPIENTS_FILE: '', BACKUP_AGE_IDENTITY_FILE: identity, BACKUP_OFFSITE_DIR: offsiteDir, BACKUP_OFFSITE_REMOTE: '' });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: process.env, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db')); const { createApp } = await import('../../apps/api/src/app'); app = createApp(); agent = request.agent(app);
  csrf = (await agent.get('/api/v1/auth/me')).body.csrfToken;
  const owner = await post('/auth/setup', { email: 'encrypted-recovery-owner@kram.test', password: 'synthetic-encrypted-recovery-password-42' }).expect(201); userId = owner.body.user.id; csrf = owner.body.csrfToken;
  const profile = await post('/profiles', { name: 'अभ्यास' }).expect(201);
  const skill = await post('/skills', { profileId: profile.body.id, name: 'Recovery fixture skill' }).expect(201);
  const goal = await post('/goals', { skillId: skill.body.id, type: 'milestone', title: '=Spreadsheet formula fixture', unit: 'questions', targetQty: 10, startDate: '2026-11-02' }).expect(201);
  const task = await post('/tasks', { goalId: goal.body.id, title: 'Recovery task', qty: 10, estMinutes: 60, earliestDate: '2026-11-02' }).expect(201); taskId = task.body.id;
  const progress = { clientEventId: v7(), kind: 'progress', occurredAt: '2026-11-03T10:00:00+05:30', minutes: 25, qty: 4 };
  await post(`/tasks/${taskId}/events`, progress).expect(200); await post(`/tasks/${taskId}/events`, progress).expect(200);
  const foreign = await db.user.create({ data: { id: v7(), email: 'foreign-recovery@kram.test', passwordHash: 'FOREIGN_HASH_NEVER_EXPORTED', settings: {}, isOwner: false } });
  await db.profile.create({ data: { id: v7(), userId: foreign.id, name: 'FOREIGN_PROFILE_NEVER_EXPORTED' } });
}, 180_000);
afterAll(async () => { if (app?.locals.closeSessions) await app.locals.closeSessions(); await db?.$disconnect(); await container?.stop(); if (workspace) await rm(workspace, { recursive: true, force: true }); });

describe('analytics and encrypted recovery on a disposable database', () => {
  it('authenticates exports/health and excludes foreign data and credentials', async () => {
    expect((await request(app).post('/api/v1/export').send({})).status).toBe(401);
    const response = await post('/export', { format: 'json' }).expect(200); const serialized = JSON.stringify(response.body);
    expect(response.headers['cache-control']).toBe('no-store'); expect(response.body.account.id).toBe(userId); expect(serialized).toContain('अभ्यास');
    expect(serialized).not.toContain('passwordHash'); expect(serialized).not.toContain('FOREIGN_'); expect(serialized).not.toContain('csrfToken'); expect(serialized).not.toContain('requestHash');
    expect(response.body.tables.progress_event).toHaveLength(1); expect(response.body.tables.session).toBeUndefined();
    const csv = await post('/export', { format: 'csv' }).expect(200); expect(csv.type).toBe('text/csv'); expect(csv.text).toContain('"\'=Spreadsheet formula fixture"');
    const health = await agent.get('/api/v1/data/health').expect(200); expect(health.body.databaseBytes).toBeGreaterThan(0); expect(health.body.alerts).toContain('No successful scheduled backup has been recorded.');
  });
  it('reports unit-specific weekly work after an idempotent replay', async () => {
    const response = await agent.get('/api/v1/analytics/overview?weekStart=2026-11-02').expect(200);
    expect(response.body.totalMinutes).toBe(25); expect(response.body.goals[0]).toMatchObject({ unit: 'questions', weeklyCredited: 4 }); expect(response.body.skills[0].units).toEqual([{ unit: 'questions', credited: 4 }]);
  });
  it('encrypts, checksum-copies, restores every table, removes temporary plaintext and reuses the same archive', async () => {
    const manifest = run('run', '--period-key=fixture-one', '--verify');
    expect(manifest).toMatchObject({ formatVersion: 2, encrypted: true, localOnly: false, verification: { verified: true, rowCounts: true, constraints: true, temporaryDatabaseRemoved: true }, offDevice: { kind: 'directory' } });
    expect((await readFile(manifest.path)).subarray(0, 22).toString()).toBe('age-encryption.org/v1\n');
    expect(await readFile(join(offsiteDir, 'kram-recovery-fixture-one.dump.age'))).toEqual(await readFile(manifest.path));
    expect((await readdir(backupDir)).some(file => file.endsWith('.dump') || file.includes('kram-restore-') || file.endsWith('.partial'))).toBe(false);
    expect(run('run', '--period-key=fixture-one').sha256).toBe(manifest.sha256);
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
    try { expect((await client.query("SELECT datname FROM pg_database WHERE datname LIKE 'kram_restore_check_%'")).rows).toEqual([]); } finally { await client.end(); }
    expect(manifest.tables).toEqual(expect.arrayContaining([{ schema: 'public', table: 'progress_event', count: 1 }, { schema: 'public', table: 'app_user', count: 2 }]));
  });
  it('rejects corruption and preserves last success when off-device configuration fails', async () => {
    const first = run('run', '--period-key=fixture-one'); const bad = join(backupDir, 'kram-recovery-corrupt.dump.age');
    await writeFile(bad, 'corrupt ciphertext'); await writeFile(`${bad}.json`, JSON.stringify({ ...first, id: 'corrupt', path: bad }));
    expect(() => run('verify', bad)).toThrow(); await rm(bad); await rm(`${bad}.json`);
    const original = process.env.BACKUP_OFFSITE_DIR; process.env.BACKUP_OFFSITE_DIR = backupDir;
    try { expect(() => run('run', '--period-key=fixture-failed')).toThrow(); } finally { process.env.BACKUP_OFFSITE_DIR = original; }
    const state = JSON.parse(await readFile(join(backupDir, 'recovery-status.json'), 'utf8')); expect(state.status).toBe('failed'); expect(state.lastSuccess.id).toBe('fixture-one');
  });
  it('records idempotent failure and hourly health notification sources without network publication', async () => {
    const { queueBackupFailure, recordHealthReport } = await import('../../apps/api/src/data/operations');
    const now = new Date('2026-11-06T12:00:00Z');
    await queueBackupFailure('fixture-failure', now); await queueBackupFailure('fixture-failure', now);
    await recordHealthReport(now); await recordHealthReport(now);
    expect(await db.notification.count({ where: { userId, type: 'backup_failed' } })).toBe(1);
    expect(await db.notification.count({ where: { userId, type: 'healthcheck_report' } })).toBe(1);
    expect(await db.systemMeta.findUnique({ where: { key: 'health-report' } })).not.toBeNull();
    expect(await db.notificationAttempt.count()).toBe(0);
  });
  it('loads one labelled sample week and archives it while preserving progress and real additions', async () => {
    const loaded = await post('/demo/load').expect(200); expect(loaded.body.reused).toBe(false);
    expect((await post('/demo/load').expect(200)).body.reused).toBe(true);
    const sample = await db.task.findMany({ where: { userId, isDemo: true, archivedAt: null } }); expect(sample).toHaveLength(5); expect(sample.every(task => task.title.startsWith('Demo ·'))).toBe(true);
    const progress = await post(`/tasks/${sample[0]!.id}/events`, { clientEventId: v7(), kind: 'progress', minutes: 5, occurredAt: new Date().toISOString() }).expect(200);
    await post(`/tasks/${sample[1]!.id}/events`, { clientEventId: v7(), kind: 'started', occurredAt: new Date().toISOString() }).expect(200);
    const real = await post('/tasks', { goalId: sample[0]!.goalId, title: 'My own work under a sample goal', estMinutes: 20, earliestDate: sample[0]!.earliestDate.toISOString().slice(0, 10) }).expect(201);
    const removed = await post('/demo/remove').expect(200); expect(removed.body.archived.tasks).toBe(5); expect(removed.body.retainedContainers).toBeGreaterThan(0);
    expect(await db.progressEvent.findUnique({ where: { id: progress.body.event.id } })).not.toBeNull(); expect((await db.task.findUnique({ where: { id: sample[0]!.id } }))?.actualMinutes).toBe(5);
    expect((await db.task.findUnique({ where: { id: sample[1]!.id } }))?.timerStartedAt).toBeNull(); expect(await db.progressEvent.count({ where: { taskId: sample[1]!.id, kind: 'paused' } })).toBe(1);
    expect((await db.task.findUnique({ where: { id: real.body.id } }))?.archivedAt).toBeNull(); expect((await db.goal.findUnique({ where: { id: sample[0]!.goalId } }))?.archivedAt).toBeNull();
    expect(await db.notification.count({ where: { userId, task: { isDemo: true }, status: 'pending' } })).toBe(0);
    expect((await post('/demo/remove').expect(200)).body.archived.tasks).toBe(0);
  });
  it('queues a manual backup durably and dedupes uncertain HTTP retries', async () => {
    const clientEventId = v7();
    const first = await post('/backup/run', { clientEventId }).expect(202); expect(first.body.queued).toBe(true); expect(first.body.jobId).toBeTruthy();
    await post('/backup/run', { clientEventId }).expect(202);
    const jobs = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM pgboss.job WHERE name='backup' AND singleton_key=${first.body.periodKey}`;
    expect(Number(jobs[0]?.count)).toBe(1);
    const health = await agent.get('/api/v1/data/health').expect(200); expect(health.body.queue.pending).toBeGreaterThanOrEqual(1);
  });
  it('uses the owner Sunday boundary for default and linked reports after a later correction', async () => {
    const { clock } = await import('../../apps/api/src/calendar'); const originalClock = clock.now;
    const owner = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const source = await db.task.findUniqueOrThrow({ where: { id: taskId }, include: { goal: true } });
    try {
      clock.now = () => '2026-11-06T12:00:00Z';
      await db.user.update({ where: { id: userId }, data: { settings: { ...(owner.settings as Record<string, unknown>), weekStart: 7 } } });
      const goal = await post('/goals', { skillId: source.goal.skillId, type: 'weekly', title: 'Sunday corrected report', unit: 'questions', targetQty: 10, startDate: '2026-10-25', availableDays: [1, 2, 3, 4, 5, 6, 7] }).expect(201);
      const task = await post('/tasks', { goalId: goal.body.id, title: 'Sunday progress fixture', estMinutes: 30, qty: 10, earliestDate: '2026-10-31' }).expect(201);
      await post(`/tasks/${task.body.id}/events`, { clientEventId: v7(), kind: 'progress', minutes: 7, qty: 1, occurredAt: '2026-10-31T10:00:00+05:30' }).expect(200);
      const progress = await post(`/tasks/${task.body.id}/events`, { clientEventId: v7(), kind: 'progress', minutes: 20, qty: 4, occurredAt: '2026-11-01T10:00:00+05:30' }).expect(200);
      const before = await agent.get('/api/v1/analytics/overview').expect(200); expect(before.body.weekStart).toBe('2026-11-01'); expect(before.body.weekEnd).toBe('2026-11-07'); expect(before.body.goals.find((row: { id: string }) => row.id === goal.body.id).weeklyCredited).toBe(4);
      clock.now = () => '2026-11-10T12:00:00Z';
      await post(`/tasks/${task.body.id}/events`, { clientEventId: v7(), kind: 'correction', referenceEventId: progress.body.event.id, explicitCorrection: true, occurredAt: '2026-11-09T10:00:00+05:30' }).expect(200);
      clock.now = () => '2026-11-06T12:00:00Z';
      const corrected = await agent.get('/api/v1/analytics/overview').expect(200); expect(corrected.body.weekStart).toBe('2026-11-01'); expect(corrected.body.goals.find((row: { id: string }) => row.id === goal.body.id).weeklyCredited).toBe(0);
      const linked = await agent.get('/api/v1/analytics/overview?weekStart=2026-11-06').expect(200); expect(linked.body.weekStart).toBe('2026-11-01');
    } finally { clock.now = originalClock; await db.user.update({ where: { id: userId }, data: { settings: owner.settings! } }); }
  });
});
