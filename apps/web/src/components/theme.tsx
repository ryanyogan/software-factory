import { Button } from '@sf/ui/components/button';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
const ORDER: ThemeMode[] = ['system', 'light', 'dark'];

/** Inline in <head> so the right class is set before first paint (no flash). */
export const THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem('theme');if(m!=='light'&&m!=='dark')m='system';var d=m==='dark'||(m==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

function apply(mode: ThemeMode) {
  const dark =
    mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

function readMode(): ThemeMode {
  try {
    const m = localStorage.getItem('theme');
    return m === 'light' || m === 'dark' ? m : 'system';
  } catch {
    return 'system';
  }
}

const EVENT = 'sf-theme';
function subscribe(onChange: () => void) {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onSystem = () => {
    if (readMode() === 'system') apply('system');
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  mq.addEventListener('change', onSystem);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
    mq.removeEventListener('change', onSystem);
  };
}

/** Theme mode lives in localStorage ('system' default); the server snapshot is always 'system'. */
export function useTheme() {
  const mode = useSyncExternalStore(subscribe, readMode, () => 'system' as const);
  const set = (next: ThemeMode) => {
    try {
      localStorage.setItem('theme', next);
    } catch {
      // storage unavailable; theme still applies for this page
    }
    apply(next);
    window.dispatchEvent(new Event(EVENT));
  };
  const cycle = () => set(ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length] ?? 'system');
  return { mode, set, cycle };
}

export function ThemeToggle({ theme }: { theme: ReturnType<typeof useTheme> }) {
  const Icon = theme.mode === 'dark' ? MoonIcon : theme.mode === 'light' ? SunIcon : MonitorIcon;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={theme.cycle}
      aria-label={`Theme: ${theme.mode} (click to change)`}
      title={`Theme: ${theme.mode}`}
    >
      <Icon />
    </Button>
  );
}
