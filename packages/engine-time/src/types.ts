/** An instant source supplied by the application. Pure engines never read it themselves. */
export interface Clock { now(): string }
export type WeekStart = 1 | 7;
export interface DateRange { start: string; end?: string | null }
export interface ResolvedLocalTime {
  instant: string;
  localDate: string;
  startMin: number;
  adjusted: boolean;
  ambiguous: boolean;
}
