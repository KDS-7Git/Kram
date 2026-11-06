import { addDays, dateRange, inDateRange, weekday } from '@kram/time';

export interface QuotaRule {
  type: string; unit: string; targetQty: number; startDate: string;
  dueDate?: string | null; availableDays?: readonly number[];
  /** Only dated immutable rule metadata; the current goal status is not pause history. */
  status?: string; pausedRanges?: readonly { start: string; end?: string | null }[];
}
export interface QuotaGoal extends QuotaRule { id: string; title: string }
export interface QuotaRuleSnapshot { id?: string; version?: number; effectiveFrom: string; rules: QuotaRule }
export interface QuotaOccurrence {
  id?: string; goalId?: string; localDate: string; originalDate: string; status: string;
  fields: { qty?: number; unit?: string };
}
export interface QuotaWork { goalId: string; localDate: string; unit: string; minutes: number; qty: number; occurrenceId?: string | null; weeklyPeriodStart?: string }
export interface WeeklyQuotaPeriod { periodStart: string; periodEnd?: string; ruleVersionId?: string }
export interface QuotaOutcome {
  goalId: string; title: string; type: string; unit: string;
  periodStart: string; periodEnd: string; targetQty: number; creditedQty: number; shortfallQty: number;
  status: 'met' | 'shortfall' | 'in_progress' | 'provisional';
  ruleVersionId?: string; occurrenceId?: string; originalDate?: string; periodKey?: string;
}
export interface GoalQuotaInput {
  goal: QuotaGoal; rules?: readonly QuotaRuleSnapshot[]; occurrences?: readonly QuotaOccurrence[];
  /** Surviving append-only contributions, annotated with their original rule's unit. */
  work: readonly QuotaWork[]; weeklyPeriods?: readonly WeeklyQuotaPeriod[]; weekStart: string; today: string; unverifiedDates?: ReadonlySet<string>;
}
const unitKey = (unit: string) => unit.trim().toLowerCase();
const round = (value: number) => Math.round(value * 100) / 100;
const suppressed = new Set(['skipped', 'suppressed', 'cancelled', 'excluded']);

/** Compare each original quota with work in its own unit and period, never a blended week target. */
export function goalQuotaOutcomes(input: GoalQuotaInput): QuotaOutcome[] {
  const end = addDays(input.weekStart, 6);
  const dates = dateRange(input.weekStart, end);
  const fallback: QuotaRule = { type: input.goal.type, unit: input.goal.unit, targetQty: input.goal.targetQty, startDate: input.goal.startDate, dueDate: input.goal.dueDate, availableDays: input.goal.availableDays };
  const rules: QuotaRuleSnapshot[] = (input.rules?.length ? [...input.rules] : [{ effectiveFrom: input.goal.startDate, rules: fallback }])
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || (a.version ?? 0) - (b.version ?? 0));
  const at = (date: string) => rules.filter(snapshot => snapshot.effectiveFrom <= date).at(-1);
  const eligible = (date: string, rule: QuotaRule) => (!rule.status || rule.status === 'active') && !(rule.pausedRanges ?? []).some(range => inDateRange(date, range)) && inDateRange(date, { start: rule.startDate, end: rule.dueDate }) && (rule.availableDays ?? [1, 2, 3, 4, 5, 6, 7]).includes(weekday(date));
  const own = input.work.filter(work => work.goalId === input.goal.id);
  const outcome = (snapshot: QuotaRuleSnapshot, start: string, finish: string, target: number, work: readonly QuotaWork[], extra: Partial<QuotaOutcome> = {}, uncertain = false): QuotaOutcome => {
    if (!Number.isFinite(target) || target <= 0) throw new Error('A quota target must be a finite positive quantity.');
    const unit = extra.unit ?? snapshot.rules.unit;
    const credited = work.filter(work => unitKey(work.unit) === unitKey(unit)).reduce((sum, work) => sum + (unitKey(unit) === 'minutes' ? work.minutes : work.qty), 0);
    const unverified = uncertain || dateRange(start, finish).some(date => date <= input.today && input.unverifiedDates?.has(date));
    return { goalId: input.goal.id, title: input.goal.title, type: snapshot.rules.type, unit, periodStart: start, periodEnd: finish,
      targetQty: target, creditedQty: round(credited), shortfallQty: round(Math.max(0, target - credited)),
      status: credited >= target ? 'met' : unverified ? 'provisional' : finish >= input.today ? 'in_progress' : 'shortfall',
      ...(snapshot.id ? { ruleVersionId: snapshot.id } : {}), ...extra };
  };
  const periodic: QuotaOutcome[] = [];
  const suppliedPeriods: WeeklyQuotaPeriod[] = [
    ...own.filter(work => work.weeklyPeriodStart).map(work => ({ periodStart: work.weeklyPeriodStart! })),
    ...(input.weeklyPeriods ?? []),
  ];
  const storedPeriods = [...new Map<string, WeeklyQuotaPeriod>(suppliedPeriods.map(period => [period.periodStart, period])).values()].map(period => ({ ...period, periodEnd: period.periodEnd ?? addDays(period.periodStart, 6) }))
    .filter(period => period.periodStart <= end && period.periodEnd >= input.weekStart);
  for (const period of storedPeriods) {
    const snapshot = rules.find(rule => rule.id && rule.id === period.ruleVersionId) ?? at(period.periodStart) ?? rules.find(rule => rule.effectiveFrom >= period.periodStart && rule.effectiveFrom <= period.periodEnd);
    if (!snapshot || snapshot.rules.type !== 'weekly') continue;
    const finish = snapshot.rules.dueDate && snapshot.rules.dueDate < period.periodEnd ? snapshot.rules.dueDate : period.periodEnd;
    const start = snapshot.rules.startDate > period.periodStart ? snapshot.rules.startDate : period.periodStart;
    if (start > finish || !dateRange(start, finish).some(date => eligible(date, snapshot.rules))) continue;
    const candidates = own.filter(work => work.localDate >= start && work.localDate <= finish);
    const ambiguous = candidates.some(work => !work.weeklyPeriodStart && storedPeriods.filter(other => work.localDate >= other.periodStart && work.localDate <= other.periodEnd).length > 1);
    const matched = candidates.filter(work => work.weeklyPeriodStart ? work.weeklyPeriodStart === period.periodStart : storedPeriods.filter(other => work.localDate >= other.periodStart && work.localDate <= other.periodEnd).length === 1);
    periodic.push(outcome(snapshot, start, finish, snapshot.rules.targetQty, matched, { periodKey: `weekly:${period.periodStart}` }, ambiguous));
  }
  // An established weekly quota is anchored to its start, even when a later
  // edit falls inside that week or its first available weekday comes later.
  const anchor = at(input.weekStart);
  if (!storedPeriods.length && anchor?.rules.type === 'weekly' && dates.some(date => eligible(date, anchor.rules))) {
    const finish = anchor.rules.dueDate && anchor.rules.dueDate < end ? anchor.rules.dueDate : end;
    periodic.push(outcome(anchor, input.weekStart, finish, anchor.rules.targetQty, own.filter(work => work.localDate >= input.weekStart && work.localDate <= finish), { periodKey: `weekly:${input.weekStart}` }));
  } else {
    for (const date of dates) {
      const snapshot = at(date); if (!snapshot || !eligible(date, snapshot.rules)) continue;
      if (snapshot.rules.type === 'daily' && !storedPeriods.some(period => date >= period.periodStart && date <= period.periodEnd)) periodic.push(outcome(snapshot, date, date, snapshot.rules.targetQty, own.filter(work => work.localDate === date)));
      else if (snapshot.rules.type === 'weekly' && !storedPeriods.length) {
        // A newly started weekly goal has one full quota in its first partial
        // week. It is not multiplied by the number of available dates.
        const finish = snapshot.rules.dueDate && snapshot.rules.dueDate < end ? snapshot.rules.dueDate : end;
        periodic.push(outcome(snapshot, date, finish, snapshot.rules.targetQty, own.filter(work => work.localDate >= date && work.localDate <= finish), { periodKey: `weekly:${input.weekStart}` })); break;
      }
    }
  }
  const occurrences = (input.occurrences ?? []).filter(occurrence => (!occurrence.goalId || occurrence.goalId === input.goal.id) && occurrence.localDate >= input.weekStart && occurrence.localDate <= end && !suppressed.has(occurrence.status));
  for (const occurrence of occurrences) {
    const snapshot = at(occurrence.originalDate);
    if (!snapshot || snapshot.rules.type !== 'recurring' || snapshot.rules.status && snapshot.rules.status !== 'active' || (snapshot.rules.pausedRanges ?? []).some(range => inDateRange(occurrence.originalDate, range))) continue;
    const unit = occurrence.fields.unit ?? snapshot.rules.unit;
    const target = occurrence.fields.qty ?? snapshot.rules.targetQty;
    const matchingDate = own.filter(work => work.localDate === occurrence.localDate && unitKey(work.unit) === unitKey(unit));
    const sharedDate = occurrences.filter(value => value.localDate === occurrence.localDate).length > 1;
    const ambiguous = sharedDate && matchingDate.some(work => !work.occurrenceId);
    const matched = occurrence.id ? matchingDate.filter(work => work.occurrenceId === occurrence.id || (!sharedDate && !work.occurrenceId)) : sharedDate ? [] : matchingDate;
    periodic.push(outcome(snapshot, occurrence.localDate, occurrence.localDate, target, matched, { unit, originalDate: occurrence.originalDate, ...(occurrence.id ? { occurrenceId: occurrence.id } : {}) }, ambiguous || occurrence.status === 'conflict'));
  }
  return periodic.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || (a.originalDate ?? '').localeCompare(b.originalDate ?? ''));
}
