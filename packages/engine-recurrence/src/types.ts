import type { DateRange } from '@kram/time';

export interface OccurrenceFields {
  startMin?: number;
  estMinutes?: number;
  title?: string;
  qty?: number;
}
export type RecurrenceException =
  | { date: string; kind: 'skip' }
  | { date: string; kind: 'move'; toDate: string; toStartMin?: number; override?: Partial<OccurrenceFields> }
  | { date: string; kind: 'modify'; override: Partial<OccurrenceFields> };
export interface RecurrenceSeries extends OccurrenceFields {
  id: string;
  goalId?: string;
  rrule: string;
  dtstartLocal: string;
  tz: string;
  until?: string | null;
  status: 'active' | 'paused' | 'ended';
  exceptions?: RecurrenceException[];
  pausedRanges?: DateRange[];
  holidays?: string[];
}
export interface Occurrence extends OccurrenceFields {
  id: string;
  seriesId: string;
  goalId?: string;
  originalDate: string;
  localDate: string;
  instant?: string;
  adjusted: boolean;
  ambiguous: boolean;
  moved: boolean;
}
