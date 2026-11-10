import { Link } from 'react-router-dom';
import { v7 as newId } from 'uuid';
import { Trash2 } from 'lucide-react';
import type { CollegeSlotTemplate } from '@kram/shared';
import { Banner, Button, Field, IconButton } from '../../components/ui/kit';
import { clockLabel, weekdays } from '../../shared/format';
import { useData } from '../../shared/data';
import { classTime, parseClassTime, type ClassDraft } from './classPaste';
import { assignSlot, courseGroups } from './collegeSlots';

export function SlotCourses({ rows, templates, selectedTemplate, onChange, onReplace }: {
  rows: ClassDraft[]; templates: CollegeSlotTemplate[]; selectedTemplate?: CollegeSlotTemplate;
  onChange: (rows: ClassDraft[]) => void; onReplace: (previous: ClassDraft[], next: ClassDraft[]) => void;
}) {
  const data = useData(), format = data.user.settings.clockFormat;
  const groups = courseGroups(rows), choices = [...new Set(selectedTemplate?.periods.map(row => row.group))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const update = (key: string, patch: Partial<ClassDraft>) => onChange(rows.map(row => row.key === key ? { ...row, ...patch } : row));
  const time = (row: ClassDraft) => `${row.weekdays.map(day => weekdays[day - 1]?.label).join(', ')} · ${parseClassTime(row.start) === null ? row.start : clockLabel(parseClassTime(row.start)!, format)}–${parseClassTime(row.end) === null ? row.end : clockLabel(parseClassTime(row.end)!, format)}`;
  return <div className="stack-lg slot-courses">
    <div className="row between wrap"><div><h3>Courses by slot</h3><p className="caption">Enter each course once. Uncheck meetings you don’t have; change a meeting for a recurring exception.</p></div>
      <Button disabled={!selectedTemplate || !choices.length || rows.length + (selectedTemplate?.periods.filter(row => row.group === choices[0]).length || 0) > 100} onClick={() => { if (selectedTemplate && choices[0]) onChange([...rows, ...assignSlot(selectedTemplate, choices[0])]); }}>Assign course to slot</Button>
    </div>
    {!selectedTemplate && <p className="caption">Save a semester slot grid above to start assigning courses.</p>}
    {groups.map((group, index) => {
      const first = group[0]!, assignment = first.assignment!, template = templates.find(item => item.id === assignment.templateId);
      const label = `course assignment ${index + 1}`, count = group.filter(row => !row.disabled).reduce((sum, row) => sum + row.weekdays.length, 0);
      const templateGroups = [...new Set(template?.periods.map(row => row.group))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const ordered = [...group].sort((a, b) => {
        const left = template?.periods.find(period => period.id === a.assignment!.meetingId)?.label;
        const right = template?.periods.find(period => period.id === b.assignment!.meetingId)?.label;
        return left && right ? left.localeCompare(right, undefined, { numeric: true }) : left ? -1 : right ? 1 : 0;
      });
      return <section className="slot-course stack" key={assignment.id} aria-label={first.course || label}>
        <div className="slot-course-heading">
          <Field id={`course-${assignment.id}`} label="Course"><input className="input" aria-label={`Course, ${label}`} id={`course-${assignment.id}`} placeholder="Networks · CS313" required maxLength={200} value={first.course} onChange={event => onChange(rows.map(row => row.assignment?.id === assignment.id ? { ...row, course: event.target.value } : row))} /></Field>
          <Field id={`group-${assignment.id}`} label="Slot"><select className="input" aria-label={`Slot, ${label}`} id={`group-${assignment.id}`} value={assignment.group} onChange={event => { if (template) onReplace(group, assignSlot(template, event.target.value, first.course, assignment.id)); }}>
            {!templateGroups.includes(assignment.group) && <option value={assignment.group}>{assignment.group}</option>}
            {templateGroups.map(value => <option key={value} value={value}>{value}</option>)}
          </select></Field>
          <IconButton label={`Remove ${first.course || label}`} onClick={() => onReplace(group, [])}><Trash2 size={18} /></IconButton>
        </div>
        <p className="caption">{template?.name || 'Saved slot grid'} · {count} {count === 1 ? 'class' : 'classes'} / week</p>
        <p className="caption">{group.filter(row => !row.disabled).map(row => `${row.slot || 'Extra'}: ${time(row)}`).join(' · ')}</p>
        {!count && <Banner tone="warning">Select at least one meeting, or remove this course assignment.</Banner>}
        <details className="disclosure">
          <summary>Customize meetings · {first.course || assignment.group}</summary>
          <div className="stack">
            {ordered.map((row, meetingIndex) => {
              const original = template?.periods.find(period => period.id === row.assignment!.meetingId), meeting = original?.label || `Extra ${meetingIndex + 1}`;
              const selected = template?.periods.find(period => period.label === row.slot && row.weekdays.length === 1 && period.weekday === row.weekdays[0] && period.startMin === parseClassTime(row.start) && period.startMin + period.estMinutes === parseClassTime(row.end));
              const accessible = `${meeting}, ${first.course || label}`;
              return <div className="slot-course-meeting stack" key={row.key}>
                <div className="row between wrap"><label className="toggle-label"><input type="checkbox" aria-label={`Include ${accessible}`} checked={!row.disabled} onChange={event => update(row.key, { disabled: !event.target.checked })} /><span><strong>{meeting}</strong>{original?.optional && <span className="caption"> · optional</span>}<span className="slot-meeting-time caption">{row.slot !== meeting ? `${row.slot || 'Custom'} · ` : ''}{time(row)}</span></span></label></div>
                {!row.disabled && <details className="disclosure slot-meeting-edit"><summary>Change time · {meeting}</summary><div className="stack">
                  <Field id={`period-${row.key}`} label={`Use slot time, ${accessible}`}><select className="input" id={`period-${row.key}`} value={selected?.id || 'custom'} onChange={event => {
                    const period = template?.periods.find(item => item.id === event.target.value);
                    update(row.key, period ? { slot: period.label, weekdays: [period.weekday], start: classTime(period.startMin), end: classTime(period.startMin + period.estMinutes) } : { slot: '' });
                  }}><option value="custom">Custom day and time</option>{template?.periods.map(period => <option key={period.id} value={period.id}>{period.label} · {weekdays[period.weekday - 1]?.label} {clockLabel(period.startMin, format)}–{clockLabel(period.startMin + period.estMinutes, format)}</option>)}</select></Field>
                  <div className="slot-meeting-fields">
                    <Field id={`day-${row.key}`} label={`Day, ${accessible}`}><select className="input" id={`day-${row.key}`} value={row.weekdays[0]} onChange={event => update(row.key, { weekdays: [Number(event.target.value)] })}>{weekdays.map(day => <option key={day.value} value={day.value}>{day.label}</option>)}</select></Field>
                    <Field id={`start-${row.key}`} label={`Start, ${accessible}`}><input className="input" id={`start-${row.key}`} required value={row.start} onChange={event => update(row.key, { start: event.target.value })} /></Field>
                    <Field id={`end-${row.key}`} label={`End, ${accessible}`}><input className="input" id={`end-${row.key}`} required value={row.end} onChange={event => update(row.key, { end: event.target.value })} /></Field>
                  </div>
                  <div className="grid-2"><Field id={`label-${row.key}`} label={`Meeting label, ${accessible}`}><input className="input" id={`label-${row.key}`} maxLength={40} placeholder="FS / custom" value={row.slot} onChange={event => update(row.key, { slot: event.target.value })} /></Field><Field id={`type-${row.key}`} label={`Type, ${accessible}`}><select className="input" id={`type-${row.key}`} value={row.type} onChange={event => update(row.key, { type: event.target.value as ClassDraft['type'] })}><option value="lecture">Lecture</option><option value="lab">Lab</option></select></Field></div>
                </div></details>}
              </div>;
            })}
            <div className="row wrap"><Button disabled={rows.length >= 100} onClick={() => onChange([...rows, { key: newId(), course: first.course, type: 'lecture', slot: 'Extra', weekdays: [1], start: '17:00', end: '17:50', assignment: { ...assignment, meetingId: newId() } }])}>Add extra weekly meeting</Button>
              {template && <Button disabled={rows.length - group.length + template.periods.filter(row => row.group === assignment.group).length > 100 || !templateGroups.includes(assignment.group)} onClick={() => onReplace(group, assignSlot(template, assignment.group, first.course, assignment.id))}>Reset to slot grid</Button>}
            </div>
            <p className="caption">Reset restores this grid’s defaults and removes this course’s weekly adjustments from the draft.</p>
          </div>
        </details>
        {group.some(row => row.id) && <Link className="text-link" to={`/schedules?seriesId=${encodeURIComponent(`course:${encodeURIComponent(first.course)}`)}`}>Move or skip a class on one date</Link>}
      </section>;
    })}
  </div>;
}
