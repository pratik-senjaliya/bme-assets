import { Router, type Request } from 'express';
import {
  departmentSchema,
  equipmentTypeSchema,
  locationSchema,
  type DepartmentInput,
  type EquipmentTypeInput,
  type HospitalInfo,
  type LocationInput,
  type Register,
} from '@bme/shared';
import { audited } from '../../lib/audit';
import { currentUser, departmentScope, requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';

export const setupRouter = Router();

const actor = (req: Request) => ({ createdBy: currentUser(req).id });

// Reads: any role that can view assets, but nursing only gets its own department's data.
// Writes: setup.manage (admin).

// ---------- The install ----------

// Its name and the optional parts it has turned on, for every signed-in person (the full settings are the admin's).
setupRouter.get('/hospital', requirePermission('asset.view'), async (_req, res) => {
  const s = await prisma.hospitalSettings.findFirstOrThrow({ select: { name: true, transfersEnabled: true, facilityEnabled: true, biomedContact: true, idleLogoutMinutes: true } });
  res.json(s satisfies HospitalInfo);
});

// ---------- Departments ----------

setupRouter.get('/departments', requirePermission('asset.view'), async (req, res) => {
  const { departmentId } = departmentScope(currentUser(req));
  res.json(await prisma.department.findMany({ where: departmentId ? { id: departmentId } : {}, orderBy: { name: 'asc' } }));
});

// Department, type and location codes are part of asset IDs (rule 2, when the pattern uses them). Once an asset's ID
// carries a code it can no longer change, or new IDs would disagree with the old ones. Names can always change.
async function assertCodeFree(token: '{DEPT}' | '{TYPE}' | '{LOC}', changing: boolean, inUse: () => Promise<number>, what: string) {
  if (!changing) return;
  const settings = await prisma.hospitalSettings.findFirst();
  if (settings?.assetIdPattern.includes(token) && (await inUse())) {
    throw new HttpError(409, `This ${what} code is part of asset IDs already given out, so it can no longer be changed. The name can still be changed.`, { fieldErrors: { code: ['Locked: asset IDs already use it'] } });
  }
}

// Two locations in one department with the same code would make the location part of an asset ID ambiguous.
async function assertLocationCodeFree(departmentId: string, code: string | null | undefined, exceptId?: string) {
  if (!code) return;
  const clash = await prisma.location.findFirst({ where: { departmentId, code: { equals: code, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (clash) throw new HttpError(409, `${clash.name} already uses the code ${clash.code} in this department`, { fieldErrors: { code: ['Already used in this department'] } });
}

setupRouter.post('/departments', requirePermission('setup.manage'), validate(departmentSchema), async (req, res) => {
  const data = req.body as DepartmentInput;
  const row = await audited(req, { action: 'department.create', entityType: 'department' }, (tx) =>
    tx.department.create({ data: { ...data, ...actor(req) } }),
  );
  res.status(201).json(row);
});

setupRouter.patch('/departments/:id', requirePermission('setup.manage'), validate(departmentSchema.partial()), async (req, res) => {
  const before = await prisma.department.findUniqueOrThrow({ where: { id: idOf(req) } });
  const body = req.body as Partial<DepartmentInput>;
  await assertCodeFree('{DEPT}', body.code !== undefined && body.code !== before.code, () => prisma.asset.count({ where: { departmentId: before.id } }), 'department');
  const row = await audited(req, { action: 'department.update', entityType: 'department', before }, (tx) =>
    tx.department.update({ where: { id: before.id }, data: req.body }),
  );
  res.json(row);
});

setupRouter.delete('/departments/:id', requirePermission('setup.manage'), async (req, res) => {
  await audited(req, { action: 'department.delete', entityType: 'department' }, async (tx) => {
    // Nursing logins belong to a department; removing it would leave them signed in to nothing.
    const users = await tx.user.count({ where: { departmentId: idOf(req) } });
    if (users) throw new HttpError(409, `This department is in use: ${users} ${users === 1 ? 'login belongs' : 'logins belong'} to it. Move or remove ${users === 1 ? 'that login' : 'those logins'} first.`);
    return tx.department.delete({ where: { id: idOf(req) } });
  });
  res.status(204).end();
});

// ---------- Locations ----------

setupRouter.get('/locations', requirePermission('asset.view'), async (req, res) => {
  const scope = departmentScope(currentUser(req));
  res.json(await prisma.location.findMany({ where: scope, orderBy: [{ departmentId: 'asc' }, { name: 'asc' }] }));
});

setupRouter.post('/locations', requirePermission('setup.manage'), validate(locationSchema), async (req, res) => {
  const data = req.body as LocationInput;
  await assertLocationCodeFree(data.departmentId, data.code);
  const row = await audited(req, { action: 'location.create', entityType: 'location' }, (tx) =>
    tx.location.create({ data: { ...data, ...actor(req) } }),
  );
  res.status(201).json(row);
});

setupRouter.patch('/locations/:id', requirePermission('setup.manage'), validate(locationSchema.partial()), async (req, res) => {
  const before = await prisma.location.findUniqueOrThrow({ where: { id: idOf(req) } });
  const body = req.body as Partial<LocationInput>;
  const assets = () => prisma.asset.count({ where: { locationId: before.id } });
  // Its equipment belongs to its department; moving the location alone would split them (and bypass HOD approval).
  if (body.departmentId !== undefined && body.departmentId !== before.departmentId && (await assets())) {
    throw new HttpError(409, 'Equipment is registered at this location, so it cannot move to another department. Move the equipment first (with HOD approval), or add a new location.', { fieldErrors: { departmentId: ['Equipment is registered here'] } });
  }
  await assertCodeFree('{LOC}', body.code !== undefined && body.code !== before.code, assets, 'location');
  // Checked only when the code or the department changes, so a name can always be fixed even where old data
  // already has two locations sharing a code.
  if ((body.code !== undefined && body.code !== before.code) || (body.departmentId !== undefined && body.departmentId !== before.departmentId)) {
    await assertLocationCodeFree(body.departmentId ?? before.departmentId, body.code ?? before.code, before.id);
  }
  const row = await audited(req, { action: 'location.update', entityType: 'location', before }, (tx) =>
    tx.location.update({ where: { id: before.id }, data: req.body }),
  );
  res.json(row);
});

setupRouter.delete('/locations/:id', requirePermission('setup.manage'), async (req, res) => {
  await audited(req, { action: 'location.delete', entityType: 'location' }, (tx) =>
    tx.location.delete({ where: { id: idOf(req) } }),
  );
  res.status(204).end();
});

// ---------- Equipment types ----------

// Each type with its latest PMS checklist version (null: none yet, so PMS cannot be recorded for it; gap review #21).
// Only the registers the person works on (the facility types stay out of sight while the add-on is off).
setupRouter.get('/equipment-types', requirePermission('asset.view'), async (req, res) => {
  const [types, versions] = await Promise.all([
    prisma.equipmentType.findMany({ where: { register: { in: currentUser(req).registers } }, orderBy: { name: 'asc' } }),
    prisma.pmsTemplate.groupBy({ by: ['equipmentTypeId'], _max: { version: true } }),
  ]);
  const latest = new Map(versions.map((v) => [v.equipmentTypeId, v._max.version]));
  res.json(types.map((t) => ({ ...t, checklistVersion: latest.get(t.id) ?? null })));
});

// A type's register can be set while the add-on is on, and changed only while no equipment is of that type (a machine
// never changes team; decision G).
async function assertRegisterChoice(req: Request, register: Register | undefined, changing: boolean, inUse: () => Promise<number>) {
  if (!register || !changing) return;
  if (!currentUser(req).registers.includes(register)) throw new HttpError(400, 'Facility equipment is not switched on for this hospital', { fieldErrors: { register: ['Not available'] } });
  if (await inUse()) throw new HttpError(409, 'Equipment of this type is already registered, so it stays with its team', { fieldErrors: { register: ['Locked: equipment of this type exists'] } });
}

setupRouter.post('/equipment-types', requirePermission('setup.manage'), validate(equipmentTypeSchema), async (req, res) => {
  const data = req.body as EquipmentTypeInput;
  await assertRegisterChoice(req, data.register, data.register !== undefined && data.register !== 'biomedical', async () => 0);
  const row = await audited(req, { action: 'equipment_type.create', entityType: 'equipment_type' }, (tx) =>
    tx.equipmentType.create({ data: { ...data, ...actor(req) } }),
  );
  res.status(201).json(row);
});

setupRouter.patch('/equipment-types/:id', requirePermission('setup.manage'), validate(equipmentTypeSchema.partial()), async (req, res) => {
  const before = await prisma.equipmentType.findUniqueOrThrow({ where: { id: idOf(req) } });
  const body = req.body as Partial<EquipmentTypeInput>;
  await assertCodeFree('{TYPE}', body.code !== undefined && body.code !== before.code, () => prisma.asset.count({ where: { equipmentTypeId: before.id } }), 'equipment type');
  await assertRegisterChoice(req, body.register, body.register !== undefined && body.register !== before.register, () => prisma.asset.count({ where: { equipmentTypeId: before.id } }));
  const row = await audited(req, { action: 'equipment_type.update', entityType: 'equipment_type', before }, (tx) =>
    tx.equipmentType.update({ where: { id: before.id }, data: req.body }),
  );
  res.json(row);
});

setupRouter.delete('/equipment-types/:id', requirePermission('setup.manage'), async (req, res) => {
  await audited(req, { action: 'equipment_type.delete', entityType: 'equipment_type' }, (tx) =>
    tx.equipmentType.delete({ where: { id: idOf(req) } }),
  );
  res.status(204).end();
});
