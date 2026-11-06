import PgBoss from 'pg-boss';
import { config } from './config';
import { logger } from './logger';

export const DISPATCH_QUEUE = 'dispatch-notifications';
export const MATERIALIZE_QUEUE = 'materialize-tasks';
export const OCCURRENCE_QUEUE = 'materialize-occurrences';
export const PLANNING_QUEUE = 'generate-plan';
let producer: Promise<PgBoss> | undefined;

async function queue() {
  if (!producer) producer = (async () => {
    const boss = new PgBoss({ connectionString: config.databaseUrl, max: 2, supervise: false, schedule: false });
    boss.on('error', error => logger.error({ error: error.message }, 'job producer error'));
    try {
      await boss.start();
      for (const name of [DISPATCH_QUEUE, MATERIALIZE_QUEUE, OCCURRENCE_QUEUE, PLANNING_QUEUE]) await boss.createQueue(name, { name, policy: 'stately', retryLimit: 3, retryDelay: 30, retryBackoff: true });
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

export async function enqueuePlanning(userId:string,changeKey:string,reason:string) {
  const periodKey=`${userId}:change:${changeKey}`;
  return (await queue()).send(PLANNING_QUEUE,{userId,periodKey,reason},{singletonKey:periodKey,retryLimit:3,retryDelay:30,retryBackoff:true});
}
