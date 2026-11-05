import { DateTime } from 'luxon';
import { addDays, instantMillis, localToInstant } from '@kram/time';
import type { Settings } from '@kram/shared';

export const RETRY_MINUTES = [1, 5, 30] as const;
export const REPEAT_MINUTES = 30;
export const GENERIC_TITLE = 'Kram reminder';
export const GENERIC_BODY = 'You have a scheduled reminder. Open Kram for details.';

/** Resolve physical quiet intervals rather than comparing repeated wall minutes. */
export function quietUntil(instant: Date, settings: Pick<Settings, 'timezone' | 'quietHours'>): Date | null {
  const { startMin, endMin } = settings.quietHours;
  if (startMin === endMin) return null;
  const now = instant.getTime();
  const date = DateTime.fromMillis(now, { zone: settings.timezone }).toISODate()!;
  for (const startDate of [addDays(date, -1), date]) {
    const start = instantMillis(localToInstant(startDate, startMin, settings.timezone));
    const end = instantMillis(localToInstant(startMin > endMin ? addDays(startDate, 1) : startDate, endMin, settings.timezone));
    if (now >= start && now < end) return new Date(end);
  }
  return null;
}

export function nextRetry(attempt: number, instant: Date): Date | null {
  const minutes = RETRY_MINUTES[attempt - 1];
  return minutes === undefined ? null : new Date(instant.getTime() + minutes * 60_000);
}

export function privateMessage(message: { title: string; body: string }, privacy: boolean) {
  return privacy ? { title: GENERIC_TITLE, body: GENERIC_BODY } : message;
}
