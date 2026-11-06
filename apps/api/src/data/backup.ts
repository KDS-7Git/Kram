import PgBoss from 'pg-boss';
import { studyDate } from '@kram/time';
import { config } from '../config';
import { getSettings } from '../modules/hierarchy/service';

/** HTTP only queues work; the worker owns locking, encryption, retries and status. */
export async function requestBackup(userId: string, clientEventId: string, now = new Date()) {
  const settings = await getSettings(userId);
  const periodKey = `manual-${clientEventId}`;
  const boss = new PgBoss({ connectionString: config.databaseUrl, max: 1, supervise: false, schedule: false });
  boss.on('error', () => undefined);
  try {
    await boss.start(); await boss.createQueue('backup', { name: 'backup', policy: 'stately', retryLimit: 3, retryDelay: 60, retryBackoff: true });
    const jobId = await boss.send('backup', { periodKey, periodDay: studyDate(now.getTime(), settings.timezone, settings.dayRollover), timezone: settings.timezone, reason: 'manual', missedPeriods: [], catchUpCapped: false, scheduledAt: now.toISOString() },
      { singletonKey: periodKey, retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 3600 });
    return { queued: true, periodKey, jobId };
  } finally { await boss.stop(); }
}
