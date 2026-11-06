import { expect, it } from 'vitest';
import { applyTemplate, conflicts, freeSlots, type TimeSlot } from './index';
const slot = (startMin: number, endMin: number, patch: Partial<TimeSlot> = {}): TimeSlot => ({ date: '2026-11-09', startMin, endMin, layer: 'fixed', ...patch });
it('rejects hard overlaps, permits adjacent slots and same-skill reserved containment', () => {
  expect(conflicts([slot(480, 540), slot(540, 600)])).toEqual([]);
  expect(conflicts([slot(480, 540), slot(530, 600)])).toHaveLength(1);
  expect(conflicts([slot(480, 600, { layer: 'reserved', skillId: 'a' }), slot(500, 550, { layer: 'flexible', skillId: 'a' })])).toEqual([]);
  expect(conflicts([slot(480, 600, { layer: 'reserved', skillId: 'a' }), slot(500, 550, { layer: 'pinned', skillId: 'a' })])).toHaveLength(1);
});
it('subtracts busy time, inserts breaks, labels reservations and retains free time', () => {
  expect(freeSlots({ date: '2026-11-09', wakingWindow: { startMin: 480, endMin: 900 }, slots: [slot(480, 600)], minBreak: 15, breakAfter: 60, minFreeTime: 30, reservedWindows: [{ startMin: 660, endMin: 720, skillId: 'a' }] })).toEqual([
    { date: '2026-11-09', startMin: 615, endMin: 660 }, { date: '2026-11-09', startMin: 660, endMin: 720, skillId: 'a' }, { date: '2026-11-09', startMin: 720, endMin: 870 },
  ]);
});
it('copies weekly templates onto the requested week without mutating the source', () => {
  const template = { id: 'template', kind: 'week' as const, entries: [{ weekday: 1, startMin: 480, endMin: 540, layer: 'fixed' as const }, { weekday: 5, startMin: 600, endMin: 660, layer: 'reserved' as const, skillId: 'a' }] };
  const before = JSON.stringify(template);
  expect(applyTemplate(template, '2026-11-09').map(item => item.date)).toEqual(['2026-11-09', '2026-11-13']);
  expect(JSON.stringify(template)).toBe(before);
});
it('keeps generated free intervals non-overlapping and within capacity for 200 snapshots', () => {
  for (let seed = 0; seed < 200; seed++) {
    const busy = slot(480 + seed, 510 + seed);
    const result = freeSlots({ date: busy.date, wakingWindow: { startMin: 420, endMin: 1260 }, slots: [busy], maxDailyMin: 60 + seed, minFreeTime: seed % 60 });
    expect(result.reduce((sum, item) => sum + item.endMin - item.startMin, 0)).toBeLessThanOrEqual(60 + seed);
    for (let index = 0; index < result.length; index++) {
      const item = result[index]!;
      expect(item.startMin).toBeGreaterThanOrEqual(420); expect(item.endMin).toBeLessThanOrEqual(1260);
      expect(item.startMin >= busy.endMin || item.endMin <= busy.startMin).toBe(true);
      if (index) expect(result[index - 1]!.endMin).toBeLessThanOrEqual(item.startMin);
    }
  }
});
it('subtracts already placed work from the daily workload and protects free time in a reserved day', () => {
  expect(freeSlots({ date: '2026-11-09', wakingWindow: { startMin: 480, endMin: 720 }, slots: [slot(480, 540, { layer: 'flexible' })], maxDailyMin: 90 }).reduce((sum, item) => sum + item.endMin - item.startMin, 0)).toBe(30);
  expect(freeSlots({ date: '2026-11-09', wakingWindow: { startMin: 480, endMin: 720 }, slots: [slot(480, 720, { layer: 'reserved', skillId: 'a' })], minFreeTime: 60 })).toEqual([{ date: '2026-11-09', startMin: 480, endMin: 660, skillId: 'a' }]);
});
it('keeps an evening skill reservation when the daily cap is smaller than earlier open time', () => {
  expect(freeSlots({ date: '2026-11-09', wakingWindow: { startMin: 480, endMin: 1260 }, slots: [slot(1080, 1140, { layer: 'reserved', skillId: 'a' })], maxDailyMin: 60 })).toEqual([{ date: '2026-11-09', startMin: 1080, endMin: 1140, skillId: 'a' }]);
});
