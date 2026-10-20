import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  assignComplaintSchema,
  complaintListQuerySchema,
  complaintNoteSchema,
  createComplaintSchema,
  optionalNoteSchema,
  resolveComplaintSchema,
  UNRESOLVED_STATUSES,
  type AssignComplaintInput,
  type ComplaintNoteInput,
  type ComplaintStatus,
  type Assignee,
  type ComplaintRow,
  type CreateComplaintInput,
  type OptionalNoteInput,
  type Paged,
  type ResolveComplaintInput,
} from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, departmentScope, requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { addDaysISO, zonedDayStart } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';
import { usersWithPermissions } from '../../lib/people';
import { notify } from '../approvals/approvals.service';
import { findScopedAsset } from '../assets/assets.service';
import { complaintInclude, complaintNo, toComplaintDetail, toComplaintRows } from './complaints.service';

export const complaintsRouter = Router();

// Nursing only sees its own department's complaints; a foreign id looks like a missing one.
async function findScoped(req: Request) {
  const complaint = await prisma.complaint.findFirst({
    where: { id: idOf(req), ...departmentScope(currentUser(req)) },
    include: complaintInclude,
  });
  if (!complaint) throw new HttpError(404, 'Complaint not found');
  return complaint;
}

const one = async (id: string): Promise<ComplaintRow> =>
  (await toComplaintRows([await prisma.complaint.findUniqueOrThrow({ where: { id }, include: complaintInclude })]))[0];

complaintsRouter.get('/', requirePermission('complaint.view'), async (req, res) => {
  const q = complaintListQuerySchema.parse(req.query);
  const me = currentUser(req);
  const where: Prisma.ComplaintWhereInput = {
    ...(q.status && { status: q.status === 'unresolved' ? { in: UNRESOLVED_STATUSES } : q.status === 'done' ? { in: ['resolved', 'closed'] } : q.status }),
    ...(q.raisedBy === 'me' && { raisedById: me.id }),
    ...(q.escalated && { status: 'in_progress' as const, escalatedAt: { not: null } }),
    ...(q.assignedTo && { assignedToId: q.assignedTo === 'me' ? me.id : q.assignedTo === 'none' ? null : q.assignedTo }),
    ...(q.assetId && { assetId: q.assetId }),
    ...(q.departmentId && { departmentId: q.departmentId }),
    // Dates are the hospital's calendar days, not UTC days.
    ...((q.from || q.to) && { raisedAt: { ...(q.from && { gte: zonedDayStart(q.from) }), ...(q.to && { lt: zonedDayStart(addDaysISO(q.to, 1)) }) } }),
    ...(q.search && {
      OR: [
        { complaintNo: { contains: q.search, mode: 'insensitive' as const } },
        { description: { contains: q.search, mode: 'insensitive' as const } },
        { asset: { assetCode: { contains: q.search, mode: 'insensitive' as const } } },
        { asset: { name: { contains: q.search, mode: 'insensitive' as const } } },
      ],
    }),
    ...departmentScope(me), // last, so it cannot be widened from the query
  };
  // Waiting complaints: longest-waiting first. Resolved: most recent first. Mixed: newest first.
  const orderBy: Prisma.ComplaintOrderByWithRelationInput | Prisma.ComplaintOrderByWithRelationInput[] = q.sortBy
    ? [{ [q.sortBy]: q.order }, { complaintNo: 'desc' }]
    : q.status && (UNRESOLVED_STATUSES as string[]).concat('unresolved').includes(q.status) ? { raisedAt: 'asc' } : q.status && ['resolved', 'closed', 'done'].includes(q.status) ? { resolvedAt: 'desc' } : { raisedAt: 'desc' };
  const [total, rows] = await prisma.$transaction([
    prisma.complaint.count({ where }),
    prisma.complaint.findMany({ where, include: complaintInclude, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
  ]);
  const body: Paged<ComplaintRow> = { items: await toComplaintRows(rows), total, page: q.page, pageSize: q.pageSize };
  res.json(body);
});

// The people a complaint can go to: active users who can start work on complaints, with their current load.
complaintsRouter.get('/assignees', requirePermission('complaint.assign'), async (_req, res) => {
  const ids = await usersWithPermissions('complaint.start');
  const [users, load] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.complaint.groupBy({ by: ['assignedToId'], where: { status: { in: UNRESOLVED_STATUSES }, assignedToId: { in: ids } }, _count: true }),
  ]);
  const body: Assignee[] = users.map((u) => ({ ...u, openCount: load.find((l) => l.assignedToId === u.id)?._count ?? 0 }));
  res.json(body);
});

complaintsRouter.get('/:id', requirePermission('complaint.view'), async (req, res) => {
  res.json(await toComplaintDetail(await findScoped(req), currentUser(req).permissions.includes('expense.manage')));
});

// The department comes from the asset and the time from the server, never from the request.
complaintsRouter.post('/', requirePermission('complaint.create'), validate(createComplaintSchema), async (req, res) => {
  const me = currentUser(req);
  const input = req.body as CreateComplaintInput;
  const asset = await findScopedAsset(req, input.assetId);
  if (asset.status === 'condemned') throw new HttpError(409, 'This equipment has been condemned, so complaints can no longer be raised for it');
  // The people who can start work on it hear about it at once, not only when the board happens to be open.
  const staff = (await usersWithPermissions('complaint.start', 'notification.view')).filter((id) => id !== me.id);

  const created = await prisma.$transaction(async (tx) => {
    // Atomic counter on the settings row: concurrent complaints get distinct numbers.
    const { id } = await tx.hospitalSettings.findFirstOrThrow({ select: { id: true } });
    const { complaintSeq } = await tx.hospitalSettings.update({ where: { id }, data: { complaintSeq: { increment: 1 } } });
    const row = await tx.complaint.create({
      data: {
        complaintNo: complaintNo(complaintSeq),
        assetId: asset.id,
        raisedById: me.id,
        departmentId: asset.departmentId,
        description: input.description,
        createdBy: me.id,
      },
    });
    await audit(tx, req, { action: 'complaint.create', entityType: 'complaint', entityId: row.id, after: row });
    await notify(tx, staff, `New complaint ${row.complaintNo}: ${asset.assetCode} ${asset.name}: "${input.description.slice(0, 80)}" (raised by ${me.name})`, asset.id, 'complaint');
    return row;
  });
  res.status(201).json(await one(created.id));
});

// One step at a time (business rule 6): Open → In progress (⇄ On hold) → Resolved → Closed. The status check sits
// inside the UPDATE, so two people pressing the button at once cannot both succeed. `step` records the steps that
// carry a note (escalated, held, resumed, closed) for the complaint's history.
type Changes = Prisma.ComplaintUncheckedUpdateManyInput;
type Before = Awaited<ReturnType<typeof findScoped>>;
async function transition(
  req: Request,
  from: ComplaintStatus[],
  changes: Changes | ((before: Before) => Changes),
  action: string,
  wrong: string,
  opts: { step?: { kind: string; note?: string | null }; check?: (before: Before) => void; also?: Prisma.ComplaintWhereInput } = {},
) {
  const before = await findScoped(req);
  if (!from.includes(before.status)) throw new HttpError(409, wrong);
  opts.check?.(before);
  const data = typeof changes === 'function' ? changes(before) : changes;
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.complaint.updateMany({ where: { id: before.id, status: { in: from }, ...opts.also }, data });
    if (count === 0) throw new HttpError(409, wrong);
    if (opts.step) await tx.complaintStep.create({ data: { complaintId: before.id, kind: opts.step.kind, note: opts.step.note ?? null, by: currentUser(req).id } });
    const after = await tx.complaint.findUniqueOrThrow({ where: { id: before.id } });
    await audit(tx, req, { action, entityType: 'complaint', entityId: before.id, before, after });
    return { before, after };
  });
}

// Tells people about a step, leaving out whoever took it.
async function tell(req: Request, userIds: (string | null)[], message: string, assetId: string) {
  const me = currentUser(req).id;
  const to = [...new Set(userIds.filter((id): id is string => !!id && id !== me))];
  const withBell = new Set(await usersWithPermissions('notification.view'));
  await notify(prisma, to.filter((id) => withBell.has(id)), message, assetId, 'complaint');
}

complaintsRouter.post('/:id/start', requirePermission('complaint.start'), async (req, res) => {
  const me = currentUser(req).id;
  const now = new Date();
  const { after } = await transition(
    req,
    ['open'],
    // Starting an unassigned complaint makes it yours; one assigned to someone else stays theirs.
    (before) => ({ status: 'in_progress', startedAt: now, startedBy: me, ...(!before.assignedToId && { assignedToId: me, assignedAt: now, assignedBy: me }) }),
    'complaint.start',
    'This complaint has already been started',
  );
  res.json(await one(after.id));
});

// The engineer cannot fix it alone (e.g. needs the OEM's engineer or a spare): it goes to the HOD, who decides
// whether to put it on hold. It stays in progress and with the same engineer meanwhile.
complaintsRouter.post('/:id/escalate', requirePermission('complaint.start'), validate(complaintNoteSchema), async (req, res) => {
  const { note } = req.body as ComplaintNoteInput;
  const me = currentUser(req);
  const { before, after } = await transition(req, ['in_progress'], { escalatedAt: new Date(), escalatedBy: me.id }, 'complaint.escalate', 'Only a complaint being worked on can be escalated (or it is on hold already)', {
    step: { kind: 'escalated', note },
    check: (b) => {
      if (b.escalatedAt) throw new HttpError(409, 'This complaint is already waiting for the HOD');
    },
    also: { escalatedAt: null },
  });
  await tell(req, await usersWithPermissions('complaint.hold'), `Complaint ${before.complaintNo} escalated by ${me.name}: ${before.asset.assetCode} ${before.asset.name}: "${note.slice(0, 80)}"`, before.assetId);
  res.json(await one(after.id));
});

// Only the HOD puts a complaint on hold (e.g. the OEM engineer comes in two days with the part). The downtime clock
// keeps running: the equipment is still down (decision C).
complaintsRouter.post('/:id/hold', requirePermission('complaint.hold'), validate(complaintNoteSchema), async (req, res) => {
  const { note } = req.body as ComplaintNoteInput;
  const { before, after } = await transition(req, ['in_progress'], { status: 'on_hold', holdNote: note, escalatedAt: null, escalatedBy: null }, 'complaint.hold', 'Only a complaint being worked on can be put on hold', {
    step: { kind: 'held', note },
  });
  await tell(req, [before.assignedToId], `Complaint ${before.complaintNo} put on hold by ${currentUser(req).name}: "${note.slice(0, 80)}"`, before.assetId);
  res.json(await one(after.id));
});

// The HOD takes it off hold, or answers an escalation by sending it back to the engineer.
complaintsRouter.post('/:id/resume', requirePermission('complaint.hold'), validate(optionalNoteSchema), async (req, res) => {
  const { note } = req.body as OptionalNoteInput;
  const { before, after } = await transition(req, ['on_hold', 'in_progress'], { status: 'in_progress', holdNote: null, escalatedAt: null, escalatedBy: null }, 'complaint.resume', 'This complaint is not on hold or waiting for the HOD', {
    step: { kind: 'resumed', note },
    check: (b) => {
      if (b.status === 'in_progress' && !b.escalatedAt) throw new HttpError(409, 'This complaint is not on hold or waiting for the HOD');
    },
  });
  await tell(req, [before.assignedToId], `Complaint ${before.complaintNo} is back with you${note ? `: "${note.slice(0, 80)}"` : ''}`, before.assetId);
  res.json(await one(after.id));
});

// Fixed: the downtime clock stops here. Also straight from on hold, once the OEM engineer has done the work.
complaintsRouter.post('/:id/resolve', requirePermission('complaint.resolve'), validate(resolveComplaintSchema), async (req, res) => {
  const { resolutionNotes } = req.body as ResolveComplaintInput;
  const { after } = await transition(
    req,
    ['in_progress', 'on_hold'],
    { status: 'resolved', resolvedAt: new Date(), resolvedBy: currentUser(req).id, resolutionNotes, holdNote: null, escalatedAt: null, escalatedBy: null },
    'complaint.resolve',
    'Start the complaint before resolving it (or it is already resolved)',
  );
  // Whoever raised it hears that it is fixed and that it is theirs to close.
  await tell(req, [after.raisedById], `Complaint ${after.complaintNo} resolved: check the equipment works, then close the complaint.`, after.assetId);
  res.json(await one(after.id));
});

// Whoever raised it confirms the equipment works and closes it, so a complaint is never marked fixed on the
// engineer's word alone. Downtime is not changed: it ended when the engineer resolved it.
complaintsRouter.post('/:id/close', requirePermission('complaint.view'), validate(optionalNoteSchema), async (req, res) => {
  const { note } = req.body as OptionalNoteInput;
  const me = currentUser(req);
  const { after } = await transition(req, ['resolved'], { status: 'closed', closedAt: new Date(), closedBy: me.id, closeNote: note ?? null }, 'complaint.close', 'Only a resolved complaint can be closed', {
    step: { kind: 'closed', note },
    check: (b) => {
      if (b.raisedById !== me.id) throw new HttpError(403, `Only ${b.raisedBy.name}, who raised it, can close this complaint`);
    },
  });
  res.json(await one(after.id));
});

// Assign, reassign or clear. The HOD (complaint.assign) may give a complaint to anyone who can work on complaints;
// an engineer may only take an unassigned one for themselves. A resolved complaint keeps its assignment.
complaintsRouter.post('/:id/assign', requirePermission('complaint.view'), validate(assignComplaintSchema), async (req, res) => {
  const me = currentUser(req);
  const { userId } = req.body as AssignComplaintInput;
  const before = await findScoped(req);
  if (before.resolvedAt) throw new HttpError(409, 'This complaint is already resolved');
  const isHod = me.permissions.includes('complaint.assign');
  if (!isHod) {
    if (!me.permissions.includes('complaint.start') || userId !== me.id) throw new HttpError(403, 'Only the HOD can assign complaints to others');
    if (before.assignedToId && before.assignedToId !== me.id) throw new HttpError(409, 'This complaint is already assigned to someone else');
  }
  if (userId && userId !== before.assignedToId) {
    const canWork = (await usersWithPermissions('complaint.start')).includes(userId);
    const active = await prisma.user.findFirst({ where: { id: userId, active: true }, select: { id: true } });
    if (!canWork || !active) throw new HttpError(400, 'This person cannot work on complaints', { fieldErrors: { userId: ['Choose someone who can work on complaints'] } });
  }
  if (userId === before.assignedToId) {
    res.json(await one(before.id)); // nothing changes
    return;
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Taking a complaint only succeeds while it is still free, so two engineers pressing "Take it" at once cannot both get it.
    const { count } = await tx.complaint.updateMany({
      where: { id: before.id, status: { in: UNRESOLVED_STATUSES }, ...(isHod ? {} : { assignedToId: null }) },
      data: { assignedToId: userId, assignedAt: userId ? now : null, assignedBy: userId ? me.id : null },
    });
    if (count === 0) throw new HttpError(409, 'This complaint changed meanwhile; refresh and try again');
    const after = await tx.complaint.findUniqueOrThrow({ where: { id: before.id } });
    await audit(tx, req, { action: 'complaint.assign', entityType: 'complaint', entityId: before.id, before, after });
    if (userId && userId !== me.id) {
      await notify(tx, [userId], `Complaint ${before.complaintNo} assigned to you: ${before.asset.assetCode} ${before.asset.name} (by ${me.name})`, before.assetId, 'complaint');
    }
  });
  res.json(await one(before.id));
});
