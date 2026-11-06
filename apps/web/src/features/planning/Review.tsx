import { clientId } from "../../shared/id";
import {useState} from 'react';
import {Link,useSearchParams,useNavigate} from 'react-router-dom';
import {useMutation,useQuery} from '@tanstack/react-query';
import type {Task} from '@kram/shared';
import type {PlanResult} from '@kram/scheduler';
import {addDays} from '@kram/time';
import type {WeeklyReviewReport} from '../../../../api/src/modules/planning/weekly';
import {Banner,Button,Card,DelayedSkeleton,Field,PageHeader} from '../../components/ui/kit';
import {api,errorMessage} from '../../shared/api';
import {useData,useOnline,useRefresh} from '../../shared/data';
import {calendarDate,duration,counted} from '../../shared/format';
import {PlanPreview} from './Planning';
type ReviewTask = Task & {goal?:{unit:string}};
interface Decision {taskId:string;decision:'unreported'|'completed'|'partial'|'skipped'|'deferred';minutes:number;qty?:number;toDate?:string;note:string;clientEventId:string}
interface ReviewResponse {date:string;state:string;revision:number;summary:{unreported?:number};tasks:ReviewTask[]}
interface Preview {token:string;revision:number;result:PlanResult;titles:Record<string,string>}
const labels=['Confirm what happened','Adjust actual time','See tomorrow','Close the day'];
export function Review() {
  const [params]=useSearchParams();
  return params.get('kind')==='weekly'?<WeeklyReview/>:<DailyReview/>;
}
function DailyReview() {
  const data=useData(),online=useOnline(),refresh=useRefresh(),[params]=useSearchParams();
  const [date,setDate]=useState(params.get('date')??data.studyDate),[step,setStep]=useState(0),[decisions,setDecisions]=useState<Decision[]>([]),[note,setNote]=useState(''),[recovery,setRecovery]=useState(false),[preview,setPreview]=useState<Preview|null>(null),[saved,setSaved]=useState(false);
  const query=useQuery({queryKey:['reviews',date],queryFn:()=>api<ReviewResponse>(`/reviews/${date}`)});
  const body={date,decisions,note,recovery};
  const prepare=()=>{
    const rows=query.data?.tasks??[];
    setDecisions(rows.map(t=>({taskId:t.id,decision:['completed','skipped','cancelled'].includes(t.status)?t.status==='completed'?'completed':'skipped':'unreported',minutes:t.actualMinutes,qty:t.goal?.unit?.toLowerCase()!=='minutes'?t.completedQty:undefined,note:'',clientEventId:clientId()})));
    setStep(1);
  };
  const adjust=(id:string,patch:Partial<Decision>)=>{setPreview(null);setDecisions(rows=>rows.map(d=>d.taskId===id?{...d,...patch}:d));};
  const build=useMutation({mutationFn:()=>api<Preview>('/reviews/preview',{method:'POST',body}),onSuccess:value=>{setPreview(value);setStep(2);}});
  const close=useMutation({mutationFn:()=>api('/reviews/close',{method:'POST',headers:{'If-Match':`"${preview?.revision}"`},body:{...body,token:preview?.token}}),onSuccess:async()=>{await refresh();await query.refetch();setSaved(true);}});
  const rows=query.data?.tasks??[],closed=query.data?.state==='closed'||saved;
  return <div className="stack-lg review-page"><PageHeader eyebrow="Daily review" title={closed?'Day closed':labels[step]!} description={calendarDate(date)} action={<Link className="button button-text" to="/planning">Back to Plan</Link>}/>
    <Field id="review-date" label="Review date"><input id="review-date" className="input" type="date" value={date} max={data.studyDate} disabled={step>0&&!closed} onChange={e=>{setDate(e.target.value);setStep(0);setDecisions([]);setPreview(null);setSaved(false);}}/></Field>
    {query.isPending?<DelayedSkeleton height={300}/>:query.isError?<Banner tone="error">{errorMessage(query.error)} <Button onClick={()=>void query.refetch()}>Retry review</Button></Banner>:closed?<Card><h2>A little clarity for tomorrow</h2><p>{counted(query.data?.summary.unreported??0, 'item')} {(query.data?.summary.unreported??0) === 1 ? 'was' : 'were'} left unreported at closure. Your recorded progress is preserved. Record late work against its original date from task history.</p>{rows.length>0&&<details><summary className="button button-text">Review task histories</summary><ul className="conflict-list">{rows.map(t=><li key={t.id}><Link className="button button-text" to={`/tasks/${t.id}`}>{t.title}</Link></li>)}</ul></details>}<div className="row wrap"><Link className="button button-primary" to="/plan">See your timetable</Link><Link className="button" to="/">Return to Today</Link></div></Card>:<>
      <ol className="review-steps" aria-label="Review steps">{labels.map((label,i)=><li key={label} aria-current={step===i?'step':undefined}><span>{i+1}</span><span>{label}</span></li>)}</ol>
      {query.data?.state==='unverified'&&<Banner>Some work was left unreported at rollover. Confirm what happened; it has not been counted as completed or missed.</Banner>}
      {step<2&&<Card><h2>{step===0?'What happened today?':'Actual time and remaining work'}</h2>{!rows.length&&<p className="muted">No work was assigned to this day. You can still close it and review the next plan.</p>}<div className="stack-lg">{rows.map(t=>{
        const d=decisions.find(x=>x.taskId===t.id),done=['completed','skipped','cancelled'].includes(t.status);
        return <div className="review-task" key={t.id}><Link to={`/tasks/${t.id}`}><strong>{t.title}</strong></Link><p className="caption">{t.status} · {duration(t.remainingMinutes)} remaining · {duration(t.actualMinutes)} logged</p>{step===1&&!done&&d&&<><Field id={`decision-${t.id}`} label="What happened?"><select id={`decision-${t.id}`} className="input" value={d.decision} onChange={e=>adjust(t.id,{decision:e.target.value as Decision['decision'],minutes:e.target.value==='partial'?0:t.actualMinutes,qty:e.target.value==='partial'?0:t.completedQty})}><option value="unreported">Leave unreported</option><option value="completed">Completed</option><option value="partial">Partly completed</option><option value="skipped">Chose to skip</option><option value="deferred">Defer to another day</option></select></Field>{['completed','partial'].includes(d.decision)&&<div className="grid-2"><Field id={`minutes-${t.id}`} label={d.decision==='completed'?'Total actual minutes':'Additional minutes'}><input id={`minutes-${t.id}`} className="input" type="number" min={d.decision==='completed'?t.actualMinutes:0} max={1440} step="any" value={d.minutes} onChange={e=>adjust(t.id,{minutes:Number(e.target.value)})}/></Field>{t.goal?.unit?.toLowerCase()!=='minutes'&&<Field id={`qty-${t.id}`} label={`${d.decision==='completed'?'Total':'Additional'} ${t.goal?.unit??'quantity'}`}><input id={`qty-${t.id}`} className="input" type="number" min={d.decision==='completed'?t.completedQty:0} step="any" value={d.qty??0} onChange={e=>adjust(t.id,{qty:Number(e.target.value)})}/></Field>}</div>}{d.decision==='deferred'&&<Field id={`defer-${t.id}`} label="Move to study date"><input id={`defer-${t.id}`} className="input" type="date" value={d.toDate??''} min={date} onChange={e=>adjust(t.id,{toDate:e.target.value})}/></Field>}</>}</div>;
      })}</div>{step===0?<Button variant="primary" onClick={prepare} disabled={!online}>Continue to actual time</Button>:<><Field id="review-note" label="Day note (optional)"><textarea id="review-note" className="input" value={note} maxLength={1000} onChange={e=>setNote(e.target.value)}/></Field><label className="toggle-label"><input type="checkbox" checked={recovery} onChange={e=>setRecovery(e.target.checked)}/>Ease back after a gap</label><div className="row wrap"><Button onClick={()=>setStep(0)}>Back</Button><Button variant="primary" disabled={!online} loading={build.isPending} onClick={()=>build.mutate()}>Preview tomorrow</Button></div></>}</Card>}
      {step>=2&&preview&&<Card><h2>{step===2?'Tomorrow, with reasons':'Ready to close the day'}</h2><p className="muted">Kept blocks are solid; new and moved blocks have dashed borders. Accepting records today’s decisions and applies this plan together.</p><PlanPreview result={preview.result} titles={preview.titles}/><div className="row wrap"><Button disabled={close.isPending} onClick={()=>setStep(1)}>Review decisions</Button>{step===2?<Button variant="primary" onClick={()=>setStep(3)}>Accept all and continue</Button>:<Button variant="primary" disabled={!online} loading={close.isPending} onClick={()=>close.mutate()}>Close day and apply plan</Button>}</div></Card>}
      {(build.isError||close.isError)&&<Banner tone="error">{errorMessage(build.error??close.error)} {close.isError&&<Button onClick={()=>build.mutate()} disabled={!online} loading={build.isPending}>Preview current changes again</Button>}</Banner>}
    </>}
  </div>;
}
function WeeklyReview() {
  const {user}=useData();
  const online=useOnline(),navigate=useNavigate(),[params]=useSearchParams();
  const [week,setWeek]=useState(params.get('weekStart')??'');
  const report=useQuery({queryKey:['reviews','weekly',week],queryFn:()=>api<WeeklyReviewReport>(`/reviews/weekly${week?`?weekStart=${week}`:''}`)});
  const value=report.data;
  const propose=useMutation({mutationFn:()=>{
    if(!value)throw new Error('Load the review before proposing an allocation.');
    return api('/planning/generate',{method:'POST',body:{reason:`Weekly review · ${value.weekStart}`,weekly:{reviewedWeek:value.weekStart,targetWeek:value.targetWeekStart}}});
  },onSuccess:()=>navigate('/planning')});
  const quantity=(amount:number)=>new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(amount);
  return <div className="stack-lg"><PageHeader eyebrow="Weekly review" title="Look at the week, then make room" description="Compare planned and recorded time by skill, review the backlog and choose the next allocation."/>
    <Field id="review-week" label="Review week starting"><input id="review-week" className="input" type="date" value={value?.weekStart??week} max={value?.currentWeekStart} onChange={e=>{setWeek(e.target.value);propose.reset();}}/></Field>
    {report.isPending?<DelayedSkeleton height={300}/>:report.isError?<Banner tone="error">{errorMessage(report.error)} <Button onClick={()=>void report.refetch()}>Retry weekly review</Button></Banner>:value&&<>
      <div className="row wrap"><Button onClick={()=>setWeek(addDays(value.weekStart,-7))}>Previous week</Button><Button disabled={value.weekStart>=value.currentWeekStart} onClick={()=>setWeek(addDays(value.weekStart,7))}>Next week</Button><span className="caption">{calendarDate(value.weekStart)}–{calendarDate(value.weekEnd)} · {value.complete?'Closed week':'Week in progress'}</span></div>
      {!value.complete&&<Banner>This week is still in progress. Open quotas and unreported work remain provisional.</Banner>}
      <Card><h2>Planned and recorded time</h2><p className="muted">Compare minutes within each area. Goal quantities remain in their own units below.</p>
        <div className="table-scroll"><table className="review-table"><caption>By profile</caption><thead><tr><th scope="col">Profile</th><th scope="col">Planned</th><th scope="col">Recorded</th></tr></thead><tbody>{value.profiles.map(p=><tr key={p.id}><th scope="row">{p.name}</th><td>{duration(p.plannedMinutes)}</td><td>{duration(p.actualMinutes)}</td></tr>)}</tbody></table></div>
        <div className="table-scroll"><table className="review-table"><caption>By skill</caption><thead><tr><th scope="col">Skill</th><th scope="col">Planned</th><th scope="col">Recorded</th></tr></thead><tbody>{value.skills.map(s=><tr key={s.id}><th scope="row">{s.name}</th><td>{duration(s.plannedMinutes)}</td><td>{duration(s.actualMinutes)}</td></tr>)}</tbody></table></div>
        <Link className="button button-text" to={`/progress?weekStart=${value.weekStart}`}>Open progress and calibration</Link>
      </Card>
      <Card><h2>Goal quota results</h2>{!value.quotas.length?<p className="muted">No goal periods fall in this review week.</p>:<div className="table-scroll"><table className="review-table"><caption className="sr-only">Goal results for each actual period and unit</caption><thead><tr><th scope="col">Goal and period</th><th scope="col">Recorded / target</th><th scope="col">Result</th></tr></thead><tbody>{value.quotas.map(q=><tr key={`${q.goalId}:${q.periodStart}:${q.periodEnd}`}><th scope="row"><Link to={`/goals/${q.goalId}`}>{q.title}</Link><p className="caption">{calendarDate(q.periodStart)}{q.periodEnd!==q.periodStart?`–${calendarDate(q.periodEnd)}`:''}</p></th><td>{quantity(q.creditedQty)} / {quantity(q.targetQty)} {q.unit}</td><td>{q.status==='met'?'Met':q.status==='in_progress'?'In progress':q.status==='provisional'?'Awaiting review':'Shortfall'}{q.shortfallQty>0&&<p className="caption">{q.status==='shortfall'?'Short by':'Remaining'} {quantity(q.shortfallQty)} {q.unit}</p>}</td></tr>)}</tbody></table></div>}</Card>
      <Card><h2>Streak changes</h2>{user.settings.quietMode?<p className="muted">Quiet mode hides streak counts. Stored date reasons remain available.</p>:!value.streaks.length?<p className="muted">No streaks were evaluated for this week.</p>:<ul className="conflict-list">{value.streaks.map(s=><li key={s.id}><strong>{s.title}</strong> · {s.beforeCurrent} → {s.afterCurrent} ({s.delta>0?'+':''}{s.delta})<p className="caption">{s.met} met · {s.missed} missed · best {s.best}{s.provisional?' · unreported periods await review':''}</p></li>)}</ul>}{user.settings.featurePreset === 'full' && <Link className="button button-text" to="/progress/streaks">Inspect stored date reasons</Link>}</Card>
      <Card><h2>Backlog</h2><p>{counted(value.backlog.tasks.length, 'task')} · {duration(value.backlog.remainingMinutes)} remaining</p><ul className="conflict-list">{value.backlog.tasks.map(t=><li key={t.id}><Link to={`/tasks/${t.id}`}>{t.title}</Link> · {duration(t.remainingMinutes)}{t.dueDate?` · due ${calendarDate(t.dueDate)}`:''}</li>)}</ul>
        <h3>Deadline risks</h3>{!value.deadlines.length?<p className="muted">No current deadline shortfalls were found.</p>:<ul className="conflict-list">{value.deadlines.map(d=><li key={d.goalId}><Link to={`/goals/${d.goalId}`}>{d.title}</Link> · due {calendarDate(d.dueDate)}<p>{d.message}</p></li>)}</ul>}</Card>
      <Card><h2>Next allocation</h2><p>{calendarDate(value.targetWeekStart)}–{calendarDate(value.targetWeekEnd)}. Inspect and accept the proposal before the timetable changes.</p>
        {value.proposal?.state==='proposed'&&<p className="caption">Saved proposal version {value.proposal.number} is ready to review.</p>}
        <div className="row wrap"><Button variant="primary" disabled={!online} loading={propose.isPending} onClick={()=>propose.mutate()}>Propose the next allocation</Button><Link className="button" to="/planning">Review plan proposals</Link></div>
        <p className="caption">To change the allocation, edit the relevant inputs and generate it again.</p><div className="row wrap"><Link className="button button-text" to="/goals">Edit goals and skill windows</Link><Link className="button button-text" to="/settings">Edit capacity</Link><Link className="button button-text" to={`/plan?date=${value.targetWeekStart}&view=week`}>Edit time blocks</Link></div>
        {propose.isError&&<Banner tone="error">{errorMessage(propose.error)}</Banner>}
      </Card>
    </>}<Link className="button button-text" to="/review">Daily review</Link></div>;
}
