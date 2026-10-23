import { DEPUTY_PERMISSIONS, DEPUTY_ROLES, REGISTER_PERMISSION, REGISTERS, type PermissionCode, type Register, type RoleName } from '@bme/shared';
import { prisma } from './prisma';

// What a person may do: their role's permissions, plus the deputy HOD's for an engineer marked deputy.
export function effectivePermissions(user: { deputy: boolean; role: { name: string; rolePermissions: { permission: { code: string } }[] } }): PermissionCode[] {
  const own = user.role.rolePermissions.map((rp) => rp.permission.code as PermissionCode);
  return user.deputy && DEPUTY_ROLES.includes(user.role.name as RoleName) ? [...new Set([...own, ...DEPUTY_PERMISSIONS])] : own;
}

// Is the facility maintenance add-on on (decision K)?
export async function facilityOn() {
  return !!(await prisma.hospitalSettings.findFirst({ select: { facilityEnabled: true } }))?.facilityEnabled;
}

// The registers a person works on or sees: their register.* permissions, facility only while the add-on is on.
export const registersOf = (permissions: PermissionCode[], facilityEnabled: boolean): Register[] =>
  REGISTERS.filter((r) => permissions.includes(REGISTER_PERMISSION[r]) && (r !== 'facility' || facilityEnabled));

// The whole hospital, for work done by the server itself (the monthly report): every register in use.
export async function hospitalScope(): Promise<{ register: { in: Register[] } }> {
  return { register: { in: (await facilityOn()) ? [...REGISTERS] : ['biomedical'] } };
}

// Ids of active users who have all the given permissions and work on `register`: who hears about, and can be given,
// that team's equipment and complaints.
export async function registerTeam(register: Register, ...codes: PermissionCode[]): Promise<string[]> {
  if (register === 'facility' && !(await facilityOn())) return [];
  return usersWithPermissions(...codes, REGISTER_PERMISSION[register]);
}

// Ids of active users who have ALL the given permission codes (role or deputy).
export async function usersWithPermissions(...codes: PermissionCode[]): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, deputy: true, role: { select: { name: true, rolePermissions: { select: { permission: { select: { code: true } } } } } } },
  });
  return users.filter((u) => codes.every((c) => effectivePermissions(u).includes(c))).map((u) => u.id);
}
