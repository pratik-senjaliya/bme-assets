'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Mode } from '@/theme';

// Light, dark ("night shift") or the computer's own setting, kept per browser. The choice is put on <html> before the
// page paints (THEME_SCRIPT in layout.tsx), so the CSS colours are right from the first frame.
export type ModeChoice = 'system' | Mode;
const KEY = 'bme-theme';

const read = (): ModeChoice => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
};
const systemDark = () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

export const THEME_SCRIPT = `try{var m=localStorage.getItem('${KEY}');if(m!=='light'&&m!=='dark')m=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=m}catch(e){}`;

const Ctx = createContext<{ choice: ModeChoice; mode: Mode; setChoice: (c: ModeChoice) => void }>({ choice: 'system', mode: 'light', setChoice: () => {} });

export function ThemeModeProvider({ children }: { children: (mode: Mode) => ReactNode }) {
  const [choice, setChoiceState] = useState<ModeChoice>('system');
  const [mode, setMode] = useState<Mode>('light');

  useEffect(() => {
    const c = read();
    setChoiceState(c);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const m: Mode = (c === 'system' ? (media.matches ? 'dark' : 'light') : c);
      setMode(m);
      document.documentElement.dataset.theme = m;
    };
    apply();
    if (c !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [choice]);

  const setChoice = useCallback((c: ModeChoice) => {
    try {
      if (c === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch {
      // Private windows may refuse storage; the choice then lasts for this visit.
    }
    setChoiceState(c);
    const m: Mode = c === 'system' ? (systemDark() ? 'dark' : 'light') : c;
    setMode(m);
    document.documentElement.dataset.theme = m;
  }, []);

  return <Ctx.Provider value={{ choice, mode, setChoice }}>{children(mode)}</Ctx.Provider>;
}

export const useThemeMode = () => useContext(Ctx);
