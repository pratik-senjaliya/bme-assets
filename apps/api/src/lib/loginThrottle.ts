import { config } from './config';
import { HttpError } from './errors';

// Brute-force protection for sign-in: after a few wrong passwords for one login, that login is locked for a while.
// Kept in memory, which is right for one install on one server. It is keyed by the email alone, because behind a
// proxy the client address is not always known. The cost is that someone can lock a colleague out for a few
// minutes; the HOD can always reset the password, and every lock is in the audit log.
type Entry = { failures: number; since: number; lockedUntil: number };
const entries = new Map<string, Entry>();

const windowMs = () => config.loginLockMinutes * 60_000;

// Throws 429 while this login is locked.
export function assertNotLocked(email: string, now = Date.now()) {
  const e = entries.get(email);
  if (e && e.lockedUntil > now) {
    const minutes = Math.ceil((e.lockedUntil - now) / 60_000);
    throw new HttpError(429, `Too many wrong passwords. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, or ask your Biomedical HOD to reset your password.`, { retryAfterSeconds: Math.ceil((e.lockedUntil - now) / 1000) });
  }
}

// Records a wrong password. Returns true when this one locked the login.
export function recordFailure(email: string, now = Date.now()): boolean {
  const old = entries.get(email);
  const fresh = !old || now - old.since > windowMs() || old.lockedUntil !== 0; // an expired lock starts a new count
  const e: Entry = fresh ? { failures: 0, since: now, lockedUntil: 0 } : old;
  e.failures += 1;
  if (e.failures >= config.loginMaxFailures) e.lockedUntil = now + windowMs();
  entries.set(email, e);
  return e.lockedUntil > 0;
}

export const recordSuccess = (email: string) => void entries.delete(email);
export const resetLoginThrottle = () => entries.clear();
