import { createHash, randomBytes } from 'node:crypto';
import type { Notification, Prisma } from '@prisma/client';
import { z } from 'zod';
import { idSchema, settingsSchema } from '@kram/shared';
import { db } from '../db';
import { ApiError } from '../errors';
import { lockOwner, newId, notFound, type Connection } from '../repository';
import { ntfyConfiguration } from '../modules/notifications/channel';
import { decryptChannelConfig, encryptChannelConfig, defaultRouting, notificationTypes, telegramLinkSchema, telegramRequest, type ChannelId, type TelegramConfiguration } from './channels';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function assertOwner(userId: string, c: Connection = db) { return notFound(await c.user.findFirst({ where: { id: userId, isOwner: true } }), 'owner'); }
export async function channelStatus(userId: string, profileId?: string) {
  const owner = await assertOwner(userId), rows = await db.userChannel.findMany({ where: { userId } }), ntfy = ntfyConfiguration();
  let scope: Prisma.NotificationWhereInput = {};
  if (profileId) {
    notFound(await db.profile.findFirst({ where: { id: profileId, userId } }), 'profile');
    const skills = await db.skill.findMany({ where: { userId, profileId }, select: { id: true } }), skillIds = skills.map(row => row.id);
    const goals = await db.goal.findMany({ where: { userId, skillId: { in: skillIds } }, select: { id: true } }), goalIds = goals.map(row => row.id);
    const streaks = await db.streakDef.findMany({ where: { userId, OR: [{ scope: 'profile', scopeId: profileId }, { scope: 'skill', scopeId: { in: skillIds } }, { scope: 'goal', scopeId: { in: goalIds } }] }, select: { id: true } });
    const slots = await db.timeSlot.findMany({ where: { userId, OR: [{ profileId }, { skillId: { in: skillIds } }, { goalId: { in: goalIds } }, { task: { goalId: { in: goalIds } } }] }, select: { id: true } });
    scope = { OR: [{ task: { goalId: { in: goalIds } } }, { ownerType: 'goal', ownerId: { in: goalIds } }, { ownerType: 'slot', ownerId: { in: slots.map(row => row.id) } }, { ownerType: 'streak', ownerId: { in: streaks.map(row => row.id) } }] };
  }
  const [lastNtfy, lastTelegram] = await Promise.all(['ntfy', 'telegram'].map(channel => db.notification.findFirst({ where: { ...scope, userId, channel, status: 'sent', sentAt: { not: null } }, orderBy: [{ sentAt: 'desc' }, { id: 'desc' }], select: { sentAt: true } })));
  const telegram = rows.find(row => row.channel === 'telegram'), local = rows.find(row => row.channel === 'ntfy');
  let canDecrypt = false;
  if (telegram) try { canDecrypt = !!decryptChannelConfig<TelegramConfiguration>(userId, 'telegram', telegram.encryptedConfig).token; } catch { /* A useful status without leaking configuration. */ }
  return [
    { id: 'ntfy', channel: 'ntfy', configured: ntfy.configured, linked: ntfy.configured, enabled: local?.enabled ?? settingsSchema.parse(owner.settings).notificationsEnabled, privacy: local?.privacy ?? settingsSchema.parse(owner.settings).notificationPrivacy, topic: ntfy.configured ? ntfy.value.topic : null, baseUrl: ntfy.configured ? ntfy.value.baseUrl : null, verifiedAt: local?.verifiedAt ?? null, lastSentAt: lastNtfy?.sentAt ?? null, profileId: profileId ?? null },
    { id: 'telegram', channel: 'telegram', configured: canDecrypt, linked: !!telegram?.verifiedAt && canDecrypt, enabled: telegram?.enabled ?? false, privacy: telegram?.privacy ?? true, topic: null, baseUrl: null, verifiedAt: telegram?.verifiedAt ?? null, linking: !!telegram?.linkExpiresAt && telegram.linkExpiresAt > new Date(), lastSentAt: lastTelegram?.sentAt ?? null, profileId: profileId ?? null },
  ];
}
export async function linkTelegram(userId: string, input: unknown, now = new Date()) {
  const { token } = telegramLinkSchema.parse(input); await assertOwner(userId);
  const code = randomBytes(12).toString('hex'), expiresAt = new Date(now.getTime() + 10 * 60000);
  const encryptedConfig = encryptChannelConfig(userId, 'telegram', { token });
  return db.$transaction(async tx => {
    await lockOwner(tx, userId);
    const previous = await tx.userChannel.findFirst({ where: { userId, channel: 'telegram' } });
    let sameBot = false;
    if (previous) try { sameBot = decryptChannelConfig<TelegramConfiguration>(userId, 'telegram', previous.encryptedConfig).token?.split(':')[0] === token.split(':')[0]; } catch { /* Re-link restores unusable configuration. */ }
    await tx.userChannel.upsert({ where: { userId_channel: { userId, channel: 'telegram' } }, create: { id: newId(), userId, channel: 'telegram', encryptedConfig, linkCodeHash: digest(code), linkExpiresAt: expiresAt }, update: { encryptedConfig, verifiedAt: null, enabled: false, privacy: true, pollOffset: sameBot ? previous!.pollOffset : 0, linkCodeHash: digest(code), linkExpiresAt: expiresAt } });
    return { code, expiresAt, command: `/start ${code}` };
  });
}
const patchSchema = z.object({ enabled: z.boolean().optional(), privacy: z.boolean().optional() }).strict();
export async function patchChannel(userId: string, channel: ChannelId, input: unknown) {
  const value = patchSchema.parse(input); await assertOwner(userId);
  if (channel === 'telegram') { const row = notFound(await db.userChannel.findFirst({ where: { userId, channel } }), 'channel'); if (value.enabled && !row.verifiedAt) throw new ApiError('CHANNEL_NOT_LINKED', 'Link your private Telegram chat before enabling delivery.', 409); await db.userChannel.update({ where: { id: row.id, userId }, data: value }); }
  else { const configuration = ntfyConfiguration(); if (value.enabled && !configuration.configured) throw new ApiError('CHANNEL_NOT_CONFIGURED', 'Configure ntfy before enabling its channel.', 409); await db.userChannel.upsert({ where: { userId_channel: { userId, channel } }, create: { id: newId(), userId, channel, encryptedConfig: encryptChannelConfig(userId, channel, {}), verifiedAt: configuration.configured ? new Date() : null, ...value }, update: value }); }
  return (await channelStatus(userId)).find(row => row.channel === channel);
}
export async function unlinkChannel(userId: string, channel: ChannelId) {
  await assertOwner(userId); await db.userChannel.updateMany({ where: { userId, channel }, data: { enabled: false, verifiedAt: null, encryptedConfig: encryptChannelConfig(userId, channel, {}), linkCodeHash: null, linkExpiresAt: null } });
  await db.notification.updateMany({ where: { userId, channel, status: { in: ['pending', 'suppressed_quiet_hours'] } }, data: { status: 'cancelled', leaseId: null, leaseUntil: null } });
}
export async function testChannel(userId: string, channel: ChannelId) {
  const status = (await channelStatus(userId)).find(value => value.channel === channel)!;
  if (!status.configured || !status.linked) throw new ApiError('CHANNEL_NOT_CONFIGURED', 'Configure and link this channel before sending a test.', 409);
  const id = newId(); return db.notification.create({ data: { id, userId, channel, type: 'task_reminder', title: 'Kram notification test', body: 'This is a test from your Kram server.', scheduledFor: new Date(), dedupeKey: `test:${channel}:${id}`, isTest: true } });
}
export const routingSchema = z.object({ profileId: idSchema.nullable().default(null), type: z.enum(notificationTypes), channels: z.array(z.enum(['ntfy', 'telegram'])).max(2).refine(value => new Set(value).size === value.length, 'Choose each channel once.'), topic: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/, 'Use a protected, unguessable topic of at least 16 characters.').nullable().default(null) }).strict();
export async function saveRoute(userId: string, input: unknown) {
  const value = routingSchema.parse(input); await assertOwner(userId);
  if (value.profileId) notFound(await db.profile.findFirst({ where: { id: value.profileId, userId } }), 'profile');
  const routeKey = `${value.profileId ?? 'global'}:${value.type}`;
  return db.notificationRoute.upsert({ where: { userId_routeKey: { userId, routeKey } }, create: { id: newId(), userId, routeKey, ...value }, update: value });
}
export async function listRoutes(userId: string) { await assertOwner(userId); return { defaults: defaultRouting, routes: await db.notificationRoute.findMany({ where: { userId }, orderBy: { routeKey: 'asc' } }) }; }
export async function routeFor(userId: string, row: Pick<Notification, 'type' | 'taskId' | 'ownerType' | 'ownerId'>, c: Connection = db) {
  const type = row.type === 'feasibility' ? 'feasibility_warning' : row.type;
  const task = row.taskId ? await c.task.findFirst({ where: { userId, id: row.taskId }, include: { goal: { include: { skill: true } } } }) : null;
  const goal = !task && row.ownerType === 'goal' && row.ownerId ? await c.goal.findFirst({ where: { id: row.ownerId, userId }, include: { skill: true } }) : null;
  let profileId = task?.goal.skill.profileId ?? goal?.skill.profileId ?? null;
  if (!profileId && row.ownerType === 'streak' && row.ownerId) {
    const streak = await c.streakDef.findFirst({ where: { id: row.ownerId, userId } });
    if (streak?.scope === 'profile') profileId = streak.scopeId;
    if (streak?.scope === 'skill' && streak.scopeId) profileId = (await c.skill.findFirst({ where: { id: streak.scopeId, userId } }))?.profileId ?? null;
    if (streak?.scope === 'goal' && streak.scopeId) profileId = (await c.goal.findFirst({ where: { id: streak.scopeId, userId }, include: { skill: true } }))?.skill.profileId ?? null;
  }
  const routes = await c.notificationRoute.findMany({ where: { userId, type, OR: [{ profileId }, { profileId: null }] } });
  const route = routes.find(value => value.profileId === profileId) ?? routes.find(value => !value.profileId);
  return { channels: (route?.channels ?? defaultRouting[type] ?? ['ntfy']) as ChannelId[], topic: route?.topic ?? null, profileId };
}
export interface TelegramUpdatePayload { update_id: number; message?: { text?: string; chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean } }; callback_query?: { id: string; from: { id: number; is_bot?: boolean }; data?: string; message?: { chat: { id: number; type: string } } } }
export async function handleTelegramUpdate(channelId: string, update: TelegramUpdatePayload, now = new Date()) {
  if (!Number.isSafeInteger(update.update_id)) return 'ignored';
  const result = await db.$transaction(async tx => {
    const preliminary = notFound(await tx.userChannel.findFirst({ where: { id: channelId, channel: 'telegram' } }), 'channel');
    await lockOwner(tx, preliminary.userId); await assertOwner(preliminary.userId, tx);
    const row = notFound(await tx.userChannel.findFirst({ where: { id: channelId, userId: preliminary.userId } }), 'channel');
    const configuration = decryptChannelConfig<TelegramConfiguration>(row.userId, 'telegram', row.encryptedConfig);
    const botHash = digest(configuration.token?.split(':')[0] ?? 'disconnected');
    if (await tx.telegramUpdate.findUnique({ where: { channelId_botHash_updateId: { channelId, botHash, updateId: BigInt(update.update_id) } } })) {
      if (BigInt(update.update_id + 1) > row.pollOffset) await tx.userChannel.update({ where: { id: row.id, userId: row.userId }, data: { pollOffset: BigInt(update.update_id + 1) } });
      return { outcome: 'duplicate' };
    }
    let outcome = 'ignored';
    const message = update.message, callback = update.callback_query;
    if (message?.chat.type === 'private' && message.from?.id === message.chat.id && !message.from.is_bot && row.linkCodeHash && row.linkExpiresAt && row.linkExpiresAt > now) {
      const code = /^\/start\s+([a-f0-9]{24})$/.exec(message.text ?? '')?.[1];
      if (code && digest(code) === row.linkCodeHash) { await tx.userChannel.update({ where: { id: row.id, userId: row.userId }, data: { encryptedConfig: encryptChannelConfig(row.userId, 'telegram', { ...configuration, chatId: String(message.chat.id), senderId: String(message.from.id) }), enabled: true, verifiedAt: now, linkCodeHash: null, linkExpiresAt: null } }); outcome = 'linked'; }
    } else if (callback && callback.message?.chat.type === 'private' && !callback.from.is_bot && row.enabled && row.verifiedAt && String(callback.message.chat.id) === configuration.chatId && String(callback.from.id) === configuration.senderId) {
      const command = /^(done|skip|snooze):([a-f0-9-]{36})$/.exec(callback.data ?? '');
      if (command) {
        const notification = await tx.notification.findFirst({ where: { id: command[2], userId: row.userId, channel: 'telegram', isTest: false } });
        const task = notification?.taskId ? await tx.task.findFirst({ where: { id: notification.taskId, userId: row.userId, isDemo: false, archivedAt: null } }) : null;
        if (notification && task && !['completed', 'skipped', 'cancelled'].includes(task.status)) {
          if (command[1] === 'skip' && !['pending', 'partial'].includes(task.status)) outcome = 'action_needs_review';
          else {
          if (command[1] === 'snooze') {
            const scheduledFor = new Date(now.getTime() + 15 * 60000);
            await tx.notificationSnooze.upsert({ where: { userId_taskId: { userId: row.userId, taskId: task.id } }, create: { id: newId(), userId: row.userId, taskId: task.id, until: scheduledFor }, update: { until: scheduledFor } });
            await tx.notification.updateMany({ where: { userId: row.userId, taskId: task.id, status: { in: ['pending', 'suppressed_quiet_hours'] } }, data: { nextAttemptAt: scheduledFor, leaseId: null, leaseUntil: null } });
            await tx.notification.createMany({ data: [{ id: newId(), userId: row.userId, channel: 'telegram', type: notification.type, title: notification.title, body: notification.body, scheduledFor, dedupeKey: `snooze:telegram:${channelId}:${update.update_id}`, taskId: task.id, ownerType: notification.ownerType, ownerId: notification.ownerId, reminderRuleId: notification.reminderRuleId }], skipDuplicates: true });
          } else {
            const { v5 } = await import('uuid'); const { tasks } = await import('../modules/tasks/service');
            await tasks.event(row.userId, task.id, { kind: command[1] === 'done' ? 'completed' : 'skipped', clientEventId: v5(`${channelId}:${update.update_id}`, v5.URL), occurredAt: now.toISOString() }, tx);
            await tx.notification.updateMany({ where: { userId: row.userId, taskId: task.id, status: { in: ['pending', 'suppressed_quiet_hours'] } }, data: { status: 'cancelled', leaseId: null, leaseUntil: null } });
          }
          outcome = command[1] === 'done' ? 'completed' : command[1] === 'skip' ? 'skipped' : 'snoozed';
          }
        } else outcome = 'task_closed';
      }
    }
    await tx.telegramUpdate.create({ data: { id: newId(), userId: row.userId, channelId, botHash, updateId: BigInt(update.update_id), outcome } });
    await tx.userChannel.update({ where: { id: row.id, userId: row.userId }, data: { pollOffset: BigInt(update.update_id + 1) > row.pollOffset ? BigInt(update.update_id + 1) : row.pollOffset } });
    return { outcome, token: configuration.token, callbackId: outcome !== 'ignored' ? callback?.id : undefined };
  }, { timeout: 60000 });
  if (result.callbackId && result.token) await telegramRequest(result.token, 'answerCallbackQuery', { callback_query_id: result.callbackId, text: result.outcome === 'task_closed' ? 'This task is already closed.' : result.outcome === 'action_needs_review' ? 'Open Kram to log partial work before skipping.' : 'Saved in Kram.' });
  return result.outcome;
}
export async function pollTelegramUpdates(now = new Date(), longPollSeconds = 0) {
  const rows = await db.userChannel.findMany({ where: { channel: 'telegram', OR: [{ enabled: true, verifiedAt: { not: null } }, { linkExpiresAt: { gt: now } }] } });
  let handled = 0;
  for (const row of rows) {
    if (!await db.user.findFirst({ where: { id: row.userId, isOwner: true } })) continue;
    let configuration: TelegramConfiguration; try { configuration = decryptChannelConfig(row.userId, 'telegram', row.encryptedConfig); } catch { continue; }
    if (!configuration.token) continue;
    const result = await telegramRequest<TelegramUpdatePayload[]>(configuration.token, 'getUpdates', { offset: Number(row.pollOffset), timeout: Math.min(20, Math.max(0, longPollSeconds)), allowed_updates: ['message', 'callback_query'], limit: 50 }, 25000);
    if (!result.ok || !Array.isArray(result.result)) continue;
    for (const update of result.result) { await handleTelegramUpdate(row.id, update, now); handled++; }
  }
  return { handled };
}
export type ChannelRow = Prisma.UserChannelGetPayload<Record<string, never>>;
