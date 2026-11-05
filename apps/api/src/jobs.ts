import PgBoss from 'pg-boss';
import { config } from './config';
import { logger } from './logger';

export const DISPATCH_QUEUE = 'dispatch-notifications';
export const MATERIALIZE_QUEUE = 'materialize-tasks';
let producer: Promise<PgBoss> | undefined;

async function queue() {
  if (!producer) producer = (async () => {
    const boss = new PgBoss({ connectionString: config.databaseUrl, max: 2, supervise: false, schedule: false });
    boss.on('error', error => logger.error({ error: error.message }, 'job producer error'));
    try {
      await boss.start();
      for (const name of [DISPATCH_QUEUE, MATERIALIZE_QUEUE]) await boss.createQueue(name, { name, policy: 'stately', retryLimit: 3, retryDelay: 30, retryBackoff: true });
      return boss;
    } catch (error) { await boss.stop().catch(() => undefined); producer = undefined; throw error; }
  })();
  return producer;
}

export async function enqueueDispatch(periodKey: string) {
  return (await queue()).send(DISPATCH_QUEUE, { periodKey }, { singletonKey: periodKey, retryLimit: 3, retryDelay: 30, retryBackoff: true });
}
export async function enqueueMaterialization(userId: string, date: string) {
  const periodKey = `${userId}:${date}`;
  return (await queue()).send(MATERIALIZE_QUEUE, { userId, date, periodKey }, { singletonKey: periodKey, retryLimit: 3, retryDelay: 30, retryBackoff: true });
}
export async function closeJobProducer() {
  const current = producer; producer = undefined;
  if (current) await (await current).stop();
}
