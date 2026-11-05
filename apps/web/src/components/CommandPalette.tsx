import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Plus, Search } from "lucide-react";
import { Field, Sheet } from "./ui/kit";
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
  const navigationChord = useRef(0);
  const canAddTask = data.goals.some((goal) => goal.status === "active");
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
      const paths: Record<string, string> = { t: "/", p: "/plan", g: "/goals" };
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
  }, [navigate, canAddTask]);
  const entries = useMemo(
    () => [
      ...(canAddTask
        ? [{ label: "Add task", kind: "Create", path: "/?add=task" }]
        : []),
      { label: "Add time block", kind: "Create", path: "/plan?add=block" },
      { label: "Add goal", kind: "Create", path: "/goals?add=goal" },
      {
        label: "Add resource",
        kind: "Create",
        path: "/resources?add=resource",
      },
      { label: "Today", kind: "Navigate", path: "/" },
      { label: "Plan", kind: "Navigate", path: "/plan" },
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
    [data, canAddTask],
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
      >
        <div className="stack">
          <Field id="command-search" label="Search or choose an action">
            <div className="command-search">
              <Search size={18} strokeWidth={1.5} aria-hidden="true" />
              <input
                className="input"
                id="command-search"
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    document
                      .querySelector<HTMLButtonElement>(".command-result")
                      ?.focus();
                  }
                  if (event.key === "Enter" && results[0]) run(results[0].path);
                }}
              />
            </div>
          </Field>
          <ul className="command-results">
            {results.map((entry, index) => (
              <li key={`${entry.kind}:${entry.path}:${entry.label}`}>
                <button
                  type="button"
                  className="command-result"
                  onClick={() => run(entry.path)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const rows = [
                        ...document.querySelectorAll<HTMLButtonElement>(
                          ".command-result",
                        ),
                      ];
                      rows[
                        (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          rows.length) %
                          rows.length
                      ]?.focus();
                    }
                  }}
                >
                  {entry.kind === "Create" ? (
                    <Plus size={18} strokeWidth={1.5} />
                  ) : (
                    <ArrowRight size={18} strokeWidth={1.5} />
                  )}
                  <span>
                    <strong>{entry.label}</strong>
                    <span className="caption">{entry.kind}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!results.length && (
            <p className="muted">No matching item. Try a shorter name.</p>
          )}
        </div>
      </Sheet>
      <Sheet
        open={help}
        onOpenChange={setHelp}
        title="Keyboard shortcuts"
        description="Use these shortcuts when you are outside a form field."
      >
        <dl className="shortcut-list">
          <dt>Ctrl or Cmd + K, /</dt>
          <dd>Add or search</dd>
          <dt>N</dt>
          <dd>Add a task</dd>
          <dt>G then T, P, G</dt>
          <dd>Go to Today, Plan, Goals</dd>
          <dt>J / K</dt>
          <dd>Move between tasks</dd>
          <dt>Enter</dt>
          <dd>Open the focused task</dd>
          <dt>D / S / E / X</dt>
          <dd>Complete, start or stop timer, defer, skip</dd>
          <dt>P in a task panel</dt>
          <dd>Place a pinned time block</dd>
          <dt>Left / Right, T in Plan</dt>
          <dd>Change day, return to the study day</dd>
          <dt>Esc</dt>
          <dd>Close the current panel</dd>
        </dl>
      </Sheet>
    </>
  );
}
