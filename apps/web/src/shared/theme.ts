import { useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark' | 'scheduled';
export interface Appearance { theme: ThemeChoice; motion: 'system' | 'reduced' | 'full'; density: 'comfortable' | 'compact'; wakeMin: number; sleepMin: number }
const defaults: Appearance = { theme: 'system', motion: 'system', density: 'comfortable', wakeMin: 420, sleepMin: 1380 };

export function readAppearance(): Appearance {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('kram-appearance') || '{}') } as Appearance; }
  catch { return defaults; }
}

function applyAppearance(appearance: Appearance) {
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  const darkStart = (appearance.sleepMin - 60 + 1440) % 1440;
  const isScheduledDark = darkStart > appearance.wakeMin ? minute >= darkStart || minute < appearance.wakeMin : minute >= darkStart && minute < appearance.wakeMin;
  const dark = appearance.theme === 'dark' || appearance.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches || appearance.theme === 'scheduled' && isScheduledDark;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.motion = appearance.motion;
  document.documentElement.dataset.density = appearance.density;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
}

export function useAppearance() {
  const [appearance, update] = useState(readAppearance);
  useEffect(() => {
    applyAppearance(appearance);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyAppearance(appearance);
    media.addEventListener('change', apply);
    const timer = window.setInterval(() => { if (!document.hidden) apply(); }, 60000);
    return () => { media.removeEventListener('change', apply); clearInterval(timer); };
  }, [appearance]);
  const setAppearance = (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    localStorage.setItem('kram-appearance', JSON.stringify(next));
    const reduced = next.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduced) {
      document.documentElement.classList.add('theme-crossfade');
      window.setTimeout(() => document.documentElement.classList.remove('theme-crossfade'), 220);
    }
    applyAppearance(next);
    update(next);
  };
  return { appearance, setAppearance };
}
