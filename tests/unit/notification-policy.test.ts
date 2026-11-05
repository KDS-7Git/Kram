import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@kram/shared';
import { quietUntil, nextRetry, privateMessage, GENERIC_BODY } from '../../apps/api/src/modules/notifications/policy';

describe('notification delivery policy', () => {
  it('defers across midnight to the owner-local end and treats the end as allowed', () => {
    expect(quietUntil(new Date('2026-11-05T18:30:00Z'), defaultSettings)?.toISOString()).toBe('2026-11-06T01:30:00.000Z');
    expect(quietUntil(new Date('2026-11-06T01:30:00Z'), defaultSettings)).toBeNull();
  });
  it('handles daytime quiet periods and an explicitly empty interval', () => {
    const settings = { ...defaultSettings, timezone: 'UTC', quietHours: { startMin: 600, endMin: 720 } };
    expect(quietUntil(new Date('2026-11-06T11:00:00Z'), settings)?.toISOString()).toBe('2026-11-06T12:00:00.000Z');
    expect(quietUntil(new Date('2026-11-06T11:00:00Z'), { ...settings, quietHours: { startMin: 600, endMin: 600 } })).toBeNull();
  });
  it('advances a DST-gap quiet end and does not suppress again after the first overlap end', () => {
    const settings = { ...defaultSettings, timezone: 'Europe/Berlin', quietHours: { startMin: 0, endMin: 150 } };
    expect(quietUntil(new Date('2026-03-29T00:30:00Z'), settings)?.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(quietUntil(new Date('2026-10-25T01:15:00Z'), settings)).toBeNull();
  });
  it('uses1/5/30minute retries and terminates after the fourth failure', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    expect([1, 2, 3, 4].map(attempt => nextRetry(attempt, now)?.toISOString() ?? null)).toEqual(['2026-11-06T12:01:00.000Z', '2026-11-06T12:05:00.000Z', '2026-11-06T12:30:00.000Z', null]);
  });
  it('replaces personal lock-screen detail before sending', () => {
    expect(privateMessage({ title: 'Private project', body: 'Private notes' }, true)).toMatchObject({ body: GENERIC_BODY });
    expect(privateMessage({ title: 'My task', body: 'My details' }, false)).toEqual({ title: 'My task', body: 'My details' });
  });
});
