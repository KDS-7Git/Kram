import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {GenericContainer,Wait,type StartedTestContainer} from 'testcontainers';
import {execFileSync} from 'node:child_process';
import {devNull} from 'node:os';
import request,{type Agent} from 'supertest';
import type {Express} from 'express';
import type {PrismaClient} from '@prisma/client';
import {v7 as uuid} from 'uuid';
import {defaultSettings} from '@kram/shared';
import PgBoss from 'pg-boss';
import type {PlanInput,PlanResult} from '@kram/scheduler';
import type {WeeklyReviewReport} from '../../apps/api/src/modules/planning/weekly';
let container:StartedTestContainer,db:PrismaClient,app:Express,agent:Agent,clock:{now:()=>string},original:()=>string;
let csrf='',ownerId='',goalId='',taskId='',foreignId='',profileId='';
const origin='http://localhost:8420';
const get=(path:string)=>agent.get(`/api/v1${path}`);
const post=(path:string,body:Record<string,unknown>={})=>agent.post(`/api/v1${path}`).set('Origin',origin).set('X-CSRF-Token',csrf).send(body);
const patch=(path:string,body:Record<string,unknown>)=>agent.patch(`/api/v1${path}`).set('Origin',origin).set('X-CSRF-Token',csrf).send(body);
beforeAll(async()=>{
 container=await new GenericContainer('postgres:16-bookworm').withEnvironment({POSTGRES_USER:'kram',POSTGRES_PASSWORD:'planning-disposable-only',POSTGRES_DB:'kram'}).withExposedPorts(5432).withHealthCheck({test:['CMD-SHELL','pg_isready -U kram -d kram'],interval:1000,timeout:3000,retries:30,startPeriod:1000}).withWaitStrategy(Wait.forHealthCheck()).start();
 Object.assign(process.env,{DOTENV_CONFIG_PATH:devNull,DATABASE_URL:`postgresql://kram:planning-disposable-only@${container.getHost()}:${container.getMappedPort(5432)}/kram`,DATABASE_URL_FILE:'',NODE_ENV:'test',APP_URL:origin,COOKIE_SECURE:'false',SESSION_SECRET:'planning-session-secret-at-least-32chars',SESSION_SECRET_FILE:'',ENCRYPTION_KEY:'11'.repeat(32),ENCRYPTION_KEY_FILE:'',OWNER_SETUP_TOKEN:'',OWNER_SETUP_TOKEN_FILE:'',LOG_LEVEL:'silent'});
 execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','apps/api/prisma/schema.prisma'],{env:process.env,stdio:'pipe'});
 ({db}=await import('../../apps/api/src/db'));({clock}=await import('../../apps/api/src/calendar'));original=clock.now;clock.now=()=> '2026-11-06T12:00:00+05:30';
 const {createApp}=await import('../../apps/api/src/app');app=createApp();agent=request.agent(app);
 csrf=(await get('/auth/me').expect(200)).body.csrfToken;
 const auth=await post('/auth/setup',{email:'planning@kram.test',password:'planning-synthetic-owner-password-42'}).expect(201);csrf=auth.body.csrfToken;ownerId=auth.body.user.id;
 const p=await post('/profiles',{name:'Planning fixture'}).expect(201);profileId=p.body.id;const s=await post('/skills',{profileId,name:'Planning skill',availableDays:[1,2,3,4,5,6,7]}).expect(201);
 goalId=(await post('/goals',{skillId:s.body.id,type:'milestone',title:'Plan a course',unit:'minutes',targetQty:120,startDate:'2026-11-06',dueDate:'2026-11-15'}).expect(201)).body.id;
 taskId=(await post('/tasks',{goalId,title:'Reviewed task',estMinutes:60,earliestDate:'2026-11-06',dueDate:'2026-11-15'}).expect(201)).body.id;
 foreignId=(await db.user.create({data:{id:uuid(),email:'foreign-planning@kram.test',passwordHash:'fixture',isOwner:false,settings:defaultSettings}})).id;
},120000);
afterAll(async()=>{if(clock)clock.now=original;if(app?.locals.closeSessions)await app.locals.closeSessions();await db?.$disconnect();await container?.stop();});
describe('planning lifecycle and review transactions',()=>{
 it('proposes without changing the active timetable and reuses identical input',async()=>{
  const before=await db.timeSlot.count({where:{userId:ownerId,archivedAt:null}});
  const first=await post('/planning/generate').expect(200);expect(first.body.plan.state).toBe('proposed');expect(first.body.plan.result.items.length).toBeGreaterThan(0);
  expect(await db.timeSlot.count({where:{userId:ownerId,archivedAt:null}})).toBe(before);
  const again=await post('/planning/generate').expect(200);expect(again.body.reused).toBe(true);expect(again.body.plan.id).toBe(first.body.plan.id);
 });
 it('requires a matching ETag and validates ownership',async()=>{
  const status=(await get('/planning').expect(200)).body,id=status.versions[0].id;
  expect((await post(`/planning/versions/${id}/accept`)).status).toBe(428);
  expect((await post(`/planning/versions/${id}/accept`).set('If-Match','"9999"')).status).toBe(412);
  const foreign=await db.plan.create({data:{id:uuid(),userId:foreignId}});
  const v=await db.planVersion.create({data:{id:uuid(),userId:foreignId,planId:foreign.id,number:1,fromDate:new Date('2026-11-06'),toDate:new Date('2026-11-06'),algoVersion:'fixture',inputsHash:'a',sourceHash:'b',config:{},input:{},result:{},reason:'Foreign'}});
  expect((await post(`/planning/versions/${v.id}/accept`).set('If-Match',`"${status.version}"`)).status).toBe(404);
 });
 it('accepts a proposal and preserves immutable history',async()=>{
  const status=(await get('/planning').expect(200)).body,id=status.versions[0].id;
  await post(`/planning/versions/${id}/accept`).set('If-Match',`"${status.version}"`).expect(200);
  expect(await db.timeSlot.count({where:{userId:ownerId,archivedAt:null,applicationKey:{startsWith:'plan:'}}})).toBeGreaterThan(0);
  await expect(db.planVersion.update({where:{id},data:{reason:'Rewrite history'}})).rejects.toThrow(/immutable/);
  const item=await db.planItem.findFirstOrThrow({where:{versionId:id}});await expect(db.planItem.delete({where:{id:item.id}})).rejects.toThrow(/append|immutable/i);
 });
 it('rejects stale acceptance after a progress event and keeps the active version',async()=>{
  await post('/planning/generate',{recovery:true}).expect(200);
  const status=(await get('/planning')).body,proposal=status.versions.find((v:{state:string})=>v.state==='proposed');
  await post(`/tasks/${taskId}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-11-06T10:00:00+05:30',minutes:10}).expect(200);
  expect((await post(`/planning/versions/${proposal.id}/accept`).set('If-Match',`"${status.version}"`)).status).toBe(409);
  expect((await get('/planning')).body.activeVersionId).toBe(status.activeVersionId);
 });
 it('previews actual decisions without writing events or closing the day',async()=>{
  const review=(await get('/reviews/2026-11-06').expect(200)).body;
  const count=await db.progressEvent.count({where:{userId:ownerId}});
  const preview=await post('/reviews/preview',{date:'2026-11-06',decisions:[{taskId,decision:'partial',minutes:15,clientEventId:uuid()}]}).expect(200);
  expect(preview.body.token).toHaveLength(64);expect(preview.body.revision).toBe(review.revision);
  expect(await db.progressEvent.count({where:{userId:ownerId}})).toBe(count);
  expect((await db.dailyReview.findUniqueOrThrow({where:{userId_date:{userId:ownerId,date:new Date('2026-11-06')}}})).state).toBe('draft');
 });
 it('rejects a stale review preview and commits a fresh close atomically with replay',async()=>{
  const decisions=[{taskId,decision:'partial',minutes:15,clientEventId:uuid()}],body={date:'2026-11-06',decisions};
  const preview=(await post('/reviews/preview',body).expect(200)).body;
  await post(`/tasks/${taskId}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-11-06T11:00:00+05:30',minutes:5}).expect(200);
  expect((await post('/reviews/close',{...body,token:preview.token}).set('If-Match',`"${preview.revision}"`)).status).toBe(409);
  const fresh=(await post('/reviews/preview',body).expect(200)).body;
  const close=await post('/reviews/close',{...body,token:fresh.token}).set('If-Match',`"${fresh.revision}"`).expect(200);
  expect(close.body.review.state).toBe('closed');expect((await db.task.findUniqueOrThrow({where:{id:taskId}})).actualMinutes).toBe(30);
  const replay=await post('/reviews/close',{...body,token:fresh.token}).set('If-Match',`"${fresh.revision}"`).expect(200);expect(replay.body.replayed).toBe(true);
  expect(await db.progressEvent.count({where:{clientEventId:decisions[0]!.clientEventId}})).toBe(1);
 });
 it('declares explicit deadline choices and removes break dates from new work',async()=>{
  const old=(await db.goal.findUniqueOrThrow({where:{id:goalId}})).dueDate!;
  expect((await post('/planning/breaks',{from:'2026-11-09',to:'2026-11-10',reason:'Fixture break',choices:[]})).status).toBe(400);
  const applied=await post('/planning/breaks',{from:'2026-11-09',to:'2026-11-10',reason:'Fixture break',choices:[{goalId,action:'extend'}]}).expect(200);
  expect((await db.goal.findUniqueOrThrow({where:{id:goalId}})).dueDate!.getTime()-old.getTime()).toBe(2*86400000);
  expect(applied.body.plan.result.items.filter((p:{date:string})=>['2026-11-09','2026-11-10'].includes(p.date))).toHaveLength(0);
 });
 it('marks missing review work unverified without assuming a miss or completion',async()=>{
  const t=await post('/tasks',{goalId,title:'Unreported yesterday',estMinutes:30,earliestDate:'2026-11-05'}).expect(201);
  const {reconcileMissedReviews}=await import('../../apps/api/src/modules/planning/service');await reconcileMissedReviews(ownerId);await reconcileMissedReviews(ownerId);
  expect(await db.task.findUniqueOrThrow({where:{id:t.body.id}})).toMatchObject({unverified:true,status:'pending',actualMinutes:0});
  expect(await db.dailyReview.count({where:{userId:ownerId,date:new Date('2026-11-05')}})).toBe(1);
 });
});

describe('weekly review decisions and reports',()=>{
 it('covers the whole next week at horizon one, protects the current allocation, and never autoaccepts a weekly review',async()=>{
  const value=await fixture('minutes',180),settings=(await db.user.findUniqueOrThrow({where:{id:ownerId}})).settings;
  const oldSlots=await db.timeSlot.findMany({where:{userId:ownerId,archivedAt:null}});
  try {
   await db.timeSlot.updateMany({where:{id:{in:oldSlots.map(slot=>slot.id)}},data:{archivedAt:new Date()}});
   await db.user.update({where:{id:ownerId},data:{settings:{...defaultSettings,horizonDays:1,planningMode:'adaptive',restDays:[],minFreeMin:0,minBreakMin:0,maxDailyMin:360,maxWeeklyMin:2520}}});
   const kept=(await post('/tasks',{goalId:value.goalId,title:'Existing current-week commitment',estMinutes:60,earliestDate:'2026-11-08'}).expect(201)).body;
   const last=(await post('/tasks',{goalId:value.goalId,title:'Last day of next week',estMinutes:60,earliestDate:'2026-11-15',dueDate:'2026-11-15'}).expect(201)).body;
   const slot=await db.timeSlot.create({data:{id:uuid(),userId:ownerId,goalId:value.goalId,skillId:value.skillId,taskId:kept.id,title:kept.title,date:new Date('2026-11-08'),startMin:600,endMin:660,applicationKey:`plan:weekly-fixture:${uuid()}`}});
   const weekly={reviewedWeek:'2026-11-02',targetWeek:'2026-11-09'},before=await db.timeSlot.count({where:{userId:ownerId,archivedAt:null}});
   const first=(await post('/planning/generate',{weekly,reason:'Weekly fixture'}).expect(200)).body;
   expect(first.plan.state).toBe('proposed');expect(first.plan.result.changes.requiresApproval).toBe(true);
   expect(first.plan.toDate.slice(0,10)).toBe('2026-11-15');expect(first.plan.input.horizonDays).toBe(10);
   expect(first.plan.result.items).toContainEqual(expect.objectContaining({taskId:kept.id,date:'2026-11-08',startMin:600,endMin:660}));
   expect(first.plan.result.items).toContainEqual(expect.objectContaining({taskId:last.id,date:'2026-11-15'}));
   expect(await db.timeSlot.count({where:{userId:ownerId,archivedAt:null}})).toBe(before);
   expect(first.plan.input.weeklyReview).toMatchObject({...weekly,summary:{weekStart:weekly.reviewedWeek,targetWeekStart:weekly.targetWeek}});
   await expect(db.planVersion.update({where:{id:first.plan.id},data:{input:{altered:true}}})).rejects.toThrow(/immutable/i);
   await post(`/planning/versions/${first.plan.id}/accept`).set('If-Match',`"${first.version}"`).expect(200);
   expect(await db.timeSlot.findUniqueOrThrow({where:{id:slot.id}})).toMatchObject({archivedAt:null,startMin:600,endMin:660});
   const second=(await post('/planning/generate',{weekly}).expect(200)).body;
   expect(second.plan.state).toBe('proposed');expect(second.plan.id).not.toBe(first.plan.id);expect(second.reused).toBe(false);
   const identical=(await post('/planning/generate',{weekly}).expect(200)).body;expect(identical.reused).toBe(true);expect(identical.plan.id).toBe(second.plan.id);
   await post(`/tasks/${last.id}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:clock.now(),minutes:0,note:'Source changes still require a fresh approval.'}).expect(200);
   await post(`/planning/versions/${second.plan.id}/accept`).set('If-Match',`"${second.version}"`).expect(409);
   for(const mode of ['balanced','deadline']) {
    await db.user.update({where:{id:ownerId},data:{settings:{...defaultSettings,horizonDays:1,planningMode:mode,restDays:[],minFreeMin:0,minBreakMin:0}}});
    const proposal=(await post('/planning/generate',{weekly}).expect(200)).body;expect(proposal.plan.state).toBe('proposed');expect(proposal.plan.result.changes.requiresApproval).toBe(true);
   }
   const pending=await db.planVersion.findFirstOrThrow({where:{userId:ownerId,state:'proposed'},orderBy:{number:'desc'}});
   const routine=(await post('/planning/generate').expect(200)).body;
   if(routine.plan.state==='proposed')await post(`/planning/versions/${routine.plan.id}/accept`).set('If-Match',`"${routine.version}"`).expect(200);
   expect((await db.planVersion.findUniqueOrThrow({where:{id:pending.id}})).state).toBe('proposed');
   expect(await db.timeSlot.count({where:{userId:ownerId,taskId:last.id,date:new Date('2026-11-15'),archivedAt:null}})).toBeGreaterThan(0);
   const reasons=(await get(`/tasks/${last.id}/planning`).expect(200)).body.items as {versionId:string;date:string;explanation:string}[];
   expect(reasons).toContainEqual(expect.objectContaining({versionId:first.plan.id,date:'2026-11-15',explanation:first.plan.result.items.find((item:{taskId:string})=>item.taskId===last.id).explanation}));
   expect(reasons.every(item=>item.versionId===first.plan.id)).toBe(true);
  } finally {
   await db.user.update({where:{id:ownerId},data:{settings:settings as object}});await cleanupFixture(value);
   await db.timeSlot.updateMany({where:{userId:ownerId,id:{notIn:oldSlots.map(slot=>slot.id)},archivedAt:null},data:{archivedAt:new Date()}});
   await db.timeSlot.updateMany({where:{id:{in:oldSlots.map(slot=>slot.id)}},data:{archivedAt:null}});
  }
 });
 it('uses Sunday boundaries for selected, previous and closing weeks',async()=>{
  const settings=(await db.user.findUniqueOrThrow({where:{id:ownerId}})).settings,previousClock=clock.now;
  try {
   await db.user.update({where:{id:ownerId},data:{settings:{...defaultSettings,weekStart:7}}});
   const previous=(await get('/reviews/weekly').expect(200)).body as WeeklyReviewReport;
   expect(previous).toMatchObject({weekStart:'2026-10-25',weekEnd:'2026-10-31',currentWeekStart:'2026-11-01',targetWeekStart:'2026-11-01',complete:true});
   const current=(await get('/reviews/weekly?weekStart=2026-11-01').expect(200)).body as WeeklyReviewReport;
   expect(current).toMatchObject({weekStart:'2026-11-01',weekEnd:'2026-11-07',targetWeekStart:'2026-11-08',targetWeekEnd:'2026-11-14',complete:false});
   await get('/reviews/weekly?weekStart=2026-11-02').expect(400);
   clock.now=()=> '2026-11-07T21:01:00+05:30';
   expect((await get('/reviews/weekly').expect(200)).body.weekStart).toBe('2026-11-01');
   clock.now=()=> '2026-11-08T05:00:00+05:30';
   expect((await get('/reviews/weekly').expect(200)).body).toMatchObject({weekStart:'2026-11-01',targetWeekStart:'2026-11-08',complete:true});
  } finally {clock.now=previousClock;await db.user.update({where:{id:ownerId},data:{settings:settings as object}});}
 });
 it('reports historical daily and weekly quotas in their own units and records unknown work provisionally',async()=>{
  const skill=(await post('/skills',{profileId,name:'Historical quotas',availableDays:[1,2,3,4,5,6,7]}).expect(201)).body;
  const daily=(await post('/goals',{skillId:skill.id,type:'daily',title:'Read two pages',unit:'pages',targetQty:2,startDate:'2026-10-26',availableDays:[1,2,3,4,5,6,7]}).expect(201)).body;
  const weekly=(await post('/goals',{skillId:skill.id,type:'weekly',title:'Three labs per week',unit:'labs',targetQty:3,startDate:'2026-10-26',availableDays:[1,2,3,4,5,6,7]}).expect(201)).body;
  try {
   const first=(await post('/tasks',{goalId:daily.id,title:'Historical pages',estMinutes:60,qty:3,earliestDate:'2026-10-26'}).expect(201)).body;
   await post(`/tasks/${first.id}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-10-26T10:00:00+05:30',minutes:30,qty:3}).expect(200);
   await post(`/tasks/${first.id}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-10-27T10:00:00+05:30',minutes:10,qty:1}).expect(200);
   const lab=(await post('/tasks',{goalId:weekly.id,title:'Historical labs',estMinutes:60,qty:3,earliestDate:'2026-10-26'}).expect(201)).body;
   await post(`/tasks/${lab.id}/events`,{clientEventId:uuid(),kind:'completed',occurredAt:'2026-11-01T10:00:00+05:30',minutes:60,qty:3}).expect(200);
   await patch(`/goals/${daily.id}`,{targetQty:100,effectiveFrom:'2026-11-06'}).expect(200);
   await patch(`/goals/${weekly.id}`,{targetQty:99,effectiveFrom:'2026-11-06'}).expect(200);
   const unknown=(await post('/tasks',{goalId:daily.id,title:'Unreported historical reading',estMinutes:30,qty:2,earliestDate:'2026-10-28'}).expect(201)).body;
   await db.dailyReview.upsert({where:{userId_date:{userId:ownerId,date:new Date('2026-10-28')}},create:{id:uuid(),userId:ownerId,date:new Date('2026-10-28'),state:'unverified',summary:{unreportedTaskIds:[unknown.id]}},update:{state:'unverified',summary:{unreportedTaskIds:[unknown.id]}}});
   await post('/timetable/slots',{date:'2026-10-26',startMin:600,endMin:660,layer:'flexible',title:'Historical planned reading',taskId:first.id,goalId:daily.id,skillId:skill.id}).expect(201);
   const report=(await get('/reviews/weekly?weekStart=2026-10-26').expect(200)).body as WeeklyReviewReport;
   expect(report.quotas.filter(row=>row.goalId===daily.id)).toHaveLength(7);
   expect(report.quotas).toContainEqual(expect.objectContaining({goalId:daily.id,unit:'pages',periodStart:'2026-10-26',targetQty:2,creditedQty:3,shortfallQty:0,status:'met'}));
   expect(report.quotas).toContainEqual(expect.objectContaining({goalId:daily.id,unit:'pages',periodStart:'2026-10-27',targetQty:2,creditedQty:1,shortfallQty:1,status:'shortfall'}));
   expect(report.quotas).toContainEqual(expect.objectContaining({goalId:daily.id,periodStart:'2026-10-28',status:'provisional'}));
   expect(report.quotas.filter(row=>row.goalId===weekly.id)).toEqual([expect.objectContaining({unit:'labs',periodStart:'2026-10-26',periodEnd:'2026-11-01',targetQty:3,creditedQty:3,status:'met'})]);
   expect(report.skills.find(row=>row.id===skill.id)).toMatchObject({plannedMinutes:60,actualMinutes:100});
   expect(report.profiles.find(row=>row.id===profileId)!.plannedMinutes).toBeGreaterThanOrEqual(60);
   const current=(await get('/reviews/weekly?weekStart=2026-11-02').expect(200)).body as WeeklyReviewReport;
   expect(current.quotas).toContainEqual(expect.objectContaining({goalId:daily.id,periodStart:'2026-11-06',targetQty:100,status:'in_progress'}));
  } finally {await cleanupFixture({goalId:daily.id,skillId:skill.id});await db.goal.update({where:{id:weekly.id},data:{archivedAt:new Date(),status:'archived'}});}
 });
 it('derives week-to-week streak changes from the latest immutable correction for each closed period',async()=>{
  const definition=await db.streakDef.create({data:{id:uuid(),userId:ownerId,title:'Stored weekly delta',scope:'global',startDate:new Date('2026-10-25')}});
  const rule=await db.streakRuleVersion.create({data:{id:uuid(),userId:ownerId,streakId:definition.id,version:1,effectiveFrom:new Date('2026-10-25'),rules:{period:'day',measure:'minutes',threshold:1}}});
  const record=async(date:string,result:string,correctsRecordId?:string)=>db.streakRecord.create({data:{id:uuid(),userId:ownerId,streakId:definition.id,ruleVersionId:rule.id,periodStart:new Date(date),periodEnd:new Date(date),result,value:result==='met'?1:0,reason:'Immutable test reason',sourceHash:uuid(),correctsRecordId,beforeReason:correctsRecordId?'Immutable test reason':null}});
  await record('2026-10-25','met');await record('2026-10-26','met');const missed=await record('2026-10-27','missed');await record('2026-10-27','met',missed.id);
  const report=(await get('/reviews/weekly?weekStart=2026-10-26').expect(200)).body as WeeklyReviewReport;
  expect(report.streaks.find(row=>row.id===definition.id)).toMatchObject({beforeCurrent:1,afterCurrent:3,delta:2,best:3,met:2,missed:0});
  await db.streakDef.update({where:{id:definition.id},data:{status:'archived'}});
 });
 it('keeps later-date work provisional but resolves a closed period after original-date reconciliation',async()=>{
  const skill=(await post('/skills',{profileId,name:'Weekly reconciliation',availableDays:[1,2,3,4,5,6,7]}).expect(201)).body;
  const goal=(await post('/goals',{skillId:skill.id,type:'daily',title:'Ten pages each day',unit:'pages',targetQty:10,startDate:'2026-10-26',availableDays:[1,2,3,4,5,6,7]}).expect(201)).body;
  try {
   const task=(await post('/tasks',{goalId:goal.id,title:'Unreported original date',estMinutes:120,qty:10,earliestDate:'2026-10-29'}).expect(201)).body;
   const review=await db.dailyReview.create({data:{id:uuid(),userId:ownerId,date:new Date('2026-10-29'),state:'closed',closedAt:new Date('2026-10-29T21:00:00+05:30'),summary:{unreported:1,unreportedTaskIds:[task.id]}}});
   await db.task.update({where:{id:task.id},data:{unverified:true}});
   const outcome=async()=>((await get('/reviews/weekly?weekStart=2026-10-26').expect(200)).body as WeeklyReviewReport).quotas.find(row=>row.goalId===goal.id&&row.periodStart==='2026-10-29');
   expect(await outcome()).toMatchObject({status:'provisional',creditedQty:0});
   await post(`/tasks/${task.id}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-11-06T10:00:00+05:30',minutes:10,qty:1}).expect(200);
   expect((await db.task.findUniqueOrThrow({where:{id:task.id}})).unverified).toBe(false);
   expect(await outcome()).toMatchObject({status:'provisional',creditedQty:0});
   await post(`/tasks/${task.id}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-10-29T10:00:00+05:30',minutes:20,qty:2}).expect(200);
   expect(await outcome()).toMatchObject({status:'shortfall',creditedQty:2,shortfallQty:8});
   expect((await db.dailyReview.findUniqueOrThrow({where:{id:review.id}})).summary).toMatchObject({unreported:1,unreportedTaskIds:[task.id]});
  } finally {await cleanupFixture({goalId:goal.id,skillId:skill.id});}
 });
 it('includes deferred backlog and calibrated future deadline shortfalls before a task is overdue',async()=>{
  const settings=(await db.user.findUniqueOrThrow({where:{id:ownerId}})).settings;
  const skill=(await post('/skills',{profileId,name:'Future deadline risk',availableDays:[1,2,3,4,5,6,7]}).expect(201)).body;
  const goal=(await post('/goals',{skillId:skill.id,type:'milestone',title:'Future capacity shortfall',unit:'minutes',targetQty:120,startDate:'2026-11-06',dueDate:'2026-11-07',availableDays:[1,2,3,4,5,6,7]}).expect(201)).body;
  try {
   const deferred=(await post('/tasks',{goalId:goal.id,title:'Deferred before a deadline',estMinutes:60,earliestDate:'2026-11-06',dueDate:'2026-11-07'}).expect(201)).body;
   await post(`/tasks/${deferred.id}/events`,{clientEventId:uuid(),kind:'deferred',occurredAt:clock.now(),toDate:'2026-11-09'}).expect(200);
   await db.user.update({where:{id:ownerId},data:{settings:{...defaultSettings,restDays:[1,2,3,4,5,6,7]}}});
   const report=(await get('/reviews/weekly?weekStart=2026-11-02').expect(200)).body as WeeklyReviewReport;
   expect(report.backlog.tasks).toContainEqual(expect.objectContaining({id:deferred.id,status:'deferred',remainingMinutes:60}));
   expect(report.deadlines.find(row=>row.goalId===goal.id)).toMatchObject({dueDate:'2026-11-07',feasible:false,availableMinutes:0});
   expect(report.deadlines.find(row=>row.goalId===goal.id)!.shortfallMin).toBeGreaterThan(0);
  } finally {await db.user.update({where:{id:ownerId},data:{settings:settings as object}});await cleanupFixture({goalId:goal.id,skillId:skill.id});}
 });
 it('prepares at week end and catches up the same upcoming-week job once after a worker restart',async()=>{
  const {reconcilePlanningJobs,PLANNING_QUEUE}=await import('../../apps/worker/src/planning');
  const settings=(await db.user.findUniqueOrThrow({where:{id:ownerId}})).settings,previousClock=clock.now;
  let boss=new PgBoss(process.env.DATABASE_URL!);
  try {
   await db.user.update({where:{id:ownerId},data:{createdAt:new Date('2026-11-02T00:00:00Z'),settings:{...defaultSettings,weekStart:1,dailyReviewMin:1260}}});
   await boss.start();await boss.createQueue(PLANNING_QUEUE,{name:PLANNING_QUEUE,policy:'stately'});
   clock.now=()=> '2026-11-08T20:59:00+05:30';await reconcilePlanningJobs(boss,new Date(clock.now()));
   const period=`${ownerId}:weekly:2026-11-09`;
   expect((await db.$queryRaw<{count:bigint}[]>`SELECT count(*) AS count FROM pgboss.job WHERE name=${PLANNING_QUEUE} AND data->>'periodKey'=${period}`)[0]!.count).toBe(0n);
   clock.now=()=> '2026-11-08T21:01:00+05:30';await reconcilePlanningJobs(boss,new Date(clock.now()));
   await boss.stop();boss=new PgBoss(process.env.DATABASE_URL!);await boss.start();
   clock.now=()=> '2026-11-09T07:01:00+05:30';await reconcilePlanningJobs(boss,new Date(clock.now()));
   const queued=await db.$queryRaw<{data:{weekly:{reviewedWeek:string;targetWeek:string}}}[]>`SELECT data FROM pgboss.job WHERE name=${PLANNING_QUEUE} AND data->>'periodKey'=${period}`;
   expect(queued).toHaveLength(1);expect(queued[0]!.data.weekly).toEqual({reviewedWeek:'2026-11-02',targetWeek:'2026-11-09'});
  } finally {clock.now=previousClock;await boss.stop();await db.user.update({where:{id:ownerId},data:{settings:settings as object}});}
 });
});

async function fixture(unit='minutes',targetQty=120,startDate='2026-11-06') {
 const skill=(await post('/skills',{profileId,name:`Adapter ${unit}`,availableDays:[1,2,3,4,5,6,7]}).expect(201)).body;
 const goal=(await post('/goals',{skillId:skill.id,type:'milestone',title:`Adapter ${unit}`,unit,targetQty,startDate,dueDate:'2026-12-01',availableDays:[1,2,3,4,5,6,7]}).expect(201)).body;
 for(const task of await db.task.findMany({where:{goalId:goal.id,status:'pending'}}))await post(`/tasks/${task.id}/events`,{clientEventId:uuid(),kind:'cancelled',occurredAt:clock.now(),note:'Disposable adapter fixture replaces automatic scope with explicit tasks.'}).expect(200);
 return {goalId:String(goal.id),skillId:String(skill.id)};
}
async function cleanupFixture(value:{goalId:string;skillId:string}) {
 await db.timeSlot.updateMany({where:{userId:ownerId,OR:[{goalId:value.goalId},{skillId:value.skillId}]},data:{archivedAt:new Date()}});
 await db.goal.update({where:{id:value.goalId},data:{archivedAt:new Date(),status:'archived'}});
 await db.skill.update({where:{id:value.skillId},data:{archivedAt:new Date()}});
}
describe('planning snapshot adapters',()=>{
 it('keeps partially reported past work provisional by date after later progress clears the current flag',async()=>{
  const value=await fixture('minutes',60,'2026-11-01');
  try {
   const task=(await post('/tasks',{goalId:value.goalId,title:'Partially reported past work',estMinutes:60,earliestDate:'2026-11-03'}).expect(201)).body;
   await post(`/tasks/${task.id}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-11-03T10:00:00+05:30',minutes:15}).expect(200);
   const {reconcileMissedReviews}=await import('../../apps/api/src/modules/planning/service');
   await reconcileMissedReviews(ownerId);
   expect(await db.task.findUniqueOrThrow({where:{id:task.id}})).toMatchObject({status:'partial',actualMinutes:15,remainingMinutes:45,unverified:true,eventVersion:1});
   const review=await db.dailyReview.findUniqueOrThrow({where:{userId_date:{userId:ownerId,date:new Date('2026-11-03')}}});
   expect(review).toMatchObject({state:'unverified',summary:{unreported:1,unreportedTaskIds:[task.id]}});
   await reconcileMissedReviews(ownerId);
   expect((await db.dailyReview.findUniqueOrThrow({where:{id:review.id}})).revision).toBe(review.revision);
   await post(`/tasks/${task.id}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-11-06T10:00:00+05:30',minutes:10}).expect(200);
   expect(await db.task.findUniqueOrThrow({where:{id:task.id}})).toMatchObject({actualMinutes:25,remainingMinutes:35,unverified:false});
   await reconcileMissedReviews(ownerId);
   expect((await db.dailyReview.findUniqueOrThrow({where:{id:review.id}})).summary).toMatchObject({unreportedTaskIds:[task.id]});
   expect(await db.task.findUniqueOrThrow({where:{id:task.id}})).toMatchObject({actualMinutes:25,remainingMinutes:35,unverified:false,eventVersion:2});
  } finally {await cleanupFixture(value);}
 });
 it('does not treat a later completion as evidence that an earlier unclosed date was complete',async()=>{
  const value=await fixture('minutes',60,'2026-11-01');
  try {
   const task=(await post('/tasks',{goalId:value.goalId,title:'Completed on a later date',estMinutes:60,earliestDate:'2026-11-04'}).expect(201)).body;
   await post(`/tasks/${task.id}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-11-04T10:00:00+05:30',minutes:15}).expect(200);
   await post(`/tasks/${task.id}/events`,{clientEventId:uuid(),kind:'completed',occurredAt:'2026-11-05T10:00:00+05:30',minutes:60}).expect(200);
   const {reconcileMissedReviews}=await import('../../apps/api/src/modules/planning/service');await reconcileMissedReviews(ownerId);
   expect(await db.dailyReview.findUniqueOrThrow({where:{userId_date:{userId:ownerId,date:new Date('2026-11-04')}}})).toMatchObject({state:'unverified',summary:{unreportedTaskIds:expect.arrayContaining([task.id])}});
   expect(await db.task.findUniqueOrThrow({where:{id:task.id}})).toMatchObject({status:'completed',actualMinutes:60,remainingMinutes:0,unverified:false,eventVersion:2});
  } finally {await cleanupFixture(value);}
 });
 it('regenerates authoritative approval after a source change even when the algorithm input is unchanged',async()=>{
  const value=await fixture();
  try {
   const task=(await post('/tasks',{goalId:value.goalId,title:'Source-only change',estMinutes:30,earliestDate:'2026-11-06'}).expect(201)).body;
   const first=(await post('/planning/generate').expect(200)).body;
   await post(`/tasks/${task.id}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:clock.now(),minutes:0,note:'A note changes recorded source without changing remaining work.'}).expect(200);
   await post(`/planning/versions/${first.plan.id}/accept`).set('If-Match',`"${first.version}"`).expect(409);
   const fresh=(await post('/planning/generate').expect(200)).body;
   expect(fresh.reused).toBe(false);expect(fresh.plan.id).not.toBe(first.plan.id);
   expect(fresh.plan.inputsHash).toBe(first.plan.inputsHash);expect(fresh.plan.sourceHash).not.toBe(first.plan.sourceHash);
   await post(`/planning/versions/${fresh.plan.id}/accept`).set('If-Match',`"${fresh.version}"`).expect(200);
  } finally {await cleanupFixture(value);}
 });
 it('reuses the current active version once its placement input stabilises after acceptance',async()=>{
  const value=await fixture();
  try {
   await post('/tasks',{goalId:value.goalId,title:'Stable active placement',estMinutes:30,supportsSplit:false,earliestDate:'2026-11-12'}).expect(201);
   const first=(await post('/planning/generate').expect(200)).body;
   await post(`/planning/versions/${first.plan.id}/accept`).set('If-Match',`"${first.version}"`).expect(200);
   const stable=(await post('/planning/generate').expect(200)).body;
   if(stable.plan.state==='proposed')await post(`/planning/versions/${stable.plan.id}/accept`).set('If-Match',`"${stable.version}"`).expect(200);
   const again=(await post('/planning/generate').expect(200)).body;
   expect(again.reused).toBe(true);expect(again.plan.id).toBe(stable.plan.id);expect(again.plan.state).toBe('active');
  } finally {await cleanupFixture(value);}
 });
 it('uses surviving completion instants and archived observations for calibration and recency',async()=>{
  const value=await fixture();
  try {
   const ids:string[]=[];
   for(let index=0;index<5;index++) {
    const task=(await post('/tasks',{goalId:value.goalId,title:`Calibration ${index}`,estMinutes:60,earliestDate:'2026-11-01'}).expect(201)).body;
    ids.push(task.id);
    await post(`/tasks/${task.id}/events`,{clientEventId:uuid(),kind:'completed',occurredAt:`2026-11-0${index+1}T10:00:00+05:30`,minutes:78}).expect(200);
   }
   await db.task.update({where:{id:ids[0]},data:{archivedAt:new Date()}});
   await patch(`/tasks/${ids[1]}`,{title:'Metadata edited after completion'}).expect(200);
   const input=(await post('/planning/generate').expect(200)).body.plan.input as PlanInput;
   const samples=input.history?.samples?.filter(sample=>sample.skillId===value.skillId)??[];
   expect(samples).toHaveLength(5);
   expect(samples.map(sample=>sample.completedAt).sort()).toEqual([1,2,3,4,5].map(day=>`2026-11-0${day}T04:30:00.000Z`));
   expect(input.history?.lastPractice?.[value.skillId]).toBe('2026-11-05');
   expect(samples.every(sample=>sample.actualMinutes===78&&sample.estMinutes===60)).toBe(true);
  } finally {await cleanupFixture(value);}
 });
 it('rejects acceptance after correction of a completed archived prerequisite',async()=>{
  const value=await fixture();
  try {
   const prerequisite=(await post('/tasks',{goalId:value.goalId,title:'Archived prerequisite',estMinutes:20,earliestDate:'2026-11-06'}).expect(201)).body;
   const completion=(await post(`/tasks/${prerequisite.id}/events`,{clientEventId:uuid(),kind:'completed',occurredAt:'2026-11-06T10:00:00+05:30',minutes:20}).expect(200)).body.event;
   await db.task.update({where:{id:prerequisite.id},data:{archivedAt:new Date()}});
   const dependent=(await post('/tasks',{goalId:value.goalId,title:'Dependent',estMinutes:30,earliestDate:'2026-11-06',dependsOn:[prerequisite.id]}).expect(201)).body;
   const proposal=(await post('/planning/generate').expect(200)).body;
   expect((proposal.plan.result as PlanResult).items.some(item=>item.taskId===dependent.id)).toBe(true);
   await post(`/tasks/${prerequisite.id}/events`,{clientEventId:uuid(),kind:'correction',occurredAt:clock.now(),referenceEventId:completion.id,explicitCorrection:true}).expect(200);
   const rejected=await post(`/planning/versions/${proposal.plan.id}/accept`).set('If-Match',`"${proposal.version}"`).expect(409);
   expect(rejected.body.error.code).toBe('STALE_PLAN');
  } finally {await cleanupFixture(value);}
 });
 it('fills a saved skill window first and keeps weekly targets soft',async()=>{
  const value=await fixture();
  try {
   await db.skill.update({where:{id:value.skillId},data:{windows:[{days:[5],startMin:1200,endMin:1260}],weeklyTargetMin:150}});
   const task=(await post('/tasks',{goalId:value.goalId,title:'Reserved session',estMinutes:60,supportsSplit:false,earliestDate:'2026-11-06'}).expect(201)).body;
   const proposal=(await post('/planning/generate').expect(200)).body.plan;
   expect((proposal.input as PlanInput).freeSlots['2026-11-06']).toContainEqual({date:'2026-11-06',startMin:1200,endMin:1260,skillId:value.skillId});
   expect((proposal.input as PlanInput).skills.find(skill=>skill.id===value.skillId)).toMatchObject({weeklyTargetMin:150});
   expect((proposal.result as PlanResult).items.filter(item=>item.taskId===task.id)).toEqual([expect.objectContaining({date:'2026-11-06',startMin:1200,endMin:1260})]);
  } finally {await cleanupFixture(value);}
 });
 it('subtracts fixed and frozen load from recovery capacity and warns when protected load already exceeds it',async()=>{
  const value=await fixture( 'minutes',200),settings=(await db.user.findUniqueOrThrow({where:{id:ownerId}})).settings;
  const previousSlots=await db.timeSlot.findMany({where:{userId:ownerId,archivedAt:null},select:{id:true}});
  try {
   await db.timeSlot.updateMany({where:{id:{in:previousSlots.map(slot=>slot.id)}},data:{archivedAt:new Date()}});
   await db.user.update({where:{id:ownerId},data:{settings:{...defaultSettings,wakingMin:1000,sleepingMin:1120,maxDailyMin:120,maxWeeklyMin:840,minFreeMin:0,minBreakMin:0,restDays:[]}}});
   const task=(await post('/tasks',{goalId:value.goalId,title:'Recovery workload',estMinutes:200,earliestDate:'2026-11-06'}).expect(201)).body;
   const fixed=(await post('/timetable/slots',{date:'2026-11-06',startMin:1000,endMin:1020,layer:'fixed',title:'Recovery fixed',skillId:value.skillId}).expect(201)).body;
   const frozen=(await post('/timetable/slots',{date:'2026-11-06',startMin:1020,endMin:1040,layer:'flexible',title:'Recovery manual session',taskId:task.id,goalId:value.goalId,skillId:value.skillId}).expect(201)).body;
   const proposal=(await post('/planning/generate',{recovery:true}).expect(200)).body.plan,result=proposal.result as PlanResult,input=proposal.input as PlanInput;
   expect(result.items.filter(item=>item.date==='2026-11-06').reduce((sum,item)=>sum+item.minutes,20)).toBeLessThanOrEqual(60);
   expect(input.freeSlots['2026-11-06']?.reduce((sum,slot)=>sum+slot.endMin-slot.startMin,0)).toBe(20);
   expect(input.freeSlots['2026-11-11']?.reduce((sum,slot)=>sum+slot.endMin-slot.startMin,0)).toBe(120);
   expect(result.items).toContainEqual(expect.objectContaining({taskId:task.id,startMin:1020,endMin:1040,minutes:20}));
   await db.timeSlot.update({where:{id:frozen.id},data:{startMin:1080,endMin:1100}});
   await db.timeSlot.update({where:{id:fixed.id},data:{endMin:1080}});
   const overloaded=(await post('/planning/generate',{recovery:true}).expect(200)).body.plan.result as PlanResult;
   expect(overloaded.items.filter(item=>item.goalId===value.goalId&&item.date==='2026-11-06')).toEqual([expect.objectContaining({startMin:1080,endMin:1100})]);
   expect(overloaded.warnings).toContainEqual(expect.objectContaining({code:'RECOVERY_EXISTING_OVERLOAD',shortfallMin:40}));
  } finally {await db.user.update({where:{id:ownerId},data:{settings:settings as object}});await cleanupFixture(value);await db.timeSlot.updateMany({where:{id:{in:previousSlots.map(slot=>slot.id)}},data:{archivedAt:null}});}
 });
 it('counts a paused goal’s manual commitment as existing workload without allocating its task work',async()=>{
  const value=await fixture();
  try {
   const task=(await post('/tasks',{goalId:value.goalId,title:'Paused manual commitment',estMinutes:50,earliestDate:'2026-11-06'}).expect(201)).body;
   await post('/timetable/slots',{date:'2026-11-06',startMin:1200,endMin:1250,layer:'flexible',title:'Paused manual slot',taskId:task.id,goalId:value.goalId,skillId:value.skillId}).expect(201);
   await db.goal.update({where:{id:value.goalId},data:{status:'paused'}});
   const proposal=(await post('/planning/generate').expect(200)).body.plan,input=proposal.input as PlanInput,result=proposal.result as PlanResult;
   expect(input.frozen?.some(item=>item.taskId===task.id)).toBe(false);
   expect(input.existingWork).toContainEqual({date:'2026-11-06',minutes:50,goalId:value.goalId,skillId:value.skillId});
   expect(result.items.some(item=>item.taskId===task.id)).toBe(false);
  } finally {await cleanupFixture(value);}
 });
 it('excludes labelled demo work and calibration from planning while respecting its visible occupied windows',async()=>{
  const value=await fixture();
  try {
   const task=(await post('/tasks',{goalId:value.goalId,title:'Demo workload',estMinutes:60,earliestDate:'2026-11-06'}).expect(201)).body;
   await post(`/tasks/${task.id}/events`,{clientEventId:uuid(),kind:'completed',occurredAt:'2026-11-06T10:00:00+05:30',minutes:60}).expect(200);
   await db.task.updateMany({where:{goalId:value.goalId},data:{isDemo:true}});
   await db.goal.update({where:{id:value.goalId},data:{isDemo:true}});
   await db.skill.update({where:{id:value.skillId},data:{isDemo:true}});
   await db.timeSlot.create({data:{id:uuid(),userId:ownerId,date:new Date('2026-11-06'),startMin:1300,endMin:1360,layer:'reserved',title:'Demo reserved window',skillId:value.skillId,isDemo:true}});
   const proposal=(await post('/planning/generate').expect(200)).body.plan,input=proposal.input as PlanInput,result=proposal.result as PlanResult;
   expect(input.tasks.some(task=>task.goalId===value.goalId)).toBe(false);
   expect(input.goals.some(goal=>goal.id===value.goalId)).toBe(false);
   expect(input.history?.samples?.some(sample=>sample.skillId===value.skillId)).toBe(false);
   expect(input.freeSlots['2026-11-06']?.some(slot=>slot.startMin<1360&&slot.endMin>1300)).toBe(false);
   expect(result.items.some(item=>item.goalId===value.goalId)).toBe(false);
  } finally {await cleanupFixture(value);}
 });
 it('extends matching inherited task deadlines while retaining started and manually edited deadlines',async()=>{
  const value=await fixture();
  try {
   const ids:string[]=[];
   for(const title of ['Inherited','Started','Edited'])ids.push((await post('/tasks',{goalId:value.goalId,title,estMinutes:20,earliestDate:'2026-11-06',dueDate:'2026-12-01'}).expect(201)).body.id);
   await post(`/tasks/${ids[1]}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-11-06T10:00:00+05:30',minutes:5}).expect(200);
   await patch(`/tasks/${ids[2]}`,{title:'Manually edited'}).expect(200);
   await post('/planning/breaks',{from:'2026-11-24',to:'2026-11-25',reason:'Inherited deadline fixture',choices:[{goalId:value.goalId,action:'extend'}]}).expect(200);
   expect((await db.task.findUniqueOrThrow({where:{id:ids[0]}})).dueDate?.toISOString().slice(0,10)).toBe('2026-12-03');
   for(const id of ids.slice(1))expect((await db.task.findUniqueOrThrow({where:{id}})).dueDate?.toISOString().slice(0,10)).toBe('2026-12-01');
  } finally {await cleanupFixture(value);}
 });
 it('reduces pending finite quantity and minutes with cancellation facts while keeping partial progress intact',async()=>{
  const value=await fixture('videos',10);
  try {
   const completed=(await post('/tasks',{goalId:value.goalId,title:'Recorded videos',qty:2,estMinutes:30,earliestDate:'2026-11-06'}).expect(201)).body;
   await post(`/tasks/${completed.id}/events`,{clientEventId:uuid(),kind:'completed',occurredAt:'2026-11-06T09:00:00+05:30',minutes:40,qty:2}).expect(200);
   const partial=(await post('/tasks',{goalId:value.goalId,title:'Started videos',qty:2,estMinutes:30,earliestDate:'2026-11-06'}).expect(201)).body;
   await post(`/tasks/${partial.id}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-11-06T10:00:00+05:30',minutes:5,qty:1}).expect(200);
   const pending=(await post('/tasks',{goalId:value.goalId,title:'Pending videos',qty:4,estMinutes:60,sortOrder:1,earliestDate:'2026-11-06'}).expect(201)).body;
   const surplus=(await post('/tasks',{goalId:value.goalId,title:'Surplus videos',qty:4,estMinutes:60,sortOrder:2,earliestDate:'2026-11-06'}).expect(201)).body;
   await post('/planning/breaks',{from:'2026-11-20',to:'2026-11-21',reason:'Reduced scope fixture',choices:[{goalId:value.goalId,action:'reduce',targetQty:6}]}).expect(200);
   expect(await db.task.findUniqueOrThrow({where:{id:pending.id}})).toMatchObject({qty:2,estMinutes:30,remainingMinutes:30,manualOverride:true});
   expect(await db.task.findUniqueOrThrow({where:{id:partial.id}})).toMatchObject({qty:2,estMinutes:30,remainingMinutes:15,actualMinutes:5,completedQty:1,eventVersion:1});
   expect(await db.task.findUniqueOrThrow({where:{id:surplus.id}})).toMatchObject({status:'cancelled',eventVersion:1});
   expect(await db.progressEvent.count({where:{taskId:surplus.id,kind:'cancelled'}})).toBe(1);
   expect(await db.task.findUniqueOrThrow({where:{id:completed.id}})).toMatchObject({actualMinutes:40,completedQty:2,status:'completed'});
  } finally {await cleanupFixture(value);}
 });
 it('rolls back a scope choice that cannot cover protected work',async()=>{
  const value=await fixture('minutes',100);
  try {
   const task=(await post('/tasks',{goalId:value.goalId,title:'Protected manual scope',estMinutes:60,earliestDate:'2026-11-06'}).expect(201)).body;
   await patch(`/tasks/${task.id}`,{title:'Edited scope'}).expect(200);
   const before=await db.goal.findUniqueOrThrow({where:{id:value.goalId}}),count=await db.progressEvent.count({where:{userId:ownerId}});
   await post('/planning/breaks',{from:'2026-11-26',to:'2026-11-27',reason:'Rejected scope fixture',choices:[{goalId:value.goalId,action:'reduce',targetQty:30}]}).expect(400);
   expect(await db.goal.findUniqueOrThrow({where:{id:value.goalId}})).toMatchObject({targetQty:100,ruleVersion:before.ruleVersion});
   expect(await db.progressEvent.count({where:{userId:ownerId}})).toBe(count);
   expect(await db.planningBreak.count({where:{userId:ownerId,fromDate:new Date('2026-11-26')}})).toBe(0);
  } finally {await cleanupFixture(value);}
 });
 it('protects pending prerequisites of started work when reducing finite scope',async()=>{
  const value=await fixture('videos',8);
  try {
   const prerequisite=(await post('/tasks',{goalId:value.goalId,title:'Required prerequisite',qty:2,estMinutes:20,earliestDate:'2026-11-06'}).expect(201)).body;
   const dependent=(await post('/tasks',{goalId:value.goalId,title:'Started dependent',qty:4,estMinutes:40,earliestDate:'2026-11-06',dependsOn:[prerequisite.id]}).expect(201)).body;
   await post(`/tasks/${dependent.id}/events`,{clientEventId:uuid(),kind:'progress',occurredAt:'2026-11-06T10:00:00+05:30',minutes:10,qty:1}).expect(200);
   const rejected=await post('/planning/breaks',{from:'2026-11-28',to:'2026-11-29',reason:'Protected dependency fixture',choices:[{goalId:value.goalId,action:'reduce',targetQty:4}]}).expect(400);
   expect(rejected.body.error.code).toBe('BREAK_SCOPE');
   expect(await db.task.findUniqueOrThrow({where:{id:prerequisite.id}})).toMatchObject({status:'pending',qty:2,estMinutes:20,eventVersion:0});
   expect(await db.task.findUniqueOrThrow({where:{id:dependent.id}})).toMatchObject({status:'partial',completedQty:1,remainingMinutes:30,eventVersion:1});
  } finally {await cleanupFixture(value);}
 });
 it('restores only owned history as a revalidated proposal and compares its diff with the active version',async()=>{
  const value=await fixture('minutes',60),settings=(await db.user.findUniqueOrThrow({where:{id:ownerId}})).settings;
  try {
   const task=(await post('/tasks',{goalId:value.goalId,title:'Historical placement',estMinutes:60,supportsSplit:false,earliestDate:'2026-11-12'}).expect(201)).body;
   const generated=(await post('/planning/generate').expect(200)).body;
   await post(`/planning/versions/${generated.plan.id}/accept`).set('If-Match',`"${generated.version}"`).expect(200);
   const current=(await get('/planning').expect(200)).body,number=(await db.planVersion.aggregate({where:{userId:ownerId},_max:{number:true}}))._max.number!+1;
   const item={taskId:task.id,goalId:value.goalId,skillId:value.skillId,date:'2026-11-12',startMin:1200,endMin:1260,minutes:60,workMinutes:60,score:0,explanation:'Historical placement fixture'};
   const historical=await db.planVersion.create({data:{id:uuid(),userId:ownerId,planId:generated.plan.planId,number,state:'superseded',fromDate:new Date('2026-11-06'),toDate:new Date('2026-11-19'),algoVersion:'greedy-v1',inputsHash:'historical-fixture',sourceHash:'historical-fixture',config:{},input:{},result:{items:[item],unplaced:[],warnings:[],changes:{changes:[],requiresApproval:false,frozenChangeCount:0},algoVersion:'greedy-v1'},reason:'Historical fixture'}});
   await db.user.update({where:{id:ownerId},data:{settings:{...settings as object,planningMode:'adaptive'}}});
   const before=await db.timeSlot.findMany({where:{userId:ownerId,archivedAt:null,taskId:task.id},orderBy:{startMin:'asc'}});
   const restored=(await post('/planning/generate',{restoreVersionId:historical.id}).expect(200)).body.plan;
   expect(restored.state).toBe('proposed');
   expect((restored.input as PlanInput).preferred).toEqual([item]);
   expect((restored.result as PlanResult).items).toContainEqual(item);
   expect((restored.result as PlanResult).changes.changes).toContainEqual(expect.objectContaining({taskId:task.id,kind:'moved',before:expect.arrayContaining([expect.objectContaining({taskId:task.id})]),after:[item]}));
   expect((await get('/planning')).body.activeVersionId).toBe(current.activeVersionId);
   expect(await db.timeSlot.findMany({where:{userId:ownerId,archivedAt:null,taskId:task.id},orderBy:{startMin:'asc'}})).toEqual(before);
   const foreign=await db.planVersion.findFirstOrThrow({where:{userId:foreignId}});
   await post('/planning/generate',{restoreVersionId:foreign.id}).expect(404);
   const obsolete=await db.planVersion.create({data:{id:uuid(),userId:ownerId,planId:generated.plan.planId,number:number+2,state:'superseded',fromDate:new Date('2026-11-06'),toDate:new Date('2026-11-19'),algoVersion:'greedy-v1',inputsHash:'obsolete-fixture',sourceHash:'obsolete-fixture',config:{},input:{},result:{items:[{...item,date:'2026-11-08'}],unplaced:[],warnings:[],changes:{changes:[],requiresApproval:false,frozenChangeCount:0},algoVersion:'greedy-v1'},reason:'Obsolete history fixture'}});
   const revalidated=(await post('/planning/generate',{restoreVersionId:obsolete.id}).expect(200)).body.plan.result as PlanResult;
   expect(revalidated.items.filter(item=>item.taskId===task.id).every(item=>item.date>='2026-11-12')).toBe(true);
  } finally {await db.user.update({where:{id:ownerId},data:{settings:settings as object}});await cleanupFixture(value);}
 });
});
