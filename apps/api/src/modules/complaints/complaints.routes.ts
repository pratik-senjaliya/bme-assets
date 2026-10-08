import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  complaintListQuerySchema,
  createComplaintSchema,
  resolveComplaintSchema,
  type ComplaintRow,
  type CreateComplaintInput,
  type Paged,
  type ResolveComplaintInput,
} from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, departmentScope, requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { addDaysISO, zonedDayStart } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';
import { findScopedAsset } from '../assets/assets.service';
import { complaintInclude, complaintNo, toComplaintDetail, toComplaintRows } from './complaints.service';

export const complaintsRouter = Router();

// Nursing only sees its own department's complaints; a foreign id looks like a missing one.
async function findScoped(req: Request) {
  const complaint = await prisma.complaint.findFirst({
    where: { id: idOf(req), ...departmentScope(currentUser(req)) },
    include: complaintInclude,
  });
  if (!complaint) throw new HttpError(404, 'Complaint not found');
  return complaint;
}

const one = async (id: string): Promise<ComplaintRow> =>
  (await toComplaintRows([await prisma.complaint.findUniqueOrThrow({ where: { id }, include: complaintInclude })]))[0];

complaintsRouter.get('/', requirePermission('complaint.view'), async (req, res) => {
  const q = complaintListQuerySchema.parse(req.query);
  const where: Prisma.ComplaintWhereInput = {
    ...(q.status && { status: q.status }),
    ...(q.assetId && { assetId: q.assetId }),
    ...(q.departmentId && { departmentId: q.departmentId }),
    // Dates are the hospital's calendar days, not UTC days.
    ...((q.from || q.to) && { raisedAt: { ...(q.from && { gte: zonedDayStart(q.from) }), ...(q.to && { lt: zonedDayStart(addDaysISO(q.to, 1)) }) } }),
    ...(q.search && {
      OR: [
        { complaintNo: { contains: q.search, mode: 'insensitive' as const } },
        { description: { contains: q.search, mode: 'insensitive' as const } },
        { asset: { assetCode: { contains: q.search, mode: 'insensitive' as const } } },
        { asset: { name: { contains: q.search, mode: 'insensitive' as const } } },
      ],
    }),
    ...departmentScope(currentUser(req)), // last, so it cannot be widened from the query
  };
  // Waiting complaints: longest-waiting first. Resolved: most recent first. Mixed: newest first.
  const orderBy: Prisma.ComplaintOrderByWithRelationInput =
    q.status === 'open' || q.status === 'in_progress' ? { raisedAt: 'asc' } : q.status === 'resolved' ? { resolvedAt: 'desc' } : { raisedAt: 'desc' };
  const [total, rows] = await prisma.$transaction([
    prisma.complaint.count({ where }),
    prisma.complaint.findMany({ where, include: complaintInclude, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
  ]);
  const body: Paged<ComplaintRow> = { items: await toComplaintRows(rows), total, page: q.page, pageSize: q.pageSize };
  res.json(body);
});

complaintsRouter.get('/:id', requirePermission('complaint.view'), async (req, res) => {
  res.json(await toComplaintDetail(await findScoped(req), currentUser(req).permissions.includes('expense.manage')));
});

// The department comes from the asset and the time from the server, never from the request.
complaintsRouter.post('/', requirePermission('complaint.create'), validate(createComplaintSchema), async (req, res) => {
  const me = currentUser(req);
  const input = req.body as CreateComplaintInput;
  const asset = await findScopedAsset(req, input.assetId);
  if (asset.status === 'condemned') throw new HttpError(409, 'This equipment has been condemned, so complaints can no longer be raised for it');

  const created = await prisma.$transaction(async (tx) => {
    // Atomic counter on the settings row: concurrent complaints get distinct numbers.
    const { id } = await tx.hospitalSettings.findFirstOrThrow({ select: { id: true } });
    const { complaintSeq } = await tx.hospitalSettings.update({ where: { id }, data: { complaintSeq: { increment: 1 } } });
    const row = await tx.complaint.create({
      data: {
        complaintNo: complaintNo(complaintSeq),
        assetId: asset.id,
        raisedById: me.id,
        departmentId: asset.departmentId,
        description: input.description,
        createdBy: me.id,
      },
    });
    await audit(tx, req, { action: 'complaint.create', entityType: 'complaint', entityId: row.id, after: row });
    return row;
  });
  res.status(201).json(await one(created.id));
});

// Open → In progress → Resolved, one step at a time. The status check sits inside the UPDATE, so two
// people pressing the button at once cannot both succeed.
async function transition(req: Request, from: 'open' | 'in_progress', data: Prisma.ComplaintUncheckedUpdateManyInput, action: string, wrong: string) {
  const before = await findScoped(req);
  if (before.status !== from) throw new HttpError(409, wrong);
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.complaint.updateMany({ where: { id: before.id, status: from }, data });
    if (count === 0) throw new HttpError(409, wrong);
    const after = await tx.complaint.findUniqueOrThrow({ where: { id: before.id } });
    await audit(tx, req, { action, entityType: 'complaint', entityId: before.id, before, after });
    return after;
  });
}

complaintsRouter.post('/:id/start', requirePermission('complaint.start'), async (req, res) => {
  const row = await transition(
    req,
    'open',
    { status: 'in_progress', startedAt: new Date(), startedBy: currentUser(req).id },
    'complaint.start',
    'This complaint has already been started',
  );
  res.json(await one(row.id));
});

complaintsRouter.post('/:id/resolve', requirePermission('complaint.resolve'), validate(resolveComplaintSchema), async (req, res) => {
  const { resolutionNotes } = req.body as ResolveComplaintInput;
  const row = await transition(
    req,
    'in_progress',
    { status: 'resolved', resolvedAt: new Date(), resolvedBy: currentUser(req).id, resolutionNotes },
    'complaint.resolve',
    'Start the complaint before resolving it (or it is already resolved)',
  );
  res.json(await one(row.id));
});
