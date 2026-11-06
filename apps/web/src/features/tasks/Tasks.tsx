import { clientId } from "../../shared/id";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { addDays } from "@kram/time";
import {
  CalendarClock,
  Check,
  ExternalLink,
  FastForward,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Target,
  X,
} from "lucide-react";
import {
  progressInputSchema,
  resolveTaskEvents,
  taskSchema,
  type ProgressEvent,
  type ProgressInput,
  type Task,
} from "@kram/shared";
import type { z } from "zod";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  DelayedSkeleton,
  DurationStepper,
  Field,
  PageHeader,
  Sheet,
  StatusPill,
} from "../../components/ui/kit";
import { TimerDigits } from "../../components/ui/TimerDigits";
import { api, apiList, errorMessage } from "../../shared/api";
import { useData, useOnline, useRefresh } from "../../shared/data";
import { useWallClock } from "../../shared/clock";
import { calendarDate, duration, timerClock } from "../../shared/format";
import { useUI } from "../../shared/ui";
import { useTaskEvents } from "./events";
import { TaskReminders } from "./reminders";

const closedStatuses = new Set(["completed", "skipped", "cancelled"]);
function inactiveHistoryEvents(events: ProgressEvent[]) {
  const groups = new Map<string, ProgressEvent[]>();
  for (const event of events) {
    if (!event.taskId) continue;
    const key = `${event.goalId}:${event.taskId}`;
    const group = groups.get(key) || [];
    group.push(event);
    groups.set(key, group);
  }
  return new Set(
    [...groups.values()].flatMap(
      (group) =>
        resolveTaskEvents(group.sort((a, b) => a.sequence - b.sequence))
          .inactiveEventIds,
    ),
  );
}
export type TaskAction = "progress" | "completed" | "deferred" | "skipped";

export function TaskEditor({
  task,
  goalId,
  onDone,
}: {
  task?: Task;
  goalId?: string;
  onDone: () => void;
}) {
  const data = useData();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const initialGoal =
    data.goals.find((goal) => goal.id === (goalId || task?.goalId)) ||
    data.goals.find((goal) => goal.status === "active");
  const form = useForm<
    z.input<typeof taskSchema>,
    unknown,
    z.output<typeof taskSchema>
  >({
    resolver: zodResolver(taskSchema),
    defaultValues: task || {
      goalId: initialGoal?.id || "",
      title: "",
      estMinutes: initialGoal?.estMinutes || 30,
      qty:
        initialGoal?.unit.toLowerCase() === "minutes"
          ? initialGoal.estMinutes
          : 1,
      earliestDate: data.studyDate,
      dueDate: null,
      supportsSplit: true,
      itemId: null,
      sortOrder: data.tasks.length,
    },
  });
  const values = form.watch();
  const errors = form.formState.errors;
  const goal = data.goals.find((goal) => goal.id === values.goalId);
  const linkedResourceIds = new Set(
    data.resources
      .filter((resource) => resource.goalIds.includes(values.goalId))
      .map((resource) => resource.id),
  );
  const save = useMutation({
    mutationFn: (input: z.output<typeof taskSchema>) =>
      api(task ? `/tasks/${task.id}` : "/tasks", {
        method: task ? "PATCH" : "POST",
        body: input,
      }),
    onSuccess: async () => {
      await refresh();
      toast(task ? "Task updated." : "Task added.");
      onDone();
    },
  });
  return (
    <form
      className="stack-lg"
      noValidate
      onSubmit={form.handleSubmit((input) => save.mutate(input))}
    >
      <Field id="task-title" label="Task title" error={errors.title?.message}>
        <input
          className="input"
          id="task-title"
          autoFocus
          {...form.register("title")}
        />
      </Field>
      <Field id="task-goal" label="Goal" hint={task ? "This task keeps its goal and recorded history." : "A task added here is a one-time item under this goal."} error={errors.goalId?.message}>
        <select
          className="input"
          id="task-goal"
          {...form.register("goalId", {
            onChange: (event) => {
              const selected = data.goals.find(
                (goal) => goal.id === event.target.value,
              );
              form.setValue("itemId", null);
              if (selected) {
                form.setValue("estMinutes", selected.estMinutes);
                form.setValue(
                  "qty",
                  selected.unit.toLowerCase() === "minutes"
                    ? selected.estMinutes
                    : 1,
                );
              }
            },
          })}
          disabled={!!task}
        >
          <option value="">Choose a goal</option>
          {data.goals
            .filter(
              (goal) => goal.status === "active" || goal.id === task?.goalId,
            )
            .map((goal) => (
              <option value={goal.id} key={goal.id}>
                {goal.title}
              </option>
            ))}
        </select>
      </Field>
      <Field
        id="task-resource-item"
        label="Resource item (optional)"
        hint="Choose a step from material linked to this goal."
        error={errors.itemId?.message}
      >
        <select
          className="input"
          id="task-resource-item"
          {...form.register("itemId", {
            setValueAs: (value) => value || null,
            onChange: (event) => {
              const item = data.resourceItems.find(
                (item) => item.id === event.target.value,
              );
              if (item) {
                form.setValue("title", item.title);
                form.setValue("estMinutes", Math.max(1, item.estMinutes));
                form.setValue(
                  "qty",
                  goal?.unit.toLowerCase() === "minutes"
                    ? Math.max(1, item.estMinutes)
                    : item.qty,
                );
              }
            },
          })}
        >
          <option value="">No linked item</option>
          {data.resourceItems
            .filter(
              (item) =>
                linkedResourceIds.has(item.resourceId) &&
                !item.archivedAt &&
                item.estMinutes > 0,
            )
            .map((item) => (
              <option value={item.id} key={item.id}>
                {item.title}
              </option>
            ))}
        </select>
      </Field>
      <div className="grid-2 form-grid">
        <Field
          id="task-estimate"
          label="Estimated time (min)"
          hint="A rough starting estimate for this task. Use it to reserve time, then adjust it after doing the work."
          error={errors.estMinutes?.message}
        >
          <input
            className="input"
            id="task-estimate"
            type="number"
            min="1"
            max="960"
            {...form.register("estMinutes", { valueAsNumber: true })}
          />
        </Field>
        {goal?.unit.toLowerCase() !== "minutes" && (
          <Field
            id="task-quantity"
            label={`Quantity (${goal?.unit || "units"})`}
            error={errors.qty?.message}
          >
            <input
              className="input"
              id="task-quantity"
              type="number"
              min="0.01"
              step="any"
              {...form.register("qty", { valueAsNumber: true })}
            />
          </Field>
        )}
        <Field
          id="task-earliest"
          label="Earliest date"
          error={errors.earliestDate?.message}
        >
          <input
            className="input"
            id="task-earliest"
            type="date"
            {...form.register("earliestDate")}
          />
        </Field>
        <Field
          id="task-due"
          label="Task deadline (optional)"
          error={errors.dueDate?.message}
        >
          <input
            className="input"
            id="task-due"
            type="date"
            min={values.earliestDate}
            {...form.register("dueDate", {
              setValueAs: (value) => value || null,
            })}
          />
        </Field>
      </div>
      <label className="toggle-label">
        <input type="checkbox" {...form.register("supportsSplit")} />
        This task can be split across sessions
      </label>
      {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}
      {!online && (
        <Banner>
          Reconnect to save task changes. Your draft stays in this form.
        </Banner>
      )}
      <Button
        variant="primary"
        type="submit"
        loading={save.isPending}
        disabled={!online}
      >
        {task ? "Save task" : "Add task"}
      </Button>
    </form>
  );
}

export function TaskPage() {
  const { taskId } = useParams();
  return (
    <>
      <Link className="button button-text back-link" to="/">
        Back to Today
      </Link>
      {taskId && <TaskPanel taskId={taskId} />}
    </>
  );
}

export function TaskPanel({
  taskId,
  initialAction,
}: {
  taskId: string;
  initialAction?: TaskAction;
}) {
  const data = useData();
  const online = useOnline();
  const now = useWallClock();
  const navigate = useNavigate();
  const [composer, setComposer] = useState<TaskAction | null>(
    initialAction || null,
  );
  const [editing, setEditing] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [olderCorrection, setOlderCorrection] = useState<ProgressEvent | null>(
    null,
  );
  const [tab, setTab] = useState("details");
  const taskQuery = useQuery({
    queryKey: ["tasks", taskId],
    queryFn: () => api<Task>(`/tasks/${taskId}`),
    initialData: () => data.tasks.find((task) => task.id === taskId),
    refetchInterval: 10000,
  });
  const planning = useQuery({queryKey:['planning','task',taskId],queryFn:()=>api<{items:{date:string;explanation:string}[]}>(`/tasks/${taskId}/planning`)});
  const history = useQuery({
    queryKey: ["tasks", taskId, "events"],
    queryFn: ({ signal }) =>
      apiList<ProgressEvent>(`/tasks/${taskId}/events`, signal),
  });
  const writer = useTaskEvents(taskId);
  const resolvedHistory = useMemo(
    () => resolveTaskEvents(history.data || []),
    [history.data],
  );
  useEffect(() => {
    if (writer.mutation.isSuccess) {
      setComposer(null);
      setCancelOpen(false);
      setOlderCorrection(null);
    }
  }, [writer.mutation.data, writer.mutation.isSuccess]);
  const task = taskQuery.data;
  const busy = writer.mutation.isPending || writer.uncertain;
  const editable = !busy;
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        !task ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest("input,textarea,select,[contenteditable=true]"))
      )
        return;
      if (event.key.toLowerCase() === "u" && task.status === "completed") {
        event.preventDefault();
        document
          .querySelector<HTMLButtonElement>("[data-undo-completion]")
          ?.click();
      }
      if (closedStatuses.has(task.status)) return;
      if (
        task.status === "deferred" &&
        !["p", "d"].includes(event.key.toLowerCase())
      )
        return;
      if (event.key.toLowerCase() === "d") {
        event.preventDefault();
        setComposer("completed");
      }
      if (["y", "s"].includes(event.key.toLowerCase()) && editable) {
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
      if (event.key.toLowerCase() === "e") {
        event.preventDefault();
        setComposer("deferred");
      }
      if (event.key.toLowerCase() === "x") {
        event.preventDefault();
        setComposer("skipped");
      }
      if (event.key.toLowerCase() === "p" && data.user.settings.featurePreset !== "simple") {
        event.preventDefault();
        navigate(`/plan?taskId=${task.id}&pin=true`);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [task, editable, navigate, writer]);
  if (!task)
    return taskQuery.isPending ? (
      <DelayedSkeleton height={280} />
    ) : (
      <Card>
        <PageHeader
          title="Could not load this task"
          description={errorMessage(taskQuery.error)}
        />
        <Button onClick={() => void taskQuery.refetch()}>Retry</Button>
      </Card>
    );
  const goal = data.goals.find((goal) => goal.id === task.goalId);
  const unit = goal?.unit || "units";
  const skill = data.skills.find(row => row.id === goal?.skillId);
  const profile = data.profiles.find(row => row.id === skill?.profileId);
  const progress = unit.toLowerCase() === "minutes" ? task.actualMinutes / task.estMinutes : task.completedQty / task.qty;
  const open = !closedStatuses.has(task.status);
  const deferred = task.status === "deferred";
  const completionId = resolvedHistory.activeEvents
    .filter((event) => event.kind === "completed")
    .at(-1)?.id;
  const completion = history.data?.find((event) => event.id === completionId);
  const measured =
    task.timerAccumulatedMinutes +
    (task.timerStartedAt
      ? Math.max(0, (now - Date.parse(task.timerStartedAt)) / 60000)
      : 0);
  const item = data.resourceItems.find((item) => item.id === task.itemId);
  const resource = data.resources.find(
    (resource) => resource.id === item?.resourceId,
  );
  const source = item?.url || resource?.url;
  return (
    <div className="stack-lg task-panel">
      <header className="task-panel-heading">
        <p className="eyebrow">{[profile?.name, skill?.name, goal?.title || "Task"].filter(Boolean).join(" › ")}</p>
        <h2>{task.title}</h2>
        <div className="row">
          <StatusPill status={task.status} />
          {task.overdue && <StatusPill status="overdue" />}
          <span className="caption">
            {task.dueDate
              ? `Due ${calendarDate(task.dueDate)}`
              : "No task deadline"}
          </span>
        </div>
      </header>
      <div
        className={`task-timer${task.timerStartedAt ? " task-timer-running" : ""}`}
      >
        <p className="eyebrow">Measured timer</p>
        <p
          className="timer-number"
          aria-label={`Measured timer ${timerClock(measured)}`}
        >
          <TimerDigits value={timerClock(measured)} />
        </p>
        <p className="caption">
          {task.timerStartedAt ? "Timer running" : "Timer stopped"} ·{" "}
          {duration(task.actualMinutes)} logged
        </p>
        <progress className="time-progress" value={Math.min(1, progress)} max={1} aria-label="Recorded task progress" />
        <p className="caption">Estimated {duration(task.estMinutes)} · timer time is logged separately.</p>
      </div>
      <div className="task-remaining">
        <strong>{duration(task.remainingMinutes)} estimated remaining</strong>
        {unit.toLowerCase() !== "minutes" && (
          <span className="caption">
            {task.completedQty} of {task.qty} {unit}
          </span>
        )}
      </div>
      {open && (
        <div className="task-primary-actions">
          <Button
            variant="primary"
            disabled={!editable || deferred}
            loading={
              writer.mutation.isPending &&
              ["started", "paused", "resumed"].includes(
                writer.mutation.variables?.kind || "",
              )
            }
            onClick={() =>
              void writer
                .post(
                  task.timerStartedAt
                    ? "paused"
                    : task.status === "in_progress"
                      ? "resumed"
                      : "started",
                )
                .catch(() => undefined)
            }
          >
            {task.timerStartedAt ? (
              <Pause size={20} strokeWidth={1.5} />
            ) : (
              <Play size={20} strokeWidth={1.5} />
            )}{" "}
            {task.timerStartedAt
              ? "Pause timer"
              : task.status === "in_progress"
                ? "Resume timer"
                : "Start timer"}
          </Button>
          <Button
            variant="secondary"
            disabled={!editable}
            onClick={() => setComposer("completed")}
          >
            <Check size={20} strokeWidth={1.5} />
            Done
          </Button>
        </div>
      )}
      {task.status === "completed" && completion && (
        <Button
          data-undo-completion="true"
          disabled={!editable}
          onClick={() => {
            if (now - Date.parse(completion.createdAt) > 600000)
              setOlderCorrection(completion);
            else
              void writer
                .post("correction", {
                  referenceEventId: completion.id,
                  note: "Undo completion",
                })
                .catch(() => undefined);
          }}
        >
          <RotateCcw size={18} strokeWidth={1.5} />
          {now - Date.parse(completion.createdAt) > 600000
            ? "Correct completion"
            : "Undo completion"}
        </Button>
      )}
      {open && <div className="task-quick-progress">
        <h3>Log progress</h3>
        <p className="caption" id="partial-help">One tap logs work up to that share of the estimate. Already recorded work is kept. Undo is available.</p>
        <div className="progress-chips" role="group" aria-label="Quick partial progress">
          {[25, 50, 75].map(percent => <Button key={percent} aria-describedby="partial-help" disabled={!editable || deferred || progress >= percent / 100} onClick={() => void writer.post('progress', { minutes: Math.max(0, (task.estMinutes * percent / 100) - task.actualMinutes), qty: unit.toLowerCase() === 'minutes' ? Math.max(0, (task.estMinutes * percent / 100) - task.actualMinutes) : Math.max(0, task.qty * percent / 100 - task.completedQty) }).catch(() => undefined)}>{percent}%</Button>)}
          <Button disabled={!editable || deferred} onClick={() => setComposer('progress')}>Other</Button>
        </div>
      </div>}
      {open && (
        <div className="row task-quiet-actions">
          <Button
            variant="text"
            disabled={!editable || deferred}
            onClick={() => setComposer("progress")}
          >
            <Plus size={18} strokeWidth={1.5} />
            Log progress
          </Button>
          <Button
            variant="text"
            disabled={!editable || deferred}
            onClick={() => setComposer("deferred")}
          >
            <CalendarClock size={18} strokeWidth={1.5} />
            Defer
          </Button>
          <Button
            variant="text"
            disabled={!editable || deferred}
            onClick={() => setComposer("skipped")}
          >
            <FastForward size={18} strokeWidth={1.5} />
            Skip
          </Button>
          {source && (
            <a
              className="button button-text"
              href={source}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={18} strokeWidth={1.5} />
              Open resource
            </a>
          )}
          {data.user.settings.featurePreset !== "simple" && <Link className="button button-text" to={`/plan?taskId=${task.id}`}>
            Schedule time
          </Link>}
        </div>
      )}
      {!!planning.data?.items.length&&<details><summary>Why here?</summary><div className="stack">{planning.data.items.map((item,i)=><p key={i}>{calendarDate(item.date)} · {item.explanation}</p>)}</div></details>}
      {!online && (
        <Banner>
          Timer actions and progress save on this device and sync when you reconnect. Planning edits need a connection.
        </Banner>
      )}
      {deferred && (
        <Banner tone="info">
          This task is deferred until {calendarDate(task.deferredToDate)}. Timer
          and progress actions become available on that study date. You can
          still complete it early.
        </Banner>
      )}
      {writer.mutation.isError && (
        <Banner tone="error">
          {errorMessage(writer.mutation.error)}
          {writer.uncertain && (
            <>
              <p>
                This event may already be saved. Retry it to confirm before
                adding more progress.
              </p>
              <Button
                onClick={() => void writer.retry().catch(() => undefined)}
                disabled={!online}
                loading={writer.mutation.isPending}
              >
                Retry same event
              </Button>
            </>
          )}
        </Banner>
      )}
      {composer && (
        <Card>
          <ProgressEditor
            key={composer}
            action={composer}
            task={task}
            unit={unit}
            disabled={!editable || (deferred && composer !== "completed") || (!online && ["deferred", "cancelled", "correction"].includes(composer))}
            pending={writer.mutation.isPending}
            onCancel={() => setComposer(null)}
            onSave={(values) =>
              void writer
                .post(composer, {
                  minutes: values.minutes,
                  qty:
                    unit.toLowerCase() === "minutes"
                      ? values.minutes
                      : values.qty,
                  note: values.note,
                  ...(values.toDate ? { toDate: values.toDate } : {}),
                })
                .catch(() => undefined)
            }
          />
        </Card>
      )}
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="tab-list" aria-label="Task details">
          <Tabs.Trigger value="details">Details</Tabs.Trigger>
          <Tabs.Trigger value="history">History</Tabs.Trigger>
          <Tabs.Trigger value="reminders">Reminders</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="details" className="stack">
          <p className="muted">
            Earliest {calendarDate(task.earliestDate)} · Estimated{" "}
            {duration(task.estMinutes)}
            {task.deferredToDate
              ? ` · Deferred to ${calendarDate(task.deferredToDate)}`
              : ""}
          </p>
          {goal && (
            <Link className="button button-text" to={`/goals/${goal.id}`}>
              <Target size={18} strokeWidth={1.5} />
              Open goal
            </Link>
          )}
          <div className="row">
            {open && (
              <Button
                variant="text"
                disabled={!editable}
                onClick={() => setEditing(true)}
              >
                <Pencil size={18} strokeWidth={1.5} />
                Edit task
              </Button>
            )}
            {open && (
              <Button
                variant="text"
                disabled={!editable}
                onClick={() => setCancelOpen(true)}
              >
                <X size={18} strokeWidth={1.5} />
                Cancel task
              </Button>
            )}
          </div>
        </Tabs.Content>
        <Tabs.Content value="history">
          <h3>
            <History size={18} strokeWidth={1.5} aria-hidden="true" /> Recorded
            events
          </h3>
          {history.isPending ? (
            <DelayedSkeleton height={160} />
          ) : history.isError ? (
            <Banner tone="error">
              {errorMessage(history.error)}{" "}
              <Button variant="text" onClick={() => void history.refetch()}>
                Retry history
              </Button>
            </Banner>
          ) : history.data?.length ? (
            <TaskEventHistory events={history.data} unit={unit} />
          ) : (
            <p className="muted">
              Timer actions, progress and corrections will appear here.
            </p>
          )}
        </Tabs.Content>
        <Tabs.Content value="reminders">
          <TaskReminders taskId={task.id} />
        </Tabs.Content>
      </Tabs.Root>
      <Sheet
        open={editing}
        onOpenChange={setEditing}
        title="Edit task"
        description="Update the estimate or dates while keeping recorded progress."
      >
        {editing && <TaskEditor task={task} onDone={() => setEditing(false)} />}
      </Sheet>
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Cancel ${task.title}?`}
        description="This marks the task as no longer needed. Its progress remains in history and it will not be planned as open work."
      >
        <div className="row between">
          <Button onClick={() => setCancelOpen(false)}>Keep task</Button>
          <Button
            variant="destructive"
            disabled={!editable}
            loading={writer.mutation.isPending}
            onClick={() =>
              void writer
                .post("cancelled", { note: "No longer needed" })
                .catch(() => undefined)
            }
          >
            Cancel task
          </Button>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!olderCorrection}
        onOpenChange={(open) => {
          if (!open) setOlderCorrection(null);
        }}
        title="Correct this older completion?"
        description="This appends a correction and can reopen the task. The original completion stays in history; totals will be recalculated."
      >
        <div className="row between">
          <Button onClick={() => setOlderCorrection(null)}>
            Keep completion
          </Button>
          <Button
            variant="destructive"
            disabled={!editable}
            loading={writer.mutation.isPending}
            onClick={() => {
              if (olderCorrection)
                void writer
                  .post("correction", {
                    referenceEventId: olderCorrection.id,
                    explicitCorrection: true,
                    note: "Explicit correction of older completion",
                  })
                  .catch(() => undefined);
            }}
          >
            Apply correction
          </Button>
        </div>
      </ConfirmDialog>
    </div>
  );
}

export function TaskEventHistory({
  events,
  unit,
  taskLinks = false,
}: {
  events: ProgressEvent[];
  unit: string;
  taskLinks?: boolean;
}) {
  const data = useData();
  const corrected = useMemo(() => inactiveHistoryEvents(events), [events]);
  return (
    <ol className="task-history">
      {[...events].reverse().map((event) => (
        <li key={event.id}>
          <strong>
            {event.kind.replaceAll("_", " ")}
            {corrected.has(event.id) ? " · corrected" : ""}
          </strong>
          <p className="caption">
            {new Intl.DateTimeFormat(undefined, {
              timeZone: event.timezone || data.user.settings.timezone,
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(event.occurredAt))}{" "}
            · study date {calendarDate(event.localDate)}
          </p>
          {event.kind === "completed" && event.reportedTotalMinutes != null ? (
            <p>
              Completion total: {duration(event.reportedTotalMinutes)}
              {unit.toLowerCase() !== "minutes" &&
              event.reportedTotalQty != null
                ? ` · ${event.reportedTotalQty} ${unit}`
                : ""}
            </p>
          ) : (
            (event.minutes > 0 || event.qty > 0) && (
              <p>
                {duration(event.minutes)}
                {unit.toLowerCase() !== "minutes"
                  ? ` · ${event.qty} ${unit}`
                  : ""}{" "}
                added
              </p>
            )
          )}
          {event.note && <p>{event.note}</p>}
          {event.referenceEventId && (
            <p className="caption">
              Correction of an earlier event; the original stays in history.
            </p>
          )}
          {event.toDate && <p>Deferred to {calendarDate(event.toDate)}</p>}
          {taskLinks && event.taskId && (
            <Link className="button button-text" to={`/tasks/${event.taskId}`}>
              Open{" "}
              {data.tasks.find((task) => task.id === event.taskId)?.title ||
                "task"}
            </Link>
          )}
        </li>
      ))}
    </ol>
  );
}

function ProgressEditor({
  action,
  task,
  unit,
  disabled,
  pending,
  onSave,
  onCancel,
}: {
  action: TaskAction;
  task: Task;
  unit: string;
  disabled: boolean;
  pending: boolean;
  onSave: (values: ProgressInput) => void;
  onCancel: () => void;
}) {
  const data = useData();
  const form = useForm<
    z.input<typeof progressInputSchema>,
    unknown,
    z.output<typeof progressInputSchema>
  >({
    resolver: zodResolver(progressInputSchema),
    defaultValues: {
      clientEventId: clientId(),
      occurredAt: new Date().toISOString(),
      kind: action,
      minutes:
        action === "completed" ? task.actualMinutes + task.remainingMinutes : 0,
      qty: action === "completed" ? Math.max(task.qty, task.completedQty) : 0,
      note: "",
      toDate: action === "deferred" ? addDays(data.studyDate, 1) : undefined,
      explicitCorrection: false,
    },
  });
  const values = form.watch();
  const errors = form.formState.errors;
  const heading =
    action === "completed"
      ? "Confirm completion"
      : action === "progress"
        ? "Add progress"
        : action === "deferred"
          ? "Choose a later date"
          : "Skip this occurrence";
  return (
    <form className="stack" noValidate onSubmit={form.handleSubmit(onSave)}>
      <h3>{heading}</h3>
      {["completed", "progress"].includes(action) && (
        <>
          <p className="field-hint">
            {action === "completed"
              ? `Enter the full actual time for this task, including ${duration(task.actualMinutes)} already logged. Only the difference is added to your record.`
              : `Enter work since your last log. These amounts are added to ${duration(task.actualMinutes)} already recorded.`}
          </p>
          {action === "progress" && (
            <div
              className="row progress-chips"
              aria-label="Partial progress presets"
            >
              {[25, 50, 75].map((percent) => (
                <Button
                  key={percent}
                  onClick={() => {
                    form.setValue(
                      "minutes",
                      Math.max(
                        0,
                        Math.round(
                          (task.estMinutes * percent) / 100 -
                            task.actualMinutes,
                        ),
                      ),
                    );
                    form.setValue(
                      "qty",
                      Math.max(
                        0,
                        (task.qty * percent) / 100 - task.completedQty,
                      ),
                    );
                  }}
                >
                  {percent}% of estimate
                </Button>
              ))}
            </div>
          )}
          <div className="grid-2 form-grid">
            <Field
              id="progress-minutes"
              label={
                action === "completed"
                  ? "Total actual minutes"
                  : "Additional minutes"
              }
              hint={
                action === "completed"
                  ? "Adjust to the work you did. Type minutes or a duration such as 1h20."
                  : "Type minutes or a duration such as 1h20. Use the buttons to adjust by 5 minutes."
              }
              error={errors.minutes?.message}
            >
              <DurationStepper id="progress-minutes" label={action === 'completed' ? 'Total actual minutes' : 'Additional minutes'} value={values.minutes ?? 0} min={action === 'completed' ? task.actualMinutes : 0} disabled={disabled} invalid={!!errors.minutes} describedBy={`progress-minutes-hint${errors.minutes ? ' progress-minutes-error' : ''}`} onChange={value => form.setValue('minutes', value, { shouldValidate: true })} />
            </Field>
            {unit.toLowerCase() !== "minutes" && (
              <Field
                id="progress-quantity"
                label={`${action === "completed" ? "Total" : "Additional"} ${unit}`}
                error={errors.qty?.message}
              >
                <input
                  className="input"
                  id="progress-quantity"
                  type="number"
                  min={action === "completed" ? task.completedQty : 0}
                  step="any"
                  {...form.register("qty", { valueAsNumber: true })}
                />
              </Field>
            )}
          </div>
          <p className="caption">
            After saving:{" "}
            {duration(
              action === "completed"
                ? values.minutes || 0
                : task.actualMinutes + (values.minutes || 0),
            )}{" "}
            logged ·{" "}
            {duration(
              action === "completed"
                ? 0
                : unit.toLowerCase() === "minutes"
                  ? Math.max(
                      0,
                      task.estMinutes -
                        task.actualMinutes -
                        (values.minutes || 0),
                    )
                  : Math.ceil(
                      (task.estMinutes *
                        Math.max(
                          0,
                          task.qty - task.completedQty - (values.qty || 0),
                        )) /
                        task.qty,
                    ),
            )}{" "}
            estimated remaining.
          </p>
          {action === "completed" && (
            <p className="field-hint">
              Completing closes the task even when actual time differs from its
              estimate.
            </p>
          )}
        </>
      )}
      {action === "deferred" && (
        <Field
          id="progress-defer"
          label="Defer until"
          error={errors.toDate?.message}
        >
          <input
            className="input"
            id="progress-defer"
            type="date"
            min={addDays(data.studyDate, 1)}
            {...form.register("toDate")}
          />
        </Field>
      )}
      {action === "skipped" && (
        <p className="muted">
          This skips this occurrence. The goal and other occurrences stay
          available.
        </p>
      )}
      <Field
        id="progress-note"
        label={
          action === "deferred" || action === "skipped"
            ? "Reason (optional)"
            : "Progress note (optional)"
        }
        error={errors.note?.message}
      >
        <textarea
          className="input"
          id="progress-note"
          rows={3}
          {...form.register("note")}
        />
      </Field>
      <div className="row between">
        <Button onClick={onCancel}>Keep editing task</Button>
        <Button
          variant="primary"
          type="submit"
          disabled={disabled}
          loading={pending}
        >
          {action === "completed"
            ? "Complete task"
            : action === "progress"
              ? "Save progress"
              : action === "deferred"
                ? "Defer task"
                : "Skip occurrence"}
        </Button>
      </div>
    </form>
  );
}
