import type PgBoss from 'pg-boss';
import {DateTime} from 'luxon';
import {addDays,instantMillis,studyDate,weekStartDate} from '@kram/time';
import {settingsSchema} from '@kram/shared';
import {db} from '../../api/src/db';
import {generatePlan,reconcileMissedReviews} from '../../api/src/modules/planning/service';
import {runDurableJob} from './domain-jobs';
import {weeklyReviewDue,type WeeklyRequest} from '../../api/src/modules/planning/weekly';
export const PLANNING_QUEUE='generate-plan';
export async function registerPlanningJobs(boss:PgBoss) {
  await boss.createQueue(PLANNING_QUEUE,{name:PLANNING_QUEUE,policy:'stately',retryLimit:3,retryDelay:30,retryBackoff:true,expireInSeconds:600});
  await boss.work<{userId:string;periodKey:string;reason:string;weekly?:WeeklyRequest}>(PLANNING_QUEUE,async jobs=>{
    for(const job of jobs)await runDurableJob(PLANNING_QUEUE,job.data.periodKey,job.data.userId,()=>generatePlan(job.data.userId,{reason:job.data.reason,weekly:job.data.weekly}));
  });
}
export async function reconcilePlanningJobs(boss:PgBoss,now=new Date()) {
  const owner=await db.user.findFirst({where:{isOwner:true}});if(!owner)return;
  const settings=settingsSchema.parse(owner.settings),today=studyDate(now.getTime(),settings.timezone,settings.dayRollover);
  await runDurableJob('finalize-missed-review',`${owner.id}:${today}`,owner.id,()=>reconcileMissedReviews(owner.id,now.toISOString()));
  const [latestGoal,latestPlan]=await Promise.all([db.goal.findFirst({where:{userId:owner.id},orderBy:{updatedAt:'desc'},select:{updatedAt:true}}),db.planVersion.findFirst({where:{userId:owner.id},orderBy:{createdAt:'desc'},select:{createdAt:true}})]);
  if(latestPlan&&latestGoal&&latestGoal.updatedAt>latestPlan.createdAt) {
    const periodKey=`${owner.id}:change:${latestGoal.updatedAt.toISOString()}`;
    await boss.send(PLANNING_QUEUE,{userId:owner.id,periodKey,reason:'Goal edited'},{singletonKey:periodKey});
  }
  const local=DateTime.fromJSDate(now).setZone(settings.timezone),minute=local.hour*60+local.minute;
  if(minute>=settings.planReadyMin) {
    const periodKey=`${owner.id}:daily:${today}`;
    if(!await db.jobRun.findUnique({where:{jobName_periodKey:{jobName:PLANNING_QUEUE,periodKey}}}))
      await boss.send(PLANNING_QUEUE,{userId:owner.id,periodKey,reason:'Daily plan'},{singletonKey:periodKey});
  }
  const currentWeek=weekStartDate(today,settings.weekStart);
  const reviewedWeek=now.getTime()>=instantMillis(weeklyReviewDue(currentWeek,settings))?currentWeek:addDays(currentWeek,-7);
  const due=instantMillis(weeklyReviewDue(reviewedWeek,settings)),targetWeek=addDays(reviewedWeek,7);
  // Prepare at week end, or catch up the latest completed week after a restart.
  // Do not invent a review for a week that ended before the owner existed.
  if(now.getTime()>=due&&owner.createdAt.getTime()<=due) {
    const periodKey=`${owner.id}:weekly:${targetWeek}`;
    if(!await db.jobRun.findUnique({where:{jobName_periodKey:{jobName:PLANNING_QUEUE,periodKey}}}))
      await boss.send(PLANNING_QUEUE,{userId:owner.id,periodKey,reason:`Weekly review · ${reviewedWeek}`,weekly:{reviewedWeek,targetWeek}},{singletonKey:periodKey});
  }
}
