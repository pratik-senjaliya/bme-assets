import { DEPUTY_PERMISSIONS, type PermissionCode } from '@bme/shared';
import { prisma } from './prisma';

// What a person may do: their role's permissions, plus the deputy HOD's for a biomedical engineer marked deputy.
export function effectivePermissions(user: { deputy: boolean; role: { name: string; rolePermissions: { permission: { code: string } }[] } }): PermissionCode[] {
  const own = user.role.rolePermissions.map((rp) => rp.permission.code as PermissionCode);
  return user.deputy && user.role.name === 'biomed' ? [...new Set([...own, ...DEPUTY_PERMISSIONS])] : own;
}

// Ids of active users who have ALL the given permission codes (role or deputy).
export async function usersWithPermissions(...codes: PermissionCode[]): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, deputy: true, role: { select: { name: true, rolePermissions: { select: { permission: { select: { code: true } } } } } } },
  });
  return users.filter((u) => codes.every((c) => effectivePermissions(u).includes(c))).map((u) => u.id);
}
