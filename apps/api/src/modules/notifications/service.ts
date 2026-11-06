import { createHash } from 'node:crypto';
import type { Notification, Prisma } from '@prisma/client';
import { reminderRuleSchema, settingsSchema } from '@kram/shared';
import { addDays, dateRange, instantMillis, localToInstant, studyDate } from '@kram/time';
import { db } from '../../db';
import { config } from '../../config';
import { ApiError } from '../../errors';
import { newId, notFound, ownerWhere, lockOwner, type Connection } from '../../repository';
import { calendarString } from '../../calendar';
import { enqueueDispatch } from '../../jobs';
import { ntfyConfiguration, publishNtfy } from './channel';
import { nextRetry, privateMessage, quietUntil, REPEAT_MINUTES } from './policy';

const terminal = ['completed', 'cancelled', 'skipped'];
const pending = ['pending', 'suppressed_quiet_hours'];
const staleMs = 60 * 60_000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type NotificationRow = Prisma.NotificationGetPayload<{ include: { attempts: true } }>;
export const notificationDto = (row: NotificationRow) => row;

async function settingsFor(userId: string, c: Connection) {
  const user = notFound(await c.user.findFirst({ where: { id: userId, isOwner: true } }), 'owner');
  return settingsSchema.parse(user.settings);
}
async function openTask(userId: string, taskId: string, c: Connection) {
  return c.task.findFirst({ where: { id: taskId, userId, archivedAt: null, status: { notIn: terminal },
    goal: { status: 'active', archivedAt: null, skill: { archivedAt: null, profile: { archivedAt: null } } } } });
}
async function validateRule(userId: string, value: ReturnType<typeof reminderRuleSchema.parse>, c: Connection) {
  if (value.ownerType === 'global') {
    if (value.ownerId || value.atLocal === null || value.repeatPolicy !== 'once') throw new ApiError('VALIDATION_FAILED', 'Global reminders need a local time and once-per-day delivery.', 400);
    return;
  }
  const id = value.ownerId!;
  const row = value.ownerType === 'task' ? await c.task.findFirst({ where: { id, userId } }) : value.ownerType === 'goal' ? await c.goal.findFirst({ where: { id, userId } }) : await c.timeSlot.findFirst({ where: { id, userId } });
  notFound(row, value.ownerType);
  if (value.repeatPolicy === 'until_completed' && value.ownerType === 'slot' && row && !('taskId' in row && row.taskId)) throw new ApiError('VALIDATION_FAILED', 'Repeating reminders need a task that can be completed.', 400);
}

export const reminders = {
  list(userId: string) { return db.reminderRule.findMany({ where: { ...ownerWhere(userId), archivedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }); },
  async get(userId: string, id: string, c: Connection = db) { return notFound(await c.reminderRule.findFirst({ where: { id, ...ownerWhere(userId) } }), 'reminder'); },
  async create(userId: string, input: unknown) {
    const value = reminderRuleSchema.parse(input);
    return db.$transaction(async tx => { await lockOwner(tx, userId); await validateRule(userId, value, tx);
      const row = await tx.reminderRule.create({ data: { ...value, id: newId(), userId } }); await refreshReminders(userId, tx); return row; });
  },
  async edit(userId: string, id: string, input: Record<string, unknown>) {
    return db.$transaction(async tx => { await lockOwner(tx, userId); const row = await this.get(userId, id, tx);
      const value = reminderRuleSchema.parse({ ...row, ...input }); await validateRule(userId, value, tx);
      const changed = await tx.reminderRule.update({ where: { id, userId }, data: value }); await refreshReminders(userId, tx); return changed; });
  },
  async archive(userId: string, id: string) {
    return db.$transaction(async tx => { await lockOwner(tx, userId); await this.get(userId, id, tx);
      const row = await tx.reminderRule.update({ where: { id, userId }, data: { enabled: false, archivedAt: new Date() } }); await refreshReminders(userId, tx); return row; });
  },
};

/** Derive rows only; API/worker call this inside their existing owner transaction. */
export async function refreshReminders(userId: string, c: Connection = db, now = new Date()): Promise<{ created: number; cancelled: number; unresolved: number }> {
  if (c === db) return db.$transaction(async tx => { await lockOwner(tx, userId); return refreshReminders(userId, tx, now); });
  const settings = await settingsFor(userId, c);
  const existing = await c.notification.findMany({ where: { userId, isTest: false, status: { in: pending } } });
  if (!settings.notificationsEnabled) {
    await c.notification.updateMany({ where: { userId, isTest: false, status: { in: pending } }, data: { status: 'cancelled', leaseId: null, leaseUntil: null, nextAttemptAt: null } });
    return { created: 0, cancelled: existing.length, unresolved: 0 };
  }
  const today = studyDate(now.getTime(), settings.timezone, settings.dayRollover);
  const rules = await c.reminderRule.findMany({ where: { userId, enabled: true, archivedAt: null } });
  const tasks = await c.task.findMany({ where: { userId, isDemo: false, archivedAt: null, status: { notIn: terminal }, goal: { status: 'active', archivedAt: null, skill: { archivedAt: null, profile: { archivedAt: null } } } } });
  const slots = await c.timeSlot.findMany({ where: { userId, archivedAt: null }, orderBy: [{ date: 'asc' }, { startMin: 'asc' }, { id: 'asc' }] });
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const desired = new Map<string, Prisma.NotificationCreateManyInput>(); let unresolved = 0;
  for (const rule of rules) {
    const targets = rule.ownerType === 'task' ? tasks.filter(task => task.id === rule.ownerId) : rule.ownerType === 'goal' ? tasks.filter(task => task.goalId === rule.ownerId) : [];
    const add = (date: string, minute: number, taskId: string | null, target: string, isCivil = false, offset = 0) => {
      const civil = !isCivil && minute < settings.dayRollover ? addDays(date, 1) : date;
      const anchor = instantMillis(localToInstant(civil, minute, settings.timezone)) + offset * 60_000;
      const key = hash({ ruleId: rule.id, type: rule.type, atLocal: rule.atLocal, offsetMin: rule.offsetMin, repeat: rule.repeatPolicy, target, civil, anchor, timezone: settings.timezone });
      const delayed = existing.find(row => row.dedupeKey === key)?.nextAttemptAt;
      if (anchor < now.getTime() - staleMs && rule.repeatPolicy !== 'until_completed' && (!delayed || delayed.getTime() < now.getTime() - staleMs)) return;
      const title = taskId ? taskMap.get(taskId)?.title ?? 'Scheduled work' : rule.ownerType === 'slot' ? slots.find(slot => slot.id === rule.ownerId)?.title ?? 'Scheduled block' : 'Scheduled reminder';
      desired.set(key, { id: newId(), userId, channel: 'ntfy', type: rule.type, title, body: 'Open Kram to review your scheduled work.',
        scheduledFor: new Date(Math.max(anchor, rule.repeatPolicy === 'until_completed' ? now.getTime() : anchor)), dedupeKey: key,
        ownerType: rule.ownerType, ownerId: rule.ownerId, reminderRuleId: rule.id, taskId });
    };
    if (rule.ownerType === 'global' && rule.atLocal !== null) {
      for (const date of dateRange(addDays(today, -1), addDays(today, 13))) add(date, rule.atLocal, null, `global:${date}`);
    } else if (rule.ownerType === 'slot') {
      const slot = slots.find(row => row.id === rule.ownerId);
      if (!slot || (slot.taskId && !taskMap.has(slot.taskId))) continue;
      add(calendarString(slot.date), rule.atLocal ?? slot.startMin, slot.taskId, slot.id, true, rule.offsetMin ?? 0);
    } else if (rule.atLocal !== null) {
      for (const task of targets) {
        const workDate = calendarString(task.deferredToDate ?? task.dueDate ?? task.earliestDate);
        // The source work date owns the key across study-day rollover. Quiet
        // delays and repeating cadence retain it; only physical due time moves.
        add(workDate, rule.atLocal, task.id, task.id);
      }
    } else {
      let resolved = false;
      for (const slot of slots.filter(slot => rule.ownerType === 'task' ? slot.taskId === rule.ownerId : slot.goalId === rule.ownerId || Boolean(slot.taskId && taskMap.get(slot.taskId)?.goalId === rule.ownerId))) {
        if (slot.taskId && !taskMap.has(slot.taskId)) continue;
        if (rule.repeatPolicy === 'until_completed' && !slot.taskId) continue;
        add(calendarString(slot.date), slot.startMin, slot.taskId, slot.id, true, rule.offsetMin ?? 0); resolved = true;
      }
      if (!resolved) unresolved++;
    }
  }
  const obsolete = existing.filter(row => !desired.has(row.dedupeKey) && !(row.dedupeKey.startsWith('repeat:') && desired.has(row.dedupeKey.split(':')[1]!))).map(row => row.id);
  if (obsolete.length) await c.notification.updateMany({ where: { userId, id: { in: obsolete }, status: { in: pending } }, data: { status: 'cancelled', leaseId: null, leaseUntil: null, nextAttemptAt: null } });
  const created = desired.size ? await c.notification.createMany({ data: [...desired.values()], skipDuplicates: true }) : { count: 0 };
  // Undo/resume may make an earlier cancelled projection valid again. Preserve
  // its attempt history while restoring only the derived pending state.
  for (const [dedupeKey, value] of desired) await c.notification.updateMany({ where: { userId, dedupeKey, status: 'cancelled' },
    data: { status: 'pending', scheduledFor: value.scheduledFor, nextAttemptAt: null, leaseId: null, leaseUntil: null } });
  for (const [dedupeKey, value] of desired) await c.notification.updateMany({ where: { userId, status: { in: pending }, OR: [{ dedupeKey }, { dedupeKey: { startsWith: `repeat:${dedupeKey}:` } }] },
    data: { title: value.title, body: value.body } });
  // A completion can cancel the next repeat after its initial row was sent.
  // Undo/resume renews one future repeat, never every cancelled historical row.
  const sentInitials = desired.size ? await c.notification.findMany({ where: { userId, dedupeKey: { in: [...desired.keys()] }, status: 'sent' } }) : [];
  const pendingRepeats = await c.notification.findMany({ where: { userId, status: { in: pending }, dedupeKey: { startsWith: 'repeat:' } }, select: { dedupeKey: true } });
  const repeatingBases = new Set(pendingRepeats.map(row => row.dedupeKey.split(':')[1]!));
  for (const initial of sentInitials) {
    const rule = rules.find(rule => rule.id === initial.reminderRuleId);
    if (rule?.repeatPolicy !== 'until_completed' || !initial.taskId || !taskMap.has(initial.taskId) || repeatingBases.has(initial.dedupeKey)) continue;
    const scheduledFor = new Date(now.getTime() + REPEAT_MINUTES * 60000);
    const dedupeKey = `repeat:${initial.dedupeKey}:${Math.floor(scheduledFor.getTime() / (REPEAT_MINUTES * 60000))}`;
    const renewed = await c.notification.createMany({ data: [{ ...desired.get(initial.dedupeKey)!, id: newId(), scheduledFor, dedupeKey }], skipDuplicates: true });
    created.count += renewed.count;
    await c.notification.updateMany({ where: { userId, dedupeKey, status: 'cancelled' }, data: { status: 'pending', scheduledFor, nextAttemptAt: null, leaseId: null, leaseUntil: null } });
    repeatingBases.add(initial.dedupeKey);
  }
  return { created: created.count, cancelled: obsolete.length, unresolved };
}

export async function listNotifications(userId: string) {
  return db.notification.findMany({ where: ownerWhere(userId), include: { attempts: { orderBy: [{ attemptedAt: 'asc' }, { id: 'asc' }] } }, orderBy: [{ scheduledFor: 'desc' }, { id: 'desc' }] });
}
export async function notificationStatus(userId: string) {
  const channel = ntfyConfiguration(); const last = await db.notification.findFirst({ where: { userId, status: 'sent' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } });
  const heartbeat = await db.systemMeta.findUnique({ where: { key: 'worker-heartbeat' } });
  return { configured: channel.configured, errorCode: channel.configured ? null : channel.errorCode,
    baseUrl: channel.configured ? channel.value.baseUrl : null, topic: channel.configured ? channel.value.topic : null,
    lastSentAt: last?.sentAt ?? null, workerHeartbeat: heartbeat?.value ?? null };
}
export async function queueTestNotification(userId: string) {
  const channel = ntfyConfiguration(); if (!channel.configured) throw new ApiError(channel.errorCode, 'Configure your protected ntfy server, topic and token before sending a test.', 409);
  const id = newId();
  const notification = await db.notification.create({ data: { id, userId, type: 'task_reminder', title: 'Kram notification test', body: 'This is a test from your Kram server.', scheduledFor: new Date(), dedupeKey: `test:${id}`, isTest: true }, include: { attempts: true } });
  await enqueueDispatch(`test:${id}`); return notification;
}

async function recordDecision(row: Notification, c: Connection, now: Date, outcome: string, status: string, nextAttemptAt: Date | null = null) {
  await c.notificationAttempt.createMany({ data: [{ id: newId(), userId: row.userId, notificationId: row.id, attemptedAt: now, outcome, leaseId: row.leaseId }], skipDuplicates: true });
  await c.notification.updateMany({ where: { id: row.id, leaseId: row.leaseId }, data: { status, nextAttemptAt, leaseId: null, leaseUntil: null } });
}

export async function dispatchNotifications(now = new Date(), limit = 10) {
  const claimed = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<Notification[]>`SELECT n.* FROM notification n JOIN app_user u ON u.id=n."userId" AND u."isOwner"=true WHERE n.channel='ntfy' AND n.status IN ('pending','suppressed_quiet_hours') AND COALESCE(n."nextAttemptAt",n."scheduledFor") <= ${now} AND (n."leaseUntil" IS NULL OR n."leaseUntil" <= ${now}) ORDER BY n."scheduledFor",n.id LIMIT ${Math.max(1, Math.min(limit, 50))} FOR UPDATE OF n SKIP LOCKED`;
    return Promise.all(rows.map(row => tx.notification.update({ where: { id: row.id }, data: { leaseId: newId(), leaseUntil: new Date(now.getTime() + 120000) } })));
  });
  let sent = 0, deferred = 0;
  for (const claim of claimed) {
    const ready = await db.$transaction(async tx => {
      await lockOwner(tx, claim.userId);
      const row = await tx.notification.findFirst({ where: { id: claim.id, leaseId: claim.leaseId, status: { in: pending } } });
      if (!row) return null;
      const settings = await settingsFor(row.userId, tx);
      const rule = row.reminderRuleId ? await tx.reminderRule.findFirst({ where: { id: row.reminderRuleId, userId: row.userId, enabled: true, archivedAt: null } }) : null;
      if (!row.isTest && (!settings.notificationsEnabled || row.reminderRuleId && !rule || row.taskId && !await openTask(row.userId, row.taskId, tx))) {
        await recordDecision(row, tx, now, 'cancelled', 'cancelled'); return null;
      }
      if (!row.isTest && now.getTime() - (row.nextAttemptAt ?? row.scheduledFor).getTime() > staleMs && rule?.repeatPolicy !== 'until_completed') {
        await recordDecision(row, tx, now, 'stale', 'cancelled'); return null;
      }
      const until = !row.isTest && !(settings.allowUrgentDuringQuiet && row.type === 'deadline') ? quietUntil(now, settings) : null;
      if (until) { await recordDecision(row, tx, now, 'suppressed_quiet_hours', 'suppressed_quiet_hours', until); deferred++; return null; }
      // A batch may wait behind earlier HTTP requests. Renew immediately before
      // publishing and abandon any claim a different dispatcher already took.
      const renewed = await tx.notification.updateMany({ where: { id: row.id, leaseId: row.leaseId, status: { in: pending } },
        data: { leaseUntil: new Date(Math.max(now.getTime(), Date.now()) + 120000) } });
      if (!renewed.count) return null;
      return { row, settings };
    });
    if (!ready) continue;
    const channel = ntfyConfiguration();
    const message = ready.row.isTest ? { title: ready.row.title, body: ready.row.body } : privateMessage(ready.row, ready.settings.notificationPrivacy);
    const outcome = channel.configured ? await publishNtfy(channel.value, { ...message, click: config.appUrl, priority: ready.row.type === 'deadline' ? 4 : 3 }) : { accepted: false, httpStatus: null, errorCode: channel.errorCode };
    await db.$transaction(async tx => {
      await lockOwner(tx, claim.userId);
      const attempt = await tx.notificationAttempt.createMany({ data: [{ id: newId(), userId: claim.userId, notificationId: claim.id, attemptedAt: now,
        outcome: outcome.accepted ? 'accepted' : 'failed', httpStatus: outcome.httpStatus, errorCode: outcome.errorCode, leaseId: claim.leaseId }], skipDuplicates: true });
      if (!attempt.count) return;
      const row = await tx.notification.findFirst({ where: { id: claim.id, leaseId: claim.leaseId, status: { in: pending } } }); if (!row) return;
      const attemptCount = row.attemptCount + 1;
      const retry = channel.configured ? nextRetry(attemptCount, now) : null;
      await tx.notification.update({ where: { id: row.id }, data: { status: outcome.accepted ? 'sent' : retry ? 'pending' : 'failed', attemptCount,
        sentAt: outcome.accepted ? new Date() : null, nextAttemptAt: outcome.accepted ? null : retry, leaseId: null, leaseUntil: null } });
      if (!outcome.accepted) return;
      sent++;
      const rule = row.reminderRuleId ? await tx.reminderRule.findFirst({ where: { id: row.reminderRuleId, userId: row.userId, enabled: true, archivedAt: null, repeatPolicy: 'until_completed' } }) : null;
      if (rule && row.taskId && await openTask(row.userId, row.taskId, tx)) {
        const next = new Date(now.getTime() + REPEAT_MINUTES * 60000); const base = row.dedupeKey.startsWith('repeat:') ? row.dedupeKey.split(':')[1]! : row.dedupeKey;
        await tx.notification.createMany({ data: [{ id: newId(), userId: row.userId, channel: 'ntfy', type: row.type, title: row.title, body: row.body,
          scheduledFor: next, dedupeKey: `repeat:${base}:${Math.floor(next.getTime() / (REPEAT_MINUTES * 60000))}`, ownerType: row.ownerType,
          ownerId: row.ownerId, reminderRuleId: row.reminderRuleId, taskId: row.taskId }], skipDuplicates: true });
      }
    });
  }
  return { claimed: claimed.length, sent, deferred };
}
