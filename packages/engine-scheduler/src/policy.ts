import type { CalibrationSample, PlanInput, SchedulerConfig, Task, GoalMeta, SkillMeta } from './types';
import { instantMillis } from '@kram/time';

export const engineVersion = '0.2.0';
export const algoVersion = 'greedy-v1';
export const defaultConfig: Readonly<SchedulerConfig> = Object.freeze({
  algoVersion, maxDailyMin: 360, maxWeeklyMin: 1800, minChunk: 15,
  minBreak: 10, breakAfter: 60, maxGoalShare: 0.6, buffer: 0.1,
  usePriority: false, weekStart: 1, stabilityThreshold: 0.15,
  weights: Object.freeze({ deadline: 0.3, goal: 0.15, skill: 0.1, pressure: 0.15, dependency: 0.1, recency: 0.1, revision: 0.1, switching: 0.05, allocation: 0.1 }),
});
export const closedStatuses = new Set(['completed', 'cancelled', 'skipped', 'archived']);
export const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export function configuration(input: PlanInput): SchedulerConfig {
  const weights = { ...defaultConfig.weights };
  if (input.mode === 'deadline') weights.deadline = 0.6;
  if (input.mode === 'balanced') { weights.recency = 0.25; weights.allocation = 0.3; }
  const config = { ...defaultConfig, ...input.config, weights: { ...weights, ...input.config?.weights } };
  for (const [key, value] of Object.entries(config)) if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new RangeError(`Scheduler ${key} must be a non-negative finite number.`);
  if (!Number.isInteger(config.minChunk) || config.minChunk < 1 || config.minChunk > 1440 || config.maxDailyMin > 1440 || config.maxWeeklyMin > 10080 || !Number.isInteger(config.minBreak) || config.minBreak > 1440 || !Number.isInteger(config.breakAfter) || config.breakAfter < 1 || config.breakAfter > 1440) throw new RangeError('Scheduler capacity, chunk and break bounds are invalid.');
  if (config.buffer >= 1 || config.maxGoalShare <= 0 || config.maxGoalShare > 1 || ![1, 7].includes(config.weekStart) || !config.algoVersion) throw new RangeError('Scheduler buffer, goal share, week start or algorithm version is invalid.');
  for (const weight of Object.values(config.weights)) if (!Number.isFinite(weight) || weight < 0) throw new RangeError('Score weights must be non-negative finite numbers.');
  return config;
}
/** Completed observations only. Invalid ratios never silently poison a plan. */
export function calibration(samples: CalibrationSample[], skillId: string, kind?: string): number {
  const observations = samples.filter(sample=>sample.skillId===skillId&&sample.kind===kind&&Number.isFinite(sample.actualMinutes)&&sample.actualMinutes>=0&&Number.isFinite(sample.estMinutes)&&sample.estMinutes>0).map((sample, index) => {
    let at = -Infinity; try { if (sample.completedAt) at = instantMillis(sample.completedAt); } catch { return undefined; }
    return { sample, index, at };
  });
  const ratios = observations.filter((entry): entry is { sample: CalibrationSample; index: number; at: number } => !!entry)
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .slice(-10).map(({ sample }) => sample.actualMinutes / sample.estMinutes).sort((a, b) => a - b);
  if (ratios.length < 5) return 1;
  const mid = Math.floor(ratios.length / 2);
  return round(clamp(ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2, 0.7, 2));
}
export function calibrationFor(input: PlanInput, task: Task, skillId: string): number {
  if (input.history?.samples) return calibration(input.history.samples, skillId, task.kind);
  const value = input.history?.calibration?.[`${skillId}:${task.kind ?? ''}`] ?? input.history?.calibration?.[skillId];
  return value === undefined ? 1 : round(clamp(Number.isFinite(value) ? value : 1, 0.7, 2));
}
export function priorityEnabled(input: PlanInput, goal: GoalMeta, skill: SkillMeta): boolean {
  if (goal.usePriority && goal.usePriority !== 'inherit') return goal.usePriority === 'on';
  if (skill.usePriority && skill.usePriority !== 'inherit') return skill.usePriority === 'on';
  return input.config?.usePriority ?? false;
}
export function effectiveDeadline(task: Task, goal: GoalMeta): string | undefined {
  return [task.dueDate, goal.dueDate].filter((date): date is string => !!date).sort()[0];
}
