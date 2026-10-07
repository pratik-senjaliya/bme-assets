import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import type { Criticality, DueRow, PmsAnswer, PmsItem, PmsRecordRow, PmsResult } from '@bme/shared';
import { departmentScope, currentUser } from '../../lib/auth';
import { addMonths, daysFromToday, isoDate, parseDate, todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';

export const latestTemplate = (equipmentTypeId: string) =>
  prisma.pmsTemplate.findFirst({ where: { equipmentTypeId }, orderBy: { version: 'desc' } });

export const templateItems = (schema: Prisma.JsonValue): PmsItem[] => (schema as { items: PmsItem[] }).items;

// Checks the answers against the checklist the asset's template defines and works out the result.
// A reading outside its allowed range is a legitimate FAIL result, not an input error: it is what
// the engineer measured. Malformed or missing answers are input errors (400, per item).
export function evaluateAnswers(items: PmsItem[], answers: Record<string, PmsAnswer>) {
  const problems: Record<string, string[]> = {};
  const clean: Record<string, PmsAnswer> = {};
  let result: PmsResult = 'pass';

  for (const key of Object.keys(answers)) {
    if (!items.some((i) => i.id === key)) problems[key] = ['Not part of this checklist'];
  }
  for (const item of items) {
    const value = answers[item.id];
    const blank = value === undefined || value === '' || value === null;
    if (blank) {
      if (item.required) problems[item.id] = ['Required'];
      continue;
    }
    if (item.type === 'check') {
      if (value !== 'pass' && value !== 'fail') problems[item.id] = ['Choose Pass or Fail'];
      else {
        clean[item.id] = value;
        if (value === 'fail') result = 'fail';
      }
    } else if (item.type === 'reading') {
      if (typeof value !== 'number' || !Number.isFinite(value)) problems[item.id] = ['Enter a number'];
      else {
        clean[item.id] = value;
        if ((item.min != null && value < item.min) || (item.max != null && value > item.max)) result = 'fail';
      }
    } else if (typeof value !== 'string') {
      problems[item.id] = ['Enter text'];
    } else {
      clean[item.id] = value.trim();
    }
  }
  if (Object.keys(problems).length) throw new HttpError(400, 'Some checklist items need attention', { fieldErrors: problems });
  return { clean, result };
}

type RecordWithRefs = Prisma.PmsRecordGetPayload<{ include: { template: true; asset: { include: { equipmentType: true } } } }>;
export const pmsRecordInclude = { template: true, asset: { include: { equipmentType: true } } } satisfies Prisma.PmsRecordInclude;

export async function toPmsRows(records: RecordWithRefs[]): Promise<PmsRecordRow[]> {
  const [users, corrections, settings] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set(records.map((r) => r.performedBy))] } }, select: { id: true, name: true } }),
    prisma.pmsRecord.findMany({ where: { correctsRecordId: { in: records.map((r) => r.id) } }, orderBy: { submittedAt: 'asc' }, select: { id: true, correctsRecordId: true } }),
    prisma.hospitalSettings.findFirstOrThrow({ select: { name: true } }),
  ]);
  const correctedBy = new Map(corrections.map((c) => [c.correctsRecordId!, c.id])); // latest wins
  return records.map((r) => ({
    id: r.id,
    assetId: r.assetId,
    assetCode: r.asset.assetCode,
    assetName: r.asset.name,
    equipmentTypeName: r.asset.equipmentType.name,
    templateVersion: r.template.version,
    items: templateItems(r.template.schema),
    answers: r.answers as Record<string, PmsAnswer>,
    performedOn: isoDate(r.performedOn),
    performedByName: users.find((u) => u.id === r.performedBy)?.name ?? 'Unknown',
    submittedAt: r.submittedAt.toISOString(),
    result: r.result as PmsResult,
    locked: true,
    correctsRecordId: r.correctsRecordId,
    correctionReason: r.correctionReason,
    correctedByRecordId: correctedBy.get(r.id) ?? null,
    hospitalName: settings.name,
  }));
}

// Active equipment whose next PMS / calibration is due on or before `until` (overdue included, soonest first).
// Condemned and not-in-use equipment never appear (business rule 7).
export async function dueList(req: Request, field: 'nextPmsDue' | 'nextCalibrationDue', until?: string): Promise<DueRow[]> {
  const limit = until ?? isoDate(addMonths(parseDate(todayISO()), 1));
  const assets = await prisma.asset.findMany({
    where: { status: 'active', [field]: { not: null, lte: parseDate(limit) }, ...departmentScope(currentUser(req)) },
    include: { equipmentType: true, department: true, location: true },
    orderBy: [{ [field]: 'asc' }, { assetCode: 'asc' }],
    take: 1000,
  });
  return assets.map((a) => {
    const due = a[field]!;
    return {
      assetId: a.id,
      assetCode: a.assetCode,
      assetName: a.name,
      equipmentTypeName: a.equipmentType.name,
      departmentName: a.department.name,
      locationName: a.location.name,
      criticality: a.criticality as Criticality,
      dueDate: isoDate(due),
      daysLeft: daysFromToday(due),
    };
  });
}
