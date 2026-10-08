import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  approvalListQuerySchema,
  approveApprovalSchema,
  condemnRequestSchema,
  deleteRequestSchema,
  rejectApprovalSchema,
  type ApprovalRow,
  type ApproveApprovalInput,
  type CondemnationInfo,
  type DeleteRequestInput,
  type RejectApprovalInput,
} from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, requireAnyPermission, requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';
import { findScopedAsset } from '../assets/assets.service';
import { storeAttachment, upload } from '../assets/attachments.service';
import { applyApproval, approvers, notify, removeFiles, toApprovalRows } from './approvals.service';

export const approvalsRouter = Router();

const REQUEST = 'asset.request_change' as const;

async function assertNoPending(type: 'condemn' | 'delete', targetType: string, targetId: string) {
  const dup = await prisma.approvalRequest.findFirst({ where: { type, targetType, targetId, status: 'pending' } });
  if (dup) throw new HttpError(409, 'There is already a pending request for this. Wait for the HOD to decide it.');
}

// ---------- Making a request ----------

// Condemnation request, with an optional end-of-life letter (the manufacturer's or vendor's letter) as the
// supporting document. Nothing changes on the asset until the HOD approves.
approvalsRouter.post('/assets/:id/condemn', requirePermission(REQUEST), upload.single('file'), async (req, res) => {
  const me = currentUser(req);
  const { reason } = condemnRequestSchema.parse(req.body);
  const asset = await findScopedAsset(req);
  if (asset.status === 'condemned') throw new HttpError(409, 'This asset is already condemned');
  await assertNoPending('condemn', 'asset', asset.id);

  const letter = req.file ? await storeAttachment(req, { assetId: asset.id, ownerType: 'asset', ownerId: asset.id, kind: 'eol_letter' }) : null;
  const request = await prisma.$transaction(async (tx) => {
    const row = await tx.approvalRequest.create({
      data: { type: 'condemn', targetType: 'asset', targetId: asset.id, payload: { reason, attachmentId: letter?.id ?? null }, requestedBy: me.id, createdBy: me.id },
    });
    await audit(tx, req, { action: 'approval.request', entityType: 'approval_request', entityId: row.id, after: row });
    await notify(tx, await approvers(), `${me.name} asks to condemn ${asset.assetCode} ${asset.name}`, asset.id);
    return row;
  });
  res.status(201).json((await toApprovalRows([request]))[0] satisfies ApprovalRow);
});

// Delete a wrong entry (an asset made by mistake, or a PO / contract / expense on one).
approvalsRouter.post('/approvals/delete', requirePermission(REQUEST), validate(deleteRequestSchema), async (req, res) => {
  const me = currentUser(req);
  const input = req.body as DeleteRequestInput;

  // The target must exist and sit in an asset this person may see.
  let assetId: string | undefined;
  if (input.targetType === 'asset') assetId = input.targetId;
  else if (input.targetType === 'purchase_order') assetId = (await prisma.purchaseOrder.findUnique({ where: { id: input.targetId } }))?.assetId;
  else if (input.targetType === 'service_contract') assetId = (await prisma.serviceContract.findUnique({ where: { id: input.targetId } }))?.assetId;
  else assetId = (await prisma.serviceExpense.findUnique({ where: { id: input.targetId } }))?.assetId;
  if (!assetId) throw new HttpError(404, 'Entry not found');
  const asset = await findScopedAsset(req, assetId);
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
  const attachmentId = (request.payload as { attachmentId?: string | null }).attachmentId;
  const letter = attachmentId ? await prisma.attachment.findUnique({ where: { id: attachmentId } }) : null;
  res.json({
    hospitalName: (await prisma.hospitalSettings.findFirstOrThrow({ select: { name: true } })).name,
    reason: row.requestReason ?? '',
    requestedByName: row.requestedByName,
    requestedAt: row.createdAt,
    approvedByName: row.decidedByName ?? '',
    approvedAt: row.decidedAt!,
    eolLetter: letter ? { id: letter.id, fileName: letter.fileName } : null,
  } satisfies CondemnationInfo);
});

// ---------- Deciding ----------

// The status check is part of the UPDATE, so two approvers cannot both decide, and the change itself is applied in
// the same transaction: it is all done or none of it is.
async function decide(req: Parameters<typeof currentUser>[0], status: 'approved' | 'rejected', note: string | null) {
  const me = currentUser(req);
  const before = await prisma.approvalRequest.findUnique({ where: { id: idOf(req) } });
  if (!before) throw new HttpError(404, 'Request not found');
  if (before.status !== 'pending') throw new HttpError(409, `This request has already been ${before.status}`);

  const files = await prisma.$transaction(async (tx) => {
    const { count } = await tx.approvalRequest.updateMany({
      where: { id: before.id, status: 'pending' },
      data: { status, decidedBy: me.id, decidedAt: new Date(), reason: note },
    });
    if (count === 0) throw new HttpError(409, 'This request has already been decided');
    const after = await tx.approvalRequest.findUniqueOrThrow({ where: { id: before.id } });
    const toRemove = status === 'approved' ? await applyApproval(tx, req, after) : [];
    await audit(tx, req, { action: status === 'approved' ? 'approval.approve' : 'approval.reject', entityType: 'approval_request', entityId: before.id, before, after });

    const [row] = await toApprovalRows([after]);
    // A deleted asset has nothing left to link the notification to.
    const assetGone = status === 'approved' && before.type === 'delete' && before.targetType === 'asset';
    await notify(tx, [before.requestedBy], `Your request was ${status}: ${row.summary}${note ? ` (${note})` : ''}`, assetGone ? null : row.assetId);
    return toRemove;
  });
  await removeFiles(files);
  return (await toApprovalRows([await prisma.approvalRequest.findUniqueOrThrow({ where: { id: before.id } })]))[0];
}

approvalsRouter.post('/approvals/:id/approve', requirePermission('approval.decide'), validate(approveApprovalSchema), async (req, res) => {
  res.json(await decide(req, 'approved', (req.body as ApproveApprovalInput).note ?? null));
});

approvalsRouter.post('/approvals/:id/reject', requirePermission('approval.decide'), validate(rejectApprovalSchema), async (req, res) => {
  res.json(await decide(req, 'rejected', (req.body as RejectApprovalInput).reason));
});

