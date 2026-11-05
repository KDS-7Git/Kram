import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { GenericContainer,Wait,type StartedTestContainer } from 'testcontainers';
import { execFileSync } from 'node:child_process';
import PgBoss from 'pg-boss';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';

let container:StartedTestContainer,db:PrismaClient,app:Express,url:string;
beforeAll(async()=>{
  container=await new GenericContainer('postgres:16-bookworm').withEnvironment({POSTGRES_USER:'kram',POSTGRES_PASSWORD:'integration-only',POSTGRES_DB:'kram'}).withExposedPorts(5432).withHealthCheck({test:['CMD-SHELL','pg_isready -U kram -d kram'],interval:1000,timeout:3000,retries:30,startPeriod:1000}).withWaitStrategy(Wait.forHealthCheck()).start();
  url=`postgresql://kram:integration-only@${container.getHost()}:${container.getMappedPort(5432)}/kram`;
  process.env.DATABASE_URL=url;process.env.NODE_ENV='test';process.env.SESSION_SECRET='integration-test-secret-that-is-long-enough';process.env.ENCRYPTION_KEY='integration-test-key-that-is-long-enough';
  execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','apps/api/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:url},stdio:'pipe'});
  ({db}=await import('../../apps/api/src/db'));const {createApp}=await import('../../apps/api/src/app');app=createApp();
},120000);
afterAll(async()=>{await db?.$disconnect();await container?.stop();});

describe('foundation runtime',()=>{
  it('boots API after forward-only migrations on clean PostgreSQL',async()=>{const result=await request(app).get('/api/v1/health');expect(result.status).toBe(200);expect(result.body).toMatchObject({status:'ok',database:'connected'});});
  it('returns a stable error envelope with request IDs for malformed or oversized JSON',async()=>{const malformed=await request(app).post('/api/v1/foundation').set('Content-Type','application/json').send('{');expect(malformed.status).toBe(400);expect(malformed.body.error.code).toBe('VALIDATION_FAILED');expect(malformed.body.error.requestId).toBe(malformed.headers['x-request-id']);const oversized=await request(app).post('/api/v1/foundation').send({text:'x'.repeat(270000)});expect(oversized.status).toBe(413);expect(oversized.body.error.code).toBe('REQUEST_TOO_LARGE');});
  it('retains a queued job across queue process restart',async()=>{
    const first=new PgBoss(url);await first.start();await first.createQueue('foundation-restart-spike');const id=await first.send('foundation-restart-spike',{marker:'restart'});await first.stop();
    const second=new PgBoss(url);await second.start();const jobs=await second.fetch<{marker:string}>('foundation-restart-spike');expect(jobs).toHaveLength(1);expect(jobs[0]?.id).toBe(id);expect(jobs[0]?.data.marker).toBe('restart');await second.complete('foundation-restart-spike',id!);await second.stop();
  });
});
