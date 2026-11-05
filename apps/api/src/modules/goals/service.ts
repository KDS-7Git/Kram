import { goalSchema, dateSchema } from "@kram/shared";
import type { Goal,GoalProgressCache } from "@prisma/client";
import { validateRRule } from "@kram/recurrence";
import { db } from "../../db";
import { ApiError } from "../../errors";
import {
  newId,
  json,
  notFound,
  ownerWhere,
  lockOwner,
  type Connection,
} from "../../repository";
import { skills, profiles } from "../hierarchy/service";
import { calendarDate, calendarString, currentStudyDate } from "../../calendar";
import { materializeTasks } from '../tasks/materialization';

export const goalDto = (row: Goal & {progressCache?:GoalProgressCache|null}) => ({
  ...row,
  startDate: calendarString(row.startDate),
  dueDate: row.dueDate ? calendarString(row.dueDate) : null,
  progressQty: row.progressCache?.qty??0,
  progressMinutes: row.progressCache?.minutes??0,
});
export async function activeSkill(
  userId: string,
  skillId: string,
  c: Connection = db,
) {
  const skill = await skills.get(userId, skillId, c);
  const profile = await profiles.get(userId, skill.profileId, c);
  if (skill.archivedAt || profile.archivedAt)
    throw new ApiError(
      "ARCHIVED_PARENT",
      "Restore the skill and profile before adding work.",
      409,
    );
  return skill;
}
function validateRule(value: string | null): string | null {
  if (value === null) return null;
  try {
    return validateRRule(value);
  } catch (error) {
    throw new ApiError(
      "VALIDATION_FAILED",
      "Choose a valid recurrence rule.",
      400,
      [{ path: ["rrule"], message: error instanceof Error ? error.message : "Use a valid RFC 5545 RRULE." }],
    );
  }
}
export const goals = {
  async list(userId: string, includeArchived = false, c: Connection = db) {
    return c.goal.findMany({
      where: {
        ...ownerWhere(userId),
        ...(includeArchived
          ? {}
          : {
              archivedAt: null,
              skill: { archivedAt: null, profile: { archivedAt: null } },
            }),
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      include:{progressCache:true},
    });
  },
  async get(userId: string, id: string, c: Connection = db) {
    return notFound(
      await c.goal.findFirst({ where: { id, ...ownerWhere(userId) },include:{progressCache:true} }),
      "goal",
    );
  },
  async create(userId: string, input: unknown) {
    const data = goalSchema.parse(input);
    data.rrule = validateRule(data.rrule);
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      await activeSkill(userId, data.skillId, tx);
      const row = await tx.goal.create({
        data: {
          ...data,
          id: newId(),
          userId,
          startDate: calendarDate(data.startDate),
          dueDate: data.dueDate ? calendarDate(data.dueDate) : null,
        },
      });
      await tx.goalRuleVersion.create({
        data: {
          id: newId(),
          userId,
          goalId: row.id,
          version: 1,
          effectiveFrom: calendarDate(data.startDate),
          rules: json(data),
        },
      });
      await materializeTasks(userId, undefined, tx);
      return goalDto(row);
    });
  },
  async edit(userId: string, id: string, input: Record<string, unknown>) {
    const today = await currentStudyDate(userId);
    const effectiveFrom = "effectiveFrom" in input
      ? dateSchema.parse(input.effectiveFrom)
      : today;
    if (effectiveFrom < today)
      throw new ApiError(
        "HISTORY_PROTECTED",
        "A rule change must start today or later; past rules stay unchanged.",
        409,
      );
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const current = await this.get(userId, id, tx);
      const effective = await this.rulesForDate(userId, id, effectiveFrom, tx);
      const earliest = effective ? null : await tx.goalRuleVersion.findFirst({
        where: { goalId: id, userId },
        orderBy: [{ effectiveFrom: "asc" }, { version: "asc" }],
      });
      const before = goalSchema.parse(effective?.rules ?? earliest?.rules ?? goalDto(current));
      // Display metadata changes immediately without importing a scheduled future target.
      const data = goalSchema.parse({ ...before, title: current.title, sortOrder: current.sortOrder, ...input });
      data.rrule = validateRule(data.rrule);
      if ('unit' in input && data.unit.toLowerCase() !== current.unit.toLowerCase() && await tx.task.count({ where: { userId, goalId: id } }))
        throw new ApiError('UNIT_HISTORY_PROTECTED', 'Create a new goal to use another unit after tasks exist; recorded quantities keep their original unit.', 409);
      if (data.skillId !== current.skillId) {
        await activeSkill(userId, data.skillId, tx);
        if (await tx.goalResource.count({ where: { goalId: id, userId } }))
          throw new ApiError(
            "RESOURCE_LINK_CONFLICT",
            "Unlink this goal’s resources before moving it to another skill.",
            409,
          );
      }
      if (JSON.stringify({ ...before, title: current.title, sortOrder: current.sortOrder }) === JSON.stringify(data))
        return goalDto(current);
      const version = current.ruleVersion + 1;
      await tx.goalRuleVersion.create({
        data: {
          id: newId(),
          userId,
          goalId: id,
          version,
          effectiveFrom: calendarDate(effectiveFrom),
          rules: json(data),
        },
      });
      const latest = await tx.goalRuleVersion.findFirstOrThrow({
        where: { goalId: id, userId },
        orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
      });
      const latestData = goalSchema.parse(latest.rules);
      const row = await tx.goal.update({
        where: { id, userId },
        data: {
          ...latestData,
          title: data.title,
          sortOrder: data.sortOrder,
          ruleVersion: version,
          startDate: calendarDate(latestData.startDate),
          dueDate: latestData.dueDate ? calendarDate(latestData.dueDate) : null,
        },
      });
      await materializeTasks(userId, undefined, tx);
      return goalDto(row);
    });
  },
  async status(
    userId: string,
    id: string,
    status: "active" | "paused" | "archived",
  ) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const current = await this.get(userId, id, tx);
      if (current.archivedAt && status !== "archived")
        throw new ApiError(
          "GOAL_ARCHIVED",
          "This goal is archived. Create a new goal to plan new work.",
          409,
        );
      const row = await tx.goal.update({
        where: { id, userId },
        data: { status, ...(status === "archived" ? { archivedAt: current.archivedAt ?? new Date() } : {}) },include:{progressCache:true},
      });
      await materializeTasks(userId, undefined, tx);
      return goalDto(row);
    });
  },
  async rulesForDate(userId: string, id: string, date: string, c: Connection = db) {
    await this.get(userId, id, c);
    const row = await c.goalRuleVersion.findFirst({
      where: { goalId: id, ...ownerWhere(userId), effectiveFrom: { lte: calendarDate(dateSchema.parse(date)) } },
      orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
    });
    return row ? { ...row, effectiveFrom: calendarString(row.effectiveFrom), rules: goalSchema.parse(row.rules) } : null;
  },
  async rules(userId: string, id: string) {
    await this.get(userId, id);
    const rows = await db.goalRuleVersion.findMany({
      where: { goalId: id, ...ownerWhere(userId) },
      orderBy: { version: "asc" },
    });
    return rows.map((row) => ({
      ...row,
      effectiveFrom: calendarString(row.effectiveFrom),
    }));
  },
};

export async function rulesForDate(
  userId: string,
  id: string,
  date: string,
  c: Connection = db,
) {
  return goals.rulesForDate(userId, id, date, c);
}
