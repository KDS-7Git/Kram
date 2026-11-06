import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config';
import { ApiError } from '../errors';
import { ntfyConfiguration, publishNtfy, type ChannelOutcome } from '../modules/notifications/channel';
export type ChannelId = 'ntfy' | 'telegram';
export interface OutboundMessage { title: string; body: string; priority: number; click: string; taskNotificationId?: string }
export interface NotificationChannel { id: ChannelId; supportsActions: boolean; send(message: OutboundMessage): Promise<ChannelOutcome>; healthCheck(): Promise<boolean> }
export interface TelegramConfiguration { token: string; chatId?: string; senderId?: string }
const key = () => createHash('sha256').update(config.encryptionKey).digest();
export function encryptChannelConfig(userId: string, channel: ChannelId, value: unknown): string {
  if (!config.persistentEncryptionKey) throw new ApiError('ENCRYPTION_KEY_REQUIRED', 'Configure a persistent encryption key before linking a channel.', 409);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(`${userId}:${channel}`));
  const content = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), content].map(value => value.toString('base64url')).join('.');
}
export function decryptChannelConfig<T>(userId: string, channel: ChannelId, content: string): T {
  try {
    const [iv, tag, value] = content.split('.').map(part => Buffer.from(part, 'base64url'));
    if (!iv || !tag || !value) throw new Error('Invalid ciphertext');
    const cipher = createDecipheriv('aes-256-gcm', key(), iv); cipher.setAAD(Buffer.from(`${userId}:${channel}`)); cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(value), cipher.final()]).toString('utf8')) as T;
  } catch { throw new ApiError('CHANNEL_CONFIG_INVALID', 'This channel could not be unlocked. Re-link it with the instance’s current encryption key.', 409); }
}
export function telegramBaseUrl() { return process.env.NODE_ENV === 'test' && process.env.TELEGRAM_TEST_BASE_URL ? process.env.TELEGRAM_TEST_BASE_URL.replace(/\/$/, '') : 'https://api.telegram.org'; }
export async function telegramRequest<T>(token: string, method: string, body: unknown, timeout = 8000): Promise<{ ok: boolean; status: number | null; result?: T; errorCode: string | null }> {
  try {
    const response = await fetch(`${telegramBaseUrl()}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) { await response.body?.cancel(); return { ok: false, status: response.status, errorCode: response.status === 401 || response.status === 403 ? 'CHANNEL_AUTH_FAILED' : 'CHANNEL_HTTP_FAILED' }; }
    const text = await response.text(); if (text.length > 1000000) return { ok: false, status: response.status, errorCode: 'CHANNEL_RESPONSE_INVALID' };
    const value = JSON.parse(text) as { ok: boolean; result?: T };
    return { ok: value.ok === true, status: response.status, result: value.result, errorCode: value.ok === true ? null : 'CHANNEL_RESPONSE_INVALID' };
  } catch { return { ok: false, status: null, errorCode: 'CHANNEL_UNREACHABLE' }; }
}
export function ntfyChannel(topic?: string | null): NotificationChannel {
  return { id: 'ntfy', supportsActions: false, async healthCheck() { return ntfyConfiguration().configured; }, async send(message) { const configuration = ntfyConfiguration(); return configuration.configured ? publishNtfy({ ...configuration.value, ...(topic ? { topic } : {}) }, message) : { accepted: false, httpStatus: null, errorCode: configuration.errorCode }; } };
}
export function telegramChannel(configuration: TelegramConfiguration): NotificationChannel {
  return { id: 'telegram', supportsActions: true, async healthCheck() { return (await telegramRequest(configuration.token, 'getMe', {})).ok; }, async send(message) {
    if (!configuration.chatId) return { accepted: false, httpStatus: null, errorCode: 'CHANNEL_NOT_LINKED' };
    const result = await telegramRequest<{ message_id?: number }>(configuration.token, 'sendMessage', {
      chat_id: configuration.chatId, text: `${message.title}\n${message.body}`, disable_web_page_preview: true,
      reply_markup: { inline_keyboard: message.taskNotificationId ? [[{ text: 'Done', callback_data: `done:${message.taskNotificationId}` }, { text: 'Snooze 15 min', callback_data: `snooze:${message.taskNotificationId}` }, { text: 'Skip', callback_data: `skip:${message.taskNotificationId}` }], [{ text: 'Open Kram', url: message.click }]] : [[{ text: 'Open Kram', url: message.click }]] },
    });
    const accepted = result.ok && Number.isInteger(result.result?.message_id);
    return { accepted, httpStatus: result.status, errorCode: accepted ? null : result.errorCode ?? 'CHANNEL_RESPONSE_INVALID' };
  } };
}
export const telegramLinkSchema = z.object({ token: z.string().trim().regex(/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/, 'Enter the bot token supplied by BotFather.') }).strict();
export const notificationTypes = ['plan_ready', 'upcoming', 'task_reminder', 'deadline', 'overdue', 'daily_review', 'weekly_review', 'streak_at_risk', 'schedule_changed', 'feasibility_warning', 'backup_failed', 'worker_unhealthy', 'healthcheck_report'] as const;
export const defaultRouting: Record<string, ChannelId[]> = Object.fromEntries(notificationTypes.map(type => [type, ['deadline', 'feasibility_warning', 'daily_review', 'weekly_review', 'backup_failed', 'worker_unhealthy'].includes(type) ? ['ntfy', 'telegram'] : ['ntfy']]));
