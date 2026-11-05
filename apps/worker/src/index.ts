import PgBoss from 'pg-boss';
import { db } from '../../api/src/db';
import { config } from '../../api/src/config';
import { logger } from '../../api/src/logger';
import { writeFile,rename } from 'node:fs/promises';
import { BACKUP_QUEUE, BACKUP_SCHEDULE_QUEUE, enqueueDueBackup, ownerTimezone, type BackupJob } from './backup-scheduling';
import { performBackup } from './backup-service';
import { registerDomainJobs, reconcileDomainJobs, runDurableJob } from './domain-jobs';

const boss = new PgBoss(config.databaseUrl);
boss.on('error',error=>logger.error({error:error.message},'job queue error'));
await boss.start();
await registerDomainJobs(boss);
await boss.createQueue(BACKUP_QUEUE, { name: BACKUP_QUEUE, policy: 'stately', retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 3600 });
await boss.createQueue(BACKUP_SCHEDULE_QUEUE);
await boss.work<BackupJob>(BACKUP_QUEUE, { includeMetadata: true }, async jobs => {
  for (const job of jobs) await runDurableJob(BACKUP_QUEUE, job.data.periodKey, null, () => performBackup(job.id, job.data, job.retryCount + 1));
});
await boss.work(BACKUP_SCHEDULE_QUEUE, async () => { await enqueueDueBackup(boss); });
let scheduledTimezone: string | undefined;
async function reconcileBackups() {
  await reconcileDomainJobs(boss);
  const timezone = await ownerTimezone();
  if (timezone !== scheduledTimezone) {
    await boss.schedule(BACKUP_SCHEDULE_QUEUE, '0 3 * * *', {}, { tz: timezone });
    scheduledTimezone = timezone;
  }
  await enqueueDueBackup(boss, new Date(), timezone);
}
await boss.createQueue('healthcheck-report');
await boss.work('healthcheck-report',async()=>{await reconcileBackups();const now=new Date().toISOString();await db.systemMeta.upsert({where:{key:'worker-heartbeat'},create:{key:'worker-heartbeat',value:now},update:{value:now}});const file=process.env.WORKER_HEALTH_FILE || '/tmp/kram-worker-health.json';await writeFile(`${file}.tmp`,JSON.stringify({status:'ok',timestamp:now}));await rename(`${file}.tmp`,file);});
await boss.schedule('healthcheck-report','* * * * *',{}, {tz:'UTC'});
await reconcileBackups();
await boss.send('healthcheck-report',{});
logger.info('Kram worker started');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{void boss.stop().then(()=>db.$disconnect()).finally(()=>process.exit(0));});
