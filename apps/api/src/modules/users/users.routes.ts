import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import {
  ROLE_LABELS,
  createUserSchema,
  updateUserSchema,
  type CreateUserInput,
  type RoleName,
  type UpdateUserInput,
  type UserRow,
} from '@bme/shared';
import { audited } from '../../lib/audit';
import { currentUser, requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';

export const usersRouter = Router();
usersRouter.use(requirePermission('user.manage'));

const include = { role: true, department: true } satisfies Prisma.UserInclude;
type UserWithRefs = Prisma.UserGetPayload<{ include: typeof include }>;

const toRow = (u: UserWithRefs): UserRow => ({
  id: u.id,
  name: u.name,
  email: u.email,
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
    ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
  };
  const user = await audited(req, { action: 'user.update', entityType: 'user', before }, (tx) =>
    tx.user.update({ where: { id: before.id }, data }),
  );
  res.json(toRow(await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include })));
});

// Users are never hard-deleted (the audit log points at them); DELETE deactivates.
usersRouter.delete('/:id', async (req, res) => {
  const me = currentUser(req);
  const before = await prisma.user.findUniqueOrThrow({ where: { id: idOf(req) }, include: { role: true } });
  guardSuperAdmin(me.role, before.role.name as RoleName);
  if (before.id === me.id) throw new HttpError(400, 'You cannot deactivate your own login');
  await audited(req, { action: 'user.update', entityType: 'user', before }, (tx) =>
    tx.user.update({ where: { id: before.id }, data: { active: false } }),
  );
  res.status(204).end();
});
