import { createHash } from 'node:crypto';
import type { Notification, Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { settingsSchema, windowSchema } from '@kram/shared';
import { addDays, daysBetween, inDateRange, instantMillis, localToInstant, studyDate, weekday, weekStartDate } from '@kram/time';
import { freeSlots, type Layer } from '@kram/timetable';
import { evaluatePeriod, resolveProgress, streakAtRisk, type ProgressEvent, type StreakRule } from '@kram/streaks';
import type { PlanResult } from '@kram/scheduler';
import { db } from '../db';
import { config } from '../config';
import { calendarDate, calendarString } from '../calendar';
import { lockOwner, newId, notFound, type Connection } from '../repository';
import { refreshReminders } from '../modules/notifications/service';
import { nextRetry, privateMessage, quietUntil, REPEAT_MINUTES } from '../modules/notifications/policy';
import { decryptChannelConfig, ntfyChannel, telegramChannel, type ChannelId, type TelegramConfiguration } from './channels';
import { routeFor } from './channel-service';
import { streakRuleSchema } from './validation';
import { storedProgressUnit } from './history-context';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending = ['pending', 'suppressed_quiet_hours'];
const terminal = ['completed', 'skipped', 'cancelled'];
const urgent = new Set(['deadline', 'feasibility_warning', 'feasibility', 'backup_failed', 'worker_unhealthy']);
const prefixFor = (channel: ChannelId, source: string) => `r:${channel}:${hash(source)}`;
type Source = Prisma.NotificationCreateManyInput;
async function ownerSettings(userId: string, c: Connection) { return settingsSchema.parse(notFound(await c.user.findFirst({ where: { id: userId, isOwner: true } }), 'owner').settings); }
async function openTask(userId: string, taskId: string, c: Connection) { return c.task.findFirst({ where: { id: taskId, userId, isDemo: false, archivedAt: null, status: { notIn: terminal }, goal: { isDemo: false, archivedAt: null, status: 'active', skill: { archivedAt: null, profile: { archivedAt: null } } } } }); }

/** Standalone successor to the initial reminder projection; no transport I/O. */
export async function refreshFullReminders(userId: string, c: Connection = db, now = new Date()): Promise<{ created: number; routed: number }> {
  if (c === db) return db.$transaction(async tx => { await lockOwner(tx, userId); return refreshFullReminders(userId, tx, now); }, { timeout: 60000 });
  const previous = await c.notification.findMany({ where: { userId, isTest: false, dedupeKey: { startsWith: 'r:' } }, include: { attempts: { orderBy: { attemptedAt: 'desc' }, take: 1 } } });
  const external = await c.notification.findMany({ where: { userId, isTest: false, reminderRuleId: null, dedupeKey: { not: { startsWith: 'r:' } }, OR: [{ status: { in: pending } }, { type: { in: ['backup_failed', 'healthcheck_report', 'worker_unhealthy'] }, status: 'cancelled', scheduledFor: { gte: new Date(now.getTime() - 3600000) } }] } });
  await refreshReminders(userId, c, now);
  const settings = await ownerSettings(userId, c);
  if (!settings.notificationsEnabled) return { created: 0, routed: 0 };
  const channels = await c.userChannel.findMany({ where: { userId } });
  const local = channels.find(row => row.channel === 'ntfy'), telegram = channels.find(row => row.channel === 'telegram');
  const enabled = (channel: ChannelId) => channel === 'ntfy' ? local?.enabled !== false : !!telegram?.enabled && !!telegram.verifiedAt;
  const originals = await c.notification.findMany({ where: { userId, isTest: false, dedupeKey: { not: { startsWith: 'r:' } }, status: { in: pending }, channel: 'ntfy' } });
  const sourceMap = new Map<string, Source>([...originals, ...external, ...await fullReminderSources(userId, c, now)].map(source => [source.dedupeKey, source]));
  const sources = [...sourceMap.values()];
  const prefixes = new Set<string>(); let created = 0, routed = 0;
  for (const source of sources) {
    if (source.taskId && !await openTask(userId, source.taskId, c)) continue;
    if (source.ownerType === 'goal' && source.ownerId && (await c.goal.findFirst({ where: { id: source.ownerId, userId } }))?.isDemo) continue;
    if (source.ownerType === 'slot' && source.ownerId && (await c.timeSlot.findFirst({ where: { id: source.ownerId, userId } }))?.isDemo) continue;
    const routing = await routeFor(userId, { type: source.type, taskId: source.taskId ?? null, ownerType: source.ownerType ?? 'global', ownerId: source.ownerId ?? null }, c);
    const rule = source.reminderRuleId ? await c.reminderRule.findFirst({ where: { id: source.reminderRuleId, userId } }) : null;
    const selected = rule?.channel === 'telegram' ? ['telegram' as const] : routing.channels;
    for (const channel of selected.filter(enabled)) {
      const prefix = prefixFor(channel, source.dedupeKey); prefixes.add(prefix);
      const prior = previous.find(row => row.dedupeKey === prefix), snooze = source.taskId ? await c.notificationSnooze.findUnique({ where: { userId_taskId: { userId, taskId: source.taskId } } }) : null;
      if (prior?.status === 'cancelled' && prior.attempts[0]?.outcome === 'stale') continue;
      const scheduledFor = source.scheduledFor instanceof Date ? source.scheduledFor : new Date(source.scheduledFor);
      const delayed = snooze && snooze.until > now ? snooze.until : null;
      const create = { id: newId(), userId, channel, type: source.type, title: source.title, body: source.body, scheduledFor: prior?.scheduledFor ?? scheduledFor, dedupeKey: prefix, ownerType: source.ownerType, ownerId: source.ownerId, reminderRuleId: source.reminderRuleId, taskId: source.taskId, nextAttemptAt: delayed ?? prior?.nextAttemptAt ?? null };
      const result = await c.notification.createMany({ data: [create], skipDuplicates: true }); created += result.count; routed++;
      await c.notification.updateMany({ where: { userId, dedupeKey: prefix, status: 'cancelled' }, data: { status: 'pending', nextAttemptAt: delayed ?? prior?.nextAttemptAt ?? null, leaseId: null, leaseUntil: null } });
      await c.notification.updateMany({ where: { userId, dedupeKey: prefix, status: { in: pending } }, data: { title: source.title, body: source.body } });
    }
  }
  // Preserve the original projection as a source, while each channel owns its delivery row.
  if (originals.length) await c.notification.updateMany({ where: { userId, id: { in: originals.map(row => row.id) }, status: { in: pending } }, data: { status: 'cancelled', leaseId: null, leaseUntil: null } });
  for (const row of previous) {
    const base = row.dedupeKey.split(':repeat:')[0]!;
    if (!prefixes.has(base)) { await c.notification.updateMany({ where: { id: row.id, userId, status: { in: pending } }, data: { status: 'cancelled', leaseId: null, leaseUntil: null } }); continue; }
    if (row.dedupeKey !== base && pending.includes(row.status) && row.taskId && await openTask(userId, row.taskId, c)) await c.notification.updateMany({ where: { id: row.id, userId, status: 'cancelled' }, data: { status: row.status, nextAttemptAt: row.nextAttemptAt, leaseId: null, leaseUntil: null } });
  }
  // Explicit Snooze rows survive later projections while the task remains open.
  const snoozed = await c.notification.findMany({ where: { userId, dedupeKey: { startsWith: 'snooze:' }, status: 'cancelled', scheduledFor: { gte: new Date(now.getTime() - 3600000) } } });
  for (const row of snoozed) if (row.taskId && await openTask(userId, row.taskId, c)) await c.notification.updateMany({ where: { id: row.id, userId, status: 'cancelled' }, data: { status: 'pending' } });
  return { created, routed };
}

async function fullReminderSources(userId: string, c: Connection, now: Date): Promise<Source[]> {
  const settings = await ownerSettings(userId, c), today = studyDate(now.getTime(), settings.timezone, settings.dayRollover);
  const sources: Source[] = [];
  const at = (minute: number) => new Date(instantMillis(localToInstant(minute < settings.dayRollover ? addDays(today, 1) : today, minute, settings.timezone)));
  const add = (type: string, key: unknown, title: string, body: string, scheduledFor: Date, ownerType = 'global', ownerId: string | null = null, taskId: string | null = null) => { if (scheduledFor.getTime() >= now.getTime() - 3600000) sources.push({ id: newId(), userId, type, title, body, scheduledFor, dedupeKey: hash({ type, key }), ownerType, ownerId, taskId }); };
  const goals = await c.goal.findMany({ where: { userId, isDemo: false, archivedAt: null, status: 'active', skill: { archivedAt: null, profile: { archivedAt: null } } } });
  for (const goal of goals) if (goal.dueDate) { const days = daysBetween(today, calendarString(goal.dueDate)); if (days === 1 || days === 2) add('deadline', { goal: goal.id, due: goal.dueDate, days, today }, goal.title, `The deadline is in ${days} ${days === 1 ? 'day' : 'days'}. Open Kram to review the remaining work.`, at(settings.planReadyMin), 'goal', goal.id); }
  const tasks = await c.task.findMany({ where: { userId, isDemo: false, archivedAt: null, status: { notIn: terminal }, goalId: { in: goals.map(goal => goal.id) } }, include: { goal: { include: { skill: true } }, dependencies: true } });
  for (const task of tasks) if (task.dueDate && calendarString(task.dueDate) < today) add('overdue', { task: task.id, today }, task.title, 'This work is overdue. Review its date or record what happened.', at(settings.planReadyMin), 'task', task.id, task.id);
  const review = await c.dailyReview.findUnique({ where: { userId_date: { userId, date: calendarDate(today) } } });
  if (review?.state !== 'closed') add('daily_review', today, 'A moment to review your day', 'Record what happened and leave tomorrow with a clear plan.', at(settings.dailyReviewMin));
  if (today === addDays(weekStartDate(today, settings.weekStart), 6)) add('weekly_review', today, 'Your week, in perspective', 'Review your practice and choose a useful next week.', at(settings.dailyReviewMin));
  const proposals = await c.planVersion.findMany({ where: { userId, state: 'proposed' }, orderBy: { number: 'desc' }, take: 1 });
  for (const version of proposals) {
    const result = version.result as unknown as PlanResult;
    add(result.changes?.requiresApproval ? 'schedule_changed' : 'plan_ready', version.id, result.changes?.requiresApproval ? 'A schedule proposal is ready' : 'Your plan is ready', 'Open Kram to review the proposed time blocks.', version.createdAt);
    for (const warning of result.warnings ?? []) if (warning.goalId) add('feasibility_warning', { version: version.id, goal: warning.goalId, code: warning.code }, goals.find(goal => goal.id === warning.goalId)?.title ?? 'A goal needs a review', warning.message, version.createdAt, 'goal', warning.goalId);
  }
  const local = DateTime.fromMillis(now.getTime(), { zone: settings.timezone });
  const minute = local.hour * 60 + local.minute;
  if (local.toISODate() !== today || minute < Math.max(settings.planReadyMin, settings.dailyReviewMin - 60)) return sources;
  const definitions = await c.streakDef.findMany({ where: { userId, status: 'active' }, include: { rules: { orderBy: { version: 'asc' } } } });
  if (!definitions.length) return sources;
  const slots = await c.timeSlot.findMany({ where: { userId, isDemo: false, date: calendarDate(today), archivedAt: null } });
  const holiday = await c.holiday.findFirst({ where: { userId, date: calendarDate(today) } });
  const broken = await c.planningBreak.findFirst({ where: { userId, fromDate: { lte: calendarDate(today) }, toDate: { gte: calendarDate(today) } } });
  const startMin = Math.max(settings.wakingMin, minute);
  if (startMin >= settings.sleepingMin) return sources;
  const rows = await c.progressEvent.findMany({ where: { userId, goal: { isDemo: false }, OR: [{ taskId: null }, { task: { isDemo: false } }] }, include: { goal: { include: { skill: true } }, task: true, ruleVersion: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const events: ProgressEvent[] = rows.map(row => ({ id: row.id, taskId: row.taskId, goalId: row.goalId, skillId: row.goal.skillId, profileId: row.goal.skill.profileId, kind: row.kind, minutes: row.minutes, qty: row.qty, localDate: calendarString(row.localDate), unit: storedProgressUnit(row.ruleVersion?.rules, row.goal.unit), createdAt: row.createdAt.toISOString(), sequence: row.sequence, correctsEventId: row.referenceEventId, reportedTotalMinutes: row.reportedTotalMinutes, reportedTotalQty: row.reportedTotalQty }));
  const active = resolveProgress(events).filter(event => !event.unverified && event.localDate === today && ['progress', 'completed'].includes(event.kind));
  const verifiedToday = active.reduce((sum, event) => sum + event.minutes, 0);
  const allocated = slots.filter(slot => !['unavailable', 'reserved'].includes(slot.layer)).reduce((sum, slot) => sum + slot.endMin - slot.startMin, 0);
  const skills = await c.skill.findMany({ where: { userId, isDemo: false, archivedAt: null } });
  let free: ReturnType<typeof freeSlots>;
  try { free = freeSlots({ date: today, wakingWindow: { startMin, endMin: settings.sleepingMin }, slots: slots.map(slot => ({ ...slot, date: calendarString(slot.date), layer: slot.layer as Layer })), reservedWindows: skills.flatMap(skill => windowSchema.array().parse(skill.windows).map(window => ({ ...window, days: window.days.filter(day => skill.availableDays.includes(day)), skillId: skill.id }))), maxDailyMin: Math.max(0, Math.floor(settings.maxDailyMin - Math.max(0, verifiedToday - allocated))), minFreeTime: settings.minFreeMin, minBreak: settings.minBreakMin, breakAfter: settings.breakAfterMin, restDay: !!holiday || !!broken }); } catch { return sources; }
  const completedIds = new Set((await c.task.findMany({ where: { userId, status: 'completed' }, select: { id: true } })).map(task => task.id));
  for (const definition of definitions) {
    const version = [...definition.rules].reverse().find(rule => calendarString(rule.effectiveFrom) <= today); if (!version) continue;
    const stored = streakRuleSchema.parse(version.rules);
    const rule: StreakRule = { ...stored, scope: definition.scope as StreakRule['scope'], scopeId: definition.scopeId, version: version.version };
    if (rule.period !== 'day' || (['profile', 'global'].includes(rule.scope) && rule.measure === 'completion')) continue;
    const eligible = stored.eligibleDays.includes(weekday(today)) && !stored.restWeekdays?.includes(weekday(today)) && !stored.pausedRanges.some(range => inDateRange(today, range)) && !holiday && !broken;
    const scoped = (goalId: string, skillId: string, profileId: string) => rule.scope === 'global' || (rule.scope === 'goal' ? goalId : rule.scope === 'skill' ? skillId : profileId) === rule.scopeId;
    const relevant = tasks.filter(task => scoped(task.goalId, task.goal.skillId, task.goal.skill.profileId) && !task.unverified && calendarString(task.deferredToDate ?? task.earliestDate) <= today && task.goal.availableDays.includes(weekday(today)) && task.goal.skill.availableDays.includes(weekday(today)) && task.dependencies.every(dependency => completedIds.has(dependency.dependsOnTaskId)));
    const hasUnverified = review?.state === 'unverified' || tasks.some(task => task.unverified && scoped(task.goalId, task.goal.skillId, task.goal.skill.profileId) && calendarString(task.deferredToDate ?? task.dueDate ?? task.earliestDate) === today);
    const value = evaluatePeriod({ rule, period: { kind: 'day', start: today, end: today }, events: events.filter(event => scoped(event.goalId ?? '', event.skillId ?? '', event.profileId ?? '')), unverifiedDates: hasUnverified ? new Set([today]) : undefined });
    const freeCapacity = free.filter(slot => !slot.skillId || rule.scope === 'skill' && slot.skillId === rule.scopeId || relevant.some(task => task.goal.skillId === slot.skillId)).reduce((sum, slot) => sum + Math.max(0, slot.endMin - Math.max(slot.startMin, minute)), 0);
    const skillCapacity = [...new Set(relevant.map(task => task.goal.skillId))].reduce((sum, skillId) => {
      const skill = skills.find(skill => skill.id === skillId);
      const occupied = slots.filter(slot => slot.skillId === skillId && !['unavailable', 'reserved'].includes(slot.layer)).reduce((total, slot) => total + slot.endMin - slot.startMin, 0);
      const completed = active.filter(event => event.skillId === skillId).reduce((total, event) => total + event.minutes, 0);
      return sum + Math.max(0, (skill?.maxDailyMin ?? 0) - Math.max(occupied, completed));
    }, 0);
    const capacity = Math.min(freeCapacity, skillCapacity);
    const remainingMinutes = relevant.reduce((sum, task) => sum + task.remainingMinutes, 0);
    const remainingValue = rule.measure === 'minutes' ? remainingMinutes : rule.measure === 'quantity' ? relevant.reduce((sum, task) => sum + Math.max(0, task.qty - task.completedQty), 0) : relevant.length;
    if (streakAtRisk({ rule, verifiedValue: value.value, provisional: value.provisional, eligible: !!eligible, freeMinutes: capacity, qualifyingMinutes: remainingMinutes, remainingValue })) add('streak_at_risk', { streak: definition.id, rule: version.id, today }, definition.title, 'There is room for a small step before rollover. Open Kram to choose the remaining work.', now, 'streak', definition.id);
  }
  return sources;
}

async function decision(row: Notification, c: Connection, now: Date, outcome: string, status: string, nextAttemptAt: Date | null = null) {
  await c.notificationAttempt.createMany({ data: [{ id: newId(), userId: row.userId, notificationId: row.id, attemptedAt: now, outcome, leaseId: row.leaseId }], skipDuplicates: true });
  await c.notification.updateMany({ where: { id: row.id, leaseId: row.leaseId }, data: { status, nextAttemptAt, leaseId: null, leaseUntil: null } });
}
export async function dispatchFullNotifications(now = new Date(), limit = 10) {
  const claimed = await db.$transaction(async tx => { const rows = await tx.$queryRaw<Notification[]>`SELECT n.* FROM notification n JOIN app_user u ON u.id=n."userId" AND u."isOwner"=true WHERE n.channel IN ('ntfy','telegram') AND n.status IN ('pending','suppressed_quiet_hours') AND COALESCE(n."nextAttemptAt",n."scheduledFor") <= ${now} AND (n."leaseUntil" IS NULL OR n."leaseUntil" <= ${now}) ORDER BY n."scheduledFor",n.id LIMIT ${Math.max(1, Math.min(limit, 50))} FOR UPDATE OF n SKIP LOCKED`; return Promise.all(rows.map(row => tx.notification.update({ where: { id: row.id }, data: { leaseId: newId(), leaseUntil: new Date(now.getTime() + 120000) } }))); });
  let sent = 0, deferred = 0;
  for (const claim of claimed) {
    const ready = await db.$transaction(async tx => {
      await lockOwner(tx, claim.userId); const row = await tx.notification.findFirst({ where: { id: claim.id, leaseId: claim.leaseId, status: { in: pending } } }); if (!row) return null;
      const settings = await ownerSettings(row.userId, tx), channel = await tx.userChannel.findFirst({ where: { userId: row.userId, channel: row.channel } });
      const rule = row.reminderRuleId ? await tx.reminderRule.findFirst({ where: { id: row.reminderRuleId, userId: row.userId, enabled: true, archivedAt: null } }) : null;
      const routing = await routeFor(row.userId, row, tx);
      const available = row.channel === 'ntfy' ? row.isTest || channel?.enabled !== false : !!channel?.verifiedAt && (row.isTest || !!channel.enabled);
      if (!available || !row.isTest && (!settings.notificationsEnabled || (!routing.channels.includes(row.channel as ChannelId) && rule?.channel !== 'telegram') || row.reminderRuleId && !rule || row.taskId && !await openTask(row.userId, row.taskId, tx))) { await decision(row, tx, now, 'cancelled', 'cancelled'); return null; }
      const snooze = row.taskId ? await tx.notificationSnooze.findUnique({ where: { userId_taskId: { userId: row.userId, taskId: row.taskId } } }) : null;
      if (!row.isTest && snooze && snooze.until > now) { await decision(row, tx, now, 'snoozed', 'pending', snooze.until); deferred++; return null; }
      if (!row.isTest && now.getTime() - (row.nextAttemptAt ?? row.scheduledFor).getTime() > 3600000 && rule?.repeatPolicy !== 'until_completed') { await decision(row, tx, now, 'stale', 'cancelled'); return null; }
      const until = !row.isTest && !(settings.allowUrgentDuringQuiet && urgent.has(row.type)) ? quietUntil(now, settings) : null;
      if (until) { await decision(row, tx, now, 'suppressed_quiet_hours', 'suppressed_quiet_hours', until); deferred++; return null; }
      const renewed = await tx.notification.updateMany({ where: { id: row.id, leaseId: row.leaseId, status: { in: pending } }, data: { leaseUntil: new Date(Math.max(now.getTime(), Date.now()) + 120000) } });
      return renewed.count ? { row, settings, channel, topic: routing.topic } : null;
    });
    if (!ready) continue;
    let adapter = ntfyChannel(ready.topic), configurationInvalid = false;
    if (ready.row.channel === 'telegram') try { adapter = telegramChannel(decryptChannelConfig<TelegramConfiguration>(ready.row.userId, 'telegram', ready.channel!.encryptedConfig)); } catch { configurationInvalid = true; }
    const message = ready.row.isTest ? { title: ready.row.title, body: ready.row.body } : privateMessage(ready.row, ready.settings.notificationPrivacy || (ready.channel?.privacy ?? ready.row.channel === 'telegram'));
    const outcome = configurationInvalid ? { accepted: false, httpStatus: null, errorCode: 'CHANNEL_CONFIG_INVALID' } : await adapter.send({ ...message, priority: urgent.has(ready.row.type) ? 4 : ['healthcheck_report', 'plan_ready'].includes(ready.row.type) ? 2 : 3, click: config.appUrl, ...(ready.row.taskId && !ready.row.isTest ? { taskNotificationId: ready.row.id } : {}) });
    await db.$transaction(async tx => {
      await lockOwner(tx, claim.userId); const row = await tx.notification.findFirst({ where: { id: claim.id, leaseId: claim.leaseId, status: { in: pending } } }); if (!row) return;
      const attempt = await tx.notificationAttempt.createMany({ data: [{ id: newId(), userId: row.userId, notificationId: row.id, attemptedAt: now, outcome: outcome.accepted ? 'accepted' : 'failed', httpStatus: outcome.httpStatus, errorCode: outcome.errorCode, leaseId: claim.leaseId }], skipDuplicates: true }); if (!attempt.count) return;
      const attemptCount = row.attemptCount + 1, retry = nextRetry(attemptCount, now);
      await tx.notification.update({ where: { id: row.id }, data: { status: outcome.accepted ? 'sent' : retry ? 'pending' : 'failed', attemptCount, sentAt: outcome.accepted ? now : null, nextAttemptAt: outcome.accepted ? null : retry, leaseId: null, leaseUntil: null } });
      if (!outcome.accepted) return; sent++;
      const rule = row.reminderRuleId ? await tx.reminderRule.findFirst({ where: { id: row.reminderRuleId, userId: row.userId, enabled: true, archivedAt: null, repeatPolicy: 'until_completed' } }) : null;
      if (rule && row.taskId && await openTask(row.userId, row.taskId, tx)) {
        const scheduledFor = new Date(now.getTime() + REPEAT_MINUTES * 60000), base = row.dedupeKey.split(':repeat:')[0]!;
        await tx.notification.createMany({ data: [{ id: newId(), userId: row.userId, channel: row.channel, type: row.type, title: row.title, body: row.body, scheduledFor, dedupeKey: `${base}:repeat:${Math.floor(scheduledFor.getTime() / (REPEAT_MINUTES * 60000))}`, taskId: row.taskId, ownerType: row.ownerType, ownerId: row.ownerId, reminderRuleId: row.reminderRuleId }], skipDuplicates: true });
      }
    });
  }
  return { claimed: claimed.length, sent, deferred };
}
