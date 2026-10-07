import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import multer from 'multer';
import type { Prisma } from '@prisma/client';
import {
  KEY_FIELDS,
  MAX_UPLOAD_BYTES,
  assetListQuerySchema,
  attachmentUploadSchema,
  createAssetSchema,
  purchaseOrderSchema,
  serviceContractSchema,
  updateAssetSchema,
  type AssetRow,
  type AttachmentRow,
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
import { idOf, validate } from '../../lib/validate';
import {
  CREATE_TX_OPTIONS,
  assertLocationInDepartment,
  assertSerialFree,
  assetInclude,
  createAssets,
  findScopedAsset,
  toAssetDetail,
  toAssetRow,
  warrantyEndFor,
} from './assets.service';

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

  const apply = canEditKey ? { ...changes, ...keyChanges } : changes;
  const data: Prisma.AssetUncheckedUpdateInput = { ...apply };
  if ('installationDate' in apply || 'warrantyMonths' in apply) {
    const installationDate = 'installationDate' in apply ? (apply.installationDate ? parseDate(apply.installationDate as string) : null) : before.installationDate;
    const months = 'warrantyMonths' in apply ? ((apply.warrantyMonths as number | null) ?? null) : before.warrantyMonths;
    data.installationDate = installationDate;
    data.warrantyMonths = months;
    data.warrantyEnd = warrantyEndFor(installationDate, months);
  }

  const requestKeyChange = hasKeyChanges && !canEditKey;
  if (Object.keys(apply).length === 0 && !requestKeyChange) {
    res.json({ asset: toAssetDetail(before), pendingApproval: false } satisfies UpdateAssetResponse);
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (Object.keys(apply).length > 0) {
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
    }
  });

  res.json({ asset: await detail(before.id), pendingApproval: requestKeyChange } satisfies UpdateAssetResponse);
});

// ---------- Timeline ----------

assetsRouter.get('/:id/timeline', requirePermission('asset.view'), async (req, res) => {
  const asset = await findScoped(req);
  const [orders, contracts, attachments, pms, calibrations, complaints] = await Promise.all([
    prisma.purchaseOrder.findMany({ where: { assetId: asset.id } }),
    prisma.serviceContract.findMany({ where: { assetId: asset.id } }),
    prisma.attachment.findMany({ where: { ownerType: 'asset', ownerId: asset.id } }),
    prisma.pmsRecord.findMany({ where: { assetId: asset.id } }),
    prisma.calibrationRecord.findMany({ where: { assetId: asset.id } }),
    prisma.complaint.findMany({ where: { assetId: asset.id } }),
  ]);

  const events: TimelineEvent[] = [
    { date: asset.createdAt.toISOString(), kind: 'registered', title: `Registered as ${asset.assetCode}` },
    ...orders.map((o): TimelineEvent => ({ date: isoDate(o.poDate), kind: 'purchase_order', title: `Purchase order ${o.poNumber}`, detail: o.vendor })),
    ...(asset.installationDate ? [{ date: isoDate(asset.installationDate), kind: 'installation', title: 'Installed' } satisfies TimelineEvent] : []),
    ...(asset.installationDate && asset.warrantyEnd
      ? [{ date: isoDate(asset.warrantyEnd), kind: 'warranty', title: 'Warranty ends', detail: `${asset.warrantyMonths} months from installation` } satisfies TimelineEvent]
      : []),
    ...contracts.flatMap((c): TimelineEvent[] => [
      { date: isoDate(c.startDate), kind: 'contract', title: `${c.type.toUpperCase()} contract starts`, detail: c.vendor },
      { date: isoDate(c.endDate), kind: 'contract', title: `${c.type.toUpperCase()} contract ends`, detail: c.vendor },
    ]),
    ...attachments.map((a): TimelineEvent => ({ date: a.createdAt.toISOString(), kind: 'document', title: `Document added: ${a.fileName || a.kind}` })),
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

// Decide the type from the file's own bytes; the browser's content-type and the file name are not trusted.
function sniff(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  return null;
}

const toAttachmentRow = (a: Prisma.AttachmentGetPayload<object>): AttachmentRow => ({
  id: a.id,
  kind: a.kind,
  fileName: a.fileName,
  mime: a.mime,
  size: a.size,
  createdAt: a.createdAt.toISOString(),
});

assetsRouter.get('/:id/attachments', requirePermission('asset.view'), async (req, res) => {
  const asset = await findScoped(req);
  const rows = await prisma.attachment.findMany({ where: { ownerType: 'asset', ownerId: asset.id }, orderBy: { createdAt: 'desc' } });
  res.json(rows.map(toAttachmentRow));
});

assetsRouter.post('/:id/attachments', requirePermission('asset.edit'), upload.single('file'), async (req, res) => {
  const asset = await findScoped(req);
  const { kind } = attachmentUploadSchema.parse(req.body);
  if (!req.file) throw new HttpError(400, 'Choose a file to upload');
  const type = sniff(req.file.buffer);
  if (!type) throw new HttpError(415, 'Only PDF, JPG and PNG files are allowed');

  // multer reads names as latin1; keep it readable and free of path characters.
  const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 150);
  const key = `assets/${asset.id}/${randomUUID()}.${type.ext}`;

  const storage = getStorage();
  await storage.put(key, req.file.buffer, type.mime);
  try {
    const row = await audited(req, { action: 'attachment.create', entityType: 'attachment' }, (tx) =>
      tx.attachment.create({
        data: { ownerType: 'asset', ownerId: asset.id, kind, fileName, filePath: key, mime: type.mime, size: req.file!.size, createdBy: currentUser(req).id },
      }),
    );
    res.status(201).json(toAttachmentRow(row));
  } catch (e) {
    await storage.remove(key).catch(() => undefined); // don't leave an orphan file behind
    throw e;
  }
});

// Files are private: they are only ever served through the API, after the same permission and
// department checks as the asset itself.
export const attachmentsRouter = Router();

attachmentsRouter.get('/:id/download', requirePermission('asset.view'), async (req, res) => {
  const file = await prisma.attachment.findUnique({ where: { id: idOf(req) } });
  if (!file || file.ownerType !== 'asset') throw new HttpError(404, 'File not found');
  const asset = await prisma.asset.findFirst({ where: { id: file.ownerId, ...departmentScope(currentUser(req)) } });
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
