import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { v7 as newId } from 'uuid';
import { BookOpen, Copy, FlaskConical, Trash2 } from 'lucide-react';
import { addDays } from '@kram/time';
import { classTimetableSchema, classWeekdays, type ClassDayPreview, type ClassDayResult, type ClassTimetableResult, type Occurrence, type RecurrenceSeries } from '@kram/shared';
import { Banner, Button, Card, DelayedSkeleton, Field, IconButton, PageHeader } from '../../components/ui/kit';
import { api, apiList, errorMessage } from '../../shared/api';
import { useData, useOnline, useRefresh } from '../../shared/data';
import { calendarDate, clockLabel, duration, weekdays } from '../../shared/format';
import { useUI } from '../../shared/ui';
import { classTime, parseClassTime, parseTimetablePaste, type ClassDraft, type PasteResult } from './classPaste';

const fullDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const fromSeries = (row: RecurrenceSeries): ClassDraft => ({ key: newId(), id: row.id, version: row.version, course: row.title, type: row.classDetails?.type || (/\blab\b/i.test(row.title) ? 'lab' : 'lecture'), slot: row.classDetails?.slot || '', weekdays: classWeekdays(row.rrule, row.dtstartLocal) || [], start: classTime(row.startMin), end: classTime((row.startMin || 0) + row.estMinutes) });
const weekly = (row: RecurrenceSeries, today: string) => row.kind === 'fixed' && row.layer === 'fixed' && (!row.until || row.until >= today) && !!classWeekdays(row.rrule, row.dtstartLocal);
function rowErrors(row: ClassDraft) {
  const start = parseClassTime(row.start), end = parseClassTime(row.end);
  return { course: !row.course.trim() || row.course.trim().length > 200, weekdays: !row.weekdays.length, start: start === null || start >= 1440,
    end: end === null || start === null || end <= start || end - start > 960, slot: row.slot.trim().length > 40 };
}
const payloadRows = (rows: ClassDraft[]) => rows.map(row => ({ ...(row.id ? { id: row.id, version: row.version } : {}), course: row.course.trim(), type: row.type, slot: row.slot.trim(), weekdays: row.weekdays, startMin: parseClassTime(row.start), estMinutes: (parseClassTime(row.end) ?? NaN) - (parseClassTime(row.start) ?? NaN) }));

export function Classes() {
  const series = useQuery({ queryKey: ['recurrence', 'series'], queryFn: () => apiList<RecurrenceSeries>('/recurrence/series') });
  return <div className="workspace-page classes-workspace">
    <PageHeader eyebrow="Plan · college" title="Your classes, one weekly sheet" description="Set up the semester once. Give each lecture or lab its own days and times." action={<Link className="button" to="/plan">Back to timetable</Link>} />
    {series.isPending ? <DelayedSkeleton height={280} /> : series.isError ? <Banner tone="error" action={<Button onClick={() => void series.refetch()}>Retry</Button>}>{errorMessage(series.error)}</Banner> : <ClassEditor series={series.data || []} />}
  </div>;
}

function ClassEditor({ series }: { series: RecurrenceSeries[] }) {
  const data = useData(), online = useOnline(), refresh = useRefresh(), { toast } = useUI();
  const available = series.filter(row => row.classDetails && weekly(row, data.studyDate));
  const covers = (row: RecurrenceSeries, date: string) => row.effectiveFrom <= date && (!row.until || row.until >= date);
  const reference = available.some(row => covers(row, data.studyDate)) ? data.studyDate : available.map(row => row.effectiveFrom).sort()[0] || data.studyDate;
  const initial = available.filter(row => covers(row, reference));
  const [rows, setRows] = useState<ClassDraft[]>(() => initial.map(fromSeries));
  const [removed, setRemoved] = useState<ClassDraft[]>([]), [requestId, setRequestId] = useState(() => newId()), [dirty, setDirty] = useState(false);
  const [startDate, setStartDate] = useState(() => initial.map(row => row.dtstartLocal).sort()[0] || data.studyDate);
  const [endDate, setEndDate] = useState(() => initial.flatMap(row => row.until ? [row.until] : []).sort().at(-1) || addDays(data.studyDate, 120));
  const [effectiveFrom, setEffectiveFrom] = useState(reference);
  const [pasteText, setPasteText] = useState(''), [preview, setPreview] = useState<PasteResult | null>(null), [previewRows, setPreviewRows] = useState<ClassDraft[]>([]);
  const [importIds, setImportIds] = useState<string[]>([]);
  const generic = series.filter(row => !row.classDetails && weekly(row, data.studyDate) && ![...rows, ...removed].some(draft => draft.id === row.id));
  const input = classTimetableSchema.safeParse({ requestId, startDate, endDate, effectiveFrom, rows: payloadRows(rows), removed: removed.filter(row => row.id).map(row => ({ id: row.id, version: row.version })) });
  const invalidRows = rows.flatMap((row, index) => Object.values(rowErrors(row)).some(Boolean) ? [index + 1] : []);
  const save = useMutation({ mutationFn: () => api<ClassTimetableResult>('/recurrence/classes', { method: 'POST', body: classTimetableSchema.parse({ requestId, startDate, endDate, effectiveFrom, rows: payloadRows(rows), removed: removed.filter(row => row.id).map(row => ({ id: row.id, version: row.version })) }) }),
    onSuccess: async result => { setRows(result.rows.map(fromSeries)); setRemoved([]); setDirty(false); setRequestId(newId()); await refresh(); toast('Weekly timetable saved. Meetings repeat through the semester.'); } });
  const changed = () => { setDirty(true); setRequestId(newId()); save.reset(); };
  const editRows = (next: ClassDraft[]) => { setRows(next); changed(); };
  const add = (type: 'lecture' | 'lab') => editRows([...rows, { key: newId(), course: '', type, slot: '', weekdays: [1], start: type === 'lab' ? '14:00' : '08:00', end: type === 'lab' ? '16:00' : '08:50' }]);
  const loadSaved = () => {
    const meetings = available.filter(row => covers(row, effectiveFrom));
    setRows(meetings.map(fromSeries)); setRemoved([]); setDirty(false); setRequestId(newId()); save.reset();
    if (meetings.length) { setStartDate(meetings.map(row => row.dtstartLocal).sort()[0]!); setEndDate(meetings.flatMap(row => row.until ? [row.until] : []).sort().at(-1) || endDate); }
  };
  const showPreview = (text: string) => { const parsed = parseTimetablePaste(text); setPreview(parsed); setPreviewRows(parsed.rows.map(row => ({ ...row, key: newId() }))); };
  return <div className="stack-lg">
    <Card className="stack-lg class-sheet">
      <div><h2>Semester timetable</h2><p className="caption">One row per meeting time. Select several days when they share the same time; use another row when the time differs.</p></div>
      <form className="stack-lg" onSubmit={event => { event.preventDefault(); if (input.success) save.mutate(); }}>
        <fieldset disabled={save.isPending} className="class-form-fields stack-lg">
          <div className="class-semester-fields">
            <Field id="class-semester-start" label="Semester starts" hint="New meetings begin on this date or the change date, whichever is later."><input className="input" id="class-semester-start" type="date" required value={startDate} onChange={event => { setStartDate(event.target.value); changed(); }} /></Field>
            <Field id="class-semester-end" label="Semester ends"><input className="input" id="class-semester-end" type="date" required min={startDate} value={endDate} onChange={event => { setEndDate(event.target.value); changed(); }} /></Field>
            <Field id="class-effective" label="Changes apply from" hint="Earlier meetings keep their history."><input className="input" id="class-effective" type="date" required min={data.studyDate} value={effectiveFrom} onChange={event => { setEffectiveFrom(event.target.value); changed(); }} /></Field>
          </div>
          {!!available.length && <div className="row wrap"><Button disabled={!effectiveFrom || effectiveFrom < data.studyDate} onClick={loadSaved}>Load saved meetings for this change date</Button><span className="caption">Replaces the rows in this sheet with the saved timetable for that date.</span></div>}
          <div className="row wrap"><Button onClick={() => add('lecture')} disabled={rows.length >= 100}><BookOpen size={17} /> Add lecture · 50 min</Button><Button onClick={() => add('lab')} disabled={rows.length >= 100}><FlaskConical size={17} /> Add lab · 2 hours</Button><span className="caption">Durations are editable.</span></div>
          {!!rows.length && <p className="caption">Scroll the sheet sideways to reach all days, times and row actions. Tab moves to the next cell.</p>}
          <MeetingGrid rows={rows} onChange={editRows} onRemove={row => { setRemoved([...removed, row]); editRows(rows.filter(item => item.key !== row.key)); }} onPaste={text => { setPasteText(text); showPreview(text); }} />
          {!rows.length && <p className="muted">Add your meetings above, or paste the timetable you compiled in Excel below.</p>}
          {!!removed.length && <div className="row wrap"><p className="caption">{removed.filter(row => row.id).length} saved meetings will stop repeating from the change date.</p><Button onClick={() => { editRows([...rows, ...removed]); setRemoved([]); }}>Restore removed rows</Button></div>}
          {!!invalidRows.length && <Banner tone="warning">Check course names, weekdays and start/end times in row{invalidRows.length > 1 ? 's' : ''} {invalidRows.join(', ')}.</Banner>}
          {!input.success && !invalidRows.length && (rows.length > 0 || removed.length > 0) && <Banner tone="warning">{input.error.issues[0]?.message}</Banner>}
          {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}
          {!online && <Banner>Your edits stay here while offline. Reconnect to save them.</Banner>}
          <div className="row between wrap"><p className="caption" role="status">{rows.length} meeting patterns · {new Set(rows.map(row => row.course.trim()).filter(Boolean)).size} {new Set(rows.map(row => row.course.trim()).filter(Boolean)).size === 1 ? 'course' : 'courses'}{dirty ? ' · unsaved changes' : ''}</p><Button type="submit" variant="primary" disabled={!online || !input.success || !dirty} loading={save.isPending}>Save weekly timetable</Button></div>
        </fieldset>
      </form>
      <details className="disclosure class-paste" open={!!preview}>
        <summary>Paste from Excel</summary>
        <div className="stack-lg">
          <p className="caption">Paste a weekly grid with Time, Mon, Tue… columns, or a list with Course, Type, Slot, Day, Start, End. Times may use 24-hour or AM/PM format.</p>
          <Field id="class-excel-paste" label="Timetable cells"><textarea id="class-excel-paste" className="input code-input" rows={5} value={pasteText} onChange={event => { setPasteText(event.target.value); setPreview(null); }} placeholder={'Course\tType\tSlot\tDay\tStart\tEnd\nNetworks\tLecture\tA1\tMon/Wed\t08:00\t08:50\nNetworks\tLab\tL2\tFri\t14:00\t16:30'} /></Field>
          <Button disabled={!pasteText.trim() || save.isPending} onClick={() => showPreview(pasteText)}>Preview pasted timetable</Button>
          {preview && <div className="stack-lg">
            <h3>Paste preview · {previewRows.length} meeting patterns</h3>
            {!!preview.issues.length && <Banner tone="warning"><ul className="class-import-issues">{preview.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></Banner>}
            <p className="caption">Check every end time, especially labs that used merged cells in Excel. Edit the preview before adding it to your sheet.</p>
            {!!previewRows.length && <MeetingGrid rows={previewRows} onChange={setPreviewRows} prefix="preview" onRemove={row => setPreviewRows(previewRows.filter(item => item.key !== row.key))} />}
            <Button disabled={save.isPending || !previewRows.length || rows.length + previewRows.length > 100 || previewRows.some(row => Object.values(rowErrors(row)).some(Boolean))} onClick={() => { editRows([...rows, ...previewRows]); setPreview(null); setPasteText(''); }}>Add preview to weekly sheet</Button>
          </div>}
        </div>
      </details>
      {!!generic.length && <details className="disclosure">
        <summary>Bring in existing weekly commitments</summary>
        <div className="stack">
          <p className="caption">Choose the class and lab meetings you already entered. They join this sheet when you save.</p>
          {generic.map(row => <label className="toggle-label" key={row.id}><input type="checkbox" checked={importIds.includes(row.id)} onChange={event => setImportIds(event.target.checked ? [...importIds, row.id] : importIds.filter(id => id !== row.id))} /><span>{row.title}<span className="caption"> · {classWeekdays(row.rrule, row.dtstartLocal)?.map(day => weekdays[day - 1]?.label).join(', ')} · {clockLabel(row.startMin || 0, data.user.settings.clockFormat)}–{clockLabel((row.startMin || 0) + row.estMinutes, data.user.settings.clockFormat)}</span></span></label>)}
          <Button disabled={!importIds.length || save.isPending || rows.length + importIds.length > 100} onClick={() => {
            const picked = generic.filter(row => importIds.includes(row.id));
            if (!rows.length && picked.length) { setStartDate(picked.map(row => row.dtstartLocal).sort()[0]!); setEndDate(picked.flatMap(row => row.until ? [row.until] : []).sort().at(-1) || endDate); }
            editRows([...rows, ...picked.map(fromSeries)]); setImportIds([]);
          }}>Add selected commitments to sheet</Button>
        </div>
      </details>}
    </Card>
    <ClassDayTools series={series} />
  </div>;
}

function MeetingGrid({ rows, onChange, onRemove, onPaste, prefix = 'meeting' }: { rows: ClassDraft[]; onChange: (rows: ClassDraft[]) => void; onRemove: (row: ClassDraft) => void; onPaste?: (text: string) => void; prefix?: string }) {
  const update = (key: string, patch: Partial<ClassDraft>) => onChange(rows.map(row => row.key === key ? { ...row, ...patch } : row));
  return <div className="class-grid-scroll" role="region" aria-label={prefix === 'preview' ? 'Editable paste preview' : 'Editable weekly meetings'} tabIndex={0} onPaste={event => { const text = event.clipboardData.getData('text/plain'); if (onPaste && (text.includes('\t') || text.includes('\n'))) { event.preventDefault(); onPaste(text); } }}>
    <table className="class-grid"><caption className="sr-only">Each row is a weekly meeting pattern. Tab moves between cells. Scroll horizontally to reach every column.</caption>
      <thead><tr><th scope="col">Course</th><th scope="col">Type</th><th scope="col">College slot</th><th scope="col">Weekdays</th><th scope="col">Start</th><th scope="col">End</th><th scope="col">Duration</th><th scope="col"><span className="sr-only">Row actions</span></th></tr></thead>
      <tbody>{rows.map((row, index) => { const errors = rowErrors(row), start = parseClassTime(row.start), end = parseClassTime(row.end), label = `${prefix} ${index + 1}`; return <tr key={row.key} data-class-type={row.type}>
        <td><input className="input" aria-label={`Course, ${label}`} required maxLength={200} value={row.course} aria-invalid={errors.course || undefined} onChange={event => update(row.key, { course: event.target.value })} /></td>
        <td><Field id={`${prefix}-${row.key}-type`} label={`Type, ${label}`}><select className="input" id={`${prefix}-${row.key}-type`} value={row.type} onChange={event => update(row.key, { type: event.target.value as ClassDraft['type'] })}><option value="lecture">Lecture</option><option value="lab">Lab</option></select></Field></td>
        <td><input className="input" aria-label={`College slot, ${label}`} maxLength={40} placeholder="A1 / L2" value={row.slot} onChange={event => update(row.key, { slot: event.target.value })} /></td>
        <td><fieldset className="class-weekdays" aria-invalid={errors.weekdays || undefined}><legend className="sr-only">Weekdays, {label}</legend>{weekdays.map(day => <label key={day.value} title={fullDays[day.value - 1]}><input type="checkbox" aria-label={`${fullDays[day.value - 1]}, ${label}`} checked={row.weekdays.includes(day.value)} onChange={event => update(row.key, { weekdays: (event.target.checked ? [...row.weekdays, day.value] : row.weekdays.filter(value => value !== day.value)).sort((a, b) => a - b) })} /><span>{day.label}</span></label>)}</fieldset></td>
        <td><input className="input class-time-cell" aria-label={`Start time, ${label}`} placeholder="08:00" inputMode="text" required value={row.start} aria-invalid={errors.start || undefined} onChange={event => update(row.key, { start: event.target.value })} onBlur={() => { if (start !== null) update(row.key, { start: classTime(start) }); }} /></td>
        <td><input className="input class-time-cell" aria-label={`End time, ${label}`} placeholder="08:50" inputMode="text" required value={row.end} aria-invalid={errors.end || undefined} onChange={event => update(row.key, { end: event.target.value })} onBlur={() => { if (end !== null) update(row.key, { end: classTime(end) }); }} /></td>
        <td className="class-duration">{start !== null && end !== null && end > start ? duration(end - start) : '—'}</td>
        <td><div className="row"><IconButton label={`Add another time for ${row.course || label}`} disabled={rows.length >= 100} onClick={() => { const nextDay = weekdays.find(day => !row.weekdays.includes(day.value))?.value || 1; onChange([...rows, { ...row, key: newId(), id: undefined, version: undefined, weekdays: [nextDay] }]); }}><Copy size={17} /></IconButton><IconButton label={`Remove ${label}`} onClick={() => onRemove(row)}><Trash2 size={17} /></IconButton></div></td>
      </tr>; })}</tbody>
    </table>
  </div>;
}

function ClassDayTools({ series }: { series: RecurrenceSeries[] }) {
  const data = useData(), online = useOnline(), refresh = useRefresh(), { toast } = useUI();
  const [date, setDate] = useState(data.studyDate), [day, setDay] = useState(1), [requestId, setRequestId] = useState(() => newId());
  const occurrences = useQuery({ queryKey: ['recurrence', 'classes-day', date], queryFn: () => apiList<Occurrence>(`/recurrence/occurrences?from=${date}&to=${date}`), enabled: !!date });
  const makeup = useQuery({ queryKey: ['recurrence', 'makeup-day', date], queryFn: () => api<ClassDayPreview>(`/recurrence/classes/day?date=${date}`), enabled: !!date });
  const saved = series.filter(row => row.classDetails && row.effectiveFrom <= date && (!row.until || row.until >= date) && !(row.status === 'paused' && !row.pausedRanges.length) && !row.pausedRanges.some(range => range.start <= date && (!range.end || range.end >= date)));
  const source = saved.filter(row => classWeekdays(row.rrule, row.dtstartLocal)?.includes(day));
  const target = (occurrences.data || []).filter(row => row.series.classDetails && row.status !== 'suppressed' && !row.slot?.archivedAt);
  const targetMeetings = [...target.map(row => ({ id: row.id, title: row.fields.title })), ...(makeup.data?.meetings || [])];
  const apply = useMutation({ mutationFn: () => api<ClassDayResult>('/recurrence/classes/day', { method: 'POST', body: { requestId, date, weekday: day } }), onSuccess: async result => { setRequestId(newId()); await refresh(); toast(`${calendarDate(result.date)} now follows ${fullDays[result.weekday - 1]}: ${result.added} ${result.added === 1 ? 'meeting' : 'meetings'} applied.`); } });
  const change = () => { setRequestId(newId()); apply.reset(); };
  return <Card className="stack-lg">
    <div><h2>A college makeup day</h2><p className="caption">When college announces “Saturday follows Monday”, replace that date’s classes and labs in one step.</p></div>
    <form className="stack-lg" onSubmit={event => { event.preventDefault(); apply.mutate(); }}>
      <div className="grid-2">
        <Field id="class-day-date" label="College day to replace"><input className="input" id="class-day-date" type="date" required min={data.studyDate} disabled={apply.isPending} value={date} onChange={event => { setDate(event.target.value); change(); }} /></Field>
        <Field id="class-day-weekday" label="Follow this weekday"><select className="input" id="class-day-weekday" disabled={apply.isPending} value={day} onChange={event => { setDay(Number(event.target.value)); change(); }}>{fullDays.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</select></Field>
      </div>
      {!!source.length && <div className="class-day-preview grid-2"><div><h3>{fullDays[day - 1]} meetings to add</h3><ul>{source.map(row => <li key={row.id}><strong>{row.title}</strong><span className="caption">{row.classDetails?.type === 'lab' ? 'Lab' : 'Lecture'} · {clockLabel(row.startMin || 0, data.user.settings.clockFormat)}–{clockLabel((row.startMin || 0) + row.estMinutes, data.user.settings.clockFormat)}</span></li>)}</ul></div><div><h3>Classes on {calendarDate(date)}</h3>{makeup.data?.weekday && <p className="caption">Currently follows {fullDays[makeup.data.weekday - 1]}.</p>}{occurrences.isPending || makeup.isPending ? <DelayedSkeleton height={70} /> : occurrences.isError || makeup.isError ? <Banner tone="error">{errorMessage(occurrences.error || makeup.error)}</Banner> : targetMeetings.length ? <ul>{targetMeetings.map(row => <li key={row.id}>{row.title}</li>)}</ul> : <p className="caption">No regular classes on this date.</p>}</div></div>}
      {!source.length && <p className="caption">Save a weekly timetable with {fullDays[day - 1]} meetings to use this tool.</p>}
      {apply.isError && <Banner tone="error">{errorMessage(apply.error)}</Banner>}
      {apply.isSuccess && <p role="status">{calendarDate(date)} follows {fullDays[day - 1]} · {apply.data.added} {apply.data.added === 1 ? 'meeting' : 'meetings'} applied.</p>}
      <Button variant="primary" type="submit" disabled={!online || !date || date < data.studyDate || !source.length || occurrences.isPending || occurrences.isError || makeup.isPending || makeup.isError} loading={apply.isPending}>Apply college day</Button>
    </form>
  </Card>;
}
