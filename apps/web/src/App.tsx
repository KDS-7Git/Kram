import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
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
  ChartNoAxesColumn,
  CalendarCheck,
  ChevronRight,
  Search,
  type LucideIcon,
} from "lucide-react";
import { LayoutGroup, m } from "framer-motion";
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
  Shortcut,
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
const Channels = lazy(() => import('./features/streaks/Channels').then(m => ({ default:m.ChannelSettings })));
const Streaks = lazy(() => import('./features/streaks/Streaks').then(m => ({ default:m.Streaks })));
const Analytics = lazy(() => import('./features/analytics/Analytics').then(m => ({ default:m.Analytics })));
const DataRecovery = lazy(() => import('./features/data/DataRecovery').then(m => ({ default:m.DataRecovery })));
const OfflineStatus = lazy(() => import('./features/data/OfflineStatus').then(m => ({ default:m.OfflineStatus })));
const Planning = lazy(() => import('./features/planning/Planning').then(m => ({ default: m.Planning })));
const Review = lazy(() => import('./features/planning/Review').then(m => ({ default: m.Review })));
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
import { FeatureGate } from "./shared/features";
import { useAppearance } from "./shared/theme";
import { offline, listQueued, subscribeOffline, replayProgress, registerOfflineShell } from "./shared/offline";
import { api, ApiIssue, errorMessage, type AuthMe } from "./shared/api";
import { DataProvider, useBootstrap, useOnline } from "./shared/data";
import { UIProvider, useUI } from "./shared/ui";
import { spring, useMotionPreference } from "./shared/motion";

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

function NavigationLink({ to, label, icon: Icon, shortcut }: { to: string; label: string; icon: LucideIcon; shortcut?: string[] }) {
  const reduced = useMotionPreference();
  return <NavLink to={to} end={to === "/"} className="nav-link">
    {({ isActive }) => <>
      {isActive && <m.span className="nav-active-pill" layoutId="navigation" layout={!reduced} transition={reduced ? { duration: 0 } : spring} aria-hidden="true" />}
      <Icon size={20} strokeWidth={1.65} aria-hidden="true" />
      <span>{label}</span>
      {shortcut && <Shortcut keys={shortcut} className="nav-shortcut" />}
    </>}
  </NavLink>;
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
  const { resolvedTheme, setAppearance } = useAppearance();
  const { pathname } = useLocation();
  const destination = pathname === "/" ? "Today" : pathname.startsWith("/plan") ? "Plan" : pathname.startsWith("/goals") ? "Goals" : pathname.startsWith("/progress") || pathname.startsWith("/streaks") ? "Progress" : pathname.startsWith("/tasks") ? "Task" : pathname.startsWith("/resources") ? "Resources" : pathname.startsWith("/review") ? "Review" : pathname.startsWith("/settings") ? "Settings" : pathname.startsWith("/notifications") || pathname.startsWith("/channels") ? "Notifications" : pathname.startsWith("/data") ? "Data & recovery" : "Design workshop";
  const online = useOnline();
  const navigate = useNavigate();
  const client = useQueryClient();
  const pending = useIsMutating();
  const [queued,setQueued]=useState(0),[cachedPage,setCachedPage]=useState(false);
  useEffect(()=>{let active=true;const read=()=>{void listQueued().then(rows=>{if(active)setQueued(rows.length);}).catch(()=>undefined);};read();const off=subscribeOffline(read);const cached=(event:Event)=>setCachedPage(Boolean((event as CustomEvent).detail.cached));window.addEventListener('kram-cache-status',cached);return()=>{active=false;off();window.removeEventListener('kram-cache-status',cached);};},[]);
  useEffect(()=>{
    if(!user||!online||pending>0||queued===0)return;
    let stopped=false;
    void (async()=>{
      const auth=await api<AuthMe>('/auth/me');
      if(!auth.user||auth.user.id!==user.id||stopped)return;
      const result=await replayProgress((taskId,input,accountId)=>{
        if(stopped||offline.currentAccount()!==accountId||accountId!==auth.user!.id)throw new ApiIssue('Sign in again before syncing.','UNAUTHENTICATED',undefined,401);
        return api(`/tasks/${taskId}/events`,{method:'POST',body:input,skipOfflineQueue:true});
      });
      if(result.sent&&!stopped)await client.invalidateQueries({predicate:q=>q.queryKey[0]!=='auth'});
    })().catch(()=>undefined);
    return()=>{stopped=true;};
  },[online,user?.id,client,queued,pending]);
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
        ...(user?.settings.featurePreset === "simple" ? [] : [{ to: "/plan", label: "Plan", icon: CalendarClock }]),
        { to: "/goals", label: "Goals", icon: Target },
        ...(user?.settings.featurePreset === "simple" ? [] : [{ to: "/progress", label: "Progress", icon: ChartNoAxesColumn }]),
      ];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <LayoutGroup id="sidebar-navigation"><aside className="sidebar">
        <NavLink to="/" className="wordmark">
          <span className="brand-mark"><BookOpen size={18} strokeWidth={1.65} /></span>
          <span>Kram</span>
        </NavLink>
        {user && (
          <Button
            className="sidebar-command"
            shortcut={["Mod", "K"]}
            onClick={() => window.dispatchEvent(new Event("kram-command"))}
          >
            <Search size={18} strokeWidth={1.5} />
            <span>Add or search</span>
          </Button>
        )}
        <nav className="nav-list" aria-label="Main navigation">
          {links.map((link) => (
            <NavigationLink
              key={link.to}
              to={link.to}
              label={link.label}
              icon={link.icon}
              shortcut={link.to === "/" ? ["G", "T"] : link.to === "/plan" ? ["G", "P"] : link.to === "/goals" ? ["G", "G"] : undefined}
            />
          ))}
        </nav>
        {user && user.settings.featurePreset!=="simple" && <NavigationLink to="/review" label="Review" icon={CalendarCheck} />}
        <div className="sidebar-footer">
          {user && (
            <>
              <NavigationLink to="/settings" label="Settings" icon={Settings2} />
              <NavigationLink to="/notifications" label="Notifications" icon={Bell} />
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
            {resolvedTheme === "dark" ? (
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
      </aside></LayoutGroup>
      <div className="app-body">
        <header className="topbar">
          <div className="topbar-location" aria-label="Current workspace">
            <span className="topbar-workspace">Your workspace</span><ChevronRight size={12} aria-hidden="true" /><span>{workshop ? "Design workshop" : destination}</span>
          </div>
          <div className="topbar-actions">
          <span className="topbar-title">
            {user ? (
              <span className="sync-label" data-pending={!online || pending > 0 || queued > 0}>
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
                {!online ? "Offline" : queued ? "Waiting to sync" : cachedPage ? "Saved copy" : pending ? "Syncing" : "Saved"}
              </span>
            ) : (
              null
            )}
          </span>
            <IconButton
              label="Toggle light and dark theme"
              onClick={toggleTheme}
            >
              {resolvedTheme === "dark" ? (
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
                      <DropdownMenu.Item asChild><NavLink to="/data" className="dropdown-item">Backup and export</NavLink></DropdownMenu.Item>
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
          {!online && !user && (
            <div style={{ marginBottom: "1.25rem" }}>
              <Banner>
                You are offline. Progress saves on this device. Reconnect for planning or settings changes.
              </Banner>
            </div>
          )}
          {user && <Suspense fallback={null}><OfflineStatus compact/></Suspense>}
          {children}
        </main>
      </div>
      <LayoutGroup id="mobile-navigation"><nav
        className={user ? `mobile-nav mobile-nav-owner${user.settings.featurePreset==='simple'?' mobile-nav-simple':''}` : "mobile-nav"}
        aria-label="Mobile navigation"
      >
        {links.map((link) => (
          <NavigationLink
            key={link.to}
            to={link.to}
            icon={link.icon}
            label={workshop && link.to === "/workshop" ? "Workshop" : link.label}
          />
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
      </nav></LayoutGroup>
    </div>
  );
}

function RouteContent({ children }: { children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const { hash } = useLocation();
  useEffect(() => {
    let target: HTMLElement | null = null;
    try { target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null; } catch { /* A malformed fragment falls back to the screen heading. */ }
    if (target) {
      target.scrollIntoView({ block: "start", behavior: "instant" });
      const focus = target.matches("input,button,a,[tabindex]") ? target : target.querySelector<HTMLElement>("input,button,a,[tabindex]");
      focus?.focus({ preventScroll: true });
      return;
    }
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    const heading = content.current?.querySelector<HTMLElement>("h1");
    (heading || document.getElementById("main-content"))?.focus({ preventScroll: true });
  }, [hash]);
  return <div className="route-content" ref={content}>{children}</div>;
}

function SignedIn({ user }: { user: User }) {
  const { pathname } = useLocation();
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
        <RouteContent key={pathname}>
          <Routes>
            <Route path="/" element={<Today />} />
            <Route path="/tasks/:taskId" element={<TaskPage />} />
            <Route path="/plan" element={<FeatureGate><Timetable /></FeatureGate>} />
            <Route path="/planning" element={<FeatureGate><Planning /></FeatureGate>} />
            <Route path="/progress" element={<FeatureGate><Analytics /></FeatureGate>} />
            <Route path="/progress/streaks" element={<FeatureGate level="full"><Streaks /></FeatureGate>} />
            <Route path="/streaks" element={<Navigate to="/progress/streaks" replace />} />
            <Route path="/channels" element={<FeatureGate level="full"><PageHeader title="Reminders where you need them" eyebrow="Notifications"/><Channels/></FeatureGate>} />
            <Route path="/data" element={<DataRecovery />} />
            <Route path="/review" element={<FeatureGate><Review /></FeatureGate>} />
            <Route path="/schedules" element={<FeatureGate><Schedules /></FeatureGate>} />
            <Route path="/notifications" element={<NotificationCenter />} />
            <Route path="/goals/*" element={<Hierarchy />} />
            <Route path="/goals/:goalId" element={<GoalDetail />} />
            <Route path="/resources" element={<ResourceLibrary />} />
            <Route path="/resources/:resourceId" element={<ResourceDetail />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Today />} />
          </Routes>
        </RouteContent>
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
  useEffect(()=>{void registerOfflineShell().catch(()=>undefined);},[]);
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
                <div className="route-content"><Workshop /></div>
              </Shell>
            }
          />
          <Route path="*" element={<AuthBoundary />} />
        </Routes>
      </Suspense>
    </UIProvider>
  );
}
