import type PgBoss from 'pg-boss';
import { settingsSchema } from '@kram/shared';
import { addDays, localToInstant, studyDate } from '@kram/time';
import { db } from '../../api/src/db';
import { evaluateStreaks } from '../../api/src/streaks/service';
import { refreshFullReminders } from '../../api/src/streaks/full-notifications';
import { pollTelegramUpdates } from '../../api/src/streaks/channel-service';
import { runDurableJob } from './domain-jobs';
export const STREAK_QUEUE = 'evaluate-streaks';
export const STREAK_RECONCILE_QUEUE = 'reconcile-streaks';
export async function reconcileStreakJobs(boss: PgBoss, now = new Date()) {
  const owner = await db.user.findFirst({ where: { isOwner: true } }); if (!owner) return;
  const settings = settingsSchema.parse(owner.settings), today = studyDate(now.getTime(), settings.timezone, settings.dayRollover);
  const last = await db.jobRun.findFirst({ where: { userId: owner.id, jobName: STREAK_QUEUE }, orderBy: { periodKey: 'desc' } });
  const lastDate = last?.periodKey.split(':').at(-1), floor = addDays(today, -14);
  for (let date = lastDate && lastDate >= floor ? addDays(lastDate, 1) : floor; date < today; date = addDays(date, 1)) {
    const periodKey = `${owner.id}:${date}`;
    await boss.send(STREAK_QUEUE, { userId: owner.id, date, periodKey }, { singletonKey: periodKey, retryLimit: 3, retryDelay: 30, retryBackoff: true });
  }
  // Minute reconciliation picks up late progress, review decisions and rule changes.
  const periodKey = `${owner.id}:${now.toISOString().slice(0, 16)}`;
  await boss.send(STREAK_RECONCILE_QUEUE, { userId: owner.id, periodKey }, { singletonKey: periodKey, retryLimit: 3, retryDelay: 30, retryBackoff: true });
}
export async function registerStreakJobs(boss: PgBoss) {
  for (const name of [STREAK_QUEUE, STREAK_RECONCILE_QUEUE]) await boss.createQueue(name, { name, policy: 'stately', retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 });
  await boss.work<{ userId: string; date: string; periodKey: string }>(STREAK_QUEUE, async jobs => {
    for (const job of jobs) await runDurableJob(STREAK_QUEUE, job.data.periodKey, job.data.userId, async () => {
      const owner = await db.user.findFirst({ where: { id: job.data.userId, isOwner: true } }); if (!owner) return;
      const settings = settingsSchema.parse(owner.settings);
      await evaluateStreaks(owner.id, db, new Date(localToInstant(addDays(job.data.date, 1), settings.dayRollover, settings.timezone)));
    });
  });
  await boss.work<{ userId?: string; periodKey?: string }>(STREAK_RECONCILE_QUEUE, async jobs => {
    for (const job of jobs) {
      if (!job.data.userId) { await reconcileStreakJobs(boss); continue; }
      const owner = await db.user.findFirst({ where: { id: job.data.userId, isOwner: true } }); if (!owner) continue;
      await runDurableJob(STREAK_RECONCILE_QUEUE, job.data.periodKey ?? `${owner.id}:${new Date().toISOString().slice(0, 16)}`, owner.id, async () => {
        await evaluateStreaks(owner.id); await refreshFullReminders(owner.id); await pollTelegramUpdates(new Date(), 20);
      });
    }
  });
  await boss.schedule(STREAK_RECONCILE_QUEUE, '* * * * *', {}, { tz: 'UTC' });
  await reconcileStreakJobs(boss);
}
