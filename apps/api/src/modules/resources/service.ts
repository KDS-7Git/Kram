import { resourceSchema, resourceItemSchema } from "@kram/shared";
import type { Prisma } from "@prisma/client";
import { db } from "../../db";
import { ApiError } from "../../errors";
import {
  newId,
  notFound,
  ownerWhere,
  lockOwner,
  type Connection,
} from "../../repository";
import { goals, activeSkill } from "../goals/service";
import { materializeTasks } from '../tasks/materialization';
import { parseOutline } from "./outline";

type ResourceRow = Prisma.ResourceGetPayload<{ include: { goals: true } }>;
type ItemRow = Prisma.ResourceItemGetPayload<{
  include: { dependencies: true };
}>;
export const resourceDto = (row: ResourceRow) => {
  const { goals: links, ...value } = row;
  return { ...value, goalIds: links.map((link) => link.goalId).sort() };
};
export const itemDto = (row: ItemRow) => {
  const { dependencies, ...value } = row;
  return {
    ...value,
    dependsOn: dependencies.map((link) => link.dependsOnItemId).sort(),
  };
};
function assertAcyclic(edges: Map<string, string[]>, code: string) {
  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id))
      throw new ApiError(
        code,
        "This change would create a cycle. Choose a different parent or prerequisite.",
        409,
      );
    if (done.has(id)) return;
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    done.add(id);
  }
  for (const id of edges.keys()) visit(id);
}
async function validateLinks(
  userId: string,
  skillId: string,
  goalIds: string[],
  c: Connection,
  retainedIds: Set<string> = new Set(),
) {
  for (const id of goalIds) {
    const goal = await goals.get(userId, id, c);
    if (goal.skillId !== skillId)
      throw new ApiError(
        "SKILL_MISMATCH",
        "Link goals and resources from the same skill.",
        400,
      );
    if (goal.archivedAt && !retainedIds.has(id))
      throw new ApiError(
        "ARCHIVED_PARENT",
        "Choose an active or paused goal.",
        409,
      );
  }
}
async function getItem(userId: string, id: string, c: Connection = db) {
  return notFound(
    await c.resourceItem.findFirst({
      where: { id, ...ownerWhere(userId) },
      include: { dependencies: true },
    }),
    "resource item",
  );
}
async function itemGraph(userId: string, resourceId: string, c: Connection) {
  return c.resourceItem.findMany({
    where: { resourceId, ...ownerWhere(userId) },
    include: { dependencies: true },
  });
}
async function validateItem(
  userId: string,
  resourceId: string,
  id: string,
  data: ReturnType<typeof resourceItemSchema.parse>,
  c: Connection,
  previous?: ItemRow,
) {
  const rows = await itemGraph(userId, resourceId, c);
  const map = new Map(rows.map((row) => [row.id, row]));
  const previousDependencies = new Set(previous?.dependencies.map((link) => link.dependsOnItemId));
  const targets = [
    ...(data.parentItemId ? [{ id: data.parentItemId, retained: previous?.parentItemId === data.parentItemId }] : []),
    ...data.dependsOn.map((target) => ({ id: target, retained: previousDependencies.has(target) })),
  ];
  for (const target of targets) {
    const row = map.get(target.id);
    if (!row)
      throw new ApiError(
        "NOT_FOUND",
        "This parent or prerequisite could not be found.",
        404,
      );
    if (row.archivedAt && !target.retained)
      throw new ApiError(
        "ARCHIVED_PARENT",
        "Choose an unarchived parent or prerequisite.",
        409,
      );
  }
  const parents = new Map(
    rows.map((row) => [row.id, row.parentItemId ? [row.parentItemId] : []]),
  );
  parents.set(id, data.parentItemId ? [data.parentItemId] : []);
  assertAcyclic(parents, "TREE_CYCLE");
  const dependencies = new Map(
    rows.map((row) => [
      row.id,
      row.dependencies.map((link) => link.dependsOnItemId),
    ]),
  );
  dependencies.set(id, [...new Set(data.dependsOn)]);
  assertAcyclic(dependencies, "DEPENDENCY_CYCLE");
}
async function writeDependencies(
  userId: string,
  resourceId: string,
  itemId: string,
  dependsOn: string[],
  c: Connection,
) {
  const retained = await c.itemDependency.findMany({ where: { itemId, ...ownerWhere(userId) } });
  const desired = new Set(dependsOn);
  await c.itemDependency.deleteMany({
    where: { itemId, ...ownerWhere(userId), dependsOnItemId: { notIn: [...desired] } },
  });
  const existing = new Set(retained.map((link) => link.dependsOnItemId));
  const added = [...desired].filter((target) => !existing.has(target));
  if (added.length)
    await c.itemDependency.createMany({
      data: added.map((dependsOnItemId) => ({
        id: newId(),
        userId,
        resourceId,
        itemId,
        dependsOnItemId,
      })),
    });
}
export const resources = {
  async list(userId: string, includeArchived = false, c: Connection = db) {
    return c.resource.findMany({
      where: {
        ...ownerWhere(userId),
        ...(includeArchived
          ? {}
          : {
              archivedAt: null,
              skill: { archivedAt: null, profile: { archivedAt: null } },
            }),
      },
      include: { goals: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  },
  async get(userId: string, id: string, c: Connection = db) {
    return notFound(
      await c.resource.findFirst({
        where: { id, ...ownerWhere(userId) },
        include: { goals: true },
      }),
      "resource",
    );
  },
  async create(userId: string, input: unknown) {
    const data = resourceSchema.parse(input);
    const goalIds = [
      ...new Set([...data.goalIds, ...(data.goalId ? [data.goalId] : [])]),
    ];
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      await activeSkill(userId, data.skillId, tx);
      await validateLinks(userId, data.skillId, goalIds, tx);
      const { goalIds: _ids, ...value } = data;
      const row = await tx.resource.create({
        data: {
          ...value,
          goalId: data.goalId ?? goalIds[0] ?? null,
          id: newId(),
          userId,
          goals: {
            create: goalIds.map((goalId) => ({ id: newId(), goalId })),
          },
        },
        include: { goals: true },
      });
      await materializeTasks(userId, undefined, tx);
      return resourceDto(row);
    });
  },
  async edit(userId: string, id: string, input: Record<string, unknown>) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const current = await this.get(userId, id, tx);
      const merged = { ...resourceDto(current), ...input };
      if ("goalIds" in input && !("goalId" in input)) merged.goalId = null;
      const data = resourceSchema.parse(merged);
      const goalIds = [
        ...new Set([...data.goalIds, ...(data.goalId ? [data.goalId] : [])]),
      ];
      if (data.skillId !== current.skillId)
        await activeSkill(userId, data.skillId, tx);
      const existing = new Set(current.goals.map((link) => link.goalId));
      await validateLinks(userId, data.skillId, goalIds, tx, existing);
      await tx.goalResource.deleteMany({
        where: { resourceId: id, ...ownerWhere(userId), goalId: { notIn: goalIds } },
      });
      const { goalIds: _ids, ...value } = data;
      const row = await tx.resource.update({
        where: { id, userId },
        data: {
          ...value,
          goalId: data.goalId ?? goalIds[0] ?? null,
          goals: {
            create: goalIds.filter((goalId) => !existing.has(goalId)).map((goalId) => ({ id: newId(), goalId })),
          },
        },
        include: { goals: true },
      });
      await materializeTasks(userId, undefined, tx);
      return resourceDto(row);
    });
  },
  async archive(userId: string, id: string) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const current = await this.get(userId, id, tx);
      const row = await tx.resource.update({
        where: { id, userId },
        data: { archivedAt: current.archivedAt ?? new Date() },
        include: { goals: true },
      });
      await materializeTasks(userId, undefined, tx);
      return resourceDto(row);
    });
  },
  async items(
    userId: string,
    id: string,
    includeArchived = false,
    c: Connection = db,
  ) {
    await this.get(userId, id, c);
    const rows = await itemGraph(userId, id, c);
    return rows
      .filter((row) => includeArchived || !row.archivedAt)
      .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
      .map(itemDto);
  },
  async allItems(userId: string) {
    return (
      await db.resourceItem.findMany({
        where: {
          ...ownerWhere(userId),
          archivedAt: null,
          resource: {
            archivedAt: null,
            skill: { archivedAt: null, profile: { archivedAt: null } },
          },
        },
        include: { dependencies: true },
        orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      })
    ).map(itemDto);
  },
  async addItem(userId: string, resourceId: string, input: unknown) {
    const data = resourceItemSchema.parse(input);
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const resource = await this.get(userId, resourceId, tx);
      if (resource.archivedAt)
        throw new ApiError(
          "ARCHIVED_PARENT",
          "Restore this resource before adding items.",
          409,
        );
      await activeSkill(userId, resource.skillId, tx);
      const id = newId();
      await validateItem(userId, resourceId, id, data, tx);
      const { dependsOn, ...value } = data;
      await tx.resourceItem.create({
        data: { ...value, id, userId, resourceId },
      });
      await writeDependencies(userId, resourceId, id, dependsOn, tx);
      await materializeTasks(userId, undefined, tx);
      return itemDto(await getItem(userId, id, tx));
    });
  },
  async editItem(userId: string, id: string, input: Record<string, unknown>) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const current = await getItem(userId, id, tx);
      const data = resourceItemSchema.parse({ ...itemDto(current), ...input });
      await validateItem(userId, current.resourceId, id, data, tx, current);
      const { dependsOn, ...value } = data;
      await tx.resourceItem.update({ where: { id, userId }, data: value });
      await writeDependencies(userId, current.resourceId, id, dependsOn, tx);
      await materializeTasks(userId, undefined, tx);
      return itemDto(await getItem(userId, id, tx));
    });
  },
  async archiveItem(userId: string, id: string) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const current = await getItem(userId, id, tx);
      const rows = await itemGraph(userId, current.resourceId, tx);
      const ids = new Set([id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows)
          if (
            row.parentItemId &&
            ids.has(row.parentItemId) &&
            !ids.has(row.id)
          ) {
            ids.add(row.id);
            changed = true;
          }
      }
      await tx.resourceItem.updateMany({
        where: { id: { in: [...ids] }, ...ownerWhere(userId) },
        data: { archivedAt: new Date() },
      });
      await materializeTasks(userId, undefined, tx);
      return itemDto(await getItem(userId, id, tx));
    });
  },
  async import(userId: string, resourceId: string, input: unknown) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const resource = await this.get(userId, resourceId, tx);
      if (resource.archivedAt)
        throw new ApiError(
          "ARCHIVED_PARENT",
          "Restore this resource before importing.",
          409,
        );
      await activeSkill(userId, resource.skillId, tx);
      const entries = parseOutline(
        input,
        resource.type as "course" | "book" | "lab" | "project",
      );
      const ids = entries.map(() => newId());
      const existingRoots = await tx.resourceItem.aggregate({
        where: { resourceId, userId, parentItemId: null, archivedAt: null },
        _max: { ordinal: true },
      });
      const rootOffset = (existingRoots._max.ordinal ?? -1) + 1;
      for (const [index, entry] of entries.entries()) {
        const { parentIndex, ...value } = entry;
        await tx.resourceItem.create({
          data: {
            ...value,
            ordinal: value.ordinal + (parentIndex === null ? rootOffset : 0),
            id: ids[index]!,
            userId,
            resourceId,
            parentItemId: parentIndex === null ? null : ids[parentIndex]!,
          },
        });
      }
      const imported = await tx.resourceItem.findMany({
        where: { id: { in: ids }, userId },
        include: { dependencies: true },
        orderBy: { createdAt: "asc" },
      });
      const rowsById = new Map(imported.map((row) => [row.id, row]));
      await materializeTasks(userId, undefined, tx);
      return {
        items: ids.map((id) => itemDto(rowsById.get(id)!)),
        imported: entries.length,
      };
    });
  },
  async reorder(
    userId: string,
    id: string,
    items: { id: string; parentItemId: string | null; ordinal: number }[],
  ) {
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      await this.get(userId, id, tx);
      const rows = (await itemGraph(userId, id, tx)).filter(
        (row) => !row.archivedAt,
      );
      const map = new Map(rows.map((row) => [row.id, row]));
      if (
        items.length !== rows.length ||
        new Set(items.map((item) => item.id)).size !== rows.length ||
        items.some(
          (item) =>
            !map.has(item.id) ||
            (item.parentItemId && !map.has(item.parentItemId)),
        )
      )
        throw new ApiError(
          "TREE_CHANGED",
          "Reload the resource tree before ordering it.",
          409,
        );
      assertAcyclic(
        new Map(
          items.map((item) => [
            item.id,
            item.parentItemId ? [item.parentItemId] : [],
          ]),
        ),
        "TREE_CYCLE",
      );
      for (const item of items)
        await tx.resourceItem.update({
          where: { id: item.id, userId },
          data: { parentItemId: item.parentItemId, ordinal: item.ordinal },
        });
      await materializeTasks(userId, undefined, tx);
      return { saved: true };
    });
  },
};
export const resourceItems = { get: getItem };
