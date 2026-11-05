import { z } from 'zod';

export const dateSchema = z.iso.date();
export const idSchema = z.uuid();
export const minuteSchema = z.number().int().min(0).max(1440);
export const clockMinuteSchema = z.number().int().min(0).max(1439);
export const weekdaySchema = z.number().int().min(1).max(7);
export const windowSchema = z.object({ days: z.array(weekdaySchema).min(1), startMin: minuteSchema, endMin: minuteSchema }).refine(v => v.endMin > v.startMin, 'End time must be after start time.');
export const settingsSchema = z.object({
  timezone: z.string().refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Choose a valid IANA timezone.').default('Asia/Kolkata'),
  dayRollover: clockMinuteSchema.default(240), weekStart: z.union([z.literal(1),z.literal(7)]).default(1),
  wakingMin: clockMinuteSchema.default(420), sleepingMin: minuteSchema.default(1380),
  maxDailyMin: z.number().int().min(15).max(960).default(360), maxWeeklyMin: z.number().int().min(15).max(6720).default(1800),
  minFreeMin: z.number().int().min(0).max(360).default(60), minBreakMin: z.number().int().min(0).max(120).default(10),
  breakAfterMin: z.number().int().min(15).max(240).default(60), minChunkMin: z.number().int().min(5).max(120).default(15),
  restDays: z.array(weekdaySchema).default([7]), horizonDays: z.number().int().min(1).max(21).default(14),
  planningMode: z.enum(['directed','adaptive','balanced','deadline']).default('directed'), usePriority: z.boolean().default(false),
  theme: z.enum(['system','light','dark','scheduled']).default('system'), density: z.enum(['comfortable','compact']).default('comfortable'),
  motion: z.enum(['system','reduced','full']).default('system'), featurePreset: z.enum(['simple','planner','full']).default('planner'),
  clockFormat: z.enum(['12','24']).default('24'), quietMode: z.boolean().default(false), gracePerMonth: z.number().int().min(0).max(10).default(0),
  quietHours: z.object({ startMin: clockMinuteSchema.default(1320), endMin: clockMinuteSchema.default(420) }).default({ startMin: 1320,endMin: 420 }),
  notificationsEnabled: z.boolean().default(false), notificationPrivacy: z.boolean().default(true), dailyReviewMin: clockMinuteSchema.default(1260), planReadyMin: clockMinuteSchema.default(420),
  allowUrgentDuringQuiet: z.boolean().default(false), sound: z.boolean().default(false), haptics: z.boolean().default(false)
}).refine(v => v.sleepingMin > v.wakingMin, {message:'Sleeping time must be after waking time.',path:['sleepingMin']});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = settingsSchema.parse({});
export const loginSchema=z.object({email:z.string().trim().email().max(254),password:z.string().min(12,'Use at least 12 characters.').max(1024)});
export const setupSchema=loginSchema.extend({timezone:settingsSchema.shape.timezone,dayRollover:settingsSchema.shape.dayRollover,wakingMin:settingsSchema.shape.wakingMin,sleepingMin:settingsSchema.shape.sleepingMin,profileName:z.string().trim().min(1).max(100).default('Learning'),featurePreset:settingsSchema.shape.featurePreset,setupToken:z.string().max(200).optional(),demo:z.boolean().default(false)}).refine(v=>v.sleepingMin>v.wakingMin,{message:'Sleeping time must be after waking time.',path:['sleepingMin']});
export const goalTypes = ['daily','weekly','recurring','adaptive','milestone'] as const;
export const taskStatuses = ['pending','in_progress','partial','completed','deferred','skipped','cancelled','unverified'] as const;
export const eventKinds = ['started','paused','resumed','progress','completed','deferred','skipped','cancelled','correction'] as const;
export const notificationTypes = ['plan_ready','upcoming','task_reminder','deadline','overdue','daily_review','weekly_review','streak_at_risk','schedule_changed','feasibility','backup_failed','worker_unhealthy'] as const;
export const profileSchema = z.object({ name:z.string().trim().min(1).max(100),icon:z.string().max(40).default('BookOpen'),color:z.enum(['teal','violet','rose','ochre','olive','slate','sky','clay']).default('teal'),sortOrder:z.number().int().min(0).default(0) });
export const skillSchema = z.object({ profileId:idSchema,name:z.string().trim().min(1).max(100),priority:z.number().int().min(1).max(5).nullable().default(null),usePriority:z.enum(['inherit','on','off']).default('inherit'),dailyTargetMin:z.number().int().min(0).max(960).default(30),weeklyTargetMin:z.number().int().min(0).max(6720).default(150),maxDailyMin:z.number().int().min(0).max(960).default(180),availableDays:z.array(weekdaySchema).default([1,2,3,4,5,6]),windows:z.array(windowSchema).default([]),sortOrder:z.number().int().min(0).default(0) });
export const goalSchema = z.object({ skillId:idSchema,type:z.enum(goalTypes),title:z.string().trim().min(1).max(200),unit:z.string().trim().min(1).max(24).default('minutes'),targetQty:z.number().positive().max(1000000),startDate:dateSchema,dueDate:dateSchema.nullable().default(null),priority:z.number().int().min(1).max(5).nullable().default(null),usePriority:z.enum(['inherit','on','off']).default('inherit'),scheduleMode:z.enum(['daily','weekly','combined']).default('combined'),estMinutes:z.number().int().min(5).max(960).default(30),availableDays:z.array(weekdaySchema).default([1,2,3,4,5,6]),rrule:z.string().max(1000).nullable().default(null),sortOrder:z.number().int().min(0).default(0) }).refine(v=> !v.dueDate||v.dueDate>=v.startDate,{message:'Deadline must be on or after the start date.',path:['dueDate']});
export const taskSchema = z.object({goalId:idSchema,title:z.string().trim().min(1).max(200),estMinutes:z.number().int().min(1).max(960),qty:z.number().positive().max(1000000).default(1),earliestDate:dateSchema,dueDate:dateSchema.nullable().default(null),supportsSplit:z.boolean().default(true),itemId:idSchema.nullable().default(null),sortOrder:z.number().int().min(0).default(0)}).refine(v=>!v.dueDate||v.dueDate>=v.earliestDate,{message:'Deadline must be on or after the earliest date.',path:['dueDate']});
export const progressInputSchema = z.object({clientEventId:idSchema,kind:z.enum(eventKinds),occurredAt:z.iso.datetime({offset:true}),minutes:z.number().nonnegative().max(1440).default(0),qty:z.number().nonnegative().max(1000000).default(0),note:z.string().max(4000).default(''),toDate:dateSchema.optional(),referenceEventId:idSchema.optional(),explicitCorrection:z.boolean().default(false)}).superRefine((v,ctx)=>{if(v.kind==='deferred'&&!v.toDate)ctx.addIssue({code:'custom',message:'Choose a date to defer this task.',path:['toDate']});if(v.referenceEventId&&v.kind!=='correction')ctx.addIssue({code:'custom',message:'Only corrections can reference an earlier event.',path:['referenceEventId']});});
export type ProgressInput = z.infer<typeof progressInputSchema>;
export const slotSchema = z.object({date:dateSchema,startMin:minuteSchema,endMin:minuteSchema,layer:z.enum(['unavailable','fixed','pinned','reserved','flexible']).default('flexible'),title:z.string().trim().min(1).max(200),profileId:idSchema.nullable().default(null),skillId:idSchema.nullable().default(null),goalId:idSchema.nullable().default(null),taskId:idSchema.nullable().default(null),pinned:z.boolean().default(false)}).refine(v=>v.endMin>v.startMin,{message:'End time must be after start time.',path:['endMin']});
export type Entity = {id:string;createdAt:string;updatedAt:string;archivedAt?:string|null;isDemo?:boolean};
export type Profile = Entity & z.infer<typeof profileSchema>;
export type Skill = Entity & z.infer<typeof skillSchema>;
export type Goal = Entity & z.infer<typeof goalSchema> & {status:'active'|'paused'|'completed'|'archived';progressQty:number;progressMinutes:number;ruleVersion:number};
export type Task = Entity & z.infer<typeof taskSchema> & {status:typeof taskStatuses[number];remainingMinutes:number;completedQty:number;actualMinutes:number;timerStartedAt:string|null;periodKey:string;overdue?:boolean;unverified?:boolean};
export type ProgressEvent = {id:string;taskId:string|null;goalId:string;kind:typeof eventKinds[number];minutes:number;qty:number;occurredAt:string;localDate:string;clientEventId:string;note:string;referenceEventId:string|null;toDate:string|null;createdAt:string};
export type Resource = Entity & {skillId:string;goalId:string|null;type:'course'|'book'|'lab'|'project';title:string;url:string|null;notesRef:string|null};
export type ResourceItem = Entity & {resourceId:string;parentItemId:string|null;ordinal:number;title:string;kind:string;estMinutes:number;qty:number;url:string|null;pagesFrom:number|null;pagesTo:number|null;dependsOn:string[]};
export type TimeSlot = Entity & z.infer<typeof slotSchema> & {version:number;templateId:string|null};
export type PlanItem = {taskId:string;goalId:string;skillId:string;date:string;startMin:number;endMin:number;minutes:number;score:number;explanation:string;pinned?:boolean};
export type PlanVersion = {id:string;planId:string;version:number;status:'proposed'|'active'|'discarded'|'superseded';generatedAt:string;algoVersion:string;inputsHash:string;reason:string;items:PlanItem[];unplaced:{taskId:string;reason:string;code:string}[];warnings:{goalId?:string;code:string;message:string;shortfallMin?:number}[];changes:unknown;acceptedAt:string|null};
export type StreakRecord = {id:string;periodStart:string;periodEnd:string;result:'met'|'missed'|'rest'|'paused'|'grace'|'unverified';reason:string;value:number;ruleVersion:number};
export type Streak = Entity & {scope:'goal'|'skill'|'profile'|'global';scopeId:string|null;title:string;measure:'minutes'|'quantity'|'completions';threshold:number;period:'day'|'week';eligibleDays:number[];countPartial:boolean;gracePerMonth:number;ruleVersion:number;current:number;best:number;records:StreakRecord[]};
export type Notification = {id:string;channel:'ntfy'|'telegram';type:typeof notificationTypes[number];title:string;body:string;scheduledFor:string;status:'pending'|'sent'|'failed'|'suppressed_quiet_hours'|'cancelled';attempts:{id:string;attemptedAt:string;outcome:string;httpStatus:number|null}[]};
export type Review = {id:string;date:string;kind:'daily'|'weekly';status:'draft'|'confirmed'|'unverified';summary:unknown;confirmedAt:string|null};
export type User = {id:string;email:string;settings:Settings};
export type Bootstrap = {user:User;profiles:Profile[];skills:Skill[];goals:Goal[];tasks:Task[];resources:Resource[];resourceItems:ResourceItem[];slots:TimeSlot[];plans:PlanVersion[];streaks:Streak[];notifications:Notification[];reviews:Review[];studyDate:string};
export type ApiError = {error:{code:string;message:string;details?:unknown;requestId:string}};
