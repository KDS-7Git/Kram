import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Pencil, Plus } from 'lucide-react';
import { addDays, dateRange, studyDate, weekStartDate } from '@kram/time';
import type { StreakRule, RunSummary } from '@kram/streaks';
import { Banner, Button, Card, DelayedSkeleton, EmptyState, Field, PageHeader, Sheet, Toggle } from '../../components/ui/kit';
import { api, apiList, errorMessage } from '../../shared/api';
import { useData, useOnline, useRefresh } from '../../shared/data';
import { useWallClock } from '../../shared/clock';
import { useUI } from '../../shared/ui';
import './streaks.css';
type StoredRule = StreakRule & { restWeekdays?: number[]; pausedRanges?: { start: string; end?: string | null }[] };
type RecordRow = { id: string; periodStart: string; periodEnd: string; result: string; reason: string; beforeReason: string | null; provisional: boolean; value: number; ruleVersion: number };
export type StreakDto = { id: string; title: string; scope: StreakRule['scope']; scopeId: string | null; startDate: string; status: string; rule: StoredRule; rules: { version: number; effectiveFrom: string; rules: StoredRule }[]; summary: RunSummary; records: RecordRow[] };
const states = ['met', 'missed', 'rest', 'paused', 'grace', 'provisional'];
const labels: Record<string, string> = { met: 'Met', missed: 'Below target', rest: 'Rest', paused: 'Paused', grace: 'Grace', provisional: 'Awaiting review', open: 'Open', empty: 'No stored result' };
function ruleSentence(rule: StoredRule) { return `${rule.threshold} ${rule.measure === 'minutes' ? 'min' : rule.measure === 'quantity' ? rule.unit : ['global', 'profile'].includes(rule.scope) ? 'met goal or skill streaks' : 'completed tasks'} each ${rule.period}${rule.countPartial ? ', including partial progress' : ', from completed work'}.`; }

export function Streaks() {
  const data = useData(), online = useOnline(), refresh = useRefresh(), query = useQueryClient(), { toast } = useUI();
  const now = useWallClock(60000), today = studyDate(now, data.user.settings.timezone, data.user.settings.dayRollover);
  const [editor, setEditor] = useState<{ streak?: StreakDto } | null>(null);
  const [quietMode, setQuietMode] = useState(data.user.settings.quietMode);
  useEffect(() => setQuietMode(data.user.settings.quietMode), [data.user.settings.quietMode]);
  const streaks = useQuery({ queryKey: ['streaks'], queryFn: ({ signal }) => apiList<StreakDto>('/streaks', signal), refetchInterval: 30000 });
  const quiet = useMutation({ mutationFn: (value: boolean) => api('/settings', { method: 'PATCH', body: { ...data.user.settings, quietMode: value } }), onSuccess: async () => { await refresh(); }, onError: error => { setQuietMode(data.user.settings.quietMode); toast(errorMessage(error), undefined, 'error'); } });
  return <>
    <PageHeader eyebrow="Progress" title="Practice, over time" description="Rest belongs here. Every closed period keeps its rule and its reason." action={<Button variant="primary" disabled={!online} onClick={() => setEditor({})}><Plus size={18} strokeWidth={1.5} />Add streak</Button>} />
    <div className="streak-toolbar"><Toggle label="Quiet mode" checked={quietMode} disabled={!online || quiet.isPending} onChange={value => { setQuietMode(value); quiet.mutate(value); }} /><p className="caption">Hide counts and targets while keeping your calendar.</p></div>
    {streaks.isPending ? <DelayedSkeleton height={300} /> : streaks.isError ? <Banner tone="error">{errorMessage(streaks.error)} <Button variant="text" onClick={() => void streaks.refetch()}>Retry streaks</Button></Banner> : !streaks.data?.length ? <EmptyState title="Make room for steady practice" icon={<CalendarDays strokeWidth={1} />} action={<Button disabled={!online} onClick={() => setEditor({})}>Choose a meaningful target</Button>}>Track one goal or skill, or time across your profiles. Rest days stay neutral, and grace is optional.</EmptyState> : <div className="streak-cards">{streaks.data.map(streak => <StreakCard key={streak.id} streak={streak} today={today} quiet={quietMode} weekStart={data.user.settings.weekStart} onEdit={() => setEditor({ streak })} />)}</div>}
    <Sheet open={!!editor} onOpenChange={open => { if (!open) setEditor(null); }} title={editor?.streak ? 'Edit streak rule' : 'A steady practice'} description="Choose a target that represents useful work. Rule changes keep your past intact.">{editor && <StreakEditor streak={editor.streak} today={today} onDone={async () => { await query.invalidateQueries({ queryKey: ['streaks'] }); setEditor(null); }} />}</Sheet>
  </>;
}
function StreakCard({ streak, today, quiet, weekStart, onEdit }: { streak: StreakDto; today: string; quiet: boolean; weekStart: 1 | 7; onEdit: () => void }) {
  const online = useOnline();
  const [selected, setSelected] = useState(addDays(today, -1));
  const dates = dateRange(addDays(weekStartDate(today, weekStart), -77), addDays(weekStartDate(today, weekStart), 6));
  const recordAt = (date: string) => streak.records.find(record => record.periodStart <= date && record.periodEnd >= date);
  const record = recordAt(selected);
  const status = record ? record.provisional ? 'provisional' : record.result : selected >= today ? 'open' : 'empty';
  const upcoming = streak.rules.filter(version => version.effectiveFrom > today);
  const runUnit = new Set(streak.rules.filter(version => version.effectiveFrom <= today).map(version => version.rules.period)).size > 1 ? 'periods' : streak.rule.period === 'day' ? 'days' : 'weeks';
  return <Card className="streak-card">
    <div className="card-header"><h2>{streak.title}</h2><Button variant="text" disabled={!online} onClick={onEdit}><Pencil size={16} strokeWidth={1.5} />Edit</Button></div>
    {!quiet && <><p>{ruleSentence(streak.rule)}</p><div className="streak-counts"><div><strong>{streak.summary.current}</strong><span>current {runUnit}</span></div><div><strong>{streak.summary.best}</strong><span>best {runUnit}</span></div></div><p className="caption">Rest and pauses keep the run steady. Grace stays distinct from met.</p></>}
    {streak.status === 'archived' && <p className="caption">Archived · history stays here.</p>}
    <div className="streak-heatmap" role="group" aria-label={`${streak.title}, twelve-week calendar`}>{dates.map(date => {
      const day = recordAt(date), result = day ? day.provisional ? 'provisional' : day.result : date >= today ? 'open' : 'empty';
      return <span key={date} role="img" className={`streak-cell streak-${result}`} data-selected={selected === date || undefined} aria-label={`${date}: ${quiet ? labels[result] : day?.reason ?? labels[result]}`} title={`${date}: ${labels[result]}`}><span aria-hidden="true">{result === 'met' ? '✓' : result === 'grace' ? '·' : result === 'paused' ? 'Ⅱ' : result === 'provisional' ? '?' : ''}</span></span>;
    })}</div>
    <ul className="streak-legend" aria-label="Calendar key">{states.map(state => <li key={state}><i className={`streak-cell streak-${state}`} aria-hidden="true" />{labels[state]}</li>)}</ul>
    <Field id={`streak-date-${streak.id}`} label="Inspect a day" hint="Choose any date to read its stored result."><input className="input" id={`streak-date-${streak.id}`} type="date" value={selected} min={streak.startDate} max={today} onChange={event => { if (event.target.value) setSelected(event.target.value); }} /></Field>
    <div className="streak-reason" aria-live="polite" aria-atomic="true"><strong>{labels[status]}</strong><p>{quiet ? status === 'provisional' ? 'This period awaits review and leaves the run unchanged.' : status === 'rest' || status === 'paused' ? 'The run stays unchanged.' : 'Your calendar keeps the stored result.' : record?.reason ?? (status === 'open' ? 'This period is still open. It will be evaluated after rollover or week end.' : 'There is no stored evaluation for this date.')}</p>{record?.beforeReason && !quiet && <details className="disclosure"><summary>Correction history</summary><p>Before: {record.beforeReason}</p><p>After: {record.reason}</p></details>}</div>
    {!quiet && !!upcoming.length && <p className="caption">Next rule starts {upcoming[0]!.effectiveFrom}. Earlier periods keep their original rules.</p>}
  </Card>;
}
function StreakEditor({ streak, today, onDone }: { streak?: StreakDto; today: string; onDone: () => void | Promise<void> }) {
  const data = useData(), online = useOnline(), { toast } = useUI();
  const latest = streak?.rules.at(-1)?.rules ?? streak?.rule;
  const [title, setTitle] = useState(streak?.title ?? ''), [scope, setScope] = useState<StreakRule['scope']>(streak?.scope ?? 'goal'), [scopeId, setScopeId] = useState(streak?.scopeId ?? '');
  const [measure, setMeasure] = useState<StreakRule['measure']>(latest?.measure ?? 'minutes'), [threshold, setThreshold] = useState(String(latest?.threshold ?? 30)), [period, setPeriod] = useState<StreakRule['period']>(latest?.period ?? 'day');
  const [days, setDays] = useState(latest?.eligibleDays ?? [1, 2, 3, 4, 5, 6, 7]), [partial, setPartial] = useState(latest?.countPartial ?? true), [grace, setGrace] = useState(latest?.gracePerMonth ?? 0), [rest, setRest] = useState(latest?.restPolicy ?? 'skip');
  const [effective, setEffective] = useState(streak ? addDays(streak.rules.at(-1)!.effectiveFrom > today ? streak.rules.at(-1)!.effectiveFrom : today, 1) : today);
  const [pauseStart, setPauseStart] = useState(''), [pauseEnd, setPauseEnd] = useState(''), [invalid, setInvalid] = useState('');
  const [pauses, setPauses] = useState(latest?.pausedRanges ?? []);
  const targets = scope === 'goal' ? data.goals.map(value => ({ id: value.id, name: value.title })) : scope === 'skill' ? data.skills : data.profiles;
  const unit = data.goals.find(goal => goal.id === scopeId)?.unit;
  const save = useMutation({ mutationFn: () => api(streak ? `/streaks/${streak.id}` : '/streaks', { method: streak ? 'PATCH' : 'POST', body: {
    title, ...(streak ? { effectiveFrom: effective } : { scope, scopeId: scope === 'global' ? null : scopeId, startDate: effective }),
    rule: { measure, threshold: Number(threshold), period, eligibleDays: days, countPartial: partial, gracePerMonth: grace, restPolicy: rest, restWeekdays: latest?.restWeekdays ?? data.user.settings.restDays, ...(measure === 'quantity' ? { unit } : {}), pausedRanges: [...pauses, ...(pauseStart ? [{ start: pauseStart, end: pauseEnd || null }] : [])] },
  } }), onSuccess: async () => { toast(streak ? 'Future rule saved. Your earlier records keep their rules.' : 'Streak saved.'); await onDone(); } });
  return <form className="stack-lg" noValidate onSubmit={event => { event.preventDefault(); if (!title.trim() || (scope !== 'global' && !scopeId) || !Number.isFinite(Number(threshold)) || Number(threshold) <= 0 || !days.length || (pauseEnd && (!pauseStart || pauseEnd < pauseStart))) { setInvalid('Add a title and target, a positive threshold and at least one eligible day. Check the pause dates.'); return; } setInvalid(''); save.mutate(); }}>
    <Field id="streak-title" label="Name"><input className="input" id="streak-title" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} autoFocus /></Field>
    <Field id="streak-scope" label="Track practice in"><select className="input" id="streak-scope" disabled={!!streak} value={scope} onChange={event => { setScope(event.target.value as StreakRule['scope']); setScopeId(''); if (event.target.value !== 'goal' && measure === 'quantity') setMeasure('minutes'); }}><option value="goal">One goal</option><option value="skill">One skill</option><option value="profile">One profile</option><option value="global">All profiles</option></select></Field>
    {scope !== 'global' && <Field id="streak-target" label="Practice target"><select className="input" id="streak-target" disabled={!!streak} value={scopeId} onChange={event => setScopeId(event.target.value)}><option value="">Choose one</option>{targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}</select></Field>}
    <div className="form-grid"><Field id="streak-measure" label="Measure"><select className="input" id="streak-measure" value={measure} onChange={event => setMeasure(event.target.value as StreakRule['measure'])}><option value="minutes">Practice minutes</option>{scope === 'goal' && <option value="quantity">Goal quantity ({unit || 'choose a goal'})</option>}<option value="completion">{scope === 'profile' || scope === 'global' ? 'Met goal or skill streaks' : 'Completed tasks'}</option></select></Field><Field id="streak-threshold" label={`Target (${measure === 'minutes' ? 'min' : measure === 'quantity' ? unit || 'units' : 'count'})`}><input className="input" id="streak-threshold" inputMode="decimal" type="number" min="0.01" step="any" value={threshold} onChange={event => setThreshold(event.target.value)} /></Field></div>
    <Field id="streak-period" label="Evaluate each" hint={period === 'week' ? 'Tracking begins with the next full week at your configured week start.' : undefined}><select className="input" id="streak-period" value={period} onChange={event => setPeriod(event.target.value as StreakRule['period'])}><option value="day">Study day, at rollover</option><option value="week">Full week, at week end</option></select></Field>
    <fieldset className="streak-days"><legend>Eligible days</legend>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => <label key={day}><input type="checkbox" checked={days.includes(index + 1)} onChange={event => setDays(event.target.checked ? [...days, index + 1].sort() : days.filter(value => value !== index + 1))} /><span>{day}</span></label>)}</fieldset>
    <Toggle label="Count partial work" checked={partial} onChange={setPartial} />
    <div className="form-grid"><Field id="streak-rest" label="On rest days"><select className="input" id="streak-rest" value={rest} onChange={event => setRest(event.target.value as 'skip' | 'miss')}><option value="skip">Keep the run unchanged</option><option value="miss">Apply the target</option></select></Field><Field id="streak-grace" label="Grace per month" hint="Optional. Grace extends a run and is shown separately from met."><select className="input" id="streak-grace" value={grace} onChange={event => setGrace(Number(event.target.value))}>{[0, 1, 2, 3].map(value => <option key={value} value={value}>{value === 0 ? 'None' : value}</option>)}</select></Field></div>
    <Field id="streak-effective" label={streak ? 'New rule starts on' : 'Start tracking on'} hint={streak ? 'Past evaluations remain under their original rules.' : 'Earlier progress can be replayed if you choose an earlier date.'}><input className="input" id="streak-effective" type="date" value={effective} min={streak ? addDays(today, 1) : undefined} max={streak ? undefined : today} onChange={event => setEffective(event.target.value)} /></Field>
    <details className="disclosure"><summary>Pause this practice</summary><p className="caption">Paused periods leave the run unchanged.</p>{pauses.filter(pause => !pause.end).map(pause => <div key={pause.start} className="stack"><p className="caption">Ongoing pause from {pause.start}.</p><Button onClick={() => setPauses(pauses.filter(value => value !== pause))}>Resume when the new rule starts</Button></div>)}<div className="form-grid"><Field id="streak-pause-start" label="Pause from"><input className="input" id="streak-pause-start" type="date" min={effective} value={pauseStart} onChange={event => setPauseStart(event.target.value)} /></Field><Field id="streak-pause-end" label="Through (optional)"><input className="input" id="streak-pause-end" type="date" min={pauseStart || effective} value={pauseEnd} onChange={event => setPauseEnd(event.target.value)} /></Field></div></details>
    {(scope === 'profile' || scope === 'global') && measure === 'completion' && <Banner>This counts met goal and skill streaks in the selected scope. Create those streaks first.</Banner>}
    {invalid && <Banner tone="error">{invalid}</Banner>}{save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}{!online && <Banner>Reconnect to save this rule.</Banner>}<Button variant="primary" type="submit" disabled={!online} loading={save.isPending}>{streak ? 'Save future rule' : 'Create streak'}</Button>
  </form>;
}
