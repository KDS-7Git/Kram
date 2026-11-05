import { useState } from "react";
import { Link } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bell, Pause, Pencil, Play, Plus, Send } from "lucide-react";
import {
  reminderRuleSchema,
  type Notification,
  type ReminderRule,
} from "@kram/shared";
import type { z } from "zod";
import {
  Banner,
  Button,
  Card,
  DelayedSkeleton,
  EmptyState,
  Field,
  PageHeader,
  Sheet,
  StatusPill,
} from "../../components/ui/kit";
import { api, apiList, errorMessage } from "../../shared/api";
import { useData, useOnline, useRefresh } from "../../shared/data";
import { minuteTime, timeMinute } from "../../shared/format";
import { useUI } from "../../shared/ui";

type ChannelStatus = {
  configured: boolean;
  errorCode: string | null;
  topic: string | null;
  baseUrl: string | null;
  lastSentAt: string | null;
  workerHeartbeat: string | null;
};
const typeLabels = {
  task_reminder: "Task reminder",
  upcoming: "Upcoming session",
  deadline: "Deadline",
  daily_review: "Daily review",
  weekly_review: "Weekly review",
  plan_ready: "Plan ready",
};
function reminderSentence(rule: ReminderRule) {
  return `${rule.atLocal !== null ? `At ${minuteTime(rule.atLocal)}` : `${Math.abs(rule.offsetMin || 0)} min ${(rule.offsetMin || 0) <= 0 ? "before" : "after"} a linked slot starts`}${rule.repeatPolicy === "until_completed" ? ", then every 30 min while work remains open" : ", once"}`;
}
function useReminderRules() {
  return useQuery({
    queryKey: ["reminders"],
    queryFn: ({ signal }) => apiList<ReminderRule>("/reminder-rules", signal),
  });
}

export function TaskReminders({ taskId }: { taskId: string }) {
  const rules = useReminderRules();
  return (
    <ReminderList
      rules={(rules.data || []).filter(
        (rule) => rule.ownerType === "task" && rule.ownerId === taskId,
      )}
      pending={rules.isPending}
      error={rules.error}
      retry={() => void rules.refetch()}
      taskId={taskId}
    />
  );
}
function ReminderList({
  rules,
  pending,
  error,
  retry,
  taskId,
}: {
  rules: ReminderRule[];
  pending: boolean;
  error: Error | null;
  retry: () => void;
  taskId?: string;
}) {
  const data = useData();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const [editor, setEditor] = useState<{ rule?: ReminderRule } | null>(null);
  const toggle = useMutation({
    mutationFn: (rule: ReminderRule) =>
      api(`/reminder-rules/${rule.id}`, {
        method: "PATCH",
        body: { enabled: !rule.enabled },
      }),
    onSuccess: async () => {
      await refresh();
      toast("Reminder updated.");
    },
    onError: (error) => toast(errorMessage(error), undefined, "error"),
  });
  const name = (rule: ReminderRule) =>
    rule.ownerType === "global"
      ? "All your days"
      : rule.ownerType === "task"
        ? data.tasks.find((task) => task.id === rule.ownerId)?.title || "Task"
        : rule.ownerType === "goal"
          ? data.goals.find((goal) => goal.id === rule.ownerId)?.title || "Goal"
          : data.slots.find((slot) => slot.id === rule.ownerId)?.title ||
            "Time block";
  return (
    <div className="stack">
      <div className="row between">
        <h3>Reminders</h3>
        <Button disabled={!online} onClick={() => setEditor({})}>
          <Plus size={18} strokeWidth={1.5} />
          Add reminder
        </Button>
      </div>
      {!data.user.settings.notificationsEnabled && (
        <Banner>
          Notifications are turned off.{" "}
          <Link to="/settings">Enable them in Settings</Link> to allow reminders
          to send.
        </Banner>
      )}
      {pending ? (
        <DelayedSkeleton height={140} />
      ) : error ? (
        <Banner tone="error">
          {errorMessage(error)}{" "}
          <Button variant="text" onClick={retry}>
            Retry reminders
          </Button>
        </Banner>
      ) : rules.length ? (
        <ul className="reminder-list">
          {rules.map((rule) => (
            <li key={rule.id}>
              <div>
                <strong>{name(rule)}</strong>
                <p className="caption">{reminderSentence(rule)}</p>
                <p className="caption">
                  {rule.enabled ? "Enabled" : "Paused"} · ntfy
                </p>
              </div>
              <div className="row">
                <Button
                  variant="text"
                  disabled={!online || toggle.isPending}
                  onClick={() => toggle.mutate(rule)}
                >
                  {rule.enabled ? (
                    <Pause size={17} strokeWidth={1.5} />
                  ) : (
                    <Play size={17} strokeWidth={1.5} />
                  )}{" "}
                  {rule.enabled ? "Pause" : "Enable"}
                </Button>
                <Button
                  variant="text"
                  disabled={!online}
                  onClick={() => setEditor({ rule })}
                >
                  <Pencil size={17} strokeWidth={1.5} />
                  Edit
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          A reminder can arrive at a local time or before a scheduled session.
        </p>
      )}
      <Sheet
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        title={editor?.rule ? "Edit reminder" : "A new reminder"}
        description="Choose a time in your timezone or an offset from a scheduled slot."
      >
        {editor && (
          <ReminderEditor
            rule={editor.rule}
            taskId={taskId}
            onDone={() => setEditor(null)}
          />
        )}
      </Sheet>
    </div>
  );
}

function ReminderEditor({
  rule,
  taskId,
  onDone,
}: {
  rule?: ReminderRule;
  taskId?: string;
  onDone: () => void;
}) {
  const data = useData();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const [timing, setTiming] = useState(
    rule?.offsetMin !== null && rule?.offsetMin !== undefined
      ? "offset"
      : "time",
  );
  const [direction, setDirection] = useState(
    (rule?.offsetMin || 0) > 0 ? "after" : "before",
  );
  const form = useForm<
    z.input<typeof reminderRuleSchema>,
    unknown,
    z.output<typeof reminderRuleSchema>
  >({
    resolver: zodResolver(reminderRuleSchema),
    defaultValues: rule || {
      ownerType: taskId ? "task" : "global",
      ownerId: taskId || null,
      type: "task_reminder",
      atLocal: 1080,
      offsetMin: null,
      repeatPolicy: "once",
      enabled: true,
      channel: "ntfy",
    },
  });
  const values = form.watch();
  const errors = form.formState.errors;
  const options =
    values.ownerType === "task"
      ? data.tasks
          .filter(
            (task) =>
              !["completed", "cancelled", "skipped"].includes(task.status),
          )
          .map((task) => ({ id: task.id, title: task.title }))
      : values.ownerType === "goal"
        ? data.goals.map((goal) => ({ id: goal.id, title: goal.title }))
        : data.slots.map((slot) => ({ id: slot.id, title: slot.title }));
  const save = useMutation({
    mutationFn: (input: z.output<typeof reminderRuleSchema>) =>
      api(rule ? `/reminder-rules/${rule.id}` : "/reminder-rules", {
        method: rule ? "PATCH" : "POST",
        body: input,
      }),
    onSuccess: async () => {
      await refresh();
      toast("Reminder saved.");
      onDone();
    },
  });
  return (
    <form
      className="stack-lg"
      noValidate
      onSubmit={form.handleSubmit((input) => save.mutate(input))}
    >
      {!taskId && (
        <>
          <Field id="reminder-owner" label="Remind me about">
            <select
              className="input"
              id="reminder-owner"
              {...form.register("ownerType", {
                onChange: (event) =>
                  form.setValue(
                    "ownerId",
                    event.target.value === "global" ? null : "",
                  ),
              })}
            >
              <option value="global">A daily reminder</option>
              <option value="task">A task</option>
              <option value="goal">A goal</option>
              <option value="slot">A time block</option>
            </select>
          </Field>
          {values.ownerType !== "global" && (
            <Field
              id="reminder-target"
              label="Reminder target"
              error={errors.ownerId?.message}
            >
              <select
                className="input"
                id="reminder-target"
                {...form.register("ownerId")}
              >
                <option value="">Choose one</option>
                {options.map((option) => (
                  <option value={option.id} key={option.id}>
                    {option.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}
      <Field id="reminder-type" label="Reminder message">
        <select className="input" id="reminder-type" {...form.register("type")}>
          {Object.entries(typeLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field id="reminder-timing" label="When to remind">
        <select
          className="input"
          id="reminder-timing"
          value={timing}
          onChange={(event) => {
            setTiming(event.target.value);
            form.setValue(
              "atLocal",
              event.target.value === "time" ? 1080 : null,
            );
            form.setValue(
              "offsetMin",
              event.target.value === "offset" ? -10 : null,
            );
          }}
        >
          <option value="time">At a local time</option>
          {values.ownerType !== "global" && (
            <option value="offset">Relative to a scheduled slot</option>
          )}
        </select>
      </Field>
      {timing === "time" ? (
        <Field
          id="reminder-at"
          label="Local reminder time"
          hint={`Uses ${data.user.settings.timezone} and your study-day rollover.`}
          error={errors.atLocal?.message}
        >
          <input
            className="input"
            id="reminder-at"
            type="time"
            value={minuteTime(values.atLocal ?? 1080)}
            onChange={(event) =>
              form.setValue("atLocal", timeMinute(event.target.value), {
                shouldValidate: true,
              })
            }
          />
        </Field>
      ) : (
        <div className="grid-2 form-grid">
          <Field
            id="reminder-offset"
            label="Offset (min)"
            hint="No reminder is fabricated until there is a linked slot."
            error={errors.offsetMin?.message}
          >
            <input
              className="input"
              id="reminder-offset"
              type="number"
              min="0"
              max="10080"
              value={Math.abs(values.offsetMin || 0)}
              onChange={(event) =>
                form.setValue(
                  "offsetMin",
                  Number(event.target.value) *
                    (direction === "before" ? -1 : 1),
                  { shouldValidate: true },
                )
              }
            />
          </Field>
          <Field id="reminder-direction" label="Before or after">
            <select
              className="input"
              id="reminder-direction"
              value={direction}
              onChange={(event) => {
                setDirection(event.target.value);
                form.setValue(
                  "offsetMin",
                  Math.abs(values.offsetMin || 0) *
                    (event.target.value === "before" ? -1 : 1),
                );
              }}
            >
              <option value="before">Before slot starts</option>
              <option value="after">After slot starts</option>
            </select>
          </Field>
        </div>
      )}
      <Field id="reminder-repeat" label="If the work is still open">
        <select
          className="input"
          id="reminder-repeat"
          {...form.register("repeatPolicy")}
        >
          <option value="once">Send once</option>
          <option value="until_completed">
            Repeat every 30 min until complete
          </option>
        </select>
      </Field>
      <label className="toggle-label">
        <input type="checkbox" {...form.register("enabled")} />
        Reminder enabled
      </label>
      <p className="field-hint">
        Quiet hours and lock-screen privacy follow your settings.
      </p>
      {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}
      {!online && <Banner>Reconnect to save this reminder.</Banner>}
      <Button
        variant="primary"
        type="submit"
        loading={save.isPending}
        disabled={!online}
      >
        Save reminder
      </Button>
    </form>
  );
}

export function NotificationCenter() {
  const data = useData();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const rules = useReminderRules();
  const channel = useQuery({
    queryKey: ["notifications", "status"],
    queryFn: () => api<ChannelStatus>("/notifications/status"),
    refetchInterval: 15000,
  });
  const notifications = useQuery({
    queryKey: ["notifications", "list"],
    queryFn: ({ signal }) => apiList<Notification>("/notifications", signal),
    refetchInterval: 5000,
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ notification: Notification; queued: true }>("/notifications/test", {
        method: "POST",
        body: {},
      }),
    onSuccess: async () => {
      await refresh();
      toast("Test queued. Check its delivery attempt below.");
    },
  });
  return (
    <>
      <PageHeader
        title="Messages, without the noise"
        eyebrow="Notifications"
        description="Control reminders and see whether the channel accepted each message."
      />
      <div className="stack-lg">
        <Card>
          <div className="card-header">
            <h2>
              <Bell size={20} strokeWidth={1.5} aria-hidden="true" /> ntfy
              channel
            </h2>
            <Button
              variant="primary"
              disabled={!online || !channel.data?.configured}
              loading={test.isPending}
              onClick={() => test.mutate()}
            >
              <Send size={18} strokeWidth={1.5} />
              Send test
            </Button>
          </div>
          {channel.isPending ? (
            <DelayedSkeleton height={100} />
          ) : channel.isError ? (
            <Banner tone="error">
              {errorMessage(channel.error)}{" "}
              <Button variant="text" onClick={() => void channel.refetch()}>
                Retry status
              </Button>
            </Banner>
          ) : channel.data?.configured ? (
            <div className="stack">
              <p>
                <StatusPill status="active" /> Channel configured
              </p>
              <p className="caption">
                Subscribe to the configured topic in your ntfy app.
              </p>
              {channel.data.baseUrl && channel.data.topic && (
                <p className="channel-address">
                  {channel.data.baseUrl}/{channel.data.topic}
                </p>
              )}
              {channel.data.lastSentAt && (
                <p className="caption">
                  Last accepted{" "}
                  {new Date(channel.data.lastSentAt).toLocaleString(undefined, {
                    timeZone: data.user.settings.timezone,
                  })}
                </p>
              )}
            </div>
          ) : (
            <Banner>
              Configure the ntfy URL and topic for this Kram instance to send
              reminders. <Link to="/settings">Notification preferences</Link>
            </Banner>
          )}
          <p className="field-hint" style={{ marginTop: "1rem" }}>
            Accepted by the channel confirms server delivery to ntfy. Check the
            receiving device to confirm it arrived there.
          </p>
          {channel.data && (
            <p className="caption">
              {channel.data.workerHeartbeat
                ? `Background delivery service last seen ${new Date(channel.data.workerHeartbeat).toLocaleString(undefined, { timeZone: data.user.settings.timezone })}.`
                : "Background delivery service has not reported yet. Start the worker to process queued reminders."}
            </p>
          )}
          {test.isError && (
            <Banner tone="error">{errorMessage(test.error)}</Banner>
          )}
        </Card>
        <Card>
          <ReminderList
            rules={rules.data || []}
            pending={rules.isPending}
            error={rules.error}
            retry={() => void rules.refetch()}
          />
        </Card>
        <Card>
          <h2>Delivery history</h2>
          {notifications.isPending ? (
            <DelayedSkeleton height={180} />
          ) : notifications.isError ? (
            <Banner tone="error">
              {errorMessage(notifications.error)}{" "}
              <Button
                variant="text"
                onClick={() => void notifications.refetch()}
              >
                Retry history
              </Button>
            </Banner>
          ) : !notifications.data?.length ? (
            <EmptyState
              title="Messages will appear here"
              icon={<Bell strokeWidth={1} />}
            >
              Scheduled reminders and test messages keep their delivery attempts
              here.
            </EmptyState>
          ) : (
            <ol className="notification-history">
              {notifications.data.map((notification) => (
                <li key={notification.id}>
                  <div className="row between">
                    <strong>{notification.title}</strong>
                    <StatusPill
                      status={
                        notification.status === "pending"
                          ? "queued"
                          : notification.status
                      }
                    />
                  </div>
                  <p>{notification.body}</p>
                  <p className="caption">
                    Scheduled{" "}
                    {new Date(notification.scheduledFor).toLocaleString(
                      undefined,
                      { timeZone: data.user.settings.timezone },
                    )}
                  </p>
                  {notification.attempts.length > 0 && (
                    <details className="disclosure">
                      <summary>
                        {notification.attempts.length} delivery{" "}
                        {notification.attempts.length === 1
                          ? "attempt"
                          : "attempts"}
                      </summary>
                      <ul>
                        {notification.attempts.map((attempt) => (
                          <li key={attempt.id}>
                            {attempt.outcome.replaceAll("_", " ")}{" "}
                            {attempt.httpStatus
                              ? `· HTTP ${attempt.httpStatus}`
                              : ""}{" "}
                            ·{" "}
                            {new Date(attempt.attemptedAt).toLocaleString(
                              undefined,
                              { timeZone: data.user.settings.timezone },
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}
