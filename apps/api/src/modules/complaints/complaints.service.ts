import type { Prisma } from '@prisma/client';
import type { ComplaintRow, Criticality } from '@bme/shared';
import { prisma } from '../../lib/prisma';

export const complaintInclude = { asset: true, department: true, raisedBy: true } satisfies Prisma.ComplaintInclude;
export type ComplaintWithRefs = Prisma.ComplaintGetPayload<{ include: typeof complaintInclude }>;

export const secondsBetween = (from: Date, to: Date | null) => (to ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000)) : null);

// Response time = started − raised. Downtime = resolved − raised. Both come only from the
// server-stamped timestamps, and stay null until that step has happened.
export const complaintMetrics = (c: { raisedAt: Date; startedAt: Date | null; resolvedAt: Date | null }) => ({
  responseSeconds: secondsBetween(c.raisedAt, c.startedAt),
  downtimeSeconds: secondsBetween(c.raisedAt, c.resolvedAt),
});

export const complaintNo = (seq: number) => `CMP-${String(seq).padStart(4, '0')}`;

// started_by / resolved_by are plain ids, so look the names up in one query for the whole page.
export async function toComplaintRows(rows: ComplaintWithRefs[]): Promise<ComplaintRow[]> {
  const ids = [...new Set(rows.flatMap((c) => [c.startedBy, c.resolvedBy]).filter((id): id is string => !!id))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? null) : null);
  return rows.map((c) => ({
    id: c.id,
    complaintNo: c.complaintNo,
    assetId: c.assetId,
    assetCode: c.asset.assetCode,
    assetName: c.asset.name,
    criticality: c.asset.criticality as Criticality,
    departmentId: c.departmentId,
    departmentName: c.department.name,
    raisedByName: c.raisedBy.name,
    description: c.description,
    status: c.status,
    raisedAt: c.raisedAt.toISOString(),
    startedAt: c.startedAt?.toISOString() ?? null,
    startedByName: name(c.startedBy),
    resolvedAt: c.resolvedAt?.toISOString() ?? null,
    resolvedByName: name(c.resolvedBy),
    resolutionNotes: c.resolutionNotes,
    ...complaintMetrics(c),
  }));
}
