import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  profileSchema,
  skillSchema,
  type Profile,
  type Skill,
  type Goal,
} from "@kram/shared";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  Sheet,
} from "../../components/ui/kit";
import { useData, useOnline, useRefresh } from "../../shared/data";
import { api, apiList, errorMessage } from "../../shared/api";
import {
  duration,
  initials,
  minuteTime,
  timeMinute,
  weekdays,
} from "../../shared/format";
import { useUI } from "../../shared/ui";
import { Link } from "react-router-dom";
import { SkillGoals } from "./Goals";

const colors = [
  "teal",
  "violet",
  "rose",
  "ochre",
  "olive",
  "slate",
  "sky",
  "clay",
] as const;
type Editor =
  | { kind: "profile"; profile?: Profile }
  | { kind: "skill"; skill?: Skill; profileId: string };

export function Hierarchy() {
  const data = useData();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [archive, setArchive] = useState<{
    kind: "profile" | "skill";
    id: string;
    name: string;
  } | null>(null);
  const archived = useQuery({
    queryKey: ["hierarchy", "archived"],
    queryFn: async ({ signal }) => {
      const [profiles, skills, goals] = await Promise.all([
        apiList<Profile>("/profiles?archived=true", signal),
        apiList<Skill>("/skills?archived=true", signal),
        apiList<Goal>("/goals?archived=true", signal),
      ]);
      return { profiles, skills, goals };
    },
    enabled: showArchived,
    staleTime: 15000,
  });
  const hierarchy = showArchived && archived.data ? archived.data : data;
  const profiles = [...hierarchy.profiles].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );
  const mutation = useMutation({
    mutationFn: async (action: {
      kind: string;
      id: string;
      body?: unknown;
      operation?: string;
    }) =>
      api(
        `/${action.kind}s/${action.id}${action.operation ? `/${action.operation}` : ""}`,
        { method: action.operation ? "POST" : "PATCH", body: action.body },
      ),
    onSuccess: async () => {
      await refresh();
    },
    onError: (error) => toast(errorMessage(error), undefined, "error"),
  });
  const reorder = async (
    kind: "profile" | "skill",
    items: (Profile | Skill)[],
    index: number,
    direction: -1 | 1,
  ) => {
    const current = items[index];
    const neighbour = items[index + direction];
    if (!current || !neighbour) return;
    try {
      const ids = items.map((item) => item.id);
      ids[index] = neighbour.id;
      ids[index + direction] = current.id;
      await api(`/${kind}s/reorder`, { method: "POST", body: { ids } });
      await refresh();
      toast(`${current.name} moved ${direction < 0 ? "earlier" : "later"}.`);
    } catch (error) {
      await refresh();
      toast(errorMessage(error), undefined, "error");
    }
  };
  return (
    <>
      <PageHeader
        title="Goals begin with a place"
        eyebrow="Profiles and skills"
        description="Group the parts of your life, then name the skills you want to grow."
        action={
          <Button
            variant="primary"
            onClick={() => setEditor({ kind: "profile" })}
            disabled={!online}
          >
            <Plus size={18} strokeWidth={1.5} />
            New profile
          </Button>
        }
      />
      <div className="row between" style={{ marginBottom: "1.25rem" }}>
        <Link className="button button-text" to="/resources">
          <BookOpen size={18} strokeWidth={1.5} />
          Resource library
        </Link>
        <p className="muted">
          {data.profiles.filter((profile) => !profile.archivedAt).length}{" "}
          profiles · {data.skills.filter((skill) => !skill.archivedAt).length}{" "}
          skills
        </p>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived
        </label>
      </div>
      {showArchived && archived.isPending && (
        <Banner>
          {online
            ? "Loading archived profiles and skills…"
            : "Reconnect to load archived profiles and skills."}
        </Banner>
      )}
      {showArchived && archived.isError && (
        <Banner tone="error">
          {errorMessage(archived.error)}{" "}
          <Button
            variant="text"
            onClick={() => void archived.refetch()}
            disabled={!online}
          >
            Retry loading archive
          </Button>
        </Banner>
      )}
      {profiles.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BookOpen strokeWidth={1} />}
            title="Start with one part of your life"
            action={
              <Button
                onClick={() => setEditor({ kind: "profile" })}
                disabled={!online}
              >
                Add a profile
              </Button>
            }
          >
            Learning, development or wellbeing. A profile gives your goals a
            place to live.
          </EmptyState>
        </Card>
      ) : (
        <div className="stack-lg">
          {profiles.map((profile, index) => {
            const skills = [...hierarchy.skills]
              .filter(
                (skill) =>
                  skill.profileId === profile.id &&
                  (showArchived || !skill.archivedAt),
              )
              .sort(
                (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
              );
            const isCollapsed = collapsed.has(profile.id);
            return (
              <Card
                key={profile.id}
                className={profile.archivedAt ? "archived-card" : undefined}
              >
                <div className="profile-heading">
                  <button
                    type="button"
                    className="profile-name-button"
                    onClick={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(profile.id)) next.delete(profile.id);
                        else next.add(profile.id);
                        return next;
                      })
                    }
                    aria-expanded={!isCollapsed}
                  >
                    <span
                      className="profile-monogram"
                      style={{ borderColor: `var(--profile-${profile.color})` }}
                    >
                      {initials(profile.name)}
                    </span>
                    <span>
                      <h2>{profile.name}</h2>
                      <span className="caption">
                        {skills.length}{" "}
                        {skills.length === 1 ? "skill" : "skills"}
                        {profile.archivedAt ? " · Archived" : ""}
                      </span>
                    </span>
                    {isCollapsed ? (
                      <ChevronRight size={18} strokeWidth={1.5} />
                    ) : (
                      <ChevronDown size={18} strokeWidth={1.5} />
                    )}
                  </button>
                  <div className="row profile-actions">
                    <IconButton
                      label={`Move ${profile.name} earlier`}
                      onClick={() => reorder("profile", profiles, index, -1)}
                      disabled={!online || index === 0}
                    >
                      <ArrowUp size={18} strokeWidth={1.5} />
                    </IconButton>
                    <IconButton
                      label={`Move ${profile.name} later`}
                      onClick={() => reorder("profile", profiles, index, 1)}
                      disabled={!online || index === profiles.length - 1}
                    >
                      <ArrowDown size={18} strokeWidth={1.5} />
                    </IconButton>
                    <IconButton
                      label={`Edit ${profile.name}`}
                      onClick={() => setEditor({ kind: "profile", profile })}
                      disabled={!online}
                    >
                      <Pencil size={18} strokeWidth={1.5} />
                    </IconButton>
                    {!profile.archivedAt && (
                      <IconButton
                        label={`Archive ${profile.name}`}
                        onClick={() =>
                          setArchive({
                            kind: "profile",
                            id: profile.id,
                            name: profile.name,
                          })
                        }
                        disabled={!online}
                      >
                        <Archive size={18} strokeWidth={1.5} />
                      </IconButton>
                    )}
                  </div>
                </div>
                {!isCollapsed && (
                  <div className="profile-skills">
                    {skills.length ? (
                      skills.map((skill, skillIndex) => (
                        <div className="skill-group" key={skill.id}>
                          <div className="skill-row">
                            <div className="skill-label">
                              <span
                                className="profile-dot"
                                style={{
                                  background: `var(--profile-${profile.color})`,
                                }}
                              />
                              <div>
                                <h3>{skill.name}</h3>
                                <p className="caption">
                                  {duration(skill.dailyTargetMin)} a day ·{" "}
                                  {duration(skill.weeklyTargetMin)} a week
                                  {skill.archivedAt ? " · Archived" : ""}
                                </p>
                              </div>
                            </div>
                            <div className="row">
                              <IconButton
                                label={`Move ${skill.name} earlier`}
                                disabled={!online || skillIndex === 0}
                                onClick={() =>
                                  reorder("skill", skills, skillIndex, -1)
                                }
                              >
                                <ArrowUp size={17} strokeWidth={1.5} />
                              </IconButton>
                              <IconButton
                                label={`Move ${skill.name} later`}
                                disabled={
                                  !online || skillIndex === skills.length - 1
                                }
                                onClick={() =>
                                  reorder("skill", skills, skillIndex, 1)
                                }
                              >
                                <ArrowDown size={17} strokeWidth={1.5} />
                              </IconButton>
                              <IconButton
                                label={`Edit ${skill.name}`}
                                disabled={!online}
                                onClick={() =>
                                  setEditor({
                                    kind: "skill",
                                    skill,
                                    profileId: profile.id,
                                  })
                                }
                              >
                                <Pencil size={17} strokeWidth={1.5} />
                              </IconButton>
                              {!skill.archivedAt && (
                                <IconButton
                                  label={`Archive ${skill.name}`}
                                  disabled={!online}
                                  onClick={() =>
                                    setArchive({
                                      kind: "skill",
                                      id: skill.id,
                                      name: skill.name,
                                    })
                                  }
                                >
                                  <Archive size={17} strokeWidth={1.5} />
                                </IconButton>
                              )}
                            </div>
                          </div>
                          <SkillGoals
                            skill={skill}
                            disabled={!!profile.archivedAt}
                            goals={hierarchy.goals.filter(
                              (goal) => goal.skillId === skill.id,
                            )}
                          />
                        </div>
                      ))
                    ) : (
                      <p className="muted" style={{ paddingBlock: "1rem" }}>
                        Name a skill you want to practice in this profile.
                      </p>
                    )}
                    {!profile.archivedAt && (
                      <Button
                        variant="text"
                        onClick={() =>
                          setEditor({ kind: "skill", profileId: profile.id })
                        }
                        disabled={!online}
                      >
                        <Plus size={18} strokeWidth={1.5} />
                        Add skill
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
      <Sheet
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        title={
          editor?.kind === "profile"
            ? editor.profile
              ? "Edit profile"
              : "A new profile"
            : editor?.skill
              ? "Edit skill"
              : "A new skill"
        }
        description={
          editor?.kind === "profile"
            ? "Give this part of your life a name and a small identifying mark."
            : "Choose a target that leaves room for real life."
        }
      >
        {editor?.kind === "profile" ? (
          <ProfileEditor
            key={editor.profile?.id || "new"}
            profile={editor.profile}
            onDone={() => setEditor(null)}
          />
        ) : editor?.kind === "skill" ? (
          <SkillEditor
            key={editor.skill?.id || "new"}
            skill={editor.skill}
            profileId={editor.profileId}
            onDone={() => setEditor(null)}
          />
        ) : null}
      </Sheet>
      <ConfirmDialog
        open={!!archive}
        onOpenChange={(open) => {
          if (!open) setArchive(null);
        }}
        title={`Archive ${archive?.name || "this item"}?`}
        description={`This hides ${archive?.name || "this item"} from active lists. Its progress history stays available.`}
      >
        {!online && <Banner>Reconnect before archiving this item.</Banner>}
        <div className="row between">
          <Button onClick={() => setArchive(null)}>Keep active</Button>
          <Button
            variant="destructive"
            loading={mutation.isPending}
            disabled={!online}
            onClick={() => {
              if (!archive) return;
              mutation.mutate(
                { kind: archive.kind, id: archive.id, operation: "archive" },
                {
                  onSuccess: () => {
                    toast(`${archive.name} archived.`);
                    setArchive(null);
                  },
                },
              );
            }}
          >
            <Archive size={18} strokeWidth={1.5} />
            Archive
          </Button>
        </div>
      </ConfirmDialog>
    </>
  );
}

function ProfileEditor({
  profile,
  onDone,
}: {
  profile?: Profile;
  onDone: () => void;
}) {
  const data = useData();
  const refresh = useRefresh();
  const { toast } = useUI();
  const online = useOnline();
  const form = useForm<
    z.input<typeof profileSchema>,
    unknown,
    z.output<typeof profileSchema>
  >({
    resolver: zodResolver(profileSchema),
    defaultValues: profile || {
      name: "",
      icon: "BookOpen",
      color: colors[data.profiles.length % colors.length]!,
      sortOrder: data.profiles.length,
    },
  });
  const color = form.watch("color");
  const save = useMutation({
    mutationFn: (values: z.output<typeof profileSchema>) =>
      api(profile ? `/profiles/${profile.id}` : "/profiles", {
        method: profile ? "PATCH" : "POST",
        body: values,
      }),
    onSuccess: async () => {
      await refresh();
      toast(profile ? "Profile updated." : "Profile added.");
      onDone();
    },
  });
  return (
    <form
      className="stack-lg"
      onSubmit={form.handleSubmit((values) => save.mutate(values))}
      noValidate
    >
      <Field
        id="profile-name"
        label="Profile name"
        error={form.formState.errors.name?.message}
      >
        <input
          className="input"
          id="profile-name"
          autoFocus
          {...form.register("name")}
          aria-invalid={!!form.formState.errors.name}
          aria-describedby={
            form.formState.errors.name ? "profile-name-error" : undefined
          }
        />
      </Field>
      <fieldset className="color-options">
        <legend>Identity colour</legend>
        {colors.map((value) => (
          <label key={value} title={value}>
            <input type="radio" value={value} {...form.register("color")} />
            <span
              className={color === value ? "selected" : ""}
              style={{
                borderColor: `var(--profile-${value})`,
                background: `var(--profile-${value})`,
              }}
            />
            <span className="sr-only">{value}</span>
          </label>
        ))}
      </fieldset>
      <Field id="profile-icon" label="Profile symbol">
        <select className="input" id="profile-icon" {...form.register("icon")}>
          <option value="BookOpen">Book</option>
          <option value="Code">Code</option>
          <option value="Heart">Heart</option>
          <option value="GraduationCap">Learning</option>
          <option value="Compass">Explore</option>
        </select>
      </Field>
      {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}
      {!online && (
        <Banner>
          Reconnect to save this profile. Your changes stay in this form.
        </Banner>
      )}
      <Button
        variant="primary"
        type="submit"
        loading={save.isPending}
        disabled={!online}
      >
        {profile ? "Save profile" : "Add profile"}
      </Button>
    </form>
  );
}

function SkillEditor({
  skill,
  profileId,
  onDone,
}: {
  skill?: Skill;
  profileId: string;
  onDone: () => void;
}) {
  const data = useData();
  const refresh = useRefresh();
  const { toast } = useUI();
  const online = useOnline();
  const form = useForm<
    z.input<typeof skillSchema>,
    unknown,
    z.output<typeof skillSchema>
  >({
    resolver: zodResolver(skillSchema),
    defaultValues: skill || {
      profileId,
      name: "",
      dailyTargetMin: 30,
      weeklyTargetMin: 150,
      maxDailyMin: 180,
      availableDays: [1, 2, 3, 4, 5, 6],
      windows: [],
      priority: null,
      usePriority: "inherit",
      sortOrder: data.skills.filter((item) => item.profileId === profileId)
        .length,
    },
  });
  const values = form.watch();
  const save = useMutation({
    mutationFn: (input: z.output<typeof skillSchema>) =>
      api(skill ? `/skills/${skill.id}` : `/profiles/${profileId}/skills`, {
        method: skill ? "PATCH" : "POST",
        body: input,
      }),
    onSuccess: async () => {
      await refresh();
      toast(skill ? "Skill updated." : "Skill added.");
      onDone();
    },
  });
  return (
    <form
      className="stack-lg"
      onSubmit={form.handleSubmit((input) => save.mutate(input))}
      noValidate
    >
      <Field
        id="skill-name"
        label="Skill name"
        error={form.formState.errors.name?.message}
      >
        <input
          id="skill-name"
          className="input"
          autoFocus
          {...form.register("name")}
          aria-invalid={!!form.formState.errors.name}
          aria-describedby={
            form.formState.errors.name ? "skill-name-error" : undefined
          }
        />
      </Field>
      <div className="grid-2 form-grid">
        <Field
          id="skill-daily"
          label="Daily target (min)"
          error={form.formState.errors.dailyTargetMin?.message}
        >
          <input
            className="input"
            id="skill-daily"
            type="number"
            min="0"
            {...form.register("dailyTargetMin", { valueAsNumber: true })}
          />
        </Field>
        <Field
          id="skill-weekly"
          label="Weekly target (min)"
          error={form.formState.errors.weeklyTargetMin?.message}
        >
          <input
            className="input"
            id="skill-weekly"
            type="number"
            min="0"
            {...form.register("weeklyTargetMin", { valueAsNumber: true })}
          />
        </Field>
      </div>
      <Field
        id="skill-max"
        label="Daily limit (min)"
        hint="The planner keeps this skill within this limit."
        error={form.formState.errors.maxDailyMin?.message}
      >
        <input
          className="input"
          id="skill-max"
          type="number"
          min="0"
          {...form.register("maxDailyMin", { valueAsNumber: true })}
        />
      </Field>
      <fieldset className="weekday-options">
        <legend>Practice days</legend>
        {weekdays.map((day) => (
          <label key={day.value}>
            <input
              type="checkbox"
              checked={values.availableDays?.includes(day.value) || false}
              onChange={(event) =>
                form.setValue(
                  "availableDays",
                  event.target.checked
                    ? [...(values.availableDays || []), day.value].sort(
                        (a, b) => a - b,
                      )
                    : values.availableDays?.filter(
                        (value) => value !== day.value,
                      ) || [],
                )
              }
            />
            <span>{day.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="stack">
        <div className="row between">
          <h3>Preferred time windows</h3>
          <Button
            variant="text"
            onClick={() =>
              form.setValue("windows", [
                ...(values.windows || []),
                {
                  days: values.availableDays?.length
                    ? values.availableDays
                    : [1, 2, 3, 4, 5],
                  startMin: 1080,
                  endMin: 1200,
                },
              ])
            }
          >
            <Plus size={17} strokeWidth={1.5} />
            Add window
          </Button>
        </div>
        <p className="caption">
          Leave this empty to use any free time on your practice days.
        </p>
        {values.windows?.map((window, index) => (
          <div className="window-editor" key={index}>
            <div className="row between">
              <p className="caption">Window {index + 1}</p>
              <IconButton
                label={`Remove time window ${index + 1}`}
                onClick={() =>
                  form.setValue(
                    "windows",
                    values.windows?.filter(
                      (_, position) => position !== index,
                    ) || [],
                  )
                }
              >
                <X size={17} strokeWidth={1.5} />
              </IconButton>
            </div>
            <div className="grid-2 form-grid">
              <Field id={`window-start-${index}`} label="Start">
                <input
                  className="input"
                  id={`window-start-${index}`}
                  type="time"
                  value={minuteTime(window.startMin)}
                  onChange={(event) =>
                    form.setValue(
                      `windows.${index}.startMin`,
                      timeMinute(event.target.value),
                    )
                  }
                />
              </Field>
              <Field id={`window-end-${index}`} label="End">
                <input
                  className="input"
                  id={`window-end-${index}`}
                  type="time"
                  value={minuteTime(window.endMin)}
                  onChange={(event) =>
                    form.setValue(
                      `windows.${index}.endMin`,
                      timeMinute(event.target.value),
                    )
                  }
                />
              </Field>
            </div>
            <fieldset className="weekday-options">
              <legend className="sr-only">Window {index + 1} days</legend>
              {weekdays.map((day) => (
                <label key={day.value}>
                  <input
                    type="checkbox"
                    checked={window.days.includes(day.value)}
                    onChange={(event) =>
                      form.setValue(
                        `windows.${index}.days`,
                        event.target.checked
                          ? [...window.days, day.value].sort((a, b) => a - b)
                          : window.days.filter((value) => value !== day.value),
                      )
                    }
                  />
                  <span>{day.label}</span>
                </label>
              ))}
            </fieldset>
            {form.formState.errors.windows?.[index] && (
              <p className="field-error">
                Choose at least one day and an end time after the start.
              </p>
            )}
          </div>
        ))}
      </div>
      {data.user.settings.usePriority && (
        <div className="grid-2 form-grid">
          <Field id="skill-priority-mode" label="Priority scheduling">
            <select
              className="input"
              id="skill-priority-mode"
              {...form.register("usePriority")}
            >
              <option value="inherit">Use global setting</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </Field>
          <Field id="skill-priority" label="Priority (1–5)">
            <input
              className="input"
              id="skill-priority"
              type="number"
              min="1"
              max="5"
              value={values.priority || ""}
              onChange={(event) =>
                form.setValue(
                  "priority",
                  event.target.value ? Number(event.target.value) : null,
                )
              }
            />
          </Field>
        </div>
      )}
      {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}
      {!online && (
        <Banner>
          Reconnect to save this skill. Your changes stay in this form.
        </Banner>
      )}
      <Button
        variant="primary"
        type="submit"
        loading={save.isPending}
        disabled={!online}
      >
        {skill ? "Save skill" : "Add skill"}
      </Button>
    </form>
  );
}
