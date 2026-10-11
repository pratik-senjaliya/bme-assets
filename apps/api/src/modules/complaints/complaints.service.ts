import type { Prisma } from '@prisma/client';
import type { ComplaintDetail, ComplaintEvent, ComplaintRow, Criticality } from '@bme/shared';
import { prisma } from '../../lib/prisma';
import { toAttachmentRow } from '../assets/attachments.service';

type Db = Prisma.TransactionClient;

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
  const [users, { criticalDowntimeHours }, files] = await Promise.all([
    ids.length ? prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [],
    prisma.hospitalSettings.findFirstOrThrow({ select: { criticalDowntimeHours: true } }),
    prisma.attachment.groupBy({ by: ['ownerId'], where: { ownerType: 'complaint', ownerId: { in: rows.map((c) => c.id) } }, _count: true }),
  ]);
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? null) : null);
  const now = Date.now();
  return rows.map((c) => {
    const metrics = complaintMetrics(c);
    // Still-open complaints count their running downtime, so a breakdown is flagged while it is happening.
    const downSeconds = metrics.downtimeSeconds ?? Math.round((now - c.raisedAt.getTime()) / 1000);
    return {
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
      ...metrics,
      overDowntimeLimit: c.asset.criticality === 'critical' && downSeconds > criticalDowntimeHours * 3600,
      attachmentCount: files.find((f) => f.ownerId === c.id)?._count ?? 0,
    };
  });
}

// The whole story of one complaint, oldest first: who raised it, who started and resolved it, every document and
// (for people allowed to see costs) every expense booked against it.
export async function toComplaintDetail(c: ComplaintWithRefs, canSeeCosts: boolean): Promise<ComplaintDetail> {
  const [row] = await toComplaintRows([c]);
  const [files, expenses] = await Promise.all([
    prisma.attachment.findMany({ where: { ownerType: 'complaint', ownerId: c.id }, orderBy: { createdAt: 'asc' } }),
    canSeeCosts ? prisma.serviceExpense.findMany({ where: { complaintId: c.id }, orderBy: { date: 'asc' } }) : [],
  ]);
  const events: ComplaintEvent[] = [
    { at: row.raisedAt, kind: 'raised', title: 'Complaint raised', detail: row.description, by: row.raisedByName },
    ...(row.startedAt ? [{ at: row.startedAt, kind: 'started', title: 'Work started', detail: `Response time ${durationText(row.responseSeconds)}`, by: row.startedByName } satisfies ComplaintEvent] : []),
    ...files.map((f): ComplaintEvent => ({ at: f.createdAt.toISOString(), kind: 'document', title: `Document added: ${f.fileName || f.kind}` })),
    ...expenses.map((e): ComplaintEvent => ({ at: e.createdAt.toISOString(), kind: 'expense', title: `Expense booked: ${e.description}`, detail: `₹ ${new Intl.NumberFormat('en-IN').format(Number(e.amount))}` })),
    ...(row.resolvedAt ? [{ at: row.resolvedAt, kind: 'resolved', title: 'Resolved', detail: `${row.resolutionNotes ?? ''}${row.resolutionNotes ? ' · ' : ''}Downtime ${durationText(row.downtimeSeconds)}`, by: row.resolvedByName } satisfies ComplaintEvent] : []),
  ];
  events.sort((a, b) => a.at.localeCompare(b.at));
  return {
    ...row,
    events,
    attachments: files.map(toAttachmentRow),
    expenses: expenses.map((e) => ({ id: e.id, type: e.type, description: e.description, amount: Number(e.amount), date: e.date.toISOString().slice(0, 10) })),
  };
}

// 2 h 15 m, 25 m, < 1 m (same wording as the screens).
function durationText(seconds: number | null) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  if (m < 1) return '< 1 m';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  return h ? (m % 60 ? `${h} h ${m % 60} m` : `${h} h`) : `${m} m`;
}

// Equipment moved to another department: its open complaints go with it, so the nurses who now have it see them.
// Resolved ones stay with the department that raised them (history).
export async function moveOpenComplaints(db: Db, assetId: string, departmentId: string) {
  await db.complaint.updateMany({ where: { assetId, status: { in: ['open', 'in_progress'] } }, data: { departmentId } });
}

// Condemned equipment will not be repaired: its open complaints are closed with a note. No start time is invented,
// so response-time figures are not distorted; downtime runs until condemnation.
export async function closeComplaintsOnCondemnation(db: Db, assetId: string, decidedBy: string) {
  await db.complaint.updateMany({
    where: { assetId, status: { in: ['open', 'in_progress'] } },
    data: { status: 'resolved', resolvedAt: new Date(), resolvedBy: decidedBy, resolutionNotes: 'Closed: the equipment was condemned.' },
  });
}

// How long one machine was down between `from` and `to`. Complaints about the same machine that overlap (two
// shifts reporting the same fault) count once, so its downtime can never exceed the time that passed.
// An unresolved complaint counts until `to`.
export function machineDownMs(complaints: { raisedAt: Date; resolvedAt: Date | null }[], from: Date, to: Date) {
  const spans = complaints
    .map((c) => [Math.max(c.raisedAt.getTime(), from.getTime()), Math.min((c.resolvedAt ?? to).getTime(), to.getTime())])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of spans) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}
