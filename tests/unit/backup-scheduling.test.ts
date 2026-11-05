import { describe, expect, it } from 'vitest';
import { dueBackup, type BackupScheduleState } from '../../apps/worker/src/backup-scheduling';

const previous = (periodDay: string, timezone = 'Asia/Kolkata'): BackupScheduleState => ({ periodDay, timezone, jobId: 'fixture', queuedAt: '2026-01-01T00:00:00Z' });

describe('nightly backup calendar', () => {
  it('switches the due period at local03:00, independently of UTC day', () => {
    expect(dueBackup(new Date('2026-11-05T21:29:59Z'), 'Asia/Kolkata')?.periodDay).toBe('2026-11-05');
    expect(dueBackup(new Date('2026-11-05T21:30:00Z'), 'Asia/Kolkata')?.periodDay).toBe('2026-11-06');
  });
  it('does not repeat the queued period after restart', () => {
    expect(dueBackup(new Date('2026-11-06T12:00:00Z'), 'Asia/Kolkata', previous('2026-11-06'))).toBeNull();
  });
  it('records an outage in calendar order but creates one current snapshot', () => {
    const job = dueBackup(new Date('2026-11-06T12:00:00Z'), 'Asia/Kolkata', previous('2026-11-03'))!;
    expect(job.reason).toBe('catch-up');
    expect(job.missedPeriods).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
    expect(job.scheduledAt).toBe('2026-11-06T12:00:00.000Z');
  });
  it('caps outage accounting to the latest fourteen days without fake initial history', () => {
    const initial = dueBackup(new Date('2026-11-06T12:00:00Z'), 'Asia/Kolkata')!;
    expect(initial.reason).toBe('initial');
    expect(initial.missedPeriods).toEqual([]);
    const catchUp = dueBackup(new Date('2026-11-06T12:00:00Z'), 'Asia/Kolkata', previous('2026-09-01'))!;
    expect(catchUp.catchUpCapped).toBe(true);
    expect(catchUp.missedPeriods).toHaveLength(14);
    expect(catchUp.missedPeriods[0]).toBe('2026-10-24');
  });
  it('uses civil days through DST and separates timezone period identities', () => {
    const dst = dueBackup(new Date('2026-03-29T01:00:00Z'), 'Europe/Berlin', previous('2026-03-28', 'Europe/Berlin'))!;
    expect(dst.periodDay).toBe('2026-03-29');
    expect(dst.missedPeriods).toEqual(['2026-03-29']);
    expect(dueBackup(new Date('2026-11-06T12:00:00Z'), 'Europe/Berlin', previous('2026-11-06'))?.reason).toBe('timezone-change');
    expect(dueBackup(new Date('2026-11-06T12:00:00Z'), 'Asia/Kolkata')?.periodKey).not.toBe(dueBackup(new Date('2026-11-06T12:00:00Z'), 'Europe/Berlin')?.periodKey);
  });
});
