import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  approvalListQuerySchema,
  approveApprovalSchema,
  condemnRequestSchema,
  deleteRequestSchema,
  isGone,
  rejectApprovalSchema,
  transferRequestSchema,
  type ApprovalRow,
  type ApproveApprovalInput,
  type CondemnationInfo,
  type DeleteRequestInput,
  type RejectApprovalInput,
  type TransferInfo,
  type TransferRequestInput,
} from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, requireAnyPermission, requirePermission } from '../../lib/auth';
import { todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';
import { findScopedAsset } from '../assets/assets.service';
import { assetIdOfOwner, storeAttachment, upload } from '../assets/attachments.service';
import { NOT_DELETABLE_COMPLAINT, applyApproval, approvers, notify, removeFiles, toApprovalRows } from './approvals.service';

export const approvalsRouter = Router();

const REQUEST = 'asset.request_change' as const;

async function assertNoPending(type: 'condemn' | 'delete' | 'transfer', targetType: string, targetId: string) {
  const dup = await prisma.approvalRequest.findFirst({ where: { type, targetType, targetId, status: 'pending' } });
  if (dup) throw new HttpError(409, 'There is already a pending request for this. Wait for the HOD to decide it.');
}

// ---------- Making a request ----------

// A machine that has left (condemned or transferred) cannot be asked about again.
const goneMessage = (status: string) => (status === 'transferred' ? 'This equipment has been transferred to another unit' : 'This asset is already condemned');

// Condemnation request: the committee's form (reason, estimated value today, committee date), with an optional
// end-of-life letter (the manufacturer's or vendor's letter). Nothing changes on the asset until the HOD approves.
approvalsRouter.post('/assets/:id/condemn', requirePermission(REQUEST), upload.single('file'), async (req, res) => {
  const me = currentUser(req);
  const { reason, reasonCategory, estimatedValue, committeeDate } = condemnRequestSchema.parse(req.body);
  if (committeeDate > todayISO()) throw new HttpError(400, 'The committee date cannot be in the future', { fieldErrors: { committeeDate: ['The committee date cannot be in the future'] } });
  const asset = await findScopedAsset(req);
  if (isGone(asset.status)) throw new HttpError(409, goneMessage(asset.status));
  await assertNoPending('condemn', 'asset', asset.id);
  await assertNoPending('transfer', 'asset', asset.id);

  const letter = req.file ? await storeAttachment(req, { assetId: asset.id, ownerType: 'asset', ownerId: asset.id, kind: 'eol_letter' }) : null;
  const request = await prisma.$transaction(async (tx) => {
    const row = await tx.approvalRequest.create({
      data: { type: 'condemn', targetType: 'asset', targetId: asset.id, payload: { reason, reasonCategory, estimatedValue, committeeDate, attachmentId: letter?.id ?? null }, requestedBy: me.id, createdBy: me.id },
    });
    await audit(tx, req, { action: 'approval.request', entityType: 'approval_request', entityId: row.id, after: row });
    await notify(tx, await approvers(), `${me.name} asks to condemn ${asset.assetCode} ${asset.name}`, asset.id);
    return row;
  });
  res.status(201).json((await toApprovalRows([request]))[0] satisfies ApprovalRow);
});

// Transfer to another unit of the group, where the hospital has turned transfers on. Nothing changes until the HOD
// approves; then the asset is marked transferred and leaves the active lists, keeping its record and history here.
approvalsRouter.post('/assets/:id/transfer', requirePermission(REQUEST), validate(transferRequestSchema), async (req, res) => {
  const me = currentUser(req);
  const { toUnit, reason } = req.body as TransferRequestInput;
  const { transfersEnabled } = await prisma.hospitalSettings.findFirstOrThrow({ select: { transfersEnabled: true } });
  if (!transfersEnabled) throw new HttpError(409, 'Transfers to other units are not turned on for this hospital (Hospital settings)');
  const asset = await findScopedAsset(req);
  if (isGone(asset.status)) throw new HttpError(409, goneMessage(asset.status));
  await assertNoPending('transfer', 'asset', asset.id);
  await assertNoPending('condemn', 'asset', asset.id);
  const request = await prisma.$transaction(async (tx) => {
    const row = await tx.approvalRequest.create({ data: { type: 'transfer', targetType: 'asset', targetId: asset.id, payload: { toUnit, reason }, requestedBy: me.id, createdBy: me.id } });
    await audit(tx, req, { action: 'approval.request', entityType: 'approval_request', entityId: row.id, after: row });
    await notify(tx, await approvers(), `${me.name} asks to transfer ${asset.assetCode} ${asset.name} to ${toUnit}`, asset.id);
    return row;
  });
  res.status(201).json((await toApprovalRows([request]))[0] satisfies ApprovalRow);
});

// Delete a wrong entry (an asset made by mistake, or a PO / contract / expense on one).
approvalsRouter.post('/approvals/delete', requirePermission(REQUEST), validate(deleteRequestSchema), async (req, res) => {
  const me = currentUser(req);
  const input = req.body as DeleteRequestInput;

  // The target must exist and sit in an asset this person may see.
  const assetId = await assetIdOfOwner(input.targetType, input.targetId);
  if (!assetId) throw new HttpError(404, 'Entry not found');
  const asset = await findScopedAsset(req, assetId);
  if (input.targetType === 'complaint' && (await prisma.complaint.findUniqueOrThrow({ where: { id: input.targetId } })).status !== 'open') {
    throw new HttpError(409, NOT_DELETABLE_COMPLAINT);
  }
  if (input.targetType === 'asset' && isGone(asset.status)) {
    throw new HttpError(409, `${goneMessage(asset.status)}. Its record is kept, so it cannot be deleted.`);
  }
  await assertNoPending('delete', input.targetType, input.targetId);

  const request = await prisma.$transaction(async (tx) => {
    const row = await tx.approvalRequest.create({
      data: { type: 'delete', targetType: input.targetType, targetId: input.targetId, payload: { reason: input.reason }, requestedBy: me.id, createdBy: me.id },
    });
    await audit(tx, req, { action: 'approval.request', entityType: 'approval_request', entityId: row.id, after: row });
    await notify(tx, await approvers(), `${me.name} asks to delete an entry on ${asset.assetCode} ${asset.name}`, asset.id);
    return row;
  });
  res.status(201).json((await toApprovalRows([request]))[0] satisfies ApprovalRow);
});

// ---------- Seeing requests ----------

// The HOD sees every request; everyone else who can ask sees only their own.
approvalsRouter.get('/approvals', requireAnyPermission('approval.decide', REQUEST), async (req, res) => {
  const me = currentUser(req);
  const q = approvalListQuerySchema.parse(req.query);
  const where: Prisma.ApprovalRequestWhereInput = {
    ...(q.status === 'all' ? {} : { status: q.status }),
    ...(me.permissions.includes('approval.decide') ? {} : { requestedBy: me.id }),
  };
  const rows = await toApprovalRows(await prisma.approvalRequest.findMany({ where, orderBy: { createdAt: q.status === 'pending' ? 'asc' : 'desc' }, take: 300 }));
  res.json(q.assetId ? rows.filter((r) => r.assetId === q.assetId) : rows);
});

// Why and by whom an asset was condemned (asset page banner and the printable certificate).
approvalsRouter.get('/assets/:id/condemnation', requirePermission('asset.view'), async (req, res) => {
  const asset = await findScopedAsset(req);
  const request = await prisma.approvalRequest.findFirst({
    where: { type: 'condemn', targetType: 'asset', targetId: asset.id, status: 'approved' },
    orderBy: { decidedAt: 'desc' },
  });
  if (!request || !request.decidedAt) throw new HttpError(404, 'This asset has not been condemned');
  const [row] = await toApprovalRows([request]);
  const p = request.payload as { attachmentId?: string | null; reasonCategory?: CondemnationInfo['reasonCategory']; estimatedValue?: number; committeeDate?: string };
  const letter = p.attachmentId ? await prisma.attachment.findUnique({ where: { id: p.attachmentId } }) : null;
  res.json({
    hospitalName: (await prisma.hospitalSettings.findFirstOrThrow({ select: { name: true } })).name,
    reason: row.requestReason ?? '',
    reasonCategory: p.reasonCategory ?? null,
    estimatedValue: p.estimatedValue ?? null,
    committeeDate: p.committeeDate ?? null,
    requestedByName: row.requestedByName,
    requestedAt: row.createdAt,
    approvedByName: row.decidedByName ?? '',
    approvedAt: row.decidedAt!,
    eolLetter: letter ? { id: letter.id, fileName: letter.fileName } : null,
  } satisfies CondemnationInfo);
});

// Where an asset was transferred to, why, and who approved it (asset page banner).
approvalsRouter.get('/assets/:id/transfer', requirePermission('asset.view'), async (req, res) => {
  const asset = await findScopedAsset(req);
  const request = await prisma.approvalRequest.findFirst({ where: { type: 'transfer', targetType: 'asset', targetId: asset.id, status: 'approved' }, orderBy: { decidedAt: 'desc' } });
  if (!request || !request.decidedAt) throw new HttpError(404, 'This asset has not been transferred');
  const [row] = await toApprovalRows([request]);
  res.json({ toUnit: (request.payload as { toUnit: string }).toUnit, reason: row.requestReason ?? '', requestedByName: row.requestedByName, approvedByName: row.decidedByName ?? '', approvedAt: row.decidedAt! } satisfies TransferInfo);
});

// ---------- Deciding ----------

// The status check is part of the UPDATE, so two approvers cannot both decide, and the change itself is applied in
// the same transaction: it is all done or none of it is.
// Applying a request can touch several records; give it room on a busy server or a remote database.
const DECIDE_TX_OPTIONS = { maxWait: 15_000, timeout: 30_000 } as const;

async function decide(req: Parameters<typeof currentUser>[0], status: 'approved' | 'rejected', note: string | null) {
  const me = currentUser(req);
  const before = await prisma.approvalRequest.findUnique({ where: { id: idOf(req) } });
  if (!before) throw new HttpError(404, 'Request not found');
  if (before.status !== 'pending') throw new HttpError(409, `This request has already been ${before.status}`);

  // The summary describes the request itself, so it is read before the transaction, which stays short.
  const [summaryRow] = await toApprovalRows([before]);

  const files = await prisma.$transaction(async (tx) => {
    const { count } = await tx.approvalRequest.updateMany({
      where: { id: before.id, status: 'pending' },
      // A copy of what was decided, as it read then: the record (or the asset) may be gone afterwards.
      data: { status, decidedBy: me.id, decidedAt: new Date(), reason: note, payload: { ...(before.payload as object), snapshot: { summary: summaryRow.summary, assetCode: summaryRow.assetCode, assetName: summaryRow.assetName } } },
    });
    if (count === 0) throw new HttpError(409, 'This request has already been decided');
    const after = await tx.approvalRequest.findUniqueOrThrow({ where: { id: before.id } });
    const toRemove = status === 'approved' ? await applyApproval(tx, req, after) : [];
    // A one-HOD hospital decides its own requests too; that is allowed, and always marked (gap review #16).
    await audit(tx, req, { action: status === 'approved' ? 'approval.approve' : 'approval.reject', entityType: 'approval_request', entityId: before.id, before, after: { ...after, selfApproved: before.requestedBy === me.id } });

    // The notice links to the asset only if it still exists (this request, or an earlier one, may have deleted it);
    // otherwise a request about a deleted asset could never be approved or rejected.
    const assetId = summaryRow.assetId && (await tx.asset.findUnique({ where: { id: summaryRow.assetId }, select: { id: true } })) ? summaryRow.assetId : null;
    await notify(tx, [before.requestedBy], `Your request was ${status}: ${summaryRow.summary}${note ? ` (${note})` : ''}`, assetId);
    return toRemove;
  }, DECIDE_TX_OPTIONS);
  await removeFiles(files);
  return (await toApprovalRows([await prisma.approvalRequest.findUniqueOrThrow({ where: { id: before.id } })]))[0];
}

approvalsRouter.post('/approvals/:id/approve', requirePermission('approval.decide'), validate(approveApprovalSchema), async (req, res) => {
  res.json(await decide(req, 'approved', (req.body as ApproveApprovalInput).note ?? null));
});

// The person who asked can take a pending request back (asked by mistake, or to ask for something else instead).
approvalsRouter.post('/approvals/:id/withdraw', requirePermission(REQUEST), async (req, res) => {
  const me = currentUser(req);
  const before = await prisma.approvalRequest.findUnique({ where: { id: idOf(req) } });
  if (!before || before.requestedBy !== me.id) throw new HttpError(404, 'Request not found');
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.approvalRequest.updateMany({
      where: { id: before.id, status: 'pending' },
      data: { status: 'withdrawn', decidedBy: me.id, decidedAt: new Date(), reason: 'Withdrawn by the person who asked' },
    });
    if (count === 0) throw new HttpError(409, `This request has already been ${before.status}`);
    const after = await tx.approvalRequest.findUniqueOrThrow({ where: { id: before.id } });
    await audit(tx, req, { action: 'approval.withdraw', entityType: 'approval_request', entityId: before.id, before, after });
  });
  res.json((await toApprovalRows([await prisma.approvalRequest.findUniqueOrThrow({ where: { id: before.id } })]))[0]);
});

approvalsRouter.post('/approvals/:id/reject', requirePermission('approval.decide'), validate(rejectApprovalSchema), async (req, res) => {
  res.json(await decide(req, 'rejected', (req.body as RejectApprovalInput).reason));
});

