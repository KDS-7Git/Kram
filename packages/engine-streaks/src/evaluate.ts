import { addDays, dateRange, inDateRange, parseLocalDate, weekday, weekStartDate } from '@kram/time';
import type { EvaluateHistoryInput, EvaluatePeriodInput, PeriodEvaluation, ProgressEvent, RunSummary, StreakRecord, StreakRule } from './types';

export function validateRule(rule: StreakRule): void {
  if (!Number.isInteger(rule.version) || rule.version < 1 || !Number.isFinite(rule.threshold) || rule.threshold <= 0) throw new Error('A rule needs a positive version and threshold.');
  if (!['goal', 'skill', 'profile', 'global'].includes(rule.scope) || !['minutes', 'quantity', 'completion'].includes(rule.measure) || !['day', 'week'].includes(rule.period)) throw new Error('Choose a supported scope, measure and period.');
  if (rule.scope !== 'global' && !rule.scopeId) throw new Error('Choose a target for this scope.');
  if (rule.measure === 'quantity' && (rule.scope !== 'goal' || !rule.unit?.trim())) throw new Error('Quantity streaks need one goal and its unit.');
  if (rule.eligibleDays && (!rule.eligibleDays.length || new Set(rule.eligibleDays).size !== rule.eligibleDays.length || rule.eligibleDays.some(day => !Number.isInteger(day) || day < 1 || day > 7))) throw new Error('Choose distinct eligible weekdays from 1 to 7.');
  if (rule.gracePerMonth !== undefined && (!Number.isInteger(rule.gracePerMonth) || rule.gracePerMonth < 0 || rule.gracePerMonth > 31)) throw new Error('Monthly grace must be between 0 and 31.');
}

/** Corrections retract earlier events; correcting a correction restores it. */
export function resolveProgress(events: readonly ProgressEvent[]): ProgressEvent[] {
  const byId = new Map<string, ProgressEvent>();
  for (const event of events) {
    parseLocalDate(event.localDate);
    if (!event.id || byId.has(event.id)) throw new Error('Every progress event needs a distinct identifier.');
    if (![event.minutes, event.qty, event.reportedTotalMinutes ?? 0, event.reportedTotalQty ?? 0].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Progress must be finite and nonnegative.');
    if (event.kind === 'correction' && (!event.correctsEventId || event.minutes || event.qty)) throw new Error('Corrections retract an earlier event without recording work.');
    if (event.kind !== 'correction' && event.correctsEventId) throw new Error('Only corrections may retract events.');
    byId.set(event.id, event);
  }
  const correctors = new Map<string, string[]>();
  for (const event of events) if (event.correctsEventId) {
    const target = byId.get(event.correctsEventId);
    if (!target || target.taskId !== event.taskId || target.goalId !== event.goalId) throw new Error('A correction must reference an event in the same task and goal.');
    correctors.set(target.id, [...correctors.get(target.id) ?? [], event.id]);
  }
  const visiting = new Set<string>(), active = new Map<string, boolean>();
  function isActive(id: string): boolean {
    if (active.has(id)) return active.get(id)!;
    if (visiting.has(id)) throw new Error('Corrections cannot contain a cycle.');
    visiting.add(id);
    const value = !(correctors.get(id) ?? []).some(isActive);
    visiting.delete(id); active.set(id, value); return value;
  }
  const totals = new Map<string, { minutes: number; qty: number }>();
  return events.filter(event => isActive(event.id)).sort((a, b) => {
    const first = a.taskId ?? a.goalId ?? a.id, second = b.taskId ?? b.goalId ?? b.id;
    if (first !== second) return first.localeCompare(second);
    if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence || a.id.localeCompare(b.id);
    return (a.createdAt ?? a.occurredAt ?? a.localDate).localeCompare(b.createdAt ?? b.occurredAt ?? b.localDate) || a.id.localeCompare(b.id);
  }).map(event => {
    const key = event.taskId ?? event.goalId ?? event.id;
    const total = totals.get(key) ?? { minutes: 0, qty: 0 };
    const contribution = event.kind === 'completed' ? { ...event,
      minutes: event.reportedTotalMinutes == null ? event.minutes : Math.max(0, event.reportedTotalMinutes - total.minutes),
      qty: event.reportedTotalQty == null ? event.qty : Math.max(0, event.reportedTotalQty - total.qty),
    } : event;
    if (['progress', 'completed'].includes(event.kind)) { total.minutes += contribution.minutes; total.qty += contribution.qty; totals.set(key, total); }
    return contribution;
  });
}

function scoped(event: ProgressEvent, rule: StreakRule) {
  return rule.scope === 'global' || (rule.scope === 'goal' ? event.goalId : rule.scope === 'skill' ? event.skillId : event.profileId) === rule.scopeId;
}
const numberText = (value: number) => String(Math.round(value * 100) / 100);

export function evaluatePeriod(input: EvaluatePeriodInput): PeriodEvaluation {
  return evaluateResolved(input, resolveProgress(input.events));
}
function evaluateResolved(input: EvaluatePeriodInput, resolved: readonly ProgressEvent[]): PeriodEvaluation {
  const { rule, period } = input; validateRule(rule);
  parseLocalDate(period.start); parseLocalDate(period.end);
  if (period.end < period.start || period.kind !== rule.period || (rule.period === 'day' ? period.start !== period.end : addDays(period.start, 6) !== period.end)) throw new Error('Evaluate one closed day or complete week.');
  const dates = dateRange(period.start, period.end);
  const paused = (date: string) => (input.pausedRanges ?? []).some(range => inDateRange(date, range));
  if (dates.every(paused)) return { result: 'paused', value: 0, reason: `Paused; rule v${rule.version}.` };
  const eligible = dates.filter(date => !paused(date) && (!rule.eligibleDays || rule.eligibleDays.includes(weekday(date))));
  if (!eligible.length) return { result: 'rest', value: 0, reason: `No eligible days in this period; rule v${rule.version}.` };
  const working = eligible.filter(date => rule.restPolicy === 'miss' || !input.restDays?.has(date));
  if (!working.length && rule.restPolicy !== 'miss') return { result: 'rest', value: 0, reason: `Rest period; the run stays unchanged; rule v${rule.version}.` };
  const active = resolved.filter(event => scoped(event, rule) && working.includes(event.localDate));
  if (rule.measure === 'quantity' && active.some(event => ['progress', 'completed'].includes(event.kind) && event.unit !== rule.unit)) throw new Error('Cannot combine unrelated quantity units.');
  const completedTasks = new Set(active.filter(event => event.kind === 'completed').map(event => event.taskId ?? event.id));
  const contributions = active.filter(event => !event.unverified && (rule.countPartial !== false || event.kind === 'sub_streak_met' || completedTasks.has(event.taskId ?? event.id)));
  const broad = rule.scope === 'profile' || rule.scope === 'global';
  const value = rule.measure === 'completion'
    ? new Set(contributions.filter(event => broad ? event.kind === 'sub_streak_met' : event.kind === 'completed').map(event => event.taskId ?? event.id)).size
    : contributions.filter(event => ['progress', 'completed'].includes(event.kind)).reduce((sum, event) => sum + (rule.measure === 'minutes' ? event.minutes : event.qty), 0);
  if (!Number.isFinite(value)) throw new Error('Accumulated progress exceeds the supported numeric range.');
  if (working.some(date => input.unverifiedDates?.has(date)) || active.some(event => event.unverified)) return { result: 'missed', value, provisional: true, reason: `Awaiting review; verified work is ${numberText(value)}. This period does not extend or end the run; rule v${rule.version}.` };
  const unit = rule.measure === 'minutes' ? 'min' : rule.measure === 'quantity' ? rule.unit! : broad ? 'met sub-streaks' : 'completed tasks';
  const detail = `${numberText(value)} of ${numberText(rule.threshold)} ${unit}; rule v${rule.version}.`;
  if (value >= rule.threshold) return { result: 'met', value, reason: `Met: ${detail}` };
  if ((input.graceTokensLeft ?? 0) > 0 && (rule.gracePerMonth ?? 0) > 0) return { result: 'grace', value, reason: `Grace used: ${detail}` };
  return { result: 'missed', value, reason: `Below target: ${detail}` };
}

/** `to` is the last closed study date, supplied by the caller's clock. */
export function evaluateHistory(input: EvaluateHistoryInput): StreakRecord[] {
  parseLocalDate(input.from); parseLocalDate(input.to);
  const versions = [...input.rules].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.rule.version - b.rule.version);
  for (const version of versions) { parseLocalDate(version.effectiveFrom); validateRule(version.rule); }
  const spent = new Map<string, number>(), result: StreakRecord[] = [];
  const resolved = resolveProgress(input.events);
  for (let date = input.from; date <= input.to; date = addDays(date, 1)) {
    const version = [...versions].reverse().find(version => version.effectiveFrom <= date);
    if (!version) continue;
    const rule = version.rule;
    if (rule.period === 'week' && weekStartDate(date, version.weekStart ?? input.weekStart) !== date) continue;
    const end = rule.period === 'day' ? date : addDays(date, 6);
    if (end > input.to) break;
    const month = end.slice(0, 7);
    const evaluation = evaluateResolved({ ...input, restDays: new Set([...input.restDays ?? [], ...version.restDays ?? []]), pausedRanges: [...input.pausedRanges ?? [], ...version.pausedRanges ?? []], rule, period: { start: date, end, kind: rule.period }, graceTokensLeft: Math.max(0, (rule.gracePerMonth ?? 0) - (spent.get(month) ?? 0)) }, resolved);
    if (evaluation.result === 'grace' && !evaluation.provisional) spent.set(month, (spent.get(month) ?? 0) + 1);
    result.push({ ...evaluation, periodStart: date, periodEnd: end, ruleVersion: rule.version });
    date = end;
  }
  return result;
}

/** Append order selects the latest correction for each closed period. */
export function foldRun(records: readonly StreakRecord[]): RunSummary {
  const latest = new Map<string, StreakRecord>();
  for (const record of records) latest.set(record.periodStart, record);
  const run: RunSummary = { current: 0, best: 0, met: 0, missed: 0, grace: 0, provisional: 0 };
  for (const record of [...latest.values()].sort((a, b) => a.periodStart.localeCompare(b.periodStart))) {
    if (record.provisional) { run.provisional++; continue; }
    if (record.result === 'met' || record.result === 'grace') { run[record.result]++; run.current++; run.best = Math.max(run.best, run.current); }
    else if (record.result === 'missed') { run.missed++; run.current = 0; }
  }
  return run;
}

export function streakAtRisk(input: { rule: StreakRule; verifiedValue: number; provisional?: boolean; eligible: boolean; freeMinutes: number; qualifyingMinutes: number; remainingValue: number }): boolean {
  validateRule(input.rule);
  const required = input.rule.threshold - input.verifiedValue;
  if (!input.eligible || input.provisional || required <= 0 || input.freeMinutes <= 0 || input.qualifyingMinutes <= 0 || input.remainingValue < required) return false;
  const neededMinutes = input.rule.measure === 'minutes' ? required : input.qualifyingMinutes * required / input.remainingValue;
  return neededMinutes <= input.freeMinutes;
}
