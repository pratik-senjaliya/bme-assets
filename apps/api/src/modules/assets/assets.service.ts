import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import type { AssetDetail, AssetRow, Criticality, WarrantyStatus } from '@bme/shared';
import { auditMany } from '../../lib/audit';
import { currentUser, departmentScope } from '../../lib/auth';
import { formatAssetCode } from '../../lib/assetCode';
import { addMonths, daysBetween, isoDateOrNull, parseDate, todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { idOf } from '../../lib/validate';

type Db = Prisma.TransactionClient;

export const assetInclude = { equipmentType: true, department: true, location: true } satisfies Prisma.AssetInclude;
export type AssetWithRefs = Prisma.AssetGetPayload<{ include: typeof assetInclude }>;

const WARRANTY_EXPIRING_DAYS = 30;

// Age and warranty status are calculated on read, never stored (they change every day).
export function toAssetRow(a: AssetWithRefs): AssetRow {
  const today = parseDate(todayISO());
  let ageMonths: number | null = null;
  if (a.installationDate) {
    const i = a.installationDate;
    ageMonths = (today.getUTCFullYear() - i.getUTCFullYear()) * 12 + (today.getUTCMonth() - i.getUTCMonth());
    if (today.getUTCDate() < i.getUTCDate()) ageMonths -= 1;
    ageMonths = Math.max(0, ageMonths);
  }
  let warrantyStatus: WarrantyStatus = 'none';
  if (a.warrantyEnd) {
    const left = daysBetween(today, a.warrantyEnd);
    warrantyStatus = left < 0 ? 'expired' : left <= WARRANTY_EXPIRING_DAYS ? 'expiring' : 'active';
  }
  return {
    id: a.id,
    assetCode: a.assetCode,
    name: a.name,
    make: a.make,
    model: a.model,
    serialNo: a.serialNo,
    equipmentTypeId: a.equipmentTypeId,
    equipmentTypeName: a.equipmentType.name,
    departmentId: a.departmentId,
    departmentName: a.department.name,
    locationId: a.locationId,
    locationName: a.location.name,
    criticality: a.criticality as Criticality,
    status: a.status,
    installationDate: isoDateOrNull(a.installationDate),
    warrantyEnd: isoDateOrNull(a.warrantyEnd),
    warrantyStatus,
    ageMonths,
    nextPmsDue: isoDateOrNull(a.nextPmsDue),
    nextCalibrationDue: isoDateOrNull(a.nextCalibrationDue),
  };
}

export const toAssetDetail = (a: AssetWithRefs): AssetDetail => ({
  ...toAssetRow(a),
  warrantyMonths: a.warrantyMonths,
  pmsFrequencyMonths: a.pmsFrequencyMonths,
  openingPmsOn: isoDateOrNull(a.openingPmsOn),
  openingCalibrationOn: isoDateOrNull(a.openingCalibrationOn),
  createdAt: a.createdAt.toISOString(),
});

export const warrantyEndFor = (installationDate: Date | null | undefined, months: number | null | undefined) =>
  installationDate && months != null ? addMonths(installationDate, months) : null;

// A location must belong to the asset's department (asset IDs and nursing scope depend on it).
export async function assertLocationInDepartment(departmentId: string, locationId: string, db: Db | typeof prisma = prisma) {
  const location = await db.location.findUnique({ where: { id: locationId } });
  if (!location || location.departmentId !== departmentId) {
    throw new HttpError(400, 'That location does not belong to the chosen department', {
      fieldErrors: { locationId: ['Choose a location in this department'] },
    });
  }
}

export async function assertSerialFree(serialNo: string | null | undefined, exceptAssetId?: string) {
  if (!serialNo) return;
  const clash = await prisma.asset.findFirst({ where: { serialNo, ...(exceptAssetId ? { id: { not: exceptAssetId } } : {}) } });
  if (clash) {
    throw new HttpError(409, `Serial number already used by ${clash.assetCode}`, {
      fieldErrors: { serialNo: [`Already used by ${clash.assetCode}`] },
    });
  }
}

export type NewAsset = {
  equipmentTypeId: string;
  name: string;
  make?: string | null;
  model?: string | null;
  serialNo?: string | null;
  departmentId: string;
  locationId: string;
  criticality?: Criticality;
  installationDate?: string | null;
  warrantyMonths?: number | null;
  pmsFrequencyMonths?: number | null;
  openingPmsOn?: string | null;
  openingCalibrationOn?: string | null;
};

// "Last done before this system" dates for existing equipment: a real past date, not before installation.
// Throws a field error the form can show. (Not a PMS record: the PMS date lock does not apply to it.)
export function assertOpeningDate(field: 'openingPmsOn' | 'openingCalibrationOn', value: string | null | undefined, installationDate?: string | null) {
  if (!value) return;
  const fail = (message: string) => new HttpError(400, message, { fieldErrors: { [field]: [message] } });
  if (value > todayISO()) throw fail('Cannot be in the future');
  if (installationDate && value < installationDate) throw fail('Cannot be before the installation date');
}

// Creates assets with generated IDs. The sequence is taken with ONE atomic increment on the settings
// row inside the caller's transaction, so concurrent creates serialize on that row lock and can never
// get the same number. The first asset also locks the ID pattern. Numbers are never handed back,
// so IDs are never reused. Used by the single-create route and the Excel import.
export async function createAssets(tx: Db, req: Request, inputs: NewAsset[]) {
  const unique = <K extends keyof NewAsset>(k: K) => [...new Set(inputs.map((i) => i[k] as string))];
  const [departments, locations, types] = [
    await tx.department.findMany({ where: { id: { in: unique('departmentId') } } }),
    await tx.location.findMany({ where: { id: { in: unique('locationId') } } }),
    await tx.equipmentType.findMany({ where: { id: { in: unique('equipmentTypeId') } } }),
  ];
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const [dept, loc, type] = [byId(departments), byId(locations), byId(types)];

  const { id } = await tx.hospitalSettings.findFirstOrThrow({ select: { id: true } });
  const settings = await tx.hospitalSettings.update({
    where: { id },
    data: { assetSeq: { increment: inputs.length }, patternLocked: true },
  });
  const firstSeq = settings.assetSeq - inputs.length + 1;

  for (const i of inputs) {
    assertOpeningDate('openingPmsOn', i.openingPmsOn, i.installationDate);
    assertOpeningDate('openingCalibrationOn', i.openingCalibrationOn, i.installationDate);
  }

  const data = inputs.map((i, n) => {
    const installationDate = i.installationDate ? parseDate(i.installationDate) : null;
    const openingPmsOn = i.openingPmsOn ? parseDate(i.openingPmsOn) : null;
    const openingCalibrationOn = i.openingCalibrationOn ? parseDate(i.openingCalibrationOn) : null;
    const equipmentType = type.get(i.equipmentTypeId)!;
    const sequenceNo = firstSeq + n;
    const pmsFrequencyMonths = i.pmsFrequencyMonths ?? equipmentType.defaultPmsMonths;
    return {
      assetCode: formatAssetCode(settings.assetIdPattern, {
        hosp: settings.shortCode,
        dept: dept.get(i.departmentId)!.code,
        type: equipmentType.code,
        loc: loc.get(i.locationId)!.code,
        seq: sequenceNo,
      }),
      sequenceNo,
      equipmentTypeId: i.equipmentTypeId,
      name: i.name,
      make: i.make ?? null,
      model: i.model ?? null,
      serialNo: i.serialNo ?? null,
      departmentId: i.departmentId,
      locationId: i.locationId,
      criticality: i.criticality ?? 'medium',
      installationDate,
      warrantyMonths: i.warrantyMonths ?? null,
      warrantyEnd: warrantyEndFor(installationDate, i.warrantyMonths),
      pmsFrequencyMonths,
      openingPmsOn,
      openingCalibrationOn,
      // First due dates run from the last PMS / calibration done before this system (existing equipment), else from
      // installation; after that PMS and calibration records move them on.
      nextPmsDue: firstDue(openingPmsOn ?? installationDate, pmsFrequencyMonths),
      nextCalibrationDue: firstDue(openingCalibrationOn ?? installationDate, equipmentType.defaultCalibrationMonths),
      createdBy: req.user?.id ?? null,
    };
  });

  const rows = await tx.asset.createManyAndReturn({ data });
  await auditMany(
    tx,
    req,
    rows.map((r) => ({ action: 'asset.create', entityType: 'asset', entityId: r.id, after: r })),
  );
  return rows;
}

export const firstDue = (from: Date | null, months: number | null | undefined) => (from && months ? addMonths(from, months) : null);

// Long enough for large imports while other creates wait on the counter row.
export const CREATE_TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

// The one way to load an asset for a request. Department scope is applied here, so nursing never sees
// another department's asset, and a foreign id looks exactly like a missing one (404).
export async function findScopedAsset(req: Request, id: string = idOf(req)) {
  const asset = await prisma.asset.findFirst({ where: { id, ...departmentScope(currentUser(req)) }, include: assetInclude });
  if (!asset) throw new HttpError(404, 'Asset not found');
  return asset;
}
