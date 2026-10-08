import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import type { ApprovalRow, ApprovalStatus, ApprovalType } from '@bme/shared';
import { audit } from '../../lib/audit';
import { prettyDate } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { usersWithPermissions } from '../../lib/people';
import { prisma } from '../../lib/prisma';
import { getStorage } from '../../lib/storage';

type Db = Prisma.TransactionClient;
type Payload = Record<string, unknown> & {
  reason?: string;
  changes?: Record<string, unknown>;
  previous?: Record<string, unknown>;
  attachmentId?: string;
};

export const money = (n: unknown) => `₹ ${new Intl.NumberFormat('en-IN').format(Number(n))}`;

// ---------- Telling people ----------

export async function notify(db: Db, userIds: string[], message: string, assetId: string | null) {
  if (userIds.length === 0) return;
  await db.notification.createMany({ data: userIds.map((userId) => ({ userId, type: 'approval', assetId, message })) });
}

export const approvers = () => usersWithPermissions('approval.decide', 'notification.view');

// ---------- Applying an approved request (all inside the caller's transaction) ----------

// Business rule 3: the change exists only as a proposal until the HOD approves it, and is applied here, in
// the same transaction that marks it approved. Anything that no longer holds throws, which rolls the approval
// back so the HOD sees why and can reject instead.
export async function applyApproval(tx: Db, req: Request, request: Prisma.ApprovalRequestGetPayload<object>): Promise<string[]> {
  const payload = request.payload as Payload;
  const filesToRemove: string[] = [];

  if (request.type === 'edit_key_field') {
    const before = await tx.asset.findUnique({ where: { id: request.targetId } });
    if (!before) throw new HttpError(409, 'The asset no longer exists, so this request cannot be applied. Reject it.');
    if (before.status === 'condemned') throw new HttpError(409, 'The asset has been condemned and can no longer be edited');
    const changes = (payload.changes ?? {}) as { serialNo?: string | null; equipmentTypeId?: string; departmentId?: string; locationId?: string };

    const departmentId = changes.departmentId ?? before.departmentId;
    const locationId = changes.locationId ?? before.locationId;
    const location = await tx.location.findUnique({ where: { id: locationId } });
    if (!location || location.departmentId !== departmentId) throw new HttpError(409, 'The requested location does not belong to the requested department any more');
    if (changes.serialNo) {
      const clash = await tx.asset.findFirst({ where: { serialNo: changes.serialNo, id: { not: before.id } } });
      if (clash) throw new HttpError(409, `The serial number is now used by ${clash.assetCode}`);
    }
    // The asset ID never changes, whatever the edit.
    const after = await tx.asset.update({ where: { id: before.id }, data: changes });
    await audit(tx, req, { action: 'asset.update', entityType: 'asset', entityId: before.id, before, after });
  } else if (request.type === 'condemn') {
    const before = await tx.asset.findUnique({ where: { id: request.targetId } });
    if (!before) throw new HttpError(409, 'The asset no longer exists. Reject this request.');
    if (before.status === 'condemned') throw new HttpError(409, 'The asset is already condemned');
    const after = await tx.asset.update({ where: { id: before.id }, data: { status: 'condemned' } });
    await audit(tx, req, { action: 'asset.condemn', entityType: 'asset', entityId: before.id, before, after });
  } else {
    filesToRemove.push(...(await applyDelete(tx, req, request.targetType, request.targetId)));
  }
  return filesToRemove;
}

async function applyDelete(tx: Db, req: Request, targetType: string, targetId: string): Promise<string[]> {
  const gone = () => new HttpError(409, 'That entry no longer exists. Reject this request.');
  // Documents belong to the record, so they go with it (rows now, files after the transaction commits).
  const takeFiles = async (ownerType: string, ownerId: string = targetId) => {
    const files = await tx.attachment.findMany({ where: { ownerType, ownerId } });
    await tx.attachment.deleteMany({ where: { ownerType, ownerId } });
    return files.map((f) => f.filePath);
  };
  if (targetType === 'purchase_order') {
    const row = await tx.purchaseOrder.findUnique({ where: { id: targetId } });
    if (!row) throw gone();
    const files = await takeFiles('purchase_order');
    await tx.purchaseOrder.delete({ where: { id: targetId } });
    await audit(tx, req, { action: 'purchase_order.delete', entityType: 'purchase_order', entityId: targetId, before: row });
    return files;
  } else if (targetType === 'service_contract') {
    const row = await tx.serviceContract.findUnique({ where: { id: targetId } });
    if (!row) throw gone();
    const files = await takeFiles('service_contract');
    await tx.serviceContract.delete({ where: { id: targetId } });
    await audit(tx, req, { action: 'service_contract.delete', entityType: 'service_contract', entityId: targetId, before: row });
    return files;
  } else if (targetType === 'service_expense') {
    const row = await tx.serviceExpense.findUnique({ where: { id: targetId } });
    if (!row) throw gone();
    const files = await takeFiles('service_expense');
    await tx.serviceExpense.delete({ where: { id: targetId } });
    await audit(tx, req, { action: 'service_expense.delete', entityType: 'service_expense', entityId: targetId, before: row });
    return files;
  } else if (targetType === 'service_log') {
    const row = await tx.serviceLog.findUnique({ where: { id: targetId } });
    if (!row) throw gone();
    const files = await takeFiles('service_log');
    await tx.serviceLog.delete({ where: { id: targetId } });
    await audit(tx, req, { action: 'service_log.delete', entityType: 'service_log', entityId: targetId, before: row });
    return files;
  } else if (targetType === 'asset') {
    const asset = await tx.asset.findUnique({ where: { id: targetId } });
    if (!asset) throw gone();
    // An asset with history is not a wrong entry: its PMS and calibration records are permanent and a complaint
    // is evidence. Those go through condemnation instead.
    const [pms, calibrations, complaints, expenses, serviceLogs] = await Promise.all([
      tx.pmsRecord.count({ where: { assetId: targetId } }),
      tx.calibrationRecord.count({ where: { assetId: targetId } }),
      tx.complaint.count({ where: { assetId: targetId } }),
      tx.serviceExpense.count({ where: { assetId: targetId } }),
      tx.serviceLog.count({ where: { assetId: targetId } }),
    ]);
    if (pms + calibrations + complaints + expenses + serviceLogs > 0) {
      throw new HttpError(409, 'This asset already has PMS, calibration, complaint, service or expense history, so it cannot be deleted. Reject this request and condemn the asset instead.');
    }
    const files = [
      ...(await takeFiles('asset')),
      ...(await Promise.all((await tx.purchaseOrder.findMany({ where: { assetId: targetId }, select: { id: true } })).map((x) => takeFiles('purchase_order', x.id)))).flat(),
      ...(await Promise.all((await tx.serviceContract.findMany({ where: { assetId: targetId }, select: { id: true } })).map((x) => takeFiles('service_contract', x.id)))).flat(),
    ];
    await tx.purchaseOrder.deleteMany({ where: { assetId: targetId } });
    await tx.serviceContract.deleteMany({ where: { assetId: targetId } });
    await tx.notification.deleteMany({ where: { assetId: targetId } });
    await tx.asset.delete({ where: { id: targetId } });
    // The asset ID is not handed out again: the counter only ever goes up.
    await audit(tx, req, { action: 'asset.delete', entityType: 'asset', entityId: targetId, before: asset });
    return files;
  } else {
    throw new HttpError(400, 'Unknown target');
  }
  return [];
}

// Files are removed only after the transaction has committed, and a failure to remove one never undoes the approval.
export async function removeFiles(paths: string[]) {
  const storage = getStorage();
  await Promise.all(paths.map((p) => storage.remove(p).catch((e) => console.error('Could not remove file', p, e))));
}

// ---------- Describing a request ----------

type RequestRow = Prisma.ApprovalRequestGetPayload<object>;

// Turns requests into rows people can read. Ids in the stored payload become names in one batch of lookups.
export async function toApprovalRows(rows: RequestRow[]): Promise<ApprovalRow[]> {
  const ids = (type: string) => rows.filter((r) => r.targetType === type).map((r) => r.targetId);
  const payloads = rows.map((r) => ({ r, p: r.payload as Payload }));
  const changeIds = (key: string) => payloads.map(({ p }) => p.changes?.[key]).filter((v): v is string => typeof v === 'string');

  const [pos, contracts, expenses, serviceLogs, users, locations, departments, types] = await Promise.all([
    prisma.purchaseOrder.findMany({ where: { id: { in: ids('purchase_order') } } }),
    prisma.serviceContract.findMany({ where: { id: { in: ids('service_contract') } } }),
    prisma.serviceExpense.findMany({ where: { id: { in: ids('service_expense') } } }),
    prisma.serviceLog.findMany({ where: { id: { in: ids('service_log') } } }),
    prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.requestedBy, r.decidedBy].filter((x): x is string => !!x)) } }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { id: { in: [...changeIds('locationId'), ...payloads.map(({ p }) => p.previous?.locationId).filter((v): v is string => typeof v === 'string')] } } }),
    prisma.department.findMany({ where: { id: { in: [...changeIds('departmentId'), ...payloads.map(({ p }) => p.previous?.departmentId).filter((v): v is string => typeof v === 'string')] } } }),
    prisma.equipmentType.findMany({ where: { id: { in: [...changeIds('equipmentTypeId'), ...payloads.map(({ p }) => p.previous?.equipmentTypeId).filter((v): v is string => typeof v === 'string')] } } }),
  ]);
  const assetIdOf = (r: RequestRow) =>
    r.targetType === 'asset' ? r.targetId
    : r.targetType === 'purchase_order' ? pos.find((x) => x.id === r.targetId)?.assetId
    : r.targetType === 'service_contract' ? contracts.find((x) => x.id === r.targetId)?.assetId
    : r.targetType === 'service_expense' ? expenses.find((x) => x.id === r.targetId)?.assetId
    : r.targetType === 'service_log' ? serviceLogs.find((x) => x.id === r.targetId)?.assetId
    : undefined;
  const assetIds = [...new Set(rows.map(assetIdOf).filter((x): x is string => !!x))];
  const assets = await prisma.asset.findMany({ where: { id: { in: assetIds } } });
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? 'Unknown') : null);

  const label: Record<string, (v: unknown) => string> = {
    serialNo: (v) => (v ? String(v) : '(none)'),
    equipmentTypeId: (v) => types.find((t) => t.id === v)?.name ?? '?',
    departmentId: (v) => departments.find((d) => d.id === v)?.name ?? '?',
    locationId: (v) => locations.find((l) => l.id === v)?.name ?? '?',
  };
  const field: Record<string, string> = { serialNo: 'serial number', equipmentTypeId: 'equipment type', departmentId: 'department', locationId: 'location' };

  return payloads.map(({ r, p }): ApprovalRow => {
    const assetId = assetIdOf(r) ?? null;
    const asset = assets.find((a) => a.id === assetId);
    let summary = '';
    if (r.type === 'edit_key_field') {
      summary = Object.entries(p.changes ?? {})
        .map(([k, v]) => `Change ${field[k] ?? k} from ${label[k]?.(p.previous?.[k]) ?? '?'} to ${label[k]?.(v) ?? String(v)}`)
        .join('; ');
    } else if (r.type === 'condemn') {
      summary = 'Condemn this asset. It leaves the active lists and reminders but stays in history and exports.';
    } else {
      const po = pos.find((x) => x.id === r.targetId);
      const c = contracts.find((x) => x.id === r.targetId);
      const e = expenses.find((x) => x.id === r.targetId);
      const sl = serviceLogs.find((x) => x.id === r.targetId);
      summary =
        r.targetType === 'asset' ? 'Delete this asset (entered by mistake). Its ID is not reused.'
        : r.targetType === 'purchase_order' ? `Delete purchase order ${po?.poNumber ?? '(already removed)'}${po ? ` (${po.vendor}, ${money(po.cost)})` : ''}`
        : r.targetType === 'service_contract' ? `Delete ${c ? `${c.type.toUpperCase().replace('_', '-')} contract with ${c.vendor}` : 'contract (already removed)'}`
        : r.targetType === 'service_log' ? `Delete service entry ${sl ? `"${sl.description.slice(0, 60)}" (${prettyDate(sl.serviceDate)})` : '(already removed)'}`
        : `Delete expense ${e ? `"${e.description}" (${money(e.amount)})` : '(already removed)'}`;
    }
    return {
      id: r.id,
      type: r.type as ApprovalType,
      status: r.status as ApprovalStatus,
      assetId,
      assetCode: asset?.assetCode ?? null,
      assetName: asset?.name ?? null,
      summary,
      requestReason: typeof p.reason === 'string' ? p.reason : null,
      requestedByName: name(r.requestedBy) ?? 'Unknown',
      createdAt: r.createdAt.toISOString(),
      decidedByName: name(r.decidedBy),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.reason,
    };
  });
}
