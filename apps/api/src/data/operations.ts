import { db } from '../db';
import { newId, json } from '../repository';
import { recoveryHealth } from './health';

/** Durable sources consumed by the normal notification dispatcher, without transport I/O. */
export async function queueBackupFailure(periodKey: string, now = new Date()) {
  const owner = await db.user.findFirst({ where: { isOwner: true }, select: { id: true } });
  if (!owner) return { count: 0 };
  return db.notification.createMany({ data: [{ id: newId(), userId: owner.id, type: 'backup_failed',
    title: 'Kram backup needs attention', body: 'The latest backup or restore verification failed. The last successful recovery point is preserved. Open Settings → Recovery health and check worker logs.',
    scheduledFor: now, dedupeKey: `backup-failed:${periodKey}`, ownerType: 'global' }], skipDuplicates: true });
}
export async function recordHealthReport(now = new Date()) {
  const owner = await db.user.findFirst({ where: { isOwner: true }, select: { id: true } });
  if (!owner) return null;
  const report = await recoveryHealth(owner.id);
  const periodKey = now.toISOString().slice(0, 13);
  await db.systemMeta.upsert({ where: { key: 'health-report' }, create: { key: 'health-report', value: json(report) }, update: { value: json(report) } });
  const body = [
    `Disk ${report.disk ? `${report.disk.usedPercent}% used` : 'unavailable'}. Database ${Math.round(report.databaseBytes / 1024 / 1024)} MB.`,
    `Queue ${report.queue ? `${report.queue.pending} due; oldest ${Math.round(report.queue.lagSeconds / 60)} min` : 'unavailable'}.`,
    `Last backup ${report.backup.lastSuccessAt ?? 'not recorded'}.`,
    `Latest jobs: ${report.latestJobs.map(job => `${job.jobName} ${job.status}`).join(', ') || 'none'}.`,
    ...(report.alerts.length ? [report.alerts.join(' ')] : []),
  ].join(' ');
  await db.notification.createMany({ data: [{ id: newId(), userId: owner.id, type: 'healthcheck_report', title: 'Kram hourly health', body,
    scheduledFor: now, dedupeKey: `healthcheck-report:${periodKey}`, ownerType: 'global' }], skipDuplicates: true });
  return report;
}
