import { useEffect, useRef } from 'react';

const KEY = 'bme-last-activity';
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

// Shared ward computers (gap review #5): a login left unused for `minutes` is signed out, so the next person does not
// act under someone else's name. Activity in any tab of this browser counts (shared through localStorage, which may be
// unavailable: then each tab counts its own). 0 or undefined: never.
export function useIdleSignOut(minutes: number | undefined, signOut: () => void) {
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;
  useEffect(() => {
    if (!minutes) return;
    let last = Date.now();
    let shared = 0; // when this tab last wrote to localStorage (writing on every key press is wasteful)
    const mark = () => {
      last = Date.now();
      if (last - shared < 10_000) return;
      shared = last;
      try {
        localStorage.setItem(KEY, String(last));
      } catch {
        // private window or storage blocked: this tab's own clock still works
      }
    };
    const lastActivity = () => {
      try {
        return Math.max(last, Number(localStorage.getItem(KEY)) || 0);
      } catch {
        return last;
      }
    };
    mark();
    EVENTS.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity() > minutes * 60_000) signOutRef.current();
    }, 15_000);
    return () => {
      EVENTS.forEach((e) => window.removeEventListener(e, mark));
      window.clearInterval(timer);
    };
  }, [minutes]);
}
