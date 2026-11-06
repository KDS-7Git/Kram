import { Router } from 'express';
import { z } from 'zod';
import { idSchema } from '@kram/shared';
import { ApiError } from '../errors';
import { overview } from './service';

export const analyticsRouter = Router();
const date = z.iso.date();
analyticsRouter.get('/analytics/overview', async (req, res) => res.json(await overview(String(res.locals.userId), req.query.weekStart ? date.parse(req.query.weekStart) : undefined)));
analyticsRouter.get('/analytics/calibration', async (_req, res) => res.json((await overview(String(res.locals.userId))).calibration));
for (const scope of ['profiles', 'skills', 'goals'] as const) {
  analyticsRouter.get(`/analytics/${scope}/:id`, async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const report = await overview(String(res.locals.userId), req.query.weekStart ? date.parse(req.query.weekStart) : undefined);
    const skills = report.skills.filter(skill => scope === 'profiles' ? skill.profileId === id : scope === 'skills' ? skill.id === id : report.goals.some(goal => goal.id === id && goal.skillId === skill.id));
    const goals = report.goals.filter(goal => scope === 'goals' ? goal.id === id : skills.some(skill => skill.id === goal.skillId));
    if (!skills.length && !goals.length) throw new ApiError('NOT_FOUND', 'This analytics scope is unavailable.', 404);
    const selectedSkills = skills.map(skill => {
      const selected = goals.filter(goal => goal.skillId === skill.id);
      return { ...skill, minutes: selected.reduce((sum, goal) => sum + goal.weeklyMinutes, 0), completions: selected.reduce((sum, goal) => sum + goal.weeklyCompletions, 0),
        days: report.days.map(day => ({ date: day.date, minutes: selected.reduce((sum, goal) => sum + (goal.days.find(value => value.date === day.date)?.minutes ?? 0), 0) })),
        units: [...new Set(selected.map(goal => goal.unit))].map(unit => ({ unit, credited: selected.filter(goal => goal.unit === unit).reduce((sum, goal) => sum + goal.weeklyCredited, 0) })) };
    });
    res.json({ ...report, skills: selectedSkills, goals, calibration: report.calibration.filter(row => skills.some(skill => skill.id === row.skillId)),
      totalMinutes: goals.reduce((sum, goal) => sum + goal.weeklyMinutes, 0), completedTasks: goals.reduce((sum, goal) => sum + goal.weeklyCompletions, 0),
      days: report.days.map(day => ({ date: day.date, minutes: selectedSkills.reduce((sum, skill) => sum + (skill.days.find(value => value.date === day.date)?.minutes ?? 0), 0) })) });
  });
}
