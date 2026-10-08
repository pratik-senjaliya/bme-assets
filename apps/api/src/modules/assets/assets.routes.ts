import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  KEY_FIELDS,
  assetListQuerySchema,
  attachmentCreateSchema,
  attachmentOwnerSchema,
  attachmentUploadSchema,
  createAssetSchema,
  purchaseOrderSchema,
  serviceContractSchema,
  updateAssetSchema,
  type AssetRow,
  type AttachmentOwnerType,
  type PermissionCode,
  type CreateAssetInput,
  type Paged,
  type PurchaseOrderInput,
  type PurchaseOrderRow,
  type ServiceContractInput,
  type ServiceContractRow,
  type TimelineEvent,
  type UpdateAssetInput,
  type UpdateAssetResponse,
} from '@bme/shared';
import { audit, audited } from '../../lib/audit';
import { currentUser, departmentScope, requirePermission } from '../../lib/auth';
import { isoDate, parseDate } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { getStorage } from '../../lib/storage';
import { approvers, notify } from '../approvals/approvals.service';
import { assetIdOfOwner, storeAttachment, toAttachmentRow, upload } from './attachments.service';
import { idOf, validate } from '../../lib/validate';
import {
  CREATE_TX_OPTIONS,
  assertLocationInDepartment,
  assertOpeningDate,
  assertSerialFree,
  assetInclude,
  createAssets,
  findScopedAsset,
  firstDue,
  toAssetDetail,
  toAssetRow,
  warrantyEndFor,
} from './assets.service';

const SERVICE_LABEL = { amc_visit: 'AMC visit', cmc_visit: 'CMC visit', repair: 'Repair', inspection: 'Inspection', other: 'Other' } as const;

export const assetsRouter = Router();

const findScoped = (req: Request) => findScopedAsset(req);

const detail = async (id: string) =>
  toAssetDetail(await prisma.asset.findUniqueOrThrow({ where: { id }, include: assetInclude }));

// ---------- Register ----------

assetsRouter.get('/', requirePermission('asset.view'), async (req, res) => {
  const q = assetListQuerySchema.parse(req.query);
  const where: Prisma.AssetWhereInput = {
    ...(q.status === 'all' ? {} : { status: q.status }),
    ...(q.departmentId && { departmentId: q.departmentId }),
    ...(q.locationId && { locationId: q.locationId }),
    ...(q.equipmentTypeId && { equipmentTypeId: q.equipmentTypeId }),
    ...(q.criticality && { criticality: q.criticality }),
    ...(q.search && {
      OR: ['assetCode', 'name', 'serialNo', 'make', 'model'].map((f) => ({ [f]: { contains: q.search, mode: 'insensitive' as const } })),
    }),
    ...departmentScope(currentUser(req)), // last, so a nursing user cannot widen it with ?departmentId=
  };
  const [total, rows] = await prisma.$transaction([
    prisma.asset.count({ where }),
    prisma.asset.findMany({
      where,
      include: assetInclude,
      orderBy: { assetCode: 'asc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  const body: Paged<AssetRow> = { items: rows.map(toAssetRow), total, page: q.page, pageSize: q.pageSize };
  res.json(body);
});

assetsRouter.post('/', requirePermission('asset.create'), validate(createAssetSchema), async (req, res) => {
  const input = req.body as CreateAssetInput;
  await assertLocationInDepartment(input.departmentId, input.locationId);
  await assertSerialFree(input.serialNo);
  const [row] = await prisma.$transaction((tx) => createAssets(tx, req, [input]), CREATE_TX_OPTIONS);
  res.status(201).json(await detail(row.id));
});

assetsRouter.get('/:id', requirePermission('asset.view'), async (req, res) => {
  res.json(toAssetDetail(await findScoped(req)));
});

// Key fields (serial no., type, department, location) are a proposal unless the user may edit them
// directly (admin). The proposal waits in approval_requests for the HOD (Phase 5 adds the decision).
assetsRouter.patch('/:id', requirePermission('asset.edit'), validate(updateAssetSchema), async (req, res) => {
  const me = currentUser(req);
  const input = req.body as UpdateAssetInput;
  const before = await findScoped(req);
  if (before.status === 'condemned') throw new HttpError(409, 'A condemned asset can no longer be edited');

  const changes: Record<string, unknown> = {};
  const keyChanges: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if ((KEY_FIELDS as readonly string[]).includes(field)) {
      if (value !== (before as Record<string, unknown>)[field]) keyChanges[field] = value;
    } else {
      changes[field] = value;
    }
  }

  const hasKeyChanges = Object.keys(keyChanges).length > 0;
  const canEditKey = me.permissions.includes('asset.edit_key');
  if (hasKeyChanges && !canEditKey && !me.permissions.includes('asset.request_change')) {
    throw new HttpError(403, 'You do not have permission to change these fields');
  }
  if (hasKeyChanges) {
    const next = { departmentId: before.departmentId, locationId: before.locationId, ...keyChanges } as { departmentId: string; locationId: string };
    await assertLocationInDepartment(next.departmentId, next.locationId);
    if ('serialNo' in keyChanges) await assertSerialFree(keyChanges.serialNo as string | null, before.id);
  }

  // Opening dates are not columns to copy as strings: they set the first due date, and only while no real
  // PMS / calibration record exists (after that the records decide).
  const { openingPmsOn, openingCalibrationOn, ...plain } = changes as { openingPmsOn?: string | null; openingCalibrationOn?: string | null } & Record<string, unknown>;
  const apply = canEditKey ? { ...plain, ...keyChanges } : plain;
  const data: Prisma.AssetUncheckedUpdateInput = { ...apply };
  const installIso = 'installationDate' in apply ? (apply.installationDate as string | null) : before.installationDate ? isoDate(before.installationDate) : null;
  if (openingPmsOn !== undefined) {
    assertOpeningDate('openingPmsOn', openingPmsOn, installIso);
    if (await prisma.pmsRecord.count({ where: { assetId: before.id } })) throw new HttpError(409, 'PMS has already been recorded for this equipment, so the starting date can no longer be changed');
    const months = ('pmsFrequencyMonths' in apply ? (apply.pmsFrequencyMonths as number | null) : before.pmsFrequencyMonths) ?? null;
    const from = openingPmsOn ? parseDate(openingPmsOn) : before.installationDate;
    data.openingPmsOn = openingPmsOn ? parseDate(openingPmsOn) : null;
    data.nextPmsDue = firstDue(from, months);
  }
  if (openingCalibrationOn !== undefined) {
    assertOpeningDate('openingCalibrationOn', openingCalibrationOn, installIso);
    if (await prisma.calibrationRecord.count({ where: { assetId: before.id } })) throw new HttpError(409, 'Calibration has already been recorded for this equipment, so the starting date can no longer be changed');
    const from = openingCalibrationOn ? parseDate(openingCalibrationOn) : before.installationDate;
    data.openingCalibrationOn = openingCalibrationOn ? parseDate(openingCalibrationOn) : null;
    data.nextCalibrationDue = firstDue(from, before.equipmentType.defaultCalibrationMonths);
  }
  if ('installationDate' in apply || 'warrantyMonths' in apply) {
    const installationDate = 'installationDate' in apply ? (apply.installationDate ? parseDate(apply.installationDate as string) : null) : before.installationDate;
    const months = 'warrantyMonths' in apply ? ((apply.warrantyMonths as number | null) ?? null) : before.warrantyMonths;
    data.installationDate = installationDate;
    data.warrantyMonths = months;
    data.warrantyEnd = warrantyEndFor(installationDate, months);
  }

  const requestKeyChange = hasKeyChanges && !canEditKey;
  const touched = Object.keys(data).length > 0;
  if (!touched && !requestKeyChange) {
    res.json({ asset: toAssetDetail(before), pendingApproval: false } satisfies UpdateAssetResponse);
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (touched) {
      const after = await tx.asset.update({ where: { id: before.id }, data });
      await audit(tx, req, { action: 'asset.update', entityType: 'asset', entityId: before.id, before, after });
    }
    if (requestKeyChange) {
      const previous = Object.fromEntries(Object.keys(keyChanges).map((k) => [k, (before as Record<string, unknown>)[k]]));
      const request = await tx.approvalRequest.create({
        data: {
          type: 'edit_key_field',
          targetType: 'asset',
          targetId: before.id,
          payload: { changes: keyChanges as Prisma.InputJsonObject, previous: previous as Prisma.InputJsonObject },
          requestedBy: me.id,
          createdBy: me.id,
        },
      });
      await audit(tx, req, { action: 'approval.request', entityType: 'approval_request', entityId: request.id, after: request });
      await notify(tx, await approvers(), `${me.name} asks to change key details of ${before.assetCode} ${before.name}`, before.id);
    }
  });

  res.json({ asset: await detail(before.id), pendingApproval: requestKeyChange } satisfies UpdateAssetResponse);
});

// ---------- Timeline ----------

assetsRouter.get('/:id/timeline', requirePermission('asset.view'), async (req, res) => {
  const asset = await findScoped(req);
  const [orders, contracts, attachments, pms, calibrations, complaints, serviceLogs] = await Promise.all([
    prisma.purchaseOrder.findMany({ where: { assetId: asset.id } }),
    prisma.serviceContract.findMany({ where: { assetId: asset.id } }),
    prisma.attachment.findMany({ where: { ownerType: 'asset', ownerId: asset.id } }),
    prisma.pmsRecord.findMany({ where: { assetId: asset.id } }),
    prisma.calibrationRecord.findMany({ where: { assetId: asset.id } }),
    prisma.complaint.findMany({ where: { assetId: asset.id } }),
    prisma.serviceLog.findMany({ where: { assetId: asset.id } }),
  ]);

  const events: TimelineEvent[] = [
    { date: asset.createdAt.toISOString(), kind: 'registered', title: `Registered as ${asset.assetCode}` },
    ...orders.map((o): TimelineEvent => ({ date: isoDate(o.poDate), kind: 'purchase_order', title: `Purchase order ${o.poNumber}`, detail: o.vendor })),
    ...(asset.installationDate ? [{ date: isoDate(asset.installationDate), kind: 'installation', title: 'Installed' } satisfies TimelineEvent] : []),
    ...(asset.openingPmsOn ? [{ date: isoDate(asset.openingPmsOn), kind: 'opening', title: 'Last PMS before this system', detail: 'Entered when the equipment was registered' } satisfies TimelineEvent] : []),
    ...(asset.openingCalibrationOn ? [{ date: isoDate(asset.openingCalibrationOn), kind: 'opening', title: 'Last calibration before this system', detail: 'Entered when the equipment was registered' } satisfies TimelineEvent] : []),
    ...(asset.installationDate && asset.warrantyEnd
      ? [{ date: isoDate(asset.warrantyEnd), kind: 'warranty', title: 'Warranty ends', detail: `${asset.warrantyMonths} months from installation` } satisfies TimelineEvent]
      : []),
    ...contracts.flatMap((c): TimelineEvent[] => [
      { date: isoDate(c.startDate), kind: 'contract', title: `${c.type.toUpperCase()} contract starts`, detail: c.vendor },
      { date: isoDate(c.endDate), kind: 'contract', title: `${c.type.toUpperCase()} contract ends`, detail: c.vendor },
    ]),
    ...attachments.map((a): TimelineEvent => ({ date: a.createdAt.toISOString(), kind: 'document', title: `Document added: ${a.fileName || a.kind}` })),
    ...serviceLogs.map((l): TimelineEvent => ({ date: isoDate(l.serviceDate), kind: 'service', title: `Service: ${SERVICE_LABEL[l.kind]}`, detail: [l.vendor, l.description].filter(Boolean).join(' · ') })),
    ...pms.map((p): TimelineEvent => ({ date: isoDate(p.performedOn), kind: 'pms', title: 'PMS done', detail: p.result })),
    ...calibrations.map((c): TimelineEvent => ({ date: isoDate(c.doneOn), kind: 'calibration', title: 'Calibration done', detail: `${c.agency} · ${c.result}` })),
    ...complaints.flatMap((c): TimelineEvent[] => [
      { date: c.raisedAt.toISOString(), kind: 'complaint', title: `Complaint ${c.complaintNo} raised`, detail: c.description },
      ...(c.resolvedAt ? [{ date: c.resolvedAt.toISOString(), kind: 'complaint', title: `Complaint ${c.complaintNo} resolved` } satisfies TimelineEvent] : []),
    ]),
  ];
  events.sort((a, b) => b.date.localeCompare(a.date));
  res.json(events);
});

// ---------- Purchase orders & contracts ----------

assetsRouter.get('/:id/purchase-orders', requirePermission('asset.view'), async (req, res) => {
  const asset = await findScoped(req);
  const rows = await prisma.purchaseOrder.findMany({ where: { assetId: asset.id }, orderBy: { poDate: 'desc' } });
  res.json(rows.map((o): PurchaseOrderRow => ({ id: o.id, poNumber: o.poNumber, poDate: isoDate(o.poDate), vendor: o.vendor, cost: Number(o.cost) })));
});

assetsRouter.post('/:id/purchase-orders', requirePermission('asset.edit'), validate(purchaseOrderSchema), async (req, res) => {
  const asset = await findScoped(req);
  const input = req.body as PurchaseOrderInput;
  const row = await audited(req, { action: 'purchase_order.create', entityType: 'purchase_order' }, (tx) =>
    tx.purchaseOrder.create({ data: { ...input, poDate: parseDate(input.poDate), assetId: asset.id, createdBy: currentUser(req).id } }),
  );
  res.status(201).json({ id: row.id, poNumber: row.poNumber, poDate: isoDate(row.poDate), vendor: row.vendor, cost: Number(row.cost) } satisfies PurchaseOrderRow);
});

const toContractRow = (c: Prisma.ServiceContractGetPayload<object>): ServiceContractRow => ({
  id: c.id,
  type: c.type,
  vendor: c.vendor,
  startDate: isoDate(c.startDate),
  endDate: isoDate(c.endDate),
  cost: c.cost == null ? null : Number(c.cost),
});

assetsRouter.get('/:id/contracts', requirePermission('asset.view'), async (req, res) => {
  const asset = await findScoped(req);
  res.json((await prisma.serviceContract.findMany({ where: { assetId: asset.id }, orderBy: { endDate: 'desc' } })).map(toContractRow));
});

assetsRouter.post('/:id/contracts', requirePermission('asset.edit'), validate(serviceContractSchema), async (req, res) => {
  const asset = await findScoped(req);
  const input = req.body as ServiceContractInput;
  const row = await audited(req, { action: 'service_contract.create', entityType: 'service_contract' }, (tx) =>
    tx.serviceContract.create({
      data: { ...input, startDate: parseDate(input.startDate), endDate: parseDate(input.endDate), cost: input.cost ?? null, assetId: asset.id, createdBy: currentUser(req).id },
    }),
  );
  res.status(201).json(toContractRow(row));
});

// ---------- Attachments ----------

assetsRouter.get('/:id/attachments', requirePermission('asset.view'), async (req, res) => {
  const asset = await findScoped(req);
  const rows = await prisma.attachment.findMany({ where: { ownerType: 'asset', ownerId: asset.id }, orderBy: { createdAt: 'desc' } });
  res.json(rows.map(toAttachmentRow));
});

assetsRouter.post('/:id/attachments', requirePermission('asset.edit'), upload.single('file'), async (req, res) => {
  const asset = await findScoped(req);
  const { kind } = attachmentUploadSchema.parse(req.body);
  res.status(201).json(toAttachmentRow(await storeAttachment(req, { assetId: asset.id, ownerType: 'asset', ownerId: asset.id, kind })));
});

// Files are private: they are only ever served through the API, after the same permission and
// department checks as the asset itself.
export const attachmentsRouter = Router();

// Who may read / add documents on each kind of record. Costs and calibration stay with the staff who manage them;
// nursing can see and add photos on complaints of their own department only (asset scope applies to every file).
const READ_PERMISSION: Record<AttachmentOwnerType, PermissionCode> = {
  asset: 'asset.view',
  complaint: 'complaint.view',
  service_log: 'asset.view',
  service_expense: 'expense.manage',
  service_contract: 'asset.view',
  purchase_order: 'asset.view',
  calibration_record: 'calibration.manage',
};
const WRITE_PERMISSIONS: Record<AttachmentOwnerType, PermissionCode[]> = {
  asset: ['asset.edit'],
  complaint: ['complaint.create', 'complaint.start', 'complaint.resolve'],
  service_log: ['asset.edit'],
  service_expense: ['expense.manage'],
  service_contract: ['asset.edit'],
  purchase_order: ['asset.edit'],
  calibration_record: ['calibration.manage'],
};

// The owner's asset, loaded with the department scope: a foreign record looks like a missing one.
async function scopedOwnerAsset(req: Request, ownerType: AttachmentOwnerType, ownerId: string) {
  const assetId = await assetIdOfOwner(ownerType, ownerId);
  const asset = assetId ? await prisma.asset.findFirst({ where: { id: assetId, ...departmentScope(currentUser(req)) } }) : null;
  if (!asset) throw new HttpError(404, 'Not found');
  return asset;
}

attachmentsRouter.get('/', async (req, res) => {
  const { ownerType, ownerId } = attachmentOwnerSchema.parse(req.query);
  if (!currentUser(req).permissions.includes(READ_PERMISSION[ownerType])) throw new HttpError(403, 'You do not have permission to see these documents');
  await scopedOwnerAsset(req, ownerType, ownerId);
  const rows = await prisma.attachment.findMany({ where: { ownerType, ownerId }, orderBy: { createdAt: 'desc' } });
  res.json(rows.map(toAttachmentRow));
});

attachmentsRouter.post('/', upload.single('file'), async (req, res) => {
  const { ownerType, ownerId, kind } = attachmentCreateSchema.parse(req.body);
  const me = currentUser(req);
  if (!WRITE_PERMISSIONS[ownerType].some((p) => me.permissions.includes(p))) throw new HttpError(403, 'You do not have permission to add documents here');
  const asset = await scopedOwnerAsset(req, ownerType, ownerId);
  if (asset.status === 'condemned') throw new HttpError(409, 'This equipment has been condemned, so documents can no longer be added');
  if (ownerType === 'complaint') {
    const c = await prisma.complaint.findUniqueOrThrow({ where: { id: ownerId } });
    if (c.status === 'resolved') throw new HttpError(409, 'This complaint is resolved and closed, so documents can no longer be added');
  }
  res.status(201).json(toAttachmentRow(await storeAttachment(req, { assetId: asset.id, ownerType, ownerId, kind })));
});

attachmentsRouter.get('/:id/download', requirePermission('asset.view'), async (req, res) => {
  const file = await prisma.attachment.findUnique({ where: { id: idOf(req) } });
  if (!file) throw new HttpError(404, 'File not found');
  const need = READ_PERMISSION[file.ownerType as AttachmentOwnerType];
  if (need && !currentUser(req).permissions.includes(need)) throw new HttpError(404, 'File not found');
  // Files belong to an asset directly, or through one of its records (a certificate, a complaint photo, ...).
  const assetId = await assetIdOfOwner(file.ownerType, file.ownerId);
  const asset = assetId ? await prisma.asset.findFirst({ where: { id: assetId, ...departmentScope(currentUser(req)) } }) : null;
  if (!asset) throw new HttpError(404, 'File not found');

  const data = await getStorage().get(file.filePath);
  res.set({
    'Content-Type': file.mime,
    'Content-Length': String(data.length),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.fileName || 'file')}`,
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(data);
});
