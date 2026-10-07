import { Router, type Request } from 'express';
import {
  departmentSchema,
  equipmentTypeSchema,
  locationSchema,
  type DepartmentInput,
  type EquipmentTypeInput,
  type LocationInput,
} from '@bme/shared';
import { audited } from '../../lib/audit';
import { currentUser, departmentScope, requirePermission } from '../../lib/auth';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';

export const setupRouter = Router();

const actor = (req: Request) => ({ createdBy: currentUser(req).id });

// Reads: any role that can view assets, but nursing only gets its own department's data.
// Writes: setup.manage (admin).

// ---------- Departments ----------

setupRouter.get('/departments', requirePermission('asset.view'), async (req, res) => {
  const { departmentId } = departmentScope(currentUser(req));
  res.json(await prisma.department.findMany({ where: departmentId ? { id: departmentId } : {}, orderBy: { name: 'asc' } }));
});

setupRouter.post('/departments', requirePermission('setup.manage'), validate(departmentSchema), async (req, res) => {
  const data = req.body as DepartmentInput;
  const row = await audited(req, { action: 'department.create', entityType: 'department' }, (tx) =>
    tx.department.create({ data: { ...data, ...actor(req) } }),
  );
  res.status(201).json(row);
});

setupRouter.patch('/departments/:id', requirePermission('setup.manage'), validate(departmentSchema.partial()), async (req, res) => {
  const before = await prisma.department.findUniqueOrThrow({ where: { id: idOf(req) } });
  const row = await audited(req, { action: 'department.update', entityType: 'department', before }, (tx) =>
    tx.department.update({ where: { id: before.id }, data: req.body }),
  );
  res.json(row);
});

setupRouter.delete('/departments/:id', requirePermission('setup.manage'), async (req, res) => {
  await audited(req, { action: 'department.delete', entityType: 'department' }, (tx) =>
    tx.department.delete({ where: { id: idOf(req) } }),
  );
  res.status(204).end();
});

// ---------- Locations ----------

setupRouter.get('/locations', requirePermission('asset.view'), async (req, res) => {
  const scope = departmentScope(currentUser(req));
  res.json(await prisma.location.findMany({ where: scope, orderBy: [{ departmentId: 'asc' }, { name: 'asc' }] }));
});

setupRouter.post('/locations', requirePermission('setup.manage'), validate(locationSchema), async (req, res) => {
  const data = req.body as LocationInput;
  const row = await audited(req, { action: 'location.create', entityType: 'location' }, (tx) =>
    tx.location.create({ data: { ...data, ...actor(req) } }),
  );
  res.status(201).json(row);
});

setupRouter.patch('/locations/:id', requirePermission('setup.manage'), validate(locationSchema.partial()), async (req, res) => {
  const before = await prisma.location.findUniqueOrThrow({ where: { id: idOf(req) } });
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

setupRouter.get('/equipment-types', requirePermission('asset.view'), async (_req, res) => {
  res.json(await prisma.equipmentType.findMany({ orderBy: { name: 'asc' } }));
});

setupRouter.post('/equipment-types', requirePermission('setup.manage'), validate(equipmentTypeSchema), async (req, res) => {
  const data = req.body as EquipmentTypeInput;
  const row = await audited(req, { action: 'equipment_type.create', entityType: 'equipment_type' }, (tx) =>
    tx.equipmentType.create({ data: { ...data, ...actor(req) } }),
  );
  res.status(201).json(row);
});

setupRouter.patch('/equipment-types/:id', requirePermission('setup.manage'), validate(equipmentTypeSchema.partial()), async (req, res) => {
  const before = await prisma.equipmentType.findUniqueOrThrow({ where: { id: idOf(req) } });
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
