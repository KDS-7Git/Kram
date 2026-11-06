import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { DateTime } from "luxon";
import { addDays, weekday } from "@kram/time";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  GripVertical,
  LockKeyhole,
  Pencil,
  Pin,
  Plus,
  Trash2,
} from "lucide-react";
import { slotSchema, type Task, type TimeSlot, type Occurrence } from "@kram/shared";
import type { z } from "zod";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  DelayedSkeleton,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  Sheet,
  Segments,
} from "../../components/ui/kit";
import { api, apiList, ApiIssue, errorMessage } from "../../shared/api";
import { useData, useOnline, useRefresh } from "../../shared/data";
import { useWallClock } from "../../shared/clock";
import {
  calendarDate,
  allocatedMinutes,
  clockLabel,
  duration,
  minuteTime,
  timeMinute,
} from "../../shared/format";
import { useUI } from "../../shared/ui";
import { useCompactLayout, useDayCalendar } from "../../shared/media";

import { CalendarRange, WeekStrip, blockLanes, calendarWindow, occurrenceLink, RecurringWork, layerLabels, type CalendarView } from "./CalendarViews";

const pixelsPerMinute = 176 / 60;
const timelineSize = (minutes: number) =>
  `${(minutes * pixelsPerMinute) / 16}rem`;
type SlotDraft = {
  slot?: TimeSlot;
  startMin?: number;
  endMin?: number;
  skillId?: string;
  task?: Task;
  pinned?: boolean;
};
type SlotConflict = Pick<
  TimeSlot,
  "id" | "title" | "date" | "startMin" | "endMin" | "layer"
>;
function conflictDetails(error: unknown): SlotConflict[] {
  return error instanceof ApiIssue && Array.isArray(error.details)
    ? error.details.filter(
        (row): row is SlotConflict =>
          row &&
          typeof row === "object" &&
          typeof row.id === "string" &&
          typeof row.title === "string" &&
          typeof row.date === "string" &&
          typeof row.startMin === "number" &&
          typeof row.endMin === "number",
      )
    : [];
}
function ConflictingBlocks({ error }: { error: unknown }) {
  const data = useData();
  const conflicts = conflictDetails(error);
  return conflicts.length ? (
    <ul className="conflict-list" aria-label="Conflicting time blocks">
      {conflicts.map((slot) => (
        <li key={slot.id}>
          <strong>{slot.title}</strong> · {calendarDate(slot.date)} ·{" "}
          {clockLabel(slot.startMin, data.user.settings.clockFormat)}–
          {clockLabel(slot.endMin, data.user.settings.clockFormat)}
        </li>
      ))}
    </ul>
  ) : null;
}

export function Timetable() {
  const data = useData();
  const navigate = useNavigate();
  const compact = useCompactLayout();
  const dayCalendar = useDayCalendar();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const [params, setParams] = useSearchParams();
  const now = useWallClock(60000);
  const [date, setDate] = useState(params.get("date") || data.studyDate);
  const [view, setView] = useState<CalendarView>((['day', 'week', 'month', 'agenda'].includes(params.get('view') || '') ? params.get('view') : 'day') as CalendarView);
  const [profileFilter, setProfileFilter] = useState('all'), [skillFilter, setSkillFilter] = useState('all'), [goalFilter, setGoalFilter] = useState('all');
  const range = calendarWindow(date, view, data.user.settings.weekStart);
  const matches = (item: { profileId?: string | null; skillId?: string | null; goalId?: string | null }) => {
    const goal = data.goals.find(goal => goal.id === item.goalId), skillId = item.skillId || goal?.skillId, skill = data.skills.find(skill => skill.id === skillId), profileId = item.profileId || skill?.profileId;
    return (profileFilter === 'all' || profileId === profileFilter) && (skillFilter === 'all' || skillId === skillFilter) && (goalFilter === 'all' || item.goalId === goalFilter);
  };
  const stepDate = (value: string, direction: number) => view === 'month' ? DateTime.fromISO(value, { zone: 'UTC' }).plus({ months: direction }).toISODate()! : addDays(value, direction * (view === 'day' ? 1 : view === 'week' ? 7 : 21));
  const [editor, setEditor] = useState<SlotDraft | null>(null);
  const [remove, setRemove] = useState<TimeSlot | null>(null);
  const [lastAttempt, setLastAttempt] = useState<TimeSlot | null>(null);
  const [editorConflicts, setEditorConflicts] = useState<string[]>([]);
  const slots = useQuery({
    queryKey: ["timetable", view, range.from, range.to],
    queryFn: ({ signal }) =>
      apiList<TimeSlot>(`/timetable/global?from=${range.from}&to=${range.to}`, signal),
    refetchInterval: 15000,
  });
  const occurrences = useQuery({ queryKey: ['recurrence', 'calendar', range.from, range.to], queryFn: ({ signal }) => apiList<Occurrence>(`/recurrence/occurrences?from=${range.from}&to=${range.to}`, signal), refetchInterval: 15000 });
  const free = useQuery({ queryKey: ['timetable', 'free', date], queryFn: () => apiList<{ startMin: number; endMin: number; skillId?: string }>(`/timetable/free/${date}`), enabled: view === 'day' || (dayCalendar && view === 'week') });
  const visibleOccurrences = (occurrences.data || []).filter(item => matches(item.series));
  const blocked = visibleOccurrences.filter(item => item.status === 'conflict');
  const editSlot = (slot: TimeSlot) => slot.virtual ? navigate(occurrenceLink(slot)) : setEditor({ slot });
  useEffect(() => {
    if (params.has("add") || params.has("taskId")) {
      setEditor({
        startMin: params.has("startMin") ? Number(params.get("startMin")) : undefined,
        task: data.tasks.find((task) => task.id === params.get("taskId")),
        pinned: params.get("pin") === "true",
      });
      const next = new URLSearchParams(params);
      next.delete("add");
      next.delete("taskId");
      next.delete("pin");
      next.delete("startMin");
      setParams(next, { replace: true });
    }
  }, [params, setParams, data.tasks]);
  useEffect(() => {
    const requestedDate = params.get('date'), requestedView = params.get('view');
    if (requestedDate && DateTime.fromISO(requestedDate).isValid) setDate(requestedDate);
    if (requestedView && ['day', 'week', 'month', 'agenda'].includes(requestedView)) setView(requestedView as CalendarView);
  }, [params]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            "input,textarea,select,[contenteditable=true]",
          )) ||
        document.querySelector("[role=dialog][data-state=open]")
      )
        return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        setDate((value) => stepDate(value, event.key === "ArrowLeft" ? -1 : 1));
      }
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        setDate(data.studyDate);
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [data.studyDate, view]);
  const allDaySlots = (slots.data || []).filter(slot => slot.date === date);
  const ordered = [...(slots.data || []).filter(slot => matches(slot) && (view !== 'day' && !(dayCalendar && view === 'week') || slot.date === date))].sort(
    (a, b) => a.startMin - b.startMin || a.id.localeCompare(b.id),
  );
  const start =
    Math.floor(
      Math.min(
        data.user.settings.wakingMin,
        ...allDaySlots.map((slot) => slot.startMin),
      ) / 60,
    ) * 60;
  const end = Math.min(
    1440,
    Math.ceil(
      Math.max(
        data.user.settings.sleepingMin,
        ...allDaySlots.map((slot) => slot.endMin),
      ) / 60,
    ) * 60,
  );
  const current = DateTime.fromMillis(now).setZone(data.user.settings.timezone);
  const nowMin = current.hour * 60 + current.minute;
  const visibleNow =
    current.toISODate() === date && nowMin >= start && nowMin <= end;
  const move = useMutation({
    mutationFn: ({ slot, startMin, endMin }: { slot: TimeSlot; startMin: number; endMin?: number }) =>
      api<TimeSlot>(`/timetable/slots/${slot.id}`, {
        method: "PATCH",
        headers: { "If-Match": `"${slot.version}"` },
        body: { startMin, endMin: endMin ?? startMin + (slot.endMin - slot.startMin) },
      }),
    onSuccess: async () => {
      await refresh();
      toast("Time block updated.");
    },
    onError: (error) => toast(errorMessage(error), undefined, "error"),
  });
  const removeBlock = useMutation({
    mutationFn: (slot: TimeSlot) =>
      api(`/timetable/slots/${slot.id}`, {
        method: "DELETE",
        headers: { "If-Match": `"${slot.version}"` },
      }),
    onSuccess: async () => {
      await refresh();
      setRemove(null);
      setEditor(null);
      toast("Time block removed.");
    },
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    const slot = ordered.find((slot) => slot.id === event.active.id);
    if (!slot || !online || slot.virtual) return;
    const length = slot.endMin - slot.startMin;
    const startMin = Math.max(
      0,
      Math.min(
        1440 - length,
        Math.round(
          (slot.startMin +
            event.delta.y /
              ((pixelsPerMinute *
                parseFloat(
                  getComputedStyle(document.documentElement).fontSize,
                )) /
                16)) /
            15,
        ) * 15,
      ),
    );
    if (startMin === slot.startMin) return;
    setLastAttempt({ ...slot, startMin, endMin: startMin + length });
    move.mutate({ slot, startMin });
  };
  const filtered = profileFilter !== 'all' || skillFilter !== 'all' || goalFilter !== 'all';
  const filterNames = [data.profiles.find(row => row.id === profileFilter)?.name, data.skills.find(row => row.id === skillFilter)?.name, data.goals.find(row => row.id === goalFilter)?.title].filter(Boolean);
  const lanes = blockLanes(ordered);
  const rest = data.user.settings.restDays.includes(weekday(date));
  const conflictIds = new Set([
    ...editorConflicts,
    ...conflictDetails(move.error).map((slot) => slot.id),
  ]);
  return (
    <>
      <PageHeader
        title="Your timetable"
        eyebrow={`Plan · ${view} timetable`}
        description="Give tasks a time, keep fixed commitments in place, and leave room between them."
        action={
          <Button
            variant="primary"
            disabled={!online}
            onClick={() => setEditor({})}
          >
            <Plus size={18} strokeWidth={1.5} />
            Add time block
          </Button>
        }
      />
      <div className="row between wrap calendar-toolbar"><Segments label="Timetable view" value={view} onChange={setView} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'agenda', label: 'Agenda' }]} /><div className="row wrap"><Link className="button" to="/planning">Proposals and plan history</Link><Link className="button" to="/schedules">Schedules and templates</Link></div></div>
      <div className="calendar-filters">
        <Field id="plan-profile" label="Profile filter"><select className="input" id="plan-profile" value={profileFilter} onChange={event => { setProfileFilter(event.target.value); setSkillFilter('all'); setGoalFilter('all'); }}><option value="all">All profiles</option>{data.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field>
        <Field id="plan-skill" label="Skill filter"><select className="input" id="plan-skill" value={skillFilter} onChange={event => { setSkillFilter(event.target.value); setGoalFilter('all'); }}><option value="all">All skills</option>{data.skills.filter(skill => profileFilter === 'all' || skill.profileId === profileFilter).map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></Field>
        <Field id="plan-goal" label="Goal filter"><select className="input" id="plan-goal" value={goalFilter} onChange={event => setGoalFilter(event.target.value)}><option value="all">All goals</option>{data.goals.filter(goal => (skillFilter === 'all' || goal.skillId === skillFilter) && (profileFilter === 'all' || data.skills.find(skill => skill.id === goal.skillId)?.profileId === profileFilter)).map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></Field>
      </div>
      {filtered && <div className="calendar-filter-banner"><Banner tone="info" action={<Button variant="text" onClick={() => { setProfileFilter('all'); setSkillFilter('all'); setGoalFilter('all'); }}>Clear filters</Button>}><strong>Showing {filterNames.join(' / ')} only</strong> · schedule unchanged. Hidden commitments still occupy their times.</Banner></div>}
      <div className="row day-navigation">
        <IconButton
          label={`Previous ${view === "day" ? "day" : view === "month" ? "month" : view === "week" ? "week" : "range"}`}
          onClick={() => setDate((value) => stepDate(value, -1))}
        >
          <ArrowLeft size={18} strokeWidth={1.5} />
        </IconButton>
        <Field id="plan-date" label="Calendar date">
          <input
            className="input"
            id="plan-date"
            type="date"
            value={date}
            onChange={(event) => {
              if (event.target.value) setDate(event.target.value);
            }}
          />
        </Field>
        <IconButton
          label={`Next ${view === "day" ? "day" : view === "month" ? "month" : view === "week" ? "week" : "range"}`}
          onClick={() => setDate((value) => stepDate(value, 1))}
        >
          <ArrowRight size={18} strokeWidth={1.5} />
        </IconButton>
        <Button variant="text" onClick={() => setDate(data.studyDate)}>
          Current study day
        </Button>
        <span className="caption">{data.user.settings.timezone}</span>
      </div>
      {(compact || (dayCalendar && view === 'week')) && (view === 'day' || view === 'week') && <WeekStrip date={date} onDate={setDate} />}
      {blocked.length > 0 && <Banner tone="warning"><strong>{blocked.length} repeating occurrences need another time.</strong><ul className="conflict-list">{blocked.map(item => <li key={item.id}><Link to={`/schedules?seriesId=${item.seriesId}&date=${item.originalDate}`}>{item.fields.title} · {calendarDate(item.localDate)}</Link></li>)}</ul></Banner>}
      {occurrences.isError && <Banner tone="error">{errorMessage(occurrences.error)} <Button variant="text" onClick={() => void occurrences.refetch()}>Retry recurring schedules</Button></Banner>}
      {move.isError && (
        <Banner tone="error">
          {errorMessage(move.error)}
          <ConflictingBlocks error={move.error} />
          {move.error instanceof ApiIssue && move.error.status === 412 && (
            <Button
              variant="text"
              onClick={() => {
                void slots.refetch();
                move.reset();
              }}
            >
              Reload latest timetable
            </Button>
          )}
          {lastAttempt && (
            <Button
              variant="text"
              onClick={() => setEditor({ slot: lastAttempt })}
            >
              <Pencil size={17} strokeWidth={1.5} />
              Edit proposed times
            </Button>
          )}
        </Banner>
      )}
      {slots.isError && (
        <Banner tone="error">
          {errorMessage(slots.error)}{" "}
          <Button variant="text" onClick={() => void slots.refetch()}>
            Retry timetable
          </Button>
        </Banner>
      )}
      {slots.isPending ? (
        <DelayedSkeleton height={320} />
      ) : view !== 'day' && !(dayCalendar && view === 'week') ? <CalendarRange view={view} date={date} from={range.from} to={range.to} slots={ordered} allSlots={slots.data || []} now={now} occurrences={visibleOccurrences} goals={data.goals.filter(goal => matches({ goalId: goal.id }))} onDate={value => { setDate(value); setView('day'); }} onEdit={editSlot} /> : (
        <>
          <Card className="day-summary">
            <CalendarDays size={24} strokeWidth={1.5} aria-hidden="true" />
            <div>
              <h2>{calendarDate(date)}</h2>
              <p className="caption">
                {allDaySlots.length} blocks · {duration(allocatedMinutes(allDaySlots))}{" "}
                allocated
              </p>
            </div>
            {visibleNow && (
              <Button
                variant="text"
                onClick={() =>
                  document.getElementById("timeline-now")?.scrollIntoView({
                    block: "center",
                    behavior:
                      data.user.settings.motion === "reduced"
                        ? "instant"
                        : "smooth",
                  })
                }
              >
                Jump to now
              </Button>
            )}
          </Card>
          {rest && <Banner tone="info">Rest day · a planned pause.</Banner>}
          {free.isError && <Banner tone="error">Available times could not load. <Button variant="text" onClick={() => void free.refetch()}>Retry available times</Button></Banner>}
          {free.isSuccess && <p className="caption calendar-capacity">{duration(free.data.reduce((sum, slot) => sum + slot.endMin - slot.startMin, 0))} available for additional work after breaks, free-time reserve and your daily limit.</p>}
          {allocatedMinutes(allDaySlots.filter(slot => !['reserved', 'unavailable'].includes(slot.layer))) > data.user.settings.maxDailyMin && <Banner tone="warning">Planned work exceeds your {duration(data.user.settings.maxDailyMin)} daily limit. Shorten or move a block to leave more room.</Banner>}
          <RecurringWork items={visibleOccurrences.filter(item => item.localDate === date && item.series.kind === 'goal' && item.status === 'scheduled')} />
          {!ordered.length && (
            <div style={{ marginBottom: "1.5rem" }}>
              <Card>
                <EmptyState
                  title="There is room in this day"
                  icon={<CalendarDays strokeWidth={1} />}
                  action={
                    <Button disabled={!online} onClick={() => setEditor({})}>
                      Place a time block
                    </Button>
                  }
                >
                  Tap a free time or add a block to give the day a little shape.
                </EmptyState>
              </Card>
            </div>
          )}
          <DndContext
            sensors={sensors}
            onDragEnd={onDragEnd}
            accessibility={{
              screenReaderInstructions: {
                draggable:
                  "Drag this handle to move the block in fifteen-minute steps. Use Edit block to change times with the keyboard.",
              },
              announcements: {
                onDragStart: ({ active }) =>
                  `Moving ${ordered.find((slot) => slot.id === active.id)?.title || "time block"}.`,
                onDragOver: () => undefined,
                onDragEnd: () => "Saving the new time.",
                onDragCancel: () => "Move cancelled.",
              },
            }}
          >
            <div
              className={`day-timeline${rest ? " day-timeline-rest" : ""}`}
              style={{ height: timelineSize(end - start) }}
              aria-label={`Timetable for ${calendarDate(date)}`}
            >
              {Array.from(
                { length: (end - start) / 60 + 1 },
                (_, index) => start + index * 60,
              ).map((minute) => (
                <div
                  className="timeline-hour"
                  key={minute}
                  style={{ top: timelineSize(minute - start) }}
                >
                  <time>
                    {clockLabel(minute, data.user.settings.clockFormat)}
                  </time>
                  <span />
                </div>
              ))}
              {(free.data || []).map((gap) => (
                <button type="button" className="timeline-free" key={`${gap.startMin}:${gap.skillId || 'open'}`} style={{ top: timelineSize(gap.startMin - start), height: timelineSize(gap.endMin - gap.startMin) }} aria-label={`Add block at ${clockLabel(gap.startMin, data.user.settings.clockFormat)}, available until ${clockLabel(gap.endMin, data.user.settings.clockFormat)}${gap.skillId ? ', reserved skill time' : ''}`} disabled={!online} onClick={() => setEditor({ startMin: gap.startMin, endMin: Math.min(gap.endMin, gap.startMin + 30), skillId: gap.skillId })}>
                  <Plus size={16} strokeWidth={1.5} aria-hidden="true" /><span>Free · tap to add</span><span className="caption">{clockLabel(gap.startMin, data.user.settings.clockFormat)}–{clockLabel(gap.endMin, data.user.settings.clockFormat)}</span>
                </button>
              ))}
              {ordered.map((slot) => (
                <TimelineBlock
                  key={slot.id}
                  slot={slot}
                  start={start}
                  lane={lanes.get(slot.id)!}
                  current={visibleNow && nowMin >= slot.startMin && nowMin < slot.endMin}
                  editable={online && !move.isPending}
                  conflict={conflictIds.has(slot.id)}
                  onTimeKey={(event) => {
                    if (!online || move.isPending || slot.virtual || ['fixed', 'unavailable'].includes(slot.layer)) return;
                    if ((event.altKey || event.shiftKey) && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
                      event.preventDefault(); event.stopPropagation();
                      const delta = event.key === 'ArrowUp' ? -15 : 15;
                      const startMin = event.shiftKey ? slot.startMin : slot.startMin + delta;
                      const endMin = slot.endMin + delta;
                      if (startMin >= 0 && endMin <= 1440 && endMin > startMin) move.mutate({ slot, startMin, endMin });
                    } else if (event.key.toLowerCase() === 'm') { event.preventDefault(); editSlot(slot); }
                  }}
                  onEdit={() => editSlot(slot)}
                  onRemove={() => slot.virtual ? navigate(occurrenceLink(slot)) : setRemove(slot)}
                />
              ))}
              {visibleNow && (
                <div
                  className="timeline-now"
                  id="timeline-now"
                  style={{ top: timelineSize(nowMin - start) }}
                >
                  <span>
                    Now {clockLabel(nowMin, data.user.settings.clockFormat)}
                  </span>
                  <i />
                </div>
              )}
            </div>
          </DndContext>
          <p className="caption" style={{ marginTop: "1rem" }}>
            Fixed and unavailable blocks stay in place. Flexible and pinned
            blocks move in 15-minute steps. Focus a block: Alt + ↑/↓ moves it, Shift + ↑/↓ resizes it, M opens typed times.
          </p>
        </>
      )}
      <Sheet
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        title={editor?.slot ? "Edit time block" : "A time block"}
        description="Choose local times. Overlapping blocks are checked before saving."
      >
        {editor && (
          <SlotEditor
            key={
              editor.slot?.id ||
              `new:${editor.startMin || 0}:${editor.task?.id || ""}`
            }
            date={date}
            draft={editor}
            onDone={() => setEditor(null)}
            onConflicts={setEditorConflicts}
            onRemove={editor.slot ? () => setRemove(editor.slot!) : undefined}
          />
        )}
      </Sheet>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(open) => {
          if (!open) setRemove(null);
        }}
        title={`Remove ${remove?.title || "this block"}?`}
        description={`This removes the block from ${calendarDate(remove?.date || date)}. Recorded task progress remains available.`}
      >
        <div className="row between">
          <Button onClick={() => setRemove(null)}>Keep block</Button>
          <Button
            variant="destructive"
            disabled={!online}
            loading={removeBlock.isPending}
            onClick={() => {
              if (remove) removeBlock.mutate(remove);
            }}
          >
            Remove block
          </Button>
        </div>
        {removeBlock.isError && (
          <Banner tone="error">{errorMessage(removeBlock.error)}</Banner>
        )}
      </ConfirmDialog>
    </>
  );
}

function TimelineBlock({
  slot,
  start,
  lane,
  current,
  onTimeKey,
  editable,
  conflict,
  onEdit,
  onRemove,
}: {
  slot: TimeSlot;
  start: number;
  lane: { lane: number; count: number };
  current: boolean;
  onTimeKey: (event: React.KeyboardEvent) => void;
  editable: boolean;
  conflict: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const data = useData();
  const fixed = slot.layer === "fixed" || slot.layer === "unavailable" || !!slot.virtual;
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: slot.id, disabled: fixed || !!slot.virtual || !editable });
  const profile = data.profiles.find(
    (profile) => profile.id === slot.profileId,
  );
  return (
    <article
      ref={setNodeRef}
      className={`timeline-block timeline-${slot.layer}${isDragging ? " timeline-dragging" : ""}${conflict ? " timeline-conflict" : ""}${current ? " block-current" : ""}${lane.count > 1 ? " timeline-block-overlap" : ""}`}
      onKeyDown={onTimeKey}
      style={{
        insetInlineStart: `calc(72px + (100% - 72px) * ${lane.lane / lane.count})`,
        width: `calc((100% - 72px) / ${lane.count})`,
        top: timelineSize(slot.startMin - start),
        height: timelineSize(Math.max(15, slot.endMin - slot.startMin)),
        transform: transform ? `translateY(${transform.y}px)` : undefined,
        borderInlineStartColor: profile
          ? `var(--profile-${profile.color})`
          : undefined,
      }}
    >
      <div className="timeline-block-heading">
        {fixed ? (
          <LockKeyhole size={18} strokeWidth={1.5} aria-hidden="true" />
        ) : lane.count === 1 ? (
          <button
            type="button"
            className="button button-icon button-text timeline-handle"
            {...attributes}
            {...listeners}
            aria-label={`Move ${slot.title}`}
            disabled={!editable}
          >
            <GripVertical size={18} strokeWidth={1.5} />
          </button>
        ) : null}
        <button
          type="button"
          className="timeline-title"
          onClick={onEdit}
          aria-label={`Edit block ${slot.title}`}
          aria-describedby={`slot-description-${slot.id}`}
          disabled={!editable}
        >
          <strong>{slot.title}</strong>
          <span className={lane.count > 1 ? "sr-only" : "caption"} id={`slot-description-${slot.id}`}>
            {clockLabel(slot.startMin, data.user.settings.clockFormat)}–
            {clockLabel(slot.endMin, data.user.settings.clockFormat)} ·{" "}
            {layerLabels[slot.layer]}{current ? " · current" : ""}{slot.taskId ? ` · ${data.tasks.find(task => task.id === slot.taskId)?.status.replaceAll("_", " ") || "task"}` : ""}{slot.recurrenceSeriesId ? " · repeats" : ""}
          </span>
          {lane.count > 1 && <span className="caption timeline-compact-time" aria-hidden="true">{clockLabel(slot.startMin, data.user.settings.clockFormat)}</span>}
        </button>
        {slot.layer === "pinned" && (
          <Pin size={16} strokeWidth={1.5} aria-hidden="true" />
        )}
        {lane.count === 1 && <IconButton
          label={slot.virtual ? `Manage repeating block ${slot.title}` : `Remove block ${slot.title}`}
          disabled={!editable}
          onClick={onRemove}
        >
          <Trash2 size={17} strokeWidth={1.5} />
        </IconButton>}
      </div>
      {slot.taskId && slot.endMin - slot.startMin > 15 && (
        <Link className="timeline-task-link" to={`/tasks/${slot.taskId}`}>
          Open task
        </Link>
      )}
    </article>
  );
}

function SlotEditor({
  date,
  draft,
  onDone,
  onConflicts,
  onRemove,
}: {
  date: string;
  draft: SlotDraft;
  onDone: () => void;
  onConflicts: (ids: string[]) => void;
  onRemove?: () => void;
}) {
  const data = useData();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const slot = draft.slot;
  const task = draft.task;
  const goal = data.goals.find((goal) => goal.id === task?.goalId);
  const skill = data.skills.find((skill) => skill.id === goal?.skillId);
  const first = draft.startMin ?? data.user.settings.wakingMin;
  const [version, setVersion] = useState(slot?.version);
  const [fixedReview, setFixedReview] = useState<z.output<
    typeof slotSchema
  > | null>(null);
  const [latestMessage, setLatestMessage] = useState("");
  const form = useForm<
    z.input<typeof slotSchema>,
    unknown,
    z.output<typeof slotSchema>
  >({
    resolver: zodResolver(slotSchema),
    defaultValues: slot || {
      date,
      startMin: first,
      endMin: draft.endMin ?? Math.min(1440, first + (task?.remainingMinutes || 30)),
      layer: draft.pinned ? "pinned" : "flexible",
      title: task?.title || "",
      profileId: skill?.profileId || data.skills.find(row => row.id === draft.skillId)?.profileId || null,
      skillId: skill?.id || draft.skillId || null,
      goalId: goal?.id || null,
      taskId: task?.id || null,
      pinned: draft.pinned || false,
    },
  });
  const values = form.watch();
  const errors = form.formState.errors;
  const save = useMutation({
    mutationFn: (input: z.output<typeof slotSchema>) =>
      api<TimeSlot>(slot ? `/timetable/slots/${slot.id}` : "/timetable/slots", {
        method: slot ? "PATCH" : "POST",
        headers: slot ? { "If-Match": `"${version}"` } : {},
        body: input,
      }),
    onSuccess: async () => {
      await refresh();
      toast(slot ? "Time block updated." : "Time block added.");
      onDone();
    },
  });
  useEffect(() => {
    onConflicts(conflictDetails(save.error).map((slot) => slot.id));
    return () => onConflicts([]);
  }, [save.error, onConflicts]);
  const reload = async () => {
    if (!slot) return;
    try {
      const current = await api<TimeSlot>(`/timetable/slots/${slot.id}`);
      setVersion(current.version);
      setLatestMessage(
        `Latest saved time: ${clockLabel(current.startMin, data.user.settings.clockFormat)}–${clockLabel(current.endMin, data.user.settings.clockFormat)}. Your draft stays in the form.`,
      );
    } catch (error) {
      toast(errorMessage(error), undefined, "error");
    }
  };
  return (
    <form
      className="stack-lg"
      noValidate
      onSubmit={form.handleSubmit((input) => {
        if (slot && (slot.layer === "fixed" || slot.layer === "unavailable"))
          setFixedReview(input);
        else save.mutate(input);
      })}
    >
      <Field id="slot-title" label="Block title" error={errors.title?.message}>
        <input
          className="input"
          id="slot-title"
          autoFocus
          {...form.register("title")}
        />
      </Field>
      <Field id="slot-date" label="Block date" error={errors.date?.message}>
        <input
          className="input"
          id="slot-date"
          type="date"
          {...form.register("date")}
        />
      </Field>
      <div className="grid-2 form-grid">
        <Field
          id="slot-start"
          label="Starts at"
          error={errors.startMin?.message}
        >
          <input
            className="input"
            id="slot-start"
            type="time"
            step="300"
            value={minuteTime(values.startMin)}
            onChange={(event) =>
              form.setValue("startMin", timeMinute(event.target.value), {
                shouldValidate: true,
              })
            }
          />
        </Field>
        <Field id="slot-end" label="Ends at" error={errors.endMin?.message}>
          <input
            className="input"
            id="slot-end"
            type="time"
            step="300"
            disabled={values.endMin === 1440}
            value={minuteTime(values.endMin === 1440 ? 0 : values.endMin)}
            onChange={(event) =>
              form.setValue("endMin", timeMinute(event.target.value), {
                shouldValidate: true,
              })
            }
          />
        </Field>
      </div>
      <label className="toggle-label">
        <input
          type="checkbox"
          checked={values.endMin === 1440}
          onChange={(event) =>
            form.setValue(
              "endMin",
              event.target.checked
                ? 1440
                : Math.min(1439, values.startMin + 30),
              { shouldValidate: true },
            )
          }
        />
        Ends at midnight
      </label>
      <Field
        id="slot-layer"
        label="Block kind"
        hint="Fixed commitments cannot be dragged. You can still edit them after confirmation."
      >
        <select
          className="input"
          id="slot-layer"
          {...form.register("layer", {
            onChange: (event) =>
              form.setValue("pinned", event.target.value === "pinned"),
          })}
        >
          {Object.entries(layerLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id="slot-task"
        label="Linked task (optional)"
        error={errors.taskId?.message}
      >
        <select
          className="input"
          id="slot-task"
          {...form.register("taskId", {
            setValueAs: (value) => value || null,
            onChange: (event) => {
              const task = data.tasks.find(
                (task) => task.id === event.target.value,
              );
              const goal = data.goals.find((goal) => goal.id === task?.goalId);
              const skill = data.skills.find(
                (skill) => skill.id === goal?.skillId,
              );
              form.setValue("goalId", goal?.id || null);
              form.setValue("skillId", skill?.id || null);
              form.setValue("profileId", skill?.profileId || null);
              if (task) form.setValue("title", task.title);
            },
          })}
        >
          <option value="">No linked task</option>
          {data.tasks
            .filter(
              (task) =>
                !["completed", "cancelled", "skipped"].includes(task.status) ||
                task.id === slot?.taskId,
            )
            .map((task) => (
              <option value={task.id} key={task.id}>
                {task.title}
              </option>
            ))}
        </select>
      </Field>
      {!values.taskId && (
        <details className="disclosure">
          <summary>Link a profile, skill or goal</summary>
          <div className="stack" style={{ marginTop: "1rem" }}>
            <Field id="slot-profile" label="Profile (optional)">
              <select
                className="input"
                id="slot-profile"
                {...form.register("profileId", {
                  setValueAs: (value) => value || null,
                  onChange: () => {
                    form.setValue("skillId", null);
                    form.setValue("goalId", null);
                  },
                })}
              >
                <option value="">No profile</option>
                {data.profiles.map((profile) => (
                  <option value={profile.id} key={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="slot-skill"
              label={
                values.layer === "reserved"
                  ? "Reserved skill"
                  : "Skill (optional)"
              }
              hint={
                values.layer === "reserved"
                  ? "Flexible work for this skill can fit inside its reserved time."
                  : undefined
              }
              error={errors.skillId?.message}
            >
              <select
                className="input"
                id="slot-skill"
                {...form.register("skillId", {
                  setValueAs: (value) => value || null,
                  onChange: (event) => {
                    const skill = data.skills.find(
                      (skill) => skill.id === event.target.value,
                    );
                    if (skill) form.setValue("profileId", skill.profileId);
                    form.setValue("goalId", null);
                  },
                })}
              >
                <option value="">No skill</option>
                {data.skills
                  .filter(
                    (skill) =>
                      !values.profileId || skill.profileId === values.profileId,
                  )
                  .map((skill) => (
                    <option value={skill.id} key={skill.id}>
                      {skill.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field id="slot-goal" label="Goal (optional)">
              <select
                className="input"
                id="slot-goal"
                {...form.register("goalId", {
                  setValueAs: (value) => value || null,
                  onChange: (event) => {
                    const goal = data.goals.find(
                      (goal) => goal.id === event.target.value,
                    );
                    const skill = data.skills.find(
                      (skill) => skill.id === goal?.skillId,
                    );
                    form.setValue("skillId", skill?.id || null);
                    if (skill) form.setValue("profileId", skill.profileId);
                  },
                })}
              >
                <option value="">No goal</option>
                {data.goals.map((goal) => (
                  <option value={goal.id} key={goal.id}>
                    {goal.title}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </details>
      )}
      {save.isError && (
        <Banner tone="error">
          {errorMessage(save.error)}
          <ConflictingBlocks error={save.error} />
          {save.error instanceof ApiIssue && save.error.status === 412 && (
            <Button variant="text" onClick={() => void reload()}>
              Reload latest version
            </Button>
          )}
        </Banner>
      )}
      {latestMessage && <Banner tone="info">{latestMessage}</Banner>}
      {values.taskId && (
        <Link className="button button-text" to={`/tasks/${values.taskId}`}>
          Open linked task
        </Link>
      )}
      {!online && (
        <Banner>
          Reconnect to save timetable changes. Your draft stays in the form.
        </Banner>
      )}
      <Button
        variant="primary"
        type="submit"
        loading={save.isPending}
        disabled={!online}
      >
        {slot ? "Save time block" : "Place time block"}
      </Button>
      {onRemove && <Button variant="destructive" disabled={!online} onClick={onRemove}>Remove time block</Button>}
      <ConfirmDialog
        open={!!fixedReview}
        onOpenChange={(open) => {
          if (!open) setFixedReview(null);
        }}
        title={`Change ${slot?.title || "this fixed block"}?`}
        description={`This changes a fixed commitment from ${slot ? `${clockLabel(slot.startMin)}–${clockLabel(slot.endMin)}` : "its current time"} to ${fixedReview ? `${clockLabel(fixedReview.startMin)}–${clockLabel(fixedReview.endMin)}` : "the entered times"}.`}
      >
        <div className="row between">
          <Button onClick={() => setFixedReview(null)}>Keep editing</Button>
          <Button
            variant="primary"
            disabled={!online}
            loading={save.isPending}
            onClick={() => {
              if (fixedReview) save.mutate(fixedReview);
            }}
          >
            Apply fixed change
          </Button>
        </div>
        {save.isError && (
          <Banner tone="error">{errorMessage(save.error)}</Banner>
        )}
      </ConfirmDialog>
    </form>
  );
}
