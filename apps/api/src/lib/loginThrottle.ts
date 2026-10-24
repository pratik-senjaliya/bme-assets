import { config } from './config';
import { HttpError } from './errors';
import { prisma } from './prisma';

// Brute-force protection for sign-in: after a few wrong passwords for one login, that login is locked for a while.
// Kept in the database (login_attempts), so a restart does not lift a lock and two API instances share it. It is keyed
// by the person's email (or what was typed when no login matches), because behind a proxy the client address is not
// always known. The cost is that someone can lock a colleague out for a few minutes; the HOD can always reset the
// password, and every lock is in the audit log.
const windowMs = () => config.loginLockMinutes * 60_000;

// Throws 429 while this login is locked.
export async function assertNotLocked(key: string, now = Date.now()) {
  const e = await prisma.loginAttempt.findUnique({ where: { key } });
  const until = e?.lockedUntil?.getTime() ?? 0;
  if (until > now) {
    const minutes = Math.ceil((until - now) / 60_000);
    throw new HttpError(429, `Too many wrong passwords. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, or ask your Biomedical HOD to reset your password.`, { retryAfterSeconds: Math.ceil((until - now) / 1000) });
  }
}

// Records a wrong password. Returns true when this one locked the login.
export async function recordFailure(key: string, now = Date.now()): Promise<boolean> {
  const old = await prisma.loginAttempt.findUnique({ where: { key } });
  // A count older than the window, or a lock that has run out, starts again.
  const fresh = !old || now - old.since.getTime() > windowMs() || !!old.lockedUntil;
  const failures = (fresh ? 0 : old.failures) + 1;
  const lockedUntil = failures >= config.loginMaxFailures ? new Date(now + windowMs()) : null;
  const data = { failures, since: fresh ? new Date(now) : old.since, lockedUntil };
  await prisma.loginAttempt.upsert({ where: { key }, create: { key, ...data }, update: data });
  return !!lockedUntil;
}

export const recordSuccess = async (key: string) => void (await prisma.loginAttempt.deleteMany({ where: { key } }));
export const resetLoginThrottle = async () => void (await prisma.loginAttempt.deleteMany());
