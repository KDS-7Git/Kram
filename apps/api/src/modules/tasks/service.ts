import {
  taskSchema,
  progressInputSchema,
  foldTaskEvents,
  assertTaskEventAllowed,
  undoCompletionReference,
  TaskEventError,
  type ProgressEvent as EventDto,
} from "@kram/shared";
import { instantMillis, studyDate } from "@kram/time";
import type { Prisma } from "@prisma/client";
import { createHash } from 'node:crypto';
import { db } from "../../db";
import { ApiError } from "../../errors";
import {
  newId,
  notFound,
  ownerWhere,
  lockOwner,
  type Connection,
  type Transaction,
} from "../../repository";
import {
  clock,
  calendarDate,
  calendarString,
} from "../../calendar";
import { getSettings } from "../hierarchy/service";
import { goals, activeSkill } from "../goals/service";
import { refreshReminders } from "../notifications/service";

const include = {
  goal: true,
  item: { include: { resource: true } },
  dependencies: true,
} as const;
export type TaskRow = Prisma.TaskGetPayload<{ include: typeof include }>;
export const eventDto = (
  row: Prisma.ProgressEventGetPayload<Record<string, never>>,
): EventDto => ({
  ...row,
  kind: row.kind as EventDto["kind"],
  occurredAt: row.occurredAt.toISOString(),
  localDate: calendarString(row.localDate),
  toDate: row.toDate ? calendarString(row.toDate) : null,
  createdAt: row.createdAt.toISOString(),
});
export const taskDto = (row: TaskRow, now: string, today: string) => ({
  ...row,
  earliestDate: calendarString(row.earliestDate),
  dueDate: row.dueDate ? calendarString(row.dueDate) : null,
  deferredToDate: row.deferredToDate
    ? calendarString(row.deferredToDate)
    : null,
  status:
    row.status === "deferred" &&
    row.deferredToDate &&
    calendarString(row.deferredToDate) <= today
      ? "pending"
      : row.status,
  timerStartedAt: row.timerStartedAt?.toISOString() ?? null,
  timerElapsedMinutes:
    row.timerAccumulatedMinutes +
    (row.timerStartedAt
      ? Math.max(0, instantMillis(now) - row.timerStartedAt.getTime()) / 60000
      : 0),
  dependsOn: row.dependencies.map((dependency) => dependency.dependsOnTaskId),
  overdue: Boolean(
    row.dueDate &&
    calendarString(row.dueDate) < today &&
    !["completed", "skipped", "cancelled"].includes(row.status),
  ),
});
async function get(userId: string, id: string, c: Connection = db) {
  return notFound(
    await c.task.findFirst({ where: { id, ...ownerWhere(userId) }, include }),
    "task",
  );
}
async function history(userId: string, id: string, c: Connection = db) {
  await get(userId, id, c);
  return (
    await c.progressEvent.findMany({
      where: { taskId: id, ...ownerWhere(userId) },
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
    })
  ).map(eventDto);
}
function seed(row: TaskRow) {
  return {
    id: row.id,
    goalId: row.goalId,
    estMinutes: row.estMinutes,
    qty: row.qty,
    quantityBased: row.goal.unit.toLowerCase() !== 'minutes',
    earliestDate: calendarString(row.earliestDate),
    dueDate: row.dueDate ? calendarString(row.dueDate) : null,
  };
}
async function refreshCache(userId: string, goalId: string, c: Connection) {
  const rows = await c.task.findMany({
    where: { goalId, ...ownerWhere(userId) },
    select: { actualMinutes: true, completedQty: true, status: true },
  });
  const totals = rows.reduce(
    (sum, row) => ({
      minutes: sum.minutes + row.actualMinutes,
      qty: sum.qty + row.completedQty,
      completions: sum.completions + (row.status === "completed" ? 1 : 0),
    }),
    { minutes: 0, qty: 0, completions: 0 },
  );
  await c.goalProgressCache.upsert({
    where: { goalId },
    create: { id: newId(), userId, goalId, ...totals },
    update: totals,
  });
  return totals;
}
export const tasks = {
  get,
  history,
  async list(userId: string, includeArchived = false, c: Connection = db) {
    return c.task.findMany({
      where: {
        ...ownerWhere(userId),
        ...(includeArchived
          ? {}
          : {
              archivedAt: null,
              goal: {
                archivedAt: null,
                skill: { archivedAt: null, profile: { archivedAt: null } },
              },
            }),
      },
      include,
      orderBy: [{ earliestDate: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
  },
  async create(userId: string, input: unknown) {
    const data = taskSchema.parse(input);
    return db.$transaction(async (tx) => {
      await lockOwner(tx, userId);
      const goal = await goals.get(userId, data.goalId, tx);
      await activeSkill(userId, goal.skillId, tx);
      if (goal.status !== "active")
        throw new ApiError(
          "GOAL_NOT_ACTIVE",
          "Resume this goal before adding tasks.",
          409,
        );
      if (data.itemId) {
        const item = notFound(
          await tx.resourceItem.findFirst({
            where: {
              id: data.itemId,
              userId,
              archivedAt: null,
              resource: {
                archivedAt: null,
                goals: { some: { goalId: goal.id, userId } },
              },
            },
          }),
          "linked resource item",
        );
        if (!item)
          throw new ApiError(
            "NOT_FOUND",
            "Choose an item linked to this goal.",
            404,
          );
      }
      const { dependsOn, ...value } = data;
      for (const id of dependsOn) await get(userId, id, tx);
      const id = newId();
      const row = await tx.task.create({
        data: {
          ...value,
          qty:
            goal.unit.toLowerCase() === "minutes" ? data.estMinutes : data.qty,
          id,
          userId,
          periodKey: `manual:${id}`,
          materializationKey: `manual:${id}`,
          remainingMinutes: data.estMinutes,
          earliestDate: calendarDate(data.earliestDate),
          dueDate: data.dueDate ? calendarDate(data.dueDate) : null,
        },
      });
      if (dependsOn.length)
        await tx.taskDependency.createMany({
          data: [...new Set(dependsOn)].map((dependsOnTaskId) => ({
            id: newId(),
            userId,
            taskId: id,
            dependsOnTaskId,
          })),
        });
      await refreshReminders(userId, tx);
      return row;
    });
  },
  async event(userId: string, id: string, input: unknown, transaction?: Transaction) {
    const data = progressInputSchema.parse(input),
      now = clock.now();
    const quantityProvided=typeof input==='object'&&input!==null&&Object.hasOwn(input,'qty');
    const minutesProvided=typeof input==='object'&&input!==null&&Object.hasOwn(input,'minutes');
    const requestHash=createHash('sha256').update(JSON.stringify({...data,occurredAt:new Date(data.occurredAt).toISOString(),quantityProvided,minutesProvided})).digest('hex');
    if (instantMillis(data.occurredAt) > instantMillis(now) + 300000)
      throw new ApiError(
        "CLOCK_AHEAD",
        "Check your device clock before recording progress.",
        400,
      );
    const operation = async (tx: Transaction) => {
      await lockOwner(tx, userId);
      const row = await get(userId, id, tx);
      const settings = await getSettings(userId, tx),
        today = studyDate(now, settings.timezone, settings.dayRollover),
        localDate = studyDate(
          data.occurredAt,
          settings.timezone,
          settings.dayRollover,
        );
      const previous = await tx.progressEvent.findFirst({
        where: { clientEventId: data.clientEventId, ...ownerWhere(userId) },
      });
      if (previous) {
        if (
          previous.taskId !== id ||
          previous.requestHash!==requestHash
        )
          throw new ApiError(
            "CLIENT_EVENT_CONFLICT",
            "This event identifier was already used for different progress.",
            409,
          );
        return {
          task: taskDto(row, now, today),
          event: eventDto(previous),
          replayed: true,
        };
      }
      if (data.kind === 'started' || data.kind === 'resumed') {
        if (row.goal.archivedAt || row.goal.status !== 'active')
          throw new ApiError('GOAL_NOT_ACTIVE', 'Resume or restore this goal before starting a timer.', 409);
        await activeSkill(userId, row.goal.skillId, tx);
      }
      const events = await history(userId, id, tx);
      const before = foldTaskEvents(seed(row), events, { now, today });
      const minutes = data.kind === 'completed' ? (minutesProvided ? data.minutes : before.actualMinutes) - before.actualMinutes : data.minutes;
      const quantity = row.goal.unit.toLowerCase() === 'minutes' ? minutes : data.kind === 'completed'
        ? (quantityProvided ? data.qty : Math.max(row.qty, before.completedQty)) - before.completedQty : data.qty;
      if (minutes < 0 || quantity < 0) throw new ApiError('INVALID_COMPLETION_TOTAL', 'Completion totals cannot be below recorded progress. Correct the earlier event before reducing it.', 400);
      if (minutes > 1440) throw new ApiError('VALIDATION_FAILED', 'A completion can add at most 1440 unreported minutes. Log earlier work as separate progress first.', 400, [{ path: ['minutes'], message: 'Additional unreported work exceeds one day.' }]);
      if (data.kind !== "correction" && row.archivedAt)
        throw new ApiError(
          "TASK_ARCHIVED",
          "This task is archived; its history remains available.",
          409,
        );
      const candidate = {
        id: newId(),
        taskId: id,
        goalId: row.goalId,
        kind: data.kind,
        minutes,
        qty: quantity,
        reportedTotalMinutes: data.kind === 'completed' && minutesProvided ? data.minutes : null,
        reportedTotalQty: data.kind !== 'completed' ? null : row.goal.unit.toLowerCase() === 'minutes'
          ? minutesProvided ? data.minutes : null
          : quantityProvided ? data.qty : row.qty,
        occurredAt: data.occurredAt,
        localDate,
        clientEventId: data.clientEventId,
        note: data.note,
        referenceEventId: data.referenceEventId ?? null,
        toDate: data.toDate ?? null,
        createdAt: now,
      };
      try {
        if (data.kind === "correction") {
          const target = events.find(
            (event) => event.id === data.referenceEventId,
          );
          if (!target)
            throw new ApiError(
              "NOT_FOUND",
              "The referenced event could not be found in this task.",
              404,
            );
          if (target.kind === "completed" && !data.explicitCorrection) {
            const reference = undoCompletionReference(events, {
              now,
              explicitCorrection: data.explicitCorrection,
            });
            if (reference !== target.id)
              throw new ApiError(
                "CORRECTION_REQUIRED",
                "Use an explicit correction for an earlier completion.",
                409,
              );
          }
        }
        assertTaskEventAllowed(before, candidate);
      } catch (error) {
        if (error instanceof TaskEventError)
          throw new ApiError(
            error.code,
            error.message,
            error.code.startsWith("INVALID") ? 400 : 409,
          );
        throw error;
      }
      const version = await goals.rulesForDate(
        userId,
        row.goalId,
        localDate,
        tx,
      );
      const stored = await tx.progressEvent.create({
        data: {
          ...candidate,
          userId,
          sequence: row.eventVersion + 1,
          requestHash,
          occurredAt: new Date(data.occurredAt),
          localDate: calendarDate(localDate),
          timezone: settings.timezone,
          ruleVersionId: version?.id ?? null,
          toDate: data.toDate ? calendarDate(data.toDate) : null,
          createdAt: new Date(now),
        },
      });
      const after = foldTaskEvents(seed(row), [...events, eventDto(stored)], {
        now,
        today,
      });
      await tx.task.update({
        where: { id, userId },
        data: {
          status: after.status,
          actualMinutes: after.actualMinutes,
          completedQty: after.completedQty,
          remainingMinutes: after.remainingMinutes,
          timerStartedAt: after.timerStartedAt
            ? new Date(after.timerStartedAt)
            : null,
          timerAccumulatedMinutes: after.timerAccumulatedMinutes,
          deferredToDate: after.deferredToDate
            ? calendarDate(after.deferredToDate)
            : null,
          eventVersion: row.eventVersion + 1,
          unverified: false,
        },
      });
      await refreshCache(userId, row.goalId, tx);
      await refreshReminders(userId, tx);
      return {
        task: taskDto(await get(userId, id, tx), now, today),
        event: eventDto(stored),
        replayed: false,
      };
    };
    return transaction ? operation(transaction) : db.$transaction(operation);
  },
  async edit(userId: string, id: string, input: Record<string, unknown>, transaction?: Transaction) {
    const edit = async (tx: Transaction) => {
      await lockOwner(tx, userId);
      const row = await get(userId, id, tx);
      const data = taskSchema.parse({
        ...row,
        earliestDate: calendarString(row.earliestDate),
        dueDate: row.dueDate ? calendarString(row.dueDate) : null,
        dependsOn: row.dependencies.map((edge) => edge.dependsOnTaskId),
        ...input,
      });
      if (row.goal.unit.toLowerCase() === 'minutes')
        data.qty = data.estMinutes !== row.estMinutes ? data.estMinutes : row.qty;
      if (data.goalId !== row.goalId || data.itemId !== row.itemId)
        throw new ApiError(
          "HISTORY_PROTECTED",
          "Create another task to change its goal or resource item.",
          409,
        );
      if (
        row.eventVersion > 0 &&
        (data.estMinutes !== row.estMinutes || data.qty !== row.qty)
      )
        throw new ApiError(
          "HISTORY_PROTECTED",
          "Started task estimates and quantities preserve their event baseline.",
          409,
        );
      if (
        JSON.stringify([...new Set(data.dependsOn)].sort()) !==
        JSON.stringify(
          row.dependencies.map((edge) => edge.dependsOnTaskId).sort(),
        )
      )
        throw new ApiError(
          "DEPENDENCY_EDIT_PENDING",
          "Task prerequisite edits are delivered with adaptive planning.",
          409,
        );
      const { dependsOn: _edges, ...value } = data;
      const changed = ['title', 'estMinutes', 'qty', 'supportsSplit', 'sortOrder']
        .some(field => row[field as keyof TaskRow] !== value[field as keyof typeof value]) ||
        calendarString(row.earliestDate) !== data.earliestDate ||
        (row.dueDate ? calendarString(row.dueDate) : null) !== data.dueDate;
      await tx.task.update({
        where: { id, userId },
        data: {
          ...value,
          manualOverride: row.manualOverride || changed,
          earliestDate: calendarDate(data.earliestDate),
          dueDate: data.dueDate ? calendarDate(data.dueDate) : null,
          ...(row.eventVersion === 0
            ? { remainingMinutes: data.estMinutes }
            : {}),
        },
      });
      await refreshReminders(userId, tx);
      return get(userId, id, tx);
    };
    return transaction ? edit(transaction) : db.$transaction(edit);
  },
  async context(userId: string) {
    const settings = await getSettings(userId);
    const now = clock.now();
    return {
      now,
      today: studyDate(now, settings.timezone, settings.dayRollover),
    };
  },
};
export { refreshCache as refreshGoalProgressCache };
export { materializeTasks } from './materialization';
