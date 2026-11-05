import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';

const file = process.env.WORKER_HEALTH_FILE || '/tmp/kram-worker-health.json';
try {
  const heartbeat = JSON.parse(await readFile(file, 'utf8'));
  const instant = Date.parse(heartbeat.at || heartbeat.timestamp);
  if ((heartbeat.status && heartbeat.status !== 'ok') || !Number.isFinite(instant) || Date.now() - instant > 180_000) process.exit(1);
} catch {
  const db = new PrismaClient();
  try {
    const entry = await db.systemMeta.findUnique({ where: { key: 'worker-heartbeat' } });
    const value = entry?.value;
    const timestamp = typeof value === 'string' ? value : value?.at || value?.timestamp;
    const instant = Date.parse(timestamp);
    if (!Number.isFinite(instant) || Date.now() - instant > 180_000) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
