import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { weekday } from "@kram/time";
import { Clock3, Plus, Target } from "lucide-react";
import type { Task, TodayResponse } from "@kram/shared";
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
import { TaskEditor, TaskPanel, type TaskAction } from "../tasks/Tasks";
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
  const currentSlot = slots.find(
    (slot) =>
      slot.date === civilDate &&
      slot.startMin <= minute &&
      slot.endMin > minute,
  );
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
            : "What is happening now, what comes next, and a little progress at your pace."
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
      <div className="today-grid">
        <Card className={`today-now${running ? " today-now-running" : ""}`}>
          <p className="eyebrow">Now</p>
          {nowTask ? (
            <>
              <h2>{nowTask.title}</h2>
              <StatusPill status={nowTask.status} />
              {running && (
                <p className="now-timer">
                  {timerClock(
                    running.timerAccumulatedMinutes +
                      Math.max(
                        0,
                        (now - Date.parse(running.timerStartedAt!)) / 60000,
                      ),
                  )}
                </p>
              )}
              <p className="muted">
                {duration(nowTask.remainingMinutes)} estimated remaining
              </p>
              <Button
                variant="primary"
                onClick={() => setSelected({ id: nowTask.id })}
              >
                Open task
              </Button>
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
        <Card>
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
        <Card className="day-ribbon-card">
          <div className="row between">
            <h2>Your day at a glance</h2>
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
            Open a task for its timer and notes. On desktop: J and K move, D
            completes, S controls the timer, E defers, X skips.
          </p>
        </Card>
        <div className="stack-lg today-aside">
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
          <TaskEditor
            goalId={params.get("goalId") || undefined}
            onDone={() => setAdding(false)}
          />
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
          <TaskPanel
            key={`${selected.id}:${selected.action || "details"}`}
            taskId={selected.id}
            initialAction={selected.action}
          />
        )}
      </Sheet>
    </>
  );
}

function TaskRow({
  task,
  onOpen,
}: {
  task: Task;
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
        )
          onOpen(delta > 0 ? "completed" : "deferred");
      }}
    >
      <button
        type="button"
        className="task-check"
        onClick={() => onOpen(finished ? undefined : "completed")}
        aria-label={finished ? `Open ${task.title}` : `Complete ${task.title}`}
        disabled={!online && !finished}
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
        {duration(finished ? task.actualMinutes : task.remainingMinutes)}
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
