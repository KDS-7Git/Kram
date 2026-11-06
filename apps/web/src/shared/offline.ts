import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ProgressInput, Task } from '@kram/shared';

export interface QueuedProgress {
  key: string;
  accountId: string;
  taskId: string;
  input: ProgressInput;
  order: number;
  queuedAt: string;
  status: 'pending' | 'conflict';
  attempts: number;
  issue?: { code: string; message: string };
}
export interface CachedRead { key: string; accountId: string; path: string; data: unknown; savedAt: string }
interface OfflineDB extends DBSchema {
  reads: { key: string; value: CachedRead; indexes: { account: string } };
  progress: { key: string; value: QueuedProgress; indexes: { account: string } };
  meta: { key: string; value: string };
}
export interface OfflineStorage {
  readAll(accountId: string): Promise<CachedRead[]>;
  getRead(key: string): Promise<CachedRead | undefined>;
  putRead(read: CachedRead): Promise<void>;
  removeRead(key: string): Promise<void>;
  queueAll(accountId: string): Promise<QueuedProgress[]>;
  putEvent(event: QueuedProgress): Promise<void>;
  removeEvent(key: string): Promise<void>;
  getAccount(): Promise<string | null>;
  putAccount(accountId: string | null): Promise<void>;
}
class IndexedStorage implements OfflineStorage {
  private database?: Promise<IDBPDatabase<OfflineDB>>;
  private db() {
    return this.database ??= openDB<OfflineDB>('kram-offline-v1', 1, { upgrade(db) {
      db.createObjectStore('reads', { keyPath: 'key' }).createIndex('account', 'accountId');
      db.createObjectStore('progress', { keyPath: 'key' }).createIndex('account', 'accountId');
      db.createObjectStore('meta');
    } });
  }
  async readAll(accountId: string) { return (await this.db()).getAllFromIndex('reads', 'account', accountId); }
  async getRead(key: string) { return (await this.db()).get('reads', key); }
  async putRead(value: CachedRead) { await (await this.db()).put('reads', value); }
  async removeRead(key: string) { await (await this.db()).delete('reads', key); }
  async queueAll(accountId: string) { return (await this.db()).getAllFromIndex('progress', 'account', accountId); }
  async putEvent(value: QueuedProgress) { await (await this.db()).put('progress', value); }
  async removeEvent(key: string) { await (await this.db()).delete('progress', key); }
  async getAccount() { return (await this.db()).get('meta', 'account').then(value => value ?? null); }
  async putAccount(value: string | null) { const db = await this.db(); if (value) await db.put('meta', value, 'account'); else await db.delete('meta', 'account'); }
}
const allowed = new Set(['started', 'paused', 'resumed', 'progress', 'completed', 'skipped']);
const safeRead = /^(?:\/bootstrap|\/today|\/tasks(?:\/[a-f\d-]+(?:\/(?:events|planning))?)?|\/timetable(?:\/[^?]*)?|\/planning(?:\/[^?]*)?|\/recurrence\/occurrences|\/analytics\/overview|\/reviews(?:\/[^?]*)?|\/streaks(?:\/[^?]*)?)(?:\?|$)/i;
const keyFor = (accountId: string, value: string) => JSON.stringify([accountId, value]);
const stable = (value: unknown): string => JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
export class OfflineIssue extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'OfflineIssue'; }
}
export type QueuedTask = Task & { queued: true; offlineEventIds: string[] };
function projectTask(task: Task & { offlineEventIds?: string[] }, input: ProgressInput, minuteUnit: boolean): QueuedTask {
  if (task.offlineEventIds?.includes(input.clientEventId)) return { ...task, queued: true, offlineEventIds: task.offlineEventIds };
  const projected: QueuedTask = { ...task, queued: true, offlineEventIds: [...(task.offlineEventIds ?? []), input.clientEventId] };
  const stop = () => {
    if (projected.timerStartedAt) projected.timerAccumulatedMinutes += Math.max(0, Date.parse(input.occurredAt) - Date.parse(projected.timerStartedAt)) / 60000;
    projected.timerStartedAt = null; projected.timerElapsedMinutes = projected.timerAccumulatedMinutes;
  };
  switch (input.kind) {
    case 'started': case 'resumed': projected.status = 'in_progress'; projected.timerStartedAt = input.occurredAt; break;
    case 'paused': stop(); break;
    case 'progress':
      stop(); projected.actualMinutes += input.minutes; projected.completedQty += minuteUnit ? input.minutes : input.qty;
      if (input.minutes || input.qty) projected.status = 'partial'; break;
    case 'completed':
      stop(); projected.actualMinutes = Math.max(projected.actualMinutes, input.minutes); projected.completedQty = Math.max(projected.completedQty, minuteUnit ? projected.actualMinutes : input.qty); projected.status = 'completed'; break;
    case 'skipped': stop(); projected.status = 'skipped'; break;
  }
  projected.remainingMinutes = projected.status === 'completed' ? 0 : minuteUnit ? Math.max(0, projected.estMinutes - projected.actualMinutes) : projected.completedQty > 0 ? Math.ceil(projected.estMinutes * Math.max(0, 1 - projected.completedQty / projected.qty)) : Math.max(0, projected.estMinutes - projected.actualMinutes);
  return projected;
}
/** All reads and queued mutations are bound to a server-confirmed account ID. */
export class OfflineStore {
  private accountId: string | null = null;
  private listeners = new Set<() => void>();
  private replaying: Promise<{ sent: number; conflicts: number; remaining: number }> | null = null;
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(private storage: OfflineStorage = new IndexedStorage()) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { for (const listener of this.listeners) listener(); }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation, operation); this.mutations = next.catch(() => undefined); return next;
  }
  async restoreAccount() { this.accountId = await this.storage.getAccount(); this.notify(); return this.accountId; }
  currentAccount() { return this.accountId; }
  async setAccount(accountId: string | null) {
    this.accountId = accountId;
    await this.storage.putAccount(accountId); this.notify();
  }
  async clearAccount() {
    const accountId = this.accountId;
    this.accountId = null;
    await this.storage.putAccount(null);
    // Logout clears all personal reads. Unsent events remain isolated for this account.
    if (accountId) await Promise.all((await this.storage.readAll(accountId)).map(read => this.storage.removeRead(read.key)));
    this.notify();
  }
  async cacheRead(path: string, data: unknown, expectedAccountId: string | null = this.accountId) {
    const accountId = this.accountId;
    if (!accountId || accountId !== expectedAccountId || !safeRead.test(path)) return;
    await this.storage.putRead({ key: keyFor(accountId, path), accountId, path, data, savedAt: new Date().toISOString() });
    const reads = (await this.storage.readAll(accountId)).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    await Promise.all(reads.slice(50).map(read => this.storage.removeRead(read.key)));
  }
  async readCached<T>(path: string): Promise<{ data: T; savedAt: string } | null> {
    const accountId = this.accountId;
    if (!accountId || !safeRead.test(path)) return null;
    const read = await this.storage.getRead(keyFor(accountId, path));
    if (this.accountId !== accountId || !read || Date.now() - Date.parse(read.savedAt) > 7 * 86400000) return null;
    return { data: read.data as T, savedAt: read.savedAt };
  }
  async listQueued() {
    const accountId = this.accountId;
    if (!accountId) return [];
    const events = await this.storage.queueAll(accountId);
    return this.accountId === accountId ? events.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)) : [];
  }
  async projectQueuedTask(taskId: string, input: ProgressInput): Promise<QueuedTask | null> {
    const accountId = this.accountId;
    if (!accountId) return null;
    return this.mutate(async () => {
      const reads = await this.storage.readAll(accountId);
      if (accountId !== this.accountId) return null;
      const units = new Map<string, string>();
      const collect = (value: unknown) => {
        if (Array.isArray(value)) { value.forEach(collect); return; }
        if (!value || typeof value !== 'object') return;
        const object = value as Record<string, unknown>;
        if (typeof object.id === 'string' && typeof object.unit === 'string') units.set(object.id, object.unit);
        Object.values(object).forEach(collect);
      };
      reads.forEach(read => collect(read.data));
      let projected: QueuedTask | null = null;
      const visit = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(visit);
        if (!value || typeof value !== 'object') return value;
        const object = value as Record<string, unknown>;
        if (object.id === taskId && typeof object.goalId === 'string' && typeof object.estMinutes === 'number' && typeof object.actualMinutes === 'number') {
          const result = projectTask(object as unknown as Task, input, units.get(object.goalId)?.toLowerCase() === 'minutes');
          projected ??= result; return result;
        }
        return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, visit(child)]));
      };
      for (const read of reads) {
        const value = visit(read.data);
        if (accountId !== this.accountId) return null;
        await this.storage.putRead({ ...read, data: value });
      }
      this.notify(); return projected;
    });
  }
  async queueProgress(taskId: string, raw: ProgressInput) {
    const accountId = this.accountId;
    if (!accountId) throw new OfflineIssue('OFFLINE_ACCOUNT_REQUIRED', 'Reconnect and sign in once before recording offline progress.');
    const { progressInputSchema } = await import('@kram/shared');
    const input = progressInputSchema.parse(raw);
    if (!allowed.has(input.kind)) throw new OfflineIssue('OFFLINE_PLANNING_DISABLED', 'Reconnect before changing planning decisions or correcting history.');
    return this.mutate(async () => {
      if (accountId !== this.accountId) throw new OfflineIssue('ACCOUNT_CHANGED', 'Sign in again before recording progress.');
      const events = await this.storage.queueAll(accountId);
      const key = keyFor(accountId, input.clientEventId);
      const existing = events.find(event => event.key === key);
      if (existing) {
        if (existing.taskId !== taskId || stable(existing.input) !== stable(input)) throw new OfflineIssue('CLIENT_EVENT_CONFLICT', 'This event identifier belongs to different progress.');
        return existing;
      }
      if (events.length >= 1000) throw new OfflineIssue('OFFLINE_QUEUE_FULL', 'Reconnect and sync saved progress before recording more.');
      const event: QueuedProgress = { key, accountId, taskId, input, queuedAt: new Date().toISOString(), order: Math.max(0, ...events.map(event => event.order)) + 1, status: 'pending', attempts: 0 };
      await this.storage.putEvent(event); this.notify(); return event;
    });
  }
  async discardEvent(key: string, confirmed: boolean) {
    if (!confirmed) throw new OfflineIssue('CONFIRM_DISCARD', 'Confirm before discarding this unsent event.');
    const event = (await this.listQueued()).find(event => event.key === key);
    if (!event) throw new OfflineIssue('NOT_FOUND', 'This queued event is unavailable.');
    await this.storage.removeEvent(key); this.notify();
  }
  async retryConflict(key: string) {
    const event = (await this.listQueued()).find(event => event.key === key);
    if (!event) throw new OfflineIssue('NOT_FOUND', 'This queued event is unavailable.');
    await this.storage.putEvent({ ...event, status: 'pending', issue: undefined }); this.notify();
  }
  replayProgress(sender: (taskId: string, input: ProgressInput, accountId: string) => Promise<unknown>) {
    return this.replaying ??= this.performReplay(sender).finally(() => { this.replaying = null; this.notify(); });
  }
  private async performReplay(sender: (taskId: string, input: ProgressInput, accountId: string) => Promise<unknown>) {
    const accountId = this.accountId;
    let sent = 0, conflicts = 0;
    if (!accountId) return { sent, conflicts, remaining: 0 };
    const blocked = new Set<string>();
    const events = await this.listQueued();
    for (const event of events) {
      if (this.accountId !== accountId) break;
      if (event.status === 'conflict') { blocked.add(event.taskId); continue; }
      if (blocked.has(event.taskId)) continue;
      try {
        const result = await sender(event.taskId, event.input, accountId);
        if (result && typeof result === 'object' && 'queued' in result && result.queued) throw new OfflineIssue('NETWORK_ERROR', 'This event is still waiting to sync.');
        if (this.accountId !== accountId) break;
        await this.storage.removeEvent(event.key); sent++;
      } catch (error) {
        if (this.accountId !== accountId) break;
        const issue = error as { code?: string; message?: string; status?: number };
        const attempts = event.attempts + 1;
        const temporary = !issue.status || issue.status >= 500 || [401, 403, 408, 429].includes(issue.status);
        await this.storage.putEvent({ ...event, attempts, ...(temporary ? {} : { status: 'conflict', issue: { code: issue.code ?? 'REPLAY_CONFLICT', message: issue.message ?? 'Review this saved event before retrying.' } }) });
        if (temporary) break;
        blocked.add(event.taskId); conflicts++;
      }
      this.notify();
    }
    return { sent, conflicts, remaining: (await this.listQueued()).length };
  }
}
export const offline = new OfflineStore();
export const setOfflineAccount = (userId: string | null) => offline.setAccount(userId);
export const clearOfflineAccount = () => offline.clearAccount();
export const restoreOfflineAccount = () => offline.restoreAccount();
export const cacheRead = (path: string, data: unknown, expectedAccountId?: string | null) => offline.cacheRead(path, data, expectedAccountId);
export const readCached = <T>(path: string) => offline.readCached<T>(path);
export const queueProgress = (taskId: string, input: ProgressInput) => offline.queueProgress(taskId, input);
export const projectQueuedTask = (taskId: string, input: ProgressInput) => offline.projectQueuedTask(taskId, input);
export const listQueued = () => offline.listQueued();
export const subscribeOffline = offline.subscribe;
export const replayProgress = (sender: (taskId: string, input: ProgressInput, accountId: string) => Promise<unknown>) => offline.replayProgress(sender);
export async function registerOfflineShell() {
  if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) return navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return null;
}
