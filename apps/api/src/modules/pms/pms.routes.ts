import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  dueQuerySchema,
  OEM_PMS_MAX_DAYS_BACK,
  oemPmsSchema,
  pmsTemplateBodySchema,
  submitPmsSchema,
  type PmsRecordRow,
  type PmsTemplateBody,
  type PmsTemplateRow,
  type SubmitPmsInput,
} from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, requireAnyPermission, requirePermission } from '../../lib/auth';
import { addDaysISO, addMonths, isoDate, parseDate, prettyDate, todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { getStorage } from '../../lib/storage';
import { idOf, validate } from '../../lib/validate';
import { findScopedAsset } from '../assets/assets.service';
import { stageUpload, upload } from '../assets/attachments.service';
import { clearReminders } from '../reminders/reminders.service';
import { dueList, evaluateAnswers, latestTemplate, pmsRecordInclude, refreshPmsFlag, tellFailed, templateItems, toPmsRows } from './pms.service';

export const pmsRouter = Router();

// ---------- Templates (versioned) ----------

const toTemplateRow = (t: Prisma.PmsTemplateGetPayload<{ include: { equipmentType: true } }>): PmsTemplateRow => ({
  id: t.id,
  equipmentTypeId: t.equipmentTypeId,
  equipmentTypeName: t.equipmentType.name,
  version: t.version,
  items: templateItems(t.schema),
  createdAt: t.createdAt.toISOString(),
});

// Latest version per equipment type, or every version of one type with ?equipmentTypeId=
pmsRouter.get('/pms-templates', requireAnyPermission('pms.perform', 'setup.manage'), async (req, res) => {
  const typeId = typeof req.query.equipmentTypeId === 'string' ? req.query.equipmentTypeId : undefined;
  const rows = await prisma.pmsTemplate.findMany({
    where: { ...(typeId && { equipmentTypeId: typeId }), equipmentType: { register: { in: currentUser(req).registers } } },
    include: { equipmentType: true },
    orderBy: [{ equipmentTypeId: 'asc' }, { version: 'desc' }],
  });
  const out = typeId ? rows : rows.filter((r, i) => i === 0 || rows[i - 1].equipmentTypeId !== r.equipmentTypeId);
  res.json(out.map(toTemplateRow));
});

// Saving never edits a version: it creates the next one, so records keep the checklist they were done with.
pmsRouter.post('/pms-templates', requirePermission('setup.manage'), validate(pmsTemplateBodySchema), async (req, res) => {
  const body = req.body as PmsTemplateBody;
  await prisma.equipmentType.findUniqueOrThrow({ where: { id: body.equipmentTypeId } });
  const row = await prisma.$transaction(async (tx) => {
    const last = await tx.pmsTemplate.findFirst({ where: { equipmentTypeId: body.equipmentTypeId }, orderBy: { version: 'desc' } });
    const created = await tx.pmsTemplate.create({
      data: { equipmentTypeId: body.equipmentTypeId, version: (last?.version ?? 0) + 1, schema: { items: body.items } as Prisma.InputJsonObject, createdBy: currentUser(req).id },
      include: { equipmentType: true },
    });
    await audit(tx, req, { action: 'pms_template.create', entityType: 'pms_template', entityId: created.id, after: created });
    return created;
  });
  res.status(201).json(toTemplateRow(row));
});

// ---------- Records ----------

pmsRouter.get('/assets/:id/pms', requirePermission('pms.perform'), async (req, res) => {
  const asset = await findScopedAsset(req);
  const records = await prisma.pmsRecord.findMany({ where: { assetId: asset.id }, include: pmsRecordInclude, orderBy: { submittedAt: 'desc' } });
  res.json(await toPmsRows(records));
});

// The checklist the next PMS on this asset will use, so the form can render it.
pmsRouter.get('/assets/:id/pms-template', requirePermission('pms.perform'), async (req, res) => {
  const asset = await findScopedAsset(req);
  const template = await latestTemplate(asset.equipmentTypeId);
  if (!template) throw new HttpError(404, `No PMS checklist is set up for ${asset.equipmentType.name} yet`);
  res.json(toTemplateRow({ ...template, equipmentType: asset.equipmentType }));
});

// Business rule 1: the server stamps performed_on = today in APP_TIMEZONE. The request has no date field,
// and anything extra the client sends is dropped by the schema. Records are never updated or deleted
// (no such routes, and the database refuses it too); a correction is a new record linked to the original.
pmsRouter.post('/assets/:id/pms', requirePermission('pms.perform'), validate(submitPmsSchema), async (req, res) => {
  const me = currentUser(req);
  const input = req.body as SubmitPmsInput;
  const asset = await findScopedAsset(req);
  if (asset.status !== 'active') throw new HttpError(409, 'PMS can only be recorded for equipment in active use');

  // A correction is checked against the checklist version the original was done with (it may have changed since).
  const original = input.correctsRecordId ? await prisma.pmsRecord.findUnique({ where: { id: input.correctsRecordId }, include: { template: true } }) : null;
  if (input.correctsRecordId && (!original || original.assetId !== asset.id)) throw new HttpError(400, 'That record is not for this asset');
  if (original?.kind === 'oem') throw new HttpError(400, 'A PMS done by the OEM engineer is corrected with a new OEM entry and its report');
  const template = original ? original.template : await latestTemplate(asset.equipmentTypeId);
  if (!template) throw new HttpError(409, `No PMS checklist is set up for ${asset.equipmentType.name} yet`);
  const { clean, result } = evaluateAnswers(templateItems(template.schema), input.answers);

  const performedOn = parseDate(todayISO());
  const created = await prisma.$transaction(async (tx) => {
    const record = await tx.pmsRecord.create({
      data: {
        assetId: asset.id,
        templateId: template.id,
        performedOn,
        performedBy: me.id,
        answers: clean as Prisma.InputJsonObject,
        result,
        locked: true,
        correctsRecordId: input.correctsRecordId ?? null,
        correctionReason: input.correctionReason ?? null,
        createdBy: me.id,
      },
    });
    // A normal PMS moves the next due date on. A correction fixes a record, it does not reset the schedule.
    // With no interval there is no next date: an earlier one must not stay behind as overdue for ever.
    if (!input.correctsRecordId) {
      await tx.asset.update({ where: { id: asset.id }, data: { nextPmsDue: asset.pmsFrequencyMonths ? addMonths(performedOn, asset.pmsFrequencyMonths) : null } });
      await clearReminders(tx, asset.id, ['pms']);
    }
    if ((await refreshPmsFlag(tx, asset.id)) && record.result === 'fail') await tellFailed(tx, asset, 'PMS');
    await audit(tx, req, { action: input.correctsRecordId ? 'pms.correct' : 'pms.submit', entityType: 'pms_record', entityId: record.id, after: record });
    return record;
  });
  const rows = await toPmsRows([await prisma.pmsRecord.findUniqueOrThrow({ where: { id: created.id }, include: pmsRecordInclude })]);
  res.status(201).json(rows[0] satisfies PmsRecordRow);
});

// Decision A: a PMS done by the OEM engineer carries the visit date from their report, which is entered later. The
// date may not be after today, more than OEM_PMS_MAX_DAYS_BACK days back, before the installation or before the
// asset's last PMS (so the schedule only moves forward and history cannot be rewritten). The report is required and
// is saved with the record in one transaction; neither can be changed afterwards. Our checklist is optional.
async function checkOemDate(asset: { id: string; installationDate: Date | null }, date: string) {
  const refuse = (message: string) => new HttpError(400, message, { fieldErrors: { performedOn: [message] } });
  const today = todayISO();
  if (date > today) throw refuse('The visit date cannot be in the future');
  if (date < addDaysISO(today, -OEM_PMS_MAX_DAYS_BACK)) throw refuse(`Only a visit in the last ${OEM_PMS_MAX_DAYS_BACK} days can be entered`);
  if (asset.installationDate && date < isoDate(asset.installationDate)) throw refuse(`This equipment was installed on ${prettyDate(asset.installationDate)}, after that date`);
  const last = await prisma.pmsRecord.findFirst({ where: { assetId: asset.id, correctsRecordId: null }, orderBy: { performedOn: 'desc' } });
  if (last && date < isoDate(last.performedOn)) throw refuse(`The last PMS on this equipment was on ${prettyDate(last.performedOn)}; a visit before it cannot be added`);
}

pmsRouter.post('/assets/:id/pms/oem', requirePermission('pms.perform'), upload.single('file'), async (req, res) => {
  const me = currentUser(req);
  let raw: unknown;
  try {
    raw = JSON.parse(String(req.body?.data ?? ''));
  } catch {
    throw new HttpError(400, 'Send the PMS details in the "data" field');
  }
  const input = oemPmsSchema.parse(raw);
  const asset = await findScopedAsset(req);
  if (asset.status !== 'active') throw new HttpError(409, 'PMS can only be recorded for equipment in active use');

  // A correction replaces an OEM entry (wrong report, engineer or result); it keeps the original's visit date.
  const original = input.correctsRecordId ? await prisma.pmsRecord.findUnique({ where: { id: input.correctsRecordId }, include: { template: true } }) : null;
  if (input.correctsRecordId && (!original || original.assetId !== asset.id)) throw new HttpError(400, 'That record is not for this asset');
  if (original && original.kind !== 'oem') throw new HttpError(400, 'An in-house PMS is corrected from its own record, with the checklist');
  if (!original) await checkOemDate(asset, input.performedOn);
  const performedOn = original ? original.performedOn : parseDate(input.performedOn);

  const answered = Object.keys(input.answers).length > 0;
  const template = answered ? (original?.template ?? (await latestTemplate(asset.equipmentTypeId))) : null;
  if (answered && !template) throw new HttpError(409, `No PMS checklist is set up for ${asset.equipmentType.name}; record the result from the report instead`);
  const { clean, result } = template ? evaluateAnswers(templateItems(template.schema), input.answers) : { clean: {}, result: input.result! };
  if (!req.file) throw new HttpError(400, 'Attach the service report from the OEM engineer', { fieldErrors: { file: ['Attach the report (PDF, JPG or PNG)'] } });

  const report = await stageUpload(req, `assets/${asset.id}`);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const record = await tx.pmsRecord.create({
        data: {
          assetId: asset.id,
          kind: 'oem',
          serviceBy: input.serviceBy,
          templateId: template?.id ?? null,
          performedOn,
          performedBy: me.id,
          answers: clean as Prisma.InputJsonObject,
          result,
          locked: true,
          correctsRecordId: input.correctsRecordId ?? null,
          correctionReason: input.correctionReason ?? null,
          createdBy: me.id,
        },
      });
      const file = await tx.attachment.create({ data: { ownerType: 'pms_record', ownerId: record.id, kind: 'service_report', ...report, createdBy: me.id } });
      // Like an in-house PMS, it moves the schedule on from the day it was done; a correction does not.
      if (!input.correctsRecordId) {
        await tx.asset.update({ where: { id: asset.id }, data: { nextPmsDue: asset.pmsFrequencyMonths ? addMonths(performedOn, asset.pmsFrequencyMonths) : null } });
        await clearReminders(tx, asset.id, ['pms']);
      }
      if ((await refreshPmsFlag(tx, asset.id)) && record.result === 'fail') await tellFailed(tx, asset, 'PMS');
      await audit(tx, req, { action: input.correctsRecordId ? 'pms.correct' : 'pms.submit_oem', entityType: 'pms_record', entityId: record.id, after: { ...record, report: file } });
      return record;
    });
    const rows = await toPmsRows([await prisma.pmsRecord.findUniqueOrThrow({ where: { id: created.id }, include: pmsRecordInclude })]);
    res.status(201).json(rows[0] satisfies PmsRecordRow);
  } catch (e) {
    await getStorage().remove(report.filePath).catch(() => undefined); // no report file without its record
    throw e;
  }
});

// ---------- Due list ---------- (must come before /pms/:id)

pmsRouter.get('/pms/due', requirePermission('pms.perform'), async (req, res) => {
  const { until, register } = dueQuerySchema.parse(req.query);
  res.json(await dueList(req, 'nextPmsDue', until, register));
});

pmsRouter.get('/pms/:id', requirePermission('pms.perform'), async (req, res) => {
  const record = await prisma.pmsRecord.findUnique({ where: { id: idOf(req) }, include: pmsRecordInclude });
  if (!record) throw new HttpError(404, 'PMS record not found');
  await findScopedAsset(req, record.assetId); // department scope
  res.json((await toPmsRows([record]))[0]);
});

