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
  'complaint.assign',
  'complaint.hold',
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
  'consumable.manage',
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
  'consumable.manage',
];

// Defaults seeded into the DB; hospitals can adjust them later.
// The HOD's role always keeps these, so a mis-click in Roles cannot lock the hospital out of its own install.
export const ADMIN_KEEPS: PermissionCode[] = ['role.manage', 'user.manage', 'setup.manage', 'approval.decide'];

export const DEFAULT_ROLE_PERMISSIONS: Record<RoleName, readonly PermissionCode[]> = {
  // The vendor's super admin is audited like everyone and cannot bypass the HOD: its key-field edits,
  // condemnations and deletions are requests, and it cannot decide them.
  super_admin: PERMISSIONS.filter((p) => p !== 'asset.edit_key' && p !== 'approval.decide'),
  admin: PERMISSIONS.filter((p) => p !== 'settings.pattern'),
  biomed: BIOMED,
  nursing: ['asset.view', 'complaint.view', 'complaint.create', 'notification.view'],
};

// ---------- Auth ----------

// `email` takes the email or the short username (gap review #20: ward staff often have no email of their own).
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Enter your email or username').max(150),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(8, 'At least 8 characters').max(100),
  })
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'Choose a password different from the current one', path: ['newPassword'] });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// "Forgot password": the HOD is told and resets it (no email needed; hospital servers may have no internet).
export const forgotPasswordSchema = z.object({ login: z.string().trim().toLowerCase().min(1, 'Enter your email or username').max(150) });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: RoleName;
  roleLabel: string;
  departmentId: string | null;
  permissions: PermissionCode[];
  // Set when the HOD gives or resets a password: nothing else works until the person chooses their own.
  mustChangePassword: boolean;
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
  // A short sign-in name, e.g. "icu.sister1"; empty = sign in with the email only.
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,30}$/, '3–30 letters, digits, dots, dashes or underscores')
    .nullish()
    .or(z.literal('').transform(() => null)),
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
  username: string | null;
  mustChangePassword: boolean;
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
  criticalDowntimeHours: z.number().int().min(1).max(720).optional(),
  complaintCloseDays: z.number().int().min(1).max(30).optional(),
  transfersEnabled: z.boolean().optional(),
  // Who the wards call for a broken machine, shown to everyone (e.g. "Biomedical on call: 98250 00000, ext. 214").
  biomedContact: optionalText(200),
  // Shared ward PCs: sign out after this many minutes without use; 0 = never.
  idleLogoutMinutes: z.number().int().min(0).max(720).optional(),
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
  criticalDowntimeHours: number;
  complaintCloseDays: number;
  transfersEnabled: boolean;
  biomedContact: string | null;
  idleLogoutMinutes: number;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpFrom: string | null;
  smtpPasswordSet: boolean;
  // The last email attempt (reminders, monthly report, urgent complaints), so a mail server that stopped is noticed.
  mailLastSentAt: string | null;
  mailLastError: string | null;
  mailLastErrorAt: string | null;
  // Written by the nightly backup on the hospital server (deploy/backup.sh); all null where nothing backs up here.
  backupLastAt: string | null;
  backupLastError: string | null;
  backupLastErrorAt: string | null;
};

// ---------- Assets ----------

// Least to most critical. "Critical equipment" in figures, limits and reports means the top two levels.
export const CRITICALITIES = ['general', 'minor', 'critical', 'most_critical'] as const;
export type Criticality = (typeof CRITICALITIES)[number];
export const CRITICALITY_LABEL: Record<Criticality, string> = { general: 'General', minor: 'Minor', critical: 'Critical', most_critical: 'Most critical' };
export const CRITICAL_LEVELS: Criticality[] = ['critical', 'most_critical'];
export const isCritical = (c: string) => (CRITICAL_LEVELS as string[]).includes(c);
export const ASSET_STATUSES = ['active', 'not_in_use', 'condemned', 'transferred'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
// Gone from the hospital: condemned, or transferred to another unit (both with HOD approval). The record and its
// history stay, labelled, but nothing new can be added or changed (business rule 7).
export const GONE_STATUSES: AssetStatus[] = ['condemned', 'transferred'];
export const isGone = (status: string) => (GONE_STATUSES as string[]).includes(status);
export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = { active: 'Active', not_in_use: 'Not in use', condemned: 'Condemned', transferred: 'Transferred' };
export const ATTACHMENT_KINDS = ['po', 'installation_report', 'photo', 'manual', 'certificate', 'contract', 'service_report', 'invoice', 'condemnation_form', 'other'] as const;
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
  criticality: z.enum(CRITICALITIES).default('minor'),
  installationDate: isoDateSchema.nullish(),
  warrantyMonths: z.number().int().min(0).max(240).nullish(),
  pmsFrequencyMonths: z.number().int().min(1).max(120).nullish(),
  // Existing equipment: when PMS / calibration was last done before this system. The first due dates run from these.
  openingPmsOn: isoDateSchema.nullish(),
  openingCalibrationOn: isoDateSchema.nullish(),
  // From the suppliers directory: who sold it, and who services it.
  supplierId: z.string().uuid().nullish(),
  serviceVendorId: z.string().uuid().nullish(),
};

// Adding an asset may record its purchase order at the same time (gap review #13).
export const createAssetSchema = z.object(assetFields).extend({ purchaseOrder: z.lazy(() => purchaseOrderSchema).optional() });
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
  // failed = its latest PMS or calibration failed; unsafe = that, or an urgent fault not yet fixed (gap review).
  condition: z.enum(['failed', 'unsafe']).optional(),
  // Condemned and not-in-use assets leave the active list; ask for them explicitly.
  status: z.enum([...ASSET_STATUSES, 'all']).default('active'),
  sortBy: z.enum(['assetCode', 'name', 'department', 'criticality', 'nextPmsDue', 'status']).default('assetCode'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type AssetListQuery = z.infer<typeof assetListQuerySchema>;

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

// QR labels: the same filters as the register (no paging, sorted by asset ID), or a list of asset ids.
export const assetLabelsQuerySchema = assetListQuerySchema.omit({ sortBy: true, order: true, page: true, pageSize: true }).extend({
  ids: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(z.string().uuid()).max(1000).optional()),
});
// lastPmsOn / nextPmsDue are for the PMS sticker: the date the last PMS was done (the opening date when none is
// recorded yet) and when the next one is due.
export type AssetLabel = { id: string; assetCode: string; name: string; departmentName: string; locationName: string; lastPmsOn: string | null; nextPmsDue: string | null };
// At most MAX_LABELS in one print; `total` says how many matched, so the page can say when it is cut short.
export const MAX_LABELS = 1000;
export type AssetLabelsResponse = { hospitalName: string; items: AssetLabel[]; total: number };

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
  // Is it safe to use? Its unresolved complaints (oldest first) and a failed latest PMS / calibration (gap review).
  openComplaints: OpenComplaintRef[];
  pmsFailedOn: string | null;
  calibrationFailedOn: string | null;
};
export type OpenComplaintRef = { id: string; complaintNo: string; status: ComplaintStatus; urgent: boolean; raisedAt: string };

export type AssetDetail = AssetRow & {
  warrantyMonths: number | null;
  pmsFrequencyMonths: number | null;
  openingPmsOn: string | null;
  openingCalibrationOn: string | null;
  createdAt: string;
  supplier: VendorCard | null;
  serviceVendor: VendorCard | null;
};

// ---------- Suppliers ----------

// A company that sells or services equipment (manufacturer, distributor, service agency), with the people to call.
const optionalPhone = optionalText(30);
const optionalEmail = z.string().trim().max(150).email('Enter a valid email address').nullish().or(z.literal('').transform(() => null));
export const vendorContactSchema = z.object({
  name: z.string().trim().min(1, 'Enter the name').max(120),
  role: optionalText(80),
  phone: optionalPhone,
  email: optionalEmail,
});
export const vendorSchema = z.object({
  name: z.string().trim().min(2, 'Enter the company name').max(150),
  phone: optionalPhone,
  email: optionalEmail,
  address: optionalText(300),
  notes: optionalText(1000),
  contacts: z.array(vendorContactSchema).max(30, 'At most 30 contacts').default([]),
});
export type VendorInput = z.infer<typeof vendorSchema>;
export type VendorContactRow = { id: string; name: string; role: string | null; phone: string | null; email: string | null };
// What the asset page shows about its supplier / service vendor.
export type VendorCard = { id: string; name: string; phone: string | null; email: string | null; contacts: VendorContactRow[] };
export type VendorRow = VendorCard & { address: string | null; notes: string | null; suppliedCount: number; servicedCount: number };

// ---------- Consumables ----------

// Things the department keeps in stock and gives out (SpO2 probes, ECG leads, batteries, fuses...), counted in a
// unit, with an optional unit cost so spend shows in reports (decision F). Stock moves only through recorded
// movements: stock in on purchase, issue to a department, or a counted correction. Movements are never edited.
export const CONSUMABLE_UNITS = ['pcs', 'box', 'pack', 'pair', 'set', 'roll', 'bottle', 'metre'] as const;
// Movements can be dated back this far (a purchase entered from last week's invoice), never ahead.
export const CONSUMABLE_MAX_DAYS_BACK = 30;
const quantity = z.number({ invalid_type_error: 'Enter the quantity' }).int('Whole numbers only').min(1, 'At least 1').max(100_000);
const unitCost = z.number().min(0).max(10_000_000).nullish();
export const consumableItemSchema = z.object({
  name: z.string().trim().min(2, 'Enter the item name').max(150),
  unit: z.enum(CONSUMABLE_UNITS).default('pcs'),
  reorderLevel: z.number().int('Whole numbers only').min(0).max(100_000).default(0),
  unitCost,
  notes: optionalText(500),
  active: z.boolean().default(true),
});
export type ConsumableItemInput = z.infer<typeof consumableItemSchema>;
// A new item may start with what is on the shelf today.
export const newConsumableSchema = consumableItemSchema.extend({ openingStock: z.number().int().min(0).max(100_000).default(0) });
export const stockInSchema = z.object({
  quantity,
  date: isoDateSchema,
  unitCost,
  supplierId: z.string().uuid().nullish(),
  reference: optionalText(80), // invoice or PO number
  note: optionalText(300),
});
export type StockInInput = z.infer<typeof stockInSchema>;
export const issueSchema = z.object({
  quantity,
  date: isoDateSchema,
  departmentId: z.string({ required_error: 'Choose the department' }).uuid('Choose the department'),
  assetId: z.string().uuid().nullish(),
  complaintId: z.string().uuid().nullish(),
  reason: z.string().trim().min(3, 'Say why it was given (e.g. replaced the broken one)').max(300),
});
export type IssueInput = z.infer<typeof issueSchema>;
// A stock count that differs from the books: the change (plus or minus) and why.
export const stockAdjustSchema = z.object({
  change: z.number().int('Whole numbers only').min(-100_000).max(100_000).refine((n) => n !== 0, 'Enter how many more (+) or fewer (−) there are'),
  reason: z.string().trim().min(5, 'Say why the count is different').max(300),
});
export type StockAdjustInput = z.infer<typeof stockAdjustSchema>;

export type ConsumableKind = 'in' | 'out' | 'adjust';
export type ConsumableRow = {
  id: string;
  name: string;
  unit: (typeof CONSUMABLE_UNITS)[number];
  stock: number;
  reorderLevel: number;
  low: boolean; // at or below its reorder level (items with no reorder level are never low)
  unitCost: number | null;
  notes: string | null;
  active: boolean;
  lastIssuedOn: string | null;
};
export type ConsumableMovementRow = {
  id: string;
  kind: ConsumableKind;
  quantity: number; // signed: + into stock, − out of it
  stockAfter: number;
  date: string;
  unitCost: number | null;
  departmentName: string | null;
  asset: { id: string; assetCode: string; name: string } | null;
  complaint: { id: string; complaintNo: string } | null;
  supplierName: string | null;
  reference: string | null;
  reason: string | null;
  byName: string;
  createdAt: string;
};
export type ConsumableDetail = ConsumableRow & { movements: ConsumableMovementRow[] };
// A low or used-up item is worth a word where it is listed.
export const isLowStock = (i: { stock: number; reorderLevel: number }) => i.reorderLevel > 0 && i.stock <= i.reorderLevel;

// Returned by PATCH /assets/:id. pendingApproval = key-field changes were sent to the HOD, not applied.
export type UpdateAssetResponse = { asset: AssetDetail; pendingApproval: boolean };

export const purchaseOrderSchema = z.object({
  poNumber: z.string().trim().min(1, 'Enter the PO number').max(60),
  poDate: isoDateSchema,
  vendor: z.string().trim().min(1, 'Enter the vendor').max(150),
  cost: z.number().min(0).max(1_000_000_000),
});
export type PurchaseOrderInput = z.infer<typeof purchaseOrderSchema>;
// `cost` is left out for users who may not see costs (expense.manage), like nursing.
export type PurchaseOrderRow = { id: string; poNumber: string; poDate: string; vendor: string; cost?: number };

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
  cost?: number | null; // left out for users who may not see costs, as on PurchaseOrderRow
};

export const attachmentUploadSchema = z.object({ kind: z.enum(ATTACHMENT_KINDS) });

// Documents can hang off the asset or off one of its records (a complaint photo, a service report, an invoice).
export const ATTACHMENT_OWNER_TYPES = ['asset', 'complaint', 'service_log', 'service_expense', 'service_contract', 'purchase_order', 'calibration_record', 'pms_record'] as const;
export type AttachmentOwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];
export const attachmentOwnerSchema = z.object({ ownerType: z.enum(ATTACHMENT_OWNER_TYPES), ownerId: z.string().uuid() });
export const attachmentCreateSchema = attachmentOwnerSchema.extend({ kind: z.enum(ATTACHMENT_KINDS) });
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export type AttachmentRow = {
  id: string;
  kind: AttachmentKind | 'eol_letter';
  fileName: string;
  mime: string;
  size: number;
  createdAt: string;
  // The viewer may remove it (a photo added by mistake to a complaint that is still open).
  canRemove?: boolean;
};

export type TimelineEvent = {
  date: string; // ISO date or date-time
  kind: 'registered' | 'purchase_order' | 'installation' | 'warranty' | 'contract' | 'document' | 'pms' | 'calibration' | 'complaint' | 'service' | 'opening' | 'condemned' | 'transferred' | 'consumable';
  title: string;
  detail?: string | null;
};

export type ImportError = { row: number; field?: string; message: string };
export type ImportResult = { ok: boolean; dryRun: boolean; total: number; created: number; errors: ImportError[] };

// ---------- Complaints ----------

// Open → In progress (⇄ On hold, set and lifted by the HOD) → Resolved (downtime stops) → Closed (by whoever raised
// it, or by itself after the hospital's number of days). Escalating to the HOD is a flag on an in-progress complaint.
export const COMPLAINT_STATUSES = ['open', 'in_progress', 'on_hold', 'resolved', 'closed'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export const UNRESOLVED_STATUSES: ComplaintStatus[] = ['open', 'in_progress', 'on_hold'];
export const COMPLAINT_STATUS_LABEL: Record<ComplaintStatus, string> = { open: 'Open', in_progress: 'In progress', on_hold: 'On hold', resolved: 'Resolved', closed: 'Closed' };

// The department and the time are set by the server; the browser only says which asset and what is wrong.
export const createComplaintSchema = z.object({
  assetId: z.string().uuid('Choose the equipment'),
  description: z.string().trim().min(5, 'Describe the problem in a few words').max(2000),
  // The machine cannot be used or patient care is affected: listed first and emailed to the biomedical team.
  urgent: z.boolean().default(false),
});
export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;

// What it cost can be booked while resolving (parts, the OEM's bill): dated today, linked to the complaint.
export const resolveComplaintSchema = z.object({
  resolutionNotes: z.string().trim().min(3, 'Say what was done').max(2000),
  costs: z.array(z.lazy(() => expenseLineSchema)).max(10).default([]),
});
export type ResolveComplaintInput = z.infer<typeof resolveComplaintSchema>;

// Escalating to the HOD and putting on hold both say why (e.g. "Needs OEM support", "OEM engineer visits Monday").
export const complaintNoteSchema = z.object({ note: z.string().trim().min(3, 'Say why in a few words').max(1000) });
export type ComplaintNoteInput = z.infer<typeof complaintNoteSchema>;
// Back to work after a hold, or closing by whoever raised it: a note is optional.
export const optionalNoteSchema = z.object({ note: z.string().trim().max(1000).optional().transform((v) => v || undefined) }).default({});
export type OptionalNoteInput = z.infer<typeof optionalNoteSchema>;

export const complaintListQuerySchema = z.object({
  // 'unresolved' = open, in progress and on hold (someone's work list); 'done' = resolved and closed.
  status: z.enum([...COMPLAINT_STATUSES, 'unresolved', 'done']).optional(),
  // 'me' = raised by whoever is asking (their own complaints, e.g. the ones waiting for them to close).
  raisedBy: z.enum(['me']).optional(),
  // 'me' = resolved complaints the asker may close: raised by them, or in their own department (shift handover).
  closable: z.enum(['me']).optional(),
  // 'true' = escalated to the HOD and still waiting for them.
  escalated: z.enum(['true']).optional(),
  // 'me' = assigned to whoever is asking, 'none' = nobody yet, or one person's id.
  assignedTo: z.union([z.enum(['me', 'none']), z.string().uuid()]).optional(),
  assetId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  search: z.string().trim().max(100).optional(), // complaint no., asset ID or name, problem text
  from: isoDateSchema.optional(), // raised on or after (hospital date)
  to: isoDateSchema.optional(), // raised on or before
  sortBy: z.enum(['raisedAt', 'complaintNo', 'status']).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ComplaintListQuery = z.infer<typeof complaintListQuerySchema>;

// Assign a complaint to someone who can work on it, or (null) take the assignment away. The HOD may assign anyone;
// an engineer may only take an unassigned complaint for themselves.
export const assignComplaintSchema = z.object({ userId: z.string().uuid().nullable() });
export type AssignComplaintInput = z.infer<typeof assignComplaintSchema>;
// The people a complaint can be assigned to, with how many unresolved complaints each already has.
export type Assignee = { id: string; name: string; openCount: number };

export type ComplaintRow = {
  id: string;
  complaintNo: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  criticality: Criticality;
  departmentId: string;
  departmentName: string;
  raisedById: string;
  raisedByName: string;
  description: string;
  urgent: boolean;
  status: ComplaintStatus;
  // Escalated to the HOD and waiting for them (cleared once they put it on hold or back to work), with the reason.
  escalatedAt: string | null;
  escalationNote: string | null;
  holdNote: string | null; // why it is on hold now
  closedAt: string | null;
  closedByName: string | null; // null when it closed by itself
  closeNote: string | null;
  raisedAt: string;
  startedAt: string | null;
  startedByName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNotes: string | null;
  // Who is to fix it: set by the HOD, taken by an engineer, or the engineer who started work on it.
  assignedToId: string | null;
  assignedToName: string | null;
  assignedAt: string | null;
  // started − raised, resolved − raised (seconds); null until that step has happened.
  responseSeconds: number | null;
  downtimeSeconds: number | null;
  // Critical equipment that has been down (or is still down) for longer than the hospital's limit.
  overDowntimeLimit: boolean;
  attachmentCount: number;
};

export type ComplaintEvent = {
  at: string; // ISO date-time
  kind: 'raised' | 'assigned' | 'started' | 'escalated' | 'held' | 'resumed' | 'resolved' | 'reopened' | 'closed' | 'document' | 'expense';
  title: string;
  detail?: string | null;
  by?: string | null;
};

// One complaint with its whole story: who did what and when, the documents, and (for those allowed) the costs.
export type ComplaintDetail = ComplaintRow & {
  events: ComplaintEvent[];
  attachments: AttachmentRow[];
  expenses: { id: string; type: ExpenseType; description: string; amount: number; date: string }[];
};

// ---------- Service log ----------

export const SERVICE_KINDS = ['amc_visit', 'cmc_visit', 'repair', 'inspection', 'other'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const createServiceLogSchema = z.object({
  serviceDate: isoDateSchema,
  kind: z.enum(SERVICE_KINDS),
  vendor: optionalText(150),
  description: z.string().trim().min(3, 'Say what was done').max(1000),
});
export type CreateServiceLogInput = z.infer<typeof createServiceLogSchema>;

export type ServiceLogRow = {
  id: string;
  serviceDate: string;
  kind: ServiceKind;
  vendor: string | null;
  description: string;
  attachmentCount: number;
};

// ---------- Service expenses ----------

export const EXPENSE_TYPES = ['repair', 'spare_part'] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];

export const expenseLineSchema = z.object({
  type: z.enum(EXPENSE_TYPES),
  description: z.string().trim().min(2, 'Describe what was paid for').max(500),
  amount: z.number().positive('Enter an amount above zero').max(1_000_000_000),
  vendor: optionalText(150),
});
export type ExpenseLineInput = z.infer<typeof expenseLineSchema>;

export const createExpenseSchema = expenseLineSchema.extend({
  date: isoDateSchema,
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
const pmsAnswersSchema = z.record(z.string(), z.union([z.enum(['pass', 'fail']), z.number(), z.string().max(1000)]));
export const submitPmsSchema = z
  .object({
    answers: pmsAnswersSchema,
    correctsRecordId: z.string().uuid().nullish(),
    correctionReason: z.string().trim().min(5, 'Say why this correction is needed').max(500).nullish(),
  })
  .refine((v) => !v.correctsRecordId || !!v.correctionReason, { message: 'Say why this correction is needed', path: ['correctionReason'] });
export type SubmitPmsInput = z.infer<typeof submitPmsSchema>;

// PMS done by the OEM engineer (decision A). Sent as the `data` field of a form upload whose `file` is their
// report (required). The date is the visit date from the report: the server refuses one after today, more than
// OEM_PMS_MAX_DAYS_BACK days back, or before the asset's last PMS. Our checklist is optional: with answers the
// result is worked out from them, without answers the result is the one on the report. A correction keeps the
// original's date.
export const OEM_PMS_MAX_DAYS_BACK = 30;
export const oemPmsSchema = z
  .object({
    performedOn: isoDateSchema,
    serviceBy: z.string().trim().min(3, 'Enter the engineer and company, as on the report').max(150),
    result: z.enum(['pass', 'fail']).optional(),
    answers: pmsAnswersSchema.default({}),
    correctsRecordId: z.string().uuid().nullish(),
    correctionReason: z.string().trim().min(5, 'Say why this correction is needed').max(500).nullish(),
  })
  .refine((v) => !v.correctsRecordId || !!v.correctionReason, { message: 'Say why this correction is needed', path: ['correctionReason'] })
  .refine((v) => Object.keys(v.answers).length > 0 || !!v.result, { message: 'Choose the result on the report', path: ['result'] });
export type OemPmsInput = z.infer<typeof oemPmsSchema>;

export type PmsResult = 'pass' | 'fail';

export type PmsRecordRow = {
  id: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  equipmentTypeName: string;
  kind: 'in_house' | 'oem';
  serviceBy: string | null; // OEM: the engineer and company, as on the report
  report: { id: string; fileName: string } | null; // OEM: their service report
  templateVersion: number | null; // null: an OEM PMS without our checklist
  items: PmsItem[];
  answers: Record<string, PmsAnswer>;
  performedOn: string; // in-house: set by the server in the hospital's timezone; OEM: the visit date from the report
  performedByName: string; // who entered it
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
    // A record entered wrongly is corrected by a new one that replaces it (gap review #12); the original stays, marked.
    correctsRecordId: z.string().uuid().nullish(),
    correctionReason: z.string().trim().min(5, 'Say why this correction is needed').max(500).nullish(),
  })
  .refine((c) => !c.dueOn || c.dueOn > c.doneOn, { message: 'Next due date must be after the calibration date', path: ['dueOn'] })
  .refine((v) => !v.correctsRecordId || !!v.correctionReason, { message: 'Say why this correction is needed', path: ['correctionReason'] });
export type CreateCalibrationInput = z.infer<typeof createCalibrationSchema>;

export type CalibrationRow = {
  id: string;
  doneOn: string;
  dueOn: string;
  agency: string;
  result: PmsResult;
  certificates: { id: string; fileName: string }[]; // oldest first; an agency may send more than one
  correctsRecordId: string | null;
  correctionReason: string | null;
  correctedById: string | null; // replaced by this later record: no longer counts
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

// backup: the nightly backup failed or stopped; account: someone asks the HOD for a new password.
export const NOTIFICATION_TYPES = ['pms', 'calibration', 'warranty', 'contract', 'approval', 'complaint', 'report', 'stock', 'backup', 'account'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationRow = {
  id: string;
  type: NotificationType;
  assetId: string | null;
  complaintId: string | null; // a complaint notice opens the complaint
  message: string;
  dueDate: string | null;
  thresholdDays: number | null;
  createdAt: string;
  readAt: string | null;
};
export type NotificationList = { items: NotificationRow[]; unread: number };

export const smtpTestSchema = z.object({ to: z.string().trim().email() });
export type RunRemindersResult = { created: number; emailed: number };

// ---------- Approvals (business rule 3) ----------

export const APPROVAL_TYPES = ['condemn', 'delete', 'edit_key_field', 'transfer'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

// What a wrong entry can be: an asset created by mistake, or a record on one.
export const DELETABLE_TARGETS = ['asset', 'purchase_order', 'service_contract', 'service_expense', 'service_log', 'complaint'] as const;
export type DeletableTarget = (typeof DELETABLE_TARGETS)[number];

// The condemnation committee's form: why (one of the usual reasons, and in words), what the equipment is worth
// today, and the date the committee met. Sent as a form upload (with the optional end-of-life letter), so numbers
// arrive as text. The server refuses a committee date after today.
export const CONDEMN_REASONS = ['end_of_support', 'repair_cost', 'damaged', 'other'] as const;
export type CondemnReason = (typeof CONDEMN_REASONS)[number];
export const CONDEMN_REASON_LABEL: Record<CondemnReason, string> = {
  end_of_support: 'End of support: no spares or service from the OEM',
  repair_cost: 'Repair costs more than half its price',
  damaged: 'Damaged beyond repair',
  other: 'Other',
};
export const condemnRequestSchema = z.object({
  reasonCategory: z.enum(CONDEMN_REASONS, { message: 'Choose the reason' }),
  reason: z.string().trim().min(5, 'Say why it should be condemned').max(1000),
  estimatedValue: z.coerce.number({ message: 'Enter the estimated value today (0 if it has none)' }).min(0, 'Enter 0 or more').max(1_000_000_000),
  committeeDate: isoDateSchema,
});
export type CondemnRequestInput = z.infer<typeof condemnRequestSchema>;

// Permanently moved to another unit of the hospital group (e.g. "Indore unit"). Its record and history stay here,
// marked transferred; the other unit registers it afresh. Only where the hospital turns transfers on.
export const transferRequestSchema = z.object({
  toUnit: z.string().trim().min(2, 'Name the unit it goes to').max(150),
  reason: z.string().trim().min(5, 'Say why it is being transferred').max(1000),
});
export type TransferRequestInput = z.infer<typeof transferRequestSchema>;
export type TransferInfo = { toUnit: string; reason: string; requestedByName: string; approvedByName: string; approvedAt: string };

// What every signed-in person may know about the install: its name, and the optional parts it has turned on.
// What every signed-in user may know about the hospital's set-up.
export type HospitalInfo = { name: string; transfersEnabled: boolean; biomedContact: string | null; idleLogoutMinutes: number };

export const deleteRequestSchema = z.object({
  targetType: z.enum(DELETABLE_TARGETS),
  targetId: z.string().uuid(),
  reason: z.string().trim().min(5, 'Say why this entry is wrong').max(1000),
});
export type DeleteRequestInput = z.infer<typeof deleteRequestSchema>;

export const approveApprovalSchema = z.object({ note: optionalText(500) });
export type ApproveApprovalInput = z.infer<typeof approveApprovalSchema>;
export const rejectApprovalSchema = z.object({ reason: z.string().trim().min(3, 'Say why it is rejected').max(500) });
export type RejectApprovalInput = z.infer<typeof rejectApprovalSchema>;

export const approvalListQuerySchema = z.object({
  status: z.enum([...APPROVAL_STATUSES, 'all']).default('pending'),
  assetId: z.string().uuid().optional(),
});

export type ApprovalRow = {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  assetId: string | null;
  assetCode: string | null;
  assetName: string | null;
  summary: string; // what will change if approved, in words
  requestReason: string | null; // the requester's reason (condemn / delete)
  requestedByName: string;
  createdAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null; // approver's note, or the reason for rejecting
  selfApproved: boolean; // decided by the person who asked (a one-HOD hospital): shown, never hidden
};

export type CondemnationInfo = {
  hospitalName: string;
  reason: string;
  // The committee's form (null on requests made before it existed).
  reasonCategory: CondemnReason | null;
  estimatedValue: number | null;
  committeeDate: string | null;
  requestedByName: string;
  requestedAt: string;
  approvedByName: string;
  approvedAt: string;
  eolLetter: { id: string; fileName: string } | null;
};

// ---------- Charts and figures (dashboard and reports share these) ----------

// How a number reads: whole number, hours (1 decimal), rupees, percentage (0-1), years, a date, or plain text.
// datetime travels as an ISO instant and reads in hospital time (07 Oct 2026, 14:35).
export type ValueFmt = 'int' | 'hours' | 'money' | 'pct' | 'years' | 'date' | 'datetime' | 'text';

// A headline figure. `tone` colours only the hint, with words (never colour alone).
export type Kpi = { label: string; value: number | string | null; fmt: ValueFmt; hint?: string; tone?: 'good' | 'warn' | 'bad' | 'neutral' };

// One chart, described as data so the same spec draws on the dashboard, in a report and in the PDF.
// column = vertical bars, bar = horizontal bars, stacked = stacked columns, line = a line per series.
export type ChartSpec = {
  id: string;
  title: string;
  subtitle?: string;
  kind: 'column' | 'bar' | 'stacked' | 'line';
  series: { key: string; label: string }[];
  data: ({ label: string } & Record<string, number | string | null>)[];
  fmt: ValueFmt;
  // false: a table of the report already carries these numbers, so the PDF and Excel summaries leave the chart out.
  print?: false;
};

// pdf: false leaves a column out of the PDF only (a page cannot hold 17 columns); screen and Excel keep it.
export type ReportColumn = { header: string; key: string; fmt?: ValueFmt; width?: number; pdf?: boolean };
export type ReportSheetData = { name: string; columns: ReportColumn[]; rows: Record<string, string | number | null>[]; totals?: string[] };

// A report as data: the screen shows it, Excel and PDF are made from it.
export type ReportData = {
  type: string;
  title: string;
  hospital: string;
  from: string | null;
  to: string | null;
  group: 'month' | 'year' | 'fy' | null;
  generatedAt: string;
  generatedBy: string;
  note: string | null;
  // What the report covers beyond the period, in words ("Department: ICU", "Status: Active"); empty = the whole hospital.
  filters?: string[];
  kpis: Kpi[];
  charts: ChartSpec[];
  sheets: ReportSheetData[];
};

// ---------- Dashboard ----------

export type DashboardMonth = { month: string; label: string; breakdowns: number; downtimeHours: number };
export type DashboardDueItem = {
  kind: 'pms' | 'calibration';
  assetId: string;
  assetCode: string;
  assetName: string;
  dueDate: string;
  daysLeft: number; // negative = overdue
};
export type DashboardTopAsset = { assetId: string; assetCode: string; assetName: string; breakdowns: number; downtimeHours: number };
export type DashboardExpiry = { kind: 'warranty' | 'contract'; label: string; assetId: string; assetCode: string; assetName: string; date: string; daysLeft: number };
export type DashboardResponse = {
  scope: 'hospital' | 'department';
  departmentName: string | null;
  activeAssets: number;
  openComplaints: number; // open + in progress
  // null when the signed-in user's role does not see PMS / calibration / approvals
  dueThisMonth: number | null;
  overdue: number | null;
  pendingApprovals: number | null;
  dueSoon: DashboardDueItem[] | null;
  openList: ComplaintRow[];
  months: DashboardMonth[]; // last 6 months, oldest first
  // Second row of figures and the charts, in display order. What a role cannot see is simply not in the list.
  kpis: Kpi[];
  charts: ChartSpec[];
  topBreakdowns: DashboardTopAsset[] | null; // the equipment that broke down most in the last 12 months
  expiring: DashboardExpiry[] | null; // warranties and contracts ending within 60 days
};

// ---------- Reports (screen, Excel, PDF) ----------

export const REPORTS = [
  { type: 'asset-master', title: 'Asset master', description: 'Every asset with its department, location, criticality, status, warranty and next due dates. Condemned and not-in-use assets are included and labelled.', range: false },
  { type: 'pms', title: 'PMS records', description: 'Preventive maintenance done in the period, with a summary per equipment type.', range: true },
  { type: 'calibration', title: 'Calibration', description: 'Calibrations done in the period, and every active asset’s next calibration due date.', range: true },
  { type: 'breakdowns', title: 'Breakdowns', description: 'Complaints raised in the period with response time and downtime, summarised by month or year.', range: true, group: true },
  { type: 'uptime', title: 'Equipment uptime', description: 'Uptime per asset over the period, from complaint downtime (24 hours a day).', range: true },
  { type: 'critical-downtime', title: 'Downtime of critical equipment', description: 'Uptime and every downtime event for assets marked Critical or Most critical.', range: true },
  { type: 'equipment-age', title: 'Equipment age', description: 'Age of every asset, grouped into age bands and by equipment type.', range: false },
  { type: 'expenses', title: 'Service expenses', description: 'Repair and spare-part costs in the period, per asset and per month.', range: true },
  { type: 'condemnation', title: 'Condemnation register', description: 'Equipment condemned in the period, by committee date: reason, purchase cost, estimated value today and who approved it. The PDF is the committee’s form.', range: true },
  { type: 'warranty-contracts', title: 'Warranty and contracts', description: 'Warranties and AMC / CMC / in-house contracts: what is running, what ends soon and what has ended.', range: false },
  { type: 'consumables', title: 'Consumables register', description: 'Everything given out in the period (to which department, machine or complaint, and why), what was received, and the stock today with its value.', range: true },
] as const;
export type ReportType = (typeof REPORTS)[number]['type'];

// Report ranges: real dates in a sensible span (a mistyped year 0001 or 9999 is refused, not crunched).
const reportDateSchema = isoDateSchema.refine((s) => s >= '1900-01-01' && s <= '2100-12-31', 'Use a date between 1900 and 2100');

export const reportQuerySchema = z
  .object({
    from: reportDateSchema.optional(),
    to: reportDateSchema.optional(),
    // fy = Indian financial year, 1 April to 31 March.
    group: z.enum(['month', 'year', 'fy']).default('month'),
    // The same filters the lists use, so "Export" on a list gives what is on screen (asset master and breakdowns).
    search: z.string().trim().max(100).optional(),
    departmentId: z.string().uuid().optional(),
    equipmentTypeId: z.string().uuid().optional(),
    criticality: z.enum(CRITICALITIES).optional(),
    assetStatus: z.enum([...ASSET_STATUSES, 'all']).optional(),
    complaintStatus: z.enum(COMPLAINT_STATUSES).optional(),
    // json = for the screen; xlsx and pdf are downloads. Excel stays the default so existing links keep working.
    format: z.enum(['json', 'xlsx', 'pdf']).default('xlsx'),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'The start date is after the end date', path: ['from'] });

// ---------- Monthly management report ----------

// One calendar month, YYYY-MM, between 2000 and 2100. A month that has not started yet has nothing to report.
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-10')
  .refine((m) => m >= '2000-01' && m <= '2100-12', 'Use a month between 2000 and 2100');
export const monthlyReportQuerySchema = z.object({ month: monthSchema, format: z.enum(['json', 'xlsx', 'pdf']).default('json') });
// A month whose report was saved on the 1st of the next month (what management was sent), newest first.
export type SavedMonthlyReport = { month: string; savedAt: string };

// ---------- Audit pack ----------

// Evidence for an inspection (NABH and similar), for a period and optionally one department: one ZIP file.
export const auditPackQuerySchema = z
  .object({ from: reportDateSchema, to: reportDateSchema, departmentId: z.string().uuid().optional() })
  .refine((q) => q.from <= q.to, { message: 'The start date is after the end date', path: ['from'] })
  .refine((q) => q.to.slice(0, 4) <= String(Number(q.from.slice(0, 4)) + 5), { message: 'Choose a period of five years or less', path: ['to'] });
export type AuditPackQuery = z.infer<typeof auditPackQuerySchema>;
// What the pack will hold, shown before downloading.
export type AuditPackSummary = {
  assets: number;
  pmsRecords: number;
  calibrations: number;
  certificates: number;
  oemReports: number; // the OEM engineer's report for each PMS they did
  complaints: number;
  condemnations: number;
  documents: number; // condemnation letters and forms
};
export type ReportQuery = z.infer<typeof reportQuerySchema>;

// ---------- Audit log viewer ----------

export const auditQuerySchema = z.object({
  entityType: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(60).optional(),
  action: z.string().trim().max(60).optional(), // contains
  actorId: z.string().uuid().optional(),
  // Leave out routine sign-ins, sign-outs and exports (failed sign-ins and locks always stay).
  hideRoutine: z.enum(['true', 'false']).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export type AuditRow = {
  id: string;
  at: string;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null; // what the record is called: an asset code, a complaint number, a name
  before: unknown;
  after: unknown;
  ip: string | null;
};
