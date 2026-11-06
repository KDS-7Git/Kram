import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { addDays } from '@kram/time';
import { plan, type PlanInput } from './src/index';

// Synthetic workstation observation, not a timing assertion or Pi acceptance.
const today='2026-11-09';
const input:PlanInput={today,horizonDays:14,mode:'directed',
  tasks:Array.from({length:500},(_,index)=>({id:`t${String(index).padStart(3,'0')}`,goalId:`g${index%30}`,kind:'reading',estMinutes:45,remainingMinutes:45,status:'pending',supportsSplit:true})),
  goals:Array.from({length:30},(_,index)=>({id:`g${index}`,skillId:`s${index%6}`,dueDate:addDays(today,13)})),
  skills:Array.from({length:6},(_,index)=>({id:`s${index}`})),
  freeSlots:Object.fromEntries(Array.from({length:14},(_,index)=>[addDays(today,index),[{date:addDays(today,index),startMin:480,endMin:960}]])),
  config:{maxDailyMin:360,maxWeeklyMin:1800},
};
for(const observations of [0,100])for(const usePriority of [false,true]){
  const history=observations?{samples:Array.from({length:observations},(_,index)=>({skillId:`s${index%6}`,kind:'reading',estMinutes:45,actualMinutes:58.5,completedAt:`${addDays(today,index-observations)}T00:00:00Z`}))}:undefined;
  const start=performance.now(),result=plan({...input,history,config:{...input.config,usePriority}});
  console.log(JSON.stringify({machine:os.cpus()[0]?.model,arch:os.arch(),node:process.version,tasks:500,goals:30,skills:6,horizonDays:14,observations,usePriority,elapsedMs:Math.round(performance.now()-start),placements:result.items.length,unplaced:result.unplaced.length}));
}
