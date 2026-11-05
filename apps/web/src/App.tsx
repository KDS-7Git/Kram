import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import {
  BookOpen,
  CalendarDays,
  Check,
  CircleUserRound,
  LogOut,
  Moon,
  Settings2,
  Sun,
  SwatchBook,
  Target,
  WifiOff,
  CircleDashed,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { User } from "@kram/shared";
import {
  Banner,
  Button,
  Card,
  IconButton,
  PageHeader,
  Skeleton,
} from "./components/ui/kit";
const Workshop = lazy(() =>
  import("./components/Workshop").then((module) => ({
    default: module.Workshop,
  })),
);
const AuthScreen = lazy(() =>
  import("./features/auth/Auth").then((module) => ({
    default: module.AuthScreen,
  })),
);
const Hierarchy = lazy(() =>
  import("./features/goals/Hierarchy").then((module) => ({
    default: module.Hierarchy,
  })),
);
const SettingsPage = lazy(() =>
  import("./features/settings/Settings").then((module) => ({
    default: module.SettingsPage,
  })),
);
import { useAppearance } from "./shared/theme";
import { api, errorMessage, type AuthMe } from "./shared/api";
import { DataProvider, useBootstrap, useData, useOnline } from "./shared/data";
import { UIProvider, useUI } from "./shared/ui";

function DelayedLoading() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return visible ? (
    <div className="stack">
      <Skeleton height={80} />
      <Skeleton height={160} />
    </div>
  ) : (
    <span className="sr-only" role="status">
      Loading your planner
    </span>
  );
}

function WelcomePage() {
  const data = useData();
  const profiles = data.profiles.filter((profile) => !profile.archivedAt);
  const skills = data.skills.filter((skill) => !skill.archivedAt);
  return (
    <>
      <PageHeader
        title="A little room to focus"
        eyebrow="Today"
        description="Give your goals a place, then take the next small step."
      />
      <div className="stack-lg">
        <Card>
          <div className="card-header">
            <h2>Your planner, your pace</h2>
            <CalendarDays size={22} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <p className="muted">
            {profiles.length
              ? `${profiles.length} ${profiles.length === 1 ? "profile" : "profiles"} and ${skills.length} ${skills.length === 1 ? "skill" : "skills"} are ready for your goals.`
              : "Start with a profile for a part of your life you want to give time to."}
          </p>
          <div style={{ marginTop: "1.25rem" }}>
            <NavLink className="button button-primary" to="/goals">
              <Target size={18} strokeWidth={1.5} />
              Manage profiles and skills
            </NavLink>
          </div>
        </Card>
        <div className="grid-2">
          <Card>
            <h2>Your study day</h2>
            <p className="muted" style={{ marginTop: ".75rem" }}>
              Timezone: {data.user.settings.timezone}
            </p>
            <p className="caption" style={{ marginTop: ".75rem" }}>
              Late-night progress follows your configured day rollover.
            </p>
            <NavLink className="button button-text" to="/settings">
              Adjust day and time
            </NavLink>
          </Card>
          <Card>
            <h2>A quiet workspace</h2>
            <p className="muted" style={{ marginTop: ".75rem" }}>
              Light, dark and scheduled themes. Comfortable spacing, with room
              to focus.
            </p>
            <NavLink className="button button-text" to="/workshop">
              Explore Paper and Ink
            </NavLink>
          </Card>
        </div>
      </div>
    </>
  );
}

function Shell({
  children,
  user,
  workshop = false,
}: {
  children: ReactNode;
  user?: User;
  workshop?: boolean;
}) {
  const { appearance, setAppearance } = useAppearance();
  const online = useOnline();
  const navigate = useNavigate();
  const client = useQueryClient();
  const pending = useIsMutating();
  const { toast } = useUI();
  const toggleTheme = () =>
    setAppearance({
      theme:
        document.documentElement.dataset.theme === "dark" ? "light" : "dark",
    });
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSuccess: async () => {
      client.removeQueries({ queryKey: ["bootstrap"] });
      await client.invalidateQueries({ queryKey: ["auth"] });
      navigate("/");
    },
    onError: (error) => toast(errorMessage(error)),
  });
  const links = workshop
    ? [
        { to: "/", label: "Today", icon: CalendarDays },
        { to: "/workshop", label: "Design workshop", icon: SwatchBook },
      ]
    : [
        { to: "/", label: "Today", icon: CalendarDays },
        { to: "/goals", label: "Goals", icon: Target },
      ];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <NavLink to="/" className="wordmark">
          <BookOpen size={24} strokeWidth={1.5} />
          <span>Kram</span>
        </NavLink>
        <nav className="nav-list" aria-label="Main navigation">
          {links.map((link) => (
            <NavLink
              key={link.to}
              end={link.to === "/"}
              to={link.to}
              className="nav-link"
            >
              <link.icon size={20} strokeWidth={1.5} />
              <span>{link.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          {user && (
            <>
              <NavLink className="nav-link" to="/settings">
                <Settings2 size={20} strokeWidth={1.5} />
                <span>Settings</span>
              </NavLink>
              <Button
                variant="text"
                onClick={() => logout.mutate()}
                disabled={!online || logout.isPending}
              >
                <LogOut size={20} strokeWidth={1.5} />
                <span>Sign out</span>
              </Button>
            </>
          )}
          <Button variant="text" onClick={toggleTheme}>
            {appearance.theme === "dark" ? (
              <Sun size={20} strokeWidth={1.5} />
            ) : (
              <Moon size={20} strokeWidth={1.5} />
            )}
            <span>Change theme</span>
          </Button>
          <p className="sidebar-note">
            Private by design.
            <br />A little progress, every day.
          </p>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <span className="topbar-title">
            {user ? (
              <span className="sync-label">
                {!online ? (
                  <WifiOff size={14} strokeWidth={1.5} aria-hidden="true" />
                ) : pending ? (
                  <CircleDashed
                    size={14}
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                ) : (
                  <Check size={14} strokeWidth={1.5} aria-hidden="true" />
                )}
                {!online ? "Offline" : pending ? "Syncing" : "Saved"}
              </span>
            ) : (
              "A planner of your own"
            )}
          </span>
          <div className="topbar-actions">
            <IconButton
              label="Toggle light and dark theme"
              onClick={toggleTheme}
            >
              {appearance.theme === "dark" ? (
                <Sun size={20} strokeWidth={1.5} />
              ) : (
                <Moon size={20} strokeWidth={1.5} />
              )}
            </IconButton>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <IconButton label="Owner account">
                  <CircleUserRound size={22} strokeWidth={1.5} />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="dropdown-menu"
                  sideOffset={8}
                  align="end"
                >
                  {user ? (
                    <>
                      <DropdownMenu.Label className="dropdown-label">
                        {user.email}
                      </DropdownMenu.Label>
                      <DropdownMenu.Separator className="dropdown-separator" />
                      <DropdownMenu.Item asChild>
                        <NavLink to="/settings" className="dropdown-item">
                          <Settings2 size={18} strokeWidth={1.5} />
                          Settings
                        </NavLink>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className="dropdown-item"
                        disabled={!online || logout.isPending}
                        onSelect={() => logout.mutate()}
                      >
                        <LogOut size={18} strokeWidth={1.5} />
                        Sign out
                      </DropdownMenu.Item>
                    </>
                  ) : (
                    <DropdownMenu.Item asChild>
                      <NavLink to="/" className="dropdown-item">
                        Sign in to Kram
                      </NavLink>
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>
        <main className="main-content" id="main-content" tabIndex={-1}>
          {!online && (
            <div style={{ marginBottom: "1.25rem" }}>
              <Banner>
                You are offline. Reconnect to change profiles, skills or
                settings.
              </Banner>
            </div>
          )}
          {children}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {links.map((link) => (
          <NavLink
            key={link.to}
            end={link.to === "/"}
            to={link.to}
            className="nav-link"
          >
            <link.icon size={20} strokeWidth={1.5} />
            <span>
              {workshop && link.to === "/workshop" ? "Workshop" : link.label}
            </span>
          </NavLink>
        ))}
        {user && (
          <NavLink className="nav-link" to="/settings">
            <Settings2 size={20} strokeWidth={1.5} />
            <span>Settings</span>
          </NavLink>
        )}
      </nav>
    </div>
  );
}

function SignedIn({ user }: { user: User }) {
  const bootstrap = useBootstrap();
  const client = useQueryClient();
  useEffect(() => {
    if (
      bootstrap.error &&
      "code" in bootstrap.error &&
      bootstrap.error.code === "UNAUTHENTICATED"
    )
      void client.invalidateQueries({ queryKey: ["auth"] });
  }, [bootstrap.error, client]);
  useEffect(() => {
    if (!localStorage.getItem("kram-appearance")) {
      localStorage.setItem(
        "kram-appearance",
        JSON.stringify({
          theme: user.settings.theme,
          motion: user.settings.motion,
          density: user.settings.density,
          wakeMin: user.settings.wakingMin,
          sleepMin: user.settings.sleepingMin,
        }),
      );
      window.dispatchEvent(new Event("kram-appearance-changed"));
    }
  }, [user]);
  if (!bootstrap.data)
    return (
      <Shell user={user}>
        {bootstrap.isPending ? (
          <DelayedLoading />
        ) : (
          <Card>
            <PageHeader
              title="Your planner could not load"
              description={errorMessage(bootstrap.error)}
            />
            <Button onClick={() => bootstrap.refetch()}>Retry</Button>
          </Card>
        )}
      </Shell>
    );
  return (
    <DataProvider value={bootstrap.data}>
      <Shell user={bootstrap.data.user}>
        {bootstrap.isError && (
          <div style={{ marginBottom: "1.25rem" }}>
            <Banner>
              Could not refresh. Showing the last loaded planner.
              <Button variant="text" onClick={() => bootstrap.refetch()}>
                Retry
              </Button>
            </Banner>
          </div>
        )}
        <Routes>
          <Route path="/" element={<WelcomePage />} />
          <Route path="/goals/*" element={<Hierarchy />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<WelcomePage />} />
        </Routes>
      </Shell>
    </DataProvider>
  );
}

function AuthBoundary() {
  const auth = useQuery({
    queryKey: ["auth"],
    queryFn: () => api<AuthMe>("/auth/me"),
    retry: 1,
  });
  if (auth.isPending)
    return (
      <div className="auth-loading">
        <DelayedLoading />
      </div>
    );
  if (auth.isError)
    return (
      <div className="auth-loading">
        <Card>
          <PageHeader
            title="Could not reach Kram"
            description="Check that this instance is running, then retry."
          />
          <Banner tone="error">{errorMessage(auth.error)}</Banner>
          <Button onClick={() => auth.refetch()} style={{ marginTop: "1rem" }}>
            Retry connection
          </Button>
        </Card>
      </div>
    );
  return auth.data.user ? (
    <SignedIn user={auth.data.user} />
  ) : (
    <AuthScreen auth={auth.data} />
  );
}

export function App() {
  return (
    <UIProvider>
      <Suspense
        fallback={
          <div className="auth-loading">
            <DelayedLoading />
          </div>
        }
      >
        <Routes>
          <Route
            path="/workshop"
            element={
              <Shell workshop>
                <Workshop />
              </Shell>
            }
          />
          <Route path="*" element={<AuthBoundary />} />
        </Routes>
      </Suspense>
    </UIProvider>
  );
}
