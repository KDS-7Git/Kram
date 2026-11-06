import { DateTime } from 'luxon';
import { goalSchema } from '@kram/shared';
import { studyDate } from '@kram/time';
import { db } from '../db';
import { calendarDate, clock } from '../calendar';
import { lockOwner, newId, ownerWhere, json } from '../repository';
import { getSettings } from '../modules/hierarchy/service';
import { tasks as taskService } from '../modules/tasks/service';

/** An opt-in seven-day sample. No fabricated progress or reminder rules. */
export async function loadDemo(userId: string) {
  return db.$transaction(async tx => {
    await lockOwner(tx, userId);
    const existing = await tx.profile.findFirst({ where: { ...ownerWhere(userId), isDemo: true, archivedAt: null, timeSlots: { some: { isDemo: true, archivedAt: null } } } });
    if (existing) return { loaded: true, reused: true, profileId: existing.id };
    const settings = await getSettings(userId, tx);
    const today = studyDate(clock.now(), settings.timezone, settings.dayRollover);
    const dateAt = (offset: number) => DateTime.fromISO(today, { zone: 'UTC' }).plus({ days: offset }).toISODate()!;
    const profile = await tx.profile.create({ data: { id: newId(), userId, name: 'Demo · Sample week', icon: 'BookOpen', color: 'teal', isDemo: true } });
    const skill = await tx.skill.create({ data: { id: newId(), userId, profileId: profile.id, name: 'Demo · Learning', weeklyTargetMin: 100, dailyTargetMin: 20, isDemo: true } });
    const specs = [{ title: 'Demo · Make time to learn', unit: 'minutes', targetQty: 60 }, { title: 'Demo · Read a few pages', unit: 'pages', targetQty: 10 }];
    const goals = [];
    for (const spec of specs) {
      const fields = goalSchema.parse({ ...spec, skillId: skill.id, type: 'milestone', startDate: today, dueDate: dateAt(6), estMinutes: 20, availableDays: [1, 2, 3, 4, 5, 6, 7] });
      const goal = await tx.goal.create({ data: { ...fields, id: newId(), userId, startDate: calendarDate(today), dueDate: calendarDate(dateAt(6)), isDemo: true } });
      await tx.goalRuleVersion.create({ data: { id: newId(), userId, goalId: goal.id, version: 1, effectiveFrom: calendarDate(today), rules: json(fields) } }); goals.push(goal);
    }
    const lessons = ['Demo · Try the task timer', 'Demo · Record partial progress', 'Demo · Complete a small task', 'Demo · Read five pages', 'Demo · Review what helped'];
    for (const [index, title] of lessons.entries()) {
      const goal = goals[index < 3 ? 0 : 1]!;
      const date = dateAt(index);
      const task = await tx.task.create({ data: { id: newId(), userId, goalId: goal.id, title, estMinutes: 20, remainingMinutes: 20, qty: index < 3 ? 20 : 5, earliestDate: calendarDate(date), dueDate: calendarDate(date), periodKey: `demo:${profile.id}:${index}`, materializationKey: `demo:${profile.id}:${index}`, manualOverride: true, isDemo: true } });
      const start = Math.min(settings.wakingMin + 60, 1380);
      await tx.timeSlot.create({ data: { id: newId(), userId, date: calendarDate(date), startMin: start, endMin: start + 20, layer: 'flexible', title, profileId: profile.id, skillId: skill.id, goalId: goal.id, taskId: task.id, isDemo: true } });
    }
    return { loaded: true, reused: false, profileId: profile.id };
  });
}

/** Archive sample rows, retaining history and any real work added under sample containers. */
export async function removeDemo(userId: string) {
  return db.$transaction(async tx => {
    await lockOwner(tx, userId);
    const archivedAt = new Date(clock.now());
    const where = { ...ownerWhere(userId), isDemo: true, archivedAt: null };
    for (const task of await tx.task.findMany({ where: { ...where, timerStartedAt: { not: null } }, select: { id: true } })) {
      await taskService.event(userId, task.id, { clientEventId: newId(), kind: 'paused', occurredAt: archivedAt.toISOString(), note: 'Paused before removing the sample week' }, tx);
    }
    const slots = await tx.timeSlot.updateMany({ where, data: { archivedAt } });
    const tasks = await tx.task.updateMany({ where, data: { archivedAt } });
    const demoGoals = await tx.goal.findMany({ where });
    let goals = 0, skills = 0, profiles = 0;
    for (const goal of demoGoals) if (!await tx.task.count({ where: { userId, goalId: goal.id, archivedAt: null } })) { await tx.goal.update({ where: { id: goal.id, userId }, data: { archivedAt, status: 'archived' } }); goals++; }
    const demoSkills = await tx.skill.findMany({ where });
    for (const skill of demoSkills) {
      const [children, resources] = await Promise.all([tx.goal.count({ where: { userId, skillId: skill.id, archivedAt: null } }), tx.resource.count({ where: { userId, skillId: skill.id, archivedAt: null } })]);
      if (!children && !resources) { await tx.skill.update({ where: { id: skill.id, userId }, data: { archivedAt } }); skills++; }
    }
    for (const profile of await tx.profile.findMany({ where })) if (!await tx.skill.count({ where: { userId, profileId: profile.id, archivedAt: null } })) { await tx.profile.update({ where: { id: profile.id, userId }, data: { archivedAt } }); profiles++; }
    // Previously queued sample notifications are cancelled; append-only attempts remain.
    await tx.notification.updateMany({ where: { userId, task: { isDemo: true }, status: { in: ['pending', 'suppressed_quiet_hours'] } }, data: { status: 'cancelled', leaseId: null, leaseUntil: null } });
    return { removed: true, archived: { tasks: tasks.count, slots: slots.count, goals, skills, profiles }, retainedContainers: demoGoals.length - goals + demoSkills.length - skills };
  });
}
