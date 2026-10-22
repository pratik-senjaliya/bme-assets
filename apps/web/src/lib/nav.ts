// Where to send someone after signing in: the page they asked for, but only a page on this site.
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/login')) return '/';
  return raw;
}

// Why a signed-in person was sent to sign in: the session ended, or the computer was left unused (see lib/idle.ts).
export type SignedOutReason = 'expired' | 'idle' | null;

// The sign-in address for the page the person is on, so they come back to it afterwards.
export function loginHref(reason: SignedOutReason): string {
  const here = `${window.location.pathname}${window.location.search}`;
  const params = new URLSearchParams();
  if (here !== '/') params.set('next', here);
  if (reason) params.set(reason, '1');
  return `/login${params.size ? `?${params}` : ''}`;
}

// Any call that finds the session gone (cookie expired, signed out elsewhere) tells the app, which sends the person
// to sign in again instead of leaving "Could not load" on every screen.
export const SIGNED_OUT_EVENT = 'bme:signed-out';
export const notifySignedOut = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
};
