import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  dueQuerySchema,
  pmsTemplateBodySchema,
  submitPmsSchema,
  type PmsRecordRow,
  type PmsTemplateBody,
  type PmsTemplateRow,
  type SubmitPmsInput,
} from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, requireAnyPermission, requirePermission } from '../../lib/auth';
import { addMonths, parseDate, todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';
import { findScopedAsset } from '../assets/assets.service';
import { dueList, evaluateAnswers, latestTemplate, pmsRecordInclude, templateItems, toPmsRows } from './pms.service';

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
    where: typeId ? { equipmentTypeId: typeId } : {},
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

  const template = await latestTemplate(asset.equipmentTypeId);
  if (!template) throw new HttpError(409, `No PMS checklist is set up for ${asset.equipmentType.name} yet`);
  const { clean, result } = evaluateAnswers(templateItems(template.schema), input.answers);

  if (input.correctsRecordId) {
    const original = await prisma.pmsRecord.findUnique({ where: { id: input.correctsRecordId } });
    if (!original || original.assetId !== asset.id) throw new HttpError(400, 'That record is not for this asset');
  }

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
    if (!input.correctsRecordId && asset.pmsFrequencyMonths) {
      await tx.asset.update({ where: { id: asset.id }, data: { nextPmsDue: addMonths(performedOn, asset.pmsFrequencyMonths) } });
    }
    await audit(tx, req, { action: input.correctsRecordId ? 'pms.correct' : 'pms.submit', entityType: 'pms_record', entityId: record.id, after: record });
    return record;
  });
  const rows = await toPmsRows([await prisma.pmsRecord.findUniqueOrThrow({ where: { id: created.id }, include: pmsRecordInclude })]);
  res.status(201).json(rows[0] satisfies PmsRecordRow);
});

// ---------- Due list ---------- (must come before /pms/:id)

pmsRouter.get('/pms/due', requirePermission('pms.perform'), async (req, res) => {
  const { until } = dueQuerySchema.parse(req.query);
  res.json(await dueList(req, 'nextPmsDue', until));
});

pmsRouter.get('/pms/:id', requirePermission('pms.perform'), async (req, res) => {
  const record = await prisma.pmsRecord.findUnique({ where: { id: idOf(req) }, include: pmsRecordInclude });
  if (!record) throw new HttpError(404, 'PMS record not found');
  await findScopedAsset(req, record.assetId); // department scope
  res.json((await toPmsRows([record]))[0]);
});

