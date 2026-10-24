import { Prisma } from '@prisma/client';
import { addDaysISO, todayISO, zonedDayStart } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import type { HoursDueRow, ReadingEvery, ReadingKind, ReadingRow, ReadingTypeRow, RunHoursInfo } from '@bme/shared';

type Db = Prisma.TransactionClient | typeof prisma;

export const readingInclude = { type: { select: { name: true, unit: true } }, correctedBy: { select: { id: true } } } satisfies Prisma.ReadingInclude;
type ReadingWithRefs = Prisma.ReadingGetPayload<{ include: typeof readingInclude }>;
export const typeInclude = { asset: { select: { assetCode: true, name: true, register: true, location: { select: { name: true } } } } } satisfies Prisma.ReadingTypeInclude;
type TypeWithRefs = Prisma.ReadingTypeGetPayload<{ include: typeof typeInclude }>;

// A reading that a later correction replaced no longer counts (last value, run hours, consumption).
export const effective = { correctedBy: null } satisfies Prisma.ReadingWhereInput;

export async function toReadingRows(rows: ReadingWithRefs[]): Promise<ReadingRow[]> {
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.takenBy))] } }, select: { id: true, name: true } });
  return rows.map((r) => ({
    id: r.id,
    readingTypeId: r.readingTypeId,
    typeName: r.type.name,
    unit: r.type.unit,
    value: r.value,
    takenAt: r.takenAt.toISOString(),
    takenByName: people.find((p) => p.id === r.takenBy)?.name ?? 'Unknown',
    note: r.note,
    outOfRange: r.outOfRange,
    correctsId: r.correctsId,
    correctionReason: r.correctionReason,
    corrected: !!r.correctedBy,
  }));
}

// When a reading is next owed: once today, once in the last 7 days, or once this month (hospital calendar).
export function periodStart(every: ReadingEvery, today = todayISO()) {
  if (every === 'day') return zonedDayStart(today);
  if (every === 'week') return zonedDayStart(addDaysISO(today, -6));
  return zonedDayStart(`${today.slice(0, 7)}-01`);
}

export async function toTypeRows(types: TypeWithRefs[]): Promise<ReadingTypeRow[]> {
  const lasts = await Promise.all(types.map((t) => prisma.reading.findFirst({ where: { readingTypeId: t.id, ...effective }, include: readingInclude, orderBy: { takenAt: 'desc' } })));
  const rows = await toReadingRows(lasts.filter((r): r is ReadingWithRefs => !!r));
  return types.map((t, i) => {
    const last = lasts[i] ? rows.find((r) => r.id === lasts[i]!.id)! : null;
    return {
      id: t.id,
      assetId: t.assetId,
      assetCode: t.asset.assetCode,
      assetName: t.asset.name,
      locationName: t.asset.location.name,
      register: t.asset.register,
      name: t.name,
      unit: t.unit,
      kind: t.kind as ReadingKind,
      min: t.min,
      max: t.max,
      every: t.every as ReadingEvery,
      runHours: t.runHours,
      active: t.active,
      last,
      dueNow: t.active && (!lasts[i] || lasts[i]!.takenAt < periodStart(t.every as ReadingEvery)),
    };
  });
}

// The run-hours meter at a moment (now, or the end of a day for an OEM visit): the latest reading that still counts.
export async function hoursAt(db: Db, assetId: string, at?: Date) {
  const r = await db.reading.findFirst({ where: { assetId, type: { runHours: true }, ...effective, ...(at && { takenAt: { lt: at } }) }, orderBy: { takenAt: 'desc' }, select: { value: true } });
  return r?.value ?? null;
}

// PMS by run hours: due at the meter of the last PMS plus the interval; before any PMS, from the first reading.
export async function runHoursInfo(asset: { id: string; pmsEveryHours: number | null; lastPmsHours: number | null }): Promise<RunHoursInfo> {
  const hoursNow = await hoursAt(prisma, asset.id);
  const first = asset.lastPmsHours ?? (await prisma.reading.findFirst({ where: { assetId: asset.id, type: { runHours: true }, ...effective }, orderBy: { takenAt: 'asc' }, select: { value: true } }))?.value ?? null;
  const pmsDueAtHours = asset.pmsEveryHours != null && first != null ? first + asset.pmsEveryHours : null;
  return { pmsEveryHours: asset.pmsEveryHours, lastPmsHours: asset.lastPmsHours, hoursNow, pmsDueAtHours, hoursLeft: pmsDueAtHours != null && hoursNow != null ? Math.round((pmsDueAtHours - hoursNow) * 10) / 10 : null };
}

// The latest reading that still counts (not corrected) for each reading type, in one query.
export async function latestEffective(typeIds: string[]) {
  if (!typeIds.length) return new Map<string, { takenAt: Date; outOfRange: boolean }>();
  const rows = await prisma.$queryRaw<{ readingTypeId: string; takenAt: Date; outOfRange: boolean }[]>`
    SELECT DISTINCT ON (r."readingTypeId") r."readingTypeId", r."takenAt", r."outOfRange"
    FROM readings r
    WHERE r."readingTypeId" = ANY(${typeIds}) AND NOT EXISTS (SELECT 1 FROM readings c WHERE c."correctsId" = r.id)
    ORDER BY r."readingTypeId", r."takenAt" DESC`;
  return new Map(rows.map((r) => [r.readingTypeId, r]));
}

// The run-hours meter now (latest reading that counts) and at its first reading, for many machines in two queries.
async function runHoursOf(assetIds: string[]) {
  const pick = (order: Prisma.Sql) => prisma.$queryRaw<{ assetId: string; value: number }[]>`
    SELECT DISTINCT ON (r."assetId") r."assetId", r.value
    FROM readings r JOIN reading_types t ON t.id = r."readingTypeId"
    WHERE r."assetId" = ANY(${assetIds}) AND t."runHours" AND NOT EXISTS (SELECT 1 FROM readings c WHERE c."correctsId" = r.id)
    ORDER BY r."assetId", r."takenAt" ${order}`;
  if (!assetIds.length) return { now: new Map<string, number>(), first: new Map<string, number>() };
  const [latest, earliest] = await Promise.all([pick(Prisma.sql`DESC`), pick(Prisma.sql`ASC`)]);
  return { now: new Map(latest.map((r) => [r.assetId, r.value])), first: new Map(earliest.map((r) => [r.assetId, r.value])) };
}

// Machines whose PMS by hours is due within `within` hours (or past it), for My work, the logbook and the dashboard.
// Same rule as runHoursInfo, for all of them at once.
export async function hoursDue(where: Prisma.AssetWhereInput, within = 25): Promise<HoursDueRow[]> {
  const assets = await prisma.asset.findMany({ where: { ...where, status: 'active', pmsEveryHours: { not: null } }, select: { id: true, assetCode: true, name: true, pmsEveryHours: true, lastPmsHours: true } });
  const meters = await runHoursOf(assets.map((a) => a.id));
  const rows = assets.map((a) => {
    const hoursNow = meters.now.get(a.id) ?? null;
    const from = a.lastPmsHours ?? meters.first.get(a.id) ?? null;
    const pmsDueAtHours = a.pmsEveryHours != null && from != null ? from + a.pmsEveryHours : null;
    return { a, info: { hoursNow, pmsDueAtHours, hoursLeft: pmsDueAtHours != null && hoursNow != null ? Math.round((pmsDueAtHours - hoursNow) * 10) / 10 : null } };
  });
  return rows
    .filter(({ info }) => info.hoursLeft != null && info.hoursLeft <= within)
    .map(({ a, info }) => ({ assetId: a.id, assetCode: a.assetCode, assetName: a.name, hoursNow: info.hoursNow!, pmsDueAtHours: info.pmsDueAtHours!, hoursLeft: info.hoursLeft! }))
    .sort((x, y) => x.hoursLeft - y.hoursLeft);
}

// A PMS (not a correction) restarts the hours count from the meter on the day it was done.
export async function stampPmsHours(db: Db, assetId: string, at?: Date) {
  const hours = await hoursAt(db, assetId, at);
  if (hours != null) await db.asset.update({ where: { id: assetId }, data: { lastPmsHours: hours } });
}
