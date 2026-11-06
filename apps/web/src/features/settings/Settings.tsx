import { OfflineStatus } from "../data/OfflineStatus";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { settingsSchema, type Settings } from "@kram/shared";
import { useMutation } from "@tanstack/react-query";
import { Check, Clock3, Moon, Palette } from "lucide-react";
import {
  Banner,
  Button,
  Card,
  Field,
  PageHeader,
  Segments,
} from "../../components/ui/kit";
import { api, errorMessage } from "../../shared/api";
import { useData, useOnline, useRefresh } from "../../shared/data";
import { useAppearance, type ThemeChoice } from "../../shared/theme";
import { minuteTime, timeMinute, weekdays } from "../../shared/format";
import { useUI } from "../../shared/ui";

export function SettingsPage() {
  const data = useData();
  const refresh = useRefresh();
  const online = useOnline();
  const { toast } = useUI();
  const { appearance, setAppearance } = useAppearance();
  const form = useForm<z.input<typeof settingsSchema>, unknown, Settings>({
    resolver: zodResolver(settingsSchema),
    defaultValues: data.user.settings,
  });
  const values = form.watch();
  const save = useMutation({
    mutationFn: (input: Settings) =>
      api<Settings>("/settings", { method: "PATCH", body: input }),
    onSuccess: async (input) => {
      setAppearance({ wakeMin: input.wakingMin, sleepMin: input.sleepingMin });
      await refresh();
      toast("Settings saved.");
      form.reset(input);
    },
  });
  const sample = useMutation({mutationFn:(remove:boolean)=>api(remove?'/demo/remove':'/demo/load',{method:'POST',body:{}}),onSuccess:async()=>{await refresh();toast('Sample week updated.');}});
  const appearanceChange = (patch: Partial<Settings>) => {
    if (patch.theme) setAppearance({ theme: patch.theme });
    if (patch.density) setAppearance({ density: patch.density });
    if (patch.motion) setAppearance({ motion: patch.motion });
    Object.entries(patch).forEach(([key, value]) =>
      form.setValue(key as keyof Settings, value as never, {
        shouldDirty: true,
      }),
    );
  };
  return (
    <>
      <PageHeader
        title="Make room your way"
        eyebrow="Settings"
        description="Choose how Kram looks and where your study day begins."
      />
      <OfflineStatus/>
      <form
        className="stack-lg"
        onSubmit={form.handleSubmit((input) => save.mutate(input))}
        noValidate
      >
        <Card>
          <div className="card-header">
            <h2>Appearance</h2>
            <Palette size={22} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div className="stack-lg">
            <div className="field">
              <label>Theme</label>
              <Segments<ThemeChoice>
                label="Appearance theme"
                value={appearance.theme}
                onChange={(theme) => appearanceChange({ theme })}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "scheduled", label: "Scheduled" },
                ]}
              />
              <p className="field-hint">
                Scheduled uses dark mode from one hour before sleep until waking
                time.
              </p>
            </div>
            <div className="grid-2">
              <Field id="settings-density" label="Desktop density">
                <select
                  className="input"
                  id="settings-density"
                  value={appearance.density}
                  onChange={(event) =>
                    appearanceChange({
                      density: event.target.value as Settings["density"],
                    })
                  }
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </Field>
              <Field id="settings-motion" label="Motion">
                <select
                  className="input"
                  id="settings-motion"
                  value={appearance.motion}
                  onChange={(event) =>
                    appearanceChange({
                      motion: event.target.value as Settings["motion"],
                    })
                  }
                >
                  <option value="system">Follow the device</option>
                  <option value="reduced">Reduced</option>
                  <option value="full">Full</option>
                </select>
              </Field>
            </div>
            <p className="caption">
              Theme is remembered on this device. Saving also sets the default
              for new devices.
            </p>
          </div>
        </Card>
        <Card>
          <div className="card-header">
            <h2>Day and time</h2>
            <Clock3 size={22} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div className="stack-lg">
            <Field
              id="settings-timezone"
              label="Timezone"
              error={form.formState.errors.timezone?.message}
            >
              <input
                className="input"
                id="settings-timezone"
                list="settings-zone-list"
                {...form.register("timezone")}
                aria-invalid={!!form.formState.errors.timezone}
              />
              <datalist id="settings-zone-list">
                {Intl.supportedValuesOf("timeZone").map((zone) => (
                  <option value={zone} key={zone} />
                ))}
              </datalist>
            </Field>
            <div className="grid-2">
              <Field
                id="settings-rollover"
                label="Study day ends at"
                hint="Late-night progress stays with the previous study day."
              >
                <input
                  className="input"
                  id="settings-rollover"
                  type="time"
                  value={minuteTime(values.dayRollover ?? 240)}
                  onChange={(event) =>
                    form.setValue(
                      "dayRollover",
                      timeMinute(event.target.value),
                      { shouldDirty: true },
                    )
                  }
                />
              </Field>
              <Field id="settings-week-start" label="Week starts on">
                <select
                  className="input"
                  id="settings-week-start"
                  value={values.weekStart}
                  onChange={(event) =>
                    form.setValue(
                      "weekStart",
                      Number(event.target.value) as 1 | 7,
                      { shouldDirty: true },
                    )
                  }
                >
                  <option value="1">Monday</option>
                  <option value="7">Sunday</option>
                </select>
              </Field>
            </div>
            <div className="grid-2">
              <Field id="settings-waking" label="Waking time">
                <input
                  className="input"
                  id="settings-waking"
                  type="time"
                  value={minuteTime(values.wakingMin ?? 420)}
                  onChange={(event) =>
                    form.setValue("wakingMin", timeMinute(event.target.value), {
                      shouldDirty: true,
                    })
                  }
                />
              </Field>
              <Field
                id="settings-sleeping"
                label="Sleeping time"
                error={form.formState.errors.sleepingMin?.message}
              >
                <input
                  className="input"
                  id="settings-sleeping"
                  type="time"
                  value={minuteTime(values.sleepingMin ?? 1380)}
                  onChange={(event) =>
                    form.setValue(
                      "sleepingMin",
                      timeMinute(event.target.value),
                      { shouldDirty: true },
                    )
                  }
                  aria-invalid={!!form.formState.errors.sleepingMin}
                />
              </Field>
            </div>
            <Field id="settings-clock" label="Clock format">
              <select
                className="input"
                id="settings-clock"
                {...form.register("clockFormat")}
              >
                <option value="24">24-hour</option>
                <option value="12">12-hour</option>
              </select>
            </Field>
            <fieldset className="weekday-options">
              <legend>Rest days</legend>
              {weekdays.map((day) => (
                <label key={day.value}>
                  <input
                    type="checkbox"
                    checked={values.restDays?.includes(day.value) || false}
                    onChange={(event) =>
                      form.setValue(
                        "restDays",
                        event.target.checked
                          ? [...(values.restDays || []), day.value].sort(
                              (a, b) => a - b,
                            )
                          : values.restDays?.filter(
                              (value) => value !== day.value,
                            ) || [],
                        { shouldDirty: true },
                      )
                    }
                  />
                  <span>{day.label}</span>
                </label>
              ))}
            </fieldset>
            <p className="caption">
              Configured rest days do not count as missed practice days.
            </p>
          </div>
        </Card>
        <Card id="features"><h2>Features</h2><div className="stack"><Field id="settings-features" label="Feature preset"><select id="settings-features" className="input" {...form.register('featurePreset')}><option value="simple">Simple · Today, goals, tasks and reminders</option><option value="planner">Planner · timetable, reviews and proposals</option><option value="full">Full · streak rules, calibration and channels</option></select></Field><p className="caption">Hiding a feature preserves its data. Save below to apply this preset.</p></div></Card>
        {data.user.settings.featurePreset!=='simple'&&<Card><h2>Planning</h2><div className="stack-lg">{data.user.settings.featurePreset==='full'&&<><Field id="settings-planning" label="Planning mode"><select id="settings-planning" className="input" {...form.register('planningMode')}><option value="directed">Directed · approve every change</option><option value="adaptive">Adaptive</option><option value="balanced">Balanced · steady practice</option><option value="deadline">Deadline · sooner work first</option></select></Field><p className="caption">Directed is the starting mode. All modes preserve dependencies, capacity and the approval window.</p><label className="toggle-label"><input type="checkbox" {...form.register('usePriority')}/>Use priority scores (off uses deadlines and your manual order)</label></>}<div className="grid-2"><Field id="settings-dailycap" label="Daily study limit (min)"><input id="settings-dailycap" className="input" type="number" min={15} max={960} {...form.register('maxDailyMin',{valueAsNumber:true})}/></Field><Field id="settings-weeklycap" label="Weekly study limit (min)"><input id="settings-weeklycap" className="input" type="number" min={15} max={6720} {...form.register('maxWeeklyMin',{valueAsNumber:true})}/></Field></div><Link className="button button-text" to="/planning">Proposals, history and breaks</Link></div></Card>}
        <Card>
          <div className="card-header">
            <h2>Quiet hours</h2>
            <Moon size={22} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div className="stack-lg">
            <p className="muted">
              Reminders wait until quiet hours end. Channels stay off until you
              configure them.
            </p>
            <div className="grid-2">
              <Field id="settings-quiet-start" label="Quiet from">
                <input
                  className="input"
                  id="settings-quiet-start"
                  type="time"
                  value={minuteTime(values.quietHours?.startMin ?? 1320)}
                  onChange={(event) =>
                    form.setValue(
                      "quietHours.startMin",
                      timeMinute(event.target.value),
                      { shouldDirty: true },
                    )
                  }
                />
              </Field>
              <Field id="settings-quiet-end" label="Quiet until">
                <input
                  className="input"
                  id="settings-quiet-end"
                  type="time"
                  value={minuteTime(values.quietHours?.endMin ?? 420)}
                  onChange={(event) =>
                    form.setValue(
                      "quietHours.endMin",
                      timeMinute(event.target.value),
                      { shouldDirty: true },
                    )
                  }
                />
              </Field>
            </div>
            <label className="toggle-label">
              <input
                type="checkbox"
                {...form.register("notificationsEnabled")}
              />
              Allow notifications
            </label>
            <Link className="button button-text" to="/notifications">
              Reminders and delivery history
            </Link>
            <label className="toggle-label">
              <input
                type="checkbox"
                {...form.register("notificationPrivacy")}
              />
              Use generic text on the lock screen
            </label>
            <div className="card-inset">
              <p className="eyebrow">Lock-screen preview</p>
              <p style={{ marginTop: ".5rem" }}>
                {values.notificationPrivacy
                  ? "Study session in 15 min"
                  : "Your activity title · in 15 min"}
              </p>
            </div>
          </div>
        </Card>
        <Card><h2>Explore a sample week</h2><p className="muted">Clearly labelled demo goals and time blocks help you try the planner. Removing the sample preserves recorded history and any real work you added.</p><div className="row wrap"><Button disabled={!online} loading={sample.isPending} onClick={()=>sample.mutate(false)}>Load sample week</Button><Button disabled={!online} loading={sample.isPending} onClick={()=>sample.mutate(true)}>Remove sample week</Button></div>{sample.isError&&<Banner tone="error">{errorMessage(sample.error)}</Banner>}</Card>
        <Link className="button" to="/data">Backup, health and export</Link>
        {save.isError && (
          <Banner tone="error">{errorMessage(save.error)}</Banner>
        )}
        <div className="row between">
          <p className="caption">
            {form.formState.isDirty
              ? "Changes are ready to save."
              : "Your settings are up to date."}
          </p>
          <Button
            variant="primary"
            type="submit"
            loading={save.isPending}
            disabled={!online}
          >
            <Check size={18} strokeWidth={1.5} />
            Save settings
          </Button>
        </div>
      </form>
    </>
  );
}
