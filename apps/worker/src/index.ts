import PgBoss from 'pg-boss';
import { db } from '../../api/src/db';
import { config } from '../../api/src/config';
import { logger } from '../../api/src/logger';
import { writeFile,rename } from 'node:fs/promises';

const boss = new PgBoss(config.databaseUrl);
boss.on('error',error=>logger.error({error:error.message},'job queue error'));
await boss.start();
await boss.createQueue('healthcheck-report');
await boss.work('healthcheck-report',async()=>{const now=new Date().toISOString();await db.systemMeta.upsert({where:{key:'worker-heartbeat'},create:{key:'worker-heartbeat',value:now},update:{value:now}});await writeFile('/tmp/kram-worker-health.json.tmp',JSON.stringify({status:'ok',timestamp:now}));await rename('/tmp/kram-worker-health.json.tmp','/tmp/kram-worker-health.json');});
await boss.schedule('healthcheck-report','* * * * *',{}, {tz:'UTC'});
await boss.send('healthcheck-report',{});
logger.info('Kram worker started');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{void boss.stop().then(()=>db.$disconnect()).finally(()=>process.exit(0));});
