import { Router } from 'express';
import { rolePermissionsSchema, type PermissionCode, type RoleName, type RolePermissionsInput } from '@bme/shared';
import { audited } from '../../lib/audit';
import { requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';

export const rolesRouter = Router();
rolesRouter.use(requirePermission('role.manage'));

const permissionCodes = async (roleId: string) =>
  (await prisma.rolePermission.findMany({ where: { roleId }, include: { permission: true } }))
    .map((rp) => rp.permission.code as PermissionCode)
    .sort();

rolesRouter.get('/', async (_req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { name: 'asc' } });
  res.json(
    await Promise.all(
      roles.map(async (r) => ({ id: r.id, name: r.name as RoleName, label: r.label, permissions: await permissionCodes(r.id) })),
    ),
  );
});

rolesRouter.get('/:id/permissions', async (req, res) => {
  res.json({ permissions: await permissionCodes(idOf(req)) });
});

rolesRouter.put('/:id/permissions', validate(rolePermissionsSchema), async (req, res) => {
  const { permissions } = req.body as RolePermissionsInput;
  const role = await prisma.role.findUniqueOrThrow({ where: { id: idOf(req) } });
  // Locked so a mis-click can never lock the vendor out of the install.
  if (role.name === 'super_admin') throw new HttpError(403, 'Super admin permissions cannot be changed');

  const before = await permissionCodes(role.id);
  const perms = await prisma.permission.findMany({ where: { code: { in: permissions } } });
  await audited(req, { action: 'role.update_permissions', entityType: 'role', before: { permissions: before } }, async (tx) => {
    await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
    await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    return { id: role.id, permissions: [...permissions].sort() };
  });
  res.json({ permissions: [...permissions].sort() });
});
