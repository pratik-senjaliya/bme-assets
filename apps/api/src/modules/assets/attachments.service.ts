import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import multer from 'multer';
import type { AttachmentKind as DbAttachmentKind, Prisma } from '@prisma/client';
import { MAX_UPLOAD_BYTES, type AttachmentOwnerType, type AttachmentRow } from '@bme/shared';
import { audited } from '../../lib/audit';
import { currentUser } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { getStorage } from '../../lib/storage';
import { prisma } from '../../lib/prisma';

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

// Decide the type from the file's own bytes; the browser's content-type and the file name are not trusted.
function sniff(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  return null;
}

export const toAttachmentRow = (a: Prisma.AttachmentGetPayload<object>): AttachmentRow => ({
  id: a.id,
  kind: a.kind,
  fileName: a.fileName,
  mime: a.mime,
  size: a.size,
  createdAt: a.createdAt.toISOString(),
});

// Stores the uploaded file (req.file) privately and records it against an owner (an asset, a calibration
// record, ...). Files live under the asset's folder so removing an asset's data is one prefix.
export async function storeAttachment(
  req: Request,
  owner: { assetId: string; ownerType: string; ownerId: string; kind: DbAttachmentKind },
) {
  if (!req.file) throw new HttpError(400, 'Choose a file to upload');
  const type = sniff(req.file.buffer);
  if (!type) throw new HttpError(415, 'Only PDF, JPG and PNG files are allowed');

  // multer reads names as latin1; keep it readable and free of path characters.
  const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 150);
  const key = `assets/${owner.assetId}/${randomUUID()}.${type.ext}`;

  const storage = getStorage();
  await storage.put(key, req.file.buffer, type.mime);
  try {
    return await audited(req, { action: 'attachment.create', entityType: 'attachment' }, (tx) =>
      tx.attachment.create({
        data: {
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          kind: owner.kind,
          fileName,
          filePath: key,
          mime: type.mime,
          size: req.file!.size,
          createdBy: currentUser(req).id,
        },
      }),
    );
  } catch (e) {
    await storage.remove(key).catch(() => undefined); // don't leave an orphan file behind
    throw e;
  }
}

// Every document belongs to one asset, directly or through one of its records. This finds that asset, so the
// department scope and permissions of the asset apply to the document too.
export async function assetIdOfOwner(ownerType: string, ownerId: string): Promise<string | undefined> {
  const t = ownerType as AttachmentOwnerType;
  const id = { where: { id: ownerId } };
  switch (t) {
    case 'asset':
      return ownerId;
    case 'complaint':
      return (await prisma.complaint.findUnique(id))?.assetId;
    case 'service_log':
      return (await prisma.serviceLog.findUnique(id))?.assetId;
    case 'service_expense':
      return (await prisma.serviceExpense.findUnique(id))?.assetId;
    case 'service_contract':
      return (await prisma.serviceContract.findUnique(id))?.assetId;
    case 'purchase_order':
      return (await prisma.purchaseOrder.findUnique(id))?.assetId;
    case 'calibration_record':
      return (await prisma.calibrationRecord.findUnique(id))?.assetId;
    default:
      return undefined;
  }
}
