import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { loginSchema, type LoginInput } from '@bme/shared';
import { audit } from '../../lib/audit';
import { authenticate, clearSessionCookie, currentUser, loadSessionUser, setSessionCookie } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { validate } from '../../lib/validate';

export const authRouter = Router();

// Not permission-gated: this is how a permission set is obtained.
authRouter.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.body as LoginInput;
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = !!user && user.active && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) {
    await audit(prisma, req, { action: 'auth.login_failed', entityType: 'user', actorId: null, after: { email } });
    throw new HttpError(401, 'Wrong email or password');
  }
  await audit(prisma, req, { action: 'auth.login', entityType: 'user', entityId: user.id, actorId: user.id });
  setSessionCookie(res, user.id);
  res.json(await loadSessionUser(user.id));
});

authRouter.post('/logout', authenticate, async (req, res) => {
  await audit(prisma, req, { action: 'auth.logout', entityType: 'user', entityId: currentUser(req).id });
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.get('/me', authenticate, (req, res) => {
  res.json(currentUser(req));
});
