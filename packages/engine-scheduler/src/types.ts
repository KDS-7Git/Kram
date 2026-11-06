export type PlanningMode = 'adaptive' | 'balanced' | 'deadline' | 'directed';
export type PriorityOverride = 'inherit' | 'on' | 'off';
export interface Slot { date: string; startMin: number; endMin: number; skillId?: string }
export interface Task {
  id: string;
  goalId: string;
  skillId?: string;
  title?: string;
  kind?: string;
  estMinutes: number;
  remainingMinutes: number;
  status: string;
  earliestDate?: string | null;
  dueDate?: string | null;
  supportsSplit?: boolean;
  order?: number;
  sortOrder?: number;
  revisionDue?: boolean;
}
export interface Dep { taskId: string; dependsOnTaskId: string }
export interface GoalMeta {
  id: string;
  skillId: string;
  status?: string;
  priority?: number | null;
  usePriority?: PriorityOverride;
  dueDate?: string | null;
  availableDays?: number[];
  order?: number;
  sortOrder?: number;
  weeklyTargetMin?: number;
  maxDailyMin?: number;
}
export interface SkillMeta {
  id: string;
  profileId?: string;
  priority?: number | null;
  usePriority?: PriorityOverride;
  availableDays?: number[];
  maxDailyMin?: number;
  maxWeeklyMin?: number;
  minWeeklyMin?: number;
  weeklyTargetMin?: number;
  allocationWeight?: number;
  order?: number;
  sortOrder?: number;
}
export interface CalibrationSample { skillId: string; kind?: string; actualMinutes: number; estMinutes: number; completedAt?: string }
export interface RecentProgress {
  lastPractice?: Record<string, string>;
  calibration?: Record<string, number>;
  samples?: CalibrationSample[];
  /** Completed prerequisites may be outside the rolling open-task window. */
  completedTaskIds?: string[];
}
export interface ScoreWeights { deadline: number; goal: number; skill: number; pressure: number; dependency: number; recency: number; revision: number; switching: number; allocation: number }
export interface SchedulerConfig {
  algoVersion: string;
  maxDailyMin: number;
  maxWeeklyMin: number;
  minChunk: number;
  minBreak: number;
  breakAfter: number;
  maxGoalShare: number;
  buffer: number;
  usePriority: boolean;
  weekStart: 1 | 7;
  stabilityThreshold: number;
  weights: ScoreWeights;
}
export interface PlanItem {
  taskId: string;
  goalId: string;
  skillId: string;
  date: string;
  startMin: number;
  endMin: number;
  /** Wall-clock minutes allocated in the slot. */
  minutes: number;
  /** Estimated task remainder consumed; differs from minutes when calibrated. */
  workMinutes?: number;
  score: number;
  explanation: string;
  pinned?: boolean;
}
/** Occupied workload outside copied frozen plan items; include earlier days of
 * every horizon week so weekly caps account for work already committed. */
export interface ExistingWork { date: string; minutes: number; skillId?: string; goalId?: string }
export interface PlanInput {
  today: string;
  horizonDays?: number;
  mode?: PlanningMode;
  freeSlots: Record<string, Slot[]>;
  tasks: Task[];
  dependencies?: Dep[];
  goals: GoalMeta[];
  skills: SkillMeta[];
  history?: RecentProgress;
  frozen?: PlanItem[];
  previous?: PlanItem[];
  /** Feasible historical placements to prefer; diffs still compare with previous. */
  preferred?: PlanItem[];
  existingWork?: ExistingWork[];
  config?: Partial<Omit<SchedulerConfig, 'weights'>> & { weights?: Partial<ScoreWeights> };
}
export type UnplacedCode = 'NO_CAPACITY' | 'BLOCKED_BY_DEP' | 'BEYOND_DEADLINE' | 'FROZEN_CONFLICT' | 'PAUSED_GOAL';
export interface UnplacedTask { taskId: string; code: UnplacedCode; reason: string; remainingMinutes: number }
export interface Warning { goalId?: string; code: string; message: string; shortfallMin?: number }
export interface PlanChange { taskId: string; kind: 'added' | 'removed' | 'moved'; before?: PlanItem[]; after?: PlanItem[]; reason: string }
export interface ChangeSummary { changes: PlanChange[]; requiresApproval: boolean; frozenChangeCount: number }
export interface PlanResult { items: PlanItem[]; unplaced: UnplacedTask[]; warnings: Warning[]; changes: ChangeSummary; algoVersion: string }
export interface GoalFeasibility { goalId: string; remainingMin: number; availableMin: number; shortfallMin: number; requiredPerDay: number; eligibleDays: number; feasible: boolean }
