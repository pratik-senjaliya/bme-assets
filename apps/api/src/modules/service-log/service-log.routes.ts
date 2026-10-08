import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { createServiceLogSchema, type CreateServiceLogInput, type ServiceLogRow } from '@bme/shared';
import { audited } from '../../lib/audit';
import { currentUser, requirePermission } from '../../lib/auth';
import { isoDate, parseDate, todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { validate } from '../../lib/validate';
import { findScopedAsset } from '../assets/assets.service';

// Mounted under /assets: /assets/:id/service-logs. Service that is not a breakdown (an AMC visit, an in-house
// repair, an inspection), entered by hand. The asset lookup applies the department scope.
export const serviceLogRouter = Router();

const toRow = (l: Prisma.ServiceLogGetPayload<object>, attachmentCount: number): ServiceLogRow => ({
  id: l.id,
  serviceDate: isoDate(l.serviceDate),
  kind: l.kind,
  vendor: l.vendor,
  description: l.description,
  attachmentCount,
});

serviceLogRouter.get('/:id/service-logs', requirePermission('asset.view'), async (req, res) => {
  const asset = await findScopedAsset(req);
  const logs = await prisma.serviceLog.findMany({ where: { assetId: asset.id }, orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }] });
  const files = await prisma.attachment.groupBy({ by: ['ownerId'], where: { ownerType: 'service_log', ownerId: { in: logs.map((l) => l.id) } }, _count: true });
  res.json(logs.map((l) => toRow(l, files.find((f) => f.ownerId === l.id)?._count ?? 0)));
});

serviceLogRouter.post('/:id/service-logs', requirePermission('asset.edit'), validate(createServiceLogSchema), async (req, res) => {
  const asset = await findScopedAsset(req);
  const input = req.body as CreateServiceLogInput;
  if (asset.status === 'condemned') throw new HttpError(409, 'This equipment has been condemned, so service can no longer be logged');
  // Service already happened, so a past date is fine; a future one is not a record of anything.
  if (input.serviceDate > todayISO()) throw new HttpError(400, 'The service date cannot be in the future', { fieldErrors: { serviceDate: ['Cannot be in the future'] } });
  const row = await audited(req, { action: 'service_log.create', entityType: 'service_log' }, (tx) =>
    tx.serviceLog.create({
      data: { assetId: asset.id, serviceDate: parseDate(input.serviceDate), kind: input.kind, vendor: input.vendor ?? null, description: input.description, createdBy: currentUser(req).id },
    }),
  );
  res.status(201).json(toRow(row, 0));
});
