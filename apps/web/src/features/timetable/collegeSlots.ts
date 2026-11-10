import { v7 as newId } from 'uuid';
import type { CollegePeriod, CollegeSlotTemplate } from '@kram/shared';
import { classTime, parseClassDays, parseClassTime, timetableCells, type ClassDraft } from './classPaste';

export type PeriodDraft = Omit<CollegePeriod, 'startMin' | 'estMinutes'> & { start: string; end: string };
export const periodDraft = (period: CollegePeriod): PeriodDraft => ({ ...period, start: classTime(period.startMin), end: classTime(period.startMin + period.estMinutes) });
export const periodPayload = (period: PeriodDraft) => ({ id: period.id, group: period.group.trim(), label: period.label.trim(), weekday: period.weekday, type: period.type, optional: period.optional, startMin: parseClassTime(period.start), estMinutes: (parseClassTime(period.end) ?? NaN) - (parseClassTime(period.start) ?? NaN) });
const heading = (text: string) => text.toLowerCase().replace(/[\s_/-]/g, '');
function clockRange(text: string) {
  const parts = text.split(/\s*(?:-|–|—|\bto\b)\s*/i);
  let start = parts[0] || '';
  const end = parts[1] || '', suffix = end.match(/(am|pm)$/i)?.[1];
  if (suffix && !/(am|pm)$/i.test(start) && Number(start.split(/[:.]/)[0]) <= 12) start += ` ${suffix}`;
  return { start: classTime(parseClassTime(start)), end: classTime(parseClassTime(end)) };
}

/** Slot definitions are input data. No institution's weekly layout is built into the editor. */
export function parseSlotGrid(text: string): { periods: PeriodDraft[]; issues: string[] } {
  const result: { periods: PeriodDraft[]; issues: string[] } = { periods: [], issues: [] };
  if (text.length > 128000) return { ...result, issues: ['Paste up to 200 slot meetings at a time.'] };
  let table: string[][];
  try { table = timetableCells(text.replace(/^\uFEFF/, '')); } catch (error) { return { ...result, issues: [(error as Error).message] }; }
  const headerIndex = table.findIndex(row => row.some(cell => ['day', 'days', 'weekday'].includes(heading(cell))));
  if (headerIndex < 0) return { ...result, issues: ['Include a Days column with time ranges across the top, or Group, Meeting, Day, Start, End columns.'] };
  const headers = table[headerIndex]!.map(heading), dayColumn = headers.findIndex(value => ['day', 'days', 'weekday'].includes(value));
  const groupColumn = headers.indexOf('group'), startColumn = headers.indexOf('start'), endColumn = headers.indexOf('end');
  const add = (label: string, weekday: number, times: { start: string; end: string }, fields?: Partial<PeriodDraft>) => {
    const lab = /^L\d+$/i.test(label);
    const group = lab ? label : label.replace(/\d+$/, '') || label;
    result.periods.push({ id: newId(), label, group, weekday, type: lab ? 'lab' : 'lecture', optional: !lab && (Number(label.match(/\d+$/)?.[0]) > 3 || /^(FS|NS)$/i.test(group)), ...times, ...fields });
  };
  for (const [index, values] of table.slice(headerIndex + 1).entries()) {
    const days = parseClassDays(values[dayColumn] || '');
    if (days.length !== 1) { result.issues.push(`Row ${headerIndex + index + 2}: use one weekday per row.`); continue; }
    const day = days[0]!;
    if (groupColumn >= 0 && startColumn >= 0 && endColumn >= 0) {
      const label = values[headers.indexOf('meeting')] || values[headers.indexOf('label')] || values[groupColumn] || '';
      const optional = values[headers.indexOf('optional')]?.trim().toLowerCase();
      add(label, day, { start: values[startColumn] || '', end: values[endColumn] || '' }, {
        group: values[groupColumn] || '',
        ...(headers.includes('type') ? { type: /^lab$/i.test(values[headers.indexOf('type')] || '') ? 'lab' : 'lecture' } : {}),
        ...(optional ? { optional: ['yes', 'true', '1'].includes(optional) } : {}),
      });
    } else {
      for (const [column, value] of values.entries()) {
        if (column === dayColumn || !value || /^(-+|lunch|break|free)$/i.test(value)) continue;
        for (const label of value.split(/\s*[/,]\s*/).filter(Boolean)) add(label, day, clockRange(table[headerIndex]![column] || ''));
      }
    }
  }
  // Shared FS/NS and unnumbered labels need a distinct identity for each time.
  const counts = new Map<string, number>();
  for (const row of result.periods) counts.set(`${row.group}:${row.label}`, (counts.get(`${row.group}:${row.label}`) || 0) + 1);
  for (const row of result.periods) if (counts.get(`${row.group}:${row.label}`)! > 1) row.label += ` ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][row.weekday - 1]} ${row.start}`;
  if (result.periods.some(row => parseClassTime(row.start) === null || parseClassTime(row.end) === null || (parseClassTime(row.end) ?? 0) <= (parseClassTime(row.start) ?? 0))) result.issues.push('Some time ranges are incomplete. Correct them in the preview.');
  if (result.periods.length > 200) return { periods: [], issues: ['Paste up to 200 slot meetings at a time.'] };
  if (!result.periods.length) result.issues.push('No slot meetings found. Include the header and weekday rows.');
  return result;
}

export function assignSlot(template: CollegeSlotTemplate, group: string, course = '', assignmentId = newId()): ClassDraft[] {
  return template.periods.filter(period => period.group === group).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })).map(period => ({
    key: newId(), course, type: period.type, slot: period.label, weekdays: [period.weekday],
    start: classTime(period.startMin), end: classTime(period.startMin + period.estMinutes), disabled: period.optional,
    assignment: { id: assignmentId, templateId: template.id, group, meetingId: period.id },
  }));
}
export function courseGroups(rows: ClassDraft[]) {
  const groups = new Map<string, ClassDraft[]>();
  for (const row of rows) if (row.assignment) groups.set(row.assignment.id, [...(groups.get(row.assignment.id) || []), row]);
  return [...groups.values()];
}
/** Missing template meetings are unchecked, never silently reintroduced on reload. */
export function restoreSlotDrafts(rows: ClassDraft[], templates: CollegeSlotTemplate[]): ClassDraft[] {
  const restored = [...rows];
  for (const group of courseGroups(rows)) {
    const first = group[0]!, assignment = first.assignment!, template = templates.find(item => item.id === assignment.templateId);
    if (!template) continue;
    for (const candidate of assignSlot(template, assignment.group, first.course, assignment.id)) {
      if (!group.some(row => row.assignment!.meetingId === candidate.assignment!.meetingId)) restored.push({ ...candidate, disabled: true });
    }
  }
  return restored;
}
