import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  licenceListQuerySchema,
  licenceSchema,
  renewLicenceSchema,
  type LicenceInput,
  type LicenceKind,
  type LicenceRow,
  type LicenceStatus,
  type Register,
  type RenewLicenceInput,
} from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, requirePermission, scopeOf } from '../../lib/auth';
import { daysBetween, isoDate, parseDate, todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { facilityOn } from '../../lib/people';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';

// Statutory licences and inspections (facility add-on, F3, docs/requirements-facility.md): lift licence, fire NOC,
// DG pollution certificate, PESO, pressure vessels, water tests, AERB. Kept by the team of what a licence covers;
// site-wide ones by the team chosen (facility by default). A renewal is a new licence; the old one stays, renewed.
export const licencesRouter = Router();
licencesRouter.use(requirePermission('licence.manage'));
// Part of the add-on: off, there are no licences for anyone.
licencesRouter.use(async (_req, _res, next) => {
  if (!(await facilityOn())) return next(new HttpError(404, 'Licences are part of the facility maintenance add-on, which is off'));
  next();
});

export const licenceInclude = { asset: { select: { assetCode: true, name: true } }, renewal: { select: { id: true } } } satisfies Prisma.LicenceInclude;
type WithRefs = Prisma.LicenceGetPayload<{ include: typeof licenceInclude }>;

// Within this many days a licence reads "ending": the hospital's longest reminder lead.
export const endingDays = async () => Math.max(...(await prisma.hospitalSettings.findFirstOrThrow({ select: { reminderDays: true } })).reminderDays, 30);

export function licenceStatus(l: { validTo: Date; renewal: { id: string } | null }, today: string, ending: number): { status: LicenceStatus; daysLeft: number } {
  const daysLeft = daysBetween(parseDate(today), l.validTo);
  return { daysLeft, status: l.renewal ? 'renewed' : daysLeft < 0 ? 'expired' : daysLeft <= ending ? 'ending' : 'valid' };
}

export async function toLicenceRows(rows: WithRefs[]): Promise<LicenceRow[]> {
  const [ending, files] = await Promise.all([
    endingDays(),
    prisma.attachment.groupBy({ by: ['ownerId'], where: { ownerType: 'licence', ownerId: { in: rows.map((l) => l.id) } }, _count: true }),
  ]);
  const today = todayISO();
  return rows.map((l) => ({
    id: l.id,
    kind: l.kind as LicenceKind,
    name: l.name,
    authority: l.authority,
    number: l.number,
    validFrom: l.validFrom && isoDate(l.validFrom),
    validTo: isoDate(l.validTo),
    ...licenceStatus(l, today, ending),
    assetId: l.assetId,
    assetCode: l.asset?.assetCode ?? null,
    assetName: l.asset?.name ?? null,
    register: l.register,
    notes: l.notes,
    renewsId: l.renewsId,
    attachmentCount: files.find((f) => f.ownerId === l.id)?._count ?? 0,
  }));
}

// The licences a person keeps: those of their registers (and, for a covered item, one they may see).
export const licenceScope = (me: ReturnType<typeof currentUser>, register?: Register): Prisma.LicenceWhereInput => {
  const scope = scopeOf(me, register);
  return { register: scope.register, ...(scope.departmentId && { OR: [{ assetId: null }, { asset: { departmentId: scope.departmentId } }] }) };
};

async function findScoped(req: Request) {
  const l = await prisma.licence.findFirst({ where: { id: idOf(req), ...licenceScope(currentUser(req)) }, include: licenceInclude });
  if (!l) throw new HttpError(404, 'Licence not found');
  return l;
}

// The covered item decides the team; a site-wide licence takes the team asked for, if the person keeps that team's.
async function ownerOf(req: Request, input: Pick<LicenceInput, 'assetId' | 'register'>) {
  const me = currentUser(req);
  if (input.assetId) {
    const asset = await prisma.asset.findFirst({ where: { id: input.assetId, ...scopeOf(me) } });
    if (!asset) throw new HttpError(400, 'Choose equipment you look after', { fieldErrors: { assetId: ['Not found'] } });
    return { assetId: asset.id, register: asset.register };
  }
  const register = input.register ?? (me.registers.includes('facility') ? 'facility' : me.registers[0]);
  if (!me.registers.includes(register)) throw new HttpError(400, 'Choose your own team', { fieldErrors: { register: ['Not your team'] } });
  return { assetId: null, register };
}

licencesRouter.get('/', async (req, res) => {
  const q = licenceListQuerySchema.parse(req.query);
  const me = currentUser(req);
  const rows = await toLicenceRows(
    await prisma.licence.findMany({
      where: { ...licenceScope(me, q.register), ...(q.assetId && { assetId: q.assetId }) },
      include: licenceInclude,
      orderBy: [{ validTo: 'asc' }, { name: 'asc' }],
    }),
  );
  const keep = (r: LicenceRow) =>
    !q.status ? true : q.status === 'current' ? r.status !== 'renewed' : q.status === 'attention' ? r.status === 'ending' || r.status === 'expired' : r.status === q.status;
  res.json(rows.filter(keep));
});

licencesRouter.get('/:id', async (req, res) => {
  res.json((await toLicenceRows([await findScoped(req)]))[0]);
});

licencesRouter.post('/', validate(licenceSchema), async (req, res) => {
  const input = req.body as LicenceInput;
  const owner = await ownerOf(req, input);
  const me = currentUser(req);
  const row = await prisma.$transaction(async (tx) => {
    const l = await tx.licence.create({
      data: { kind: input.kind, name: input.name, authority: input.authority, number: input.number ?? null, validFrom: input.validFrom ? parseDate(input.validFrom) : null, validTo: parseDate(input.validTo), notes: input.notes ?? null, ...owner, createdBy: me.id },
    });
    await audit(tx, req, { action: 'licence.create', entityType: 'licence', entityId: l.id, after: l });
    return l;
  });
  res.status(201).json((await toLicenceRows([await prisma.licence.findUniqueOrThrow({ where: { id: row.id }, include: licenceInclude })]))[0]);
});

// Corrections to a licence as entered (a typo in the number, the wrong date). A renewal is not an edit: see /renew.
licencesRouter.patch('/:id', validate(licenceSchema), async (req, res) => {
  const before = await findScoped(req);
  const input = req.body as LicenceInput;
  const owner = await ownerOf(req, input);
  await prisma.$transaction(async (tx) => {
    const after = await tx.licence.update({
      where: { id: before.id },
      data: { kind: input.kind, name: input.name, authority: input.authority, number: input.number ?? null, validFrom: input.validFrom ? parseDate(input.validFrom) : null, validTo: parseDate(input.validTo), notes: input.notes ?? null, ...owner },
    });
    await audit(tx, req, { action: 'licence.update', entityType: 'licence', entityId: before.id, before, after });
  });
  res.json((await toLicenceRows([await prisma.licence.findUniqueOrThrow({ where: { id: before.id }, include: licenceInclude })]))[0]);
});

// The authority issued a new one: a new licence for the same thing, linked to this one, which stays as history. Its
// reminders stop (it reads "Renewed").
licencesRouter.post('/:id/renew', validate(renewLicenceSchema), async (req, res) => {
  const before = await findScoped(req);
  const input = req.body as RenewLicenceInput;
  if (before.renewal) throw new HttpError(409, 'This licence has already been renewed');
  if (parseDate(input.validTo) <= before.validTo) throw new HttpError(400, 'The renewal must run past the current one', { fieldErrors: { validTo: [`After ${isoDate(before.validTo)}`] } });
  const me = currentUser(req);
  const row = await prisma.$transaction(async (tx) => {
    const l = await tx.licence.create({
      data: {
        kind: before.kind, name: before.name, authority: before.authority, assetId: before.assetId, register: before.register,
        number: input.number ?? before.number, validFrom: input.validFrom ? parseDate(input.validFrom) : null, validTo: parseDate(input.validTo), notes: input.notes ?? before.notes,
        renewsId: before.id, createdBy: me.id,
      },
    });
    await tx.notification.deleteMany({ where: { licenceId: before.id, readAt: null } }); // its reminders no longer apply
    await audit(tx, req, { action: 'licence.renew', entityType: 'licence', entityId: l.id, before, after: l });
    return l;
  });
  res.status(201).json((await toLicenceRows([await prisma.licence.findUniqueOrThrow({ where: { id: row.id }, include: licenceInclude })]))[0]);
});

// Only a licence entered by mistake, by the HOD: one with a renewal, or that renews another, is history.
licencesRouter.delete('/:id', requirePermission('approval.decide'), async (req, res) => {
  const l = await findScoped(req);
  if (l.renewal || l.renewsId) throw new HttpError(409, 'This licence is part of a renewal history, so it stays');
  if (await prisma.attachment.count({ where: { ownerType: 'licence', ownerId: l.id } })) throw new HttpError(409, 'This licence has documents, so it stays. Correct it instead.');
  await prisma.$transaction(async (tx) => {
    await tx.notification.deleteMany({ where: { licenceId: l.id } });
    await tx.licence.delete({ where: { id: l.id } });
    await audit(tx, req, { action: 'licence.delete', entityType: 'licence', entityId: l.id, before: l });
  });
  res.status(204).end();
});
