import { z } from "zod";
export {
  TaskEventError,
  resolveTaskEvents,
  foldTaskEvents,
  assertTaskEventAllowed,
  undoCompletionReference,
} from "./task-state";
export type {
  TaskFoldStatus,
  TaskStateEvent,
  TaskFoldSeed,
  TaskFoldContext,
  TaskFoldState,
} from "./task-state";

export const dateSchema = z.iso.date();
export const idSchema = z.uuid();
export const minuteSchema = z.number().int().min(0).max(1440);
export const clockMinuteSchema = z.number().int().min(0).max(1439);
export const weekdaySchema = z.number().int().min(1).max(7);
export const windowSchema = z
  .object({
    days: z.array(weekdaySchema).min(1),
    startMin: minuteSchema,
    endMin: minuteSchema,
  })
  .refine((v) => v.endMin > v.startMin, "End time must be after start time.");
export const settingsSchema = z
  .object({
    timezone: z
      .string()
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid IANA timezone.")
      .default("Asia/Kolkata"),
    dayRollover: clockMinuteSchema.default(240),
    weekStart: z.union([z.literal(1), z.literal(7)]).default(1),
    wakingMin: clockMinuteSchema.default(420),
    sleepingMin: minuteSchema.default(1380),
    maxDailyMin: z.number().int().min(15).max(960).default(360),
    maxWeeklyMin: z.number().int().min(15).max(6720).default(1800),
    minFreeMin: z.number().int().min(0).max(360).default(60),
    minBreakMin: z.number().int().min(0).max(120).default(10),
    breakAfterMin: z.number().int().min(15).max(240).default(60),
    minChunkMin: z.number().int().min(5).max(120).default(15),
    restDays: z.array(weekdaySchema).default([7]),
    horizonDays: z.number().int().min(1).max(21).default(14),
    planningMode: z
      .enum(["directed", "adaptive", "balanced", "deadline"])
      .default("directed"),
    usePriority: z.boolean().default(false),
    theme: z.enum(["system", "light", "dark", "scheduled"]).default("system"),
    density: z.enum(["comfortable", "compact"]).default("comfortable"),
    motion: z.enum(["system", "reduced", "full"]).default("system"),
    featurePreset: z.enum(["simple", "planner", "full"]).default("planner"),
    clockFormat: z.enum(["12", "24"]).default("24"),
    quietMode: z.boolean().default(false),
    gracePerMonth: z.number().int().min(0).max(10).default(0),
    quietHours: z
      .object({
        startMin: clockMinuteSchema.default(1320),
        endMin: clockMinuteSchema.default(420),
      })
      .default({ startMin: 1320, endMin: 420 }),
    notificationsEnabled: z.boolean().default(false),
    notificationPrivacy: z.boolean().default(true),
    dailyReviewMin: clockMinuteSchema.default(1260),
    planReadyMin: clockMinuteSchema.default(420),
    allowUrgentDuringQuiet: z.boolean().default(false),
    sound: z.boolean().default(false),
    haptics: z.boolean().default(false),
  })
  .refine((v) => v.sleepingMin > v.wakingMin, {
    message: "Sleeping time must be after waking time.",
    path: ["sleepingMin"],
  });
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = settingsSchema.parse({});
export const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12, "Use at least 12 characters.").max(1024),
});
export const setupSchema = loginSchema
  .extend({
    timezone: settingsSchema.shape.timezone,
    dayRollover: settingsSchema.shape.dayRollover,
    wakingMin: settingsSchema.shape.wakingMin,
    sleepingMin: settingsSchema.shape.sleepingMin,
    profileName: z.string().trim().min(1).max(100).default("Learning"),
    featurePreset: settingsSchema.shape.featurePreset,
    setupToken: z.string().max(200).optional(),
    demo: z.boolean().default(false),
  })
  .refine((v) => v.sleepingMin > v.wakingMin, {
    message: "Sleeping time must be after waking time.",
    path: ["sleepingMin"],
  });
export const goalTypes = [
  "daily",
  "weekly",
  "recurring",
  "adaptive",
  "milestone",
] as const;
export const taskStatuses = [
  "pending",
  "in_progress",
  "partial",
  "completed",
  "deferred",
  "skipped",
  "cancelled",
  "unverified",
] as const;
export const eventKinds = [
  "started",
  "paused",
  "resumed",
  "progress",
  "completed",
  "deferred",
  "skipped",
  "cancelled",
  "correction",
] as const;
export const notificationTypes = [
  "plan_ready",
  "upcoming",
  "task_reminder",
  "deadline",
  "overdue",
  "daily_review",
  "weekly_review",
  "streak_at_risk",
  "schedule_changed",
  "feasibility",
  "backup_failed",
  "worker_unhealthy",
] as const;
export const profileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  icon: z.string().max(40).default("BookOpen"),
  color: z
    .enum(["teal", "violet", "rose", "ochre", "olive", "slate", "sky", "clay"])
    .default("teal"),
  sortOrder: z.number().int().min(0).default(0),
});
export const skillSchema = z.object({
  profileId: idSchema,
  name: z.string().trim().min(1).max(100),
  priority: z.number().int().min(1).max(5).nullable().default(null),
  usePriority: z.enum(["inherit", "on", "off"]).default("inherit"),
  dailyTargetMin: z.number().int().min(0).max(960).default(30),
  weeklyTargetMin: z.number().int().min(0).max(6720).default(150),
  maxDailyMin: z.number().int().min(0).max(960).default(180),
  availableDays: z.array(weekdaySchema).default([1, 2, 3, 4, 5, 6]),
  windows: z.array(windowSchema).default([]),
  sortOrder: z.number().int().min(0).default(0),
});
export const goalSchema = z
  .object({
    skillId: idSchema,
    type: z.enum(goalTypes),
    title: z.string().trim().min(1).max(200),
    unit: z.string().trim().min(1).max(24).default("minutes"),
    targetQty: z.number().positive().max(1000000),
    startDate: dateSchema,
    dueDate: dateSchema.nullable().default(null),
    priority: z.number().int().min(1).max(5).nullable().default(null),
    usePriority: z.enum(["inherit", "on", "off"]).default("inherit"),
    scheduleMode: z.enum(["daily", "weekly", "combined"]).default("combined"),
    estMinutes: z.number().int().min(5).max(960).default(30),
    availableDays: z.array(weekdaySchema).default([1, 2, 3, 4, 5, 6]),
    rrule: z.string().max(1000).nullable().default(null),
    sortOrder: z.number().int().min(0).default(0),
  })
  .refine((v) => !v.dueDate || v.dueDate >= v.startDate, {
    message: "Deadline must be on or after the start date.",
    path: ["dueDate"],
  })
  .refine((v) => v.type !== "recurring" || Boolean(v.rrule?.trim()), {
    message: "Choose a recurrence rule for this goal.",
    path: ["rrule"],
  })
  .refine(
    (v) =>
      !["percent", "percentage", "%"].includes(v.unit.toLowerCase()) ||
      v.targetQty <= 100,
    { message: "A percentage target cannot exceed 100.", path: ["targetQty"] },
  );
export const resourceTypes = ["course", "book", "lab", "project"] as const;
export const resourceItemKinds = [
  "chapter",
  "section",
  "video",
  "reading",
  "lab",
  "project",
  "revision",
  "task",
] as const;
const safeUrl = z
  .url()
  .refine(
    (value) => ["http:", "https:"].includes(new URL(value).protocol),
    "Use an HTTP or HTTPS address.",
  )
  .nullable()
  .default(null);
export const resourceSchema = z.object({
  skillId: idSchema,
  goalId: idSchema.nullable().default(null),
  goalIds: z.array(idSchema).max(100).default([]),
  type: z.enum(resourceTypes),
  title: z.string().trim().min(1).max(200),
  url: safeUrl,
  notesRef: z.string().max(1000).nullable().default(null),
});
export const resourceItemSchema = z
  .object({
    parentItemId: idSchema.nullable().default(null),
    ordinal: z.number().int().min(0).default(0),
    title: z.string().trim().min(1).max(200),
    kind: z.enum(resourceItemKinds).default("task"),
    estMinutes: z.number().int().min(0).max(100000).default(30),
    durationMin: z
      .number()
      .int()
      .positive()
      .max(100000)
      .nullable()
      .default(null),
    qty: z.number().positive().max(1000000).default(1),
    url: safeUrl,
    pagesFrom: z.number().int().positive().nullable().default(null),
    pagesTo: z.number().int().positive().nullable().default(null),
    dependsOn: z.array(idSchema).max(200).default([]),
  })
  .superRefine((v, ctx) => {
    if (
      (v.pagesFrom === null) !== (v.pagesTo === null) ||
      (v.pagesFrom !== null && v.pagesTo !== null && v.pagesTo < v.pagesFrom)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Enter both page numbers with the last page at or after the first.",
        path: ["pagesTo"],
      });
    if (!["chapter", "section"].includes(v.kind) && v.estMinutes <= 0)
      ctx.addIssue({
        code: "custom",
        message: "Work items need a positive time estimate.",
        path: ["estMinutes"],
      });
  });
export const taskSchema = z
  .object({
    goalId: idSchema,
    title: z.string().trim().min(1).max(200),
    estMinutes: z.number().int().min(1).max(960),
    qty: z.number().positive().max(1000000).default(1),
    earliestDate: dateSchema,
    dueDate: dateSchema.nullable().default(null),
    supportsSplit: z.boolean().default(true),
    itemId: idSchema.nullable().default(null),
    dependsOn: z.array(idSchema).max(200).default([]),
    sortOrder: z.number().int().min(0).default(0),
  })
  .refine((v) => !v.dueDate || v.dueDate >= v.earliestDate, {
    message: "Deadline must be on or after the earliest date.",
    path: ["dueDate"],
  });
export const progressInputSchema = z
  .object({
    clientEventId: idSchema,
    kind: z.enum(eventKinds),
    occurredAt: z.iso.datetime({ offset: true }),
    minutes: z.number().nonnegative().max(1000000).default(0),
    qty: z.number().nonnegative().max(1000000).default(0),
    note: z.string().max(4000).default(""),
    toDate: dateSchema.optional(),
    referenceEventId: idSchema.optional(),
    explicitCorrection: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.kind !== 'completed' && v.minutes > 1440)
      ctx.addIssue({ code: 'custom', message: 'Log at most 1440 additional minutes in one event.', path: ['minutes'] });
    if (v.kind === "deferred" && !v.toDate)
      ctx.addIssue({
        code: "custom",
        message: "Choose a date to defer this task.",
        path: ["toDate"],
      });
    if (v.referenceEventId && v.kind !== "correction")
      ctx.addIssue({
        code: "custom",
        message: "Only corrections can reference an earlier event.",
        path: ["referenceEventId"],
      });
  });
export type ProgressInput = z.infer<typeof progressInputSchema>;
export const slotSchema = z
  .object({
    date: dateSchema,
    startMin: minuteSchema,
    endMin: minuteSchema,
    layer: z
      .enum(["unavailable", "fixed", "pinned", "reserved", "flexible"])
      .default("flexible"),
    title: z.string().trim().min(1).max(200),
    profileId: idSchema.nullable().default(null),
    skillId: idSchema.nullable().default(null),
    goalId: idSchema.nullable().default(null),
    taskId: idSchema.nullable().default(null),
    pinned: z.boolean().default(false),
  })
  .refine((v) => v.endMin > v.startMin, {
    message: "End time must be after start time.",
    path: ["endMin"],
  });
export type Entity = {
  id: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  isDemo?: boolean;
};
export type Profile = Entity & z.infer<typeof profileSchema>;
export type Skill = Entity & z.infer<typeof skillSchema>;
export type Goal = Entity &
  z.infer<typeof goalSchema> & {
    status: "active" | "paused" | "completed" | "archived";
    progressQty: number;
    progressMinutes: number;
    ruleVersion: number;
  };
export type Task = Entity &
  z.infer<typeof taskSchema> & {
    status: (typeof taskStatuses)[number];
    remainingMinutes: number;
    completedQty: number;
    actualMinutes: number;
    timerStartedAt: string | null;
    timerAccumulatedMinutes: number;
    timerElapsedMinutes: number;
    deferredToDate: string | null;
    periodKey: string;
    manualOverride: boolean;
    overdue?: boolean;
    unverified?: boolean;
  };
export type ProgressEvent = {
  id: string;
  sequence: number;
  taskId: string | null;
  goalId: string;
  kind: (typeof eventKinds)[number];
  minutes: number;
  qty: number;
  reportedTotalMinutes: number | null;
  reportedTotalQty: number | null;
  occurredAt: string;
  localDate: string;
  clientEventId: string;
  note: string;
  referenceEventId: string | null;
  toDate: string | null;
  createdAt: string;
  timezone?: string;
  ruleVersionId?: string | null;
};
export type GoalRuleVersion = {
  id: string;
  version: number;
  effectiveFrom: string;
  rules: z.infer<typeof goalSchema>;
  createdAt: string;
};
export type Resource = Entity & z.infer<typeof resourceSchema>;
export type ResourceItem = Entity &
  z.infer<typeof resourceItemSchema> & { resourceId: string };
export type TimeSlot = Entity &
  z.infer<typeof slotSchema> & { version: number; templateId: string | null; occurrenceId?: string | null; recurrenceSeriesId?: string; originalDate?: string; virtual?: boolean };
export type PlanItem = {
  taskId: string;
  goalId: string;
  skillId: string;
  date: string;
  startMin: number;
  endMin: number;
  minutes: number;
  score: number;
  explanation: string;
  pinned?: boolean;
};
export type PlanVersion = {
  id: string;
  planId: string;
  version: number;
  status: "proposed" | "active" | "discarded" | "superseded";
  generatedAt: string;
  algoVersion: string;
  inputsHash: string;
  reason: string;
  items: PlanItem[];
  unplaced: { taskId: string; reason: string; code: string }[];
  warnings: {
    goalId?: string;
    code: string;
    message: string;
    shortfallMin?: number;
  }[];
  changes: unknown;
  acceptedAt: string | null;
};
export type StreakRecord = {
  id: string;
  periodStart: string;
  periodEnd: string;
  result: "met" | "missed" | "rest" | "paused" | "grace" | "unverified";
  reason: string;
  value: number;
  ruleVersion: number;
};
export type Streak = Entity & {
  scope: "goal" | "skill" | "profile" | "global";
  scopeId: string | null;
  title: string;
  measure: "minutes" | "quantity" | "completions";
  threshold: number;
  period: "day" | "week";
  eligibleDays: number[];
  countPartial: boolean;
  gracePerMonth: number;
  ruleVersion: number;
  current: number;
  best: number;
  records: StreakRecord[];
};
export type Notification = {
  id: string;
  channel: "ntfy" | "telegram";
  type: (typeof notificationTypes)[number];
  title: string;
  body: string;
  scheduledFor: string;
  status:
    "pending" | "sent" | "failed" | "suppressed_quiet_hours" | "cancelled";
  attempts: {
    id: string;
    attemptedAt: string;
    outcome: string;
    httpStatus: number | null;
  }[];
};
export type Review = {
  id: string;
  date: string;
  kind: "daily" | "weekly";
  status: "draft" | "confirmed" | "unverified";
  summary: unknown;
  confirmedAt: string | null;
};
export type User = { id: string; email: string; settings: Settings };
export type Bootstrap = {
  user: User;
  profiles: Profile[];
  skills: Skill[];
  goals: Goal[];
  tasks: Task[];
  resources: Resource[];
  resourceItems: ResourceItem[];
  slots: TimeSlot[];
  plans: PlanVersion[];
  streaks: Streak[];
  notifications: Notification[];
  reviews: Review[];
  studyDate: string;
};
export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
};

export const reminderOwnerTypes = ["task", "goal", "slot", "global"] as const;
export const reminderRuleSchema = z
  .object({
    ownerType: z.enum(reminderOwnerTypes),
    ownerId: idSchema.nullable().default(null),
    type: z.enum(notificationTypes).default("task_reminder"),
    atLocal: clockMinuteSchema.nullable().default(null),
    offsetMin: z.number().int().min(-10080).max(10080).nullable().default(null),
    repeatPolicy: z.enum(["once", "until_completed"]).default("once"),
    enabled: z.boolean().default(true),
    channel: z.literal("ntfy").default("ntfy"),
  })
  .superRefine((value, ctx) => {
    if (value.ownerType !== "global" && !value.ownerId)
      ctx.addIssue({
        code: "custom",
        message: "Choose the task, goal or slot for this reminder.",
        path: ["ownerId"],
      });
    if ((value.atLocal === null) === (value.offsetMin === null))
      ctx.addIssue({
        code: "custom",
        message: "Choose either a local reminder time or an offset.",
        path: ["atLocal"],
      });
  });
export type ReminderRule = Entity & z.infer<typeof reminderRuleSchema>;
export type TodayResponse = {
  review?: {state:string;summary:unknown;closedAt:string|null}|null;
  unverifiedReviews?:string[];
  proposalCount?:number;
  tomorrowFirst?:TimeSlot|null;
  studyDate: string;
  tasks: Task[];
  slots: TimeSlot[];
  goals: Goal[];
  weekly: { minutes: number; bySkill: { skillId: string; minutes: number }[] };
  notifications: Notification[];
};

const timezoneSchema = settingsSchema.shape.timezone;
export const classDetailsSchema = z.object({ type: z.enum(['lecture', 'lab']), slot: z.string().trim().max(40).default('') });
export const recurrenceSeriesSchema = z.object({
  kind: z.enum(['fixed', 'goal']).default('fixed'),
  goalId: idSchema.nullable().default(null),
  skillId: idSchema.nullable().default(null),
  profileId: idSchema.nullable().default(null),
  title: z.string().trim().min(1).max(200),
  classDetails: classDetailsSchema.nullable().default(null),
  rrule: z.string().trim().min(1).max(1000),
  dtstartLocal: dateSchema,
  tz: timezoneSchema.default('Asia/Kolkata'),
  until: dateSchema.nullable().default(null),
  startMin: clockMinuteSchema.nullable().default(null),
  estMinutes: z.number().int().min(1).max(960).default(30),
  qty: z.number().positive().max(1000000).default(1),
  unit: z.string().trim().min(1).max(24).default('minutes'),
  layer: z.enum(['fixed', 'unavailable']).default('fixed'),
}).superRefine((value, context) => {
  if (value.until && value.until < value.dtstartLocal) context.addIssue({ code: 'custom', message: 'End after the series anchor.', path: ['until'] });
  if (value.kind === 'goal' && !value.goalId) context.addIssue({ code: 'custom', message: 'Choose a goal.', path: ['goalId'] });
  if (value.kind === 'fixed' && (value.startMin === null || value.startMin + value.estMinutes > 1440)) context.addIssue({ code: 'custom', message: 'Choose a time and duration within one calendar day.', path: ['startMin'] });
  if (value.classDetails && value.kind !== 'fixed') context.addIssue({ code: 'custom', message: 'Classes and labs are fixed commitments.', path: ['classDetails'] });
});
const classRowSchema = z.object({
  id: idSchema.optional(), version: z.number().int().positive().optional(),
  course: z.string().trim().min(1).max(200), type: z.enum(['lecture', 'lab']), slot: z.string().trim().max(40).default(''),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startMin: clockMinuteSchema, estMinutes: z.number().int().min(1).max(960),
}).superRefine((row, context) => {
  if (row.id && !row.version) context.addIssue({ code: 'custom', message: 'Reload this meeting before editing.', path: ['version'] });
  if (new Set(row.weekdays).size !== row.weekdays.length) context.addIssue({ code: 'custom', message: 'Choose each weekday once.', path: ['weekdays'] });
  if (row.startMin + row.estMinutes > 1440) context.addIssue({ code: 'custom', message: 'Finish within the same calendar day.', path: ['estMinutes'] });
});
export const classTimetableSchema = z.object({
  requestId: idSchema, startDate: dateSchema, endDate: dateSchema, effectiveFrom: dateSchema,
  rows: z.array(classRowSchema).max(100), removed: z.array(z.object({ id: idSchema, version: z.number().int().positive() })).max(100).default([]),
}).superRefine((value, context) => {
  if (value.endDate < value.startDate || value.endDate < value.effectiveFrom) context.addIssue({ code: 'custom', message: 'The semester must end after its start and the change date.', path: ['endDate'] });
  const ids = [...value.rows.flatMap(row => row.id ? [row.id] : []), ...value.removed.map(row => row.id)];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Each existing meeting can be changed once.', path: ['rows'] });
  if (!value.rows.length && !value.removed.length) context.addIssue({ code: 'custom', message: 'Add a class or lab meeting.', path: ['rows'] });
});
export type ClassTimetableInput = z.infer<typeof classTimetableSchema>;
export const classDaySchema = z.object({ requestId: idSchema, date: dateSchema, weekday: z.number().int().min(1).max(7) });
/** Only simple weekly rules can be edited without losing a custom calendar pattern. */
export function classWeekdays(rule: string, anchor: string): number[] | null {
  const codes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const pairs = rule.replace(/^RRULE:/, '').split(';').map(part => part.split('='));
  if (pairs.some(pair => pair.length !== 2) || new Set(pairs.map(pair => pair[0])).size !== pairs.length) return null;
  const parts: Record<string, string> = Object.fromEntries(pairs);
  if (parts.FREQ !== 'WEEKLY' || Number(parts.INTERVAL || 1) !== 1 || Object.keys(parts).some(key => !['FREQ', 'INTERVAL', 'BYDAY', 'WKST'].includes(key))) return null;
  if (parts.WKST && !codes.includes(parts.WKST)) return null;
  const days = parts.BYDAY ? parts.BYDAY.split(',').map(code => codes.indexOf(code) + 1) : [new Date(`${dateSchema.parse(anchor)}T12:00:00Z`).getUTCDay() || 7];
  return days.some(day => day < 1) || new Set(days).size !== days.length ? null : days.sort((a, b) => a - b);
}
const occurrenceFieldsSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), startMin: clockMinuteSchema.optional(), estMinutes: z.number().int().min(1).max(960).optional(), qty: z.number().positive().max(1000000).optional() }).strict();
export const recurrenceExceptionSchema = z.discriminatedUnion('kind', [
  z.object({ date: dateSchema, kind: z.literal('skip') }),
  z.object({ date: dateSchema, kind: z.literal('move'), toDate: dateSchema, toStartMin: clockMinuteSchema.optional(), override: occurrenceFieldsSchema.optional() }),
  z.object({ date: dateSchema, kind: z.literal('modify'), override: occurrenceFieldsSchema }),
]);
export type RecurrenceSeries = Entity & z.infer<typeof recurrenceSeriesSchema> & { status: 'active' | 'paused' | 'ended'; version: number; effectiveFrom: string; ruleVersionId: string | null; pausedRanges: { start: string; end?: string | null }[] };
export type ClassTimetableResult = { rows: RecurrenceSeries[]; reused: boolean };
export type ClassDayResult = { date: string; weekday: number; added: number; removed: number; reused: boolean };
export type ClassDayPreview = { weekday: number | null; meetings: { id: string; title: string; startMin: number; endMin: number }[] };
export const deletionKindSchema = z.enum(['goal', 'goal-history', 'schedule', 'template']);
export type DeletionKind = z.infer<typeof deletionKindSchema>;
export type DeletionPreview = { kind: DeletionKind; id: string; title: string; token: string; taskIds: string[]; counts: { label: string; count: number }[] };
export type DeletionResult = { deleted: true; kind: DeletionKind; id: string; taskIds: string[] };
export type Occurrence = { id: string; seriesId: string; originalDate: string; localDate: string; status: 'scheduled' | 'suppressed' | 'conflict'; fields: { title: string; startMin?: number; estMinutes: number; qty: number }; manualOverride: boolean; moved: boolean; adjusted: boolean; ambiguous: boolean; tasks: Task[]; slot: TimeSlot | null; series: RecurrenceSeries; conflict: unknown; virtual?: boolean };
export const holidaySchema = z.object({ date: dateSchema, title: z.string().trim().min(1).max(200) });
export type Holiday = Entity & z.infer<typeof holidaySchema>;
export const templateEntrySchema = z.object(slotSchema.shape).omit({ date: true, taskId: true }).extend({ weekday: weekdaySchema }).refine(value => value.endMin > value.startMin, { message: 'End time must be after start time.', path: ['endMin'] });
export const scheduleTemplateSchema = z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(['week', 'day']).default('week'), entries: z.array(templateEntrySchema).min(1).max(100) });
export type ScheduleTemplate = Entity & z.infer<typeof scheduleTemplateSchema> & { version: number };
