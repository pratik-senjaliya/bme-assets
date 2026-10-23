import { Router, type Request } from 'express';
import {
  correctReadingSchema,
  isGone,
  pmsHoursSchema,
  readingTypeSchema,
  recordReadingSchema,
  registerQuerySchema,
  type AssetReadings,
  type CorrectReadingInput,
  type PmsHoursInput,
  type ReadingAttention,
  type ReadingTypeInput,
  type RecordReadingInput,
} from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, requirePermission, scopeOf } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { facilityOn, registerTeam } from '../../lib/people';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';
import { notify } from '../approvals/approvals.service';
import { findScopedAsset } from '../assets/assets.service';
import { effective, hoursDue, readingInclude, runHoursInfo, toReadingRows, toTypeRows, typeInclude } from './readings.service';

// The plant-room logbook (facility add-on, F4, docs/requirements-facility.md): each item has the readings it takes
// (name, unit, normal range, how often); a reading is dated by the server and cannot be edited (a database trigger),
// a wrong one is put right by a linked correction. A reading outside its range tells the team; one not taken in its
// period shows on My work. A run-hours meter lets PMS be due every N hours.
export const readingsRouter = Router();
readingsRouter.use(async (_req, _res, next) => {
  if (!(await facilityOn())) return next(new HttpError(404, 'The logbook is part of the facility maintenance add-on, which is off'));
  next();
});
const RECORD = requirePermission('reading.record');
const SET_UP = requirePermission('asset.edit');

// A reading type of a machine the person may see.
async function scopedType(req: Request, id = idOf(req)) {
  const t = await prisma.readingType.findFirst({ where: { id, asset: scopeOf(currentUser(req)) }, include: { ...typeInclude, asset: { include: { location: true } } } });
  if (!t) throw new HttpError(404, 'Reading not found');
  return t;
}

const outside = (t: { min: number | null; max: number | null }, v: number) => (t.min != null && v < t.min) || (t.max != null && v > t.max);
const range = (t: { min: number | null; max: number | null; unit: string }) => (t.min != null && t.max != null ? `${t.min}–${t.max} ${t.unit}` : t.min != null ? `at least ${t.min} ${t.unit}` : `at most ${t.max} ${t.unit}`);

// Everything about one machine's readings: its types with the last value, its recent readings, and run hours.
readingsRouter.get('/assets/:id', RECORD, async (req, res) => {
  const asset = await findScopedAsset(req);
  const [types, readings, runHours] = await Promise.all([
    prisma.readingType.findMany({ where: { assetId: asset.id }, include: typeInclude, orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
    prisma.reading.findMany({ where: { assetId: asset.id }, include: readingInclude, orderBy: { takenAt: 'desc' }, take: 100 }),
    runHoursInfo(asset),
  ]);
  const body: AssetReadings = { types: await toTypeRows(types), readings: await toReadingRows(readings), runHours };
  res.json(body);
});

readingsRouter.post('/assets/:id/types', SET_UP, validate(readingTypeSchema), async (req, res) => {
  const asset = await findScopedAsset(req);
  const input = req.body as ReadingTypeInput;
  if (await prisma.readingType.findFirst({ where: { assetId: asset.id, name: { equals: input.name, mode: 'insensitive' } } })) {
    throw new HttpError(409, `${asset.assetCode} already has a reading called ${input.name}`, { fieldErrors: { name: ['Already exists on this item'] } });
  }
  if (input.runHours && (await prisma.readingType.count({ where: { assetId: asset.id, runHours: true } }))) {
    throw new HttpError(409, 'This item already has a run-hours meter', { fieldErrors: { runHours: ['Already has one'] } });
  }
  const t = await prisma.$transaction(async (tx) => {
    const row = await tx.readingType.create({ data: { ...input, min: input.min ?? null, max: input.max ?? null, runHours: !!input.runHours, assetId: asset.id, createdBy: currentUser(req).id } });
    await audit(tx, req, { action: 'reading_type.create', entityType: 'reading_type', entityId: row.id, after: row });
    return row;
  });
  res.status(201).json((await toTypeRows([await prisma.readingType.findUniqueOrThrow({ where: { id: t.id }, include: typeInclude })]))[0]);
});

// Name, unit, range and how often can change; readings already taken keep their out-of-range mark as it was then.
readingsRouter.patch('/types/:id', SET_UP, validate(readingTypeSchema), async (req, res) => {
  const before = await scopedType(req);
  const input = req.body as ReadingTypeInput;
  const used = await prisma.reading.count({ where: { readingTypeId: before.id } });
  if (used && input.kind !== before.kind) throw new HttpError(409, 'Readings were taken already, so a level cannot become a meter (or back)', { fieldErrors: { kind: ['Locked: readings exist'] } });
  if (input.runHours && !before.runHours && (await prisma.readingType.count({ where: { assetId: before.assetId, runHours: true } }))) {
    throw new HttpError(409, 'This item already has a run-hours meter', { fieldErrors: { runHours: ['Already has one'] } });
  }
  await prisma.$transaction(async (tx) => {
    const after = await tx.readingType.update({ where: { id: before.id }, data: { ...input, min: input.min ?? null, max: input.max ?? null, runHours: !!input.runHours } });
    await audit(tx, req, { action: 'reading_type.update', entityType: 'reading_type', entityId: before.id, before, after });
  });
  res.json((await toTypeRows([await prisma.readingType.findUniqueOrThrow({ where: { id: before.id }, include: typeInclude })]))[0]);
});

// Take a reading now. A meter never goes backwards (a wrong earlier reading is corrected first). Outside the normal
// range: the item's team hears at once.
readingsRouter.post('/types/:id', RECORD, validate(recordReadingSchema), async (req, res) => {
  const t = await scopedType(req);
  const input = req.body as RecordReadingInput;
  const me = currentUser(req);
  if (!t.active) throw new HttpError(409, `${t.name} is no longer read`);
  if (isGone(t.asset.status)) throw new HttpError(409, `This equipment has been ${t.asset.status}`);
  if (t.kind === 'meter') {
    const last = await prisma.reading.findFirst({ where: { readingTypeId: t.id, ...effective }, orderBy: { takenAt: 'desc' } });
    if (last && input.value < last.value) throw new HttpError(400, `A meter does not go back: the last reading was ${last.value} ${t.unit}`, { fieldErrors: { value: [`At least ${last.value}`] } });
  }
  const out = outside(t, input.value);
  const team = out ? (await registerTeam(t.asset.register, 'reading.record', 'notification.view')).filter((id) => id !== me.id) : [];
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.reading.create({ data: { readingTypeId: t.id, assetId: t.assetId, value: input.value, note: input.note ?? null, takenBy: me.id, outOfRange: out } });
    await audit(tx, req, { action: 'reading.create', entityType: 'reading', entityId: r.id, after: r });
    if (out) await notify(tx, team, `Reading out of range: ${t.asset.assetCode} ${t.asset.name}, ${t.name} ${input.value} ${t.unit} (normal ${range(t)}), by ${me.name}`, t.assetId, 'reading');
    return r;
  });
  res.status(201).json((await toReadingRows([await prisma.reading.findUniqueOrThrow({ where: { id: row.id }, include: readingInclude })]))[0]);
});

// A wrong reading is put right by a new one linked to it, with the reason; the original stays and stops counting.
readingsRouter.post('/:id/correct', RECORD, validate(correctReadingSchema), async (req, res) => {
  const original = await prisma.reading.findFirst({ where: { id: idOf(req), asset: scopeOf(currentUser(req)) }, include: { correctedBy: true, type: true } });
  if (!original) throw new HttpError(404, 'Reading not found');
  if (original.correctedBy) throw new HttpError(409, 'This reading has already been corrected');
  const input = req.body as CorrectReadingInput;
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.reading.create({
      data: { readingTypeId: original.readingTypeId, assetId: original.assetId, value: input.value, takenBy: currentUser(req).id, outOfRange: outside(original.type, input.value), correctsId: original.id, correctionReason: input.reason },
    });
    await audit(tx, req, { action: 'reading.correct', entityType: 'reading', entityId: r.id, before: original, after: r });
    return r;
  });
  res.status(201).json((await toReadingRows([await prisma.reading.findUniqueOrThrow({ where: { id: row.id }, include: readingInclude })]))[0]);
});

readingsRouter.put('/assets/:id/pms-hours', SET_UP, validate(pmsHoursSchema), async (req, res) => {
  const before = await findScopedAsset(req);
  const { pmsEveryHours } = req.body as PmsHoursInput;
  if (pmsEveryHours != null && !(await prisma.readingType.count({ where: { assetId: before.id, runHours: true } }))) {
    throw new HttpError(409, 'Add a run-hours meter to this item first', { fieldErrors: { pmsEveryHours: ['No run-hours meter'] } });
  }
  const after = await prisma.$transaction(async (tx) => {
    const a = await tx.asset.update({ where: { id: before.id }, data: { pmsEveryHours } });
    await audit(tx, req, { action: 'asset.pms_hours', entityType: 'asset', entityId: before.id, before: { pmsEveryHours: before.pmsEveryHours }, after: { pmsEveryHours } });
    return a;
  });
  res.json(await runHoursInfo(after));
});

// The logbook: every active reading of the person's equipment, those owed now first.
readingsRouter.get('/logbook', RECORD, async (req, res) => {
  const { register } = registerQuerySchema.parse(req.query);
  const types = await prisma.readingType.findMany({ where: { active: true, asset: { ...scopeOf(currentUser(req), register), status: 'active' } }, include: typeInclude, orderBy: [{ asset: { assetCode: 'asc' } }, { name: 'asc' }] });
  const rows = await toTypeRows(types);
  res.json(rows.sort((a, b) => Number(b.dueNow) - Number(a.dueNow)));
});

// For My work: readings not taken in their period, items whose last reading was out of range, PMS due by hours.
readingsRouter.get('/attention', RECORD, async (req, res) => {
  const scope = scopeOf(currentUser(req));
  const rows = await toTypeRows(await prisma.readingType.findMany({ where: { active: true, asset: { ...scope, status: 'active' } }, include: typeInclude }));
  const body: ReadingAttention = { missed: rows.filter((r) => r.dueNow), outOfRange: rows.filter((r) => r.last?.outOfRange), hoursDue: await hoursDue(scope) };
  res.json(body);
});
