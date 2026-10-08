import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { changePasswordSchema, loginSchema, type ChangePasswordInput, type LoginInput } from '@bme/shared';
import { audit } from '../../lib/audit';
import { authenticate, clearSessionCookie, currentUser, loadSessionUser, setSessionCookie } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { assertNotLocked, recordFailure, recordSuccess } from '../../lib/loginThrottle';
import { prisma } from '../../lib/prisma';
import { validate } from '../../lib/validate';

export const authRouter = Router();

// Not permission-gated: this is how a permission set is obtained.
authRouter.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.body as LoginInput;
  try {
    assertNotLocked(email);
  } catch (e) {
    await audit(prisma, req, { action: 'auth.login_blocked', entityType: 'user', actorId: null, after: { email } });
    throw e;
  }
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = !!user && user.active && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) {
    const locked = recordFailure(email);
    await audit(prisma, req, { action: locked ? 'auth.login_locked' : 'auth.login_failed', entityType: 'user', actorId: null, after: { email } });
    throw new HttpError(401, 'Wrong email or password');
  }
  recordSuccess(email);
  await audit(prisma, req, { action: 'auth.login', entityType: 'user', entityId: user.id, actorId: user.id });
  setSessionCookie(res, user.id);
  res.json(await loadSessionUser(user.id));
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
  assertNotLocked(me.email);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    recordFailure(me.email);
    throw new HttpError(400, 'Your current password is not right', { fieldErrors: { currentPassword: ['Not right'] } });
  }
  await prisma.user.update({ where: { id: me.id }, data: { passwordHash: await bcrypt.hash(newPassword, 10) } });
  recordSuccess(me.email);
  await audit(prisma, req, { action: 'auth.password_change', entityType: 'user', entityId: me.id });
  res.status(204).end();
});

authRouter.get('/me', authenticate, (req, res) => {
  res.json(currentUser(req));
});
