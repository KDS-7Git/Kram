import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { addDays } from '@kram/time';
import { BarChart3, ChevronLeft, ChevronRight } from 'lucide-react';
import type { AnalyticsReport } from '../../../../api/src/analytics/report';
import { Banner, Button, Card, DelayedSkeleton, EmptyState, Field, IconButton, PageHeader } from '../../components/ui/kit';
import { api, errorMessage } from '../../shared/api';
import { useData } from '../../shared/data';
import { calendarDate, duration } from '../../shared/format';
import { adjacentAnalyticsWeek, analyticsWeekStart, selectedAnalyticsWeek } from './week';

export function Analytics() {
  const data = useData();
  const firstDay = data.user.settings.weekStart;
  const currentWeek = analyticsWeekStart(data.studyDate, firstDay);
  const [params, setParams] = useSearchParams();
  const weekStart = selectedAnalyticsWeek(params.get('weekStart'), data.studyDate, firstDay);
  const [skillId, setSkillId] = useState('all');
  const report = useQuery({ queryKey: ['analytics', weekStart], queryFn: () => api<AnalyticsReport>(`/analytics/overview?weekStart=${weekStart}`) });
  const changeWeek = (weeks: number) => {
    const next = adjacentAnalyticsWeek(weekStart, weeks, firstDay);
    setParams(previous => { const params = new URLSearchParams(previous); if (next === currentWeek) params.delete('weekStart'); else params.set('weekStart', next); return params; });
  };
  const skills = report.data?.skills.filter(skill => skillId === 'all' || skill.id === skillId) ?? [];
  const goals = report.data?.goals.filter(goal => skillId === 'all' || goal.skillId === skillId) ?? [];
  const calibration = report.data?.calibration.filter(row => skillId === 'all' || row.skillId === skillId) ?? [];
  return <div className="workspace-page analytics-workspace">
    <PageHeader eyebrow="Progress" title="See the work that adds up" description="Review credited time, each goal’s own unit, and how your estimates compare with completed work." />
    <div className="row wrap">{data.user.settings.featurePreset==='full'&&<Link className="button" to="/progress/streaks">Streaks and period history</Link>}<Link className="button" to="/review?kind=weekly">Weekly review</Link></div>
    <div className="row between analytics-toolbar" style={{ flexWrap: 'wrap', gap: '1rem', marginBlock: '1.5rem' }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <IconButton label="Previous report week" onClick={() => changeWeek(-1)}><ChevronLeft size={20} /></IconButton>
        <span style={{ fontWeight: 600 }}>{calendarDate(weekStart)} – {calendarDate(addDays(weekStart, 6))}</span>
        <IconButton label="Next report week" disabled={weekStart >= currentWeek} onClick={() => changeWeek(1)}><ChevronRight size={20} /></IconButton>
        <Button variant="text" disabled={weekStart === currentWeek} onClick={() => setParams(previous => { const params = new URLSearchParams(previous); params.delete('weekStart'); return params; })}>This week</Button>
      </div>
      <Field id="analytics-skill" label="Skill"><select className="input" id="analytics-skill" value={skillId} onChange={event => setSkillId(event.target.value)}><option value="all">All skills</option>{data.skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></Field>
    </div>
    {report.isError && <Banner tone="error" action={<Button onClick={() => void report.refetch()}>Retry</Button>}>{errorMessage(report.error)}</Banner>}
    {report.isPending ? <DelayedSkeleton height={220} /> : !report.data ? null : <>
      <div className="grid-2 analytics-overview">
        <Card><p className="eyebrow">Credited work this week</p><h2>{duration(skills.reduce((sum, skill) => sum + skill.minutes, 0))}</h2><p className="muted">Time you recorded through progress and completion. Running timers are separate.</p></Card>
        <Card><p className="eyebrow">Completed tasks</p><h2>{goals.reduce((sum, goal) => sum + goal.weeklyCompletions, 0)}</h2><p className="muted">Recorded completions, with corrected events removed.</p><Link className="button button-text" to="/review">Open review</Link></Card>
      </div>
      <section className="analytics-section" style={{ marginBlock: '2rem' }}><h2>Practice by skill</h2><p className="muted">Minutes share a scale. Quantities remain in their own unit.</p>
        {skills.length ? <div className="grid-2">{skills.map(skill => <Card key={skill.id}>
          <h3>{skill.name}</h3><p><strong>{duration(skill.minutes)}</strong> credited · {duration(skill.weeklyTargetMin)} weekly practice target</p>
          <progress className="time-progress" max={Math.max(skill.weeklyTargetMin, skill.minutes, 1)} value={skill.minutes} aria-label={`${skill.name}: ${duration(skill.minutes)} of ${duration(skill.weeklyTargetMin)} weekly practice target`} />
          <div className="row" style={{ flexWrap: 'wrap', gap: '.5rem 1rem', marginBlock: '.75rem' }}>{skill.units.map(unit => <span key={unit.unit}>{unit.credited} {unit.unit}</span>)}</div>
          <details><summary className="button button-text">Daily credited time</summary><dl className="credit-list">{skill.days.map(day => <div key={day.date}><dt>{calendarDate(day.date)}</dt><dd>{duration(day.minutes)}</dd></div>)}</dl></details>
        </Card>)}</div> : <EmptyState icon={<BarChart3 />} title="A little practice will appear here">Start a task and record progress to build a useful weekly picture.</EmptyState>}
      </section>
      <section className="analytics-section" style={{ marginBlock: '2rem' }}><h2>Goals in their own units</h2><p className="muted">This week’s credit follows the selected calendar dates. Quotas keep their original period dates, including weeks created before a week-start change.</p>
        <div className="grid-2">{goals.map(goal => <Card key={goal.id}>
          <h3>{goal.title}</h3><p><strong>{goal.weeklyCredited} {goal.unit}</strong> this week</p>
          <p className="muted">All recorded: {goal.credited} {goal.unit}{['milestone', 'adaptive'].includes(goal.type) ? ` · Goal target: ${goal.targetQty} ${goal.unit}` : ''}</p>
          {goal.periodOutcomes.length > 0 && <details>
            <summary className="button button-text">{goal.periodOutcomes[0]?.type === 'daily' ? 'Review daily quotas' : goal.periodOutcomes[0]?.type === 'weekly' ? 'Review weekly quota' : 'Review occurrence quotas'}</summary>
            {goal.periodOutcomes.map(outcome => <div key={`${outcome.periodStart}:${outcome.ruleVersionId ?? ''}:${outcome.occurrenceId ?? ''}`} style={{ borderTop: '1px solid var(--border)', paddingBlock: '.75rem' }}>
              <p>{calendarDate(outcome.periodStart)}{outcome.periodEnd !== outcome.periodStart ? ` – ${calendarDate(outcome.periodEnd)}` : ''}</p>
              <p>{outcome.creditedQty} of {outcome.targetQty} {outcome.unit} credited</p>
              <p className="muted">{outcome.status === 'met' ? 'Quota met' : outcome.status === 'provisional' ? 'Awaiting a confirmed report' : outcome.status === 'in_progress' ? `${outcome.shortfallQty} ${outcome.unit} remaining · period open` : `${outcome.shortfallQty} ${outcome.unit} below quota · period finished`}</p>
            </div>)}
          </details>}
          <Link className="button button-text" to={`/goals/${goal.id}`}>View goal</Link>
        </Card>)}</div>
      </section>
      {data.user.settings.featurePreset==='full'&&<section className="analytics-section" style={{ marginBlock: '2rem' }}><h2>Estimate calibration</h2><p className="muted">The scheduler uses the median actual-to-estimate ratio of the last 10 completed tasks for each skill and task kind. Five samples are needed; the multiplier stays between 0.7× and 2×.</p>
        {calibration.length ? <div className="grid-2">{calibration.map(row => <Card key={`${row.skillId}:${row.kind}`}><h3>{row.skillName} · {row.kind}</h3><p><strong>{row.multiplier}×</strong> {row.ready ? 'calibration multiplier' : 'default multiplier'}</p><p className="muted">{row.sampleCount} of 10 recent samples{row.ready ? '' : ` · ${Math.max(0, 5 - row.sampleCount)} more needed`}{row.observedMedian !== null ? ` · observed median ${row.observedMedian}×` : ''}</p>
          {row.samples.length > 0 && <details><summary className="button button-text">Inspect completed samples</summary>{row.samples.map(sample => <div key={sample.taskId} style={{ borderTop: '1px solid var(--border)', paddingBlock: '.75rem' }}><p>{sample.title}</p><p className="muted">Estimated {duration(sample.estimateMinutes)} · actual {duration(sample.actualMinutes)} · {sample.ratio}×</p></div>)}</details>}
        </Card>)}</div> : <EmptyState title="Estimates learn from completed work">Complete tasks with recorded time to build calibration samples.</EmptyState>}
      </section>}
    </>}
  </div>;
}
