import { addDays, dateRange } from '@kram/time';

/** Initial install starts today; outage catch-up covers at most14 civil dates. */
export function missingMaterializationDates(today: string, lastDate?: string): string[] {
  if (lastDate && lastDate >= today) return [];
  const first = lastDate ? [addDays(lastDate, 1), addDays(today, -13)].sort().at(-1)! : today;
  return dateRange(first, today);
}
