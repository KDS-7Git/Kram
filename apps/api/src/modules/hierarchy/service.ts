import {
  profileSchema,
  skillSchema,
  settingsSchema,
  type Settings,
} from "@kram/shared";
import type { Prisma,Skill } from "@prisma/client";
import { db } from "../../db";
import { ApiError } from "../../errors";
import { goals, goalDto } from "../goals/service";
import { resources, resourceDto } from "../resources/service";
import { currentStudyDate } from "../../calendar";
import { materializeTasks } from '../tasks/materialization';
import { refreshReminders } from '../notifications/service';
import {
  ownerWhere,
  newId,
  notFound,
  json,
  audit,
  iso,
  lockOwner,
  type Connection,
} from "../../repository";
export const profiles = {
  async list(userId: string, includeArchived = false, c: Connection = db) {
    return c.profile.findMany({
      where: {
        ...ownerWhere(userId),
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
  },
  async get(userId: string, id: string, c: Connection = db) {
    return notFound(
      await c.profile.findFirst({ where: { id, ...ownerWhere(userId) } }),
      "profile",
    );
  },
  async create(userId: string, input: unknown, c: Connection = db) {
    const data = profileSchema.parse(input);
    return c.profile.create({ data: { ...data, id: newId(), userId } });
  },
  async edit(userId: string, id: string, input: unknown) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const current = await this.get(userId, id, tx);
      const data = profileSchema.parse({
        ...current,
        ...(input as Record<string, unknown>),
      });
      return tx.profile.update({ where: { id, userId }, data });
    });
  },
  async archive(userId: string, id: string) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      await this.get(userId, id, tx);
      const row = await tx.profile.update({
        where: { id, userId },
        data: { archivedAt: new Date() },
      });
      await refreshReminders(userId, tx);
      return row;
    });
  },
};
export const skills = {
  async list(userId: string, includeArchived = false, c: Connection = db) {
    return c.skill.findMany({
      where: {
        ...ownerWhere(userId),
        ...(includeArchived
          ? {}
          : { archivedAt: null, profile: { archivedAt: null } }),
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
  },
  async get(userId: string, id: string, c: Connection = db) {
    return notFound(
      await c.skill.findFirst({ where: { id, ...ownerWhere(userId) } }),
      "skill",
    );
  },
  async create(userId: string, input: unknown, c: Connection = db):Promise<Skill> {
    if (c === db)
      return db.$transaction(async (tx) => {
        await lockOwner(tx, userId);
        return this.create(userId, input, tx);
      });
    const data = skillSchema.parse(input);
    const profile = await profiles.get(userId, data.profileId, c);
    if (profile.archivedAt)
      throw new ApiError(
        "ARCHIVED_PARENT",
        "Restore this profile before adding skills.",
        409,
      );
    return c.skill.create({
      data: { ...data, windows: json(data.windows), id: newId(), userId },
    });
  },
  async edit(userId: string, id: string, input: unknown) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const current = await this.get(userId, id, tx);
      const data = skillSchema.parse({
        ...current,
        ...(input as Record<string, unknown>),
      });
      const profile = await profiles.get(userId, data.profileId, tx);
      if (profile.archivedAt && data.profileId !== current.profileId)
        throw new ApiError(
          "ARCHIVED_PARENT",
          "Restore this profile before moving skills into it.",
          409,
        );
      return tx.skill.update({
        where: { id, userId },
        data: { ...data, windows: json(data.windows) },
      });
    });
  },
  async archive(userId: string, id: string) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      await this.get(userId, id, tx);
      const row = await tx.skill.update({
        where: { id, userId },
        data: { archivedAt: new Date() },
      });
      await refreshReminders(userId, tx);
      return row;
    });
  },
};
export async function getUser(userId: string, c: Connection = db) {
  const user = notFound(
    await c.user.findFirst({ where: { id: userId, isOwner: true } }),
    "account",
  );
  return {
    id: user.id,
    email: user.email,
    settings: settingsSchema.parse(user.settings),
  };
}
export async function getSettings(
  userId: string,
  c: Connection = db,
): Promise<Settings> {
  return (await getUser(userId, c)).settings;
}
export async function setSettings(userId: string, input: unknown) {
  return db.$transaction(async (tx) => {
    await lockOwner(tx, userId);
    const current = await getSettings(userId, tx);
    const next = settingsSchema.parse({
      ...current,
      ...(input as Record<string, unknown>),
    });
    await tx.user.update({
      where: { id: userId },
      data: {
        settings: json(next),
        timezone: next.timezone,
        dayRollover: next.dayRollover,
      },
    });
    await audit(
      userId,
      "settings_changed",
      { fields: Object.keys(input as Record<string, unknown>) },
      undefined,
      tx,
    );
    await materializeTasks(userId, undefined, tx);
    return next;
  });
}
export async function hierarchyBootstrap(userId: string) {
  const [{ tasks, taskDto }, { listNotifications }] = await Promise.all([
    import('../tasks/service'), import('../notifications/service'),
  ]);
  const [
    user,
    profileList,
    skillList,
    goalList,
    resourceList,
    items,
    studyDate,
  ] = await Promise.all([
    getUser(userId),
    profiles.list(userId),
    skills.list(userId),
    goals.list(userId),
    resources.list(userId),
    resources.allItems(userId),
    currentStudyDate(userId),
  ]);
  const [taskRows, slotRows, notificationRows, context] = await Promise.all([
    tasks.list(userId),
    db.timeSlot.findMany({ where: { userId, archivedAt: null }, orderBy: [{ date: 'asc' }, { startMin: 'asc' }, { id: 'asc' }] }),
    listNotifications(userId), tasks.context(userId),
  ]);
  return {
    user,
    profiles: iso(profileList),
    skills: iso(skillList),
    goals: iso(goalList.map(goalDto)),
    tasks: iso(taskRows.map((row) => taskDto(row, context.now, studyDate))),
    resources: iso(resourceList.map(resourceDto)),
    resourceItems: iso(items),
    slots: iso(slotRows.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) }))),
    plans: [],
    streaks: [],
    notifications: iso(notificationRows),
    reviews: [],
    studyDate,
  };
}
export function editableFields<T extends Record<string, unknown>>(
  value: T,
  fields: readonly string[],
) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => fields.includes(key)),
  ) as Prisma.InputJsonObject;
}
