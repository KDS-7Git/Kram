import { queueBackupFailure } from '../../api/src/data/operations';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { db } from '../../api/src/db';
import { config } from '../../api/src/config';
import { logger } from '../../api/src/logger';
import { BACKUP_STATUS_KEY, type BackupJob } from './backup-scheduling';

// Session locks must use a dedicated connection, never Prisma's pooled session.
const BACKUP_LOCK = [1263681871, 1];

interface BackupManifest {
  id: string;
  path: string;
  createdAt: string;
  sha256: string;
  sizeBytes: number;
  localOnly: boolean;
  encrypted: boolean;
  formatVersion?: number;
}

export function executeLocalBackup(periodKey: string): Promise<BackupManifest> {
  return new Promise((resolveDone, reject) => {
    const child = spawn(process.execPath, [resolve(process.env.BACKUP_MODE === 'encrypted' ? 'infra/backup/recovery.mjs' : 'infra/backup/backup.mjs'), 'run', ...(process.env.BACKUP_MODE === 'encrypted' ? [] : ['--local-only']), `--period-key=${periodKey}`], {
      env: { ...process.env, DATABASE_URL: config.databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_300_000,
    });
    let output = '', errorOutput = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.length > 1_000_000) { child.kill('SIGTERM'); reject(new Error('Backup manifest exceeds the output limit')); }
    });
    child.stderr.on('data', chunk => { if (errorOutput.length < 8000) errorOutput += String(chunk).slice(0, 8000 - errorOutput.length); });
    child.once('error', () => reject(new Error('Local backup process could not start')));
    child.once('close', code => {
      if (code !== 0) return reject(new Error(`Local backup process failed: ${errorOutput.trim()}`));
      try {
        const result: BackupManifest = JSON.parse(output);
        if (result.id !== periodKey || typeof result.sha256 !== 'string' || (process.env.BACKUP_MODE === 'encrypted' ? !result.encrypted || result.formatVersion !== 2 : !result.localOnly || result.encrypted)) throw new Error('Invalid backup result');
        resolveDone(result);
      } catch { reject(new Error('Local backup process returned an invalid manifest')); }
    });
  });
}

export async function performBackup(jobId: string, data: BackupJob, attempt: number, runner = executeLocalBackup) {
  const lock = new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 15_000 });
  let acquired = false;
  try {
    await lock.connect();
    acquired = Boolean((await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', BACKUP_LOCK)).rows[0]?.locked);
    if (!acquired) throw new Error('Another backup is running');
    const prior = await db.systemMeta.findUnique({ where: { key: BACKUP_STATUS_KEY } });
    const priorValue = prior?.value;
    const priorSuccess = priorValue && typeof priorValue === 'object' && !Array.isArray(priorValue) ? priorValue.lastSuccess ?? null : null;
    const startedAt = new Date().toISOString();
    const base = { jobId, ...data, attempt, startedAt, localOnly: !process.env.BACKUP_OFFSITE_DIR && !process.env.BACKUP_OFFSITE_REMOTE, encrypted: process.env.BACKUP_MODE === 'encrypted' };
    await db.systemMeta.upsert({ where: { key: BACKUP_STATUS_KEY }, create: { key: BACKUP_STATUS_KEY, value: { ...base, status: 'running', lastSuccess: priorSuccess } }, update: { value: { ...base, status: 'running', lastSuccess: priorSuccess } } });
    try {
      const manifest = await runner(data.periodKey);
      const finishedAt = new Date().toISOString();
      const lastSuccess = { ...manifest, finishedAt, periodDay: data.periodDay, timezone: data.timezone };
      const value = { ...base, status: 'succeeded', finishedAt, lastSuccess, error: null };
      await db.systemMeta.upsert({ where: { key: BACKUP_STATUS_KEY }, create: { key: BACKUP_STATUS_KEY, value }, update: { value } });
      logger.info({ jobId, periodKey: data.periodKey, attempt, sizeBytes: manifest.sizeBytes }, 'local backup completed');
      return manifest;
    } catch (error) {
      const value = { ...base, status: 'failed', finishedAt: new Date().toISOString(), lastSuccess: priorSuccess,
        error: { code: 'BACKUP_FAILED', message: 'Local backup failed. Check worker logs, disk capacity and PostgreSQL client tools.' } };
      await db.systemMeta.upsert({ where: { key: BACKUP_STATUS_KEY }, create: { key: BACKUP_STATUS_KEY, value }, update: { value } });
      await queueBackupFailure(data.periodKey).catch(()=>undefined);
      logger.error({ jobId, periodKey: data.periodKey, attempt, error: error instanceof Error ? error.message : 'Backup failed' }, 'local backup failed');
      throw error;
    }
  } finally {
    if (acquired) await lock.query('SELECT pg_advisory_unlock($1, $2)', BACKUP_LOCK).catch(() => undefined);
    await lock.end().catch(() => undefined);
  }
}
