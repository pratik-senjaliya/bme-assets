import type { Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ROLE_LABELS, type PermissionCode, type Register, type RoleName, type SessionUser } from '@bme/shared';
import { config } from './config';
import { HttpError } from './errors';
import { effectivePermissions, facilityOn, registersOf } from './people';
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

// The token carries the user's session version; changing the password raises it, which ends every other session.
export function setSessionCookie(res: Response, userId: string, sessionVersion: number) {
  const token = jwt.sign({ sub: userId, v: sessionVersion }, config.jwtSecret, { expiresIn: `${config.sessionHours}h` });
  res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: config.sessionHours * 3600_000 });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, cookieOptions);
}

// Permissions are read from the DB on every request, so a role change takes effect immediately
// and a deactivated user is locked out at once.
// `sessionVersion` is the one the token was signed with (tokens from before this existed count as 0).
export async function loadSessionUser(id: string, sessionVersion?: number): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
  });
  if (!user || !user.active) return null;
  if (sessionVersion !== undefined && sessionVersion !== user.sessionVersion) return null;
  const role = user.role.name as RoleName;
  const permissions = effectivePermissions(user);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role,
    roleLabel: ROLE_LABELS[role] ?? user.role.label,
    departmentId: user.departmentId,
    permissions,
    mustChangePassword: user.mustChangePassword,
    registers: registersOf(permissions, await facilityOn()),
  };
}

export const authenticate: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[COOKIE_NAME];
  let userId: string | undefined;
  let version = 0;
  try {
    if (token) {
      const claims = jwt.verify(token, config.jwtSecret) as { sub: string; v?: number };
      userId = claims.sub;
      version = claims.v ?? 0;
    }
  } catch {
    // fall through to 401
  }
  const user = userId ? await loadSessionUser(userId, version) : null;
  if (!user) {
    clearSessionCookie(res);
    throw new HttpError(401, 'Please sign in');
  }
  req.user = user;
  next();
};

// A password given by the HOD must be replaced before anything else (gap review #20); sign-in, "who am I", changing the
// password and signing out have no permission check, so they still work.
function assertOwnPassword(req: Parameters<RequestHandler>[0]) {
  if (req.user?.mustChangePassword) throw new HttpError(403, 'Choose your own password first: the one you were given must be changed before you continue');
}

// Every route (except login/health) declares the permission it needs.
export const requirePermission =
  (...codes: PermissionCode[]): RequestHandler =>
  (req, _res, next) => {
    assertOwnPassword(req);
    const have = req.user?.permissions ?? [];
    if (!codes.every((c) => have.includes(c))) throw new HttpError(403, 'You do not have permission to do this');
    next();
  };

// For routes several roles reach with different permissions (e.g. admin or PMS staff).
export const requireAnyPermission =
  (...codes: PermissionCode[]): RequestHandler =>
  (req, _res, next) => {
    assertOwnPassword(req);
    const have = req.user?.permissions ?? [];
    if (!codes.some((c) => have.includes(c))) throw new HttpError(403, 'You do not have permission to do this');
    next();
  };

export const currentUser = (req: Request): SessionUser => {
  if (!req.user) throw new HttpError(401, 'Please sign in');
  return req.user;
};

// Nursing users only ever see their own department.
export function departmentScope(user: SessionUser): { departmentId?: string } {
  if (user.role !== 'nursing') return {};
  if (!user.departmentId) throw new HttpError(403, 'No department assigned to your login');
  return { departmentId: user.departmentId };
}

// What a person may see: their department (nursing) and the registers they work on (decision H). Spread it into every
// Prisma `where` on assets and complaints (both carry `departmentId` and `register`), or under `asset:` for records
// of an asset. `register` narrows it to one team's equipment for people who see both (never widens it).
export type Scope = { departmentId?: string; register?: { in: Register[] } };
export function scopeOf(user: SessionUser, register?: Register): Scope {
  return { ...departmentScope(user), register: { in: register ? user.registers.filter((r) => r === register) : user.registers } };
}
