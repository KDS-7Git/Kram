import { describe, expect, it } from 'vitest';
import { defaultSettings, progressInputSchema, type Task } from '@kram/shared';
import { OfflineStore, type OfflineStorage, type CachedRead, type QueuedProgress } from './offline';

class MemoryStorage implements OfflineStorage {
  reads = new Map<string, CachedRead>(); events = new Map<string, QueuedProgress>(); account: string | null = null;
  async readAll(id: string) { return [...this.reads.values()].filter(read => read.accountId === id); }
  async getRead(key: string) { return this.reads.get(key); }
  async putRead(read: CachedRead) { this.reads.set(read.key, structuredClone(read)); }
  async removeRead(key: string) { this.reads.delete(key); }
  async queueAll(id: string) { return [...this.events.values()].filter(event => event.accountId === id); }
  async putEvent(event: QueuedProgress) { this.events.set(event.key, structuredClone(event)); }
  async removeEvent(key: string) { this.events.delete(key); }
  async getAccount() { return this.account; }
  async putAccount(id: string | null) { this.account = id; }
}
const input = (id: string, kind = 'progress', fields = {}) => progressInputSchema.parse({ clientEventId: id, kind, occurredAt: '2026-11-06T12:00:00Z', minutes: 5, ...fields });
const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];

describe('account-isolated offline reads and ordered replay', () => {
  it('isolates accounts and clears read caches on logout while preserving isolated unsent work', async () => {
    const memory = new MemoryStorage(), store = new OfflineStore(memory);
    await store.setAccount('a'); await store.cacheRead('/today', { private: 'a' }); await store.queueProgress('task', input(ids[0]!));
    await store.setAccount('b'); expect(await store.readCached('/today')).toBeNull(); expect(await store.listQueued()).toEqual([]);
    await store.cacheRead('/today', { private: 'b' }); await store.clearAccount(); expect(await store.readCached('/today')).toBeNull();
    await store.setAccount('a'); expect((await store.listQueued())[0]?.accountId).toBe('a'); expect(await store.readCached('/today')).toEqual(expect.objectContaining({ data: { private: 'a' } }));
    await store.clearAccount(); await store.setAccount('a'); expect(await store.readCached('/today')).toBeNull(); expect(await store.listQueued()).toHaveLength(1);
  });
  it('dedupes identical identifiers and rejects different payloads and planning changes', async () => {
    const store = new OfflineStore(new MemoryStorage()); await store.setAccount('a');
    await Promise.all([store.queueProgress('task', input(ids[0]!)), store.queueProgress('task', input(ids[0]!))]);
    expect(await store.listQueued()).toHaveLength(1);
    await expect(store.queueProgress('other', input(ids[0]!))).rejects.toMatchObject({ code: 'CLIENT_EVENT_CONFLICT' });
    await expect(store.queueProgress('task', input(ids[1]!, 'deferred', { toDate: '2026-11-07', minutes: 0 }))).rejects.toMatchObject({ code: 'OFFLINE_PLANNING_DISABLED' });
  });
  it('rejects a delayed response from a previous account before writing to the active cache', async () => {
    const store = new OfflineStore(new MemoryStorage()); await store.setAccount('a');
    const requestAccount = store.currentAccount();
    await store.setAccount('b'); await store.cacheRead('/today', { private: 'account a response' }, requestAccount);
    expect(await store.readCached('/today')).toBeNull();
    await store.cacheRead('/today', { private: 'account b response' }, 'b'); expect((await store.readCached('/today'))?.data).toEqual({ private: 'account b response' });
  });
  it('keeps identifiers and order through a lost response, then replays without double-counting', async () => {
    const store = new OfflineStore(new MemoryStorage()); await store.setAccount('a');
    await store.queueProgress('task', input(ids[0]!)); await store.queueProgress('task', input(ids[1]!));
    const committed = new Set<string>(); let drop = true; const calls: string[] = [];
    const sender = async (_task: string, event: ReturnType<typeof input>) => { calls.push(event.clientEventId); committed.add(event.clientEventId); if (drop) { drop = false; throw { code: 'NETWORK_ERROR' }; } };
    expect(await store.replayProgress(sender)).toMatchObject({ sent: 0, remaining: 2 });
    expect(await store.replayProgress(sender)).toMatchObject({ sent: 2, remaining: 0 });
    expect(calls).toEqual([ids[0], ids[0], ids[1]]); expect(committed.size).toBe(2);
  });
  it('retains closed-task conflicts, blocks later events for that task and permits other tasks', async () => {
    const store = new OfflineStore(new MemoryStorage()); await store.setAccount('a');
    await store.queueProgress('closed', input(ids[0]!)); await store.queueProgress('closed', input(ids[1]!)); await store.queueProgress('other', input(ids[2]!));
    const calls: string[] = []; const result = await store.replayProgress(async (task, event) => { calls.push(event.clientEventId); if (task === 'closed') throw { status: 409, code: 'TASK_CLOSED', message: 'Inspect task history.' }; });
    expect(result).toEqual({ sent: 1, conflicts: 1, remaining: 2 }); expect(calls).toEqual([ids[0], ids[2]]);
    const conflict = (await store.listQueued())[0]!; expect(conflict.status).toBe('conflict');
    await expect(store.discardEvent(conflict.key, false)).rejects.toMatchObject({ code: 'CONFIRM_DISCARD' });
    await store.retryConflict(conflict.key); expect((await store.listQueued())[0]?.status).toBe('pending'); await store.discardEvent(conflict.key, true); expect(await store.listQueued()).toHaveLength(1);
  });
  it('does not treat a requeued network result as acknowledgement and stops on account change', async () => {
    const store = new OfflineStore(new MemoryStorage()); await store.setAccount('a'); await store.queueProgress('task', input(ids[0]!));
    expect(await store.replayProgress(async () => ({ queued: true }))).toMatchObject({ sent: 0, remaining: 1 });
    await store.replayProgress(async () => { await store.setAccount('b'); }); expect(await store.listQueued()).toEqual([]);
    await store.setAccount('a'); expect(await store.listQueued()).toHaveLength(1);
  });
  it('updates cached task/list/today previews once per identifier and projects timer transitions', async () => {
    const memory = new MemoryStorage(), store = new OfflineStore(memory); await store.setAccount('a');
    const task = { id: 'task', goalId: 'goal', estMinutes: 30, qty: 30, actualMinutes: 0, completedQty: 0, remainingMinutes: 30, status: 'pending', timerStartedAt: null, timerAccumulatedMinutes: 0, timerElapsedMinutes: 0 } as Task;
    await store.cacheRead('/bootstrap', { data: { user: { id: 'a', settings: defaultSettings }, goals: [{ id: 'goal', unit: 'minutes' }], tasks: [task] }, headers: [] }); await store.cacheRead('/today', { tasks: [task], now: task });
    const start = input(ids[0]!, 'started', { minutes: 0 }); await store.queueProgress('task', start); expect(await store.projectQueuedTask('task', start)).toMatchObject({ status: 'in_progress', timerStartedAt: start.occurredAt, queued: true });
    const pause = input(ids[1]!, 'paused', { minutes: 0, occurredAt: '2026-11-06T12:10:00Z' }); await store.queueProgress('task', pause); expect(await store.projectQueuedTask('task', pause)).toMatchObject({ timerStartedAt: null, timerAccumulatedMinutes: 10 });
    const progress = input(ids[2]!, 'progress', { minutes: 8 }); await store.queueProgress('task', progress); await store.projectQueuedTask('task', progress); expect(await store.projectQueuedTask('task', progress)).toMatchObject({ status: 'partial', actualMinutes: 8, completedQty: 8, remainingMinutes: 22 });
    await store.setAccount('b'); expect(await store.projectQueuedTask('task', progress)).toBeNull();
  });
});
