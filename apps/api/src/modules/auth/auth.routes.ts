import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { changePasswordSchema, forgotPasswordSchema, loginSchema, type ChangePasswordInput, type ForgotPasswordInput, type LoginInput } from '@bme/shared';
import { audit } from '../../lib/audit';
import { authenticate, clearSessionCookie, currentUser, loadSessionUser, setSessionCookie } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { assertNotLocked, recordFailure, recordSuccess } from '../../lib/loginThrottle';
import { usersWithPermissions } from '../../lib/people';
import { prisma } from '../../lib/prisma';
import { validate } from '../../lib/validate';
import { notify } from '../approvals/approvals.service';

export const authRouter = Router();

// A login is the email or the short username (both stored in lowercase).
const findLogin = (login: string) => prisma.user.findUnique({ where: login.includes('@') ? { email: login } : { username: login } });

// Not permission-gated: this is how a permission set is obtained.
authRouter.post('/login', validate(loginSchema), async (req, res) => {
  const { email: login, password } = req.body as LoginInput;
  const user = await findLogin(login);
  // Wrong tries count per person, whichever of their names is typed (an unknown name counts on its own).
  const key = user?.email ?? login;
  try {
    await assertNotLocked(key);
  } catch (e) {
    await audit(prisma, req, { action: 'auth.login_blocked', entityType: 'user', actorId: null, after: { email: login } });
    throw e;
  }
  const ok = !!user && user.active && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) {
    const locked = await recordFailure(key);
    await audit(prisma, req, { action: locked ? 'auth.login_locked' : 'auth.login_failed', entityType: 'user', actorId: null, after: { email: login } });
    throw new HttpError(401, 'Wrong email, username or password');
  }
  await recordSuccess(key);
  await audit(prisma, req, { action: 'auth.login', entityType: 'user', entityId: user.id, actorId: user.id });
  const sessionEndsAt = setSessionCookie(res, user.id, user.sessionVersion);
  res.json({ ...(await loadSessionUser(user.id)), sessionEndsAt });
});

authRouter.post('/logout', authenticate, async (req, res) => {
  await audit(prisma, req, { action: 'auth.logout', entityType: 'user', entityId: currentUser(req).id });
  clearSessionCookie(res);
  res.status(204).end();
});

// Change your own password. The current one is checked first (and wrong tries count towards the lock), so a
// computer left signed in cannot be used to take over the account.
authRouter.post('/password', authenticate, validate(changePasswordSchema), async (req, res) => {
  const me = currentUser(req);
  const { currentPassword, newPassword } = req.body as ChangePasswordInput;
  await assertNotLocked(me.email);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    await recordFailure(me.email);
    throw new HttpError(400, 'Your current password is not right', { fieldErrors: { currentPassword: ['Not right'] } });
  }
  // Every other session (another computer, a copied cookie) ends; this one gets a fresh cookie and carries on.
  const updated = await prisma.user.update({ where: { id: me.id }, data: { passwordHash: await bcrypt.hash(newPassword, 10), sessionVersion: { increment: 1 }, mustChangePassword: false } });
  setSessionCookie(res, me.id, updated.sessionVersion);
  await recordSuccess(me.email);
  await audit(prisma, req, { action: 'auth.password_change', entityType: 'user', entityId: me.id });
  res.status(204).end();
});

// "Forgot password" (gap review #20): the HOD is told in the bell and sets a new one under Users; no email is needed.
// The answer is the same whether or not the login exists, and one request an hour per person is passed on.
authRouter.post('/forgot', validate(forgotPasswordSchema), async (req, res) => {
  const { login } = req.body as ForgotPasswordInput;
  const user = await findLogin(login);
  await audit(prisma, req, { action: 'auth.password_forgot', entityType: 'user', entityId: user?.id ?? null, actorId: null, after: { login } });
  if (user?.active) {
    const message = `${user.name} (${user.username ?? user.email}) forgot their password: set a new one under Users.`;
    const hods = (await usersWithPermissions('user.manage', 'notification.view')).filter((id) => id !== user.id);
    const recent = await prisma.notification.findMany({ where: { type: 'account', message, createdAt: { gte: new Date(Date.now() - 3_600_000) } }, select: { userId: true } });
    const told = new Set(recent.map((r) => r.userId));
    await notify(prisma, hods.filter((id) => !told.has(id)), message, null, 'account');
  }
  res.status(204).end();
});

// Still working when the session is about to end ("Stay signed in"): a fresh session for the same person, who must
// still be active with the same password (authenticate checks both).
authRouter.post('/refresh', authenticate, async (req, res) => {
  const me = await prisma.user.findUniqueOrThrow({ where: { id: currentUser(req).id }, select: { sessionVersion: true } });
  res.json({ sessionEndsAt: setSessionCookie(res, currentUser(req).id, me.sessionVersion) });
});

authRouter.get('/me', authenticate, (req, res) => {
  res.json({ ...currentUser(req), sessionEndsAt: req.sessionEndsAt });
});
