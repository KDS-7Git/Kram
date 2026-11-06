import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type PgBoss from 'pg-boss';
import { db } from '../../api/src/db';
import { config } from '../../api/src/config';

export const BACKUP_QUEUE = 'backup';
export const BACKUP_SCHEDULE_QUEUE = 'backup-schedule';
export const BACKUP_SCHEDULE_KEY = 'backup-schedule';
export const BACKUP_STATUS_KEY = 'backup-status';

export interface BackupJob {
  periodKey: string;
  periodDay: string;
  timezone: string;
  reason: 'initial' | 'nightly' | 'catch-up' | 'timezone-change' | 'manual';
  missedPeriods: string[];
  catchUpCapped: boolean;
  scheduledAt: string;
}

export interface BackupScheduleState {
  periodDay: string;
  timezone: string;
  jobId: string;
  queuedAt: string;
}

/** A period names the latest local 03:00 that is due, not a historical snapshot. */
export function dueBackup(now: Date, timezone: string, previous?: BackupScheduleState): BackupJob | null {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) throw new Error('Invalid backup clock or timezone');
  const due = local.hour >= 3 ? local.startOf('day') : local.startOf('day').minus({ days: 1 });
  const periodDay = due.toISODate()!;
  if (previous?.timezone === timezone && previous.periodDay >= periodDay) return null;
  let reason: BackupJob['reason'] = previous ? 'timezone-change' : 'initial';
  let missedPeriods: string[] = [];
  let catchUpCapped = false;
  if (previous?.timezone === timezone) {
    const last = DateTime.fromISO(previous.periodDay, { zone: timezone });
    if (last.isValid) {
      const days = Math.round(due.diff(last.startOf('day'), 'days').days);
      reason = days > 1 ? 'catch-up' : 'nightly';
      catchUpCapped = days > 14;
      // One current snapshot covers an outage; the most recent missed periods
      // are recorded in civil-date order, without manufacturing old archives.
      const count = Math.min(Math.max(days, 0), 14);
      missedPeriods = Array.from({ length: count }, (_, index) => due.minus({ days: count - index - 1 }).toISODate()!);
    }
  }
  const zoneKey = createHash('sha256').update(timezone).digest('hex').slice(0, 12);
  return { periodKey: `nightly-${periodDay}-${zoneKey}`, periodDay, timezone, reason, missedPeriods, catchUpCapped, scheduledAt: now.toISOString() };
}

export async function ownerTimezone() {
  const owner = await db.user.findFirst({ where: { isOwner: true }, select: { timezone: true } });
  return owner?.timezone ?? config.defaultTimezone;
}

export async function enqueueDueBackup(boss: PgBoss, now = new Date(), timezone?: string) {
  const zone = timezone ?? await ownerTimezone();
  const record = await db.systemMeta.findUnique({ where: { key: BACKUP_SCHEDULE_KEY } });
  const previous = record?.value as unknown as BackupScheduleState | undefined;
  const data = dueBackup(now, zone, previous);
  if (!data) return null;
  const jobId = await boss.send(BACKUP_QUEUE, data, {
    singletonKey: data.periodKey, retryLimit: 3, retryDelay: 60,
    retryBackoff: true, expireInSeconds: 3600,
  });
  if (jobId) {
    const value = { periodDay: data.periodDay, timezone: zone, jobId, queuedAt: data.scheduledAt };
    await db.systemMeta.upsert({ where: { key: BACKUP_SCHEDULE_KEY }, create: { key: BACKUP_SCHEDULE_KEY, value }, update: { value } });
  }
  return jobId;
}
