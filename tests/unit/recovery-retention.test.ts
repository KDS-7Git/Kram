import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { retainedIds } from '../../infra/backup/recovery.mjs';

describe('encrypted recovery retention', () => {
  it('retains exactly the union of 7 daily, 4 weekly, and 6 monthly buckets', () => {
    const latest = DateTime.fromISO('2026-11-06T12:00:00Z');
    const points = Array.from({ length: 300 }, (_, index) => ({ id: String(index), createdAt: latest.minus({ days: index }).toISO()!, timezone: 'UTC' }));
    const retained = retainedIds(points);
    expect([...retained].filter(id => Number(id) < 7)).toHaveLength(7);
    const months = new Set([...retained].map(id => DateTime.fromISO(points[Number(id)]!.createdAt).toFormat('yyyy-MM')));
    expect(months.size).toBe(6);
    expect(retained.has('0')).toBe(true); expect(retained.has('299')).toBe(false);
    expect(retained.size).toBeLessThanOrEqual(17);
    // Fixed civil-calendar fixture: newest days, previous Mondays and month ends.
    expect(retained).toEqual(new Set(['0', '1', '2', '3', '4', '5', '6', '12', '19', '37', '67', '98', '129']));
  });
  it('selects the newest same-day recovery and honors civil dates across timezone boundaries', () => {
    const points = [{ id: 'older', createdAt: '2026-11-05T20:00:00Z', timezone: 'Asia/Kolkata' }, { id: 'newer', createdAt: '2026-11-05T21:00:00Z', timezone: 'Asia/Kolkata' }, { id: 'other-day', createdAt: '2026-11-05T18:00:00Z', timezone: 'Asia/Kolkata' }];
    expect(retainedIds(points)).toEqual(new Set(['newer', 'other-day']));
    expect(() => retainedIds([{ id: 'invalid', createdAt: 'invalid' }])).toThrow('Invalid backup date');
  });
});
