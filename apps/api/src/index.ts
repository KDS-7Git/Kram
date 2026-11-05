import { createApp } from './app';
import { config } from './config';
import { db } from './db';
import { logger } from './logger';
const server=createApp().listen(config.port,config.host,()=>logger.info({host:config.host,port:config.port},'Kram API listening'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{void db.$disconnect().finally(()=>process.exit(0));}));
