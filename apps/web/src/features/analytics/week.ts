import { addDays, weekStartDate, type WeekStart } from '@kram/time';

export const analyticsWeekStart = (date: string, firstDay: WeekStart) => weekStartDate(date, firstDay);
export const adjacentAnalyticsWeek = (date: string, weeks: number, firstDay: WeekStart) => weekStartDate(addDays(date, weeks * 7), firstDay);
export function selectedAnalyticsWeek(requested: string | null, today: string, firstDay: WeekStart) {
  if (requested) { try { return weekStartDate(requested, firstDay); } catch { /* Fall back for an invalid shared report link. */ } }
  return weekStartDate(today, firstDay);
}
