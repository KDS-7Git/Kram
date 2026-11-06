import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { loginSchema, setupSchema } from "@kram/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  LockKeyhole,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { api, errorMessage, type AuthMe } from "../../shared/api";
import { minuteTime, timeMinute } from "../../shared/format";
import { Banner, Button, Field } from "../../components/ui/kit";

type SetupForm = z.input<typeof setupSchema>;
const steps = [
  "Your account",
  "Your study day",
  "Room in your day",
  "Your first profile",
  "Make it your own",
];

export function AuthScreen({ auth }: { auth: AuthMe }) {
  return (
    <div className="auth-layout">
      <a className="skip-link" href="#auth-main">
        Skip to content
      </a>
      <aside className="auth-intro">
        <NavLink className="wordmark" to="/">
          <BookOpen size={28} strokeWidth={1.5} />
          <span>Kram</span>
        </NavLink>
        <div>
          <p className="eyebrow">A planner of your own</p>
          <h1>
            Make room
            <br />
            for what matters.
          </h1>
          <p className="muted">
            A clear day, steady progress, and a plan that can change with you.
          </p>
        </div>
        <p className="caption">Your own installation. Your own data.</p>
      </aside>
      <main id="auth-main" className="auth-main" tabIndex={-1}>
        {auth.setupRequired ? (
          auth.setupAllowed ? (
            <Setup auth={auth} />
          ) : (
            <div className="stack-lg">
              <p className="eyebrow">First run</p>
              <h1>Set up the owner account</h1>
              <Banner>
                This installation is waiting for its owner account. Use the
                administrator setup command from the deployment guide, then sign
                in here.
              </Banner>
              <p className="muted">
                Public registration is disabled. Each Kram installation has one
                owner.
              </p>
              <NavLink to="/workshop">Explore Paper and Ink</NavLink>
            </div>
          )
        ) : (
          <Login />
        )}
      </main>
    </div>
  );
}

function Login() {
  const client = useQueryClient();
  const form = useForm<
    z.input<typeof loginSchema>,
    unknown,
    z.output<typeof loginSchema>
  >({ resolver: zodResolver(loginSchema) });
  const login = useMutation({
    mutationFn: (values: z.output<typeof loginSchema>) =>
      api("/auth/login", { method: "POST", body: values }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["auth"] });
    },
  });
  return (
    <div className="stack-lg">
      <div>
        <p className="eyebrow">Welcome back</p>
        <h1>A little room to focus.</h1>
        <p className="muted" style={{ marginTop: ".75rem" }}>
          Sign in to your Kram instance.
        </p>
      </div>
      <form
        className="stack"
        onSubmit={form.handleSubmit((values) => login.mutate(values))}
        noValidate
      >
        <Field
          id="login-email"
          label="Email"
          error={form.formState.errors.email?.message}
        >
          <input
            id="login-email"
            className="input"
            type="email"
            autoComplete="username"
            {...form.register("email")}
            aria-invalid={!!form.formState.errors.email}
            aria-describedby={
              form.formState.errors.email ? "login-email-error" : undefined
            }
          />
        </Field>
        <Field
          id="login-password"
          label="Password"
          error={form.formState.errors.password?.message}
        >
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            {...form.register("password")}
            aria-invalid={!!form.formState.errors.password}
            aria-describedby={
              form.formState.errors.password
                ? "login-password-error"
                : undefined
            }
          />
        </Field>
        {login.isError && (
          <Banner tone="error">{errorMessage(login.error)}</Banner>
        )}
        <Button variant="primary" type="submit" loading={login.isPending}>
          <LockKeyhole size={18} strokeWidth={1.5} />
          Sign in
        </Button>
      </form>
      <p className="caption">For the owner of this installation.</p>
    </div>
  );
}

function Setup({ auth }: { auth: AuthMe }) {
  const [step, setStep] = useState(0);
  const client = useQueryClient();
  const form = useForm<SetupForm, unknown, z.output<typeof setupSchema>>({
    resolver: zodResolver(setupSchema),
    defaultValues: {
      timezone: auth.defaults.timezone,
      dayRollover: auth.defaults.dayRollover,
      wakingMin: auth.defaults.wakingMin,
      sleepingMin: auth.defaults.sleepingMin,
      featurePreset: "planner",
      profileName: "Learning",
      demo: false,
    },
  });
  const setup = useMutation({
    mutationFn: (values: z.output<typeof setupSchema>) =>
      api("/auth/setup", { method: "POST", body: values }),
    onSuccess: async (_result,values) => {
      if(values.demo)await api("/demo/load",{method:"POST",body:{}});
      await client.invalidateQueries({ queryKey: ["auth"] });
    },
  });
  const values = form.watch();
  const next = async () => {
    const fields: (keyof SetupForm)[][] = [
      ["email", "password", "setupToken"],
      ["timezone", "dayRollover"],
      ["wakingMin", "sleepingMin"],
      ["profileName"],
      ["featurePreset"],
    ];
    if (await form.trigger(fields[step])) {
      if (step === 2 && (values.sleepingMin ?? 0) <= (values.wakingMin ?? 0)) {
        form.setError("sleepingMin", {
          message: "Choose a sleeping time after waking time.",
        });
        return;
      }
      setStep((value) => value + 1);
    }
  };
  return (
    <div className="stack-lg">
      <div>
        <p className="eyebrow">Step {step + 1} of 5</p>
        <h1>{steps[step]}</h1>
        <p className="muted" style={{ marginTop: ".75rem" }}>
          Start small. You can change these choices in Settings.
        </p>
      </div>
      <div className="onboarding-progress" aria-label={`Step ${step + 1} of 5`}>
        {steps.map((title, index) => (
          <span key={title} className={index <= step ? "current" : ""} />
        ))}
      </div>
      <form
        className="stack-lg"
        onSubmit={(event) => {
          if (step < 4) {
            event.preventDefault();
            void next();
          } else
            void form.handleSubmit((result) => setup.mutate(result))(event);
        }}
        noValidate
      >
        {step === 0 && (
          <div className="stack">
            <Field
              id="setup-email"
              label="Email"
              error={form.formState.errors.email?.message}
            >
              <input
                className="input"
                id="setup-email"
                type="email"
                autoComplete="username"
                {...form.register("email")}
                aria-invalid={!!form.formState.errors.email}
                aria-describedby={
                  form.formState.errors.email ? "setup-email-error" : undefined
                }
              />
            </Field>
            <Field
              id="setup-password"
              label="Password"
              hint="Use at least 12 characters. A long passphrase works well."
              error={form.formState.errors.password?.message}
            >
              <input
                className="input"
                id="setup-password"
                type="password"
                autoComplete="new-password"
                {...form.register("password")}
                aria-invalid={!!form.formState.errors.password}
                aria-describedby={
                  form.formState.errors.password
                    ? "setup-password-error"
                    : "setup-password-hint"
                }
              />
            </Field>
            {auth.setupTokenRequired && (
              <Field
                id="setup-token"
                label="One-time setup token"
                hint="The token supplied when this instance was deployed."
                error={form.formState.errors.setupToken?.message}
              >
                <input
                  className="input"
                  id="setup-token"
                  type="password"
                  autoComplete="off"
                  {...form.register("setupToken")}
                />
              </Field>
            )}
          </div>
        )}
        {step === 1 && (
          <div className="stack">
            <Field
              id="setup-timezone"
              label="Timezone"
              error={form.formState.errors.timezone?.message}
            >
              <input
                className="input"
                id="setup-timezone"
                list="timezone-list"
                {...form.register("timezone")}
                aria-invalid={!!form.formState.errors.timezone}
              />
              <datalist id="timezone-list">
                {Intl.supportedValuesOf("timeZone").map((zone) => (
                  <option value={zone} key={zone} />
                ))}
              </datalist>
            </Field>
            <Field
              id="setup-rollover"
              label="Study day ends at"
              hint="Work after midnight belongs to the previous day until this time."
            >
              <input
                id="setup-rollover"
                className="input"
                type="time"
                value={minuteTime(values.dayRollover ?? 240)}
                onChange={(event) =>
                  form.setValue("dayRollover", timeMinute(event.target.value))
                }
              />
            </Field>
          </div>
        )}
        {step === 2 && (
          <div className="stack">
            <Field id="setup-waking" label="Waking time">
              <input
                className="input"
                id="setup-waking"
                type="time"
                value={minuteTime(values.wakingMin ?? 420)}
                onChange={(event) =>
                  form.setValue("wakingMin", timeMinute(event.target.value))
                }
              />
            </Field>
            <Field
              id="setup-sleeping"
              label="Sleeping time"
              error={form.formState.errors.sleepingMin?.message}
              hint="The planner keeps your rest time clear."
            >
              <input
                className="input"
                id="setup-sleeping"
                type="time"
                value={minuteTime(values.sleepingMin ?? 1380)}
                onChange={(event) =>
                  form.setValue("sleepingMin", timeMinute(event.target.value))
                }
                aria-invalid={!!form.formState.errors.sleepingMin}
                aria-describedby={
                  form.formState.errors.sleepingMin
                    ? "setup-sleeping-error"
                    : "setup-sleeping-hint"
                }
              />
            </Field>
          </div>
        )}
        {step === 3 && (
          <div className="stack">
            <p className="muted">
              A profile groups a part of your life, such as Learning,
              Development or Wellbeing. Skills sit inside it.
            </p>
            <Field
              id="setup-profile"
              label="First profile name"
              error={form.formState.errors.profileName?.message}
            >
              <input
                className="input"
                id="setup-profile"
                {...form.register("profileName")}
                aria-invalid={!!form.formState.errors.profileName}
              />
            </Field>
          </div>
        )}
        {step === 4 && (
          <div className="stack">
            <fieldset className="preset-options">
              <legend className="sr-only">Feature preset</legend>
              {[
                {
                  value: "simple",
                  title: "Simple",
                  detail: "Goals, tasks, Today and reminders.",
                },
                {
                  value: "planner",
                  title: "Planner",
                  detail: "Adds a timetable, recurrence and reviews.",
                },
                {
                  value: "full",
                  title: "Full",
                  detail: "All planning, streak and analytics controls.",
                },
              ].map((preset) => (
                <label
                  className={
                    values.featurePreset === preset.value ? "selected" : ""
                  }
                  key={preset.value}
                >
                  <input
                    type="radio"
                    value={preset.value}
                    {...form.register("featurePreset")}
                  />
                  <span>
                    <strong>
                      {preset.title}
                      {preset.value === "planner" ? " · Recommended" : ""}
                    </strong>
                    <span className="muted">{preset.detail}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="caption">Hiding a feature never deletes its data.</p>
            <label className="toggle-label"><input type="checkbox" {...form.register("demo")}/>Load a labelled, removable sample week</label>
          </div>
        )}
        {setup.isError && (
          <Banner tone="error">{errorMessage(setup.error)}</Banner>
        )}
        <div className="row between">
          {step > 0 ? (
            <Button
              variant="text"
              onClick={() => setStep((value) => value - 1)}
            >
              <ArrowLeft size={18} strokeWidth={1.5} />
              Back
            </Button>
          ) : (
            <span />
          )}
          {step < 4 ? (
            <Button
              key={`continue-${step}`}
              variant="primary"
              type="button"
              onClick={(event) => {
                event.preventDefault();
                void next();
              }}
            >
              Continue
              <ArrowRight size={18} strokeWidth={1.5} />
            </Button>
          ) : (
            <Button
              key="finish-setup"
              variant="primary"
              type="submit"
              loading={setup.isPending}
            >
              <Check size={18} strokeWidth={1.5} />
              Create my planner
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
