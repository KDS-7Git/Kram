import { describe, expect, it } from 'vitest';
import { missingMaterializationDates } from '../../apps/worker/src/domain-calendar';

describe('durable task materialization calendar', () => {
  it('starts with today and does not invent missed work on an initial install', () => {
    expect(missingMaterializationDates('2026-11-06')).toEqual(['2026-11-06']);
  });
  it('enqueues missing periods chronologically across a month and leap day', () => {
    expect(missingMaterializationDates('2028-03-02', '2028-02-27')).toEqual(['2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02']);
  });
  it('bounds a long outage to the latest14 civil dates', () => {
    const result = missingMaterializationDates('2026-11-06', '2026-09-01');
    expect(result).toHaveLength(14); expect(result[0]).toBe('2026-10-24'); expect(result.at(-1)).toBe('2026-11-06');
  });
  it('does no work after a completed current or future period', () => {
    expect(missingMaterializationDates('2026-11-06', '2026-11-06')).toEqual([]);
    expect(missingMaterializationDates('2026-11-06', '2026-11-07')).toEqual([]);
  });
});
