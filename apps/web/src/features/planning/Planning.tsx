import {useState} from 'react';
import {Link} from 'react-router-dom';
import {useMutation,useQuery} from '@tanstack/react-query';
import {addDays} from '@kram/time';
import type {PlanResult} from '@kram/scheduler';
import {CalendarCheck,History,Pause,RefreshCw} from 'lucide-react';
import {Banner,Button,Card,DelayedSkeleton,EmptyState,Field,PageHeader,Sheet,StatusPill} from '../../components/ui/kit';
import {api,errorMessage} from '../../shared/api';
import {useData,useOnline,useRefresh} from '../../shared/data';
import {calendarDate,clockLabel,duration,counted} from '../../shared/format';
import {useUI} from '../../shared/ui';
export interface SavedPlan {id:string;number:number;state:string;reason:string;fromDate:string;toDate:string;createdAt:string;result:PlanResult;algoVersion:string}
export interface PlanningResponse {version:number;activeVersionId:string|null;versions:SavedPlan[];breaks:{id:string;fromDate:string;toDate:string;reason:string}[]}
export function PlanPreview({result,titles={}}:{result:PlanResult;titles?:Record<string,string>}) {
  const data=useData();
  const title=(id:string)=>titles[id]??data.tasks.find(t=>t.id===id)?.title??'Task';
  return <div className="stack-lg">
    {result.warnings.map((w,i)=><Banner tone="warning" key={i}>{w.shortfallMin!==undefined?`This plan is short by ${duration(w.shortfallMin)}. `:''}{w.message}</Banner>)}
    <p className="caption">{counted(result.items.length, 'time block')} · {counted(result.changes.changes.length, 'change')} · {counted(result.unplaced.length, 'task')} awaiting time</p>
    {result.items.length===0&&<p className="muted">No open work fits the available time. Add a task or review the capacity below.</p>}
    <ol className="plan-preview-list" aria-label="Proposed time blocks">{result.items.map((item,i)=>{
      const change=result.changes.changes.find(c=>c.taskId===item.taskId);
      return <li key={`${item.taskId}-${i}`} className={`plan-preview-item${change?' plan-preview-proposed':''}`}><div className="row between wrap"><Link to={`/tasks/${item.taskId}`}><strong>{title(item.taskId)}</strong></Link><span className="caption">{change?.kind==='moved'?'Moved':change?.kind==='added'?'New':'Kept'}</span></div><p>{calendarDate(item.date)} · {clockLabel(item.startMin,data.user.settings.clockFormat)}–{clockLabel(item.endMin,data.user.settings.clockFormat)}</p><details><summary>Why here?</summary><p className="muted">{item.explanation}</p>{change?.reason&&<p>{change.reason}</p>}</details></li>;
    })}</ol>
    {result.changes.changes.filter(c=>c.kind==='removed').map(c=><Banner key={c.taskId}>{title(c.taskId)} · removed from this version. {c.reason}</Banner>)}
    {!!result.unplaced.length&&<details><summary>Work awaiting time ({result.unplaced.length})</summary><ul className="conflict-list">{result.unplaced.map(t=><li key={t.taskId}><Link to={`/tasks/${t.taskId}`}>{title(t.taskId)}</Link> · {duration(t.remainingMinutes)} remaining. {t.reason}</li>)}</ul></details>}
  </div>;
}
export function Planning() {
  const online=useOnline(),refresh=useRefresh(),{toast}=useUI();
  const [selected,setSelected]=useState<string|null>(null),[breaking,setBreaking]=useState(false),[recovery,setRecovery]=useState(false);
  const query=useQuery({queryKey:['planning'],queryFn:()=>api<PlanningResponse>('/planning')});
  const generate=useMutation({mutationFn:()=>api<{plan:SavedPlan;reused:boolean}>('/planning/generate',{method:'POST',body:{recovery,reason:recovery?'Recovery after a gap':'Manual replan'}}),onSuccess:async value=>{await query.refetch();await refresh();setSelected(value.plan.id);toast(value.reused?'The same plan is already available.':'Plan ready to review.');}});
  const restore=useMutation({mutationFn:(id:string)=>api<{plan:SavedPlan}>('/planning/generate',{method:'POST',body:{restoreVersionId:id,reason:'Restore a previous allocation'}}),onSuccess:async value=>{await query.refetch();setSelected(value.plan.id);toast('Restoration ready to review against current constraints.');}});
  const decide=useMutation({mutationFn:({id,accept}:{id:string;accept:boolean})=>api(`/planning/versions/${id}/${accept?'accept':'discard'}`,{method:'POST',headers:{'If-Match':`"${query.data?.version}"`}}),onSuccess:async()=>{await query.refetch();await refresh();toast('Plan decision saved.');}});
  const versions=query.data?.versions??[],proposal=versions.find(v=>v.state==='proposed'),active=versions.find(v=>v.state==='active'),current=versions.find(v=>v.id===selected)??proposal??active;
  return <div className="stack-lg"><PageHeader eyebrow="Plan" title="Make room for what matters" description="Review changes and their reasons before they become your timetable." action={<Link className="button" to="/plan">Open timetable</Link>}/>
    <div className="row wrap"><Link className="button" to="/review"><CalendarCheck size={18}/>Daily review</Link><Link className="button" to="/review?kind=weekly">Weekly review</Link><Button onClick={()=>setBreaking(true)} disabled={!online}><Pause size={18}/>Declare a break</Button></div>
    <Card><div className="row between wrap"><div><h2>Plan the next horizon</h2><p className="muted">Today and tomorrow keep their commitments. Directed mode asks you to approve every change.</p></div><Button variant="primary" loading={generate.isPending} disabled={!online} onClick={()=>generate.mutate()}><RefreshCw size={18}/>Generate plan</Button></div><label className="toggle-label"><input type="checkbox" checked={recovery} onChange={e=>setRecovery(e.target.checked)}/>Ease back after a gap (50%, 65%, 80% capacity for the first three days)</label></Card>
    {query.isPending&&<DelayedSkeleton height={240}/>}{query.isError&&<Banner tone="error">{errorMessage(query.error)} <Button onClick={()=>void query.refetch()}>Retry plans</Button></Banner>}
    {restore.isError&&<Banner tone="error">{errorMessage(restore.error)}</Banner>}{generate.isError&&<Banner tone="error">{errorMessage(generate.error)}</Banner>}{decide.isError&&<Banner tone="error">{errorMessage(decide.error)} <Button onClick={()=>void query.refetch()}>Reload plans</Button></Banner>}
    {current?<Card><div className="row between wrap"><div><p className="eyebrow">Version {current.number} · {current.state}</p><h2>{current.reason}</h2><p className="caption">{calendarDate(current.fromDate)}–{calendarDate(current.toDate)}</p></div>{current.state==='proposed'&&<StatusPill status="pending" detail="Awaiting approval"/>}</div><PlanPreview result={current.result}/>{['superseded','discarded'].includes(current.state)&&<Button disabled={!online} loading={restore.isPending} onClick={()=>restore.mutate(current.id)}>Restore as a new proposal</Button>}{current.state==='proposed'&&<div className="row wrap plan-decision-actions"><Button variant="primary" disabled={!online} loading={decide.isPending} onClick={()=>decide.mutate({id:current.id,accept:true})}>Accept all changes</Button><Button disabled={!online||decide.isPending} onClick={()=>decide.mutate({id:current.id,accept:false})}>Discard proposal</Button></div>}</Card>:!query.isPending&&!query.isError&&<EmptyState title="Your plan starts with your available time">Add goals and tasks, then generate a plan to see where they fit.</EmptyState>}
    {!!versions.length&&<Card><h2 className="row"><History size={20}/>Plan history</h2><ul className="plan-history-list">{versions.map(v=><li key={v.id}><Button variant="text" onClick={()=>setSelected(v.id)} aria-pressed={current?.id===v.id}>Version {v.number} · {v.reason}</Button><span className="caption">{v.state} · {calendarDate(v.fromDate)}</span></li>)}</ul></Card>}
    {!!query.data?.breaks.length&&<Card><h2>Declared breaks</h2>{query.data.breaks.map(b=><p key={b.id}>{calendarDate(b.fromDate)}–{calendarDate(b.toDate)} · {b.reason}</p>)}</Card>}
    <Sheet open={breaking} onOpenChange={setBreaking} title="Declare a break" description="Remove these dates from new planning and choose the effect on each deadline."><BreakForm onSaved={async()=>{setBreaking(false);await query.refetch();await refresh();}}/></Sheet>
  </div>;
}
function BreakForm({onSaved}:{onSaved:()=>Promise<void>}) {
  const data=useData(),online=useOnline();
  const [from,setFrom]=useState(data.studyDate),[to,setTo]=useState(addDays(data.studyDate,2)),[reason,setReason]=useState(''),[choices,setChoices]=useState<Record<string,{action:string;targetQty?:number}>>({});
  const affected=data.goals.filter(g=>g.status==='active'&&!g.archivedAt&&g.dueDate&&g.dueDate>=from);
  const save=useMutation({mutationFn:()=>api('/planning/breaks',{method:'POST',body:{from,to,reason,choices:affected.map(g=>({goalId:g.id,action:choices[g.id]?.action??'keep',targetQty:choices[g.id]?.targetQty}))}}),onSuccess:onSaved});
  return <form className="stack-lg" onSubmit={e=>{e.preventDefault();save.mutate();}}><div className="grid-2"><Field id="break-from" label="First day"><input id="break-from" className="input" type="date" value={from} min={data.studyDate} required onChange={e=>setFrom(e.target.value)}/></Field><Field id="break-to" label="Last day"><input id="break-to" className="input" type="date" value={to} min={from} required onChange={e=>setTo(e.target.value)}/></Field></div><Field id="break-reason" label="Reason"><textarea id="break-reason" className="input" value={reason} maxLength={500} required onChange={e=>setReason(e.target.value)}/></Field><p className="muted">Fixed commitments stay visible. New flexible work avoids the break; review any existing commitment before cancelling it.</p>{affected.map(g=><div className="stack" key={g.id}><Field id={`break-${g.id}`} label={`${g.title} · ${g.targetQty} ${g.unit}`}><select id={`break-${g.id}`} className="input" value={choices[g.id]?.action??'keep'} onChange={e=>setChoices({...choices,[g.id]:{...choices[g.id],action:e.target.value}})}><option value="keep">Keep deadline and acknowledge the risk</option><option value="extend">Extend deadline by the break’s length</option><option value="reduce">Reduce the target in this goal’s unit</option></select></Field>{choices[g.id]?.action==='reduce'&&<Field id={`target-${g.id}`} label={`New target (${g.unit})`}><input id={`target-${g.id}`} className="input" type="number" min={0.001} step="any" max={g.targetQty-0.001} required onChange={e=>setChoices({...choices,[g.id]:{action:'reduce',targetQty:Number(e.target.value)}})}/></Field>}</div>)}{save.isError&&<Banner tone="error">{errorMessage(save.error)}</Banner>}<Button variant="primary" type="submit" disabled={!online} loading={save.isPending}>Apply break and review plan</Button></form>;
}
