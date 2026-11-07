import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Plus, Search, CalendarDays, Target, BookOpen, Settings2, Command, CircleCheck } from "lucide-react";
import { Button, EmptyState, Field, Sheet, Shortcut, Truncate } from "./ui/kit";
import { useData } from "../shared/data";
import { useAppearance } from "../shared/theme";

function matchScore(text: string, query: string) {
  if (!query) return 0;
  let position = -1;
  let score = 0;
  for (const letter of query.toLocaleLowerCase()) {
    const next = text.toLocaleLowerCase().indexOf(letter, position + 1);
    if (next < 0) return Infinity;
    score += next - position - 1;
    position = next;
  }
  return score;
}
export function CommandPalette() {
  const data = useData();
  const navigate = useNavigate();
  const { setAppearance } = useAppearance();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [help, setHelp] = useState(false);
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const navigationChord = useRef(0);
  useEffect(() => setActive(0), [search, open]);
  const canAddTask = data.goals.some((goal) => goal.status === "active");
  const planner = data.user.settings.featurePreset !== "simple";
  useEffect(() => {
    const launch = () => {
      setSearch("");
      setOpen(true);
    };
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        launch();
        return;
      }
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            "input,textarea,select,[contenteditable=true]",
          )) ||
        document.querySelector("[role=dialog][data-state=open]")
      )
        return;
      const key = event.key.toLowerCase();
      if (key === "/") {
        event.preventDefault();
        launch();
        return;
      }
      if (key === "?") {
        event.preventDefault();
        setHelp(true);
        return;
      }
      const paths: Record<string, string> = { t: "/", ...(planner ? { p: "/plan" } : {}), g: "/goals" };
      if (
        navigationChord.current &&
        Date.now() - navigationChord.current < 1000 &&
        paths[key]
      ) {
        event.preventDefault();
        navigationChord.current = 0;
        navigate(paths[key]);
        return;
      }
      if (key === "g") {
        navigationChord.current = Date.now();
        return;
      }
      navigationChord.current = 0;
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key.toLowerCase() === "n" &&
        !(
          event.target instanceof HTMLElement &&
          event.target.closest("input,textarea,select,[contenteditable=true]")
        ) &&
        !document.querySelector("[role=dialog][data-state=open]")
      ) {
        event.preventDefault();
        navigate(canAddTask ? "/?add=task" : "/goals");
      }
    };
    window.addEventListener("kram-command", launch);
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("kram-command", launch);
      window.removeEventListener("keydown", keyboard);
    };
  }, [navigate, canAddTask, planner]);
  const entries = useMemo(
    () => [
      ...(canAddTask
        ? [{ label: "Add task", kind: "Create", path: "/?add=task" }]
        : []),
      ...(planner ? [{ label: "Add time block", kind: "Create", path: "/plan?add=block" }] : []),
      { label: "Add goal", kind: "Create", path: "/goals?add=goal" },
      {
        label: "Add resource",
        kind: "Create",
        path: "/resources?add=resource",
      },
      { label: "Today", kind: "Navigate", path: "/" },
      ...(planner ? [{ label: "Plan", kind: "Navigate", path: "/plan" }, { label: "Progress", kind: "Navigate", path: "/progress" }] : []),
      { label: "Profiles and goals", kind: "Navigate", path: "/goals" },
      { label: "Resource library", kind: "Navigate", path: "/resources" },
      { label: "Notifications", kind: "Navigate", path: "/notifications" },
      { label: "Settings", kind: "Navigate", path: "/settings" },
      ...data.profiles.map((profile) => ({
        label: profile.name,
        kind: "Profile",
        path: `/goals#${profile.id}`,
      })),
      ...data.skills.map((skill) => ({
        label: skill.name,
        kind: "Skill",
        path: `/goals#${skill.id}`,
      })),
      ...data.goals.map((goal) => ({
        label: goal.title,
        kind: "Goal",
        path: `/goals/${goal.id}`,
      })),
      ...data.tasks.map((task) => ({
        label: task.title,
        kind: "Task",
        path: `/tasks/${task.id}`,
      })),
      {
        label: "Toggle light and dark theme",
        kind: "Appearance",
        path: "theme",
      },
    ],
    [data, canAddTask, planner],
  );
  const results = entries
    .map((entry) => ({
      ...entry,
      score: matchScore(`${entry.label} ${entry.kind}`, search.trim()),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score)
    .slice(0, 30);
  const run = (path: string) => {
    setOpen(false);
    if (path === "theme")
      setAppearance({
        theme:
          document.documentElement.dataset.theme === "dark" ? "light" : "dark",
      });
    else navigate(path);
  };
  return (
    <>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="A small next step"
        description="Add something or search profiles, skills, goals and tasks. Ctrl or Cmd plus K opens this menu."
        presentation="dialog"
        className="command-palette"
      >
        <div className="stack">
          <Field id="command-search" label="Search or choose an action">
            <div className="command-search">
              <Search size={18} strokeWidth={1.5} aria-hidden="true" />
              <input
                className="input"
                id="command-search"
                ref={searchRef}
                type="search"
                placeholder="Search your workspace…"
                autoComplete="off"
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    resultRefs.current[0]?.focus();
                  }
                  if (event.key === "ArrowUp") { event.preventDefault(); resultRefs.current[results.length - 1]?.focus(); }
                  if (event.key === "Enter" && results[0]) run(results[0].path);
                }}
              />
            </div>
          </Field>
          <ul className="command-results" aria-label="Commands and search results">
            {results.map((entry, index) => {
              const Icon = entry.kind === "Create" ? Plus : entry.kind === "Task" ? CircleCheck : entry.kind === "Goal" ? Target : entry.kind === "Profile" || entry.kind === "Skill" ? BookOpen : entry.path === "/" || entry.path === "/plan" ? CalendarDays : entry.path === "/settings" ? Settings2 : entry.kind === "Appearance" ? Command : ArrowRight;
              const shortcut = entry.path === "/?add=task" ? ["N"] : entry.path === "/" ? ["G", "T"] : entry.path === "/plan" ? ["G", "P"] : entry.path === "/goals" ? ["G", "G"] : undefined;
              return <li key={`${entry.kind}:${entry.path}:${entry.label}`}>
                {results[index - 1]?.kind !== entry.kind && <p className="command-group-label">{entry.kind}</p>}
                <button
                  type="button"
                  className="command-result"
                  aria-label={`${entry.label} ${entry.kind}`}
                  ref={node => { resultRefs.current[index] = node; }}
                  data-active={active === index || undefined}
                  onFocus={() => setActive(index)}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => run(entry.path)}
                  onKeyDown={(event) => {
                    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                      event.preventDefault();
                      const next = event.key === "Home" ? 0 : event.key === "End" ? results.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
                      resultRefs.current[next]?.focus();
                    }
                    if (!event.ctrlKey && !event.metaKey && !event.altKey && ((event.key.length === 1 && event.key !== " ") || event.key === "Backspace")) {
                      event.preventDefault();
                      setSearch(previous => event.key === "Backspace" ? previous.slice(0, -1) : previous + event.key);
                      searchRef.current?.focus();
                    }
                  }}
                >
                  <span className="command-result-icon"><Icon size={17} strokeWidth={1.6} aria-hidden="true" /></span>
                  <span className="command-result-title"><Truncate>{entry.label}</Truncate></span>
                  {shortcut ? <Shortcut keys={shortcut} /> : <Shortcut keys={["↵"]} className="command-enter-hint" />}
                </button>
              </li>;
            })}
          </ul>
          {!results.length && (
            <EmptyState icon={<Search />} title="Nothing by that name" action={<Button variant="text" onClick={() => { setSearch(""); searchRef.current?.focus(); }}>Clear search</Button>}>Try a shorter name, or clear your search to browse all actions.</EmptyState>
          )}
          <div className="command-footer"><span><Shortcut keys={["↑", "↓"]} /> Navigate</span><span><Shortcut keys={["↵"]} /> Open</span><span><Shortcut keys={["Esc"]} /> Close</span></div>
        </div>
      </Sheet>
      <Sheet
        open={help}
        onOpenChange={setHelp}
        title="Keyboard shortcuts"
        description="Use these shortcuts when you are outside a form field."
      >
        <dl className="shortcut-list">
          <dt><Shortcut keys={["Mod", "K"]} /> <Shortcut keys={["/"]} /></dt>
          <dd>Add or search</dd>
          <dt><Shortcut keys={["N"]} /></dt>
          <dd>Add a task</dd>
          <dt><Shortcut keys={["G"]} /> then <Shortcut keys={planner ? ["T", "P", "G"] : ["T", "G"]} /></dt>
          <dd>{planner ? "Go to Today, Plan, Goals" : "Go to Today or Goals"}</dd>
          <dt><Shortcut keys={["J", "K"]} /></dt>
          <dd>Move between tasks</dd>
          <dt><Shortcut keys={["↵"]} /></dt>
          <dd>Open the focused task</dd>
          <dt><Shortcut keys={["D", "S", "E", "X"]} /></dt>
          <dd>Complete, start or stop timer, defer, skip</dd>
          <dt><Shortcut keys={["P"]} /> in a task panel</dt>
          <dd>Place a pinned time block</dd>
          <dt><Shortcut keys={["←", "→", "T"]} /> in Plan</dt>
          <dd>Change day, return to the study day</dd>
          <dt><Shortcut keys={["Esc"]} /></dt>
          <dd>Close the current panel</dd>
        </dl>
      </Sheet>
    </>
  );
}
