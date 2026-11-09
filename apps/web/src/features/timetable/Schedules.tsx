import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { v7 as newId } from 'uuid';
import { CalendarDays, Copy, Plus, Repeat2, Trash2 } from 'lucide-react';
import { AnimatePresence, m } from 'framer-motion';
import { addDays, weekStartDate } from '@kram/time';
import type { Holiday, Occurrence, RecurrenceSeries, ScheduleTemplate } from '@kram/shared';
import { Banner, Button, Card, DelayedSkeleton, EmptyState, Field, IconButton, PageHeader, Segments, Sheet, Truncate } from '../../components/ui/kit';
import { api, apiList, errorMessage } from '../../shared/api';
import { useData, useOnline, useRefresh } from '../../shared/data';
import { calendarDate, clockLabel, minuteTime, timeMinute, weekdays } from '../../shared/format';
import { useUI } from '../../shared/ui';
import { listSpring, useMotionPreference } from '../../shared/motion';
import { RecurrenceFields, recurrenceWords } from '../goals/RecurrenceFields';
import { DeleteButton } from '../../components/DeleteButton';

type Editor = { mode: 'new' | 'future' | 'modify' | 'move' | 'pause' | 'resume'; series?: RecurrenceSeries; occurrence?: Occurrence; date?: string };
function scheduleDetails(item: RecurrenceSeries, format: '12' | '24') {
  const rhythm = recurrenceWords(item.rrule).replace(/^every week on /, '');
  const time = item.startMin === null ? `${item.estMinutes} min` : `${clockLabel(item.startMin, format)}–${clockLabel(item.startMin + item.estMinutes, format)}`;
  return `${rhythm} · ${time}`;
}
export function Schedules() {
  const data = useData(), online = useOnline(), refresh = useRefresh(), { toast } = useUI();
  const reduced = useMotionPreference();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<'recurring' | 'templates' | 'holidays'>(params.get('tab') === 'templates' ? 'templates' : params.get('tab') === 'holidays' ? 'holidays' : 'recurring');
  const [from, setFrom] = useState(params.get('date') || data.studyDate), [to, setTo] = useState(addDays(params.get('date') || data.studyDate, 20));
  const [selected, setSelected] = useState(params.get('seriesId') || 'all'), [editor, setEditor] = useState<Editor | null>(null);
  const [showPast, setShowPast] = useState(false);
  const series = useQuery({ queryKey: ['recurrence', 'series'], queryFn: () => apiList<RecurrenceSeries>('/recurrence/series') });
  const occurrences = useQuery({ queryKey: ['recurrence', 'occurrences', from, to], queryFn: () => apiList<Occurrence>(`/recurrence/occurrences?from=${from}&to=${to}`) });
  const skip = useMutation({ mutationFn: (item: Occurrence) => api(`/recurrence/series/${item.seriesId}/exceptions`, { method: 'POST', headers: { 'If-Match': `"${item.series.version}"` }, body: { date: item.originalDate, kind: 'skip' } }), onSuccess: async () => { await refresh(); toast('Occurrence skipped. The repeating rhythm stays anchored.'); } });
  const courseValue = (title: string) => `course:${encodeURIComponent(title)}`;
  const active = (series.data || []).filter(item => showPast || !item.until || item.until >= data.studyDate || item.id === selected);
  const choices = (series.data || []).filter(item => showPast || !item.until || item.until >= from || item.id === selected || item.classDetails && courseValue(item.title) === selected);
  const groups = new Map<string, RecurrenceSeries[]>(), choiceGroups = new Map<string, RecurrenceSeries[]>();
  for (const item of active.filter(item => item.classDetails)) groups.set(item.title, [...(groups.get(item.title) || []), item]);
  for (const item of choices.filter(item => item.classDetails)) choiceGroups.set(item.title, [...(choiceGroups.get(item.title) || []), item]);
  const visible = (occurrences.data || []).filter(item => (selected === 'all' || item.seriesId === selected || item.series.classDetails && courseValue(item.series.title) === selected) && item.status !== 'suppressed');
  return <div className="workspace-page schedules-workspace">
    <PageHeader eyebrow="Plan · schedules" title="Keep a rhythm, leave room for change" description="Repeating commitments, weekly templates and daily edits share one timetable." action={<Link className="button" to="/plan">Back to timetable</Link>} />
    <Segments label="Schedule tools" value={tab} onChange={setTab} options={[{ value: 'recurring', label: 'Repeating schedules' }, { value: 'templates', label: 'Templates and copy' }, { value: 'holidays', label: 'Holidays' }]} />
    <div className="stack-lg schedule-page">
      {tab === 'recurring' && <>
        <div className="row between wrap"><p className="muted">Recurring goals create their series from the rules in Goals.</p><div className="row wrap"><Link className="button" to="/classes">Classes and labs</Link><Button variant="primary" disabled={!online} onClick={() => setEditor({ mode: 'new' })}><Plus size={18} /> Add repeating commitment</Button></div></div>
        {series.isPending ? <DelayedSkeleton height={120} /> : series.isError ? <Banner tone="error" action={<Button onClick={() => void series.refetch()}>Retry</Button>}>{errorMessage(series.error)}</Banner> : <div className="grid-2">
          {[...groups].map(([title, meetings]) => <Card key={courseValue(title)} className="stack"><div><h2>{title}</h2><p className="caption">Classes and labs · {meetings.length} meeting patterns</p></div><ul className="class-schedule-meetings">{meetings.map(item => <li key={item.id}><strong>{item.classDetails?.type === 'lab' ? 'Lab' : 'Lecture'}{item.classDetails?.slot ? ` · ${item.classDetails.slot}` : ''}</strong><span className="caption">{scheduleDetails(item, data.user.settings.clockFormat)}{item.until ? ` · until ${calendarDate(item.until)}` : ''}</span></li>)}</ul><div className="row wrap"><Button onClick={() => setSelected(courseValue(title))}>View course occurrences</Button><Link className="button" to="/classes">Edit weekly times</Link></div><details className="disclosure"><summary>Manage individual meeting patterns</summary><div className="stack">{meetings.map(item => <div className="stack" key={item.id}><p className="caption">{scheduleDetails(item, data.user.settings.clockFormat)} · {item.status}</p><div className="row wrap"><Button onClick={() => setSelected(item.id)}>View this pattern</Button><DeleteButton kind="schedule" id={item.id} title={`${item.title} · ${scheduleDetails(item, data.user.settings.clockFormat)}`} onDeleted={() => setSelected('all')} /></div></div>)}</div></details></Card>)}
          {active.filter(item => !item.classDetails).map(item => <Card key={item.id} className="stack"><div><h2>{item.title}</h2><p className="caption schedule-meeting-time">{scheduleDetails(item, data.user.settings.clockFormat)}</p><p className="caption">From {calendarDate(item.dtstartLocal)}{item.until ? ` until ${calendarDate(item.until)}` : ''} · {item.tz}</p><p className="caption">{item.kind === 'goal' ? 'Goal tasks' : `${item.layer === 'unavailable' ? 'Unavailable' : 'Fixed'} commitment`} · {item.status}</p></div><div className="row wrap">
            <Button onClick={() => setSelected(item.id)}>View occurrences</Button>
            <Button disabled={!online} onClick={() => setEditor({ mode: item.status === 'paused' ? 'resume' : 'pause', series: item })}>{item.status === 'paused' ? 'Resume series' : 'Pause series'}</Button>
            <Button disabled={!online} onClick={() => setEditor({ mode: 'future', series: item })}>Edit future</Button>
            {item.goalId && <Link className="button button-text" to={`/goals/${item.goalId}`}>Open goal</Link>}
            {item.kind === 'fixed' && <DeleteButton kind="schedule" id={item.id} title={item.title} onDeleted={() => setSelected('all')} />}
          </div></Card>)}
          {!active.length && <Card className="schedule-empty"><EmptyState title="Start with a regular commitment" icon={<Repeat2 />} action={<Button disabled={!online} onClick={() => setEditor({ mode: 'new' })}><Plus size={16} /> Add a commitment</Button>}>Give a class or appointment a rhythm. You can always make room for changes.</EmptyState></Card>}
        </div>}
        <Card className="stack-lg"><div className="schedule-range">
          <Field id="occurrence-from" label="Occurrences from"><input className="input" id="occurrence-from" type="date" value={from} onChange={event => { if (event.target.value) { setFrom(event.target.value); if (event.target.value > to) setTo(addDays(event.target.value, 20)); } }} /></Field>
          <Field id="occurrence-to" label="Occurrences until"><input className="input" id="occurrence-to" type="date" min={from} value={to} onChange={event => { if (event.target.value) setTo(event.target.value); }} /></Field>
          <Field id="occurrence-series" label="Series filter"><select className="input" id="occurrence-series" value={selected} onChange={event => setSelected(event.target.value)}><option value="all">All series</option>{[...choiceGroups].map(([title, meetings]) => <option value={courseValue(title)} key={courseValue(title)}>{title} · {meetings.length} meeting patterns</option>)}{choices.filter(item => !item.classDetails || item.id === selected).map(item => <option value={item.id} key={item.id}>{item.title} · {scheduleDetails(item, data.user.settings.clockFormat)}{item.until && item.until < from ? ` · ended ${calendarDate(item.until)}` : ''}</option>)}</select></Field>
        </div>
          <label className="toggle-label"><input type="checkbox" checked={showPast} onChange={event => setShowPast(event.target.checked)} />Include past schedules</label>
          {skip.isError && <Banner tone="error">{errorMessage(skip.error)}</Banner>}
          {occurrences.isPending ? <DelayedSkeleton height={160} /> : occurrences.isError ? <Banner tone="error" action={<Button onClick={() => void occurrences.refetch()}>Retry</Button>}>{errorMessage(occurrences.error)}</Banner> : <div className="stack">
            <AnimatePresence initial={false}>{visible.map(item => { const editable = online && item.originalDate >= data.studyDate && !item.manualOverride && !item.tasks.some(task => task.actualMinutes > 0 || task.manualOverride || !['pending', 'unverified'].includes(task.status)); return <m.article layout={reduced ? false : 'position'} initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0 }} transition={reduced ? { duration: 0 } : listSpring} className="occurrence-row" key={item.id}>
              <div><strong><Truncate>{item.fields.title}</Truncate></strong><p className="caption">{calendarDate(item.localDate)}{item.fields.startMin !== undefined ? ` · ${clockLabel(item.fields.startMin, data.user.settings.clockFormat)}` : ''} · {item.status}{item.virtual ? ' · upcoming' : ''}</p>
                {item.moved && <p className="caption">Moved from {calendarDate(item.originalDate)}; original occurrence retained.</p>}{(item.adjusted || item.ambiguous) && <p className="caption">Local time resolved for a daylight-saving change.</p>}{item.manualOverride && <p className="caption">Your timetable edit is preserved.</p>}{item.status === 'conflict' && <p className="caption">Overlaps {Array.isArray(item.conflict) ? item.conflict.map((row: { title?: string }) => row.title || 'another block').join(', ') : 'another block'}. Move or edit this occurrence to choose another time.</p>}
              </div><div className="row wrap">
                <Button disabled={!editable} onClick={() => setEditor({ mode: 'modify', occurrence: item, series: item.series })}>Edit one</Button>
                <Button disabled={!editable} onClick={() => setEditor({ mode: 'move', occurrence: item, series: item.series })}>Move one</Button>
                <Button disabled={!editable || skip.isPending} onClick={() => skip.mutate(item)}>Skip one</Button>
              </div>
            </m.article>; })}</AnimatePresence>
            {!visible.length && <EmptyState title="Room in this part of your calendar" icon={<CalendarDays />} action={<Button variant="text" onClick={() => { setSelected('all'); setFrom(data.studyDate); setTo(addDays(data.studyDate, 20)); }}>Reset date range</Button>}>No occurrences match these dates and this series. Try another range to see what's ahead.</EmptyState>}
          </div>}
        </Card>
      </>}
      {tab === 'templates' && <TemplateTools />}
      {tab === 'holidays' && <HolidayTools />}
    </div>
    <Sheet open={!!editor} onOpenChange={open => { if (!open) setEditor(null); }} title={editor ? ({ new: 'A repeating commitment', future: 'Change future occurrences', modify: 'Edit this occurrence', move: 'Move this occurrence', pause: 'Pause this series', resume: 'Resume this series' })[editor.mode] : ''} description="Past work keeps its history. Moving one occurrence preserves its recorded work.">
      {editor && <SeriesEditor key={`${editor.mode}:${editor.series?.id || 'new'}:${editor.occurrence?.originalDate || ''}`} action={editor} onDone={() => setEditor(null)} />}
    </Sheet>
  </div>;
}

function SeriesEditor({ action, onDone }: { action: Editor; onDone: () => void }) {
  const data = useData(), online = useOnline(), refresh = useRefresh(), { toast } = useUI();
  const row = action.series, item = action.occurrence, mode = action.mode;
  const [title, setTitle] = useState(item?.fields.title || row?.title || '');
  const [rule, setRule] = useState(row?.rrule || 'FREQ=WEEKLY;BYDAY=MO,WE,FR');
  const [date, setDate] = useState(action.date || item?.originalDate || (row?.dtstartLocal && row.dtstartLocal > data.studyDate ? row.dtstartLocal : data.studyDate));
  const [destination, setDestination] = useState(item?.localDate || data.studyDate);
  const [start, setStart] = useState(minuteTime(item?.fields.startMin ?? row?.startMin ?? 1080));
  const [minutes, setMinutes] = useState(item?.fields.estMinutes ?? row?.estMinutes ?? 30);
  const [qty, setQty] = useState(item?.fields.qty ?? row?.qty ?? 1), [until, setUntil] = useState(row?.until || '');
  const [skillId, setSkillId] = useState(row?.skillId || ''), [layer, setLayer] = useState<'fixed' | 'unavailable'>(row?.layer || 'fixed');
  const save = useMutation({ mutationFn: async () => {
    const headers: Record<string, string> = row ? { 'If-Match': `"${row.version}"` } : {};
    if (mode === 'new') return api('/recurrence/series', { method: 'POST', body: { title, rrule: rule, dtstartLocal: date, tz: data.user.settings.timezone, startMin: timeMinute(start), estMinutes: minutes, until: until || null, skillId: skillId || null, layer } });
    if (mode === 'pause' || mode === 'resume') return api(`/recurrence/series/${row!.id}/${mode}`, { method: 'POST', headers, body: { date } });
    if (mode === 'future') {
      const changes = row!.kind === 'goal' ? { title, ...(rule !== row!.rrule ? { rrule: rule } : {}), startDate: date, estMinutes: minutes, targetQty: qty, dueDate: until || null } : { title, ...(rule !== row!.rrule ? { rrule: rule } : {}), startMin: timeMinute(start), estMinutes: minutes, until: until || null, skillId: skillId || null, layer };
      return api(`/recurrence/series/${row!.id}/future`, { method: 'POST', headers, body: { from: date, changes } });
    }
    const body = mode === 'move' ? { date: item!.originalDate, kind: 'move', toDate: destination, toStartMin: timeMinute(start) } : { date: item!.originalDate, kind: 'modify', override: { title, estMinutes: minutes, qty, ...(row!.kind === 'fixed' ? { startMin: timeMinute(start) } : {}) } };
    return api(`/recurrence/series/${row!.id}/exceptions`, { method: 'POST', headers, body });
  }, onSuccess: async () => { await refresh(); toast('Schedule saved.'); onDone(); } });
  return <form className="stack-lg" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
    {['new', 'future', 'modify'].includes(mode) && <Field id="series-title" label="Schedule title"><input className="input" id="series-title" required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></Field>}
    {['new', 'future'].includes(mode) && <><RecurrenceFields rule={rule} onChange={setRule} /><details className="disclosure"><summary>Advanced calendar rule</summary><Field id="series-rrule" label="Calendar recurrence rule" hint="For example FREQ=DAILY;INTERVAL=2;COUNT=8. Select calendar dates here and set the start time separately."><input className="input code-input" id="series-rrule" value={rule} onChange={event => setRule(event.target.value)} /></Field></details></>}
    {['new', 'future', 'pause', 'resume'].includes(mode) && <Field id="series-date" label={mode === 'new' ? 'Anchor date' : mode === 'future' ? 'Changes start on' : mode === 'pause' ? 'Pause starts on' : 'Resume on'} hint="Alternate-day patterns retain their anchor through skips and pauses."><input className="input" id="series-date" type="date" required min={data.studyDate} value={date} onChange={event => setDate(event.target.value)} /></Field>}
    {mode === 'move' && <Field id="series-destination" label="Move to date"><input className="input" id="series-destination" type="date" required min={data.studyDate} value={destination} onChange={event => setDestination(event.target.value)} /></Field>}
    {!['pause', 'resume'].includes(mode) && <div className="grid-2">
      {(mode === 'new' || row?.kind === 'fixed' || mode === 'move') && <Field id="series-time" label="Starts at"><input className="input" id="series-time" type="time" required value={start} onChange={event => setStart(event.target.value)} /></Field>}
      {mode !== 'move' && <Field id="series-duration" label="Duration (min)"><input className="input" id="series-duration" type="number" required min={1} max={960} value={minutes} onChange={event => setMinutes(Number(event.target.value))} /></Field>}
      {row?.kind === 'goal' && mode !== 'move' && <Field id="series-quantity" label={`Target (${row.unit})`}><input className="input" id="series-quantity" type="number" required min={0.001} max={1000000} step="any" value={qty} onChange={event => setQty(Number(event.target.value))} /></Field>}
    </div>}
    {['new', 'future'].includes(mode) && <>
      <Field id="series-until" label="Series ends on (optional)"><input className="input" id="series-until" type="date" min={date} value={until} onChange={event => setUntil(event.target.value)} /></Field>
      {(mode === 'new' || row?.kind === 'fixed') && <div className="grid-2"><Field id="series-skill" label="Skill (optional)"><select className="input" id="series-skill" value={skillId} onChange={event => setSkillId(event.target.value)}><option value="">All areas</option>{data.skills.filter(skill => !skill.archivedAt).map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></Field><Field id="series-layer" label="Commitment type"><select className="input" id="series-layer" value={layer} onChange={event => setLayer(event.target.value as typeof layer)}><option value="fixed">Fixed commitment</option><option value="unavailable">Unavailable time</option></select></Field></div>}
    </>}
    {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}
    {!online && <Banner>Reconnect to save schedule changes.</Banner>}
    <Button variant="primary" type="submit" disabled={!online} loading={save.isPending}>Save schedule</Button>
  </form>;
}

function TemplateTools() {
  const data = useData(), online = useOnline(), refresh = useRefresh(), { toast } = useUI();
  const [showArchived, setShowArchived] = useState(false);
  const rows = useQuery({ queryKey: ['templates', showArchived], queryFn: () => apiList<ScheduleTemplate>(`/timetable/templates${showArchived ? '?archived=true' : ''}`) });
  const [editor, setEditor] = useState<{ row?: ScheduleTemplate } | null>(null), [anchor, setAnchor] = useState(weekStartDate(data.studyDate, data.user.settings.weekStart));
  const apply = useMutation({ mutationFn: (row: ScheduleTemplate) => api<{ reused: boolean }>(`/timetable/templates/${row.id}/apply`, { method: 'POST', headers: { 'If-Match': `"${row.version}"` }, body: { anchor: row.kind === 'week' ? weekStartDate(anchor, data.user.settings.weekStart) : anchor } }), onSuccess: async result => { await refresh(); toast(result.reused ? 'This template is already applied to that date.' : 'Template applied. Daily edits stay independent.'); } });
  const archive = useMutation({ mutationFn: (row: ScheduleTemplate) => api(`/timetable/templates/${row.id}`, { method: 'DELETE', headers: { 'If-Match': `"${row.version}"` } }), onSuccess: async () => { await refresh(); toast('Template archived. Existing weeks stay available.'); } });
  return <><Card className="stack-lg"><div className="row between wrap"><div><h2>Weekly and daily templates</h2><p className="caption">Apply a template to create concrete blocks. Later template edits affect later applications.</p></div><Button variant="primary" disabled={!online} onClick={() => setEditor({})}><Plus size={18} /> Create template</Button></div><Field id="template-anchor" label="Apply to date or week" hint={`Weekly templates use your ${data.user.settings.weekStart === 1 ? 'Monday' : 'Sunday'} week start.`}><input className="input" id="template-anchor" type="date" value={anchor} onChange={event => { if (event.target.value) setAnchor(event.target.value); }} /></Field>
    <label className="toggle-label"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Include archived templates</label>
    {rows.isPending ? <DelayedSkeleton height={120} /> : rows.isError ? <Banner tone="error" action={<Button onClick={() => void rows.refetch()}>Retry</Button>}>{errorMessage(rows.error)}</Banner> : <div className="stack">{(rows.data || []).map(row => <article className="occurrence-row" key={row.id}><div><strong><Truncate>{row.name}</Truncate></strong><p className="caption">{row.kind === 'week' ? 'Weekly' : 'Daily'} · {row.entries.length} {row.entries.length === 1 ? 'block' : 'blocks'}{row.archivedAt ? ' · archived' : ''}</p></div><div className="row wrap">{!row.archivedAt && <><Button disabled={!online || apply.isPending} onClick={() => apply.mutate(row)}>Apply template</Button><Button disabled={!online} onClick={() => setEditor({ row })}>Edit template</Button><Button disabled={!online || archive.isPending} onClick={() => archive.mutate(row)}>Archive template</Button></>}<DeleteButton kind="template" id={row.id} title={row.name} /></div></article>)}{!rows.data?.length && <EmptyState title="A good week, ready to repeat" icon={<Copy />} action={<Button disabled={!online} onClick={() => setEditor({})}><Plus size={16} /> Create your first template</Button>}>Save your regular time blocks once, then bring them into a day or week when you need them.</EmptyState>}</div>}
    {apply.isError && <Banner tone="error">{errorMessage(apply.error)}</Banner>}{archive.isError && <Banner tone="error">{errorMessage(archive.error)}</Banner>}
  </Card><CopyTools /><Sheet open={!!editor} onOpenChange={open => { if (!open) setEditor(null); }} title={editor?.row ? 'Edit a template' : 'A reusable template'} description="Reserve study time for a skill, or add fixed and unavailable blocks.">{editor && <TemplateEditor key={editor.row?.id || 'new'} row={editor.row} onDone={() => setEditor(null)} />}</Sheet></>;
}
function TemplateEditor({ row, onDone }: { row?: ScheduleTemplate; onDone: () => void }) {
  const data = useData(), refresh = useRefresh(), online = useOnline(), { toast } = useUI();
  const [name, setName] = useState(row?.name || ''), [kind, setKind] = useState<'week' | 'day'>(row?.kind || 'week');
  const initial = row?.entries || [{ weekday: 1, startMin: 1080, endMin: 1140, title: 'Study window', layer: 'reserved' as const, skillId: data.skills.find(skill => !skill.archivedAt)?.id || null, profileId: null, goalId: null, pinned: false }];
  const [entries, setEntries] = useState(initial.map(entry => ({ ...entry, key: newId() })));
  const change = (index: number, patch: Partial<typeof entries[number]>) => setEntries(previous => previous.map((entry, position) => position === index ? { ...entry, ...patch } : entry));
  const save = useMutation({ mutationFn: () => api(row ? `/timetable/templates/${row.id}` : '/timetable/templates', { method: row ? 'PATCH' : 'POST', ...(row ? { headers: { 'If-Match': `"${row.version}"` } } : {}), body: { name, kind, entries: entries.map(({ key: _key, ...entry }) => entry) } }), onSuccess: async () => { await refresh(); toast('Template saved.'); onDone(); } });
  return <form className="stack-lg" onSubmit={event => { event.preventDefault(); save.mutate(); }}><Field id="template-name" label="Template name"><input className="input" id="template-name" required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></Field><Field id="template-kind" label="Template repeats a"><select className="input" id="template-kind" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="week">Week</option><option value="day">Day</option></select></Field>
    {entries.map((entry, index) => <fieldset className="template-entry" key={entry.key}><legend>Block {index + 1}</legend><div className="row between"><strong>{entry.title || 'Time block'}</strong><IconButton label={`Remove template block ${index + 1}`} disabled={entries.length === 1} onClick={() => setEntries(previous => previous.filter(value => value.key !== entry.key))}><Trash2 size={18} /></IconButton></div>
      <Field id={`template-title-${entry.key}`} label="Block title"><input className="input" id={`template-title-${entry.key}`} required maxLength={200} value={entry.title} onChange={event => change(index, { title: event.target.value })} /></Field><div className="grid-2">
        {kind === 'week' && <Field id={`template-day-${entry.key}`} label="Weekday"><select className="input" id={`template-day-${entry.key}`} value={entry.weekday} onChange={event => change(index, { weekday: Number(event.target.value) })}>{weekdays.map(day => <option key={day.value} value={day.value}>{day.label}</option>)}</select></Field>}
        <Field id={`template-layer-${entry.key}`} label="Block type"><select className="input" id={`template-layer-${entry.key}`} value={entry.layer} onChange={event => change(index, { layer: event.target.value as typeof entry.layer })}><option value="reserved">Reserved study window</option><option value="fixed">Fixed commitment</option><option value="unavailable">Unavailable</option><option value="flexible">Flexible block</option><option value="pinned">Pinned block</option></select></Field>
        <Field id={`template-start-${entry.key}`} label="Starts at"><input className="input" id={`template-start-${entry.key}`} type="time" required value={minuteTime(entry.startMin)} onChange={event => change(index, { startMin: timeMinute(event.target.value) })} /></Field><Field id={`template-end-${entry.key}`} label="Ends at"><input className="input" id={`template-end-${entry.key}`} type="time" required data-allow-midnight="true" value={minuteTime(entry.endMin)} onChange={event => change(index, { endMin: timeMinute(event.target.value) })} /></Field>
      </div><Field id={`template-skill-${entry.key}`} label={entry.layer === 'reserved' ? 'Reserved for skill' : 'Skill (optional)'}><select className="input" id={`template-skill-${entry.key}`} required={entry.layer === 'reserved'} value={entry.skillId || ''} onChange={event => change(index, { skillId: event.target.value || null, profileId: null, goalId: null })}><option value="">Choose a skill</option>{data.skills.filter(skill => !skill.archivedAt).map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></Field>
    </fieldset>)}
    <Button disabled={entries.length >= 100} onClick={() => setEntries(previous => [...previous, { ...initial[0]!, title: 'Another block', key: newId() }])}><Plus size={18} /> Add template block</Button>
    {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}<Button type="submit" variant="primary" disabled={!online} loading={save.isPending}>Save template</Button>
  </form>;
}
function CopyTools() {
  const data = useData(), online = useOnline(), refresh = useRefresh(), { toast } = useUI();
  const [source, setSource] = useState(data.studyDate), [target, setTarget] = useState(addDays(data.studyDate, 7)), [days, setDays] = useState<1 | 7>(1), [requestId, setRequestId] = useState(newId());
  const copy = useMutation({ mutationFn: () => api<{ count?: number; reused: boolean }>('/timetable/copy', { method: 'POST', body: { source, target, days, requestId } }), onSuccess: async result => { await refresh(); toast(result.reused ? 'This copy is already applied.' : `${result.count ?? 0} time blocks copied.`); setRequestId(newId()); } });
  return <Card className="stack-lg"><div className="row"><Copy size={22} /><div><h2>Copy a day or week</h2><p className="caption">Copy scheduled times. Progress stays with the original work.</p></div></div><form className="stack" onSubmit={event => { event.preventDefault(); copy.mutate(); }}><div className="schedule-range"><Field id="copy-source" label="Copy from"><input className="input" id="copy-source" type="date" required value={source} onChange={event => { setSource(event.target.value); setRequestId(newId()); }} /></Field><Field id="copy-target" label="Copy to"><input className="input" id="copy-target" type="date" required value={target} onChange={event => { setTarget(event.target.value); setRequestId(newId()); }} /></Field><Field id="copy-span" label="Copy how much"><select className="input" id="copy-span" value={days} onChange={event => { setDays(Number(event.target.value) as 1 | 7); setRequestId(newId()); }}><option value={1}>One day</option><option value={7}>Seven days</option></select></Field></div>{copy.isError && <Banner tone="error">{errorMessage(copy.error)}</Banner>}<Button type="submit" disabled={!online} loading={copy.isPending}>Copy time blocks</Button></form></Card>;
}
function HolidayTools() {
  const data = useData(), online = useOnline(), refresh = useRefresh(), { toast } = useUI();
  const rows = useQuery({ queryKey: ['holidays'], queryFn: () => apiList<Holiday>('/holidays') });
  const [date, setDate] = useState(data.studyDate), [title, setTitle] = useState('');
  const save = useMutation({ mutationFn: () => api('/holidays', { method: 'POST', body: { date, title } }), onSuccess: async () => { await refresh(); toast('Holiday saved. Recorded work is preserved.'); setTitle(''); } });
  const remove = useMutation({ mutationFn: (id: string) => api(`/holidays/${id}`, { method: 'DELETE' }), onSuccess: async () => { await refresh(); toast('Holiday removed.'); } });
  return <Card className="stack-lg"><div className="row"><CalendarDays size={24} /><div><h2>Holidays</h2><p className="caption">Suppress repeating occurrences on these dates while preserving recorded work.</p></div></div><form className="stack" onSubmit={event => { event.preventDefault(); save.mutate(); }}><div className="grid-2"><Field id="holiday-date" label="Holiday date"><input className="input" id="holiday-date" type="date" required min={data.studyDate} value={date} onChange={event => setDate(event.target.value)} /></Field><Field id="holiday-title" label="Holiday name"><input className="input" id="holiday-title" required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></Field></div>{save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}<Button type="submit" disabled={!online} loading={save.isPending}>Add holiday</Button></form>
    {rows.isPending ? <DelayedSkeleton height={80} /> : rows.isError ? <Banner tone="error" action={<Button onClick={() => void rows.refetch()}>Retry</Button>}>{errorMessage(rows.error)}</Banner> : rows.data?.length ? rows.data.map(row => <article className="occurrence-row" key={row.id}><div><strong><Truncate>{row.title}</Truncate></strong><p className="caption"><time dateTime={row.date}>{calendarDate(row.date)}</time></p></div><Button disabled={!online || remove.isPending || row.date < data.studyDate} onClick={() => remove.mutate(row.id)}>Remove holiday</Button></article>) : <EmptyState title="Keep a day open" icon={<CalendarDays />} action={<Button variant="text" onClick={() => document.getElementById('holiday-title')?.focus()}>Name a holiday</Button>}>Add a holiday to pause your repeating schedule for that day. Your recorded progress stays safe.</EmptyState>}{remove.isError && <Banner tone="error">{errorMessage(remove.error)}</Banner>}
  </Card>;
}
