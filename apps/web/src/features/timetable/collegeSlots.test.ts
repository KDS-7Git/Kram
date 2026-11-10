import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { v7 as newId } from 'uuid';
import { collegeSlotTemplateSchema } from '@kram/shared';
import { assignSlot, parseSlotGrid, periodPayload, restoreSlotDrafts } from './collegeSlots';

const screenshot = readFileSync('docs/examples/non-ic-slot-grid.tsv', 'utf8');
const grid = (text: string) => collegeSlotTemplateSchema.parse({ id: newId(), version: 1, name: 'Synthetic semester', periods: parseSlotGrid(text).periods.map(periodPayload) }) as ReturnType<typeof collegeSlotTemplateSchema.parse> & { version: number };
describe('semester-defined course slots', () => {
  it('imports the supplied grid, using three lectures by default and distinct shared FS/NS choices', () => {
    const template = grid(screenshot);
    expect(parseSlotGrid(screenshot).issues).toEqual([]);
    const f = assignSlot(template, 'F', 'Networks · CS313');
    expect(f.filter(row => !row.disabled).map(row => [row.slot, row.weekdays, row.start, row.end])).toEqual([
      ['F1', [2], '08:00', '08:50'], ['F2', [3], '10:00', '10:50'], ['F3', [5], '11:00', '11:50'],
    ]);
    expect(f.find(row => row.slot === 'F4')?.disabled).toBe(true);
    expect(assignSlot(template, 'C').filter(row => !row.disabled).map(row => [row.slot, row.weekdays, row.start])).toEqual([['C1', [1], '10:00'], ['C2', [3], '08:00'], ['C3', [4], '11:00']]);
    expect(assignSlot(template, 'L2')[0]).toMatchObject({ type: 'lab', weekdays: [2], start: '14:00', end: '17:00', disabled: false });
    expect(template.periods.filter(row => row.group === 'FS')).toHaveLength(6);
    expect(template.periods.find(row => row.label === 'A4')).toMatchObject({ startMin: 720, optional: true });
  });
  it('takes different semester layouts and arbitrary group names entirely from input', () => {
    const template = grid('Group,Meeting,Day,Start,End,Type,Optional\nBlue,Session one,Sat,09:15,10:05,Lecture,no\nBlue,Session two,Sun,4:10 PM,5:20 PM,Lecture,yes\nLab-Q,Practical,Wed,13:10,16:40,Lab,no');
    expect(assignSlot(template, 'Blue').map(row => [row.weekdays, row.start, row.end, row.disabled])).toEqual([[[6], '09:15', '10:05', false], [[7], '16:10', '17:20', true]]);
    expect(assignSlot(template, 'Lab-Q')[0]?.end).toBe('16:40');
    expect(assignSlot(grid('Days\t10:10-11:00 AM\nThursday\tF1'), 'F')[0]).toMatchObject({ weekdays: [4], start: '10:10' });
  });
  it('preserves fewer meetings and custom times when reconstructing course cards', () => {
    const template = grid(screenshot), f = assignSlot(template, 'F');
    const persisted = f.filter(row => ['F1', 'F2'].includes(row.slot)).map(row => row.slot === 'F2' ? { ...row, slot: 'FS', weekdays: [6], start: '16:00', end: '17:10' } : row);
    const restored = restoreSlotDrafts(persisted, [template]);
    expect(restored.filter(row => !row.disabled)).toEqual(persisted);
    expect(restored.filter(row => row.disabled).map(row => row.slot).sort()).toEqual(['F3', 'F4']);
    const changedGrid = { ...template, periods: template.periods.map(row => ({ ...row, startMin: row.startMin + 5 })) };
    expect(restoreSlotDrafts(persisted, [changedGrid]).filter(row => !row.disabled)).toEqual(persisted);
  });
  it('flags malformed ranges and rejects invalid or duplicate definitions', () => {
    const parsed = parseSlotGrid('Days\t09:00-\nMonday\tX1');
    expect(parsed.issues).not.toHaveLength(0);
    expect(collegeSlotTemplateSchema.safeParse({ id: newId(), name: 'Invalid', periods: parsed.periods.map(periodPayload) }).success).toBe(false);
    const template = grid(screenshot), period = template.periods[0]!;
    for (const other of [{ ...period, id: newId() }, { ...period, label: 'Different' }]) expect(collegeSlotTemplateSchema.safeParse({ ...template, periods: [period, other] }).success).toBe(false);
    expect(parseSlotGrid('A1\tB1\nC1\tD1').issues).not.toHaveLength(0);
  });
});
