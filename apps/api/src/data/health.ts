import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db } from '../db';
import { ownerWhere } from '../repository';

type BackupStatus = { status?: string; finishedAt?: string; lastSuccess?: { createdAt?: string; encrypted?: boolean; localOnly?: boolean; lastVerificationAt?: string; verification?: { verifiedAt?: string; verified?: boolean }; offDevice?: { copiedAt?: string; destination?: string } }; error?: { code?: string; message?: string } };
export async function recoveryHealth(userId: string) {
  const now = new Date();
  const [size, backupRow, jobs, failures, disk, queue] = await Promise.all([
    db.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database()) AS bytes`,
    db.systemMeta.findUnique({ where: { key: 'backup-status' } }),
    db.jobRun.findMany({ where: { OR: [{ userId }, { userId: null }] }, orderBy: { finishedAt: 'desc' }, take: 200, select: { jobName: true, finishedAt: true, status: true } }),
    db.notification.count({ where: { ...ownerWhere(userId), status: 'failed', attemptCount: { gte: 3 } } }),
    statfs(resolve(process.env.BACKUP_DIR ?? '.')).then(info => ({ totalBytes: info.blocks * info.bsize, availableBytes: info.bavail * info.bsize, usedPercent: Math.round((1 - info.bfree / info.blocks) * 100) })).catch(() => null),
    db.$queryRaw<{ pending: bigint; lagSeconds: number | null }[]>`SELECT count(*) AS pending, max(extract(epoch FROM (now() - start_after)))::float AS "lagSeconds" FROM pgboss.job WHERE state IN ('created','retry') AND start_after <= now()`.then(rows => ({ pending: Number(rows[0]?.pending ?? 0), lagSeconds: rows[0]?.lagSeconds ?? 0 })).catch(() => null),
  ]);
  const raw = (backupRow?.value ?? {}) as BackupStatus;
  const last = raw.lastSuccess;
  const verifiedAt = last?.verification?.verifiedAt ?? last?.lastVerificationAt ?? null;
  const backupAgeHours = last?.createdAt && Number.isFinite(Date.parse(last.createdAt)) ? Math.max(0, (now.getTime() - Date.parse(last.createdAt)) / 3_600_000) : null;
  const latestJobs = [...new Map(jobs.map(job => [job.jobName, job] as const).reverse()).values()];
  const alerts = [
    ...(disk && disk.usedPercent > 80 ? ['Disk usage is above 80%.'] : []),
    ...(backupAgeHours === null ? ['No successful scheduled backup has been recorded.'] : backupAgeHours > 36 ? ['The last backup is older than 36 hours.'] : []),
    ...(raw.status === 'failed' ? ['The latest backup attempt failed.'] : []),
    ...(last && !last.encrypted ? ['Encrypted recovery is not configured.'] : []),
    ...(last && !last.offDevice?.copiedAt ? ['No off-device copy is recorded.'] : []),
    ...(last?.encrypted && (!verifiedAt || now.getTime() - Date.parse(verifiedAt) > 8 * 86400000) ? ['A successful restore check is overdue.'] : []),
    ...(queue && queue.lagSeconds > 3600 ? ['Due background jobs have waited more than an hour.'] : []),
    ...(failures ? [`${failures} notifications failed repeatedly.`] : []),
  ];
  return { checkedAt: now.toISOString(), databaseBytes: Number(size[0]?.bytes ?? 0), disk, queue, latestJobs, alerts, backupAgeHours,
    backup: { status: raw.status ?? 'not-configured', finishedAt: raw.finishedAt ?? null,
      lastSuccessAt: last?.createdAt ?? null, encrypted: last?.encrypted ?? false, offDeviceAt: last?.offDevice?.copiedAt ?? null,
      verifiedAt, error: raw.error?.message ?? null }, targets: { rpoHours: 24, rtoHours: 2 } };
}
export type RecoveryHealth = Awaited<ReturnType<typeof recoveryHealth>>;
