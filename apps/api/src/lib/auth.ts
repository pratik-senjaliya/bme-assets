import type { Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ROLE_LABELS, type PermissionCode, type RoleName, type SessionUser } from '@bme/shared';
import { config } from './config';
import { HttpError } from './errors';
import { prisma } from './prisma';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export const COOKIE_NAME = 'bme_token';

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.cookieSecure,
  path: '/',
} as const;

export function setSessionCookie(res: Response, userId: string) {
  const token = jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: `${config.sessionHours}h` });
  res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: config.sessionHours * 3600_000 });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, cookieOptions);
}

// Permissions are read from the DB on every request, so a role change takes effect immediately
// and a deactivated user is locked out at once.
export async function loadSessionUser(id: string): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
  });
  if (!user || !user.active) return null;
  const role = user.role.name as RoleName;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role,
    roleLabel: ROLE_LABELS[role] ?? user.role.label,
    departmentId: user.departmentId,
    permissions: user.role.rolePermissions.map((rp) => rp.permission.code as PermissionCode),
  };
}

export const authenticate: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[COOKIE_NAME];
  let userId: string | undefined;
  try {
    if (token) userId = (jwt.verify(token, config.jwtSecret) as { sub: string }).sub;
  } catch {
    // fall through to 401
  }
  const user = userId ? await loadSessionUser(userId) : null;
  if (!user) {
    clearSessionCookie(res);
    throw new HttpError(401, 'Please sign in');
  }
  req.user = user;
  next();
};

// Every route (except login/health) declares the permission it needs.
export const requirePermission =
  (...codes: PermissionCode[]): RequestHandler =>
  (req, _res, next) => {
    const have = req.user?.permissions ?? [];
    if (!codes.every((c) => have.includes(c))) throw new HttpError(403, 'You do not have permission to do this');
    next();
  };

export const currentUser = (req: Request): SessionUser => {
  if (!req.user) throw new HttpError(401, 'Please sign in');
  return req.user;
};

// Nursing users only ever see their own department. Spread the result into every Prisma `where`
// on a model that has `departmentId`.
export function departmentScope(user: SessionUser): { departmentId?: string } {
  if (user.role !== 'nursing') return {};
  if (!user.departmentId) throw new HttpError(403, 'No department assigned to your login');
  return { departmentId: user.departmentId };
}
