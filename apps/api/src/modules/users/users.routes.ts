import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import {
  ROLE_LABELS,
  UNRESOLVED_STATUSES,
  createUserSchema,
  updateUserSchema,
  type CreateUserInput,
  type RoleName,
  type UpdateUserInput,
  type UserRow,
} from '@bme/shared';
import { auditMany, audited } from '../../lib/audit';
import { currentUser, requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { recordSuccess } from '../../lib/loginThrottle';
import { usersWithPermissions } from '../../lib/people';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';
import { notify } from '../approvals/approvals.service';

export const usersRouter = Router();
usersRouter.use(requirePermission('user.manage'));

const include = { role: true, department: true } satisfies Prisma.UserInclude;
type UserWithRefs = Prisma.UserGetPayload<{ include: typeof include }>;

const toRow = (u: UserWithRefs): UserRow => ({
  id: u.id,
  name: u.name,
  email: u.email,
  username: u.username,
  mustChangePassword: u.mustChangePassword,
  role: u.role.name as RoleName,
  roleLabel: ROLE_LABELS[u.role.name as RoleName] ?? u.role.label,
  departmentId: u.departmentId,
  departmentName: u.department?.name ?? null,
  active: u.active,
  createdAt: u.createdAt.toISOString(),
});

// The vendor's super admin login belongs to the vendor: a hospital admin cannot create, edit,
// deactivate or promote anyone to it.
function guardSuperAdmin(actorRole: RoleName, ...touched: Array<RoleName | undefined>) {
  if (actorRole !== 'super_admin' && touched.includes('super_admin')) {
    throw new HttpError(403, 'Only the super admin can manage super admin users');
  }
}

// Someone leaving (deactivated): the complaints they were to fix go back to the board, unassigned, and whoever assigns
// complaints is told about each (gap review #9). Inside the deactivating transaction.
async function handBack(tx: Prisma.TransactionClient, req: Parameters<typeof currentUser>[0], user: { id: string; name: string }) {
  const open = await tx.complaint.findMany({ where: { assignedToId: user.id, status: { in: UNRESOLVED_STATUSES } }, include: { asset: true } });
  if (!open.length) return;
  await tx.complaint.updateMany({ where: { id: { in: open.map((c) => c.id) } }, data: { assignedToId: null, assignedAt: null, assignedBy: null } });
  await auditMany(tx, req, open.map((c) => ({ action: 'complaint.assign', entityType: 'complaint', entityId: c.id, before: { assignedToId: user.id }, after: { assignedToId: null, reason: 'user deactivated' } })));
  const hods = (await usersWithPermissions('complaint.assign', 'notification.view')).filter((id) => id !== user.id);
  for (const c of open) await notify(tx, hods, `${user.name} has left: complaint ${c.complaintNo} (${c.asset.assetCode} ${c.asset.name}) needs someone`, c.assetId, 'complaint', c.id);
}

async function roleId(name: RoleName) {
  return (await prisma.role.findUniqueOrThrow({ where: { name } })).id;
}

usersRouter.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({ include, orderBy: { name: 'asc' } });
  res.json(users.map(toRow));
});

usersRouter.post('/', validate(createUserSchema), async (req, res) => {
  const { password, role, departmentId, ...rest } = req.body as CreateUserInput;
  guardSuperAdmin(currentUser(req).role, role);
  const data = {
    ...rest,
    roleId: await roleId(role),
    departmentId: role === 'nursing' ? departmentId : null,
    passwordHash: await bcrypt.hash(password, 10),
    // The HOD knows this password: the person chooses their own at first sign-in.
    mustChangePassword: true,
    createdBy: currentUser(req).id,
  };
  const user = await audited(req, { action: 'user.create', entityType: 'user' }, (tx) => tx.user.create({ data }));
  res.status(201).json(toRow(await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include })));
});

usersRouter.patch('/:id', validate(updateUserSchema), async (req, res) => {
  const { password, role, departmentId, ...rest } = req.body as UpdateUserInput;
  const me = currentUser(req);
  const before = await prisma.user.findUniqueOrThrow({ where: { id: idOf(req) }, include: { role: true } });
  guardSuperAdmin(me.role, before.role.name as RoleName, role);
  if (before.id === me.id && (rest.active === false || role !== me.role)) {
    throw new HttpError(400, 'You cannot deactivate or change the role of your own login');
  }
  const data = {
    ...rest,
    roleId: await roleId(role),
    departmentId: role === 'nursing' ? departmentId : null,
    // A reset ends the person's sessions everywhere (the audit entry shows the version going up).
    // and a password set by someone else is changed at the next sign-in.
    ...(password ? { passwordHash: await bcrypt.hash(password, 10), sessionVersion: { increment: 1 }, mustChangePassword: before.id !== me.id } : {}),
  };
  const user = await audited(req, { action: 'user.update', entityType: 'user', before }, async (tx) => {
    const row = await tx.user.update({ where: { id: before.id }, data });
    if (before.active && !row.active) await handBack(tx, req, row);
    return row;
  });
  // The locked-out message says to ask the HOD for a reset; the reset must then let them in.
  if (password) recordSuccess(before.email);
  res.json(toRow(await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include })));
});

// Users are never hard-deleted (the audit log points at them); DELETE deactivates.
usersRouter.delete('/:id', async (req, res) => {
  const me = currentUser(req);
  const before = await prisma.user.findUniqueOrThrow({ where: { id: idOf(req) }, include: { role: true } });
  guardSuperAdmin(me.role, before.role.name as RoleName);
  if (before.id === me.id) throw new HttpError(400, 'You cannot deactivate your own login');
  await audited(req, { action: 'user.update', entityType: 'user', before }, async (tx) => {
    const row = await tx.user.update({ where: { id: before.id }, data: { active: false } });
    if (before.active) await handBack(tx, req, row);
    return row;
  });
  res.status(204).end();
});
