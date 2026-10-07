// Types and zod schemas shared by apps/api and apps/web.
// Rule: every request body schema lives here so the API and the forms validate the same way.
import { z } from 'zod';

export type HealthResponse = {
  status: 'ok';
  database: 'up' | 'down';
  serverTime: string;
};

// ---------- Roles & permissions ----------

export const ROLE_NAMES = ['super_admin', 'admin', 'biomed', 'nursing'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const ROLE_LABELS: Record<RoleName, string> = {
  super_admin: 'Super admin',
  admin: 'Admin (Biomedical HOD)',
  biomed: 'Biomedical staff',
  nursing: 'Nursing staff',
};

export const PERMISSIONS = [
  'asset.view',
  'asset.create',
  'asset.edit',
  'asset.edit_key',
  'asset.request_change',
  'complaint.view',
  'complaint.create',
  'complaint.start',
  'complaint.resolve',
  'expense.manage',
  'pms.perform',
  'calibration.manage',
  'approval.decide',
  'user.manage',
  'role.manage',
  'setup.manage',
  'settings.pattern',
  'audit.view',
  'report.view',
] as const;
export type PermissionCode = (typeof PERMISSIONS)[number];

const BIOMED: PermissionCode[] = [
  'asset.view',
  'asset.create',
  'asset.edit',
  'asset.request_change',
  'complaint.view',
  'complaint.create',
  'complaint.start',
  'complaint.resolve',
  'expense.manage',
  'pms.perform',
  'calibration.manage',
  'report.view',
];

// Defaults seeded into the DB; hospitals can adjust them later.
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleName, readonly PermissionCode[]> = {
  super_admin: PERMISSIONS,
  admin: PERMISSIONS.filter((p) => p !== 'settings.pattern'),
  biomed: BIOMED,
  nursing: ['asset.view', 'complaint.view', 'complaint.create'],
};

// ---------- Auth ----------

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: RoleName;
  roleLabel: string;
  departmentId: string | null;
  permissions: PermissionCode[];
};

// ---------- Setup ----------

export const departmentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/, '2–10 letters or digits'),
});
export type DepartmentInput = z.infer<typeof departmentSchema>;

export const locationSchema = z.object({
  departmentId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/, '2–10 letters or digits'),
});
export type LocationInput = z.infer<typeof locationSchema>;

export const equipmentTypeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/, '2–10 letters or digits'),
  defaultPmsMonths: z.number().int().positive().max(120).nullable().optional(),
  defaultCalibrationMonths: z.number().int().positive().max(120).nullable().optional(),
});
export type EquipmentTypeInput = z.infer<typeof equipmentTypeSchema>;

// ---------- Users ----------

const userBase = {
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(ROLE_NAMES),
  departmentId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
};

const nursingNeedsDepartment = (v: { role?: RoleName; departmentId?: string | null }) =>
  v.role !== 'nursing' || !!v.departmentId;
const nursingMessage = { message: 'Nursing users must belong to a department', path: ['departmentId'] };

export const createUserSchema = z
  .object({ ...userBase, password: z.string().min(8).max(100) })
  .refine(nursingNeedsDepartment, nursingMessage);
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({ ...userBase, password: z.string().min(8).max(100).optional() })
  .refine(nursingNeedsDepartment, nursingMessage);
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export type UserRow = {
  id: string;
  name: string;
  email: string;
  role: RoleName;
  roleLabel: string;
  departmentId: string | null;
  departmentName: string | null;
  active: boolean;
  createdAt: string;
};

export type RoleRow = { id: string; name: RoleName; label: string; permissions: PermissionCode[] };

export const rolePermissionsSchema = z.object({ permissions: z.array(z.enum(PERMISSIONS)) });
export type RolePermissionsInput = z.infer<typeof rolePermissionsSchema>;

// ---------- Settings ----------

// Pattern tokens: {HOSP} {DEPT} {TYPE} {LOC} {SEQ:n}. {SEQ:n} is mandatory so IDs stay unique.
export const ASSET_PATTERN_TOKEN = /\{(HOSP|DEPT|TYPE|LOC|SEQ:[1-9])\}/g;

export const assetIdPatternSchema = z
  .string()
  .trim()
  .max(80)
  .refine((p) => /\{SEQ:[1-9]\}/.test(p), 'Pattern must contain {SEQ:n}, e.g. {SEQ:3}')
  .refine(
    (p) => !/[^A-Za-z0-9\-_/.]/.test(p.replace(ASSET_PATTERN_TOKEN, '')),
    'Only letters, digits and - _ / . are allowed outside tokens',
  );

export const updateSettingsSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  shortCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/).optional(),
  reminderDays: z.array(z.number().int().positive().max(365)).min(1).max(6).optional(),
  assetIdPattern: assetIdPatternSchema.optional(), // super admin only; rejected once locked
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export type SettingsResponse = {
  name: string;
  shortCode: string;
  assetIdPattern: string;
  patternLocked: boolean;
  reminderDays: number[];
};
