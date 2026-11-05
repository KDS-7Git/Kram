import { db } from './db';
const command=process.argv[2];
try {
  if(command==='health'){await db.$queryRaw`SELECT 1`;process.stdout.write('Database connected.\n');}
  else if(command==='worker-health'){const heartbeat=await db.systemMeta.findUnique({where:{key:'worker-heartbeat'}});const at=heartbeat?new Date(String(heartbeat.value)).getTime():NaN;if(!Number.isFinite(at)||Date.now()-at>180000)process.exitCode=1;else process.stdout.write('Worker heartbeat current.\n');}
  else {process.stdout.write('Kram CLI\nCommands: health, worker-health\n');if(command)process.exitCode=1;}
} finally {await db.$disconnect();}
