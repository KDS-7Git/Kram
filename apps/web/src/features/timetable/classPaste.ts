import type { RecurrenceSeries } from '@kram/shared';
export type ClassDraft = { key: string; id?: string; version?: number; course: string; type: 'lecture' | 'lab'; slot: string; weekdays: number[]; start: string; end: string; assignment?: NonNullable<RecurrenceSeries['classDetails']>['assignment']; disabled?: boolean };
export type PastedMeeting = Omit<ClassDraft, 'key' | 'id' | 'version'>;
export type PasteResult = { rows: PastedMeeting[]; issues: string[]; format: 'list' | 'grid' };

const fullDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const dayCodes = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
function dayNumber(value: string) {
  const name = value.trim().toLowerCase().replace(/\.$/, '');
  return fullDays.findIndex((day, index) => day === name || day.slice(0, 3) === name || dayCodes[index] === name) + 1 || (/^[1-7]$/.test(name) ? Number(name) : 0);
}
export function parseClassDays(value: string): number[] {
  const parts = value.trim().split(/\s*[,;/&+]\s*|\s+/).filter(Boolean);
  const days = parts.map(dayNumber);
  return days.length && days.every(Boolean) ? [...new Set(days)].sort((a, b) => a - b) : [];
}
export function parseClassTime(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (/^0\.\d+$/.test(text)) return Math.min(1439, Math.round(Number(text) * 1440));
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]); const minute = Number(match[2] || 0), suffix = match[3];
  if (minute > 59 || (suffix ? hour < 1 || hour > 12 : hour > 24 || hour === 24 && minute !== 0)) return null;
  if (suffix) hour = hour % 12 + (suffix === 'pm' ? 12 : 0);
  return hour * 60 + minute;
}
export function classTime(minute: number | null) {
  return minute === null ? '' : `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
/** Excel clipboard TSV and CSV, including quoted multiline cells and escaped quotes. */
export function timetableCells(text: string): string[][] {
  const delimiter = text.includes('\t') ? '\t' : ',';
  const result: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else if (quoted || !cell.length) quoted = !quoted;
      else cell += char;
    } else if (!quoted && (char === delimiter || char === '\n' || char === '\r')) {
      row.push(cell.trim()); cell = '';
      if (char !== delimiter) {
        result.push(row); row = [];
        if (char === '\r' && text[index + 1] === '\n') index++;
      }
    } else cell += char;
  }
  if (quoted) throw new Error('A quoted cell is unfinished. Copy the complete range from Excel.');
  row.push(cell.trim()); result.push(row);
  return result.filter(values => values.some(Boolean));
}
const heading = (value: string) => value.toLowerCase().replace(/[\s_()/-]/g, '');
function typeOf(value: string, course: string, issues: string[], number: number): 'lecture' | 'lab' {
  const type = value.trim().toLowerCase();
  if (['lab', 'laboratory', 'practical'].includes(type) || !type && /\b(lab|laboratory|practical)\b/i.test(course)) return 'lab';
  if (type && !['lecture', 'class', 'theory'].includes(type)) issues.push(`Row ${number}: choose Lecture or Lab in the preview.`);
  return 'lecture';
}
function checkTimes(start: string, end: string, issues: string[], number: number) {
  const from = parseClassTime(start), to = parseClassTime(end);
  if (from === null || to === null || from >= 1440 || to <= from || to - from > 960) issues.push(`Row ${number}: enter a start and end time within the same day.`);
  return { start: classTime(from), end: classTime(to) };
}
export function parseTimetablePaste(text: string): PasteResult {
  const result: PasteResult = { rows: [], issues: [], format: 'list' };
  if (text.length > 128000) { result.issues.push('Paste a smaller range, up to 100 meetings.'); return result; }
  let table: string[][];
  try { table = timetableCells(text.replace(/^\uFEFF/, '')); } catch (error) { result.issues.push((error as Error).message); return result; }
  if (!table.length) { result.issues.push('Copy some timetable cells from Excel first.'); return result; }
  const headers = table[0]!.map(heading), days = table[0]!.map(dayNumber);
  if (days.filter(Boolean).length >= 2) {
    result.format = 'grid';
    const timeColumn = headers.findIndex(value => ['time', 'timing', 'timings', 'timeday', 'timedays'].includes(value));
    const startColumn = headers.findIndex(value => ['start', 'starttime', 'from'].includes(value));
    const endColumn = headers.findIndex(value => ['end', 'endtime', 'to'].includes(value));
    if (timeColumn < 0 && startColumn < 0) { result.issues.push('The weekly grid needs a Time column, or Start and End columns.'); return result; }
    for (const [index, values] of table.slice(1).entries()) {
      const number = index + 2;
      const range = timeColumn >= 0 ? (values[timeColumn] || '').split(/\s*(?:-|–|—|\bto\b)\s*/i) : [values[startColumn] || '', values[endColumn] || ''];
      for (const [column, day] of days.entries()) {
        const course = (values[column] || '').replace(/\s*\n\s*/g, ' ').trim();
        if (!day || !course || /^(-+|free|break|lunch)$/i.test(course)) continue;
        const times = checkTimes(range[0] || '', range[1] || '', result.issues, number);
        const type = typeOf('', course, result.issues, number);
        if (type === 'lab') result.issues.push(`Row ${number}: check the lab’s end time; blank or merged Excel cells do not show its full duration.`);
        result.rows.push({ course, type, slot: '', weekdays: [day], ...times });
      }
    }
  } else {
    const aliases: Record<string, string[]> = { course: ['course', 'coursename', 'subject', 'subjectname'], type: ['type', 'kind'], slot: ['slot', 'collegeslot'], days: ['day', 'days', 'weekday', 'weekdays'], start: ['start', 'starttime', 'from'], end: ['end', 'endtime', 'to'], duration: ['duration', 'durationmin', 'minutes'] };
    const columns = Object.fromEntries(Object.entries(aliases).map(([name, names]) => [name, headers.findIndex(header => names.includes(header))])) as Record<string, number>;
    const hasHeader = columns.course! >= 0 && columns.days! >= 0;
    for (const [index, values] of (hasHeader ? table.slice(1) : table).entries()) {
      const number = index + (hasHeader ? 2 : 1);
      if (!hasHeader && values.length < 6) { result.issues.push(`Row ${number}: use Course, Type, Slot, Day, Start, End columns.`); return { ...result, rows: [] }; }
      const get = (name: string, fallback: number) => values[hasHeader ? columns[name]! : fallback] || '';
      const course = get('course', 0), weekdays = parseClassDays(get('days', 3)), rawStart = get('start', 4), rawEnd = get('end', 5);
      let end = rawEnd;
      if (!end && hasHeader && columns.duration! >= 0) {
        const from = parseClassTime(rawStart), duration = Number(get('duration', -1));
        if (from !== null && Number.isInteger(duration) && duration > 0) end = classTime(from + duration);
      }
      if (!weekdays.length) result.issues.push(`Row ${number}: choose its weekdays in the preview.`);
      if (!course) result.issues.push(`Row ${number}: enter the course name in the preview.`);
      result.rows.push({ course, type: typeOf(get('type', 1), course, result.issues, number), slot: get('slot', 2), weekdays, ...checkTimes(rawStart, end, result.issues, number) });
    }
  }
  // Identical times on different days are one editable meeting pattern.
  const merged = new Map<string, PastedMeeting>();
  for (const row of result.rows) {
    const key = JSON.stringify([row.course, row.type, row.slot, row.start, row.end]), prior = merged.get(key);
    if (prior) prior.weekdays = [...new Set([...prior.weekdays, ...row.weekdays])].sort((a, b) => a - b);
    else merged.set(key, { ...row });
  }
  result.rows = [...merged.values()]; result.issues = [...new Set(result.issues)];
  if (result.rows.length > 100) { result.rows = []; result.issues.push('Paste up to 100 meeting patterns at a time.'); }
  if (!result.rows.length && !result.issues.length) result.issues.push('This range has no class or lab meetings.');
  return result;
}
