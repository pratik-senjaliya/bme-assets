import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { createCalibrationSchema, dueQuerySchema, type CalibrationRow, type CreateCalibrationInput, type PmsResult } from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, requirePermission } from '../../lib/auth';
import { addMonths, isoDate, parseDate, todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';
import { findScopedAsset } from '../assets/assets.service';
import { storeAttachment, toAttachmentRow, upload } from '../assets/attachments.service';
import { dueList } from '../pms/pms.service';

export const calibrationRouter = Router();

type Row = Prisma.CalibrationRecordGetPayload<object>;

async function toRows(records: Row[]): Promise<CalibrationRow[]> {
  const certs = await prisma.attachment.findMany({
    where: { ownerType: 'calibration_record', ownerId: { in: records.map((r) => r.id) }, kind: 'certificate' },
    orderBy: { createdAt: 'asc' },
  });
  const latest = new Map(certs.map((c) => [c.ownerId, c])); // newest wins
  return records.map((r) => {
    const cert = latest.get(r.id);
    return {
      id: r.id,
      doneOn: isoDate(r.doneOn),
      dueOn: isoDate(r.dueOn),
      agency: r.agency,
      result: r.result as PmsResult,
      certificate: cert ? { id: cert.id, fileName: cert.fileName } : null,
    };
  });
}

calibrationRouter.get('/assets/:id/calibrations', requirePermission('calibration.manage'), async (req, res) => {
  const asset = await findScopedAsset(req);
  res.json(await toRows(await prisma.calibrationRecord.findMany({ where: { assetId: asset.id }, orderBy: [{ doneOn: 'desc' }, { createdAt: 'desc' }] })));
});

// Calibration is done by an outside agency, so the date is reported (not server-stamped), but it can
// never be in the future. The asset's next-due date follows the most recent calibration.
calibrationRouter.post('/assets/:id/calibrations', requirePermission('calibration.manage'), validate(createCalibrationSchema), async (req, res) => {
  const input = req.body as CreateCalibrationInput;
  const asset = await findScopedAsset(req);
  if (asset.status !== 'active') throw new HttpError(409, 'Calibration can only be recorded for equipment in active use');
  if (input.doneOn > todayISO()) throw new HttpError(400, 'The calibration date cannot be in the future', { fieldErrors: { doneOn: ['Cannot be in the future'] } });

  const doneOn = parseDate(input.doneOn);
  const months = asset.equipmentType.defaultCalibrationMonths;
  if (!input.dueOn && !months) {
    throw new HttpError(400, 'Enter the next due date (this equipment type has no usual calibration interval)', { fieldErrors: { dueOn: ['Required'] } });
  }
  const dueOn = input.dueOn ? parseDate(input.dueOn) : addMonths(doneOn, months!);

  const row = await prisma.$transaction(async (tx) => {
    const record = await tx.calibrationRecord.create({
      data: { assetId: asset.id, doneOn, dueOn, agency: input.agency, result: input.result, createdBy: currentUser(req).id },
    });
    const latest = await tx.calibrationRecord.findFirstOrThrow({ where: { assetId: asset.id }, orderBy: [{ doneOn: 'desc' }, { createdAt: 'desc' }] });
    await tx.asset.update({ where: { id: asset.id }, data: { nextCalibrationDue: latest.dueOn } });
    await audit(tx, req, { action: 'calibration.create', entityType: 'calibration_record', entityId: record.id, after: record });
    return record;
  });
  res.status(201).json((await toRows([row]))[0]);
});

calibrationRouter.post('/calibration/records/:id/certificate', requirePermission('calibration.manage'), upload.single('file'), async (req, res) => {
  const record = await prisma.calibrationRecord.findUnique({ where: { id: idOf(req) } });
  if (!record) throw new HttpError(404, 'Calibration record not found');
  await findScopedAsset(req, record.assetId); // department scope
  const file = await storeAttachment(req, { assetId: record.assetId, ownerType: 'calibration_record', ownerId: record.id, kind: 'certificate' });
  res.status(201).json(toAttachmentRow(file));
});

calibrationRouter.get('/calibration/due', requirePermission('calibration.manage'), async (req, res) => {
  const { until } = dueQuerySchema.parse(req.query);
  res.json(await dueList(req, 'nextCalibrationDue', until));
});
