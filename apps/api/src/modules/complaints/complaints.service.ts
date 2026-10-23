import type { Prisma } from '@prisma/client';
import { isCritical, UNRESOLVED_STATUSES, type ComplaintDetail, type ComplaintEvent, type ComplaintRow, type Criticality, type Register } from '@bme/shared';
import { auditSystem } from '../../lib/audit';
import { addDaysISO, todayISO, zonedDayStart } from '../../lib/dates';
import { sendMail, smtpConfigured } from '../../lib/mail';
import { registerTeam, usersWithPermissions } from '../../lib/people';
import { prisma } from '../../lib/prisma';
import { toAttachmentRow } from '../assets/attachments.service';

type Db = Prisma.TransactionClient;

export const complaintInclude = { asset: true, department: true, raisedBy: true, assignedTo: { select: { name: true } } } satisfies Prisma.ComplaintInclude;
export type ComplaintWithRefs = Prisma.ComplaintGetPayload<{ include: typeof complaintInclude }>;

export const secondsBetween = (from: Date, to: Date | null) => (to ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000)) : null);

// Response time = started − raised. Downtime = resolved − raised. Both come only from the
// server-stamped timestamps, and stay null until that step has happened.
export const complaintMetrics = (c: { raisedAt: Date; startedAt: Date | null; resolvedAt: Date | null }) => ({
  responseSeconds: secondsBetween(c.raisedAt, c.startedAt),
  downtimeSeconds: secondsBetween(c.raisedAt, c.resolvedAt),
});

export const complaintNo = (seq: number) => `CMP-${String(seq).padStart(4, '0')}`;

// started_by / resolved_by / assigned_by / closed_by are plain ids, so look the names up in one query for the whole page.
export async function toComplaintRows(rows: ComplaintWithRefs[]): Promise<ComplaintRow[]> {
  const ids = [...new Set(rows.flatMap((c) => [c.startedBy, c.resolvedBy, c.assignedBy, c.closedBy]).filter((id): id is string => !!id))];
  const escalated = rows.filter((c) => c.escalatedAt).map((c) => c.id);
  const [users, { criticalDowntimeHours }, files, escalations] = await Promise.all([
    ids.length ? prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [],
    prisma.hospitalSettings.findFirstOrThrow({ select: { criticalDowntimeHours: true } }),
    prisma.attachment.groupBy({ by: ['ownerId'], where: { ownerType: 'complaint', ownerId: { in: rows.map((c) => c.id) } }, _count: true }),
    // The reason given with a pending escalation (the latest one).
    escalated.length ? prisma.complaintStep.findMany({ where: { complaintId: { in: escalated }, kind: 'escalated' }, orderBy: { at: 'asc' } }) : [],
  ]);
  const escalationNote = new Map(escalations.map((e) => [e.complaintId, e.note]));
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
      register: c.register,
      raisedById: c.raisedById,
      raisedByName: c.raisedBy.name,
      description: c.description,
      urgent: c.urgent,
      status: c.status,
      escalatedAt: c.escalatedAt?.toISOString() ?? null,
      escalationNote: c.escalatedAt ? (escalationNote.get(c.id) ?? null) : null,
      holdNote: c.holdNote,
      closedAt: c.closedAt?.toISOString() ?? null,
      closedByName: name(c.closedBy),
      closeNote: c.closeNote,
      raisedAt: c.raisedAt.toISOString(),
      startedAt: c.startedAt?.toISOString() ?? null,
      startedByName: name(c.startedBy),
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
      resolvedByName: name(c.resolvedBy),
      resolutionNotes: c.resolutionNotes,
      assignedToId: c.assignedToId,
      assignedToName: c.assignedTo?.name ?? null,
      assignedAt: c.assignedAt?.toISOString() ?? null,
      ...metrics,
      overDowntimeLimit: isCritical(c.asset.criticality) && downSeconds > criticalDowntimeHours * 3600,
      attachmentCount: files.find((f) => f.ownerId === c.id)?._count ?? 0,
    };
  });
}

// The whole story of one complaint, oldest first: who raised it, who started and resolved it, every document and
// (for people allowed to see costs) every expense booked against it.
export async function toComplaintDetail(c: ComplaintWithRefs, canSeeCosts: boolean): Promise<ComplaintDetail> {
  const [row] = await toComplaintRows([c]);
  const [files, expenses, assigner, steps] = await Promise.all([
    prisma.attachment.findMany({ where: { ownerType: 'complaint', ownerId: c.id }, orderBy: { createdAt: 'asc' } }),
    canSeeCosts ? prisma.serviceExpense.findMany({ where: { complaintId: c.id }, orderBy: { date: 'asc' } }) : [],
    c.assignedBy ? prisma.user.findUnique({ where: { id: c.assignedBy }, select: { name: true } }) : null,
    prisma.complaintStep.findMany({ where: { complaintId: c.id }, orderBy: { at: 'asc' } }),
  ]);
  const stepPeople = await prisma.user.findMany({ where: { id: { in: steps.map((s) => s.by).filter((id): id is string => !!id) } }, select: { id: true, name: true } });
  // `resolved` steps are earlier resolutions of a complaint that was then reopened (the current one is on the complaint).
  const STEP_TITLE: Record<string, string> = { escalated: 'Escalated to the HOD', held: 'Put on hold', resumed: 'Back to work', resolved: 'Resolved', reopened: 'Not fixed: sent back', closed: 'Closed' };
  // Only the current assignment is shown; earlier ones are in the audit log. Taking a complaint, or starting it,
  // reads as the engineer's own doing.
  const selfTaken = c.assignedBy === c.assignedToId;
  // Starting an unassigned complaint makes it the starter's; "Work started" already says so.
  const byStarting = selfTaken && c.startedBy === c.assignedToId && c.startedAt?.getTime() === c.assignedAt?.getTime();
  const events: ComplaintEvent[] = [
    { at: row.raisedAt, kind: 'raised', title: 'Complaint raised', detail: row.description, by: row.raisedByName },
    ...(row.assignedAt && row.assignedToName && !byStarting
      ? [{ at: row.assignedAt, kind: 'assigned', title: selfTaken ? `Taken by ${row.assignedToName}` : `Assigned to ${row.assignedToName}`, by: selfTaken ? null : (assigner?.name ?? null) } satisfies ComplaintEvent]
      : []),
    ...(row.startedAt ? [{ at: row.startedAt, kind: 'started', title: 'Work started', detail: `${steps.find((s) => s.kind === 'started')?.note ? `${steps.find((s) => s.kind === 'started')!.note} · ` : ''}${row.startedByName ?? 'An engineer'} is attending · response time ${durationText(row.responseSeconds)}`, by: row.startedByName } satisfies ComplaintEvent] : []),
    // The note given when starting work belongs to "Work started" above.
    ...steps.filter((s) => s.kind !== 'started').map((s): ComplaintEvent => ({
      at: s.at.toISOString(),
      kind: s.kind as ComplaintEvent['kind'],
      title: s.kind === 'closed' && !s.by ? 'Closed automatically' : (STEP_TITLE[s.kind] ?? s.kind),
      detail: s.note,
      by: stepPeople.find((u) => u.id === s.by)?.name ?? null,
    })),
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

// Equipment moved to another department: its unresolved complaints go with it, so the nurses who now have it see
// them. Resolved ones stay with the department that raised them (history).
export async function moveOpenComplaints(db: Db, assetId: string, departmentId: string) {
  await db.complaint.updateMany({ where: { assetId, status: { in: UNRESOLVED_STATUSES } }, data: { departmentId } });
}

// Condemned equipment will not be repaired: its complaints are closed with a note, without waiting for whoever raised
// them. No start time is invented, so response-time figures are not distorted; downtime runs until condemnation.
// `at` is the HOD's decision, so the closing reads at the same moment as the condemnation or transfer itself.
export async function closeComplaintsOnCondemnation(db: Db, assetId: string, decidedBy: string, note = 'Closed: the equipment was condemned.', at = new Date()) {
  const now = at;
  const affected = await db.complaint.findMany({ where: { assetId, status: { in: [...UNRESOLVED_STATUSES, 'resolved'] } }, select: { id: true } });
  await db.complaint.updateMany({
    where: { assetId, status: { in: UNRESOLVED_STATUSES } },
    data: { status: 'closed', resolvedAt: now, resolvedBy: decidedBy, resolutionNotes: note, escalatedAt: null, holdNote: null, closedAt: now, closeNote: note },
  });
  await db.complaint.updateMany({ where: { assetId, status: 'resolved' }, data: { status: 'closed', closedAt: now, closeNote: note } });
  await db.complaintStep.createMany({ data: affected.map((c) => ({ complaintId: c.id, kind: 'closed', note, at: now, by: null })) });
}

// Resolved complaints waiting for whoever raised them to close. Every day: those older than the hospital's limit
// close by themselves (decision B), and each raiser with the bell gets one notice listing the rest. Closing never
// changes downtime, which ended when the engineer resolved it.
export const CLOSE_REMINDER = -1; // thresholdDays marking the daily "please close" notice
export async function followUpResolvedComplaints(today = todayISO()) {
  const { complaintCloseDays } = await prisma.hospitalSettings.findFirstOrThrow({ select: { complaintCloseDays: true } });
  const cutoff = zonedDayStart(addDaysISO(today, 1 - complaintCloseDays)); // resolved before this day: time is up
  const due = await prisma.complaint.findMany({ where: { status: 'resolved', resolvedAt: { lt: cutoff } }, select: { id: true } });
  let closed = 0;
  for (const { id } of due) {
    const now = new Date();
    const note = `Closed automatically: not closed within ${complaintCloseDays} ${complaintCloseDays === 1 ? 'day' : 'days'} of being resolved.`;
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.complaint.updateMany({ where: { id, status: 'resolved' }, data: { status: 'closed', closedAt: now, closeNote: note } });
      if (!count) return; // closed by its raiser meanwhile
      await tx.complaintStep.create({ data: { complaintId: id, kind: 'closed', note, at: now, by: null } });
      await auditSystem(tx, [{ action: 'complaint.autoclose', entityType: 'complaint', entityId: id, after: { status: 'closed', closedAt: now, closeNote: note } }]);
      closed++;
    });
  }

  const waiting = await prisma.complaint.findMany({ where: { status: 'resolved' }, select: { complaintNo: true, raisedById: true }, orderBy: { complaintNo: 'asc' } });
  const withBell = new Set(await usersWithPermissions('notification.view'));
  const day = new Date(`${today}T00:00:00Z`);
  let reminded = 0;
  const byRaiser = new Map<string, string[]>();
  for (const c of waiting) if (withBell.has(c.raisedById)) byRaiser.set(c.raisedById, [...(byRaiser.get(c.raisedById) ?? []), c.complaintNo]);
  for (const [userId, nos] of byRaiser) {
    if (await prisma.notification.findFirst({ where: { userId, type: 'complaint', dueDate: day, thresholdDays: CLOSE_REMINDER }, select: { id: true } })) continue;
    const list = nos.join(', ');
    await prisma.notification.create({
      data: { userId, type: 'complaint', dueDate: day, thresholdDays: CLOSE_REMINDER, message: `Fixed and waiting for you to close: ${list}. Check the equipment works, then close ${nos.length === 1 ? 'it' : 'them'} under Complaints.` },
    });
    reminded++;
  }
  return { closed, reminded };
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

// Gap review #4: an urgent complaint (the machine cannot be used, or patient care is affected) is emailed at once to
// everyone of its team who works on complaints, when the hospital has email; the bell alone waits until someone opens the app.
// Sent after the complaint is saved: a mail failure is logged and never stops the complaint.
export async function emailUrgent(c: { complaintNo: string; description: string }, asset: { register: Register; assetCode: string; name: string; department: { name: string }; location: { name: string } }, raisedBy: string) {
  try {
    const settings = await prisma.hospitalSettings.findFirstOrThrow();
    if (!smtpConfigured(settings)) return;
    const people = await prisma.user.findMany({ where: { id: { in: await registerTeam(asset.register, 'complaint.start') } }, select: { email: true } });
    const subject = `URGENT complaint ${c.complaintNo}: ${asset.assetCode} ${asset.name} cannot be used`;
    const text = `${raisedBy} reports that ${asset.name} (${asset.assetCode}) in ${asset.department.name}, ${asset.location.name} cannot be used or patient care is affected.\n\nProblem: ${c.description}\n\nSign in to the BME Asset Management system to take it.`;
    await Promise.all(people.map((p) => sendMail(settings, p.email, subject, text)));
  } catch (e) {
    console.error(`Could not email urgent complaint ${c.complaintNo}:`, e instanceof Error ? e.message : e);
  }
}
