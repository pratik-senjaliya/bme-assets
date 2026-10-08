import type { PermissionCode } from '@bme/shared';
import { prisma } from './prisma';

// Ids of active users whose role has ALL the given permission codes.
export async function usersWithPermissions(...codes: PermissionCode[]): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { active: true, role: { AND: codes.map((code) => ({ rolePermissions: { some: { permission: { code } } } })) } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}
