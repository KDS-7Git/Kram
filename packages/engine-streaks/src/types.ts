import type { DateRange } from '@kram/time';

export type StreakResult = 'met' | 'missed' | 'rest' | 'paused' | 'grace';
export interface StreakRule {
  version: number;
  id?: string;
  scope: 'goal' | 'skill' | 'profile' | 'global';
  scopeId?: string | null;
  measure: 'minutes' | 'quantity' | 'completion';
  threshold: number;
  period: 'day' | 'week';
  eligibleDays?: number[];
  restPolicy?: 'skip' | 'miss';
  countPartial?: boolean;
  gracePerMonth?: number;
  unit?: string;
}
export interface ProgressEvent {
  id: string;
  taskId?: string | null;
  goalId?: string;
  skillId?: string;
  profileId?: string;
  kind: string;
  minutes: number;
  qty: number;
  localDate: string;
  unit?: string;
  occurredAt?: string;
  createdAt?: string;
  sequence?: number;
  reportedTotalMinutes?: number | null;
  reportedTotalQty?: number | null;
  correctsEventId?: string | null;
  unverified?: boolean;
}
export interface Period { start: string; end: string; kind: 'day' | 'week' }
export interface RunSummary { current: number; best: number; met: number; missed: number; grace: number; provisional: number }
export interface EvaluatePeriodInput {
  rule: StreakRule;
  period: Period;
  events: ProgressEvent[];
  restDays?: Set<string>;
  pausedRanges?: DateRange[];
  graceTokensLeft?: number;
  unverifiedDates?: Set<string>;
}
export interface PeriodEvaluation { result: StreakResult; reason: string; value: number; provisional?: boolean }
export interface StreakRecord extends PeriodEvaluation { periodStart: string; periodEnd: string; ruleVersion: number }
export interface RuleVersion { effectiveFrom: string; rule: StreakRule; pausedRanges?: DateRange[]; restDays?: Set<string>; weekStart?: 1 | 7 }
export interface EvaluateHistoryInput {
  from: string;
  to: string;
  rules: RuleVersion[];
  events: ProgressEvent[];
  weekStart?: 1 | 7;
  restDays?: Set<string>;
  pausedRanges?: DateRange[];
  unverifiedDates?: Set<string>;
}
