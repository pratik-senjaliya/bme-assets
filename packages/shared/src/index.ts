// Types and zod schemas shared by apps/api and apps/web.
// Rule: every request body schema lives here so the API and the forms validate the same way.
import { z } from 'zod';

// Empty text from a form becomes null; undefined stays undefined so partial updates leave it alone.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' ? null : v));

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
  'notification.view',
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
  'notification.view',
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
  // Email is optional: hospital servers may have no internet. Without these, reminders stay in-app.
  smtpHost: optionalText(200),
  smtpPort: z.number().int().min(1).max(65535).nullish(),
  smtpUser: optionalText(200),
  smtpPassword: z.string().max(200).optional(), // write-only; empty or missing keeps the stored one
  smtpFrom: z.string().trim().email().nullish().or(z.literal('').transform(() => null)),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export type SettingsResponse = {
  name: string;
  shortCode: string;
  assetIdPattern: string;
  patternLocked: boolean;
  reminderDays: number[];
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpFrom: string | null;
  smtpPasswordSet: boolean;
};

// ---------- Assets ----------

export const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Criticality = (typeof CRITICALITIES)[number];
export const ASSET_STATUSES = ['active', 'not_in_use', 'condemned'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ATTACHMENT_KINDS = ['po', 'installation_report', 'photo', 'manual', 'certificate'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export const CONTRACT_TYPES = ['warranty', 'cmc', 'amc', 'in_house'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

// YYYY-MM-DD that is a real calendar date.
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-07')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a real date');

const assetFields = {
  equipmentTypeId: z.string().uuid(),
  name: z.string().trim().min(1, 'Enter a name').max(150),
  make: optionalText(100),
  model: optionalText(100),
  serialNo: optionalText(100),
  departmentId: z.string().uuid(),
  locationId: z.string().uuid(),
  criticality: z.enum(CRITICALITIES).default('medium'),
  installationDate: isoDateSchema.nullish(),
  warrantyMonths: z.number().int().min(0).max(240).nullish(),
  pmsFrequencyMonths: z.number().int().min(1).max(120).nullish(),
};

export const createAssetSchema = z.object(assetFields);
export type CreateAssetInput = z.infer<typeof createAssetSchema>;

// Condemnation goes through the approval flow, so it is not a status you can set here.
export const updateAssetSchema = z.object(assetFields).partial().extend({ status: z.enum(['active', 'not_in_use']).optional() });
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

// Changing these needs HOD approval (they decide the asset's identity and place).
export const KEY_FIELDS = ['serialNo', 'equipmentTypeId', 'departmentId', 'locationId'] as const;

export const assetListQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  departmentId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  equipmentTypeId: z.string().uuid().optional(),
  criticality: z.enum(CRITICALITIES).optional(),
  // Condemned and not-in-use assets leave the active list; ask for them explicitly.
  status: z.enum([...ASSET_STATUSES, 'all']).default('active'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type AssetListQuery = z.infer<typeof assetListQuerySchema>;

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

export type WarrantyStatus = 'none' | 'active' | 'expiring' | 'expired';

export type AssetRow = {
  id: string;
  assetCode: string;
  name: string;
  make: string | null;
  model: string | null;
  serialNo: string | null;
  equipmentTypeId: string;
  equipmentTypeName: string;
  departmentId: string;
  departmentName: string;
  locationId: string;
  locationName: string;
  criticality: Criticality;
  status: AssetStatus;
  installationDate: string | null;
  warrantyEnd: string | null;
  warrantyStatus: WarrantyStatus;
  ageMonths: number | null;
  nextPmsDue: string | null;
  nextCalibrationDue: string | null;
};

export type AssetDetail = AssetRow & {
  warrantyMonths: number | null;
  pmsFrequencyMonths: number | null;
  createdAt: string;
};

// Returned by PATCH /assets/:id. pendingApproval = key-field changes were sent to the HOD, not applied.
export type UpdateAssetResponse = { asset: AssetDetail; pendingApproval: boolean };

export const purchaseOrderSchema = z.object({
  poNumber: z.string().trim().min(1, 'Enter the PO number').max(60),
  poDate: isoDateSchema,
  vendor: z.string().trim().min(1, 'Enter the vendor').max(150),
  cost: z.number().min(0).max(1_000_000_000),
});
export type PurchaseOrderInput = z.infer<typeof purchaseOrderSchema>;
export type PurchaseOrderRow = { id: string; poNumber: string; poDate: string; vendor: string; cost: number };

export const serviceContractSchema = z
  .object({
    type: z.enum(CONTRACT_TYPES),
    vendor: z.string().trim().min(1, 'Enter the vendor').max(150),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    cost: z.number().min(0).max(1_000_000_000).nullish(),
  })
  .refine((c) => c.endDate >= c.startDate, { message: 'End date cannot be before the start date', path: ['endDate'] });
export type ServiceContractInput = z.infer<typeof serviceContractSchema>;
export type ServiceContractRow = {
  id: string;
  type: ContractType;
  vendor: string;
  startDate: string;
  endDate: string;
  cost: number | null;
};

export const attachmentUploadSchema = z.object({ kind: z.enum(ATTACHMENT_KINDS) });
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export type AttachmentRow = {
  id: string;
  kind: AttachmentKind | 'eol_letter';
  fileName: string;
  mime: string;
  size: number;
  createdAt: string;
};

export type TimelineEvent = {
  date: string; // ISO date or date-time
  kind: 'registered' | 'purchase_order' | 'installation' | 'warranty' | 'contract' | 'document' | 'pms' | 'calibration' | 'complaint';
  title: string;
  detail?: string | null;
};

export type ImportError = { row: number; field?: string; message: string };
export type ImportResult = { ok: boolean; dryRun: boolean; total: number; created: number; errors: ImportError[] };

// ---------- Complaints ----------

export const COMPLAINT_STATUSES = ['open', 'in_progress', 'resolved'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

// The department and the time are set by the server; the browser only says which asset and what is wrong.
export const createComplaintSchema = z.object({
  assetId: z.string().uuid('Choose the equipment'),
  description: z.string().trim().min(5, 'Describe the problem in a few words').max(2000),
});
export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;

export const resolveComplaintSchema = z.object({
  resolutionNotes: z.string().trim().min(3, 'Say what was done').max(2000),
});
export type ResolveComplaintInput = z.infer<typeof resolveComplaintSchema>;

export const complaintListQuerySchema = z.object({
  status: z.enum(COMPLAINT_STATUSES).optional(),
  assetId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ComplaintListQuery = z.infer<typeof complaintListQuerySchema>;

export type ComplaintRow = {
  id: string;
  complaintNo: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  criticality: Criticality;
  departmentId: string;
  departmentName: string;
  raisedByName: string;
  description: string;
  status: ComplaintStatus;
  raisedAt: string;
  startedAt: string | null;
  startedByName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNotes: string | null;
  // started − raised, resolved − raised (seconds); null until that step has happened.
  responseSeconds: number | null;
  downtimeSeconds: number | null;
};

// ---------- Service expenses ----------

export const EXPENSE_TYPES = ['repair', 'spare_part'] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];

export const createExpenseSchema = z.object({
  type: z.enum(EXPENSE_TYPES),
  description: z.string().trim().min(2, 'Describe what was paid for').max(500),
  amount: z.number().positive('Enter an amount above zero').max(1_000_000_000),
  date: isoDateSchema,
  vendor: optionalText(150),
  complaintId: z.string().uuid().nullish(),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export type ExpenseRow = {
  id: string;
  type: ExpenseType;
  description: string;
  amount: number;
  date: string;
  vendor: string | null;
  complaintId: string | null;
  complaintNo: string | null;
};
export type ExpenseList = { items: ExpenseRow[]; total: number };

// ---------- PMS (preventive maintenance) ----------

export const PMS_ITEM_TYPES = ['check', 'reading', 'text'] as const;
export type PmsItemType = (typeof PMS_ITEM_TYPES)[number];

// One line of a PMS checklist. check = Pass/Fail, reading = a number with an allowed range, text = remarks.
export const pmsItemSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,40}$/, 'Item id: lowercase letters, digits, _'),
    label: z.string().trim().min(1, 'Enter the item text').max(200),
    type: z.enum(PMS_ITEM_TYPES),
    unit: optionalText(20),
    min: z.number().nullish(),
    max: z.number().nullish(),
    required: z.boolean().default(true),
  })
  .refine((i) => i.min == null || i.max == null || i.min <= i.max, { message: 'Minimum is above the maximum', path: ['max'] });
export type PmsItem = z.infer<typeof pmsItemSchema>;

// A new version is created on every save; records keep the version they were done with.
export const pmsTemplateBodySchema = z
  .object({ equipmentTypeId: z.string().uuid(), items: z.array(pmsItemSchema).min(1, 'Add at least one item').max(60) })
  .refine((t) => new Set(t.items.map((i) => i.id)).size === t.items.length, { message: 'Item ids must be unique', path: ['items'] });
export type PmsTemplateBody = z.infer<typeof pmsTemplateBodySchema>;

export type PmsTemplateRow = {
  id: string;
  equipmentTypeId: string;
  equipmentTypeName: string;
  version: number;
  items: PmsItem[];
  createdAt: string;
};

export type PmsAnswer = 'pass' | 'fail' | number | string;

// The client sends answers only. The date, the person, the template version and the result are the server's.
export const submitPmsSchema = z
  .object({
    answers: z.record(z.string(), z.union([z.enum(['pass', 'fail']), z.number(), z.string().max(1000)])),
    correctsRecordId: z.string().uuid().nullish(),
    correctionReason: z.string().trim().min(5, 'Say why this correction is needed').max(500).nullish(),
  })
  .refine((v) => !v.correctsRecordId || !!v.correctionReason, { message: 'Say why this correction is needed', path: ['correctionReason'] });
export type SubmitPmsInput = z.infer<typeof submitPmsSchema>;

export type PmsResult = 'pass' | 'fail';

export type PmsRecordRow = {
  id: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  equipmentTypeName: string;
  templateVersion: number;
  items: PmsItem[];
  answers: Record<string, PmsAnswer>;
  performedOn: string; // set by the server in the hospital's timezone
  performedByName: string;
  submittedAt: string;
  result: PmsResult;
  locked: true;
  correctsRecordId: string | null;
  correctionReason: string | null;
  correctedByRecordId: string | null;
  hospitalName: string;
};

// ---------- Calibration ----------

export const CALIBRATION_RESULTS = ['pass', 'fail'] as const;

export const createCalibrationSchema = z
  .object({
    doneOn: isoDateSchema,
    dueOn: isoDateSchema.nullish(), // blank = done date + the equipment type's usual interval
    agency: z.string().trim().min(2, 'Enter the agency or engineer').max(150),
    result: z.enum(CALIBRATION_RESULTS),
  })
  .refine((c) => !c.dueOn || c.dueOn > c.doneOn, { message: 'Next due date must be after the calibration date', path: ['dueOn'] });
export type CreateCalibrationInput = z.infer<typeof createCalibrationSchema>;

export type CalibrationRow = {
  id: string;
  doneOn: string;
  dueOn: string;
  agency: string;
  result: PmsResult;
  certificate: { id: string; fileName: string } | null;
};

// ---------- Due lists ----------

export type DueRow = {
  assetId: string;
  assetCode: string;
  assetName: string;
  equipmentTypeName: string;
  departmentName: string;
  locationName: string;
  criticality: Criticality;
  dueDate: string;
  daysLeft: number; // negative = overdue
};

export const dueQuerySchema = z.object({ until: isoDateSchema.optional() });

// ---------- Notifications ----------

export const NOTIFICATION_TYPES = ['pms', 'calibration', 'warranty', 'contract'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationRow = {
  id: string;
  type: NotificationType;
  assetId: string | null;
  message: string;
  dueDate: string | null;
  thresholdDays: number | null;
  createdAt: string;
  readAt: string | null;
};
export type NotificationList = { items: NotificationRow[]; unread: number };

export const smtpTestSchema = z.object({ to: z.string().trim().email() });
export type RunRemindersResult = { created: number; emailed: number };
