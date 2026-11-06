import { useEffect, useRef, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark" | "scheduled";
type ResolvedTheme = "light" | "dark";
export interface Appearance {
  theme: ThemeChoice;
  motion: "system" | "reduced" | "full";
  density: "comfortable" | "compact";
  wakeMin: number;
  sleepMin: number;
}
const defaults: Appearance = {
  theme: "system",
  motion: "system",
  density: "comfortable",
  wakeMin: 420,
  sleepMin: 1380,
};

export function readAppearance(): Appearance {
  try {
    return {
      ...defaults,
      ...JSON.parse(localStorage.getItem("kram-appearance") || "{}"),
    } as Appearance;
  } catch {
    return defaults;
  }
}

function resolveTheme(appearance: Appearance): ResolvedTheme {
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  const darkStart = (appearance.sleepMin - 60 + 1440) % 1440;
  const isScheduledDark =
    darkStart > appearance.wakeMin
      ? minute >= darkStart || minute < appearance.wakeMin
      : minute >= darkStart && minute < appearance.wakeMin;
  const dark =
    appearance.theme === "dark" ||
    (appearance.theme === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches) ||
    (appearance.theme === "scheduled" && isScheduledDark);
  return dark ? "dark" : "light";
}

function applyAppearance(appearance: Appearance) {
  const resolvedTheme = resolveTheme(appearance);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.motion = appearance.motion;
  document.documentElement.dataset.density = appearance.density;
  document.documentElement.style.colorScheme = resolvedTheme;
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (meta)
    meta.content = getComputedStyle(document.documentElement)
      .getPropertyValue("--bg")
      .trim();
  return resolvedTheme;
}

export function useAppearance() {
  const [appearance, update] = useState(readAppearance);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(
    () => document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  const crossfadeTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const apply = () => setResolvedTheme(applyAppearance(appearance));
    apply();
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    const timer = window.setInterval(() => {
      if (!document.hidden) apply();
    }, 60000);
    const visible = () => { if (!document.hidden) apply(); };
    document.addEventListener("visibilitychange", visible);
    const sync = () => update(readAppearance());
    const storage = (event: StorageEvent) => {
      if (event.key === "kram-appearance") sync();
    };
    window.addEventListener("kram-appearance-changed", sync);
    window.addEventListener("storage", storage);
    return () => {
      media.removeEventListener("change", apply);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("kram-appearance-changed", sync);
      window.removeEventListener("storage", storage);
      clearInterval(timer);
    };
  }, [appearance]);
  useEffect(() => () => {
    clearTimeout(crossfadeTimer.current);
    document.documentElement.classList.remove("theme-crossfade");
  }, []);
  const setAppearance = (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    localStorage.setItem("kram-appearance", JSON.stringify(next));
    const reduced =
      next.motion === "reduced" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    clearTimeout(crossfadeTimer.current);
    document.documentElement.classList.remove("theme-crossfade");
    if (!reduced && resolveTheme(next) !== document.documentElement.dataset.theme) {
      document.documentElement.classList.add("theme-crossfade");
      crossfadeTimer.current = window.setTimeout(
        () => document.documentElement.classList.remove("theme-crossfade"),
        220,
      );
    }
    setResolvedTheme(applyAppearance(next));
    update(next);
    window.dispatchEvent(new Event("kram-appearance-changed"));
  };
  return { appearance, resolvedTheme, setAppearance };
}
