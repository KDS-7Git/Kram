import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dateSchema, idSchema, slotSchema, windowSchema, resolveTaskEvents, foldTaskEvents, type Settings } from '@kram/shared';
import { addDays, daysBetween, instantMillis, localToInstant, studyDate, weekday } from '@kram/time';
import { calibration, defaultConfig, feasibility, plan as schedule, type PlanInput, type PlanItem, type PlanResult } from '@kram/scheduler';
import { freeSlots, type Layer } from '@kram/timetable';
import { db } from '../../db';
import { ApiError } from '../../errors';
import { calendarDate, calendarString, clock } from '../../calendar';
import { json, lockOwner, newId, notFound, type Transaction } from '../../repository';
import { getSettings } from '../hierarchy/service';
import { tasks, taskDto, eventDto, materializeTasks } from '../tasks/service';
import { goals } from '../goals/service';
import { materializeOccurrences } from '../recurrence/service';
import { assertNoConflict, associations } from '../timetable/service';
import { refreshReminders } from '../notifications/service';
import { weeklyIdentity, weeklyMetadata, weeklyRequestSchema, weeklyReview, type WeeklyRequest } from './weekly';

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const closed = new Set(['completed','cancelled','skipped']);
const managed = (key: string|null) => key?.startsWith('plan:') ?? false;
export const generateSchema = z.object({ reason: z.string().trim().min(1).max(200).default('Manual replan'), recovery: z.boolean().default(false), restoreVersionId: idSchema.optional(), weekly: weeklyRequestSchema.optional() }).refine(value=>!value.weekly||!value.restoreVersionId,'Review a weekly allocation or restore a version separately.');
interface PlanningWindow { through?: string; preserveCurrentWeek?: boolean }

/** Authoritative source snapshot is distinct from algorithm input, and checked again at acceptance. */
async function snapshot(userId: string, tx: Transaction, window: PlanningWindow = {}) {
  const settings = await getSettings(userId, tx);
  const today = studyDate(clock.now(), settings.timezone, settings.dayRollover), to = [addDays(today, settings.horizonDays-1),window.through??today].sort().at(-1)!;
  const weekFrom = addDays(today, -((weekday(today)-settings.weekStart+7)%7));
  const [listedTasks, goalRows, skillRows, slots, breaks, completed, events, currentPlan] = await Promise.all([
    tasks.list(userId, false, tx).then(rows=>rows.filter(row=>!row.isDemo&&!row.goal.isDemo)),
    tx.goal.findMany({where:{userId,isDemo:false,archivedAt:null,skill:{isDemo:false,archivedAt:null,profile:{isDemo:false,archivedAt:null}}},orderBy:{id:'asc'}}),
    tx.skill.findMany({where:{userId,isDemo:false,archivedAt:null,profile:{isDemo:false,archivedAt:null}},orderBy:{id:'asc'}}),
    tx.timeSlot.findMany({where:{userId,archivedAt:null,date:{gte:calendarDate(weekFrom),lte:calendarDate(to)}},orderBy:[{date:'asc'},{startMin:'asc'},{id:'asc'}]}),
    tx.planningBreak.findMany({where:{userId,toDate:{gte:calendarDate(today)}},orderBy:{id:'asc'}}),
    tx.task.findMany({where:{userId,isDemo:false,status:'completed',goal:{isDemo:false}},select:{id:true,goalId:true,actualMinutes:true,estMinutes:true,unverified:true,goal:{select:{skillId:true,type:true}},item:{select:{kind:true}}},orderBy:{id:'asc'}}),
    tx.progressEvent.findMany({where:{userId,taskId:{not:null},task:{isDemo:false,goal:{isDemo:false}}},include:{goal:{select:{skillId:true}}},orderBy:[{taskId:'asc'},{sequence:'asc'},{id:'asc'}]}),
    tx.plan.findUnique({where:{userId},select:{activeVersionId:true}}),
  ]);
  const goalIds=new Set(goalRows.map(goal=>goal.id)),taskRows=listedTasks.filter(task=>goalIds.has(task.goalId));
  const sourceHash = hash({ today, to, settings, tasks:taskRows, goals:goalRows, skills:skillRows, slots, breaks, completed, events, activeVersionId:currentPlan?.activeVersionId??null });
  return {today,to,settings,taskRows,goalRows,skillRows,slots,breaks,completed,events,sourceHash};
}
function planningHistory(source:Awaited<ReturnType<typeof snapshot>>) {
  const {completed,events}=source,byTask=new Map<string,ReturnType<typeof eventDto>[]>(),eventSkill=new Map(events.map(event=>[event.id,event.goal.skillId]));
  for(const event of events) {const rows=byTask.get(event.taskId!)??[];rows.push(eventDto(event));byTask.set(event.taskId!,rows);}
  const activeEvents=new Map([...byTask].map(([id,rows])=>[id,resolveTaskEvents(rows).activeEvents]));
  const lastPractice:Record<string,string>={},lastPracticeAt=new Map<string,number>();
  for(const rows of activeEvents.values()) for(const event of rows) {
    if(!['progress','completed'].includes(event.kind)||event.minutes<=0&&event.qty<=0)continue;
    const at=instantMillis(event.occurredAt),skillId=eventSkill.get(event.id)!;
    if(at>(lastPracticeAt.get(skillId)??-Infinity)){lastPracticeAt.set(skillId,at);lastPractice[skillId]=event.localDate;}
  }
  const samples=completed.filter(t=>!t.unverified&&t.actualMinutes>0).flatMap(t=>{
    const completion=activeEvents.get(t.id)?.filter(event=>event.kind==='completed').at(-1);
    return completion?[{skillId:t.goal.skillId,kind:t.item?.kind??t.goal.type,actualMinutes:t.actualMinutes,estMinutes:t.estMinutes,completedAt:completion.occurredAt}]:[];
  });
  return {completedTaskIds:completed.map(t=>t.id),samples,lastPractice};
}
async function makeInput(userId: string, tx: Transaction, recovery: boolean, window: PlanningWindow = {}) {
  const source = await snapshot(userId,tx,window), {today,settings,taskRows,goalRows,skillRows,slots,breaks} = source;
  const horizonDays=daysBetween(today,source.to)+1;
  const history=planningHistory(source);
  const active = await tx.planVersion.findFirst({where:{userId,state:'active'}});
  const previous = active ? (active.result as unknown as PlanResult).items : [];
  const taskMap = new Map(taskRows.map(t=>[t.id,t]));
  const frozen: PlanItem[] = [];
  const protectedThrough=[window.preserveCurrentWeek?addDays(today,6-((weekday(today)-settings.weekStart+7)%7)):today,addDays(today,1)].sort().at(-1)!;
  const base = slots.filter(slot=> !managed(slot.applicationKey) || calendarString(slot.date)<=protectedThrough || slot.pinned);
  for (const slot of base) {
    const task = slot.taskId ? taskMap.get(slot.taskId) : undefined;
    if (!task || closed.has(task.status) || task.goal.status!=='active' || !slot.skillId || calendarString(slot.date)<today) continue;
    // Manual placements are hard commitments, including those beyond the freeze window.
    const prior = previous.find(p=>p.taskId===task.id&&p.date===calendarString(slot.date)&&p.startMin===slot.startMin&&p.endMin===slot.endMin);
    frozen.push({ taskId:task.id,goalId:task.goalId,skillId:slot.skillId,date:calendarString(slot.date),startMin:slot.startMin,endMin:slot.endMin,
      minutes:slot.endMin-slot.startMin,workMinutes:Math.min(task.remainingMinutes,prior?.workMinutes ?? (slot.endMin-slot.startMin)/calibration(history.samples,slot.skillId,task.item?.kind??task.goal.type)),score:prior?.score??0,
      explanation:prior?.explanation??'Kept: an existing time commitment.',pinned:true });
  }
  // A partial completion can leave more frozen wall time than remaining work. Consume each task only once.
  const remaining = new Map(taskRows.map(t=>[t.id,t.remainingMinutes]));
  frozen.sort((a,b)=>a.date.localeCompare(b.date)||a.startMin-b.startMin);
  for (const p of frozen) {
    const left=remaining.get(p.taskId)??0;
    p.workMinutes=Math.max(0,Math.min(left,p.workMinutes??p.minutes)); remaining.set(p.taskId,left-p.workMinutes);
  }
  const free: PlanInput['freeSlots'] = {},recoveryWarnings:PlanResult['warnings']=[];
  for(let i=0;i<horizonDays;i++) {
    const date=addDays(today,i), broken=breaks.some(b=>calendarString(b.fromDate)<=date&&calendarString(b.toDate)>=date);
    const capacity = recovery ? Math.round(settings.maxDailyMin*([0.5,0.65,0.8][i]??1)) : settings.maxDailyMin;
    const busy=base;
    try {free[date]=freeSlots({date,wakingWindow:{startMin:settings.wakingMin,endMin:settings.sleepingMin},slots:busy.map(s=>({...s,date:calendarString(s.date),layer:s.layer==='reserved'&&!skillRows.some(skill=>skill.id===s.skillId)?'unavailable':s.layer as Layer})),
      reservedWindows:skillRows.flatMap(skill=>z.array(windowSchema).parse(skill.windows).map(window=>({...window,days:window.days.filter(day=>skill.availableDays.includes(day)),skillId:skill.id}))),
      maxDailyMin:1440,minFreeTime:settings.minFreeMin,minBreak:settings.minBreakMin,breakAfter:settings.breakAfterMin,restDay:broken||settings.restDays.includes(weekday(date))});}
    catch(error){throw new ApiError('PLAN_CONSTRAINT',error instanceof Error?error.message:'Resolve the time windows before planning.',409);}
    if(recovery && capacity<settings.maxDailyMin) {
      const committed=base.filter(s=>calendarString(s.date)===date&&!['unavailable','reserved'].includes(s.layer)).reduce((sum,s)=>sum+s.endMin-s.startMin,0);
      let budget=Math.max(0,capacity-committed);
      if(committed>capacity)recoveryWarnings.push({code:'RECOVERY_EXISTING_OVERLOAD',message:`${date} already has ${committed} min committed, above the ${capacity} min recovery limit. Review these protected commitments.`,shortfallMin:committed-capacity});
      free[date]=[...free[date]!].sort((a,b)=>Number(!!b.skillId)-Number(!!a.skillId)||a.startMin-b.startMin).flatMap(s=>{const n=Math.min(budget,s.endMin-s.startMin);budget-=n;return n>0?[{...s,endMin:s.startMin+n}]:[];}).sort((a,b)=>a.startMin-b.startMin);
    }
  }
  const dependencies=taskRows.flatMap(t=>t.dependencies.map(d=>({taskId:t.id,dependsOnTaskId:d.dependsOnTaskId})));
  const input:PlanInput = {today,horizonDays,mode:settings.planningMode,freeSlots:free,
    tasks:taskRows.map(t=>({id:t.id,goalId:t.goalId,skillId:t.goal.skillId,title:t.title,kind:t.item?.kind??t.goal.type,estMinutes:t.estMinutes,remainingMinutes:t.remainingMinutes,status:t.status,
      earliestDate:calendarString(t.deferredToDate&&t.deferredToDate>t.earliestDate?t.deferredToDate:t.earliestDate),dueDate:t.dueDate?calendarString(t.dueDate):null,supportsSplit:t.supportsSplit,order:t.sortOrder})),
    goals:goalRows.map(g=>({id:g.id,skillId:g.skillId,status:g.status,priority:g.priority,usePriority:g.usePriority as 'inherit'|'on'|'off',dueDate:g.dueDate?calendarString(g.dueDate):null,availableDays:g.availableDays,order:g.sortOrder})),
    skills:skillRows.map(s=>({id:s.id,profileId:s.profileId,priority:s.priority,usePriority:s.usePriority as 'inherit'|'on'|'off',availableDays:s.availableDays,maxDailyMin:s.maxDailyMin,weeklyTargetMin:s.weeklyTargetMin,order:s.sortOrder})),
    dependencies,frozen,previous,existingWork:base.filter(s=>!['reserved','unavailable'].includes(s.layer)&&!frozen.some(p=>p.taskId===s.taskId&&p.date===calendarString(s.date)&&p.startMin===s.startMin&&p.endMin===s.endMin)).map(s=>({date:calendarString(s.date),minutes:s.endMin-s.startMin,skillId:skillRows.some(skill=>skill.id===s.skillId)?s.skillId??undefined:undefined,goalId:goalRows.some(goal=>goal.id===s.goalId)?s.goalId??undefined:undefined})),
    history,
    config:{...defaultConfig,maxDailyMin:settings.maxDailyMin,maxWeeklyMin:settings.maxWeeklyMin,minChunk:settings.minChunkMin,minBreak:settings.minBreakMin,breakAfter:settings.breakAfterMin,usePriority:settings.usePriority,weekStart:settings.weekStart,
      weights:{...defaultConfig.weights,...(settings.planningMode==='deadline'?{deadline:0.6}:settings.planningMode==='balanced'?{recency:0.25,allocation:0.3}:{})}}};
  return {...source,input,recoveryWarnings};
}
function scheduled(source:Awaited<ReturnType<typeof makeInput>>) {const result=schedule(source.input);result.warnings.push(...source.recoveryWarnings);return result;}
/** Read-only deadline estimates use the same reservations, caps and calibrated work as planning. */
export async function planningFeasibility(userId:string,tx:Transaction,through:string) {
  return feasibility((await makeInput(userId,tx,false,{through})).input);
}
export async function planningStatus(userId:string) {
  const [plan,versions,breaks]=await Promise.all([db.plan.findUnique({where:{userId}}),db.planVersion.findMany({where:{userId},orderBy:{number:'desc'},take:50}),db.planningBreak.findMany({where:{userId},orderBy:{fromDate:'desc'},take:50})]);
  return {version:plan?.version??0,activeVersionId:plan?.activeVersionId??null,versions:versions.map(v=>({...v,fromDate:calendarString(v.fromDate),toDate:calendarString(v.toDate),weeklyReview:weeklyMetadata(v.input),input:undefined})),breaks:breaks.map(b=>({...b,fromDate:calendarString(b.fromDate),toDate:calendarString(b.toDate)}))};
}
export async function generatePlan(userId:string,raw:unknown={}) {
  const request=generateSchema.parse(raw);
  await materializeOccurrences(userId); await materializeTasks(userId);
  return db.$transaction(async tx=>{
    await lockOwner(tx,userId);
    const settings=await getSettings(userId,tx),today=studyDate(clock.now(),settings.timezone,settings.dayRollover);
    const weekly=request.weekly?weeklyIdentity(settings,today,request.weekly):undefined;
    const source=await makeInput(userId,tx,request.recovery,weekly?{through:addDays(weekly.targetWeek,6),preserveCurrentWeek:true}:{});
    const reviewSummary=weekly?await weeklyReview(userId,weekly.reviewedWeek,tx,false):undefined;
    if(reviewSummary)source.sourceHash=hash({source:source.sourceHash,reviewSummary});
    let reason=request.reason;
    if(request.restoreVersionId) {
      const historical=notFound(await tx.planVersion.findFirst({where:{id:request.restoreVersionId,userId}}),'historical plan');
      source.input.preferred=(historical.result as unknown as PlanResult).items;
      reason=`Restore plan ${historical.number} · ${request.reason}`;
    }
    const storedInput={...source.input,...(weekly?{weeklyReview:{...weekly,summary:reviewSummary}}:{})};
    const inputsHash=hash(storedInput);
    const plan=await tx.plan.upsert({where:{userId},create:{id:newId(),userId},update:{}});
    // A proposal needs current authority as well as equal algorithm input. The
    // already active plan can be a no-op after activation changes source IDs.
    const reused=await tx.planVersion.findFirst({where:{userId,inputsHash,OR:[{state:'proposed',sourceHash:source.sourceHash},...(!weekly&&!request.restoreVersionId&&plan.activeVersionId?[{state:'active',id:plan.activeVersionId}]:[])]},orderBy:{number:'desc'}});
    if(reused) return {version:plan.version,plan:reused,reused:true};
    let result:PlanResult;
    try {result=scheduled(source);} catch(error) {throw new ApiError('PLAN_CONSTRAINT',error instanceof Error?error.message:'Resolve the current commitments before planning.',409);}
    if(request.restoreVersionId||weekly) result.changes.requiresApproval=true;
    const number=(await tx.planVersion.aggregate({where:{userId},_max:{number:true}}))._max.number??0;
    const version=await tx.planVersion.create({data:{id:newId(),userId,planId:plan.id,number:number+1,fromDate:calendarDate(source.today),toDate:calendarDate(source.to),algoVersion:result.algoVersion,inputsHash,sourceHash:source.sourceHash,
      config:json(source.input.config),input:json(storedInput),result:json(result),reason}});
    if(result.items.length) await tx.planItem.createMany({data:result.items.map(p=>({...p,id:newId(),userId,versionId:version.id,date:calendarDate(p.date),workMinutes:p.workMinutes??p.minutes,pinned:undefined}))});
    const updated=await tx.plan.update({where:{id:plan.id},data:{version:{increment:1}}});
    // Adaptive modes may only apply changes wholly outside today/tomorrow.
    if(!weekly&&!request.restoreVersionId&&source.settings.planningMode!=='directed'&&!result.changes.requiresApproval) {
      await activate(userId,version.id,tx,source.settings,source.today);
      return {version:updated.version,plan:{...version,state:'active'},reused:false};
    }
    return {version:updated.version,plan:version,reused:false};
  },{timeout:30000});
}
async function activate(userId:string,id:string,tx:Transaction,settings:Settings,today:string) {
  const version=notFound(await tx.planVersion.findFirst({where:{id,userId,state:'proposed'}}),'proposed plan');
  const result=version.result as unknown as PlanResult;
  const openTasks=await tx.task.findMany({where:{userId,archivedAt:null,status:{notIn:[...closed]}}});
  const ids=new Set(openTasks.map(t=>t.id));
  if(result.items.some(p=>!ids.has(p.taskId))) throw new ApiError('STALE_PLAN','Progress changed. Generate a fresh proposal before accepting.',409);
  const existing=await tx.timeSlot.findMany({where:{userId,archivedAt:null,date:{gte:calendarDate(today)}}});
  const retained=new Set(result.items.map(p=>`${p.taskId}:${p.date}:${p.startMin}:${p.endMin}`));
  await tx.timeSlot.updateMany({where:{userId,archivedAt:null,date:{gte:calendarDate(today),lte:version.toDate},id:{in:existing.filter(s=>managed(s.applicationKey)&&!s.pinned&&!retained.has(`${s.taskId}:${calendarString(s.date)}:${s.startMin}:${s.endMin}`)).map(s=>s.id)}},data:{archivedAt:new Date(clock.now()),version:{increment:1}}});
  for(let i=0;i<result.items.length;i++) {
    const p=result.items[i]!;
    if(existing.some(s=>s.taskId===p.taskId&&calendarString(s.date)===p.date&&s.startMin===p.startMin&&s.endMin===p.endMin)) continue;
    const task=openTasks.find(t=>t.id===p.taskId)!;
    const input=slotSchema.parse({date:p.date,startMin:p.startMin,endMin:p.endMin,layer:'flexible',title:task.title,taskId:p.taskId,goalId:p.goalId,skillId:p.skillId});
    const data=await associations(userId,input,tx);
    await assertNoConflict(userId,data,tx);
    await tx.timeSlot.create({data:{...data,id:newId(),userId,date:calendarDate(p.date),applicationKey:`plan:${id}:${i}`}});
  }
  const pending=await tx.planVersion.findMany({where:{userId,state:'proposed',id:{not:id}},select:{id:true,input:true}});
  // A routine adaptive plan cannot silently resolve a weekly decision.
  const superseded=pending.filter(row=>weeklyMetadata(version.input)||!weeklyMetadata(row.input)).map(row=>row.id);
  await tx.planVersion.updateMany({where:{userId,id:{not:id},OR:[{state:'active'},{id:{in:superseded}}]},data:{state:'superseded'}});
  await tx.planVersion.update({where:{id},data:{state:'active'}});
  await tx.plan.update({where:{userId},data:{activeVersionId:id}});
  await refreshReminders(userId,tx);
  void settings;
}
export async function decidePlan(userId:string,id:string,expected:number,accept:boolean) {
  return db.$transaction(async tx=>{
    await lockOwner(tx,userId);
    const row=notFound(await tx.planVersion.findFirst({where:{id,userId}}),'plan');
    const plan=notFound(await tx.plan.findUnique({where:{userId}}),'plan');
    if(plan.version!==expected) throw new ApiError('VERSION_CONFLICT','The plan changed. Reload before accepting.',412);
    if(row.state!=='proposed') throw new ApiError('PLAN_NOT_PROPOSED','This version is already resolved. Reload the plan.',409);
    const weekly=weeklyMetadata(row.input);
    const source=await snapshot(userId,tx,weekly?{through:addDays(weekly.targetWeek,6),preserveCurrentWeek:true}:{});
    if(accept&&weekly) {
      let summary;
      try {weeklyIdentity(source.settings,source.today,weekly as WeeklyRequest);summary=await weeklyReview(userId,weekly.reviewedWeek,tx,false);}
      catch {throw new ApiError('STALE_PLAN','The reviewed week or settings changed. Generate a fresh weekly proposal.',409);}
      source.sourceHash=hash({source:source.sourceHash,reviewSummary:summary});
    }
    if(accept&&source.sourceHash!==row.sourceHash) throw new ApiError('STALE_PLAN','Tasks, settings or time blocks changed. Generate a fresh proposal.',409);
    if(accept) await activate(userId,id,tx,source.settings,source.today);
    else await tx.planVersion.update({where:{id},data:{state:'discarded'}});
    const updated=await tx.plan.update({where:{userId},data:{version:{increment:1}}});
    return {version:updated.version,state:accept?'active':'discarded'};
  },{timeout:30000});
}

export const reviewDecisionSchema=z.object({taskId:idSchema,decision:z.enum(['unreported','completed','partial','skipped','deferred']),minutes:z.number().finite().min(0).max(1440).default(0),qty:z.number().finite().min(0).max(1000000).optional(),toDate:dateSchema.optional(),note:z.string().max(1000).default(''),clientEventId:idSchema});
export const reviewSchema=z.object({date:dateSchema,decisions:z.array(reviewDecisionSchema).max(200),recovery:z.boolean().default(false),note:z.string().max(1000).default('')}).refine(v=>new Set(v.decisions.map(d=>d.taskId)).size===v.decisions.length,'Choose each task once.');
export async function dayReview(userId:string,date:string) {
  dateSchema.parse(date);
  const settings=await getSettings(userId),today=studyDate(clock.now(),settings.timezone,settings.dayRollover);
  if(date>today||daysBetween(date,today)>366) throw new ApiError('REVIEW_DATE','Review today or a date within the last year.',400);
  return db.$transaction(async tx=>{
    await lockOwner(tx,userId);
    const review=await tx.dailyReview.upsert({where:{userId_date:{userId,date:calendarDate(date)}},create:{id:newId(),userId,date:calendarDate(date)},update:{}});
    const rows=await reviewTasks(userId,date,tx);
    return {...review,date,tasks:rows.map(t=>taskDto(t,clock.now(),today))};
  });
}
async function reviewTasks(userId:string,date:string,tx:Transaction) {
  const settings=await getSettings(userId,tx);
  const slots=await tx.timeSlot.findMany({where:{userId,archivedAt:null,date:{gte:calendarDate(date),lte:calendarDate(addDays(date,1))}}});
  const ids=slots.filter(s=>studyDate(localToInstant(calendarString(s.date),s.startMin,settings.timezone),settings.timezone,settings.dayRollover)===date).flatMap(s=>s.taskId?[s.taskId]:[]);
  const events=await tx.progressEvent.findMany({where:{userId,localDate:calendarDate(date)},select:{taskId:true}});
  const selected=new Set([...ids,...events.flatMap(e=>e.taskId?[e.taskId]:[])]);
  return (await tasks.list(userId,false,tx)).filter(t=>selected.has(t.id)||calendarString(t.earliestDate)===date);
}
async function reviewEvents(userId:string,input:z.infer<typeof reviewSchema>,tx:Transaction) {
  const eligible=new Set((await reviewTasks(userId,input.date,tx)).map(t=>t.id));
  const settings=await getSettings(userId,tx);
  const at=localToInstant(input.date,Math.max(settings.dayRollover,Math.min(settings.dailyReviewMin,1439)),settings.timezone);
  // Today's review cannot record events later than now; historical dates stay in their original bucket.
  const occurredAt=new Date(Math.min(new Date(at).getTime(),new Date(clock.now()).getTime())).toISOString();
  for(const d of input.decisions) {
    if(!eligible.has(d.taskId)) throw new ApiError('REVIEW_TASK','Choose tasks listed in this day’s review.',409);
    if(d.decision==='unreported') { await tx.task.updateMany({where:{id:d.taskId,userId,status:{notIn:[...closed]}},data:{unverified:true}}); continue; }
    const row=await tasks.get(userId,d.taskId,tx);
    if(closed.has(row.status)) continue;
    if(d.decision==='deferred'&&(!d.toDate||d.toDate<=input.date)) throw new ApiError('DEFER_DATE','Choose a later study date for deferred work.',400);
    await tasks.event(userId,d.taskId,{clientEventId:d.clientEventId,kind:d.decision==='partial'?'progress':d.decision,occurredAt,minutes:d.minutes,...(d.qty!==undefined?{qty:d.qty}:{}),note:d.note||'Daily review',toDate:d.toDate},tx);
  }
}
class PreviewRollback { constructor(public value:unknown) {} }
export async function previewReview(userId:string,raw:unknown) {
  const input=reviewSchema.parse(raw);
  await dayReview(userId,input.date);
  try {
    await db.$transaction(async tx=>{
      await lockOwner(tx,userId);
      const before=await snapshot(userId,tx);
      const review=notFound(await tx.dailyReview.findUnique({where:{userId_date:{userId,date:calendarDate(input.date)}}}),'review');
      if(review.state==='closed') throw new ApiError('REVIEW_CLOSED','This day is closed. Use a task history correction for late changes.',409);
      await reviewEvents(userId,input,tx);
      const source=await makeInput(userId,tx,input.recovery),result=scheduled(source);
      throw new PreviewRollback({token:hash({source:before.sourceHash,input,revision:review.revision}),revision:review.revision,result,titles:Object.fromEntries(source.taskRows.map(t=>[t.id,t.title]))});
    },{timeout:30000});
  } catch(error) {if(error instanceof PreviewRollback)return error.value;throw error;}
}
export async function closeReview(userId:string,raw:unknown,token:string,expected:number) {
  const input=reviewSchema.parse(raw),requestHash=hash(input);
  return db.$transaction(async tx=>{
    await lockOwner(tx,userId);
    const review=notFound(await tx.dailyReview.findUnique({where:{userId_date:{userId,date:calendarDate(input.date)}}}),'review');
    if(review.state==='closed') {
      if(review.requestHash!==requestHash) throw new ApiError('REVIEW_CLOSED','This day is already closed with different decisions. Correct the task history.',409);
      return {review,replayed:true};
    }
    if(review.revision!==expected) throw new ApiError('VERSION_CONFLICT','This review changed. Reload it.',412);
    const before=await snapshot(userId,tx);
    if(token!==hash({source:before.sourceHash,input,revision:review.revision})) throw new ApiError('STALE_REVIEW','Progress or planning changed. Preview tomorrow again before closing.',409);
    await reviewEvents(userId,input,tx);
    const source=await makeInput(userId,tx,input.recovery),result=scheduled(source);
    const plan=await tx.plan.upsert({where:{userId},create:{id:newId(),userId},update:{}});
    const number=(await tx.planVersion.aggregate({where:{userId},_max:{number:true}}))._max.number??0;
    const version=await tx.planVersion.create({data:{id:newId(),userId,planId:plan.id,number:number+1,fromDate:calendarDate(source.today),toDate:calendarDate(source.to),algoVersion:result.algoVersion,inputsHash:hash(source.input),sourceHash:source.sourceHash,config:json(source.input.config),input:json(source.input),result:json(result),reason:`Daily review · ${input.date}`}});
    if(result.items.length) await tx.planItem.createMany({data:result.items.map(p=>({...p,id:newId(),userId,versionId:version.id,date:calendarDate(p.date),workMinutes:p.workMinutes??p.minutes,pinned:undefined}))});
    await activate(userId,version.id,tx,source.settings,source.today);
    await tx.plan.update({where:{userId},data:{version:{increment:1}}});
    const summary={decisions:input.decisions,unreported:input.decisions.filter(d=>d.decision==='unreported').length,note:input.note,planVersionId:version.id};
    const saved=await tx.dailyReview.update({where:{id:review.id},data:{state:'closed',summary:json(summary),requestHash,closedAt:new Date(clock.now()),revision:{increment:1}}});
    return {review:{...saved,date:input.date},planVersionId:version.id,replayed:false};
  },{timeout:30000});
}
export const breakSchema=z.object({from:dateSchema,to:dateSchema,reason:z.string().trim().min(1).max(500),choices:z.array(z.object({goalId:idSchema,action:z.enum(['extend','keep','reduce']),targetQty:z.number().finite().positive().optional()})).max(500)}).refine(v=>daysBetween(v.from,v.to)>=0&&daysBetween(v.from,v.to)<=90,'Choose a break of at most 91 days.').refine(v=>new Set(v.choices.map(c=>c.goalId)).size===v.choices.length,'Choose each goal once.');
/** Finite scope reductions retain recorded and started work, then keep pending
 * prerequisites in saved order. Surplus decisions are append-only events. */
async function reduceFiniteScope(userId:string,goalId:string,targetQty:number,note:string,tx:Transaction) {
  const goal=notFound(await tx.goal.findFirst({where:{id:goalId,userId}}),'goal');
  if(!['milestone','adaptive'].includes(goal.type))return [];
  const rows=await tx.task.findMany({where:{userId,goalId},include:{dependencies:true},orderBy:[{sortOrder:'asc'},{earliestDate:'asc'},{id:'asc'}]});
  const open=rows.filter(row=>!row.archivedAt&&!closed.has(row.status)),minutesUnit=goal.unit.toLowerCase()==='minutes';
  const recorded=rows.reduce((sum,row)=>sum+(minutesUnit?row.actualMinutes:row.completedQty),0);
  const units=(row:typeof rows[number])=>minutesUnit?row.remainingMinutes:Math.max(0,row.qty-row.completedQty);
  const openById=new Map(open.map(row=>[row.id,row])),protectedIds=new Set(open.filter(row=>row.eventVersion>0||row.manualOverride||row.timerStartedAt).map(row=>row.id));
  const protectPrerequisites=(id:string)=>{for(const edge of openById.get(id)?.dependencies??[]){if(openById.has(edge.dependsOnTaskId)&&!protectedIds.has(edge.dependsOnTaskId)){protectedIds.add(edge.dependsOnTaskId);protectPrerequisites(edge.dependsOnTaskId);}}};
  for(const id of [...protectedIds])protectPrerequisites(id);
  const protectedRows=open.filter(row=>protectedIds.has(row.id));
  const protectedQty=recorded+protectedRows.reduce((sum,row)=>sum+units(row),0);
  if(targetQty+0.000001<protectedQty)throw new ApiError('BREAK_SCOPE',`The target must cover ${protectedQty} ${goal.unit} of recorded or protected work. Review started or manually edited tasks separately.`,400);
  let budget=Math.max(0,targetQty-protectedQty);
  const pending=open.filter(row=>!protectedRows.includes(row)),byId=new Map(pending.map(row=>[row.id,row])),ordered:typeof pending=[],visited=new Set<string>(),visiting=new Set<string>();
  const visit=(row:typeof pending[number])=>{
    if(visited.has(row.id))return;
    if(visiting.has(row.id))throw new ApiError('BREAK_SCOPE','Resolve the prerequisite cycle before reducing this scope.',409);
    visiting.add(row.id);for(const edge of row.dependencies){const prerequisite=byId.get(edge.dependsOnTaskId);if(prerequisite)visit(prerequisite);}
    visiting.delete(row.id);visited.add(row.id);ordered.push(row);
  };
  for(const row of pending)visit(row);
  const adjustments:Array<{taskId:string;action:'cancelled'|'reduced';beforeQty:number;afterQty:number;beforeMinutes:number;afterMinutes:number}>=[];
  for(const row of ordered) {
    const quantity=units(row),keep=Math.min(quantity,budget);
    if(keep+0.000001>=quantity){budget=Math.max(0,budget-quantity);continue;}
    if(keep<=0.000001) {
      await tasks.event(userId,row.id,{clientEventId:newId(),kind:'cancelled',occurredAt:clock.now(),note},tx);
      adjustments.push({taskId:row.id,action:'cancelled',beforeQty:quantity,afterQty:0,beforeMinutes:row.estMinutes,afterMinutes:0});
      continue;
    }
    if(!row.supportsSplit)throw new ApiError('BREAK_SCOPE','Choose a target that keeps complete non-splittable tasks, or edit those tasks separately.',400);
    const estimate=Math.max(1,Math.ceil(row.estMinutes*keep/quantity));
    await tasks.edit(userId,row.id,{estMinutes:estimate,...(!minutesUnit?{qty:keep}:{})},tx);
    adjustments.push({taskId:row.id,action:'reduced',beforeQty:quantity,afterQty:keep,beforeMinutes:row.estMinutes,afterMinutes:estimate});
    budget=0;
  }
  return adjustments;
}
export async function declareBreak(userId:string,raw:unknown) {
  const input=breakSchema.parse(raw);
  await db.$transaction(async tx=>{
    await lockOwner(tx,userId);
    const settings=await getSettings(userId,tx),today=studyDate(clock.now(),settings.timezone,settings.dayRollover);
    if(input.from<today)throw new ApiError('BREAK_DATE','Start a break today or later.',400);
    const affected=await tx.goal.findMany({where:{userId,isDemo:false,status:'active',archivedAt:null,skill:{isDemo:false,archivedAt:null,profile:{isDemo:false,archivedAt:null}},dueDate:{gte:calendarDate(input.from)}}});
    if(affected.some(g=>!input.choices.some(c=>c.goalId===g.id)))throw new ApiError('BREAK_CHOICES','Choose the effect on each affected deadline.',400);
    const overlap=await tx.planningBreak.findFirst({where:{userId,fromDate:{lte:calendarDate(input.to)},toDate:{gte:calendarDate(input.from)}}});
    if(overlap)throw new ApiError('BREAK_OVERLAP','This break overlaps another declared break.',409);
    const choices:Array<z.infer<typeof breakSchema>['choices'][number]&{adjustments?:Awaited<ReturnType<typeof reduceFiniteScope>>}>=[];
    for(const choice of input.choices) {
      const goal=notFound(await tx.goal.findFirst({where:{id:choice.goalId,userId,isDemo:false,status:'active',archivedAt:null,skill:{isDemo:false,archivedAt:null,profile:{isDemo:false,archivedAt:null}}}}),'goal');
      if(choice.action==='reduce'&&(!choice.targetQty||choice.targetQty>=goal.targetQty))throw new ApiError('BREAK_SCOPE','Enter a smaller positive target in the goal’s own unit.',400);
      if(choice.action==='keep'){choices.push(choice);continue;}
      const dueDate=goal.dueDate?addDays(calendarString(goal.dueDate),daysBetween(input.from,input.to)+1):null;
      if(choice.action==='extend'&&goal.dueDate)await tx.task.updateMany({where:{userId,goalId:goal.id,archivedAt:null,eventVersion:0,manualOverride:false,status:{in:['pending','unverified']},dueDate:goal.dueDate},data:{dueDate:calendarDate(dueDate!)}});
      await goals.edit(userId,goal.id,{...(choice.action==='extend'?{dueDate}:{targetQty:choice.targetQty}),effectiveFrom:input.from},tx,true);
      const adjustments=choice.action==='reduce'?await reduceFiniteScope(userId,goal.id,choice.targetQty!,`Scope reduced for break ${input.from} to ${input.to}: ${input.reason}`,tx):undefined;
      choices.push({...choice,...(adjustments?{adjustments}:{})});
    }
    await tx.planningBreak.create({data:{id:newId(),userId,fromDate:calendarDate(input.from),toDate:calendarDate(input.to),reason:input.reason,choices:json(choices)}});
  },{timeout:30000});
  // Breaks are explicit choices; timetable changes still follow plan approval policy.
  return generatePlan(userId,{reason:`Break · ${input.from} to ${input.to}`});
}
export async function reconcileMissedReviews(userId:string,now=clock.now()) {
  const settings=await getSettings(userId),today=studyDate(now,settings.timezone,settings.dayRollover);
  for(let i=14;i>=1;i--) {
    const date=addDays(today,-i);
    await db.$transaction(async tx=>{
      await lockOwner(tx,userId);
      const existing=await tx.dailyReview.findUnique({where:{userId_date:{userId,date:calendarDate(date)}}});
      if(existing?.state==='closed')return;
      const rows=await reviewTasks(userId,date,tx);
      const history=await tx.progressEvent.findMany({where:{userId,taskId:{in:rows.map(row=>row.id)}},orderBy:[{taskId:'asc'},{sequence:'asc'},{id:'asc'}]});
      const byTask=new Map<string,ReturnType<typeof eventDto>[]>();
      for(const event of history){const events=byTask.get(event.taskId!)??[];events.push(eventDto(event));byTask.set(event.taskId!,events);}
      const end=localToInstant(addDays(date,1),settings.dayRollover,settings.timezone);
      const unreported=rows.filter(row=>{
        // Resolve corrections from the complete history first. A later day's
        // completion cannot settle an earlier day's unreported remainder.
        const events=resolveTaskEvents(byTask.get(row.id)??[]).activeEvents.filter(event=>event.kind!=='correction'&&event.localDate<=date);
        const status=foldTaskEvents({id:row.id,goalId:row.goalId,estMinutes:row.estMinutes,qty:row.qty,quantityBased:row.goal.unit.toLowerCase()!=='minutes',earliestDate:calendarString(row.earliestDate),dueDate:row.dueDate?calendarString(row.dueDate):null},events,{now:end,today:date}).status;
        return !closed.has(status);
      });
      const oldSummary=existing?.summary;
      const oldIds=oldSummary&&typeof oldSummary==='object'&&!Array.isArray(oldSummary)&&Array.isArray(oldSummary.unreportedTaskIds)?oldSummary.unreportedTaskIds.filter((id):id is string=>typeof id==='string'):[];
      // Keep the historical scope until its review closes, even when a later
      // event clears the current task flag or completes the task.
      const unreportedTaskIds=[...new Set([...oldIds,...unreported.map(row=>row.id)])].sort();
      if(!unreportedTaskIds.length)return;
      if(existing?.state==='unverified'&&JSON.stringify([...oldIds].sort())===JSON.stringify(unreportedTaskIds))return;
      await tx.task.updateMany({where:{userId,id:{in:unreported.map(row=>row.id)},status:{notIn:[...closed]},unverified:false},data:{unverified:true}});
      const summary=json({unreported:unreportedTaskIds.length,unreportedTaskIds});
      await tx.dailyReview.upsert({where:{userId_date:{userId,date:calendarDate(date)}},create:{id:newId(),userId,date:calendarDate(date),state:'unverified',summary},update:{state:'unverified',revision:{increment:1},summary}});
    });
  }
}
