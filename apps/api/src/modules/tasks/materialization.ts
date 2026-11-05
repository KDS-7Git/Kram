import { createHash } from 'node:crypto';
import type { Prisma, ResourceItem } from '@prisma/client';
import { dateSchema, goalSchema } from '@kram/shared';
import { addDays, dateRange, weekday, weekStartDate, studyDate } from '@kram/time';
import { db } from '../../db';
import { calendarDate, calendarString, clock } from '../../calendar';
import { lockOwner, newId, type Connection } from '../../repository';
import { getSettings } from '../hierarchy/service';
import { refreshReminders } from '../notifications/service';

type DesiredTask = Prisma.TaskCreateManyInput;
type Item = ResourceItem & { dependencies: { dependsOnItemId: string }[] };
const generated = (period: string) => /^(daily|weekly|item):/.test(period);
const keyFor = (userId: string, goalId: string, itemId: string | null, period: string) =>
  createHash('sha256').update(JSON.stringify([userId, goalId, itemId, period])).digest('hex');

/** Order leaves by the saved tree; prerequisites precede their dependants. */
function orderedLeaves(items: Item[]): Item[] {
  const activeItems = items.filter(item => !item.archivedAt);
  const byParent = new Map<string | null, Item[]>();
  for (const item of activeItems) byParent.set(item.parentItemId, [...(byParent.get(item.parentItemId) ?? []), item]);
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const leaves: Item[] = [];
  const walk = (parent: string | null) => { for (const item of byParent.get(parent) ?? []) { if (byParent.has(item.id)) walk(item.id); else if (item.estMinutes > 0) leaves.push(item); } };
  walk(null);
  const byId = new Map(leaves.map(item => [item.id, item])), visited = new Set<string>(), result: Item[] = [];
  const visit = (item: Item) => { if (visited.has(item.id)) return; visited.add(item.id); for (const edge of item.dependencies) for (const id of prerequisiteLeaves(edge.dependsOnItemId, items) ?? []) { const prerequisite = byId.get(id); if (prerequisite) visit(prerequisite); } result.push(item); };
  for (const item of leaves) visit(item);
  return result;
}
function prerequisiteLeaves(id: string, items: Item[]): string[] | null {
  const item = items.find(item => item.id === id); if (!item) return null;
  const children = items.filter(item => item.parentItemId === id);
  if (!children.length) return item.estMinutes > 0 ? [id] : null;
  const ids: string[] = [];
  for (const child of children) { const required = prerequisiteLeaves(child.id, items); if (!required) return null; ids.push(...required); }
  return ids.length ? ids : null;
}

/** Rolling source projection; caller may share its owner-locked transaction. */
export async function materializeTasks(userId: string, from?: string, c: Connection = db): Promise<{ created: number; updated: number; archived: number; unresolved: number }> {
  if (c === db) return db.$transaction(async tx => { await lockOwner(tx, userId); return materializeTasks(userId, from, tx); }, { timeout: 30000 });
  const settings = await getSettings(userId, c);
  const first = dateSchema.parse(from ?? studyDate(clock.now(), settings.timezone, settings.dayRollover)), last = addDays(first, 13);
  const goals = await c.goal.findMany({ where: { userId, status: 'active', archivedAt: null, skill: { archivedAt: null, profile: { archivedAt: null } } },
    include: { rules: { orderBy: [{ effectiveFrom: 'asc' }, { version: 'asc' }] }, resources: { include: { resource: { include: { items: { include: { dependencies: true } } } } } } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  const existing = await c.task.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const byKey = new Map(existing.map(task => [task.materializationKey, task]));
  const desired = new Map<string, DesiredTask>(), itemEdges = new Map<string, { goalId: string; item: Item; prerequisites: string[] }>();
  const calendarValues = new Map<string, Date>();
  const dateValue = (value: string) => { const existing = calendarValues.get(value); if (existing) return existing; const parsed = calendarDate(value); calendarValues.set(value, parsed); return parsed; };
  let unresolved = 0;
  for (const goal of goals) {
    const rulesAt = (date: string) => {
      const version = goal.rules.filter(version => calendarString(version.effectiveFrom) <= date).at(-1);
      return version ? goalSchema.parse(version.rules) : null;
    };
    const eligible = (date: string) => {
      const rule = rulesAt(date);
      return rule && date >= rule.startDate && (!rule.dueDate || date <= rule.dueDate) && rule.availableDays.includes(weekday(date));
    };
    const add = (date: string, due: string | null, qty: number, estimated: number, periodKey: string, title: string, sortOrder: number, itemId: string | null = null) => {
      const materializationKey = keyFor(userId, goal.id, itemId, periodKey), previous = byKey.get(materializationKey);
      desired.set(materializationKey, { id: previous?.id ?? newId(), userId, goalId: goal.id, itemId, title, estMinutes: estimated, remainingMinutes: estimated, qty,
        earliestDate: dateValue(date), dueDate: due ? dateValue(due) : null, periodKey, materializationKey, sortOrder });
    };
    // A linked resource is finite material. Closed/manual items never spawn a
    // second generated copy; a paused/archived source supplies no replacement.
    if (goal.resources.length) {
      const dates = dateRange(first, last).filter(eligible); let nextDate = 0;
      const leaves = goal.resources.filter(link => !link.resource.archivedAt).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.resourceId.localeCompare(b.resourceId)).flatMap(link => orderedLeaves(link.resource.items));
      for (const [index, item] of leaves.entries()) {
        const previous = existing.filter(task => task.goalId === goal.id && task.itemId === item.id);
        if (previous.some(task => task.manualOverride || !generated(task.periodKey) || task.eventVersion > 0 || ['completed', 'skipped', 'cancelled'].includes(task.status))) continue;
        if (nextDate >= dates.length) break;
        if (item.estMinutes > 960) { unresolved++; continue; }
        const sourceItems = goal.resources.find(link => link.resourceId === item.resourceId)!.resource.items;
        const required: string[] = []; let missingPrerequisite = false;
        for (const edge of item.dependencies) {
          const ids = prerequisiteLeaves(edge.dependsOnItemId, sourceItems) ??
            (existing.some(task => task.goalId === goal.id && task.itemId === edge.dependsOnItemId && task.status === 'completed') ? [edge.dependsOnItemId] : null);
          if (!ids || ids.includes(item.id)) { missingPrerequisite = true; break; }
          for (const id of ids) {
            const known = existing.some(task => task.goalId === goal.id && task.itemId === id && (task.status === 'completed' || !task.archivedAt && !['skipped', 'cancelled'].includes(task.status) && (task.manualOverride || task.eventVersion > 0 || !generated(task.periodKey)))) ||
              [...desired.values()].some(task => task.goalId === goal.id && task.itemId === id);
            if (!known) { missingPrerequisite = true; break; }
            required.push(id);
          }
          if (missingPrerequisite) break;
        }
        if (missingPrerequisite) { unresolved++; continue; }
        const date = dates[nextDate++]!, rule = rulesAt(date)!;
        const prior = previous.find(task => generated(task.periodKey) && !task.archivedAt);
        add(prior ? calendarString(prior.earliestDate) : date, rule.dueDate, rule.unit.toLowerCase() === 'minutes' ? item.estMinutes : item.qty, item.estMinutes,
          `item:${item.id}`, item.title, index, item.id);
        itemEdges.set(`${goal.id}:${item.id}`, { goalId: goal.id, item, prerequisites: [...new Set(required)] });
      }
      continue;
    }
    for (const date of dateRange(first, last)) {
      const rule = rulesAt(date); if (!rule || !eligible(date)) continue;
      // RRULE occurrences use the recurrence engine. Do not approximate them as daily.
      if (rule.type === 'recurring') { unresolved++; continue; }
      if (!['daily', 'weekly', 'milestone', 'adaptive'].includes(rule.type)) continue;
      let qty = rule.targetQty, period = `daily:${date}`, due: string | null = date;
      if (rule.type === 'weekly') {
        const week = weekStartDate(date, settings.weekStart), end = addDays(week, 6);
        const weekRows = existing.filter(task => task.goalId === goal.id && task.periodKey.startsWith(`weekly:${week}:`) && !task.archivedAt);
        const originalDate = (task: typeof existing[number]) => task.periodKey.split(':')[2]!;
        const protectedDates = new Set(weekRows.filter(task => task.eventVersion > 0 || task.manualOverride).map(originalDate));
        const commitments = weekRows.filter(task => originalDate(task) < first || protectedDates.has(originalDate(task)));
        // Keep a started date's other chunks intact. Its existing commitment
        // stays part of the quota; editable dates share only the remainder.
        for (const task of commitments) desired.set(task.materializationKey, task);
        const committedQty = commitments.reduce((sum, task) => sum + (task.status === 'completed' ? task.completedQty : task.qty), 0);
        const days = dateRange([week, first].sort().at(-1)!, end).filter(day => eligible(day) && !protectedDates.has(day));
        if (!days.length) continue;
        if (!days.includes(date)) continue;
        qty = Math.max(0, qty - committedQty) / days.length;
        if (qty <= 0) continue;
        period = `weekly:${week}:${date}`; due = rule.dueDate && rule.dueDate < end ? rule.dueDate : end;
      } else if (rule.type === 'milestone' || rule.type === 'adaptive') {
        if (date !== dateRange(first, last).find(eligible)) continue;
        period = `item:goal:${goal.id}`; due = rule.dueDate;
        const previous = existing.find(task => task.goalId === goal.id && task.periodKey.startsWith(period));
        if (previous?.eventVersion || previous && ['completed', 'skipped', 'cancelled'].includes(previous.status)) continue;
      }
      const minutesUnit = rule.unit.toLowerCase() === 'minutes', estimate = minutesUnit ? Math.ceil(qty) : rule.estMinutes;
      const chunks = Math.max(1, Math.ceil(estimate / 960));
      for (let index = 0; index < chunks; index++) {
        const minutes = Math.min(960, estimate - index * 960);
        const share = index === chunks - 1 ? qty - qty * (index * 960 / estimate) : qty * (minutes / estimate);
        add(date, due, share, minutes, `${period}:chunk:${index}`, goal.title, goal.sortOrder + index);
      }
    }
  }
  let created = 0, updated = 0, archived = 0;
  const missing = [...desired].filter(([key]) => !byKey.has(key)).map(([, value]) => value);
  if (missing.length) created = (await c.task.createMany({ data: missing, skipDuplicates: true })).count;
  for (const [key, value] of desired) {
    const previous = byKey.get(key);
    if (!previous) continue;
    if (previous.manualOverride || previous.eventVersion || !['pending', 'unverified'].includes(previous.status) || calendarString(previous.earliestDate) < first && !previous.itemId) continue;
    const { id: _id, userId: _userId, goalId: _goalId, itemId: _itemId, materializationKey: _key, periodKey: _period, ...projection } = value;
    const change = previous.archivedAt || ['title', 'estMinutes', 'qty', 'sortOrder'].some(field => previous[field as keyof typeof previous] !== value[field as keyof typeof value]) ||
      calendarString(previous.earliestDate) !== calendarString(value.earliestDate as Date) || (previous.dueDate ? calendarString(previous.dueDate) : null) !== (value.dueDate ? calendarString(value.dueDate as Date) : null);
    if (change) { await c.task.update({ where: { id: previous.id, userId }, data: { ...projection, archivedAt: null } }); updated++; }
  }
  const activeGoals = new Set(goals.map(goal => goal.id));
  for (const previous of existing) {
    if (!activeGoals.has(previous.goalId) || !generated(previous.periodKey) || previous.manualOverride || previous.eventVersion || previous.archivedAt || !['pending', 'unverified'].includes(previous.status) || desired.has(previous.materializationKey)) continue;
    if (!previous.itemId && (calendarString(previous.earliestDate) < first || calendarString(previous.earliestDate) > last)) continue;
    await c.task.update({ where: { id: previous.id, userId }, data: { archivedAt: new Date() } }); archived++;
  }
  const materialized = await c.task.findMany({ where: { userId, itemId: { not: null }, OR: [{ archivedAt: null }, { status: 'completed' }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const { goalId, item, prerequisites } of itemEdges.values()) {
    const task = materialized.find(task => task.goalId === goalId && task.itemId === item.id && generated(task.periodKey));
    if (!task || task.manualOverride || task.eventVersion) continue;
    await c.taskDependency.deleteMany({ where: { userId, taskId: task.id } });
    for (const id of prerequisites) {
      const prerequisite = materialized.find(task => task.goalId === goalId && task.itemId === id && (task.status === 'completed' || !['skipped', 'cancelled'].includes(task.status)));
      if (!prerequisite) { unresolved++; continue; }
      await c.taskDependency.createMany({ data: [{ id: newId(), userId, taskId: task.id, dependsOnTaskId: prerequisite.id }], skipDuplicates: true });
    }
  }
  await refreshReminders(userId, c);
  return { created, updated, archived, unresolved };
}
