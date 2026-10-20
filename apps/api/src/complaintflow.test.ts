// Business rule 6 with the hospital's workflow (decisions B and C in docs/requirements-2026-10-20.md): an engineer
// escalates to the HOD, only the HOD puts a complaint on hold or back to work, the engineer resolves (also straight
// from on hold), and only whoever raised it closes it, or it closes by itself after the hospital's number of days.
// Downtime is resolved − raised whatever happened in between. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ComplaintDetail, ComplaintRow, Paged } from '@bme/shared';
import { ensureRolesAndPermissions } from './lib/baseData';
import { addDaysISO, todayISO, zonedDayStart } from './lib/dates';
import { prisma } from './lib/prisma';
import { followUpResolvedComplaints } from './modules/complaints/complaints.service';
import { call, login, startServer } from './testUtils';

const PREFIX = 'CFTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nurse = '';
let assetId = '';
const users = { admin: '', biomed: '', nurse: '' };

async function cleanUp() {
  const ids = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const complaints = (await prisma.complaint.findMany({ where: { assetId: { in: ids } }, select: { id: true } })).map((c) => c.id);
  await prisma.notification.deleteMany({ where: { OR: [{ assetId: { in: ids } }, { type: 'complaint', message: { contains: PREFIX } }, { type: 'complaint', thresholdDays: -1 }] } });
  await prisma.complaintStep.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.complaint.deleteMany({ where: { id: { in: complaints } } });
  await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  await prisma.hospitalSettings.updateMany({ data: { complaintCloseDays: 3 } });
}

before(async () => {
  await cleanUp();
  await ensureRolesAndPermissions(); // grants complaint.hold to the HOD, as the API does on start-up
  ({ server, base } = startServer());
  [admin, biomed, nurse] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  for (const [key, email] of [['admin', 'admin'], ['biomed', 'biomed'], ['nurse', 'nursing']] as const) {
    users[key] = (await prisma.user.findUniqueOrThrow({ where: { email: `${email}@demo.local` } })).id;
  }
  const [type, icu, icu1] = await Promise.all([
    prisma.equipmentType.findFirstOrThrow({ where: { code: 'VENT' } }),
    prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } }),
  ]);
  const res = await call(base, admin, 'POST', '/assets', { equipmentTypeId: type.id, name: `${PREFIX}vent`, departmentId: icu.id, locationId: icu1.id });
  assetId = ((await res.json()) as { id: string }).id;
});
after(async () => {
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

const raise = async (by = nurse) => {
  const res = await call(base, by, 'POST', '/complaints', { assetId, description: `${PREFIX}alarm keeps sounding` });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as ComplaintRow;
};
const step = (cookie: string, id: string, what: string, body?: unknown) => call(base, cookie, 'POST', `/complaints/${id}/${what}`, body);
const started = async (by = nurse) => {
  const c = await raise(by);
  assert.equal((await step(biomed, c.id, 'start')).status, 200);
  return c;
};
const detail = async (id: string, cookie = admin) => (await (await call(base, cookie, 'GET', `/complaints/${id}`)).json()) as ComplaintDetail;

describe('Escalating to the HOD', () => {
  it('the engineer escalates a complaint in progress with a reason; the HOD is told; it stays with the engineer', async () => {
    const c = await started();
    const res = await step(biomed, c.id, 'escalate', { note: 'Needs OEM support' });
    assert.equal(res.status, 200, await res.clone().text());
    const row = (await res.json()) as ComplaintRow;
    assert.equal(row.status, 'in_progress');
    assert.ok(row.escalatedAt);
    assert.equal(row.escalationNote, 'Needs OEM support');
    assert.equal(row.assignedToId, users.biomed);
    assert.ok(await prisma.notification.findFirst({ where: { userId: users.admin, message: { contains: `${c.complaintNo} escalated` } } }), 'the HOD was not told');
    assert.equal((await step(biomed, c.id, 'escalate', { note: 'Again' })).status, 409, 'escalated twice');
    const waiting = (await (await call(base, admin, 'GET', `/complaints?escalated=true&search=${PREFIX}&pageSize=100`)).json()) as Paged<ComplaintRow>;
    assert.ok(waiting.items.some((x) => x.id === c.id), 'not in the HOD’s escalated list');
  });

  it('needs a reason, and only a complaint being worked on can be escalated', async () => {
    const c = await raise();
    assert.equal((await step(biomed, c.id, 'escalate', { note: 'Needs OEM support' })).status, 409, 'escalated before work started');
    await step(biomed, c.id, 'start');
    assert.equal((await step(biomed, c.id, 'escalate', { note: '' })).status, 400);
    assert.equal((await step(nurse, c.id, 'escalate', { note: 'Needs OEM support' })).status, 403, 'nursing escalated');
  });
});

describe('On hold and back to work', () => {
  it('only the HOD puts a complaint on hold; it ends the escalation and tells the engineer', async () => {
    const c = await started();
    await step(biomed, c.id, 'escalate', { note: 'Needs OEM support' });
    assert.equal((await step(biomed, c.id, 'hold', { note: 'Waiting for the OEM' })).status, 403, 'an engineer put it on hold');
    const res = await step(admin, c.id, 'hold', { note: 'Company engineer will attend in two days with the part' });
    assert.equal(res.status, 200, await res.clone().text());
    const row = (await res.json()) as ComplaintRow;
    assert.equal(row.status, 'on_hold');
    assert.equal(row.escalatedAt, null);
    assert.equal(row.holdNote, 'Company engineer will attend in two days with the part');
    assert.ok(await prisma.notification.findFirst({ where: { userId: users.biomed, message: { contains: `${c.complaintNo} put on hold` } } }), 'the engineer was not told');
    assert.equal((await step(admin, c.id, 'hold', { note: 'Again' })).status, 409, 'held twice');
    // Still unresolved: it stays on the engineer's work list.
    const mine = (await (await call(base, biomed, 'GET', `/complaints?assignedTo=me&status=unresolved&search=${PREFIX}&pageSize=100`)).json()) as Paged<ComplaintRow>;
    assert.ok(mine.items.some((x) => x.id === c.id), 'an on-hold complaint left the engineer’s list');
  });

  it('cannot hold a complaint nobody has started; the HOD can send a held or escalated one back to work', async () => {
    const fresh = await raise();
    assert.equal((await step(admin, fresh.id, 'hold', { note: 'Waiting for the OEM' })).status, 409);
    const c = await started();
    assert.equal((await step(admin, c.id, 'resume')).status, 409, 'resumed a complaint that was neither held nor escalated');
    await step(admin, c.id, 'hold', { note: 'Waiting for the OEM' });
    const back = (await (await step(admin, c.id, 'resume', { note: 'Part arrived' })).json()) as ComplaintRow;
    assert.equal(back.status, 'in_progress');
    assert.equal(back.holdNote, null);
    await step(biomed, c.id, 'escalate', { note: 'Needs OEM support' });
    const answered = (await (await step(admin, c.id, 'resume', { note: 'Try the spare board first' })).json()) as ComplaintRow;
    assert.equal(answered.escalatedAt, null);
    assert.equal((await step(biomed, c.id, 'resume')).status, 403, 'an engineer used the HOD’s step');
  });

  it('the engineer resolves straight from on hold, and the downtime still runs from raised to resolved', async () => {
    const c = await started();
    await step(admin, c.id, 'hold', { note: 'Waiting for the OEM' });
    // Raised 30 hours ago: the hold does not stop the clock (decision C).
    await prisma.complaint.update({ where: { id: c.id }, data: { raisedAt: new Date(Date.now() - 30 * 3600_000) } });
    const res = await step(biomed, c.id, 'resolve', { resolutionNotes: 'OEM engineer replaced the flow sensor' });
    assert.equal(res.status, 200, await res.clone().text());
    const row = (await res.json()) as ComplaintRow;
    const stored = await prisma.complaint.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal(row.status, 'resolved');
    assert.equal(row.downtimeSeconds, Math.round((stored.resolvedAt!.getTime() - stored.raisedAt.getTime()) / 1000));
    assert.ok(row.downtimeSeconds! >= 30 * 3600 - 5);
  });
});

describe('Closing by whoever raised it', () => {
  it('only the raiser closes a resolved complaint; closing never changes downtime', async () => {
    const c = await started();
    assert.equal((await step(nurse, c.id, 'close')).status, 409, 'closed before it was resolved');
    const resolved = (await (await step(biomed, c.id, 'resolve', { resolutionNotes: 'Replaced the sensor' })).json()) as ComplaintRow;
    assert.equal(resolved.raisedById, users.nurse);
    assert.equal((await step(biomed, c.id, 'close')).status, 403, 'the engineer closed it');
    assert.equal((await step(admin, c.id, 'close')).status, 403, 'the HOD closed it for the nurse');
    const res = await step(nurse, c.id, 'close', { note: 'Working fine since this morning' });
    assert.equal(res.status, 200, await res.clone().text());
    const closed = (await res.json()) as ComplaintRow;
    assert.equal(closed.status, 'closed');
    assert.equal(closed.closedByName, (await prisma.user.findUniqueOrThrow({ where: { id: users.nurse } })).name);
    assert.equal(closed.downtimeSeconds, resolved.downtimeSeconds, 'closing changed the downtime');
    assert.equal((await step(nurse, c.id, 'close')).status, 409, 'closed twice');
    assert.ok(await prisma.auditLog.findFirst({ where: { entityId: c.id, action: 'complaint.close' } }), 'closing not audited');
  });

  it('lists: unresolved holds on-hold ones, done holds resolved and closed, raisedBy=me is one’s own', async () => {
    const held = await started();
    await step(admin, held.id, 'hold', { note: 'Waiting for the OEM' });
    const done = await started();
    await step(biomed, done.id, 'resolve', { resolutionNotes: 'Fixed' });
    const list = async (cookie: string, q: string) => ((await (await call(base, cookie, 'GET', `/complaints?${q}&search=${PREFIX}&pageSize=100`)).json()) as Paged<ComplaintRow>).items.map((x) => x.id);
    assert.ok((await list(admin, 'status=unresolved')).includes(held.id));
    assert.ok((await list(admin, 'status=done')).includes(done.id));
    assert.ok(!(await list(admin, 'status=done')).includes(held.id));
    const mineToClose = await list(nurse, 'status=resolved&raisedBy=me');
    assert.ok(mineToClose.includes(done.id) && (await list(biomed, 'status=resolved&raisedBy=me')).every((id) => id !== done.id));
  });

  it('shows every step with its note in the history', async () => {
    const c = await started();
    await step(biomed, c.id, 'escalate', { note: 'Needs OEM support' });
    await step(admin, c.id, 'hold', { note: 'OEM visit on Monday' });
    await step(admin, c.id, 'resume', { note: 'Part arrived' });
    await step(biomed, c.id, 'resolve', { resolutionNotes: 'Board replaced' });
    await step(nurse, c.id, 'close', { note: 'All good' });
    const d = await detail(c.id);
    const kinds = d.events.map((e) => e.kind).filter((k) => !['document', 'expense'].includes(k));
    assert.deepEqual(kinds, ['raised', 'started', 'escalated', 'held', 'resumed', 'resolved', 'closed']);
    assert.equal(d.events.find((e) => e.kind === 'held')?.detail, 'OEM visit on Monday');
    assert.equal(d.events.find((e) => e.kind === 'closed')?.detail, 'All good');
  });
});

describe('Resolved complaints nobody closed', () => {
  it('close by themselves after the hospital’s number of days; younger ones stay, and their raiser is reminded once a day', async () => {
    await prisma.hospitalSettings.updateMany({ data: { complaintCloseDays: 3 } });
    // Raised by the engineer, who has the reminders bell.
    const old = await started(biomed);
    await step(biomed, old.id, 'resolve', { resolutionNotes: 'Fixed' });
    const young = await started(biomed);
    await step(biomed, young.id, 'resolve', { resolutionNotes: 'Fixed' });
    const today = todayISO();
    await prisma.complaint.update({ where: { id: old.id }, data: { resolvedAt: zonedDayStart(addDaysISO(today, -3)) } }); // resolved three days ago
    await prisma.complaint.update({ where: { id: young.id }, data: { resolvedAt: zonedDayStart(addDaysISO(today, -2)) } });

    const first = await followUpResolvedComplaints(today);
    assert.ok(first.closed >= 1);
    const o = await prisma.complaint.findUniqueOrThrow({ where: { id: old.id } });
    const y = await prisma.complaint.findUniqueOrThrow({ where: { id: young.id } });
    assert.equal(o.status, 'closed');
    assert.equal(o.closedBy, null, 'a person was recorded for an automatic close');
    assert.equal(y.status, 'resolved', 'closed too early');
    assert.ok(await prisma.auditLog.findFirst({ where: { entityId: old.id, action: 'complaint.autoclose', actorId: null } }), 'automatic close not audited');
    assert.equal((await detail(old.id)).events.at(-1)?.title, 'Closed automatically');

    const reminders = () => prisma.notification.findMany({ where: { userId: users.biomed, type: 'complaint', thresholdDays: -1 } });
    const once = await reminders();
    assert.equal(once.length, 1);
    assert.ok(once[0].message.includes(young.complaintNo) && !once[0].message.includes(old.complaintNo));
    await followUpResolvedComplaints(today); // the job runs again the same day (a restart)
    assert.equal((await reminders()).length, 1, 'reminded twice on one day');
  });
});
