import { addDays, localToInstant, studyDate, weekStartDate } from '@kram/time';
import { goalSchema, resolveTaskEvents } from '@kram/shared';
import { db } from '../../db';
import { calendarDate, calendarString } from '../../calendar';
import { getSettings } from '../hierarchy/service';
import { goals, goalDto } from '../goals/service';
import { listNotifications } from '../notifications/service';
import { tasks, taskDto, eventDto } from './service';
import { slotDto } from '../timetable/service';

const closed = new Set(['completed', 'cancelled', 'skipped']);
export async function todaySummary(userId: string) {
  const { now, today } = await tasks.context(userId);
  const settings = await getSettings(userId);
  const week = weekStartDate(today, settings.weekStart);
  const through = calendarDate(addDays(today, 1));
  // Civil arithmetic belongs to engine-time; use a two-day query for the study window.
  const [rows, goalRows, slotRows, weekTaskIds, notifications, historicalGoals] = await Promise.all([
    tasks.list(userId), goals.list(userId),
    db.timeSlot.findMany({ where: { userId, archivedAt: null, date: { gte: calendarDate(today), lte: through } }, orderBy: [{ date: 'asc' }, { startMin: 'asc' }, { id: 'asc' }] }),
    db.progressEvent.findMany({ where: { userId, taskId: { not: null }, localDate: { gte: calendarDate(week), lte: calendarDate(today) } }, select: { taskId: true } }),
    listNotifications(userId),
    db.goal.findMany({ where: { userId }, select: { id: true, skillId: true } }),
  ]);
  const histories = await db.progressEvent.findMany({ where: { userId, taskId: { in: [...new Set(weekTaskIds.map((row) => row.taskId!))] } }, orderBy: [{ sequence: 'asc' }, { id: 'asc' }] });
  const rules = await db.goalRuleVersion.findMany({ where: { userId, id: { in: [...new Set(histories.map((row) => row.ruleVersionId).filter((id): id is string => Boolean(id)))] } }, select: { id: true, rules: true } });
  const historicalSkills = new Map(rules.map((row) => [row.id, goalSchema.parse(row.rules).skillId]));
  const grouped = new Map<string, ReturnType<typeof eventDto>[]>();
  for (const row of histories) {
    const list = grouped.get(row.taskId!) ?? []; list.push(eventDto(row)); grouped.set(row.taskId!, list);
  }
  const active = [...grouped.values()].flatMap((events) => resolveTaskEvents(events).activeEvents);
  const dayTaskIds = new Set(active.filter((event) => event.localDate === today).map((event) => event.taskId));
  const slots = slotRows.filter((slot) => studyDate(localToInstant(calendarString(slot.date), slot.startMin, settings.timezone), settings.timezone, settings.dayRollover) === today).map(slotDto);
  const scheduledIds = new Set(slots.map((slot) => slot.taskId).filter(Boolean));
  const todayTasks = rows.filter((row) => {
    if (dayTaskIds.has(row.id) || scheduledIds.has(row.id) || row.timerStartedAt) return true;
    if (closed.has(row.status) || row.goal.status !== 'active') return false;
    return calendarString(row.earliestDate) <= today && (!row.deferredToDate || calendarString(row.deferredToDate) <= today);
  }).map((row) => taskDto(row, now, today));
  const byGoal = new Map(historicalGoals.map((goal) => [goal.id, goal.skillId]));
  const eventRules = new Map(histories.map((event) => [event.id, event.ruleVersionId]));
  const totals = new Map<string, number>(); let minutes = 0;
  for (const event of active) if (['progress', 'completed'].includes(event.kind) && event.localDate >= week && event.localDate <= today) {
    minutes += event.minutes;
    const ruleId = eventRules.get(event.id);
    const skillId = (ruleId ? historicalSkills.get(ruleId) : undefined) ?? byGoal.get(event.goalId);
    if (skillId) totals.set(skillId, (totals.get(skillId) ?? 0) + event.minutes);
  }
  const [review,unverifiedReviews,proposalCount]=await Promise.all([
    db.dailyReview.findUnique({where:{userId_date:{userId,date:calendarDate(today)}}}),
    db.dailyReview.findMany({where:{userId,state:'unverified'},orderBy:{date:'desc'},take:14,select:{date:true}}),
    db.planVersion.count({where:{userId,state:'proposed'}}),
  ]);
  const tomorrowFirst=slotRows.find(slot=>studyDate(localToInstant(calendarString(slot.date),slot.startMin,settings.timezone),settings.timezone,settings.dayRollover)>today);
  return { review:review?{state:review.state,summary:review.summary,closedAt:review.closedAt}:null,unverifiedReviews:unverifiedReviews.map(r=>calendarString(r.date)),proposalCount,tomorrowFirst:tomorrowFirst?slotDto(tomorrowFirst):null,studyDate: today, tasks: todayTasks, slots, goals: goalRows.map(goalDto), weekly: { minutes, bySkill: [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([skillId, value]) => ({ skillId, minutes: value })) }, notifications: notifications.slice(0, 50) };
}
