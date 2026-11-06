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
  Bell,
  CalendarClock,
  Plus,
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
const GoalDetail = lazy(() =>
  import("./features/goals/Goals").then((module) => ({
    default: module.GoalDetail,
  })),
);
const ResourceLibrary = lazy(() =>
  import("./features/resources/Resources").then((module) => ({
    default: module.ResourceLibrary,
  })),
);
const ResourceDetail = lazy(() =>
  import("./features/resources/Resources").then((module) => ({
    default: module.ResourceDetail,
  })),
);
const Today = lazy(() =>
  import("./features/today/Today").then((module) => ({
    default: module.Today,
  })),
);
const TaskPage = lazy(() =>
  import("./features/tasks/Tasks").then((module) => ({
    default: module.TaskPage,
  })),
);
const Timetable = lazy(() =>
  import("./features/timetable/Timetable").then((module) => ({
    default: module.Timetable,
  })),
);
const Schedules = lazy(() => import('./features/timetable/Schedules').then(module => ({ default: module.Schedules })));
const NotificationCenter = lazy(() =>
  import("./features/tasks/reminders").then((module) => ({
    default: module.NotificationCenter,
  })),
);
const CommandPalette = lazy(() =>
  import("./components/CommandPalette").then((module) => ({
    default: module.CommandPalette,
  })),
);
import { useAppearance } from "./shared/theme";
import { api, errorMessage, type AuthMe } from "./shared/api";
import { DataProvider, useBootstrap, useOnline } from "./shared/data";
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
      client.removeQueries({
        predicate: (query) => query.queryKey[0] !== "auth",
      });
      await client.invalidateQueries({ queryKey: ["auth"] });
      navigate("/");
    },
    onError: (error) => toast(errorMessage(error), undefined, "error"),
  });
  const links = workshop
    ? [
        { to: "/", label: "Today", icon: CalendarDays },
        { to: "/workshop", label: "Design workshop", icon: SwatchBook },
      ]
    : [
        { to: "/", label: "Today", icon: CalendarDays },
        { to: "/plan", label: "Plan", icon: CalendarClock },
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
        {user && (
          <Button
            onClick={() => window.dispatchEvent(new Event("kram-command"))}
          >
            <Plus size={18} strokeWidth={1.5} />
            <span>Add or search</span>
          </Button>
        )}
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
              <NavLink className="nav-link" to="/notifications">
                <Bell size={20} strokeWidth={1.5} />
                <span>Notifications</span>
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
                        <NavLink to="/notifications" className="dropdown-item">
                          <Bell size={18} strokeWidth={1.5} />
                          Notifications
                        </NavLink>
                      </DropdownMenu.Item>
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
                You are offline. Reconnect to save planning or settings changes.
              </Banner>
            </div>
          )}
          {children}
        </main>
      </div>
      <nav
        className={user ? "mobile-nav mobile-nav-owner" : "mobile-nav"}
        aria-label="Mobile navigation"
      >
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
          <button
            type="button"
            className="mobile-add"
            aria-label="Add or search"
            onClick={() => window.dispatchEvent(new Event("kram-command"))}
          >
            <Plus size={24} strokeWidth={1.5} />
          </button>
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
        <Suspense fallback={<DelayedLoading />}>
          <Routes>
            <Route path="/" element={<Today />} />
            <Route path="/tasks/:taskId" element={<TaskPage />} />
            <Route path="/plan" element={<Timetable />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/notifications" element={<NotificationCenter />} />
            <Route path="/goals/*" element={<Hierarchy />} />
            <Route path="/goals/:goalId" element={<GoalDetail />} />
            <Route path="/resources" element={<ResourceLibrary />} />
            <Route path="/resources/:resourceId" element={<ResourceDetail />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Today />} />
          </Routes>
        </Suspense>
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
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
