import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { v7 as newId } from 'uuid';
import { collegeSlotTemplateSchema, type CollegeSlotTemplate } from '@kram/shared';
import { Banner, Button, Field, IconButton } from '../../components/ui/kit';
import { Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../shared/api';
import { useOnline, useRefresh } from '../../shared/data';
import { useUI } from '../../shared/ui';
import { weekdays } from '../../shared/format';
import { parseSlotGrid, periodDraft, periodPayload, type PeriodDraft } from './collegeSlots';

export function SlotGridEditor({ template, copy = false, onSaved }: { template?: CollegeSlotTemplate; copy?: boolean; onSaved: (template: CollegeSlotTemplate) => void }) {
  const online = useOnline(), refresh = useRefresh(), { toast } = useUI();
  const [id] = useState(() => copy ? newId() : template?.id || newId()), [version, setVersion] = useState(copy ? undefined : template?.version);
  const [name, setName] = useState(template ? `${template.name}${copy ? ' · copy' : ''}` : ''), [periods, setPeriods] = useState<PeriodDraft[]>(() => template?.periods.map(period => periodDraft(copy ? { ...period, id: newId() } : period)) || []);
  const [paste, setPaste] = useState(''), [issues, setIssues] = useState<string[]>([]), [dirty, setDirty] = useState(copy);
  const input = collegeSlotTemplateSchema.safeParse({ id, version, name, periods: periods.map(periodPayload) });
  const save = useMutation({ mutationFn: () => api<CollegeSlotTemplate>('/recurrence/college-slots', { method: 'POST', body: collegeSlotTemplateSchema.parse({ id, version, name, periods: periods.map(periodPayload) }) }),
    onSuccess: async result => { setVersion(result.version); setDirty(false); await refresh(); onSaved(result); toast('Slot grid saved. Assign your courses below.'); } });
  const change = () => { setDirty(true); save.reset(); };
  const update = (id: string, patch: Partial<PeriodDraft>) => { setPeriods(periods.map(row => row.id === id ? { ...row, ...patch } : row)); change(); };
  return <form className="stack-lg" onSubmit={event => { event.preventDefault(); if (input.success) save.mutate(); }}>
    <fieldset className="class-form-fields stack-lg" disabled={save.isPending}>
      <Field id="slot-grid-name" label="Slot grid name" hint="For example, Semester 5 · Non-IC. Create a new grid when next semester’s layout changes."><input className="input" id="slot-grid-name" required maxLength={100} value={name} onChange={event => { setName(event.target.value); change(); }} /></Field>
      <details className="disclosure" open={!periods.length || undefined}>
        <summary>Paste the college slot grid</summary>
        <div className="stack">
          <p className="caption">Copy the header and weekday rows from Excel: Days down the left and time ranges across the top. A list with Group, Meeting, Day, Start, End also works. Shared cells such as F4/FS/NS become separate choices.</p>
          <Field id="slot-grid-paste" label="Slot grid cells"><textarea className="input code-input" id="slot-grid-paste" rows={5} value={paste} onChange={event => setPaste(event.target.value)} placeholder={'Days\t09:00-09:50 AM\t02:00-04:00 PM\nMonday\tX1\tLab-A\nTuesday\tY1\t'} /></Field>
          <Button disabled={!paste.trim()} onClick={() => { const parsed = parseSlotGrid(paste); setIssues(parsed.issues); if (parsed.periods.length) { setPeriods(parsed.periods); change(); } }}>Preview slot grid</Button>
        </div>
      </details>
      {!!issues.length && <Banner tone="warning"><ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></Banner>}
      {!!periods.length && <>
        <p className="caption">Review the preview before saving. Group is the course’s slot (such as F); meeting is one occurrence (such as F1). Optional meetings start unchecked. Check AM/PM, shared slots and lab durations.</p>
        <div className="class-grid-scroll" role="region" aria-label="Slot grid preview" tabIndex={0}>
          <table className="class-grid slot-definition-grid"><caption className="sr-only">Editable semester slot definitions</caption>
            <thead><tr>{['Group', 'Meeting', 'Day', 'Start', 'End', 'Type', 'Optional', ''].map((label, index) => <th scope="col" key={index}>{label || <span className="sr-only">Remove</span>}</th>)}</tr></thead>
            <tbody>{periods.map((row, index) => { const label = `slot definition ${index + 1}`; return <tr key={row.id}>
              <td><input className="input" aria-label={`Group, ${label}`} value={row.group} required maxLength={40} onChange={event => update(row.id, { group: event.target.value })} /></td>
              <td><input className="input" aria-label={`Meeting, ${label}`} value={row.label} required maxLength={40} onChange={event => update(row.id, { label: event.target.value })} /></td>
              <td><Field id={`slot-day-${row.id}`} label={`Day, ${label}`}><select className="input" id={`slot-day-${row.id}`} value={row.weekday} onChange={event => update(row.id, { weekday: Number(event.target.value) })}>{weekdays.map(day => <option key={day.value} value={day.value}>{day.label}</option>)}</select></Field></td>
              <td><input className="input class-time-cell" aria-label={`Start, ${label}`} required value={row.start} onChange={event => update(row.id, { start: event.target.value })} /></td>
              <td><input className="input class-time-cell" aria-label={`End, ${label}`} required value={row.end} onChange={event => update(row.id, { end: event.target.value })} /></td>
              <td><Field id={`slot-type-${row.id}`} label={`Type, ${label}`}><select className="input" id={`slot-type-${row.id}`} value={row.type} onChange={event => update(row.id, { type: event.target.value as PeriodDraft['type'] })}><option value="lecture">Lecture</option><option value="lab">Lab</option></select></Field></td>
              <td><label className="toggle-label"><input type="checkbox" aria-label={`Optional, ${label}`} checked={row.optional} onChange={event => update(row.id, { optional: event.target.checked })} /><span>Optional</span></label></td>
              <td><IconButton label={`Remove ${label}`} onClick={() => { setPeriods(periods.filter(item => item.id !== row.id)); change(); }}><Trash2 size={17} /></IconButton></td>
            </tr>; })}</tbody>
          </table>
        </div>
      </>}
      <Button disabled={periods.length >= 200} onClick={() => { setPeriods([...periods, { id: newId(), group: '', label: '', weekday: 1, start: '09:00', end: '09:50', type: 'lecture', optional: false }]); change(); }}>Add slot meeting</Button>
      {!input.success && periods.length > 0 && <Banner tone="warning">{input.error.issues[0]?.message}</Banner>}
      {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}
      {template && <p className="caption">Saving this grid leaves already assigned class times in place. Use “Reset to slot grid” on a course to adopt updated definitions.</p>}
      <Button type="submit" variant="primary" disabled={!online || !input.success || !dirty} loading={save.isPending}>Save slot grid</Button>
    </fieldset>
  </form>;
}
