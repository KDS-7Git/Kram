// Disposable production-image proof; never connects to an existing installation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { GenericContainer, Network, Wait } from 'testcontainers';

const imageName = process.env.KRAM_RUNTIME_IMAGE || 'kram:runtime-check';
try { execFileSync('docker', ['image', 'inspect', imageName], { stdio: 'ignore' }); }
catch { throw new Error(`Build the reviewed runtime image first: docker build --target runtime -t ${imageName} .`); }
const password = `runtime-fixture-${randomBytes(24).toString('hex')}`;
const origin = 'http://runtime-fixture.test';
const backupVolume = `kram-runtime-fixture-${randomUUID()}`;
let network, postgres, ntfy, app, worker;
try {
  execFileSync('docker', ['volume', 'create', backupVolume], { stdio: 'ignore' });
  network = await new Network().start();
  // Boot the bundled provider config too; a stub cannot catch invalid ntfy settings.
  ntfy = await new GenericContainer('binwiederhier/ntfy:v2.14.0').withNetwork(network).withCommand(['serve'])
    .withCopyFilesToContainer([{ source: resolve('infra/ntfy/server.yml'), target: '/etc/ntfy/server.yml' }])
    .withTmpFs({ '/var/lib/ntfy': 'rw', '/var/cache/ntfy': 'rw' })
    .withHealthCheck({ test: ['CMD', 'wget', '-q', '--spider', 'http://127.0.0.1/v1/health'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 }).withWaitStrategy(Wait.forHealthCheck()).start();
  const ntfyUsers = await ntfy.exec(['ntfy', 'user', 'list']); assert.equal(ntfyUsers.exitCode, 0);
  postgres = await new GenericContainer('postgres:16-bookworm').withNetwork(network).withNetworkAliases('runtime-db')
    .withEnvironment({ POSTGRES_USER: 'kram', POSTGRES_PASSWORD: password, POSTGRES_DB: 'kram' })
    .withHealthCheck({ test: ['CMD-SHELL', 'pg_isready -U kram -d kram'], interval: 1000, timeout: 3000, retries: 30, startPeriod: 1000 }).withWaitStrategy(Wait.forHealthCheck()).start();
  // Match Compose: the entrypoint derives DATABASE_URL from a file secret.
  // Docker exec must invoke that entrypoint again for its own process.
  const databaseSecret = { content: `${password}\n`, target: '/tmp/kram-runtime-postgres-password', mode: 0o444 };
  const environment = { NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '8420', DATABASE_HOST: 'runtime-db', DATABASE_PORT: '5432', DATABASE_NAME: 'kram', DATABASE_USER: 'kram', POSTGRES_PASSWORD_FILE: databaseSecret.target,
    SESSION_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'), APP_URL: origin, COOKIE_SECURE: 'false', LOG_LEVEL: 'silent',
    NTFY_BASE_URL: '', NTFY_TOPIC: '', NTFY_TOKEN: '', NTFY_TOKEN_FILE: '', BACKUP_DIR: '/app/backups', WORKER_HEALTH_FILE: '/tmp/kram-runtime-health.json' };
  app = await new GenericContainer(imageName).withNetwork(network).withEnvironment(environment).withCopyContentToContainer([databaseSecret]).withExposedPorts(8420)
    .withHealthCheck({ test: ['CMD', 'node', 'infra/app-health.mjs'], interval: 1000, timeout: 5000, retries: 30, startPeriod: 1000 }).withWaitStrategy(Wait.forHealthCheck()).start();
  const base = `http://${app.getHost()}:${app.getMappedPort(8420)}`;
  const shell = await fetch(base); assert.equal(shell.status, 200); assert.match(await shell.text(), /Kram/); assert.match(shell.headers.get('content-security-policy') || '', /script-src/);
  execFileSync('docker', ['exec', '-i', app.getId(), '/app/infra/entrypoint.sh', 'node', 'dist/server/cli.js', 'create-owner', '--email=runtime-owner@kram.test', '--password-stdin'], { input: `${password}\n`, stdio: ['pipe', 'pipe', 'pipe'] });
  let cookie = '', csrf = '';
  const call = async (path, method = 'GET', body, extraHeaders = {}) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers: { ...extraHeaders, Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const cookies = response.headers.getSetCookie(); if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ');
    const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`); if (value.csrfToken) csrf = value.csrfToken; return value;
  };
  await call('/auth/me'); await call('/auth/login', 'POST', { email: 'runtime-owner@kram.test', password });
  const bootstrap = await call('/bootstrap');
  const profile = await call('/profiles', 'POST', { name: 'Synthetic runtime profile' });
  const skill = await call('/skills', 'POST', { profileId: profile.id, name: 'Synthetic runtime skill' });
  const goal = await call('/goals', 'POST', { skillId: skill.id, type: 'daily', title: 'Synthetic runtime goal', targetQty: 60, startDate: bootstrap.studyDate, availableDays: [1, 2, 3, 4, 5, 6, 7] });
  const task = await call('/tasks', 'POST', { goalId: goal.id, title: 'Synthetic runtime execution', estMinutes: 60, earliestDate: bootstrap.studyDate });
  const first = await call(`/tasks/${task.id}/events`, 'POST', { clientEventId: randomUUID(), kind: 'progress', minutes: 40, occurredAt: new Date().toISOString() });
  assert.equal(first.task.remainingMinutes, 20);
  const done = await call(`/tasks/${task.id}/events`, 'POST', { clientEventId: randomUUID(), kind: 'completed', minutes: 60, occurredAt: new Date().toISOString() });
  assert.equal(done.task.actualMinutes, 60); assert.equal(done.event.minutes, 20); assert.equal(done.task.remainingMinutes, 0);
  assert.equal(done.event.reportedTotalMinutes, 60);
  const correctedPartial = await call(`/tasks/${task.id}/events`, 'POST', { clientEventId: randomUUID(), kind: 'correction', referenceEventId: first.event.id, occurredAt: new Date().toISOString() });
  assert.equal(correctedPartial.task.actualMinutes, 60);
  await call(`/tasks/${task.id}/events`, 'POST', { clientEventId: randomUUID(), kind: 'correction', referenceEventId: correctedPartial.event.id, occurredAt: new Date().toISOString() });
  assert.equal((await call(`/goals/${goal.id}`)).progressMinutes, 60); assert.equal((await call('/notifications/status')).configured, false);
  const advance = (date, days) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
  const rhythm = await call('/goals', 'POST', { skillId: skill.id, type: 'recurring', title: 'Synthetic anchored practice', targetQty: 30, startDate: bootstrap.studyDate, rrule: 'FREQ=DAILY;INTERVAL=2;COUNT=8' });
  const series = (await call('/recurrence/series')).find(row => row.goalId === rhythm.id);
  const occurrences = (await call(`/recurrence/occurrences?from=${bootstrap.studyDate}&to=${advance(bootstrap.studyDate, 20)}`)).filter(row => row.seriesId === series.id && row.status === 'scheduled');
  assert.equal(occurrences.length, 8);
  assert.deepEqual(occurrences.map(row => row.localDate), Array.from({ length: 8 }, (_, index) => advance(bootstrap.studyDate, index * 2)));
  const commitment = await call('/recurrence/series', 'POST', { title: 'Synthetic runtime commitment', rrule: 'FREQ=DAILY;INTERVAL=2', dtstartLocal: bootstrap.studyDate, startMin: 600, estMinutes: 30 });
  assert.equal((await call(`/timetable/day/${advance(bootstrap.studyDate, 70)}`)).filter(slot => slot.recurrenceSeriesId === commitment.id && slot.virtual).length, 1);
  const template = await call('/timetable/templates', 'POST', { name: 'Synthetic reusable day', kind: 'day', entries: [{ weekday: 1, startMin: 1080, endMin: 1140, title: 'Synthetic reserved window', layer: 'reserved', skillId: skill.id }] });
  const application = { anchor: advance(bootstrap.studyDate, 30) }, etag = { 'If-Match': `"${template.version}"` };
  assert.equal((await call(`/timetable/templates/${template.id}/apply`, 'POST', application, etag)).reused, false);
  assert.equal((await call(`/timetable/templates/${template.id}/apply`, 'POST', application, etag)).reused, true);
  const startWorker = () => new GenericContainer(imageName).withNetwork(network).withEnvironment(environment).withCopyContentToContainer([databaseSecret]).withCommand(['node', 'dist/server/worker.js'])
    .withBindMounts([{ source: backupVolume, target: '/app/backups' }]).withHealthCheck({ test: ['CMD', 'node', '--input-type=module', '-e', 'import {access} from "node:fs/promises";await access(process.env.WORKER_HEALTH_FILE);await import("./infra/worker-health.mjs");'], interval: 1000, timeout: 5000, retries: 40, startPeriod: 1000 }).withWaitStrategy(Wait.forHealthCheck()).start();
  worker = await startWorker();
  const readJobs = async () => {
    const result = await worker.exec(['/app/infra/entrypoint.sh', 'node', '--input-type=module', '-e', 'import {PrismaClient} from "@prisma/client";const db=new PrismaClient();console.log(JSON.stringify({jobs:(await db.jobRun.findMany()).map(r=>r.jobName),tasks:await db.task.count(),occurrences:await db.occurrence.count(),backup:(await db.systemMeta.findUnique({where:{key:"backup-status"}}))?.value?.status}));await db.$disconnect();']);
    assert.equal(result.exitCode, 0); return JSON.parse(result.output);
  };
  let state; const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    state = await readJobs(); if (state.jobs.includes('materialize-tasks') && state.jobs.includes('materialize-occurrences') && state.backup === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(state?.jobs.includes('materialize-tasks')); assert.ok(state?.jobs.includes('materialize-occurrences')); assert.equal(state?.backup, 'succeeded');
  const beforeRestart = state.tasks; await worker.stop(); worker = undefined; worker = await startWorker();
  const restarted = await readJobs(); assert.equal(restarted.tasks, beforeRestart); assert.equal(restarted.occurrences, state.occurrences);
  const integrity = await app.exec(['/app/infra/entrypoint.sh', 'node', 'dist/server/cli.js', 'integrity']); assert.equal(integrity.exitCode, 0);
  process.stdout.write(`${JSON.stringify({ image: imageName, databaseConfiguration: 'file-secret', ntfy: 'healthy', api: 'healthy', worker: 'healthy', completionMinutes: done.task.actualMinutes, storedCompletionContribution: done.event.minutes, restartTaskCount: beforeRestart, restartOccurrenceCount: state.occurrences, recurrenceDates: occurrences.map(row => row.localDate), templateRetryReused: true, backup: state.backup, jobs: [...new Set(state.jobs)].sort() }, null, 2)}\n`);
} finally {
  for (const resource of [worker, app, ntfy, postgres, network]) if (resource) await resource.stop().catch(() => undefined);
  try { execFileSync('docker', ['volume', 'rm', backupVolume], { stdio: 'ignore' }); } catch { /* Already removed by fixture cleanup. */ }
}
