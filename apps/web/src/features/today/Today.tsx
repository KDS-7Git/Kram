import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { weekday } from "@kram/time";
import { Clock3, Plus, Target, Pause, Play, Check, ArrowRight, CalendarDays, GripVertical } from "lucide-react";
import type { Task, TodayResponse, TimeSlot } from "@kram/shared";
import { AnimatePresence, LayoutGroup, m } from "framer-motion";
import {
  Banner,
  Button,
  Card,
  DelayedSkeleton,
  EmptyState,
  PageHeader,
  Sheet,
  StatusPill,
  Shortcut,
  TaskCheckbox,
  Truncate,
  IconButton,
} from "../../components/ui/kit";
import { TimerDigits } from "../../components/ui/TimerDigits";
import { SelectControl } from "../../components/ui/SelectControl";
import { api, errorMessage } from "../../shared/api";
import { useData, useOnline, useRefresh } from "../../shared/data";
import { useUI } from "../../shared/ui";
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
const TaskOrderList = lazy(() => import('./TaskOrderList').then(module => ({ default: module.TaskOrderList })));
import { blockLanes, layerLabels } from "../timetable/layout";
import { useTaskEvents } from "../tasks/events";
import { listSpring, useMotionPreference } from "../../shared/motion";

const closed = new Set(["completed", "cancelled", "skipped"]);
export function Today() {
  const data = useData();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
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
  const [manual, setManual] = useState(false);
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const query = useQuery({
    queryKey: ["today"],
    queryFn: () => api<TodayResponse>("/today"),
    refetchInterval: 10000,
  });
  const mergeOrder = (ids: string[]) => {
    const base = [...(query.data?.tasks || [])].sort((a, b) => a.sortOrder - b.sortOrder).map(task => task.id);
    const all = [...manualOrder.filter(id => base.includes(id)), ...base.filter(id => !manualOrder.includes(id))];
    const visible = new Set(ids);
    let index = 0;
    return all.map(id => visible.has(id) ? ids[index++]! : id);
  };
  const saveOrder = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const [sortOrder, id] of ids.entries()) {
        const task = query.data?.tasks.find(row => row.id === id);
        if (task && task.sortOrder !== sortOrder) await api(`/tasks/${id}`, { method: "PATCH", body: { sortOrder } });
      }
    },
    onSuccess: async () => { await query.refetch(); await refresh(); setManualOrder([]); toast("Task order saved."); },
    onError: async error => { await query.refetch(); await refresh(); setManualOrder([]); toast(errorMessage(error), undefined, "error"); },
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
  const simple = data.user.settings.featurePreset === "simple";
  const taskDestination = data.goals.length ? "#today-tasks" : "/goals";
  const chooseTask = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!data.goals.length || !event.currentTarget.getAttribute("href")?.endsWith("#today-tasks")) return;
    event.preventDefault();
    const list = document.getElementById("today-tasks");
    list?.scrollIntoView({ block: "start", behavior: "instant" });
    list?.focus({ preventScroll: true });
  };
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
        manual ? (manualOrder.indexOf(a.id) >= 0 ? manualOrder.indexOf(a.id) : manualOrder.length + a.sortOrder) - (manualOrder.indexOf(b.id) >= 0 ? manualOrder.indexOf(b.id) : manualOrder.length + b.sortOrder) :
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
    <div className={`today-page${simple ? " today-page-simple" : ""}`}>
      <PageHeader
        title="Today"
        eyebrow={calendarDate(today.studyDate)}
        description={
          rest
            ? "A planned rest day. Keep the day gentle."
            : undefined
        }
        action={
          <Button
            variant="primary"
            shortcut={["N"]}
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
      {!simple && !!today.proposalCount&&<Banner>{today.proposalCount} plan {today.proposalCount === 1 ? 'proposal awaits' : 'proposals await'} your review. <Link className="button button-text" to="/planning">Review changes</Link></Banner>}
      {!simple && !!today.unverifiedReviews?.length&&<Banner>Some previous days still need confirmation. <Link className="button button-text" to={`/review?date=${today.unverifiedReviews[0]}`}>Reconcile {calendarDate(today.unverifiedReviews[0]!)}</Link></Banner>}

      <div className="today-grid">
        <div className="today-execution">
        <Card className={`today-now${running ? " today-now-running" : ""}`}>
          <div className="focus-heading"><p className="eyebrow"><span className={`focus-indicator${running ? " focus-indicator-running" : ""}`} aria-hidden="true" />{today.review?.state==='closed'?'Day closed':running ? 'In focus' : 'Now'}</p><span className="focus-clock"><Clock3 size={14} aria-hidden="true" />{clockLabel(minute, data.user.settings.clockFormat)}</span></div>
          {today.review?.state==='closed'?<><h2>Your day is recorded</h2><p className="muted">Progress is preserved. You can correct an earlier log from its task history.</p>{today.tomorrowFirst&&<p>Tomorrow: {today.tomorrowFirst.title} · {clockLabel(today.tomorrowFirst.startMin,data.user.settings.clockFormat)}</p>}{!simple && <Link className="button" to="/review">See closing summary</Link>}</>:nowTask ? (
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
              <Link className="button button-primary" to={simple ? taskDestination : "/plan"} onClick={chooseTask}>
                {simple ? "Choose a task" : "See the day"}
              </Link>
            </>
          ) : (
            <>
              <h2>{rest ? "Room to rest" : "Choose your next step"}</h2>
              {nextSlot && <p className="muted">Free until {clockLabel(nextSlot.startMin, data.user.settings.clockFormat)}.</p>}
              <div className="focus-empty-actions"><Link className="button button-primary" to={taskDestination} onClick={chooseTask}>
                {data.goals.length ? "Choose a task" : "Create a goal"}<ArrowRight size={16} aria-hidden="true" />
              </Link>{!simple && <Link className="button" to="/plan"><CalendarDays size={16} aria-hidden="true" />Plan time</Link>}</div>
            </>
          )}
        <div className="today-next">
          <p className="eyebrow">Up next</p>
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
                <Link className="button button-text" to={simple ? taskDestination : "/plan"} onClick={chooseTask}>
                  {simple ? "Choose a task" : "Open timetable"}
                </Link>
              )}
            </>
          ) : (
            <>
              <p className="next-empty">No upcoming block.</p>
            </>
          )}
        </div>
        </Card>
        <section className="today-tasks" id="today-tasks" tabIndex={-1} aria-labelledby="today-task-heading">
          <div className="card-header">
            <div className="task-list-heading"><h2 id="today-task-heading">Your tasks</h2><span className="task-count" aria-label={`${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`}>{tasks.length}</span></div>
            <div className="row task-list-controls"><div className="task-filter">
              <SelectControl label="Task view" select={<select
                className="input"
                aria-label="Task view"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">All tasks</option>
                <option value="open">Open tasks</option>
                <option value="finished">Finished tasks</option>
              </select>} />
            </div><IconButton label="Arrange tasks" aria-pressed={manual} disabled={!online || saveOrder.isPending || !today.tasks.length}
              onClick={() => { setManual(value => !value); setManualOrder([]); }}><GripVertical size={17} strokeWidth={1.6} /></IconButton></div>
          </div>
          {manual && <p className="caption task-order-help" id="task-order-help">Your order · drag a handle, or use <Shortcut keys={["↑", "↓"]} /> on a focused handle. Scheduled times stay visible.</p>}
          {filter !== "all" && (
            <Banner tone="info">
              Showing {filter} tasks. Your task records are unchanged.
            </Banner>
          )}
          {manual ? <Suspense fallback={<DelayedSkeleton height={160} />}><TaskOrderList tasks={tasks} disabled={!online || saveOrder.isPending}
            onReorder={ids => setManualOrder(mergeOrder(ids))} onCommit={ids => saveOrder.mutate(mergeOrder(ids))}
            renderRow={id => <TaskRow task={tasks.find(task => task.id === id)!} slot={slots.find(slot => slot.taskId === id)}
              onOpen={action => setSelected({ id, action })} asListItem={false} />} /></Suspense> : <LayoutGroup id="today-tasks">
            <ul className="today-task-list">
              <AnimatePresence initial={false}>{tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  slot={slots.find(slot => slot.taskId === task.id)}
                  onOpen={(action) => setSelected({ id: task.id, action })}
                />
              ))}</AnimatePresence>
            </ul>
          </LayoutGroup>}
          {!tasks.length && (
            <EmptyState
              title={
                filter === "open" ? "All clear for now" : filter === "finished" ? "Progress starts with one task" : data.goals.length
                  ? "One small task is enough"
                  : "Start with a goal"
              }
              icon={<Target strokeWidth={1} />}
              action={
                filter !== "all" ? <Button variant="text" onClick={() => setFilter("all")}>Show all tasks</Button> : data.goals.length ? (
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
              {filter === "open" ? "There’s no open work in this view. Take a breath, or choose your next step." : filter === "finished" ? "Completed and skipped tasks will appear here. Your next step is waiting in the full list." : data.goals.length
                ? "Tasks for this study day belong here. Future tasks stay on their own dates."
                : "Give a skill a measurable goal, then turn it into a manageable step."}
            </EmptyState>
          )}
          <p className="caption task-keyboard-help">
            Open a task for its timer and notes.<span className="desktop-shortcuts"> <Shortcut keys={["J", "K"]} /> move · <Shortcut keys={["D"]} /> complete · <Shortcut keys={["S"]} /> timer · <Shortcut keys={["E"]} /> defer · <Shortcut keys={["X"]} /> skip</span>
          </p>
        </section>
      {data.user.settings.featurePreset!=='simple'&&today.review?.state!=='closed'&&<section className="today-review row between wrap"><div><h2>Review your day</h2><p className="muted">Confirm work, check tomorrow and close the day.</p></div><Link className="button" to="/review">Daily review</Link></section>}
        </div>
        <div className="today-aside">
            {!simple && <section className="day-ribbon-card">
          <Link className="day-overview-link" to="/plan" aria-label="Open the day timetable">
          <div className="row between">
            <h2 className="sr-only">Your day at a glance</h2>
            <span className="day-capacity"><strong>{duration(free)}</strong> free today{rest ? " · Rest day" : ""}</span>
            <span className="caption">{ribbonSlots.length} {ribbonSlots.length === 1 ? "block" : "blocks"} · {duration(occupied)} allocated</span>
          </div>
          <div
            className={`day-ribbon${rest ? " day-ribbon-rest" : ""}`}
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
          </div>
          <div className="row between caption">
            <time>{clockLabel(wake, data.user.settings.clockFormat)}</time>
            <time>{clockLabel(sleep, data.user.settings.clockFormat)}</time>
          </div>
          </Link>
        </section>}
          {!simple && <TodayTimeline slots={ribbonSlots} wake={wake} sleep={sleep} minute={sameDate ? minute : -1} />}
          <section className="today-summary">
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
          </section>
          <section className="today-summary">
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
          </section>
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
    </div>
  );
}

function TaskRow({
  task,
  slot,
  onOpen,
  asListItem = true,
}: {
  task: Task;
  slot?: TimeSlot;
  onOpen: (action?: TaskAction) => void;
  asListItem?: boolean;
}) {
  const data = useData();
  const online = useOnline();
  const writer = useTaskEvents(task.id);
  const reduced = useMotionPreference();
  const touch = useRef<{ x: number; y: number } | null>(null);
  const goal = data.goals.find((goal) => goal.id === task.goalId);
  const skill = data.skills.find((skill) => skill.id === goal?.skillId);
  const profile = data.profiles.find(
    (profile) => profile.id === skill?.profileId,
  );
  const finished = closed.has(task.status);
  const scopeLabel = goal?.title?.trim().toLocaleLowerCase() === task.title.trim().toLocaleLowerCase() ? "" : goal?.title || "Goal";
  const quantityLabel = goal && goal.unit.toLowerCase() !== "minutes" ? `${task.completedQty} of ${task.qty} ${goal.unit}` : "";
  const Row = asListItem ? m.li : m.div;
  return (
    <Row
      layout={reduced || !asListItem ? false : "position"}
      initial={reduced ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? undefined : { opacity: 0, height: 0, paddingBlock: 0 }}
      transition={reduced ? { duration: 0 } : { ...listSpring, opacity: { duration: .16 }, height: { duration: .18 } }}
      className={`today-task-row${finished ? " task-finished" : ""}`}
      data-task-id={task.id}
      data-status={task.status}
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
      <TaskCheckbox
        status={task.status}
        label={finished ? `Open ${task.title}` : `Complete ${task.title}`}
        shortcut={finished ? undefined : ["D"]}
        onClick={() => onOpen(finished ? undefined : "completed")}
        disabled={writer.mutation.isPending}
      />
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
          <strong className="task-title-text"><Truncate>{task.title}</Truncate></strong>
        </span>
        <span id={`task-state-${task.id}`} className="task-row-metadata">
          <StatusPill status={task.status} />
          {scopeLabel && <span className="task-scope"><Truncate>{scopeLabel}</Truncate></span>}
          {quantityLabel && <span className="task-quantity caption">{quantityLabel}</span>}
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
    </Row>
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
  if (!slots.some(slot => slot.startMin < sleep && slot.endMin > wake)) return <section className="today-live today-live-empty"><h2>Timeline</h2><p className="muted">No blocks planned today.</p><Link className="button button-text" to="/plan">Open timetable</Link></section>;
  const visibleSlots = slots.filter(slot => slot.startMin < sleep && slot.endMin > wake);
  if (visibleSlots.length <= 3) return <section className="today-live today-live-compact"><div className="card-header"><h2>Today’s schedule</h2><Link to="/plan" className="schedule-open" aria-label="Open today's live timetable"><ArrowRight size={18} aria-hidden="true" /></Link></div><ul className="today-agenda">{visibleSlots.map(slot => <li key={slot.id} className={slot.startMin <= minute && slot.endMin > minute ? 'agenda-current' : undefined}><span className="agenda-times"><time>{clockLabel(slot.startMin, data.user.settings.clockFormat)}</time><span>{clockLabel(slot.endMin, data.user.settings.clockFormat)}</span></span><Link to={`/plan?date=${slot.date}`}><strong>{slot.title}</strong><span className="caption">{layerLabels[slot.layer]} · {duration(slot.endMin - slot.startMin)}</span></Link></li>)}</ul></section>;
  const span = sleep - wake, scale = 32 / 60, height = span * scale + 28, lanes = blockLanes(slots);
  return <section className="today-live">
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
  </section>;
}
