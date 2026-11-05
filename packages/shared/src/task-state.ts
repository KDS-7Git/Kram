import { instantMillis, parseLocalDate } from '@kram/time';
import type { ProgressEvent } from './index';

export type TaskFoldStatus = 'pending' | 'in_progress' | 'partial' | 'completed' | 'deferred' | 'skipped' | 'cancelled';
export type TaskStateEvent = Pick<ProgressEvent,
  'id' | 'clientEventId' | 'taskId' | 'goalId' | 'kind' | 'minutes' | 'qty' |
  'occurredAt' | 'localDate' | 'createdAt' | 'referenceEventId' | 'toDate'> & { note?: string };

export interface TaskFoldSeed {
  id: string;
  goalId: string;
  estMinutes: number;
  qty: number;
  /** Minute-unit tasks use actual minutes directly; other units use quantity ratios. */
  quantityBased?: boolean;
  earliestDate: string;
  dueDate?: string | null;
}
export interface TaskFoldContext { now: string; today: string }
export interface TaskFoldState {
  taskId: string;
  goalId: string;
  status: TaskFoldStatus;
  actualMinutes: number;
  completedQty: number;
  remainingMinutes: number;
  timerStartedAt: string | null;
  timerAccumulatedMinutes: number;
  timerElapsedMinutes: number;
  timerLatestAt: string | null;
  deferredToDate: string | null;
  overdue: boolean;
  /** Surviving events, including corrections; safe input for unit-specific caches. */
  activeEvents: TaskStateEvent[];
  eventIds: string[];
}
export class TaskEventError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'TaskEventError'; }
}
const kinds = new Set(['started', 'paused', 'resumed', 'progress', 'completed', 'deferred', 'skipped', 'cancelled', 'correction']);
const closed = new Set<TaskFoldStatus>(['completed', 'skipped', 'cancelled']);
function fail(code: string, message: string): never { throw new TaskEventError(code, message); }
function amount(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) fail('INVALID_AMOUNT', `${name} must be a finite nonnegative number.`);
}
function validateEvent(event: TaskStateEvent) {
  if (!event.id || !event.clientEventId || !event.taskId || !event.goalId) fail('INVALID_EVENT', 'Task events need explicit identifiers.');
  if (!kinds.has(event.kind)) fail('INVALID_EVENT_KIND', 'Choose a supported task event.');
  amount(event.minutes, 'Minutes'); amount(event.qty, 'Quantity');
  instantMillis(event.occurredAt); instantMillis(event.createdAt); parseLocalDate(event.localDate);
  if (event.toDate !== null && event.toDate !== undefined) parseLocalDate(event.toDate);
  if (event.kind === 'deferred' && !event.toDate) fail('DEFER_DATE_REQUIRED', 'Choose the new study date.');
  if (event.kind === 'correction') {
    if (!event.referenceEventId) fail('CORRECTION_REFERENCE_REQUIRED', 'A correction must reference an earlier event.');
    if (event.minutes !== 0 || event.qty !== 0) fail('CORRECTION_AMOUNTS', 'Retract the old event, then log replacement progress separately.');
  } else if (event.referenceEventId) fail('INVALID_REFERENCE', 'Only a correction can reference another event.');
  if (!['progress', 'completed', 'correction'].includes(event.kind) && (event.minutes !== 0 || event.qty !== 0)) fail('INVALID_AMOUNT', 'Only progress and completion events record work.');
}
function fingerprint(event: TaskStateEvent) {
  return JSON.stringify([event.taskId, event.goalId, event.kind, event.minutes, event.qty,
    event.occurredAt, event.localDate, event.referenceEventId ?? null, event.toDate ?? null, event.note ?? '']);
}

/** Input order is authoritative append order (repository createdAt/id order). */
export function resolveTaskEvents(events: readonly TaskStateEvent[]) {
  const unique: TaskStateEvent[] = [], byClient = new Map<string, string>(), ids = new Set<string>();
  const scope = events[0];
  for (const event of events) {
    validateEvent(event);
    if (scope && (event.taskId !== scope.taskId || event.goalId !== scope.goalId)) fail('EVENT_SCOPE_MISMATCH', 'All events must belong to one task and goal.');
    const payload = fingerprint(event), previous = byClient.get(event.clientEventId);
    if (previous !== undefined) {
      if (previous !== payload) fail('CLIENT_EVENT_CONFLICT', 'This client event identifier was used for different work.');
      continue;
    }
    if (ids.has(event.id)) fail('EVENT_ID_CONFLICT', 'Each stored event needs a distinct identifier.');
    if (event.referenceEventId && !ids.has(event.referenceEventId)) fail('INVALID_REFERENCE', 'A correction must reference an earlier event in this task.');
    byClient.set(event.clientEventId, payload); ids.add(event.id); unique.push(event);
  }
  const inactive = new Set<string>();
  for (let index = unique.length - 1; index >= 0; index--) {
    const event = unique[index]!;
    if (!inactive.has(event.id) && event.kind === 'correction') inactive.add(event.referenceEventId!);
  }
  return { events: unique, activeEvents: unique.filter((event) => !inactive.has(event.id)), inactiveEventIds: [...inactive] };
}

/** Rebuild a cache without I/O. Historical orphan transitions after corrections are tolerated. */
export function foldTaskEvents(seed: TaskFoldSeed, events: readonly TaskStateEvent[], context: TaskFoldContext): TaskFoldState {
  amount(seed.estMinutes, 'Estimate'); amount(seed.qty, 'Task quantity');
  if (!seed.id || !seed.goalId || seed.qty === 0) fail('INVALID_TASK', 'A task needs identifiers and a positive quantity.');
  parseLocalDate(seed.earliestDate); parseLocalDate(context.today);
  if (seed.dueDate !== undefined && seed.dueDate !== null) {
    parseLocalDate(seed.dueDate);
    if (seed.dueDate < seed.earliestDate) fail('INVALID_TASK', 'A deadline cannot precede the earliest study date.');
  }
  const now = instantMillis(context.now);
  for (const event of events) if (event.taskId !== seed.id || event.goalId !== seed.goalId) fail('EVENT_SCOPE_MISMATCH', 'All events must belong to this task and goal.');
  const resolved = resolveTaskEvents(events);
  let status: TaskFoldStatus = 'pending', actualMinutes = 0, completedQty = 0;
  let timerStartedAt: string | null = null, timerAccumulatedMinutes = 0, timerLatestAt: string | null = null;
  let deferredToDate: string | null = null;
  function stopTimer(at: string) {
    if (timerStartedAt !== null) {
      timerAccumulatedMinutes += Math.max(0, instantMillis(at) - instantMillis(timerStartedAt)) / 60000;
      timerStartedAt = null;
      if (timerLatestAt === null || instantMillis(at) >= instantMillis(timerLatestAt)) timerLatestAt = at;
    }
  }
  for (const event of resolved.activeEvents) {
    if (event.kind === 'correction') continue;
    if (status === 'deferred' && deferredToDate && event.localDate >= deferredToDate) { status = 'pending'; deferredToDate = null; }
    if (event.kind === 'progress' || event.kind === 'completed') {
      actualMinutes += event.minutes; completedQty += event.qty;
    }
    if (closed.has(status)) continue;
    switch (event.kind) {
      case 'started': case 'resumed':
        if (status !== 'deferred') {
          status = 'in_progress';
          if (timerStartedAt === null && (timerLatestAt === null || instantMillis(event.occurredAt) >= instantMillis(timerLatestAt))) {
            timerStartedAt = event.occurredAt; timerLatestAt = event.occurredAt;
          }
        }
        break;
      case 'paused': stopTimer(event.occurredAt); break;
      case 'progress':
        stopTimer(event.occurredAt);
        if (event.minutes > 0 || event.qty > 0) { status = 'partial'; deferredToDate = null; }
        break;
      case 'completed': stopTimer(event.occurredAt); status = 'completed'; deferredToDate = null; break;
      case 'deferred': stopTimer(event.occurredAt); status = 'deferred'; deferredToDate = event.toDate!; break;
      case 'skipped': stopTimer(event.occurredAt); status = 'skipped'; deferredToDate = null; break;
      case 'cancelled': stopTimer(event.occurredAt); status = 'cancelled'; deferredToDate = null; break;
    }
  }
  if (status === 'deferred' && deferredToDate && context.today >= deferredToDate) { status = 'pending'; deferredToDate = null; }
  const remainingMinutes = status === 'completed' ? 0 : seed.quantityBased !== false && completedQty > 0
    ? Math.ceil(seed.estMinutes * Math.max(0, 1 - completedQty / seed.qty))
    : Math.max(0, seed.estMinutes - actualMinutes);
  if (!Number.isFinite(actualMinutes) || !Number.isFinite(completedQty) || !Number.isFinite(timerAccumulatedMinutes)) fail('INVALID_AMOUNT', 'Accumulated work is outside the supported numeric range.');
  return {
    taskId: seed.id, goalId: seed.goalId, status, actualMinutes, completedQty, remainingMinutes,
    timerStartedAt, timerAccumulatedMinutes,
    timerElapsedMinutes: timerAccumulatedMinutes + (timerStartedAt === null ? 0 : Math.max(0, now - instantMillis(timerStartedAt)) / 60000),
    timerLatestAt, deferredToDate, overdue: Boolean(seed.dueDate && seed.dueDate < context.today && !closed.has(status)),
    activeEvents: resolved.activeEvents, eventIds: resolved.events.map((event) => event.id),
  };
}

/** Validate a new append; replay itself remains tolerant of corrected history. */
export function assertTaskEventAllowed(state: TaskFoldState, event: TaskStateEvent): void {
  validateEvent(event);
  if (event.taskId !== state.taskId || event.goalId !== state.goalId) fail('EVENT_SCOPE_MISMATCH', 'This event belongs to another task or goal.');
  if (event.kind === 'correction') {
    if (!state.eventIds.includes(event.referenceEventId!)) fail('INVALID_REFERENCE', 'Choose an earlier event from this task.');
    return;
  }
  if (closed.has(state.status)) fail('TASK_CLOSED', 'Correct the earlier decision before adding work to a closed task.');
  if (event.kind === 'started' || event.kind === 'resumed' || event.kind === 'paused' ||
      (state.timerStartedAt !== null && ['progress', 'completed', 'cancelled'].includes(event.kind))) {
    if (state.timerLatestAt && instantMillis(event.occurredAt) < instantMillis(state.timerLatestAt)) fail('TIMER_ORDER_CONFLICT', 'Timer events must follow the previous timer instant.');
  }
  switch (event.kind) {
    case 'started':
      if (!['pending', 'partial', 'in_progress'].includes(state.status) || state.timerStartedAt) fail('INVALID_TRANSITION', 'Start an open task with a stopped timer.');
      break;
    case 'resumed':
      if (!['partial', 'in_progress'].includes(state.status) || state.timerStartedAt) fail('INVALID_TRANSITION', 'Resume a paused or partially completed task.');
      break;
    case 'paused':
      if (state.status !== 'in_progress' || !state.timerStartedAt) fail('INVALID_TRANSITION', 'Pause a running timer.');
      break;
    case 'progress':
      if (state.status === 'deferred') fail('INVALID_TRANSITION', 'Reach the deferred date before recording new work.');
      break;
    case 'completed': break;
    case 'deferred': case 'skipped':
      if (!['pending', 'partial'].includes(state.status)) fail('INVALID_TRANSITION', 'Pause and record partial progress before deferring or skipping this task.');
      if (event.kind === 'deferred' && event.toDate! <= event.localDate) fail('INVALID_DEFER_DATE', 'Defer to a later study date.');
      break;
    case 'cancelled': break;
  }
}

/** The API creates the correction and its identifiers; this helper checks its undo window. */
export function undoCompletionReference(events: readonly TaskStateEvent[], options: { now: string; explicitCorrection?: boolean }): string {
  const active = resolveTaskEvents(events).activeEvents;
  const completed = [...active].reverse().find((event) => event.kind === 'completed');
  if (!completed) fail('NOTHING_TO_UNDO', 'This task has no active completion to undo.');
  const elapsed = instantMillis(options.now) - instantMillis(completed.createdAt);
  if (!options.explicitCorrection && (elapsed < 0 || elapsed > 600000)) fail('UNDO_WINDOW_EXPIRED', 'Use an explicit correction to change a completion after ten minutes.');
  return completed.id;
}
