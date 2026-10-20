import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { vendorSchema, type VendorInput, type VendorRow } from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, requireAnyPermission, requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';
import { toVendorCard } from '../assets/assets.service';

// The suppliers directory (meeting of Oct 2026): companies that sell and service equipment, with their contacts.
// Read by whoever registers or edits equipment (the asset form picks from it); changed by the same people; every
// change is audited. A company that equipment points to cannot be deleted.
export const vendorsRouter = Router();

const include = { contacts: { orderBy: { name: 'asc' } }, _count: { select: { supplied: true, serviced: true } } } satisfies Prisma.VendorInclude;
type Row = Prisma.VendorGetPayload<{ include: typeof include }>;
const toRow = (v: Row): VendorRow => ({ ...toVendorCard(v)!, address: v.address, notes: v.notes, suppliedCount: v._count.supplied, servicedCount: v._count.serviced });

const READ = requireAnyPermission('asset.create', 'asset.edit');

async function assertNameFree(name: string, exceptId?: string) {
  const clash = await prisma.vendor.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (clash) throw new HttpError(409, `${clash.name} is already in the list`, { fieldErrors: { name: [`${clash.name} is already in the list`] } });
}

const fields = (v: VendorInput) => ({ name: v.name, phone: v.phone ?? null, email: v.email ?? null, address: v.address ?? null, notes: v.notes ?? null });
const contactRows = (v: VendorInput) => v.contacts.map((c) => ({ name: c.name, role: c.role ?? null, phone: c.phone ?? null, email: c.email ?? null }));

vendorsRouter.get('/', READ, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const rows = await prisma.vendor.findMany({
    where: search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { contacts: { some: { name: { contains: search, mode: 'insensitive' } } } }] } : {},
    include,
    orderBy: { name: 'asc' },
    take: 500,
  });
  res.json(rows.map(toRow));
});

vendorsRouter.get('/:id', READ, async (req, res) => {
  const v = await prisma.vendor.findUnique({ where: { id: idOf(req) }, include });
  if (!v) throw new HttpError(404, 'Company not found');
  res.json(toRow(v));
});

vendorsRouter.post('/', requirePermission('asset.edit'), validate(vendorSchema), async (req, res) => {
  const input = req.body as VendorInput;
  await assertNameFree(input.name);
  const created = await prisma.$transaction(async (tx) => {
    const v = await tx.vendor.create({ data: { ...fields(input), createdBy: currentUser(req).id, contacts: { create: contactRows(input) } }, include });
    await audit(tx, req, { action: 'vendor.create', entityType: 'vendor', entityId: v.id, after: v });
    return v;
  });
  res.status(201).json(toRow(created));
});

// The contacts are sent whole and replace the old list, so the edit is one change in the audit log.
vendorsRouter.put('/:id', requirePermission('asset.edit'), validate(vendorSchema), async (req, res) => {
  const input = req.body as VendorInput;
  const before = await prisma.vendor.findUnique({ where: { id: idOf(req) }, include });
  if (!before) throw new HttpError(404, 'Company not found');
  await assertNameFree(input.name, before.id);
  const after = await prisma.$transaction(async (tx) => {
    await tx.vendorContact.deleteMany({ where: { vendorId: before.id } });
    const v = await tx.vendor.update({ where: { id: before.id }, data: { ...fields(input), contacts: { create: contactRows(input) } }, include });
    await audit(tx, req, { action: 'vendor.update', entityType: 'vendor', entityId: v.id, before, after: v });
    return v;
  });
  res.json(toRow(after));
});

vendorsRouter.delete('/:id', requirePermission('asset.edit'), async (req, res) => {
  const before = await prisma.vendor.findUnique({ where: { id: idOf(req) }, include });
  if (!before) throw new HttpError(404, 'Company not found');
  const used = before._count.supplied + before._count.serviced;
  if (used) throw new HttpError(409, `${before.name} is recorded on ${used} ${used === 1 ? 'piece' : 'pieces'} of equipment, so it stays in the list`);
  await prisma.$transaction(async (tx) => {
    await tx.vendor.delete({ where: { id: before.id } });
    await audit(tx, req, { action: 'vendor.delete', entityType: 'vendor', entityId: before.id, before });
  });
  res.status(204).end();
});
