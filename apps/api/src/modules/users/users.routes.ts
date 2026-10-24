import { Router } from 'express';
import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import {
  ROLE_LABELS,
  UNRESOLVED_STATUSES,
  createUserSchema,
  DEPUTY_ROLES,
  ROLE_NAMES,
  type ImportError,
  type ImportResult,
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
import { facilityOn, usersWithPermissions } from '../../lib/people';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';
import { notify } from '../approvals/approvals.service';
import { subjectOf } from '../complaints/complaints.service';
import { readUpload, upload } from '../import/import.routes';

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
  deputy: u.deputy,
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
  const open = await tx.complaint.findMany({ where: { assignedToId: user.id, status: { in: UNRESOLVED_STATUSES } }, include: { asset: true, trade: true, location: true } });
  if (!open.length) return;
  await tx.complaint.updateMany({ where: { id: { in: open.map((c) => c.id) } }, data: { assignedToId: null, assignedAt: null, assignedBy: null } });
  await auditMany(tx, req, open.map((c) => ({ action: 'complaint.assign', entityType: 'complaint', entityId: c.id, before: { assignedToId: user.id }, after: { assignedToId: null, reason: 'user deactivated' } })));
  const hods = (await usersWithPermissions('complaint.assign', 'notification.view')).filter((id) => id !== user.id);
  for (const c of open) await notify(tx, hods, `${user.name} has left: complaint ${c.complaintNo} (${subjectOf(c)}) needs someone`, c.assetId, 'complaint', c.id);
}

// Maintenance staff work on facility equipment, so the role is only given while the add-on is on (decision K).
async function roleId(name: RoleName) {
  if (name === 'maintenance' && !(await facilityOn())) throw new HttpError(400, 'The facility maintenance add-on is not switched on', { fieldErrors: { role: ['Not available'] } });
  return (await prisma.role.findUniqueOrThrow({ where: { name } })).id;
}

usersRouter.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({ include, orderBy: { name: 'asc' } });
  res.json(users.map(toRow));
});

usersRouter.post('/', validate(createUserSchema), async (req, res) => {
  const { password, role, departmentId, deputy, ...rest } = req.body as CreateUserInput;
  guardSuperAdmin(currentUser(req).role, role);
  const data = {
    ...rest,
    deputy: DEPUTY_ROLES.includes(role) && !!deputy, // deputy HOD is for biomedical or maintenance staff only
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
  const { password, role, departmentId, deputy, ...rest } = req.body as UpdateUserInput;
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
    deputy: DEPUTY_ROLES.includes(role) && (deputy ?? before.deputy),
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
  if (password) await recordSuccess(before.email);
  res.json(toRow(await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include })));
});

// ---------- Import from Excel (gap review #26) ----------
// A department's logins at once: all rows or none, checked first (dry run). Everyone must change the first password.

const USER_COLUMNS = [
  { key: 'name', header: 'Name', required: true, width: 26 },
  { key: 'email', header: 'Email', required: true, width: 30 },
  { key: 'username', header: 'Username', width: 18 },
  { key: 'role', header: 'Role', required: true, width: 24 },
  { key: 'departmentCode', header: 'Department code', width: 18 },
  { key: 'password', header: 'First password', required: true, width: 18 },
] as const;
type UserColumn = (typeof USER_COLUMNS)[number]['key'];
const MAX_USER_ROWS = 300; // each password is hashed, which takes a moment
// The super admin is the vendor's and is never imported; maintenance staff only while the add-on is on.
const importRoles = async () => {
  const on = await facilityOn();
  return ROLE_NAMES.filter((r) => r !== 'super_admin' && (on || r !== 'maintenance'));
};

usersRouter.get('/import/template', async (_req, res) => {
  const IMPORT_ROLES = await importRoles();
  const departments = await prisma.department.findMany({ orderBy: { code: 'asc' } });
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Users', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = USER_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  sheet.getCell('C1').note = 'Optional short name to sign in with, e.g. icu.sister1 (3–30 letters, digits, dots, dashes).';
  sheet.getCell('E1').note = 'Nursing staff only: the department they belong to.';
  sheet.getCell('F1').note = 'At least 8 characters. They choose their own when they first sign in.';
  const lists = wb.addWorksheet('Lists');
  lists.addRow(['Role', 'Department code', 'Department']);
  lists.getRow(1).font = { bold: true };
  for (let i = 0; i < Math.max(IMPORT_ROLES.length, departments.length); i++) lists.addRow([IMPORT_ROLES[i] && ROLE_LABELS[IMPORT_ROLES[i]], departments[i]?.code, departments[i]?.name]);
  lists.columns.forEach((c) => (c.width = 26));
  for (let r = 2; r <= MAX_USER_ROWS + 1; r++) {
    sheet.getCell(r, 4).dataValidation = { type: 'list', allowBlank: true, formulae: [`Lists!$A$2:$A$${IMPORT_ROLES.length + 1}`] };
    if (departments.length) sheet.getCell(r, 5).dataValidation = { type: 'list', allowBlank: true, formulae: [`Lists!$B$2:$B$${departments.length + 1}`] };
  }
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="user-import-template.xlsx"',
  });
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

usersRouter.post('/import', upload.single('file'), async (req, res) => {
  const dryRun = req.query.dryRun === 'true';
  const IMPORT_ROLES = await importRoles();
  const rawRows = await readUpload(req, [...USER_COLUMNS], 'Users', MAX_USER_ROWS);
  const headerOf = Object.fromEntries(USER_COLUMNS.map((c) => [c.key, c.header])) as Record<UserColumn, string>;
  const [departments, existing] = await Promise.all([
    prisma.department.findMany(),
    prisma.user.findMany({ select: { email: true, username: true } }),
  ]);
  const taken = new Set(existing.flatMap((u) => [u.email, ...(u.username ? [u.username] : [])]));
  // A role written as on screen ("Nursing staff") or as stored (nursing).
  const roleOf = (v: string) => IMPORT_ROLES.find((r) => r === v.trim().toLowerCase() || ROLE_LABELS[r].toLowerCase() === v.trim().toLowerCase());

  const errors: ImportError[] = [];
  const valid: CreateUserInput[] = [];
  const seen = new Map<string, number>();
  for (const { row, values } of rawRows) {
    const role = roleOf(values.role);
    if (!role) errors.push({ row, field: headerOf.role, message: `Use one of: ${IMPORT_ROLES.map((r) => ROLE_LABELS[r]).join(', ')}` });
    const dept = values.departmentCode ? departments.find((d) => d.code === values.departmentCode.trim().toUpperCase()) : undefined;
    if (values.departmentCode && !dept) errors.push({ row, field: headerOf.departmentCode, message: `Unknown department "${values.departmentCode}"` });
    const parsed = createUserSchema.safeParse({ name: values.name, email: values.email, username: values.username || null, role: role ?? 'biomed', departmentId: dept?.id ?? null, password: values.password });
    if (!parsed.success) {
      const field: Record<string, UserColumn> = { departmentId: 'departmentCode' };
      for (const issue of parsed.error.issues) errors.push({ row, field: headerOf[field[String(issue.path[0])] ?? (issue.path[0] as UserColumn)], message: issue.message });
      continue;
    }
    for (const [key, value] of [['email', parsed.data.email], ['username', parsed.data.username]] as const) {
      if (!value) continue;
      if (taken.has(value)) errors.push({ row, field: headerOf[key], message: `${value} is already used by another login` });
      else if (seen.has(value)) errors.push({ row, field: headerOf[key], message: `Repeated from row ${seen.get(value)}` });
      else seen.set(value, row);
    }
    if (role) valid.push(parsed.data);
  }

  errors.sort((a, b) => a.row - b.row);
  const result: ImportResult = { ok: errors.length === 0, dryRun, total: rawRows.length, created: 0, errors };
  if (errors.length) {
    res.status(422).json(result);
    return;
  }
  if (!dryRun) {
    const me = currentUser(req).id;
    const data = await Promise.all(
      valid.map(async ({ password, role, departmentId, deputy: _deputy, ...rest }) => ({
        ...rest,
        roleId: await roleId(role),
        departmentId: role === 'nursing' ? departmentId : null,
        passwordHash: await bcrypt.hash(password, 10),
        mustChangePassword: true,
        createdBy: me,
      })),
    );
    await prisma.$transaction(async (tx) => {
      const rows = await tx.user.createManyAndReturn({ data });
      await auditMany(tx, req, [
        ...rows.map((u) => ({ action: 'user.create', entityType: 'user', entityId: u.id, after: u })),
        { action: 'user.import', entityType: 'user', after: { file: req.file!.originalname, count: rows.length } },
      ]);
      result.created = rows.length;
    });
  }
  res.json(result);
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
