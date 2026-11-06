import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { weekday } from "@kram/time";
import { Clock3, Plus, Target, Pause, Play, Check } from "lucide-react";
import type { Task, TodayResponse, TimeSlot } from "@kram/shared";
import {
  Banner,
  Button,
  Card,
  DelayedSkeleton,
  EmptyState,
  PageHeader,
  Sheet,
  StatusPill,
} from "../../components/ui/kit";
import { TimerDigits } from "../../components/ui/TimerDigits";
import { api, errorMessage } from "../../shared/api";
import { useData, useOnline } from "../../shared/data";
import { useWallClock } from "../../shared/clock";
import {
  calendarDate,
  allocatedMinutes,
  clockLabel,
  duration,
  timerClock,
} from "../../shared/format";
import type { TaskAction } from "../tasks/Tasks";
const TaskEditor = lazy(() => import('../tasks/Tasks').then(module => ({ default: module.TaskEditor })));
const TaskPanel = lazy(() => import('../tasks/Tasks').then(module => ({ default: module.TaskPanel })));
import { blockLanes, layerLabels } from "../timetable/layout";
import { useTaskEvents } from "../tasks/events";

const closed = new Set(["completed", "cancelled", "skipped"]);
export function Today() {
  const data = useData();
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const now = useWallClock(
    data.tasks.some((task) => task.timerStartedAt) ? 1000 : 60000,
  );
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<{
    id: string;
    action?: TaskAction;
  } | null>(null);
  const [filter, setFilter] = useState("all");
  const query = useQuery({
    queryKey: ["today"],
    queryFn: () => api<TodayResponse>("/today"),
    refetchInterval: 10000,
  });
  useEffect(() => {
    if (params.get("add") === "task") {
      setAdding(true);
      const next = new URLSearchParams(params);
      next.delete("add");
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest("input,textarea,select,[contenteditable=true]"))
      )
        return;
      const row = document.activeElement?.closest("[data-task-id]");
      if (["j", "k"].includes(event.key.toLowerCase()) && row) {
        event.preventDefault();
        const rows = [
          ...document.querySelectorAll<HTMLButtonElement>(".task-row-title"),
        ];
        const index = rows.findIndex(
          (button) => button.closest("[data-task-id]") === row,
        );
        rows[
          Math.max(
            0,
            Math.min(
              rows.length - 1,
              index + (event.key.toLowerCase() === "j" ? 1 : -1),
            ),
          )
        ]?.focus();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const today = query.data;
  if (!today)
    return (
      <>
        <PageHeader title="Today" eyebrow="A little room to focus" />
        {query.isPending ? (
      <div className="today-grid">
            <DelayedSkeleton height={240} />
            <DelayedSkeleton height={180} />
            <DelayedSkeleton height={240} />
          </div>
        ) : (
          <Card>
            <h2>Your day could not load</h2>
            <Banner tone="error">{errorMessage(query.error)}</Banner>
            <Button onClick={() => void query.refetch()}>Retry Today</Button>
            <Link className="button button-text" to="/goals">
              Profiles and goals
            </Link>
          </Card>
        )}
      </>
    );
  const local = DateTime.fromMillis(now).setZone(data.user.settings.timezone);
  const minute = local.hour * 60 + local.minute;
  const civilDate = local.toISODate();
  const sameDate = civilDate === today.studyDate;
  const slots = [...today.slots].sort(
    (a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin,
  );
  const currentSlot = slots.filter(slot => slot.date === civilDate && slot.startMin <= minute && slot.endMin > minute).sort((a, b) => Number(!!b.taskId) - Number(!!a.taskId) || Number(a.layer === 'reserved') - Number(b.layer === 'reserved'))[0];
  const nextSlot = slots.find(
    (slot) =>
      slot.date > civilDate! ||
      (slot.date === civilDate && slot.startMin > minute),
  );
  const ribbonSlots = slots.filter((slot) => slot.date === today.studyDate);
  const running = today.tasks.find((task) => task.timerStartedAt);
  const nowTask =
    running ||
    today.tasks.find(
      (task) => task.id === currentSlot?.taskId && !closed.has(task.status),
    );
  const wake = data.user.settings.wakingMin;
  const sleep = data.user.settings.sleepingMin;
  const span = sleep - wake;
  const occupied = allocatedMinutes(ribbonSlots, wake, sleep);
  const free = Math.max(0, span - occupied);
  const rest = data.user.settings.restDays.includes(weekday(today.studyDate));
  const tasks = [...today.tasks]
    .filter(
      (task) =>
        filter === "all" ||
        (filter === "open"
          ? !closed.has(task.status)
          : closed.has(task.status)),
    )
    .sort(
      (a, b) =>
        (slots.find(slot => slot.taskId === a.id)?.date ?? '9999').localeCompare(slots.find(slot => slot.taskId === b.id)?.date ?? '9999') ||
        (slots.find(slot => slot.taskId === a.id)?.startMin ?? 1440) -
          (slots.find(slot => slot.taskId === b.id)?.startMin ?? 1440) ||
        Number(closed.has(a.status)) - Number(closed.has(b.status)) ||
        (a.dueDate || "9999").localeCompare(b.dueDate || "9999") ||
        a.sortOrder - b.sortOrder,
    );
  const deadlines = today.goals
    .filter((goal) => goal.status === "active" && goal.dueDate)
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const weeklyTarget = data.skills.reduce(
    (total, skill) => total + skill.weeklyTargetMin,
    0,
  );
  return (
    <>
      <PageHeader
        title={calendarDate(today.studyDate)}
        eyebrow="Today"
        description={
          rest
            ? "A planned rest day. Keep the day gentle."
            : undefined
        }
        action={
          <Button
            variant="primary"
            disabled={
              !online || !data.goals.some((goal) => goal.status === "active")
            }
            onClick={() => setAdding(true)}
          >
            <Plus size={18} strokeWidth={1.5} />
            Add task
          </Button>
        }
      />
      {query.isError && (
        <Banner>
          Showing the last loaded day.{" "}
          <Button variant="text" onClick={() => void query.refetch()}>
            Retry refresh
          </Button>
        </Banner>
      )}
      {!sameDate && (
        <Banner tone="info">
          Your study day is still {calendarDate(today.studyDate)} until{" "}
          {clockLabel(
            data.user.settings.dayRollover,
            data.user.settings.clockFormat,
          )}
          . Late-night progress stays with this day.
        </Banner>
      )}
      {!!today.proposalCount&&<Banner>{today.proposalCount} plan proposals await your review. <Link className="button button-text" to="/planning">Review changes</Link></Banner>}
      {!!today.unverifiedReviews?.length&&<Banner>Some previous days still need confirmation. <Link className="button button-text" to={`/review?date=${today.unverifiedReviews[0]}`}>Reconcile {calendarDate(today.unverifiedReviews[0]!)}</Link></Banner>}
      {data.user.settings.featurePreset!=='simple'&&today.review?.state!=='closed'&&<Card className="row between wrap"><div><h2>Review your day</h2><p className="muted">Confirm work, check tomorrow and close the day.</p></div><Link className="button" to="/review">Daily review</Link></Card>}
            <Card className="day-ribbon-card">
          <div className="row between">
            <h2 className="sr-only">Your day at a glance</h2>
            <span className="caption">
              {duration(free)} free between waking and sleep
              {rest ? " · Rest day" : ""}
            </span>
          </div>
          <Link
            className={`day-ribbon${rest ? " day-ribbon-rest" : ""}`}
            to="/plan"
            aria-label="Open the day timetable"
          >
            {ribbonSlots.map((slot) => {
              const start = Math.max(wake, slot.startMin);
              const end = Math.min(sleep, slot.endMin);
              if (end <= start) return null;
              const profile = data.profiles.find(
                (profile) => profile.id === slot.profileId,
              );
              return (
                <span
                  className={`ribbon-block ribbon-${slot.layer}`}
                  key={slot.id}
                  style={{
                    left: `${((start - wake) / span) * 100}%`,
                    width: `${((end - start) / span) * 100}%`,
                    borderInlineStartColor: profile
                      ? `var(--profile-${profile.color})`
                      : undefined,
                  }}
                  title={`${slot.title}: ${clockLabel(slot.startMin)}–${clockLabel(slot.endMin)}`}
                >
                  <span className="sr-only">
                    {slot.title}, {clockLabel(slot.startMin)} to{" "}
                    {clockLabel(slot.endMin)}, {slot.layer}.
                  </span>
                </span>
              );
            })}
            {sameDate && minute >= wake && minute <= sleep && (
              <i
                className="ribbon-now"
                style={{ left: `${((minute - wake) / span) * 100}%` }}
                aria-hidden="true"
              />
            )}
          </Link>
          <div className="row between caption">
            <time>{clockLabel(wake, data.user.settings.clockFormat)}</time>
            <time>{clockLabel(sleep, data.user.settings.clockFormat)}</time>
          </div>
        </Card>
      <div className="today-grid">
        <Card className={`today-now${running ? " today-now-running" : ""}`}>
          <p className="eyebrow">{today.review?.state==='closed'?'Day closed':'Now'}</p>
          {today.review?.state==='closed'?<><h2>Your day is recorded</h2><p className="muted">Progress is preserved. You can correct an earlier log from its task history.</p>{today.tomorrowFirst&&<p>Tomorrow: {today.tomorrowFirst.title} · {clockLabel(today.tomorrowFirst.startMin,data.user.settings.clockFormat)}</p>}<Link className="button" to="/review">See closing summary</Link></>:nowTask ? (
            <>
              <button type="button" className="now-task-title" aria-label={`Open focused task ${nowTask.title}`} onClick={() => setSelected({ id: nowTask.id })}><h2>{nowTask.title}</h2></button>
              <StatusPill status={nowTask.status} />
              {running && (
                <p className="now-timer">
                  <TimerDigits value={timerClock(
                    running.timerAccumulatedMinutes +
                      Math.max(
                        0,
                        (now - Date.parse(running.timerStartedAt!)) / 60000,
                      ),
                  )} />
                </p>
              )}
              <p className="muted">
                {duration(nowTask.remainingMinutes)} estimated remaining
              </p>
              <NowActions task={nowTask} onOpen={action => setSelected({ id: nowTask.id, action })} />
            </>
          ) : currentSlot ? (
            <>
              <h2>{currentSlot.title}</h2>
              <p className="muted">
                {clockLabel(
                  currentSlot.startMin,
                  data.user.settings.clockFormat,
                )}
                –
                {clockLabel(currentSlot.endMin, data.user.settings.clockFormat)}{" "}
                · {currentSlot.layer}
              </p>
              <Link className="button button-primary" to="/plan">
                See the day
              </Link>
            </>
          ) : (
            <>
              <h2>{rest ? "Room to rest" : "A little open space"}</h2>
              <p className="muted">
                {nextSlot
                  ? `Free until ${clockLabel(nextSlot.startMin, data.user.settings.clockFormat)}.`
                  : "No block is happening now."}
              </p>
              <Link className="button button-text" to="/plan">
                Choose a time for something
              </Link>
            </>
          )}
        </Card>
        <Card className="today-next">
          <p className="eyebrow">Next</p>
          {nextSlot ? (
            <>
              <h2>{nextSlot.title}</h2>
              <p className="muted">
                {nextSlot.date !== civilDate &&
                  `${calendarDate(nextSlot.date)} · `}
                {clockLabel(nextSlot.startMin, data.user.settings.clockFormat)}{" "}
                · {duration(nextSlot.endMin - nextSlot.startMin)}
              </p>
              {nextSlot.taskId ? (
                <Button
                  variant="text"
                  onClick={() => setSelected({ id: nextSlot.taskId! })}
                >
                  Open next task
                </Button>
              ) : (
                <Link className="button button-text" to="/plan">
                  Open timetable
                </Link>
              )}
            </>
          ) : (
            <>
              <h2>No next block</h2>
              <p className="muted">The next stretch is yours to shape.</p>
              <Link className="button button-text" to="/plan">
                Plan a time block
              </Link>
            </>
          )}
        </Card>
        <Card className="today-tasks">
          <div className="card-header">
            <h2>Your tasks</h2>
            <label className="task-filter">
              <span className="sr-only">Task view</span>
              <select
                className="input"
                aria-label="Task view"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">All tasks</option>
                <option value="open">Open tasks</option>
                <option value="finished">Finished tasks</option>
              </select>
            </label>
          </div>
          {filter !== "all" && (
            <Banner tone="info">
              Showing {filter} tasks. Your task records are unchanged.
            </Banner>
          )}
          {tasks.length ? (
            <ul className="today-task-list">
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  slot={slots.find(slot => slot.taskId === task.id)}
                  onOpen={(action) => setSelected({ id: task.id, action })}
                />
              ))}
            </ul>
          ) : (
            <EmptyState
              title={
                data.goals.length
                  ? "One small task is enough"
                  : "Start with a goal"
              }
              icon={<Target strokeWidth={1} />}
              action={
                data.goals.length ? (
                  <Button disabled={!online} onClick={() => setAdding(true)}>
                    Add a task
                  </Button>
                ) : (
                  <Link className="button button-primary" to="/goals">
                    Create a goal
                  </Link>
                )
              }
            >
              {data.goals.length
                ? "Tasks for this study day belong here. Future tasks stay on their own dates."
                : "Give a skill a measurable goal, then turn it into a manageable step."}
            </EmptyState>
          )}
          <p className="caption task-keyboard-help">
            Open a task for its timer and notes.<span className="desktop-shortcuts"> On desktop: J and K move, D completes, S controls the timer, E defers, X skips.</span>
          </p>
        </Card>
        <div className="today-aside">
          <TodayTimeline slots={ribbonSlots} wake={wake} sleep={sleep} minute={sameDate ? minute : -1} />
          <Card>
            <p className="eyebrow">This week</p>
            <h2>{duration(today.weekly.minutes)} logged</h2>
            {weeklyTarget > 0 && (
              <>
                <progress
                  className="time-progress"
                  value={today.weekly.minutes}
                  max={weeklyTarget}
                  aria-label="Logged minutes toward skill weekly time targets"
                />
                <p className="caption">
                  {duration(weeklyTarget)} combined skill time target
                </p>
              </>
            )}
            {today.weekly.bySkill.map((summary) => (
              <p className="weekly-skill" key={summary.skillId}>
                <span>
                  {data.skills.find((skill) => skill.id === summary.skillId)
                    ?.name || "Archived skill"}
                </span>
                <strong>{duration(summary.minutes)}</strong>
              </p>
            ))}
          </Card>
          <Card>
            <p className="eyebrow">Deadlines</p>
            {deadlines.length ? (
              <ul className="deadline-list">
                {deadlines.slice(0, 4).map((goal) => (
                  <li key={goal.id}>
                    <Link to={`/goals/${goal.id}`}>
                      <strong>{goal.title}</strong>
                      <span className="caption">
                        {goal.progressQty} {goal.unit} logged
                        {["adaptive", "milestone"].includes(goal.type)
                          ? ` of ${goal.targetQty}`
                          : " in total"}{" "}
                        · {calendarDate(goal.dueDate)}
                      </span>
                    </Link>
                    {goal.dueDate! < today.studyDate && (
                      <StatusPill status="overdue" />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <h2>No deadline set</h2>
                <p className="muted">
                  When a goal has a date, it will appear here.
                </p>
              </>
            )}
          </Card>
        </div>
      </div>
      <Sheet
        open={adding}
        onOpenChange={setAdding}
        title="A task for the next step"
        description="Choose the goal, estimate the time and give it an earliest date."
      >
        {adding && (
          <Suspense fallback={<DelayedSkeleton height={240} />}><TaskEditor
            goalId={params.get("goalId") || undefined}
            onDone={() => setAdding(false)}
          /></Suspense>
        )}
      </Sheet>
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title="Task in focus"
        description="Control the timer, record additional progress, or choose a later date."
      >
        {selected && (
          <Suspense fallback={<DelayedSkeleton height={240} />}><TaskPanel
            key={`${selected.id}:${selected.action || "details"}`}
            taskId={selected.id}
            initialAction={selected.action}
          /></Suspense>
        )}
      </Sheet>
    </>
  );
}

function TaskRow({
  task,
  slot,
  onOpen,
}: {
  task: Task;
  slot?: TimeSlot;
  onOpen: (action?: TaskAction) => void;
}) {
  const data = useData();
  const online = useOnline();
  const writer = useTaskEvents(task.id);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const goal = data.goals.find((goal) => goal.id === task.goalId);
  const skill = data.skills.find((skill) => skill.id === goal?.skillId);
  const profile = data.profiles.find(
    (profile) => profile.id === skill?.profileId,
  );
  const finished = closed.has(task.status);
  return (
    <li
      className={`today-task-row${finished ? " task-finished" : ""}`}
      data-task-id={task.id}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key.toLowerCase();
        if (
          ["d", "e", "x"].includes(key) &&
          !finished &&
          (task.status !== "deferred" || key === "d") &&
          online
        ) {
          event.preventDefault();
          onOpen(
            key === "d" ? "completed" : key === "e" ? "deferred" : "skipped",
          );
        }
        if (
          (key === "s" || key === "y") &&
          !finished &&
          task.status !== "deferred" &&
          online &&
          !writer.uncertain &&
          !writer.mutation.isPending
        ) {
          event.preventDefault();
          void writer
            .post(
              task.timerStartedAt
                ? "paused"
                : task.status === "in_progress"
                  ? "resumed"
                  : "started",
            )
            .catch(() => undefined);
        }
        if (key === "u" && finished) {
          event.preventDefault();
          onOpen();
        }
      }}
      onTouchStart={(event) => {
        const point = event.touches[0];
        if (point) touch.current = { x: point.clientX, y: point.clientY };
      }}
      onTouchCancel={() => { touch.current = null; }}
      onTouchEnd={(event) => {
        const point = event.changedTouches[0];
        if (!point || !touch.current || !online || finished) return;
        const delta = point.clientX - touch.current.x;
        const vertical = Math.abs(point.clientY - touch.current.y);
        touch.current = null;
        if (
          vertical < 40 &&
          Math.abs(delta) > 72 &&
          (delta > 0 || task.status !== "deferred")
        ) {
          event.preventDefault();
          onOpen(delta > 0 ? "completed" : "deferred");
        }
      }}
    >
      <button
        type="button"
        className="task-check"
        onClick={() => onOpen(finished ? undefined : "completed")}
        aria-label={finished ? `Open ${task.title}` : `Complete ${task.title}`}
        disabled={writer.mutation.isPending}
      >
        <StatusPill status={task.status} />
      </button>
      <button
        type="button"
        className="task-row-title"
        onClick={() => onOpen()}
        aria-label={`Open task ${task.title}`}
        aria-describedby={`task-state-${task.id}`}
      >
        <span className="task-title-line">
          {profile && (
            <i
              className="profile-dot"
              style={{ background: `var(--profile-${profile.color})` }}
              aria-hidden="true"
            />
          )}
          <strong>{task.title}</strong>
        </span>
        <span id={`task-state-${task.id}`}>
          <StatusPill status={task.status} />
        </span>
        <span className="caption">
          {goal?.title || "Goal"}
          {goal?.unit.toLowerCase() !== "minutes"
            ? ` · ${task.completedQty} of ${task.qty} ${goal?.unit || "units"}`
            : ""}
        </span>
        {task.overdue && <StatusPill status="overdue" />}
      </button>
      <span className="task-row-time">
        <Clock3 size={15} strokeWidth={1.5} aria-hidden="true" />
        {slot ? <><time>{clockLabel(slot.startMin, data.user.settings.clockFormat)}</time><span className="caption">{slot.date !== data.studyDate ? `${calendarDate(slot.date)} · ` : ''}{duration(finished ? task.actualMinutes : task.remainingMinutes)}</span></> : duration(finished ? task.actualMinutes : task.remainingMinutes)}
        <span className="sr-only">
          {finished ? " logged" : " estimated remaining"}
        </span>
      </span>
      {writer.uncertain && (
        <div className="task-row-event-error">
          <Banner tone="error">
            The timer action may already be saved.{" "}
            <Button
              disabled={!online}
              loading={writer.mutation.isPending}
              onClick={() => void writer.retry().catch(() => undefined)}
            >
              Retry same event
            </Button>
          </Banner>
        </div>
      )}
    </li>
  );
}


function NowActions({ task, onOpen }: { task: Task; onOpen: (action?: TaskAction) => void }) {
  const online = useOnline();
  const writer = useTaskEvents(task.id);
  const editable = !writer.uncertain && !writer.mutation.isPending;
  return <>
    <div className="task-primary-actions">
      <Button variant="primary" disabled={!editable || task.status === 'deferred'} loading={writer.mutation.isPending} onClick={() => void writer.post(task.timerStartedAt ? 'paused' : task.status === 'in_progress' ? 'resumed' : 'started').catch(() => undefined)}>
        {task.timerStartedAt ? <Pause size={18} strokeWidth={1.5} /> : <Play size={18} strokeWidth={1.5} />}{task.timerStartedAt ? 'Pause' : task.status === 'in_progress' ? 'Resume' : 'Start'}
      </Button>
      <Button disabled={!editable} onClick={() => onOpen('completed')}><Check size={18} strokeWidth={1.5} />Done</Button>
    </div>
    {writer.uncertain && <Banner tone="error">This timer action may already be saved. <Button disabled={!online} onClick={() => void writer.retry().catch(() => undefined)}>Retry same event</Button></Banner>}
    {!online && <p className="caption">Timer actions and completion save here and sync when connected.</p>}
  </>;
}

function TodayTimeline({ slots, wake, sleep, minute }: { slots: TimeSlot[]; wake: number; sleep: number; minute: number }) {
  const data = useData();
  const span = sleep - wake, scale = 32 / 60, height = span * scale + 28, lanes = blockLanes(slots);
  return <Card className="today-live">
    <h2>Timeline</h2>
    <Link to="/plan" className="today-timeline-link" aria-label="Open today's live timetable">
      <svg viewBox={`0 0 260 ${height}`} className="today-timeline-svg" aria-hidden="true">
        {Array.from({ length: Math.ceil(span / 120) }, (_, i) => wake + i * 120).map(value => <g key={value}><text x="0" y={(value - wake) * scale + 16}>{clockLabel(value, data.user.settings.clockFormat)}</text><line x1="52" x2="258" y1={(value - wake) * scale + 12} y2={(value - wake) * scale + 12} className="live-hour" /></g>)}
        {slots.filter(slot => slot.startMin < sleep && slot.endMin > wake).map(slot => {
          const lane = lanes.get(slot.id)!, x = 54 + lane.lane / lane.count * 204, width = 200 / lane.count;
          const top = (Math.max(wake, slot.startMin) - wake) * scale + 12, size = Math.max(14, (Math.min(sleep, slot.endMin) - Math.max(wake, slot.startMin)) * scale);
          const current = slot.startMin <= minute && slot.endMin > minute;
          return <g key={slot.id} className={`live-block live-${slot.layer}${current ? ' live-current' : ''}`}><rect x={x} y={top} width={width} height={size} rx="5" /><text x={x + 6} y={top + 13}>{slot.title.slice(0, Math.max(5, Math.floor(width / 7)))}{['fixed', 'unavailable'].includes(slot.layer) && size > 28 ? ' · fixed' : ''}</text></g>;
        })}
        {minute >= wake && minute <= sleep && <g className="live-now"><line x1="52" x2="258" y1={(minute - wake) * scale + 12} y2={(minute - wake) * scale + 12} /><circle cx="52" cy={(minute - wake) * scale + 12} r="3" /></g>}
      </svg>
    </Link>
    <details className="disclosure"><summary>Times and block details</summary>{slots.length ? <ul className="calendar-work">{slots.map(slot => <li key={slot.id}><Link to={`/plan?date=${slot.date}`}>{slot.title}</Link><span className="caption">{clockLabel(slot.startMin, data.user.settings.clockFormat)}–{clockLabel(slot.endMin, data.user.settings.clockFormat)} · {layerLabels[slot.layer]}</span></li>)}</ul> : <p className="caption">No blocks planned today.</p>}</details>
  </Card>;
}
