import {
  profileSchema,
  skillSchema,
  settingsSchema,
  type Settings,
} from "@kram/shared";
import type { Prisma } from "@prisma/client";
import { db } from "../../db";
import { ApiError } from "../../errors";
import {
  ownerWhere,
  newId,
  notFound,
  json,
  audit,
  iso,
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
    const current = await this.get(userId, id);
    const data = profileSchema.parse({
      ...current,
      ...(input as Record<string, unknown>),
    });
    return db.profile.update({ where: { id, userId }, data });
  },
  async archive(userId: string, id: string) {
    await this.get(userId, id);
    return db.profile.update({
      where: { id, userId },
      data: { archivedAt: new Date() },
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
  async create(userId: string, input: unknown, c: Connection = db) {
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
    const current = await this.get(userId, id);
    const data = skillSchema.parse({
      ...current,
      ...(input as Record<string, unknown>),
    });
    const profile = await profiles.get(userId, data.profileId);
    if (profile.archivedAt && data.profileId !== current.profileId)
      throw new ApiError(
        "ARCHIVED_PARENT",
        "Restore this profile before moving skills into it.",
        409,
      );
    return db.skill.update({
      where: { id, userId },
      data: { ...data, windows: json(data.windows) },
    });
  },
  async archive(userId: string, id: string) {
    await this.get(userId, id);
    return db.skill.update({
      where: { id, userId },
      data: { archivedAt: new Date() },
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
  const current = await getSettings(userId);
  const next = settingsSchema.parse({
    ...current,
    ...(input as Record<string, unknown>),
  });
  await db.$transaction(async (tx) => {
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
  });
  return next;
}
export async function hierarchyBootstrap(userId: string) {
  const [user, profileList, skillList] = await Promise.all([
    getUser(userId),
    profiles.list(userId),
    skills.list(userId),
  ]);
  return {
    user,
    profiles: iso(profileList),
    skills: iso(skillList),
    goals: [],
    tasks: [],
    resources: [],
    resourceItems: [],
    slots: [],
    plans: [],
    streaks: [],
    notifications: [],
    reviews: [],
    studyDate: null,
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
