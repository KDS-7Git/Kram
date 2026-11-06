import { z } from 'zod';
import { dateSchema, idSchema } from '@kram/shared';
export const streakRuleSchema = z.object({
  measure: z.enum(['minutes', 'quantity', 'completion']).default('minutes'),
  threshold: z.number().positive().max(1000000).default(30),
  period: z.enum(['day', 'week']).default('day'),
  weekStart: z.union([z.literal(1), z.literal(7)]).optional(),
  eligibleDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6, 7]),
  restPolicy: z.enum(['skip', 'miss']).default('skip'),
  countPartial: z.boolean().default(true),
  gracePerMonth: z.number().int().min(0).max(10).default(0),
  unit: z.string().trim().min(1).max(48).optional(),
  restWeekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  pausedRanges: z.array(z.object({ start: dateSchema, end: dateSchema.nullable().optional() }).strict().refine(value => !value.end || value.end >= value.start, 'Pause end must follow its start.')).max(100).default([]),
}).strict().refine(value => new Set(value.eligibleDays).size === value.eligibleDays.length, 'Eligible days must be distinct.');
export const createStreakSchema = z.object({ title: z.string().trim().min(1).max(120), scope: z.enum(['goal', 'skill', 'profile', 'global']), scopeId: idSchema.nullable().optional(), startDate: dateSchema.optional(), rule: streakRuleSchema }).strict();
export const editStreakSchema = z.object({ title: z.string().trim().min(1).max(120).optional(), status: z.enum(['active', 'archived']).optional(), effectiveFrom: dateSchema.optional(), rule: streakRuleSchema.optional() }).strict();
