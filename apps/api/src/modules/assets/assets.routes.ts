import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  assetLabelsQuerySchema,
  assetListQuerySchema,
  attachmentCreateSchema,
  attachmentOwnerSchema,
  attachmentUploadSchema,
  createAssetSchema,
  isGone,
  KEY_FIELDS,
  MAX_LABELS,
  purchaseOrderSchema,
  serviceContractSchema,
  UNRESOLVED_STATUSES,
  updateAssetSchema,
  type AssetLabelsResponse,
  type AssetListQuery,
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
import { moveOpenComplaints } from '../complaints/complaints.service';
import { clearReminders } from '../reminders/reminders.service';
import { assetIdOfOwner, storeAttachment, toAttachmentRow, upload } from './attachments.service';
import { idOf, validate } from '../../lib/validate';
import {
  CREATE_TX_OPTIONS,
  SCHEDULE_FIELDS,
  scheduleFor,
  assertLocationInDepartment,
  assertOpeningDate,
  assertSerialFree,
  assertVendors,
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

// Sorting for the register. Equipment with no due date goes last either way; the asset code breaks ties so pages are stable.
function assetOrder(by: AssetListQuery['sortBy'], order: 'asc' | 'desc'): Prisma.AssetOrderByWithRelationInput[] {
  const first: Prisma.AssetOrderByWithRelationInput =
    by === 'department' ? { department: { name: order } } : by === 'nextPmsDue' ? { nextPmsDue: { sort: order, nulls: 'last' } } : { [by]: order };
  return by === 'assetCode' ? [first] : [first, { assetCode: 'asc' }];
}

const detail = async (id: string) =>
  toAssetDetail(await prisma.asset.findUniqueOrThrow({ where: { id }, include: assetInclude }));

// ---------- Register ----------

// The register's filters, shared with the QR label sheet so a printed sheet matches the list on screen.
const registerWhere = (req: Request, q: Omit<AssetListQuery, 'sortBy' | 'order' | 'page' | 'pageSize'>): Prisma.AssetWhereInput => ({
  ...(q.status === 'all' ? {} : { status: q.status }),
  ...(q.departmentId && { departmentId: q.departmentId }),
  ...(q.locationId && { locationId: q.locationId }),
  ...(q.equipmentTypeId && { equipmentTypeId: q.equipmentTypeId }),
  ...(q.criticality && { criticality: q.criticality }),
  ...(q.search && {
    OR: ['assetCode', 'name', 'serialNo', 'make', 'model'].map((f) => ({ [f]: { contains: q.search, mode: 'insensitive' as const } })),
  }),
  ...(q.condition && { AND: [CONDITION[q.condition]] }),
  ...departmentScope(currentUser(req)), // last, so a nursing user cannot widen it with ?departmentId=
});
const FAILED: Prisma.AssetWhereInput[] = [{ pmsFailedOn: { not: null } }, { calibrationFailedOn: { not: null } }];
const CONDITION: Record<NonNullable<AssetListQuery['condition']>, Prisma.AssetWhereInput> = {
  failed: { OR: FAILED },
  unsafe: { OR: [...FAILED, { complaints: { some: { status: { in: UNRESOLVED_STATUSES }, urgent: true } } }] },
};

assetsRouter.get('/', requirePermission('asset.view'), async (req, res) => {
  const q = assetListQuerySchema.parse(req.query);
  const where = registerWhere(req, q);
  const [total, rows] = await prisma.$transaction([
    prisma.asset.count({ where }),
    prisma.asset.findMany({
      where,
      include: assetInclude,
      orderBy: assetOrder(q.sortBy, q.order),
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
  await assertVendors(input);
  const [row] = await prisma.$transaction((tx) => createAssets(tx, req, [input]), CREATE_TX_OPTIONS);
  res.status(201).json(await detail(row.id));
});

// ---------- QR labels ----------

// What to print on a sheet of labels: the listed ids, or everything the register's filters match. For the people
// who look after the equipment (asset.edit), not for departments that only see it.
assetsRouter.get('/labels', requirePermission('asset.edit'), async (req, res) => {
  const { ids, ...q } = assetLabelsQuerySchema.parse(req.query);
  const where: Prisma.AssetWhereInput = ids ? { id: { in: ids }, ...departmentScope(currentUser(req)) } : registerWhere(req, q);
  const [total, rows, settings] = await Promise.all([
    prisma.asset.count({ where }),
    prisma.asset.findMany({ where, include: { department: true, location: true }, orderBy: { assetCode: 'asc' }, take: MAX_LABELS }),
    prisma.hospitalSettings.findFirstOrThrow(),
  ]);
  // The day the PMS was done: a correction is filed later but is about the same PMS, so only originals count.
  const done = await prisma.pmsRecord.groupBy({ by: ['assetId'], where: { assetId: { in: rows.map((a) => a.id) }, correctsRecordId: null }, _max: { performedOn: true } });
  const lastPms = new Map(done.map((d) => [d.assetId, d._max.performedOn]));
  const day = (d: Date | null | undefined) => (d ? isoDate(d) : null);
  const body: AssetLabelsResponse = {
    hospitalName: settings.name,
    total,
    items: rows.map((a) => ({
      id: a.id, assetCode: a.assetCode, name: a.name, departmentName: a.department.name, locationName: a.location.name,
      lastPmsOn: day(lastPms.get(a.id) ?? a.openingPmsOn), nextPmsDue: day(a.nextPmsDue),
    })),
  };
  res.json(body);
});

// A scanned label: the asset ID printed on it, to the record. Department scope applies as everywhere, so a label
// on another department's equipment reads as not found for nursing staff.
assetsRouter.get('/by-code/:code', requirePermission('asset.view'), async (req, res) => {
  const asset = await prisma.asset.findFirst({ where: { assetCode: String(req.params.code), ...departmentScope(currentUser(req)) }, select: { id: true } });
  if (!asset) throw new HttpError(404, 'No equipment with this label');
  res.json(asset);
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
  if (isGone(before.status)) throw new HttpError(409, `A ${before.status} asset can no longer be edited`);
  await assertVendors(input);

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

  if (SCHEDULE_FIELDS.some((f) => f in data)) {
    const pick = <K extends (typeof SCHEDULE_FIELDS)[number]>(k: K) => (k in data ? data[k] : before[k]) as (typeof before)[K];
    Object.assign(
      data,
      await scheduleFor(prisma, {
        id: before.id,
        equipmentTypeId: pick('equipmentTypeId'),
        installationDate: pick('installationDate'),
        openingPmsOn: pick('openingPmsOn'),
        openingCalibrationOn: pick('openingCalibrationOn'),
        pmsFrequencyMonths: pick('pmsFrequencyMonths'),
      }),
    );
  }

  const requestKeyChange = hasKeyChanges && !canEditKey;
  if (requestKeyChange && (await prisma.approvalRequest.findFirst({ where: { type: 'edit_key_field', targetId: before.id, status: 'pending' } }))) {
    throw new HttpError(409, 'A change to the key details of this asset is already waiting for the HOD. Wait for the decision, or withdraw that request (Approvals) and ask again.');
  }
  const touched = Object.keys(data).length > 0;
  if (!touched && !requestKeyChange) {
    res.json({ asset: toAssetDetail(before), pendingApproval: false } satisfies UpdateAssetResponse);
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (touched) {
      const after = await tx.asset.update({ where: { id: before.id }, data });
      await audit(tx, req, { action: 'asset.update', entityType: 'asset', entityId: before.id, before, after });
      if (after.status === 'not_in_use' && before.status !== 'not_in_use') await clearReminders(tx, before.id, ['pms', 'calibration', 'warranty', 'contract']);
      if (after.departmentId !== before.departmentId) await moveOpenComplaints(tx, before.id, after.departmentId);
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
  const [orders, contracts, attachments, pms, calibrations, complaints, serviceLogs, departures, issued] = await Promise.all([
    prisma.purchaseOrder.findMany({ where: { assetId: asset.id } }),
    prisma.serviceContract.findMany({ where: { assetId: asset.id } }),
    prisma.attachment.findMany({ where: { ownerType: 'asset', ownerId: asset.id } }),
    prisma.pmsRecord.findMany({ where: { assetId: asset.id } }),
    prisma.calibrationRecord.findMany({ where: { assetId: asset.id } }),
    prisma.complaint.findMany({ where: { assetId: asset.id } }),
    prisma.serviceLog.findMany({ where: { assetId: asset.id } }),
    // The day it left the hospital: condemnation or transfer, as approved by the HOD.
    prisma.approvalRequest.findMany({ where: { targetType: 'asset', targetId: asset.id, type: { in: ['condemn', 'transfer'] }, status: 'approved' } }),
    prisma.consumableMovement.findMany({ where: { assetId: asset.id, kind: 'out' }, include: { item: true, complaint: { select: { complaintNo: true } } } }),
  ]);

  const events: TimelineEvent[] = [
    ...departures.map((r): TimelineEvent => {
      const p = r.payload as { reason?: string; toUnit?: string };
      return r.type === 'transfer'
        ? { date: r.decidedAt!.toISOString(), kind: 'transferred', title: `Transferred to ${p.toUnit ?? 'another unit'}`, detail: p.reason }
        : { date: r.decidedAt!.toISOString(), kind: 'condemned', title: 'Condemned', detail: p.reason };
    }),
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
    ...issued.map((m): TimelineEvent => ({ date: isoDate(m.date), kind: 'consumable', title: `Given: ${-m.quantity} ${m.item.unit} ${m.item.name}`, detail: [m.complaint?.complaintNo, m.reason].filter(Boolean).join(' · ') })),
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

// Costs are shown only to those who manage expenses, as on the dashboard; nursing sees vendors and dates.
const seesCosts = (req: Request) => currentUser(req).permissions.includes('expense.manage');

const toOrderRow = (o: Prisma.PurchaseOrderGetPayload<object>, costs: boolean): PurchaseOrderRow => ({
  id: o.id,
  poNumber: o.poNumber,
  poDate: isoDate(o.poDate),
  vendor: o.vendor,
  ...(costs && { cost: Number(o.cost) }),
});

assetsRouter.get('/:id/purchase-orders', requirePermission('asset.view'), async (req, res) => {
  const asset = await findScoped(req);
  const rows = await prisma.purchaseOrder.findMany({ where: { assetId: asset.id }, orderBy: { poDate: 'desc' } });
  res.json(rows.map((o) => toOrderRow(o, seesCosts(req))));
});

assetsRouter.post('/:id/purchase-orders', requirePermission('asset.edit'), validate(purchaseOrderSchema), async (req, res) => {
  const asset = await findScoped(req);
  if (isGone(asset.status)) throw new HttpError(409, `This equipment has been ${asset.status}, so purchase orders can no longer be added`);
  const input = req.body as PurchaseOrderInput;
  const row = await audited(req, { action: 'purchase_order.create', entityType: 'purchase_order' }, (tx) =>
    tx.purchaseOrder.create({ data: { ...input, poDate: parseDate(input.poDate), assetId: asset.id, createdBy: currentUser(req).id } }),
  );
  res.status(201).json(toOrderRow(row, seesCosts(req)));
});

const toContractRow = (c: Prisma.ServiceContractGetPayload<object>, costs: boolean): ServiceContractRow => ({
  id: c.id,
  type: c.type,
  vendor: c.vendor,
  startDate: isoDate(c.startDate),
  endDate: isoDate(c.endDate),
  ...(costs && { cost: c.cost == null ? null : Number(c.cost) }),
});

assetsRouter.get('/:id/contracts', requirePermission('asset.view'), async (req, res) => {
  const asset = await findScoped(req);
  res.json((await prisma.serviceContract.findMany({ where: { assetId: asset.id }, orderBy: { endDate: 'desc' } })).map((c) => toContractRow(c, seesCosts(req))));
});

assetsRouter.post('/:id/contracts', requirePermission('asset.edit'), validate(serviceContractSchema), async (req, res) => {
  const asset = await findScoped(req);
  if (isGone(asset.status)) throw new HttpError(409, `This equipment has been ${asset.status}, so service contracts can no longer be added`);
  const input = req.body as ServiceContractInput;
  const row = await audited(req, { action: 'service_contract.create', entityType: 'service_contract' }, (tx) =>
    tx.serviceContract.create({
      data: { ...input, startDate: parseDate(input.startDate), endDate: parseDate(input.endDate), cost: input.cost ?? null, assetId: asset.id, createdBy: currentUser(req).id },
    }),
  );
  res.status(201).json(toContractRow(row, seesCosts(req)));
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

// Who may read / add documents on each kind of record. Costs and calibration stay with the staff who manage them
// (a PO or contract copy shows the price); nursing can see and add photos on complaints of their own department only
// (asset scope applies to every file).
const READ_PERMISSION: Record<AttachmentOwnerType, PermissionCode> = {
  asset: 'asset.view',
  complaint: 'complaint.view',
  service_log: 'asset.view',
  service_expense: 'expense.manage',
  service_contract: 'expense.manage',
  purchase_order: 'expense.manage',
  calibration_record: 'calibration.manage',
  pms_record: 'pms.perform',
};
const WRITE_PERMISSIONS: Record<AttachmentOwnerType, PermissionCode[]> = {
  asset: ['asset.edit'],
  complaint: ['complaint.create', 'complaint.start', 'complaint.resolve'],
  service_log: ['asset.edit'],
  service_expense: ['expense.manage'],
  service_contract: ['asset.edit'],
  purchase_order: ['asset.edit'],
  calibration_record: ['calibration.manage'],
  pms_record: [], // the OEM's report is saved with the PMS record, which is read-only afterwards
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
  const open = ownerType === 'complaint' && !(await prisma.complaint.findUnique({ where: { id: ownerId } }))?.resolvedAt;
  res.json(rows.map((f) => ({ ...toAttachmentRow(f), canRemove: open && mayRemoveComplaintFile(req, f) })));
});

// A complaint photo added by mistake can be taken off while the complaint is open: by whoever added it, or by the
// biomedical staff working on it. Other documents are records, removed only with the record (HOD approval).
const mayRemoveComplaintFile = (req: Request, f: { ownerType: string; createdBy: string | null }) => {
  const me = currentUser(req);
  return f.ownerType === 'complaint' && (f.createdBy === me.id || me.permissions.includes('complaint.start'));
};

attachmentsRouter.delete('/:id', requirePermission('asset.view'), async (req, res) => {
  const file = await prisma.attachment.findUnique({ where: { id: idOf(req) } });
  if (!file || file.ownerType !== 'complaint') throw new HttpError(404, 'File not found');
  await scopedOwnerAsset(req, 'complaint', file.ownerId);
  if (!mayRemoveComplaintFile(req, file)) throw new HttpError(403, 'Only the person who added this file, or the biomedical team, can remove it');
  const complaint = await prisma.complaint.findUniqueOrThrow({ where: { id: file.ownerId } });
  if (complaint.resolvedAt) throw new HttpError(409, 'This complaint is resolved, so its documents are kept');
  await prisma.$transaction(async (tx) => {
    await tx.attachment.delete({ where: { id: file.id } });
    await audit(tx, req, { action: 'attachment.delete', entityType: 'attachment', entityId: file.id, before: file });
  });
  await getStorage().remove(file.filePath).catch((e) => console.error('Could not remove file', file.filePath, e));
  res.status(204).end();
});

attachmentsRouter.post('/', upload.single('file'), async (req, res) => {
  const { ownerType, ownerId, kind } = attachmentCreateSchema.parse(req.body);
  const me = currentUser(req);
  if (!WRITE_PERMISSIONS[ownerType].some((p) => me.permissions.includes(p))) throw new HttpError(403, 'You do not have permission to add documents here');
  const asset = await scopedOwnerAsset(req, ownerType, ownerId);
  if (isGone(asset.status)) throw new HttpError(409, `This equipment has been ${asset.status}, so documents can no longer be added`);
  if (ownerType === 'complaint') {
    const c = await prisma.complaint.findUniqueOrThrow({ where: { id: ownerId } });
    // The OEM's service report or the invoice often arrives days after the fix: the biomedical team can still add it.
    // The ward's photos stop at resolve (gap review #11). Nothing is removed from a resolved complaint.
    if (c.resolvedAt && !me.permissions.includes('complaint.resolve')) throw new HttpError(409, 'This complaint is resolved, so documents can no longer be added');
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
