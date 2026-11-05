export type Layer = 0 | 1 | 2 | 3 | 4 | 'unavailable' | 'fixed' | 'pinned' | 'reserved' | 'flexible';
export interface Interval { startMin: number; endMin: number }
export interface TimeSlot extends Interval {
  id?: string;
  date: string;
  title?: string;
  layer: Layer;
  skillId?: string | null;
  profileId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  pinned?: boolean;
  templateId?: string | null;
}
export interface FreeSlot extends Interval { date: string; skillId?: string }
export interface ReservedWindow extends Interval { skillId: string; days?: number[] }
export interface FreeSlotsInput {
  date: string;
  wakingWindow: Interval;
  slots: TimeSlot[];
  reservedWindows?: ReservedWindow[];
  maxDailyMin?: number;
  minFreeTime?: number;
  minBreak?: number;
  breakAfter?: number;
  restDay?: boolean;
}
export interface SlotConflict { first: TimeSlot; second: TimeSlot; message: string }
export interface TemplateEntry extends Omit<TimeSlot, 'date' | 'id'> { weekday: number }
export interface ScheduleTemplate { id: string; name?: string; kind: 'week' | 'day'; entries: TemplateEntry[] }
