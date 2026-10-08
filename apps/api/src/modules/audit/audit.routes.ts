import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { auditQuerySchema, type AuditRow, type Paged } from '@bme/shared';
import { requirePermission } from '../../lib/auth';
import { addDaysISO, zonedDayStart } from '../../lib/dates';
import { prisma } from '../../lib/prisma';

export const auditRouter = Router();

// Actions that happen all day and say nothing about changes to the data.
const ROUTINE = ['auth.login', 'auth.logout', 'report.export'];

// Records that belong to an asset: the log shows the asset's code, which is how people know the record.
const OF_ASSET = ['pms_record', 'calibration_record', 'service_expense', 'service_log', 'purchase_order', 'service_contract'] as const;

// What each entry is about, in the words people use: SHL-ICU-VENT-ICU1-001, CMP-0042, a name. Deleted records
// are named from the copy kept in the log itself.
async function labels(rows: { entityType: string; entityId: string | null; before: unknown; after: unknown }[]) {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.entityType === type && r.entityId).map((r) => r.entityId!))];
  const [assets, complaints, users, departments, locations, types, ...ofAsset] = await Promise.all([
    prisma.asset.findMany({ where: { id: { in: ids('asset') } }, select: { id: true, assetCode: true, name: true } }),
    prisma.complaint.findMany({ where: { id: { in: ids('complaint') } }, select: { id: true, complaintNo: true } }),
    prisma.user.findMany({ where: { id: { in: ids('user') } }, select: { id: true, name: true } }),
    prisma.department.findMany({ where: { id: { in: ids('department') } }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { id: { in: ids('location') } }, select: { id: true, name: true } }),
    prisma.equipmentType.findMany({ where: { id: { in: ids('equipment_type') } }, select: { id: true, name: true } }),
    ...OF_ASSET.map((t) => (prisma[{ pms_record: 'pmsRecord', calibration_record: 'calibrationRecord', service_expense: 'serviceExpense', service_log: 'serviceLog', purchase_order: 'purchaseOrder', service_contract: 'serviceContract' }[t] as 'pmsRecord'] as typeof prisma.pmsRecord).findMany({ where: { id: { in: ids(t) } }, select: { id: true, asset: { select: { assetCode: true } } } })),
  ]);
  const map = new Map<string, string>();
  assets.forEach((a) => map.set(`asset:${a.id}`, `${a.assetCode} · ${a.name}`));
  complaints.forEach((c) => map.set(`complaint:${c.id}`, c.complaintNo));
  users.forEach((u) => map.set(`user:${u.id}`, u.name));
  departments.forEach((d) => map.set(`department:${d.id}`, d.name));
  locations.forEach((l) => map.set(`location:${l.id}`, l.name));
  types.forEach((t) => map.set(`equipment_type:${t.id}`, t.name));
  OF_ASSET.forEach((t, i) => (ofAsset[i] as { id: string; asset: { assetCode: string } }[]).forEach((r) => map.set(`${t}:${r.id}`, r.asset.assetCode)));
  return (r: { entityType: string; entityId: string | null; before: unknown; after: unknown }) => {
    if (r.entityId && map.has(`${r.entityType}:${r.entityId}`)) return map.get(`${r.entityType}:${r.entityId}`)!;
    const copy = ((r.after ?? r.before) ?? {}) as Record<string, unknown>;
    const own = copy.assetCode ?? copy.complaintNo ?? copy.name ?? copy.email;
    return typeof own === 'string' ? own : null;
  };
}

// Read-only: the table is append-only and nothing here (or anywhere) updates or deletes it.
auditRouter.get('/audit-logs', requirePermission('audit.view'), async (req, res) => {
  const q = auditQuerySchema.parse(req.query);
  const where: Prisma.AuditLogWhereInput = {
    ...(q.entityType && { entityType: q.entityType }),
    ...(q.entityId && { entityId: q.entityId }),
    AND: [
      ...(q.action ? [{ action: { contains: q.action, mode: 'insensitive' as const } }] : []),
      ...(q.hideRoutine === 'true' ? [{ action: { notIn: ROUTINE } }] : []),
    ],
    ...(q.actorId && { actorId: q.actorId }),
    // Whole hospital days: from 00:00 on `from` up to (not including) 00:00 the day after `to`.
    ...((q.from || q.to) && { at: { ...(q.from && { gte: zonedDayStart(q.from) }), ...(q.to && { lt: zonedDayStart(addDaysISO(q.to, 1)) }) } }),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
  ]);
  const actors = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const labelOf = await labels(rows);
  const body: Paged<AuditRow> = {
    items: rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actorName: r.actorId ? (actors.find((a) => a.id === r.actorId)?.name ?? 'Unknown') : null,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      entityLabel: labelOf(r),
      before: r.before,
      after: r.after,
      ip: r.ip,
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
  res.json(body);
});

// People who appear in the log, for the "who" filter.
auditRouter.get('/audit-logs/actors', requirePermission('audit.view'), async (_req, res) => {
  res.json(await prisma.user.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }));
});
