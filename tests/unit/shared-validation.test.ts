import { describe,it,expect } from 'vitest';
import { settingsSchema,taskSchema,progressInputSchema,minuteSchema } from '@kram/shared';
const id='019a5680-0000-7000-8000-000000000001';
describe('domain validation boundaries',()=>{
  it('distinguishes local clock minutes from an interval ending at midnight',()=>{expect(minuteSchema.safeParse(1440).success).toBe(true);for(const key of ['dayRollover','dailyReviewMin','planReadyMin'])expect(settingsSchema.safeParse({[key]:1440}).success).toBe(false);expect(settingsSchema.safeParse({wakingMin:900,sleepingMin:600}).success).toBe(false);});
  it('rejects impossible task date ranges',()=>{expect(taskSchema.safeParse({goalId:id,title:'Read',estMinutes:30,earliestDate:'2026-11-05',dueDate:'2026-11-04'}).success).toBe(false);});
  it('requires deferral dates and limits references to corrections',()=>{const base={clientEventId:id,occurredAt:'2026-11-05T10:00:00Z'};expect(progressInputSchema.safeParse({...base,kind:'deferred'}).success).toBe(false);expect(progressInputSchema.safeParse({...base,kind:'progress',referenceEventId:id}).success).toBe(false);expect(progressInputSchema.safeParse({...base,kind:'correction',referenceEventId:id}).success).toBe(true);});
});
