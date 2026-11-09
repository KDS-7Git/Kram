import { describe, expect, it } from 'vitest';
import { classWeekdays } from '@kram/shared';
import { parseClassDays, parseClassTime, parseTimetablePaste } from './classPaste';

describe('college timetable paste', () => {
  it('reads Excel rows with different weekday times, lab lengths and slot names', () => {
    const parsed = parseTimetablePaste('Course\tType\tSlot\tDay\tStart\tEnd\nNetworks\tLecture\tA1\tMon/Wed\t8:00 AM\t8:50 AM\nNetworks\tLecture\tA1\tThursday\t11:00\t11:50\nNetworks\tLab\tL2\tFri\t2:00 PM\t4:30 PM');
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toEqual([
      { course: 'Networks', type: 'lecture', slot: 'A1', weekdays: [1, 3], start: '08:00', end: '08:50' },
      { course: 'Networks', type: 'lecture', slot: 'A1', weekdays: [4], start: '11:00', end: '11:50' },
      { course: 'Networks', type: 'lab', slot: 'L2', weekdays: [5], start: '14:00', end: '16:30' },
    ]);
  });
  it('reads a compiled weekday grid, merging equal times across days', () => {
    const parsed = parseTimetablePaste('Time\tMon\tTue\tWed\tThu\tFri\n08:00–08:50\tNetworks\t\tNetworks\t\tMaths\n14:00-16:30\t\tPhysics Lab\t\t\t');
    expect(parsed.format).toBe('grid');
    expect(parsed.rows).toEqual([
      { course: 'Networks', type: 'lecture', slot: '', weekdays: [1, 3], start: '08:00', end: '08:50' },
      { course: 'Maths', type: 'lecture', slot: '', weekdays: [5], start: '08:00', end: '08:50' },
      { course: 'Physics Lab', type: 'lab', slot: '', weekdays: [2], start: '14:00', end: '16:30' },
    ]);
  });
  it('leaves unknown end times editable instead of guessing through blank Excel cells', () => {
    const parsed = parseTimetablePaste('Time\tMon\tTue\n14:00\tChemistry Lab\t\n15:00\t\t');
    expect(parsed.rows).toEqual([{ course: 'Chemistry Lab', type: 'lab', slot: '', weekdays: [1], start: '14:00', end: '' }]);
    expect(parsed.issues.join(' ')).toMatch(/start and end/);
    expect(parsed.issues.join(' ')).toMatch(/merged/);
  });
  it('supports CSV quotes, multiline cells, reordered columns and explicit duration', () => {
    const parsed = parseTimetablePaste('Day,Course,Start,Duration (min),Type,Slot\n"Tue, Fri","Signals, ""Systems""\nand Networks",09:00,50,Lecture,B2');
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toEqual([{ course: 'Signals, "Systems"\nand Networks', type: 'lecture', slot: 'B2', weekdays: [2, 5], start: '09:00', end: '09:50' }]);
  });
  it('preserves missing course cells and reports malformed or oversized input', () => {
    const parsed = parseTimetablePaste('\tLecture\tA1\tMon\t08:00\t08:50');
    expect(parsed.rows[0]?.course).toBe('');
    expect(parsed.issues.join(' ')).toMatch(/course name/);
    expect(parseTimetablePaste('"unfinished').issues.join(' ')).toMatch(/unfinished/);
    expect(parseTimetablePaste('x'.repeat(128001)).rows).toEqual([]);
    expect(parseTimetablePaste('Course\tType\tSlot\tDay\tStart\tEnd\nA\tLecture\t\tMon\t25:00\t08:50').rows[0]?.start).toBe('');
  });
  it('accepts real clock times and weekday names while rejecting ambiguous calendar rules', () => {
    expect([parseClassTime('12 AM'), parseClassTime('12 PM'), parseClassTime('24:00'), parseClassTime('0.5')]).toEqual([0, 720, 1440, 720]);
    expect([parseClassTime('24:30'), parseClassTime('13 PM'), parseClassTime('9:75')]).toEqual([null, null, null]);
    expect(parseClassDays('Monday, WE / Fri')).toEqual([1, 3, 5]);
    expect(parseClassDays('Mon invalid')).toEqual([]);
    expect(classWeekdays('FREQ=WEEKLY;INTERVAL=1;BYDAY=FR,MO,WE', '2026-11-09')).toEqual([1, 3, 5]);
    expect(classWeekdays('FREQ=WEEKLY', '2026-11-09')).toEqual([1]);
    expect(classWeekdays('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', '2026-11-09')).toBeNull();
    expect(classWeekdays('FREQ=WEEKLY;BYDAY=MO;COUNT=10', '2026-11-09')).toBeNull();
  });
});
