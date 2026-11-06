import { useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Link, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  BookOpen,
  Pause,
  Pencil,
  Play,
  Plus,
  Target,
} from "lucide-react";
import {
  goalSchema,
  goalTypes,
  type Goal,
  type Skill,
  type GoalRuleVersion,
  type ProgressEvent,
} from "@kram/shared";
import type { z } from "zod";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  PageHeader,
  Sheet,
  DelayedSkeleton as Skeleton,
  StatusPill as Status,
} from "../../components/ui/kit";
import { api, apiList, errorMessage } from "../../shared/api";
import { useData, useOnline, useRefresh } from "../../shared/data";
import { calendarDate, duration, weekdays } from "../../shared/format";
import { useUI } from "../../shared/ui";
import { RecurrenceFields, recurrenceWords } from "./RecurrenceFields";
import { TaskEditor, TaskPanel, TaskEventHistory } from "../tasks/Tasks";

export const goalLabels = {
  daily: "Daily practice",
  weekly: "Weekly quota",
  recurring: "Repeating goal",
  adaptive: "Adaptive goal",
  milestone: "Milestone",
};
const descriptions = {
  daily: "A target on each chosen practice day.",
  weekly: "A target across the week, with room to choose the days.",
  recurring: "A goal that repeats on a calendar rule.",
  adaptive: "A total amount of work to spread over your available time.",
  milestone: "A clear outcome, such as finishing a project or passing an exam.",
};

export function goalSentence(
  goal: Pick<
    Goal,
    | "type"
    | "targetQty"
    | "unit"
    | "availableDays"
    | "startDate"
    | "dueDate"
    | "rrule"
  >,
) {
  const days = weekdays
    .filter((day) => goal.availableDays.includes(day.value))
    .map((day) => day.label)
    .join(", ");
  const amount = `${goal.targetQty} ${goal.unit}`;
  const rule =
    goal.type === "daily"
      ? `${amount} on ${days || "your practice days"}`
      : goal.type === "weekly"
        ? `${amount} each week`
        : goal.type === "recurring"
          ? `${amount} ${recurrenceWords(goal.rrule)}`
          : `${amount} in total`;
  return `${rule}, from ${calendarDate(goal.startDate)}${goal.dueDate ? ` until ${calendarDate(goal.dueDate)}` : ""}.`;
}

export function SkillGoals({
  skill,
  goals,
  disabled = false,
}: {
  skill: Skill;
  goals: Goal[];
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const online = useOnline();
  return (
    <div className="skill-goals">
      {goals.map((goal) => (
        <Link to={`/goals/${goal.id}`} className="goal-row" key={goal.id}>
          <Target size={18} strokeWidth={1.5} aria-hidden="true" />
          <span className="goal-row-title">
            <strong>{goal.title}</strong>
            <span className="caption">
              {goalLabels[goal.type]} · {goal.progressQty} {goal.unit} logged
              {["adaptive", "milestone"].includes(goal.type)
                ? ` of ${goal.targetQty}`
                : " in total"}
            </span>
          </span>
          <Status status={goal.status} />
        </Link>
      ))}
      <Button
        variant="text"
        onClick={() => setEditing(true)}
        disabled={!online || !!skill.archivedAt || disabled}
      >
        <Plus size={17} strokeWidth={1.5} />
        New goal for {skill.name}
      </Button>
      <Sheet
        open={editing}
        onOpenChange={setEditing}
        title="A measurable goal"
        description="Choose what progress means, in the unit that fits this goal."
      >
        {editing && (
          <GoalEditor skillId={skill.id} onDone={() => setEditing(false)} />
        )}
      </Sheet>
    </div>
  );
}

export function GoalEditor({
  goal,
  skillId,
  effectiveDate,
  onDone,
}: {
  goal?: Goal;
  skillId?: string;
  effectiveDate?: string;
  onDone: () => void;
}) {
  const data = useData();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const [effectiveFrom, setEffectiveFrom] = useState(
    effectiveDate || data.studyDate,
  );
  const form = useForm<
    z.input<typeof goalSchema>,
    unknown,
    z.output<typeof goalSchema>
  >({
    resolver: zodResolver(goalSchema),
    defaultValues: goal || {
      skillId: skillId || data.skills[0]?.id || "",
      type: "daily",
      title: "",
      unit: "minutes",
      targetQty: 30,
      startDate: data.studyDate,
      dueDate: null,
      priority: null,
      usePriority: "inherit",
      scheduleMode: "combined",
      estMinutes: 30,
      availableDays: [1, 2, 3, 4, 5, 6],
      rrule: null,
      sortOrder: data.goals.length,
    },
  });
  const values = form.watch();
  const save = useMutation({
    mutationFn: (input: z.output<typeof goalSchema>) =>
      api(goal ? `/goals/${goal.id}` : "/goals", {
        method: goal ? "PATCH" : "POST",
        body: { ...input, ...(goal ? { effectiveFrom } : {}) },
      }),
    onSuccess: async () => {
      await refresh();
      toast(goal ? "Goal rule saved." : "Goal added.");
      onDone();
    },
  });
  const errors = form.formState.errors;
  return (
    <form
      className="stack-lg"
      onSubmit={form.handleSubmit((input) => save.mutate(input))}
      noValidate
    >
      <Field id="goal-title" label="Goal title" error={errors.title?.message}>
        <input
          id="goal-title"
          className="input"
          autoFocus
          {...form.register("title")}
        />
      </Field>
      <Field id="goal-skill" label="Skill" error={errors.skillId?.message}>
        <select
          id="goal-skill"
          className="input"
          {...form.register("skillId")}
          disabled={!!goal}
        >
          <option value="">Choose a skill</option>
          {data.skills
            .filter((skill) => !skill.archivedAt)
            .map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skill.name}
              </option>
            ))}
        </select>
      </Field>
      <Field
        id="goal-type"
        label="Goal type"
        hint={descriptions[values.type]}
        error={errors.type?.message}
      >
        <select
          id="goal-type"
          className="input"
          {...form.register("type", {
            onChange: (event) => {
              if (
                event.target.value === "recurring" &&
                !form.getValues("rrule")
              )
                form.setValue("rrule", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
              if (event.target.value !== "recurring")
                form.setValue("rrule", null);
            },
          })}
        >
          {goalTypes.filter(type=>data.user.settings.featurePreset!=='simple'||!['recurring','adaptive'].includes(type)||type===goal?.type).map((type) => (
            <option value={type} key={type}>
              {goalLabels[type]}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid-2 form-grid">
        <Field
          id="goal-quantity"
          label="Target quantity"
          hint={
            values.type === "daily"
              ? "Amount for each selected practice day."
              : values.type === "weekly"
                ? "Amount across one week."
                : values.type === "recurring"
                  ? "Amount for each occurrence."
                  : "Choose a concrete scope, such as 12 lessons or 1 assignment. A skill can stay ongoing."
          }
          error={errors.targetQty?.message}
        >
          <input
            id="goal-quantity"
            className="input"
            type="number"
            min="0.01"
            step="any"
            {...form.register("targetQty", { valueAsNumber: true })}
          />
        </Field>
        <Field
          id="goal-unit"
          label="Measurement unit"
          hint={
            goal && data.tasks.some((task) => task.goalId === goal.id)
              ? "This unit stays fixed after tasks exist. Create a new goal to measure something differently."
              : "Minutes, pages, videos, sessions…"
          }
          error={errors.unit?.message}
        >
          <input
            id="goal-unit"
            className="input"
            list="goal-units"
            readOnly={
              !!goal && data.tasks.some((task) => task.goalId === goal.id)
            }
            {...form.register("unit")}
          />
          <datalist id="goal-units">
            <option value="minutes" />
            <option value="pages" />
            <option value="videos" />
            <option value="sessions" />
            <option value="projects" />
          </datalist>
        </Field>
        <Field
          id="goal-start"
          label="Start date"
          error={errors.startDate?.message}
        >
          <input
            id="goal-start"
            className="input"
            type="date"
            {...form.register("startDate")}
          />
        </Field>
        <Field
          id="goal-due"
          label="Deadline (optional)"
          hint={
            values.type === "adaptive"
              ? "A deadline helps the planner estimate a sustainable pace."
              : undefined
          }
          error={errors.dueDate?.message}
        >
          <input
            id="goal-due"
            className="input"
            type="date"
            min={values.startDate}
            {...form.register("dueDate", {
              setValueAs: (value) => value || null,
            })}
          />
        </Field>
      </div>
      <Field
        id="goal-estimate"
        label="Estimated session time (min)"
        hint={
          (values.unit ?? "minutes").toLowerCase() === "minutes"
            ? "Minute targets supply generated task durations. This is a starting estimate for tasks you add manually."
            : ["milestone", "adaptive"].includes(values.type)
              ? "Rough time for this goal's defined quantity. Break larger goals into resource items or edit individual task estimates."
              : "Rough time for one task's assigned quantity. Start with a guess and refine individual estimates after trying the work."
        }
        error={errors.estMinutes?.message}
      >
        <input
          id="goal-estimate"
          className="input"
          type="number"
          min="5"
          max="960"
          {...form.register("estMinutes", { valueAsNumber: true })}
        />
      </Field>
      <fieldset className="weekday-field">
        <legend>Practice days</legend>
        <div className="weekday-options">
          {weekdays.map((day) => (
            <label key={day.value}>
              <input
                type="checkbox"
                checked={(values.availableDays || []).includes(day.value)}
                onChange={(event) =>
                  form.setValue(
                    "availableDays",
                    event.target.checked
                      ? [...(values.availableDays || []), day.value].sort()
                      : (values.availableDays || []).filter(
                          (value) => value !== day.value,
                        ),
                    { shouldDirty: true, shouldValidate: true },
                  )
                }
              />
              <span>{day.label}</span>
            </label>
          ))}
        </div>
        {errors.availableDays?.message && (
          <p className="field-error" role="alert">
            {errors.availableDays.message}
          </p>
        )}
      </fieldset>
      {values.type === "recurring" && (
        <div className="stack">
          <RecurrenceFields
            rule={values.rrule || null}
            onChange={(rule) =>
              form.setValue("rrule", rule, {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
          />
          <details className="disclosure">
            <summary>Advanced calendar rule</summary>
            <Field
              id="goal-rrule"
              label="Calendar recurrence rule"
              hint="For example FREQ=WEEKLY;BYDAY=MO,WE,FR. Times are local to your timezone."
              error={errors.rrule?.message}
            >
              <input
                id="goal-rrule"
                className="input code-input"
                {...form.register("rrule", {
                  setValueAs: (value) => value || null,
                })}
              />
            </Field>
          </details>
        </div>
      )}
      {data.user.settings.featurePreset!=='simple'&&<details className="disclosure">
        <summary>Planning preferences</summary>
        <div className="stack" style={{ marginTop: "1rem" }}>
          <Field id="goal-mode" label="Planning period">
            <select
              className="input"
              id="goal-mode"
              {...form.register("scheduleMode")}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="combined">Daily and weekly</option>
            </select>
          </Field>
          {data.user.settings.featurePreset==='full'&&<>
          <Field id="goal-priority-use" label="Priority scheduling">
            <select
              className="input"
              id="goal-priority-use"
              {...form.register("usePriority")}
            >
              <option value="inherit">
                Follow skill and global preference
              </option>
              <option value="on">Use priority for this goal</option>
              <option value="off">Leave priority out</option>
            </select>
          </Field>
          <Field
            id="goal-priority"
            label="Priority (optional)"
            error={errors.priority?.message}
          >
            <select
              className="input"
              id="goal-priority"
              {...form.register("priority", {
                setValueAs: (value) => (value ? Number(value) : null),
              })}
            >
              <option value="">Not set</option>
              {[1, 2, 3, 4, 5].map((value) => (
                <option value={value} key={value}>
                  {value}
                  {value === 1 ? " — lower" : value === 5 ? " — higher" : ""}
                </option>
              ))}
            </select>
          </Field>
          </>}
        </div>
      </details>}
      {goal && (
        <Field
          id="goal-effective"
          label="Rule takes effect on"
          hint="Earlier rule versions remain in your history."
          error={
            !effectiveFrom || effectiveFrom < data.studyDate
              ? "Choose today or a later study date."
              : undefined
          }
        >
          <input
            className="input"
            id="goal-effective"
            type="date"
            value={effectiveFrom}
            min={data.studyDate}
            required
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
        </Field>
      )}
      {values.startDate && (
        <Banner tone="info">{goalSentence(values as Goal)}</Banner>
      )}
      {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}
      {!online && (
        <Banner>
          Reconnect to save this goal. Your changes stay in this form.
        </Banner>
      )}
      <Button
        variant="primary"
        type="submit"
        loading={save.isPending}
        disabled={
          !online ||
          (!!goal && (!effectiveFrom || effectiveFrom < data.studyDate))
        }
      >
        {goal ? "Save goal rule" : "Add goal"}
      </Button>
    </form>
  );
}

export function GoalDetail() {
  const { goalId } = useParams();
  const data = useData();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [tab, setTab] = useState("overview");
  const [addingTask, setAddingTask] = useState(false);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const goalQuery = useQuery({
    queryKey: ["goals", goalId],
    queryFn: () => api<Goal>(`/goals/${goalId}`),
  });
  const rules = useQuery({
    queryKey: ["goals", goalId, "rules"],
    queryFn: () => api<GoalRuleVersion[]>(`/goals/${goalId}/rules`),
  });
  const history = useQuery({
    queryKey: ["goals", goalId, "events"],
    queryFn: ({ signal }) =>
      apiList<ProgressEvent>(`/goals/${goalId}/events`, signal),
    enabled: tab === "history",
  });
  const changeStatus = useMutation({
    mutationFn: (action: string) =>
      api(`/goals/${goalId}/${action}`, { method: "POST" }),
    onSuccess: async (_result, action) => {
      await refresh();
      setArchiving(false);
      toast(
        action === "archive"
          ? "Goal archived. Its history remains available."
          : action === "pause"
            ? "Goal paused."
            : "Goal resumed.",
      );
    },
  });
  if (!goalQuery.data)
    return goalQuery.isPending ? (
      <div className="stack">
        <Skeleton height={80} />
        <Skeleton height={240} />
      </div>
    ) : (
      <Card>
        <PageHeader
          title="Could not load this goal"
          description={errorMessage(goalQuery.error)}
        />
        <Button onClick={() => void goalQuery.refetch()}>Retry</Button>
        <Link className="button button-text" to="/goals">
          Back to goals
        </Link>
      </Card>
    );
  const goal = goalQuery.data;
  const cumulativeGoal = goal.type === "adaptive" || goal.type === "milestone";
  const tasks = data.tasks
    .filter((task) => task.goalId === goal.id)
    .sort(
      (a, b) =>
        a.earliestDate.localeCompare(b.earliestDate) ||
        a.sortOrder - b.sortOrder,
    );
  const latestRule = [...(rules.data || [])].sort(
    (a, b) =>
      b.effectiveFrom.localeCompare(a.effectiveFrom) || b.version - a.version,
  )[0];
  const futureRule =
    latestRule && latestRule.effectiveFrom > data.studyDate ? latestRule : null;
  const skill = data.skills.find((item) => item.id === goal.skillId);
  const resources = data.resources.filter(
    (resource) =>
      "goalIds" in resource && (resource.goalIds as string[]).includes(goal.id),
  );
  return (
    <>
      <Link className="button button-text back-link" to="/goals">
        <ArrowLeft size={18} strokeWidth={1.5} />
        Profiles and goals
      </Link>
      <PageHeader
        title={goal.title}
        eyebrow={`${skill?.name || "Goal"} · ${goalLabels[goal.type]}`}
        description={goalSentence(goal)}
        action={
          <Button
            onClick={() => setEditing(true)}
            disabled={
              !online || goal.status === "archived" || rules.isPending || !skill
            }
          >
            <Pencil size={18} strokeWidth={1.5} />
            Edit goal
          </Button>
        }
      />
      <div className="goal-summary">
        <Status status={goal.status} />
        <span className="caption">Rule version {goal.ruleVersion}</span>
        <span className="caption">
          {goal.dueDate
            ? `Deadline ${calendarDate(goal.dueDate)}`
            : "No deadline set"}
        </span>
      </div>
      {futureRule && (
        <div style={{ marginBottom: "1.5rem" }}>
          <Banner tone="info">
            Showing the latest configured rule. It takes effect on{" "}
            {calendarDate(futureRule.effectiveFrom)}; earlier study dates keep
            their previous rule.
          </Banner>
        </div>
      )}
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="tab-list" aria-label="Goal details">
          {["overview", "tasks", "history", "resources", "rules"].map(
            (value) => (
              <Tabs.Trigger value={value} key={value}>
                {value === "rules"
                  ? "Rule history"
                  : value === "resources"
                    ? "Resources"
                    : value === "tasks"
                      ? "Tasks"
                      : value === "history"
                        ? "History"
                        : "Overview"}
              </Tabs.Trigger>
            ),
          )}
        </Tabs.List>
        <Tabs.Content value="overview" className="stack-lg">
          <>
            <div className="grid-2">
              <Card>
                <p className="eyebrow">
                  {cumulativeGoal ? "Progress" : "Lifetime logged progress"} in{" "}
                  {goal.unit}
                </p>
                <p className="goal-number">
                  {goal.progressQty}
                  {cumulativeGoal && <span> of {goal.targetQty}</span>}
                </p>
                <p className="muted">{goal.unit} in total</p>
                {!cumulativeGoal && (
                  <p className="caption">
                    Target: {goal.targetQty} {goal.unit}
                    {goal.type === "weekly"
                      ? " per week"
                      : goal.type === "daily"
                        ? " per practice day"
                        : " per occurrence"}
                    .
                  </p>
                )}
              </Card>
              <Card>
                <p className="eyebrow">Lifetime time logged</p>
                <p className="goal-number">{duration(goal.progressMinutes)}</p>
                <p className="muted">
                  Estimated session: {duration(goal.estMinutes)}
                </p>
              </Card>
            </div>
            <Card>
              <h2>Goal status</h2>
              <p className="muted" style={{ marginBlock: ".75rem" }}>
                {goal.status === "paused"
                  ? "This goal is paused. Resume when you want to give it time again."
                  : goal.status === "archived"
                    ? "This goal is archived. Its rules and progress history remain available."
                    : "Pause when life needs room. Your progress stays with this goal."}
              </p>
              <div className="row">
                {["active", "paused"].includes(goal.status) && (
                  <Button
                    loading={changeStatus.isPending}
                    disabled={!online}
                    onClick={() =>
                      changeStatus.mutate(
                        goal.status === "paused" ? "resume" : "pause",
                      )
                    }
                  >
                    {goal.status === "paused" ? (
                      <Play size={18} strokeWidth={1.5} />
                    ) : (
                      <Pause size={18} strokeWidth={1.5} />
                    )}{" "}
                    {goal.status === "paused" ? "Resume goal" : "Pause goal"}
                  </Button>
                )}
                {goal.status !== "archived" && (
                  <Button
                    variant="text"
                    disabled={!online}
                    onClick={() => setArchiving(true)}
                  >
                    <Archive size={18} strokeWidth={1.5} />
                    Archive goal
                  </Button>
                )}
              </div>
            </Card>
          </>
        </Tabs.Content>
        <Tabs.Content value="tasks" className="stack-lg">
          <Card>
            <div className="card-header">
              <h2>Tasks for this goal</h2>
              <Button
                variant="primary"
                disabled={!online || goal.status !== "active"}
                onClick={() => setAddingTask(true)}
              >
                <Plus size={18} strokeWidth={1.5} />
                Add task
              </Button>
            </div>
            {tasks.length ? (
              <ul className="goal-task-list">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <button
                      className="resource-link-row"
                      type="button"
                      onClick={() => setSelectedTask(task.id)}
                    >
                      <span>
                        <strong>{task.title}</strong>
                        <span className="caption">
                          Earliest {calendarDate(task.earliestDate)} ·{" "}
                          {duration(task.remainingMinutes)} estimated remaining
                        </span>
                      </span>
                      <Status status={task.status} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                Add a manageable step for this goal. Future and finished tasks
                stay available here.
              </p>
            )}
          </Card>
        </Tabs.Content>
        <Tabs.Content value="history" className="stack-lg">
          <Card>
            <h2>Recorded progress and changes</h2>
            {history.isPending ? (
              <Skeleton height={180} />
            ) : history.isError ? (
              <Banner tone="error">
                {errorMessage(history.error)}{" "}
                <Button variant="text" onClick={() => void history.refetch()}>
                  Retry history
                </Button>
              </Banner>
            ) : history.data?.length ? (
              <TaskEventHistory
                events={history.data}
                unit={goal.unit}
                taskLinks
              />
            ) : (
              <p className="muted">
                Task progress, timer actions and corrections will appear here.
              </p>
            )}
          </Card>
        </Tabs.Content>
        <Tabs.Content value="resources" className="stack-lg">
          <Card>
            {resources.length ? (
              <div className="stack">
                {resources.map((resource) => (
                  <Link
                    className="resource-link-row"
                    to={`/resources/${resource.id}`}
                    key={resource.id}
                  >
                    <BookOpen size={20} strokeWidth={1.5} />
                    <span>
                      <strong>{resource.title}</strong>
                      <span className="caption">{resource.type}</span>
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Give this goal some material"
                icon={<BookOpen strokeWidth={1} />}
                action={
                  <Link
                    className="button button-primary"
                    to={`/resources?goalId=${goal.id}`}
                  >
                    Add a resource
                  </Link>
                }
              >
                Link a course, book, lab or project from your resource library.
              </EmptyState>
            )}
            <Link
              className="button button-text"
              to={`/resources?goalId=${goal.id}`}
              style={{ marginTop: "1rem" }}
            >
              Manage linked resources
            </Link>
          </Card>
        </Tabs.Content>
        <Tabs.Content value="rules" className="stack-lg">
          <Card>
            <h2>Rules over time</h2>
            <p className="muted" style={{ marginBlock: ".75rem" }}>
              Each saved rule has an effective date. Earlier rules remain
              available for past progress.
            </p>
            {rules.isPending ? (
              <Skeleton height={160} />
            ) : rules.isError ? (
              <Banner tone="error">
                {errorMessage(rules.error)}{" "}
                <Button variant="text" onClick={() => void rules.refetch()}>
                  Retry
                </Button>
              </Banner>
            ) : (
              <ol className="rule-history">
                {rules.data?.map((rule) => (
                  <li key={rule.id}>
                    <strong>Version {rule.version}</strong>
                    <p className="caption">
                      Effective {calendarDate(rule.effectiveFrom)}
                    </p>
                    <p>{goalSentence(rule.rules)}</p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </Tabs.Content>
      </Tabs.Root>
      <Sheet
        open={addingTask}
        onOpenChange={setAddingTask}
        title="A task for this goal"
        description="Estimate the next manageable step."
      >
        {addingTask && (
          <TaskEditor goalId={goal.id} onDone={() => setAddingTask(false)} />
        )}
      </Sheet>
      <Sheet
        open={!!selectedTask}
        onOpenChange={(open) => {
          if (!open) setSelectedTask(null);
        }}
        title="Task in focus"
        description="Control the timer and record additional progress."
      >
        {selectedTask && <TaskPanel key={selectedTask} taskId={selectedTask} />}
      </Sheet>
      {changeStatus.isError && (
        <Banner tone="error">{errorMessage(changeStatus.error)}</Banner>
      )}
      <Sheet
        open={editing}
        onOpenChange={setEditing}
        title="Edit goal rule"
        description="Choose an effective date; past rule versions remain available."
      >
        {editing && (
          <GoalEditor
            goal={goal}
            effectiveDate={futureRule?.effectiveFrom}
            onDone={() => setEditing(false)}
          />
        )}
      </Sheet>
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={`Archive ${goal.title}?`}
        description="This removes the goal from active lists. Its resources, rules and progress history stay available."
      >
        <div className="row between">
          <Button onClick={() => setArchiving(false)}>Keep goal</Button>
          <Button
            variant="destructive"
            loading={changeStatus.isPending}
            disabled={!online}
            onClick={() => changeStatus.mutate("archive")}
          >
            Archive goal
          </Button>
        </div>
        {changeStatus.isError && (
          <Banner tone="error">{errorMessage(changeStatus.error)}</Banner>
        )}
      </ConfirmDialog>
    </>
  );
}
