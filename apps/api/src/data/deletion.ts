import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type DeletionKind, type DeletionPreview, type DeletionResult } from '@kram/shared';
import { db } from '../db';
import { ApiError } from '../errors';
import { audit, json, lockOwner, notFound, type Transaction } from '../repository';
import { evaluateStreaks } from '../streaks/service';
import { refreshReminders } from '../modules/notifications/service';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) => {
  if (Array.isArray(item) && item.length && item.every(row => row && typeof row === 'object' && typeof row.id === 'string')) return [...item].sort((a, b) => a.id.localeCompare(b.id));
  return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
})).digest('hex');
const ids = (rows: { id: string }[]) => rows.map(row => row.id).sort();
function refersTo(value: unknown, targets: Set<string>): boolean {
  if (typeof value === 'string') return targets.has(value);
  if (Array.isArray(value)) return value.some(item => refersTo(item, targets));
  return !!value && typeof value === 'object' && Object.values(value).some(item => refersTo(item, targets));
}

async function contents(userId: string, kind: DeletionKind, id: string, tx: Transaction) {
  const isGoal = kind === 'goal' || kind === 'goal-history', historyOnly = kind === 'goal-history';
  const goal = isGoal ? notFound(await tx.goal.findFirst({ where: { id, userId }, include: { skill: true } }), 'goal') : null;
  const series = kind === 'schedule' ? notFound(await tx.recurrenceSeries.findFirst({ where: { id, userId } }), 'schedule') : null;
  if (series?.kind === 'goal') throw new ApiError('DELETE_GOAL_REQUIRED', 'Delete this repeating goal from its goal page so its linked history is removed together.', 409);
  const template = kind === 'template' ? notFound(await tx.scheduleTemplate.findFirst({ where: { id, userId } }), 'template') : null;
  const tasks = isGoal ? await tx.task.findMany({ where: { userId, goalId: id }, orderBy: { id: 'asc' } }) : [];
  const taskIds = ids(tasks), goalIds = isGoal ? [id] : [];
  const events = isGoal ? await tx.progressEvent.findMany({ where: { userId, goalId: id }, orderBy: { id: 'asc' } }) : [];
  const rules = kind === 'goal' ? await tx.goalRuleVersion.findMany({ where: { userId, goalId: id } }) : [];
  const seriesRows = kind === 'goal' ? await tx.recurrenceSeries.findMany({ where: { userId, goalId: id } }) : series ? [series] : [];
  const seriesIds = ids(seriesRows);
  const occurrences = await tx.occurrence.findMany({ where: { userId, seriesId: { in: seriesIds } }, orderBy: { id: 'asc' } });
  if (seriesIds.length && await tx.task.count({ where: { userId, occurrence: { seriesId: { in: seriesIds } }, id: { notIn: taskIds } } })) throw new ApiError('LINKED_WORK', 'This schedule has work belonging to another goal. Remove that link before deleting it.', 409);
  const applications = await tx.templateApplication.findMany({ where: { userId } });
  // Makeup blocks belong to the source class even though they are one-off slots.
  const makeupIds = applications.flatMap(row => {
    const snapshot = row.snapshot as { sourceSeriesIds?: string[]; slotIds?: string[]; sourceSlots?: { id: string; seriesId: string }[] };
    if (snapshot.sourceSlots) return snapshot.sourceSlots.filter(slot => seriesIds.includes(slot.seriesId)).map(slot => slot.id);
    return snapshot.sourceSeriesIds?.length === 1 && seriesIds.includes(snapshot.sourceSeriesIds[0]!) ? snapshot.slotIds ?? [] : [];
  });
  const slots = historyOnly ? [] : await tx.timeSlot.findMany({ where: { userId, OR: [{ goalId: { in: goalIds } }, { taskId: { in: taskIds } }, { occurrenceId: { in: ids(occurrences) } }, { id: { in: makeupIds } }] }, orderBy: { id: 'asc' } });
  const targetIds = new Set([id, ...taskIds, ...seriesIds, ...ids(occurrences), ...ids(slots)]);
  const templates = kind === 'goal' ? (await tx.scheduleTemplate.findMany({ where: { userId } })).filter(row => refersTo(row.entries, new Set(goalIds))) : template ? [template] : [];
  const emptiedTemplates = templates.filter(row => kind === 'template' || (row.entries as { goalId?: string | null }[]).every(entry => !!entry.goalId && goalIds.includes(entry.goalId)));
  for (const row of emptiedTemplates) targetIds.add(row.id);
  const removedApplications = historyOnly ? [] : applications.filter(row => {
    const snapshot = row.snapshot as { operation?: string; sourceSeriesIds?: string[]; ids?: string[] };
    // ID-only receipts still track surviving meetings in a shared college day.
    if (snapshot.operation === 'class-day' && snapshot.sourceSeriesIds?.some(sourceId => !seriesIds.includes(sourceId))) return false;
    if (snapshot.operation === 'class-timetable' && snapshot.ids?.some(sourceId => !seriesIds.includes(sourceId))) return false;
    return !!row.templateId && ids(emptiedTemplates).includes(row.templateId) || refersTo(row.snapshot, targetIds);
  });
  const reminders = historyOnly ? [] : await tx.reminderRule.findMany({ where: { userId, OR: [{ ownerType: 'goal', ownerId: { in: goalIds } }, { ownerType: 'task', ownerId: { in: taskIds } }, { ownerType: 'slot', ownerId: { in: ids(slots) } }] } });
  const definitions = goal ? await tx.streakDef.findMany({ where: { userId, OR: [{ scope: 'goal', scopeId: id }, { scope: 'skill', scopeId: goal.skillId }, { scope: 'profile', scopeId: goal.skill.profileId }, { scope: 'global' }] } }) : [];
  const removedStreaks = kind === 'goal' ? definitions.filter(row => row.scope === 'goal' && row.scopeId === id) : [];
  const streakRules = await tx.streakRuleVersion.findMany({ where: { userId, streakId: { in: ids(removedStreaks) } } });
  // Rebuild aggregate streak records so erased work does not leave old totals.
  const streakRecords = await tx.streakRecord.findMany({ where: { userId, streakId: { in: ids(definitions) } } });
  for (const row of removedStreaks) targetIds.add(row.id);
  const notifications = await tx.notification.findMany({ where: { userId, OR: [{ taskId: { in: taskIds } }, { ownerId: { in: [...targetIds] } }, { reminderRuleId: { in: ids(reminders) } }] }, orderBy: { id: 'asc' } });
  const attempts = await tx.notificationAttempt.findMany({ where: { userId, notificationId: { in: ids(notifications) } } });
  const planVersions = (await tx.planVersion.findMany({ where: { userId }, include: { items: true } })).filter(row => refersTo(row.input, targetIds) || refersTo(row.result, targetIds) || refersTo(row.items, targetIds));
  const reviews = (await tx.dailyReview.findMany({ where: { userId } })).filter(row => refersTo(row.summary, targetIds));
  const breaks = kind === 'goal' ? (await tx.planningBreak.findMany({ where: { userId } })).filter(row => refersTo(row.choices, targetIds)) : [];
  const resources = kind === 'goal' ? await tx.resource.findMany({ where: { userId, goalId: id } }) : [];
  const resourceLinks = kind === 'goal' ? await tx.goalResource.findMany({ where: { userId, goalId: id } }) : [];
  const goalCache = isGoal ? await tx.goalProgressCache.findMany({ where: { userId, goalId: id } }) : [];
  const templateSlots = await tx.timeSlot.findMany({ where: { userId, templateId: { in: ids(emptiedTemplates) } } });
  const scope = { goal, series, template, tasks, events, rules, seriesRows, occurrences, slots, removedApplications, reminders, definitions, removedStreaks, streakRules, streakRecords, notifications, attempts, planVersions, reviews, breaks, resources, resourceLinks, templates, emptiedTemplates, templateSlots, goalCache };
  const counts = [
    { label: historyOnly ? 'Tasks reset to pending' : 'Tasks', count: tasks.length },
    { label: 'Progress and timer history entries', count: events.length },
    { label: 'Goal rule versions', count: rules.length },
    { label: 'Repeating schedules', count: seriesRows.length },
    { label: 'Timetable blocks', count: slots.length },
    { label: 'Linked saved plans', count: planVersions.length },
    { label: 'Linked daily reviews', count: reviews.length },
    { label: 'Reminder rules', count: reminders.length },
    { label: 'Notification history entries', count: notifications.length },
    { label: 'Goal streaks', count: removedStreaks.length },
    { label: 'Streak results to recalculate', count: streakRecords.length },
    { label: 'Template application records', count: removedApplications.length },
    { label: 'Templates', count: emptiedTemplates.length },
  ].filter(row => row.count > 0);
  const preview: DeletionPreview = { kind, id, title: goal?.title || series?.title || template!.name, token: digest({ userId, kind, id, scope }), taskIds, counts };
  return { scope, preview };
}

export const deletion = {
  preview(userId: string, kind: DeletionKind, id: string) {
    return db.$transaction(async tx => { await lockOwner(tx, userId); return (await contents(userId, kind, id, tx)).preview; }, { timeout: 30000 });
  },
  async remove(userId: string, kind: DeletionKind, id: string, input: unknown): Promise<DeletionResult> {
    const { token } = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input);
    return db.$transaction(async tx => {
      await lockOwner(tx, userId);
      const receipt = await tx.auditLog.findFirst({ where: { userId, action: 'permanent-deletion', detail: { path: ['token'], equals: token } } });
      if (receipt) {
        const saved = receipt.detail as { kind: string; id: string; taskIds: string[] };
        if (saved.kind === kind && saved.id === id) return { deleted: true, kind, id, taskIds: saved.taskIds };
      }
      const { scope: s, preview } = await contents(userId, kind, id, tx);
      if (preview.token !== token) throw new ApiError('DELETION_CHANGED', 'The contents changed after you opened this confirmation. Review the updated counts before deleting.', 412);
      const erasureScope = { goal_rule_version: ids(s.rules), progress_event: ids(s.events), notification_attempt: ids(s.attempts), template_application: ids(s.removedApplications), streak_rule_version: ids(s.streakRules), streak_record: ids(s.streakRecords), plan_item: s.planVersions.flatMap(row => ids(row.items)), plan_version: ids(s.planVersions) };
      await tx.$queryRaw`SELECT set_config('kram.erase_owner', ${userId}, true), set_config('kram.erase_scope', ${JSON.stringify(erasureScope)}, true)`;
      await tx.notificationAttempt.deleteMany({ where: { userId, id: { in: ids(s.attempts) } } });
      await tx.notification.deleteMany({ where: { userId, id: { in: ids(s.notifications) } } });
      await tx.reminderRule.deleteMany({ where: { userId, id: { in: ids(s.reminders) } } });
      await tx.notificationSnooze.deleteMany({ where: { userId, taskId: { in: preview.taskIds } } });
      await tx.plan.updateMany({ where: { userId, activeVersionId: { in: ids(s.planVersions) } }, data: { activeVersionId: null, version: { increment: 1 } } });
      await tx.planItem.deleteMany({ where: { userId, versionId: { in: ids(s.planVersions) } } });
      await tx.planVersion.deleteMany({ where: { userId, id: { in: ids(s.planVersions) } } });
      await tx.dailyReview.deleteMany({ where: { userId, id: { in: ids(s.reviews) } } });
      await tx.planningBreak.deleteMany({ where: { userId, id: { in: ids(s.breaks) } } });
      await tx.streakRecord.deleteMany({ where: { userId, id: { in: ids(s.streakRecords) } } });
      await tx.streakRuleVersion.deleteMany({ where: { userId, id: { in: ids(s.streakRules) } } });
      await tx.streakDef.deleteMany({ where: { userId, id: { in: ids(s.removedStreaks) } } });
      await tx.templateApplication.deleteMany({ where: { userId, id: { in: ids(s.removedApplications) } } });
      await tx.timeSlot.updateMany({ where: { userId, templateId: { in: ids(s.emptiedTemplates) } }, data: { templateId: null, version: { increment: 1 } } });
      await tx.scheduleTemplate.deleteMany({ where: { userId, id: { in: ids(s.emptiedTemplates) } } });
      for (const row of s.templates.filter(row => !ids(s.emptiedTemplates).includes(row.id))) await tx.scheduleTemplate.update({ where: { id: row.id }, data: { entries: json((row.entries as { goalId?: string | null }[]).filter(entry => entry.goalId !== id)), version: { increment: 1 } } });
      await tx.progressEvent.deleteMany({ where: { userId, id: { in: ids(s.events) } } });
      await tx.goalProgressCache.deleteMany({ where: { userId, goalId: { in: s.goal ? [id] : [] } } });
      if (kind === 'goal-history') {
        await tx.task.updateMany({ where: { userId, goalId: id }, data: { actualMinutes: 0, completedQty: 0, status: 'pending', eventVersion: 0, timerStartedAt: null, timerAccumulatedMinutes: 0, deferredToDate: null, unverified: false } });
        for (const task of s.tasks) await tx.task.update({ where: { id: task.id }, data: { remainingMinutes: task.estMinutes } });
      } else {
        await tx.timeSlot.deleteMany({ where: { userId, id: { in: ids(s.slots) } } });
        await tx.taskDependency.deleteMany({ where: { userId, OR: [{ taskId: { in: preview.taskIds } }, { dependsOnTaskId: { in: preview.taskIds } }] } });
        await tx.task.deleteMany({ where: { userId, id: { in: preview.taskIds } } });
        await tx.occurrence.deleteMany({ where: { userId, id: { in: ids(s.occurrences) } } });
        await tx.recurrenceException.deleteMany({ where: { userId, seriesId: { in: ids(s.seriesRows) } } });
        await tx.recurrenceSeries.deleteMany({ where: { userId, id: { in: ids(s.seriesRows) } } });
        await tx.goalRuleVersion.deleteMany({ where: { userId, id: { in: ids(s.rules) } } });
        await tx.goalResource.deleteMany({ where: { userId, id: { in: ids(s.resourceLinks) } } });
        await tx.resource.updateMany({ where: { userId, id: { in: ids(s.resources) } }, data: { goalId: null } });
        if (kind === 'goal') await tx.goal.delete({ where: { id, userId } });
      }
      if (s.goal) await evaluateStreaks(userId, tx);
      await refreshReminders(userId, tx);
      await audit(userId, 'permanent-deletion', { kind, id, token, taskIds: preview.taskIds }, undefined, tx);
      return { deleted: true, kind, id, taskIds: preview.taskIds };
    }, { timeout: 120000 });
  },
};
