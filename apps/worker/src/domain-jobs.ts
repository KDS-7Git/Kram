import pg from 'pg';
import PgBoss from 'pg-boss';
import { createHash } from 'node:crypto';
import { db } from '../../api/src/db';
import { config } from '../../api/src/config';
import { newId, json } from '../../api/src/repository';
import { DISPATCH_QUEUE, MATERIALIZE_QUEUE } from '../../api/src/jobs';
import { dispatchNotifications, refreshReminders } from '../../api/src/modules/notifications/service';
import { settingsSchema } from '@kram/shared';
import { studyDate } from '@kram/time';
import { missingMaterializationDates } from './domain-calendar';

const SCHEDULE_QUEUE = 'materialize-schedule';
const lockPart = (value: string) => createHash('sha256').update(value).digest().readInt32BE(0);

/** Only successful completion is recorded; retries remain pg-boss history. */
export async function runDurableJob(jobName: string, periodKey: string, userId: string | null, operation: () => Promise<unknown>) {
  const client = new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 15000 });
  const parts = [lockPart(`kram:${jobName}`), lockPart(periodKey)]; let locked = false;
  try {
    await client.connect();
    locked = Boolean((await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1,$2) AS locked', parts)).rows[0]?.locked);
    if (!locked) throw new Error('This job period is already running');
    const existing = await db.jobRun.findUnique({ where: { jobName_periodKey: { jobName, periodKey } } });
    if (existing) return { reused: true, run: existing };
    const startedAt = new Date(); await operation();
    const run = await db.jobRun.create({ data: { id: newId(), userId, jobName, periodKey, startedAt, finishedAt: new Date(), status: 'succeeded', detail: json({ completed: true }) } });
    return { reused: false, run };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1,$2)', parts).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

let scheduledZone: string | undefined;
export async function reconcileDomainJobs(boss: PgBoss, now = new Date()) {
  const owner = await db.user.findFirst({ where: { isOwner: true } }); if (!owner) return;
  const settings = settingsSchema.parse(owner.settings);
  if (settings.timezone !== scheduledZone) { await boss.schedule(SCHEDULE_QUEUE, '0 3 * * *', {}, { tz: settings.timezone }); scheduledZone = settings.timezone; }
  const today = studyDate(now.getTime(), settings.timezone, settings.dayRollover);
  const last = await db.jobRun.findFirst({ where: { jobName: MATERIALIZE_QUEUE, userId: owner.id }, orderBy: { periodKey: 'desc' } });
  const lastDate = last?.periodKey.split(':').at(-1);
  for (const date of missingMaterializationDates(today, lastDate)) {
    const periodKey = `${owner.id}:${date}`;
    await boss.send(MATERIALIZE_QUEUE, { userId: owner.id, date, periodKey }, { singletonKey: periodKey, retryLimit: 3, retryDelay: 30, retryBackoff: true });
  }
}

export async function registerDomainJobs(boss: PgBoss) {
  for (const name of [DISPATCH_QUEUE, MATERIALIZE_QUEUE, SCHEDULE_QUEUE]) await boss.createQueue(name, { name, policy: 'stately', retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 });
  await boss.work<{ periodKey?: string }>(DISPATCH_QUEUE, { includeMetadata: true }, async jobs => {
    for (const job of jobs) await runDurableJob(DISPATCH_QUEUE, job.data.periodKey ?? job.createdOn.toISOString().slice(0, 16), null, () => dispatchNotifications());
  });
  await boss.work<{ userId: string; date: string; periodKey: string }>(MATERIALIZE_QUEUE, async jobs => {
    for (const job of jobs) await runDurableJob(MATERIALIZE_QUEUE, job.data.periodKey, job.data.userId, async () => {
      const { materializeTasks } = await import('../../api/src/modules/tasks/service');
      await materializeTasks(job.data.userId, job.data.date); await refreshReminders(job.data.userId);
    });
  });
  await boss.work(SCHEDULE_QUEUE, async () => { await reconcileDomainJobs(boss); });
  await boss.schedule(DISPATCH_QUEUE, '* * * * *', {}, { tz: 'UTC' });
  await reconcileDomainJobs(boss);
  await boss.send(DISPATCH_QUEUE, { periodKey: new Date().toISOString().slice(0, 16) });
}
