import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Settings } from 'luxon';
import { addDays, instantMillis } from '@kram/time';
import { assertTaskEventAllowed, foldTaskEvents, resolveTaskEvents, TaskEventError, undoCompletionReference, type TaskFoldSeed, type TaskStateEvent } from './task-state';

const seed: TaskFoldSeed = { id: 'task', goalId: 'goal', estMinutes: 60, qty: 10, earliestDate: '2026-11-05', dueDate: '2026-11-06' };
const context = { now: '2026-11-05T12:00:00Z', today: '2026-11-05' };
function event(id: string, kind: TaskStateEvent['kind'], fields: Partial<TaskStateEvent> = {}): TaskStateEvent {
  return { id, clientEventId: `client-${id}`, taskId: seed.id, goalId: seed.goalId, kind,
    minutes: 0, qty: 0, occurredAt: '2026-11-05T10:00:00Z', createdAt: '2026-11-05T10:00:01Z',
    localDate: '2026-11-05', referenceEventId: null, toDate: null, ...fields };
}
const fold = (events: TaskStateEvent[], override: Partial<typeof context> = {}) => foldTaskEvents(seed, events, { ...context, ...override });
function correction(id: string, referenceEventId: string) { return event(id, 'correction', { referenceEventId }); }
function expectCode(fn: () => unknown, code: string) {
  try { fn(); throw new Error(`Expected ${code}`); } catch (error) { expect(error).toBeInstanceOf(TaskEventError); expect((error as TaskEventError).code).toBe(code); }
}

describe('task progress and state replay', () => {
  it('starts pending and recalculates the specified 60/40/20 partial example', () => {
    expect(fold([])).toMatchObject({ status: 'pending', remainingMinutes: 60, actualMinutes: 0, timerElapsedMinutes: 0 });
    expect(fold([event('partial', 'progress', { minutes: 40 })])).toMatchObject({ status: 'partial', remainingMinutes: 20, actualMinutes: 40, completedQty: 0 });
  });

  it('uses quantity fraction for estimated remainder when quantity is logged', () => {
    expect(fold([event('pages', 'progress', { minutes: 45, qty: 2 })])).toMatchObject({ actualMinutes: 45, completedQty: 2, remainingMinutes: 48 });
    expect(foldTaskEvents({ ...seed, estMinutes: 61 }, [event('fraction', 'progress', { qty: 1 })], context).remainingMinutes).toBe(55);
    expect(fold([event('excess', 'progress', { minutes: 1000, qty: 50 })]).remainingMinutes).toBe(0);
  });

  it('adds progress and completion amounts as deltas and closes explicitly', () => {
    const events = [event('partial', 'progress', { minutes: 40, qty: 6 }), event('done', 'completed', { minutes: 20, qty: 4 })];
    expect(fold(events)).toMatchObject({ status: 'completed', actualMinutes: 60, completedQty: 10, remainingMinutes: 0 });
    expect(fold([event('done', 'completed', { minutes: 5, qty: 1 })])).toMatchObject({ status: 'completed', actualMinutes: 5, completedQty: 1, remainingMinutes: 0 });
  });

  it('keeps terminal skip/cancel decisions and computes overdue only for open work', () => {
    const later = { today: '2026-11-07', now: '2026-11-07T12:00:00Z' };
    expect(fold([], later).overdue).toBe(true);
    for (const kind of ['skipped', 'cancelled', 'completed'] as const) {
      const terminal = event(kind, kind);
      expect(fold([terminal], later)).toMatchObject({ status: kind, overdue: false });
      expectCode(() => assertTaskEventAllowed(fold([terminal]), event('new', 'started')), 'TASK_CLOSED');
      expect(fold([terminal, event('orphan', 'started')]).status).toBe(kind);
    }
  });

  it('retains deferred work until its study date and then returns it to pending', () => {
    const events = [event('partial', 'progress', { minutes: 40 }), event('later', 'deferred', { toDate: '2026-11-07' })];
    expect(fold(events)).toMatchObject({ status: 'deferred', remainingMinutes: 20, deferredToDate: '2026-11-07' });
    expect(fold(events, { today: '2026-11-06' }).status).toBe('deferred');
    expect(fold(events, { today: '2026-11-07' })).toMatchObject({ status: 'pending', remainingMinutes: 20, deferredToDate: null, overdue: true });
    expect(fold([...events, event('next', 'started', { localDate: '2026-11-07', occurredAt: '2026-11-07T10:00:00Z' })], { today: '2026-11-07', now: '2026-11-07T10:10:00Z' }).status).toBe('in_progress');
  });

  it('uses stored study dates for deferred transitions even around midnight', () => {
    const events = [event('later', 'deferred', { toDate: '2026-11-06' }), event('early', 'started', { occurredAt: '2026-11-06T01:30:00+05:30', localDate: '2026-11-05' })];
    expect(fold(events, { now: '2026-11-06T01:40:00+05:30' }).status).toBe('deferred');
  });
});

describe('timer event segments', () => {
  const started = event('start', 'started', { occurredAt: '2026-11-05T10:00:00Z' });
  const paused = event('pause', 'paused', { occurredAt: '2026-11-05T10:20:00Z' });
  const resumed = event('resume', 'resumed', { occurredAt: '2026-11-05T10:30:00Z' });

  it('adds closed segments and live elapsed separately from logged actual work', () => {
    expect(fold([started], { now: '2026-11-05T10:10:00Z' })).toMatchObject({ status: 'in_progress', timerAccumulatedMinutes: 0, timerElapsedMinutes: 10, actualMinutes: 0 });
    expect(fold([started, paused], { now: '2026-11-05T11:00:00Z' })).toMatchObject({ timerStartedAt: null, timerAccumulatedMinutes: 20, timerElapsedMinutes: 20 });
    expect(fold([started, paused, resumed], { now: '2026-11-05T10:40:00Z' })).toMatchObject({ timerAccumulatedMinutes: 20, timerElapsedMinutes: 30, actualMinutes: 0 });
  });

  it('closes a running timer on progress/completion without counting logged minutes twice', () => {
    const partial = event('partial', 'progress', { occurredAt: '2026-11-05T10:40:00Z', minutes: 30 });
    expect(fold([started, paused, resumed, partial])).toMatchObject({ status: 'partial', actualMinutes: 30, timerElapsedMinutes: 30, timerStartedAt: null });
    const done = event('done', 'completed', { occurredAt: '2026-11-05T10:40:00Z', minutes: 30 });
    expect(fold([started, paused, resumed, done])).toMatchObject({ status: 'completed', actualMinutes: 30, timerElapsedMinutes: 30, timerStartedAt: null });
  });

  it('uses elapsed instants across DST rather than subtracting civil clock labels', () => {
    const events = [event('start', 'started', { occurredAt: '2026-11-01T01:30:00-04:00', localDate: '2026-11-01' }), event('pause', 'paused', { occurredAt: '2026-11-01T01:30:00-05:00', localDate: '2026-11-01' })];
    expect(foldTaskEvents({ ...seed, earliestDate: '2026-11-01' }, events, { today: '2026-11-01', now: '2026-11-01T02:00:00-05:00' }).timerElapsedMinutes).toBe(60);
  });

  it('rejects new backward timer instants but tolerates corrected orphan pauses', () => {
    const state = fold([started, paused]);
    expectCode(() => assertTaskEventAllowed(state, event('backward', 'resumed', { occurredAt: '2026-11-05T10:10:00Z' })), 'TIMER_ORDER_CONFLICT');
    expect(fold([started, paused, correction('undo-start', started.id)])).toMatchObject({ status: 'pending', timerAccumulatedMinutes: 0, timerStartedAt: null });
    expect(fold([started], { now: '2026-11-05T09:59:00Z' }).timerElapsedMinutes).toBe(0);
  });
});

describe('idempotency and append-only corrections', () => {
  it('deduplicates identical client replay and rejects conflicting payloads', () => {
    const first = event('p', 'progress', { minutes: 20 });
    expect(fold([first, { ...first, id: 'retry', createdAt: '2026-11-05T11:00:00Z' }])).toEqual(fold([first]));
    expectCode(() => fold([first, { ...first, minutes: 21 }]), 'CLIENT_EVENT_CONFLICT');
    expectCode(() => fold([first, { ...first, clientEventId: 'different' }]), 'EVENT_ID_CONFLICT');
  });

  it('retracts the referenced contribution and restores it when the correction is corrected', () => {
    const first = event('p', 'progress', { minutes: 40, qty: 6 }), retract = correction('c', 'p');
    expect(fold([first, retract])).toMatchObject({ status: 'pending', actualMinutes: 0, completedQty: 0, remainingMinutes: 60 });
    expect(fold([first, retract, correction('cc', 'c')])).toMatchObject({ status: 'partial', actualMinutes: 40, completedQty: 6, remainingMinutes: 24 });
    expect(resolveTaskEvents([first, retract]).inactiveEventIds).toEqual(['p']);
  });

  it('undoes a completion to the prior partial state without rewriting either event', () => {
    const partial = event('p', 'progress', { minutes: 40 }), completed = event('done', 'completed', { minutes: 20 });
    expect(fold([partial, completed, correction('undo', completed.id)])).toMatchObject({ status: 'partial', actualMinutes: 40, remainingMinutes: 20 });
    expect(completed.kind).toBe('completed'); expect(completed.minutes).toBe(20);
  });

  it('does not discard logged contributions in tolerant terminal-state replay', () => {
    expect(fold([event('done', 'completed', { minutes: 30 }), event('late', 'progress', { minutes: 10 })])).toMatchObject({ status: 'completed', actualMinutes: 40 });
  });

  it('requires earlier same-task correction references and zero correction amounts', () => {
    expectCode(() => fold([correction('missing', 'later')]), 'INVALID_REFERENCE');
    expectCode(() => fold([event('missing', 'correction')]), 'CORRECTION_REFERENCE_REQUIRED');
    expectCode(() => fold([event('p', 'progress'), event('c', 'correction', { referenceEventId: 'p', minutes: 10 })]), 'CORRECTION_AMOUNTS');
    expectCode(() => fold([event('wrong', 'progress', { taskId: 'other' })]), 'EVENT_SCOPE_MISMATCH');
    expectCode(() => resolveTaskEvents([event('first', 'progress'), event('other', 'progress', { goalId: 'other' })]), 'EVENT_SCOPE_MISMATCH');
  });

  it('checks the exact ten-minute undo boundary using server receipt time', () => {
    const done = event('done', 'completed', { occurredAt: '2026-11-01T01:30:00Z', createdAt: '2026-11-05T10:00:00Z' });
    expect(undoCompletionReference([done], { now: '2026-11-05T10:10:00Z' })).toBe('done');
    expectCode(() => undoCompletionReference([done], { now: '2026-11-05T10:10:00.001Z' }), 'UNDO_WINDOW_EXPIRED');
    expectCode(() => undoCompletionReference([done], { now: '2026-11-05T09:59:59Z' }), 'UNDO_WINDOW_EXPIRED');
    expect(undoCompletionReference([done], { now: '2026-11-06T10:00:00Z', explicitCorrection: true })).toBe('done');
    expectCode(() => undoCompletionReference([done, correction('undo', 'done')], { now: context.now }), 'NOTHING_TO_UNDO');
  });
});

describe('strict new-event validation and deterministic invariants', () => {
  it('permits the documented open-state transitions and rejects invalid ones', () => {
    const pending = fold([]), running = fold([event('s', 'started')]);
    expect(() => assertTaskEventAllowed(pending, event('s', 'started'))).not.toThrow();
    expect(() => assertTaskEventAllowed(running, event('p', 'paused'))).not.toThrow();
    expectCode(() => assertTaskEventAllowed(pending, event('r', 'resumed')), 'INVALID_TRANSITION');
    expectCode(() => assertTaskEventAllowed(running, event('d', 'deferred', { toDate: '2026-11-06' })), 'INVALID_TRANSITION');
    expectCode(() => assertTaskEventAllowed(pending, event('d', 'deferred', { toDate: '2026-11-05' })), 'INVALID_DEFER_DATE');
    const deferred = fold([event('d', 'deferred', { toDate: '2026-11-07' })]);
    expect(() => assertTaskEventAllowed(deferred, event('done', 'completed'))).not.toThrow();
    expect(() => assertTaskEventAllowed(deferred, event('cancel', 'cancelled'))).not.toThrow();
    expectCode(() => assertTaskEventAllowed(deferred, event('s', 'started')), 'INVALID_TRANSITION');
    expectCode(() => assertTaskEventAllowed(deferred, event('p', 'progress', { minutes: 10 })), 'INVALID_TRANSITION');
  });

  it('allows valid corrections for closed tasks and rejects unknown references', () => {
    const state = fold([event('done', 'completed')]);
    expect(() => assertTaskEventAllowed(state, correction('undo', 'done'))).not.toThrow();
    expectCode(() => assertTaskEventAllowed(state, correction('missing', 'unknown')), 'INVALID_REFERENCE');
  });

  it('rejects negative/nonfinite amounts, invalid dates and inappropriate work-bearing events', () => {
    for (const fields of [{ minutes: -1 }, { qty: Number.NaN }, { minutes: Number.POSITIVE_INFINITY }]) expectCode(() => fold([event('invalid', 'progress', fields)]), 'INVALID_AMOUNT');
    expectCode(() => fold([event('bad-start', 'started', { minutes: 10 })]), 'INVALID_AMOUNT');
    expect(() => fold([event('bad-date', 'progress', { localDate: '2026-02-30' })])).toThrow();
    expect(() => foldTaskEvents({ ...seed, dueDate: '' }, [], context)).toThrow();
    expectCode(() => foldTaskEvents({ ...seed, qty: 0 }, [], context), 'INVALID_TASK');
  });

  it('never reads the ambient clock or mutates its inputs', () => {
    const originalNow = Settings.now;
    const base = Object.freeze({ ...seed }), events = Object.freeze([Object.freeze(event('p', 'progress', { minutes: 40 }))]);
    try { Settings.now = () => { throw new Error('Unexpected ambient clock'); }; expect(foldTaskEvents(base, events, context).remainingMinutes).toBe(20); }
    finally { Settings.now = originalNow; }
    expect(events[0]!.minutes).toBe(40);
  });

  it('preserves nonnegative remainder, delta conservation and duplicate replay invariance over generated histories', () => {
    fc.assert(fc.property(fc.array(fc.record({ minutes: fc.integer({ min: 0, max: 200 }), qty: fc.integer({ min: 0, max: 10 }) }), { maxLength: 25 }), (work) => {
      const events = work.map((value, index) => event(`p-${index}`, 'progress', value));
      const state = fold(events);
      expect(state.actualMinutes).toBe(work.reduce((sum, value) => sum + value.minutes, 0));
      expect(state.completedQty).toBe(work.reduce((sum, value) => sum + value.qty, 0));
      expect(state.remainingMinutes).toBeGreaterThanOrEqual(0);
      expect(fold(events.flatMap((value) => [value, { ...value }]))).toEqual(state);
    }), { numRuns: 150, seed: 20261106 });
  });

  it('advances deferred states by civil dates independently of elapsed-day duration', () => {
    const deferred = event('d', 'deferred', { toDate: addDays(seed.earliestDate, 2) });
    expect(fold([deferred], { today: addDays(seed.earliestDate, 2) }).status).toBe('pending');
    expect(instantMillis('2026-11-05T12:00:00+05:30')).toBe(instantMillis('2026-11-05T06:30:00Z'));
  });
});
