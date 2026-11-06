import {Router} from 'express';
import {z} from 'zod';
import {dateSchema,idSchema} from '@kram/shared';
import {iso,notFound} from '../../repository';
import {db} from '../../db';
import {expectedSlotVersion} from '../timetable/service';
import {planningStatus,generatePlan,decidePlan,dayReview,previewReview,closeReview,declareBreak} from './service';
import {weeklyReview} from './weekly';
export const planningRouter=Router();
const owner=(res:{locals:Record<string,unknown>})=>String(res.locals.userId);
planningRouter.get('/planning',async(_req,res)=>{const status=await planningStatus(owner(res));res.setHeader('ETag',`"${status.version}"`);res.json(iso(status));});
planningRouter.post('/planning/generate',async(req,res)=>res.json(iso(await generatePlan(owner(res),req.body))));
for(const action of ['accept','discard'] as const)planningRouter.post(`/planning/versions/:id/${action}`,async(req,res)=>res.json(iso(await decidePlan(owner(res),idSchema.parse(req.params.id),expectedSlotVersion(req.get('If-Match')),action==='accept'))));
planningRouter.get('/reviews/weekly',async(req,res)=>res.json(iso(await weeklyReview(owner(res),req.query.weekStart?dateSchema.parse(req.query.weekStart):undefined))));
planningRouter.get('/reviews/:date',async(req,res)=>{const review=await dayReview(owner(res),dateSchema.parse(req.params.date));res.setHeader('ETag',`"${review.revision}"`);res.json(iso(review));});
planningRouter.post('/reviews/preview',async(req,res)=>res.json(iso(await previewReview(owner(res),req.body))));
planningRouter.post('/reviews/close',async(req,res)=>{const {token,...input}=z.object({token:z.string().length(64)}).passthrough().parse(req.body);res.json(iso(await closeReview(owner(res),input,token,expectedSlotVersion(req.get('If-Match')))));});
planningRouter.post('/planning/breaks',async(req,res)=>res.json(iso(await declareBreak(owner(res),req.body))));

planningRouter.get('/tasks/:id/planning',async(req,res)=>{
  const userId=owner(res),taskId=idSchema.parse(req.params.id);
  const items=await db.$transaction(async tx=>{
    notFound(await tx.task.findFirst({where:{id:taskId,userId}}),'task');
    const live=await tx.timeSlot.findMany({where:{userId,taskId,archivedAt:null}});
    const appliedId=(key:string|null)=>{const parsed=idSchema.safeParse(key?.startsWith('plan:')?key.split(':')[1]:undefined);return parsed.success?parsed.data:undefined;};
    const applied=[...new Set(live.flatMap(slot=>appliedId(slot.applicationKey)?[appliedId(slot.applicationKey)!]:[]))];
    const candidates=await tx.planItem.findMany({where:{userId,taskId,OR:[{version:{state:'active'}},{versionId:{in:applied},version:{state:'superseded'}}]},include:{version:{select:{state:true}}},orderBy:[{date:'asc'},{startMin:'asc'}]});
    const chosen=new Map<string,typeof candidates[number]>();
    for(const item of candidates.sort((a,b)=>Number(b.version.state==='active')-Number(a.version.state==='active'))) {
      const key=`${item.date.toISOString().slice(0,10)}:${item.startMin}:${item.endMin}`;
      if(!chosen.has(key)&&live.some(slot=>slot.date.getTime()===item.date.getTime()&&slot.startMin===item.startMin&&slot.endMin===item.endMin&&(item.version.state==='active'||appliedId(slot.applicationKey)===item.versionId)))chosen.set(key,item);
    }
    return [...chosen.values()].sort((a,b)=>a.date.getTime()-b.date.getTime()||a.startMin-b.startMin).map(({version:_version,...item})=>item);
  },{isolationLevel:'RepeatableRead'});
  res.json(iso({items:items.map(item=>({...item,date:item.date.toISOString().slice(0,10)}))}));
});
