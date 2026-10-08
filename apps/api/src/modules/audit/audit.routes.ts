import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { auditQuerySchema, type AuditRow, type Paged } from '@bme/shared';
import { requirePermission } from '../../lib/auth';
import { addDaysISO, zonedDayStart } from '../../lib/dates';
import { prisma } from '../../lib/prisma';

export const auditRouter = Router();

// Read-only: the table is append-only and nothing here (or anywhere) updates or deletes it.
auditRouter.get('/audit-logs', requirePermission('audit.view'), async (req, res) => {
  const q = auditQuerySchema.parse(req.query);
  const where: Prisma.AuditLogWhereInput = {
    ...(q.entityType && { entityType: q.entityType }),
    ...(q.entityId && { entityId: q.entityId }),
    ...(q.action && { action: { contains: q.action, mode: 'insensitive' } }),
    ...(q.actorId && { actorId: q.actorId }),
    // Whole hospital days: from 00:00 on `from` up to (not including) 00:00 the day after `to`.
    ...((q.from || q.to) && { at: { ...(q.from && { gte: zonedDayStart(q.from) }), ...(q.to && { lt: zonedDayStart(addDaysISO(q.to, 1)) }) } }),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
  ]);
  const actors = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const body: Paged<AuditRow> = {
    items: rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actorName: r.actorId ? (actors.find((a) => a.id === r.actorId)?.name ?? 'Unknown') : null,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
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
