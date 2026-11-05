import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import PgBoss from 'pg-boss';
import pg from 'pg';
import { v7 } from 'uuid';
import type { BackupJob } from '../../apps/worker/src/backup-scheduling';

let container: StartedTestContainer, db: PrismaClient, url: string, workspace: string, worker: ChildProcess | undefined;
let performBackup: typeof import('../../apps/worker/src/backup-service').performBackup;
let enqueueDueBackup: typeof import('../../apps/worker/src/backup-scheduling').enqueueDueBackup;
let data: BackupJob;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kram-backup-integration-'));
  container = await new GenericContainer('postgres:16-bookworm')
    .withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: 'disposable-backup-test', POSTGRES_DB: 'kram' })
    .withBindMounts([{ source: workspace, target: workspace }])
    .withExposedPorts(5432)
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 })
    .withWaitStrategy(Wait.forHealthCheck()).start();
  url = `postgresql://kram:disposable-backup-test@${container.getHost()}:${container.getMappedPort(5432)}/kram`;
  Object.assign(process.env, { DOTENV_CONFIG_PATH: devNull, DATABASE_URL: url, DATABASE_URL_FILE: '', NODE_ENV: 'test', SESSION_SECRET: 'backup-integration-secret-that-is-long-enough', SESSION_SECRET_FILE: '', ENCRYPTION_KEY: 'backup-integration-key-that-is-long-enough', ENCRYPTION_KEY_FILE: '', LOG_LEVEL: 'silent', BACKUP_DIR: workspace, WORKER_HEALTH_FILE: join(workspace, 'worker-health.json') });
  for (const tool of ['pg_dump', 'pg_restore']) {
    const wrapper = join(workspace, tool);
    await writeFile(wrapper, `#!/bin/sh\nexec docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER -e PGPASSWORD -e PGDATABASE ${container.getId()} ${tool} "$@"\n`, { mode: 0o700 });
    process.env[tool === 'pg_dump' ? 'PG_DUMP_BIN' : 'PG_RESTORE_BIN'] = wrapper;
  }
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { env: process.env, stdio: 'pipe' });
  ({ db } = await import('../../apps/api/src/db'));
  ({ performBackup } = await import('../../apps/worker/src/backup-service'));
  const scheduling = await import('../../apps/worker/src/backup-scheduling');
  enqueueDueBackup = scheduling.enqueueDueBackup;
  data = scheduling.dueBackup(new Date('2026-11-06T12:00:00Z'), 'Asia/Kolkata')!;
  const user = await db.user.create({ data: { id: v7(), email: 'backup-owner@kram.test', passwordHash: 'fixture-only', settings: {}, isOwner: true } });
  const profile = await db.profile.create({ data: { id: v7(), userId: user.id, name: 'Populated backup profile' } });
  await db.skill.create({ data: { id: v7(), userId: user.id, profileId: profile.id, name: 'Backup verification skill' } });
  await db.auditLog.create({ data: { id: v7(), userId: user.id, action: 'backup_verification_fixture', detail: { synthetic: true } } });
}, 120000);

afterAll(async () => {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await new Promise<void>(resolveDone => { worker!.once('close', () => resolveDone()); setTimeout(() => { worker?.kill('SIGKILL'); resolveDone(); }, 5000).unref(); });
  }
  await db?.$disconnect();
  await container?.stop();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe('durable local backup worker', () => {
  it('queues one period durably across restart with retries and local timezone cron', async () => {
    const boss = new PgBoss(url); await boss.start();
    await boss.createQueue('backup', { name: 'backup', policy: 'stately' });
    await boss.createQueue('backup-schedule');
    await boss.schedule('backup-schedule', '0 3 * * *', {}, { tz: 'Asia/Kolkata' });
    const id = await enqueueDueBackup(boss, new Date('2026-11-06T12:00:00Z'));
    expect(id).toBeTypeOf('string');
    expect(await enqueueDueBackup(boss, new Date('2026-11-06T12:00:00Z'))).toBeNull();
    await boss.stop();
    const restarted = new PgBoss(url); await restarted.start();
    const jobs = await restarted.fetch<BackupJob>('backup', { includeMetadata: true });
    expect(jobs).toHaveLength(1); expect(jobs[0]?.id).toBe(id);
    expect(jobs[0]?.retryLimit).toBe(3); expect(jobs[0]?.retryBackoff).toBe(true);
    const schedules = await restarted.getSchedules();
    expect(schedules.find(schedule => schedule.name === 'backup-schedule')).toMatchObject({ cron: '0 3 * * *', options: { tz: 'Asia/Kolkata' } });
    await restarted.complete('backup', id!); await restarted.stop();
  });
  it('persists a failed attempt and releases its dedicated advisory lock', async () => {
    await expect(performBackup('failed-fixture', data, 1, async () => { throw new Error('simulated dump failure'); })).rejects.toThrow('simulated dump failure');
    expect((await db.systemMeta.findUnique({ where: { key: 'backup-status' } }))?.value).toMatchObject({ status: 'failed', attempt: 1, error: { code: 'BACKUP_FAILED' }, lastSuccess: null });
    const client = new pg.Client({ connectionString: url }); await client.connect();
    expect((await client.query('SELECT pg_try_advisory_lock(1263681871, 1) AS locked')).rows[0].locked).toBe(true);
    await client.end();
  });
  it('restores populated hierarchy/history plus queue tables and reuses the same snapshot', async () => {
    const manifest = await performBackup('success-fixture', data, 2);
    expect((await db.systemMeta.findUnique({ where: { key: 'backup-status' } }))?.value).toMatchObject({ status: 'succeeded', attempt: 2, lastSuccess: { id: data.periodKey, sha256: manifest.sha256 } });
    const restored = JSON.parse(execFileSync(process.execPath, ['infra/backup/backup.mjs', 'verify', manifest.path], { env: process.env, encoding: 'utf8' }));
    expect(restored).toMatchObject({ verified: true, rowCounts: true, constraints: true, temporaryDatabaseRemoved: true });
    const persisted = JSON.parse(await readFile(`${manifest.path}.json`, 'utf8'));
    expect(persisted.tables).toEqual(expect.arrayContaining([
      { schema: 'public', table: 'app_user', count: 1 }, { schema: 'public', table: 'profile', count: 1 },
      { schema: 'public', table: 'skill', count: 1 }, { schema: 'public', table: 'audit_log', count: 1 },
    ]));
    expect((await performBackup('retry-fixture', data, 3)).sha256).toBe(manifest.sha256);
    const client = new pg.Client({ connectionString: url }); await client.connect();
    expect((await client.query("SELECT datname FROM pg_database WHERE datname LIKE 'kram_restore_check_%'")).rows).toHaveLength(0);
    await client.end();
  });
  it('prevents simultaneous backup handlers and preserves last success after a later failure', async () => {
    const client = new pg.Client({ connectionString: url }); await client.connect();
    await client.query('SELECT pg_advisory_lock(1263681871, 1)');
    let called = false;
    await expect(performBackup('busy-fixture', data, 1, async () => { called = true; throw new Error('should not run'); })).rejects.toThrow('Another backup is running');
    expect(called).toBe(false); await client.end();
    await expect(performBackup('later-failure', { ...data, periodKey: `${data.periodKey}-later` }, 1, async () => { throw new Error('later failure'); })).rejects.toThrow('later failure');
    expect((await db.systemMeta.findUnique({ where: { key: 'backup-status' } }))?.value).toMatchObject({ status: 'failed', lastSuccess: { id: data.periodKey } });
  });
  it('boots the actual worker, performs current catch-up and writes heartbeat after restart', async () => {
    await db.systemMeta.delete({ where: { key: 'backup-schedule' } });
    let output = '';
    worker = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'apps/worker/src/index.ts'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    worker.stdout?.on('data', chunk => { output += String(chunk); }); worker.stderr?.on('data', chunk => { output += String(chunk); });
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const status = (await db.systemMeta.findUnique({ where: { key: 'backup-status' } }))?.value;
      const heartbeat = await db.systemMeta.findUnique({ where: { key: 'worker-heartbeat' } });
      if (status && typeof status === 'object' && !Array.isArray(status) && status.status === 'succeeded' && heartbeat) {
        expect(JSON.parse(await readFile(process.env.WORKER_HEALTH_FILE!, 'utf8'))).toMatchObject({ status: 'ok' });
        expect(output).toContain('Kram worker started'); return;
      }
      if (worker.exitCode !== null) throw new Error(`Worker exited: ${output}`);
      await new Promise(resolveDone => setTimeout(resolveDone, 200));
    }
    throw new Error(`Worker did not finish catch-up: ${output}`);
  });
});
