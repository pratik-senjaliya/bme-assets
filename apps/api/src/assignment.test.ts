// Complaint assignment: the HOD assigns anyone who can work on complaints; an engineer may only take an unassigned
// complaint for themselves; starting an unassigned complaint makes it yours; the assignee hears about it; "assigned
// to me" lists exactly that. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Assignee, ComplaintDetail, ComplaintRow, Paged } from '@bme/shared';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

const PREFIX = 'ATEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nurse = '';
let assetId = '';
const users = { admin: '', biomed: '', nurse: '' };

async function cleanUp() {
  const assets = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const ids = assets.map((a) => a.id);
  await prisma.notification.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.complaint.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.asset.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  await cleanUp();
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

const raise = async () => {
  const res = await call(base, nurse, 'POST', '/complaints', { assetId, description: `${PREFIX}alarm keeps sounding` });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as ComplaintRow;
};
const assign = (cookie: string, id: string, userId: string | null) => call(base, cookie, 'POST', `/complaints/${id}/assign`, { userId });

describe('Assigning complaints', () => {
  it('starts unassigned; the HOD assigns an engineer, who is told', async () => {
    const c = await raise();
    assert.equal(c.assignedToId, null);
    const res = await assign(admin, c.id, users.biomed);
    assert.equal(res.status, 200);
    const row = (await res.json()) as ComplaintRow;
    assert.equal(row.assignedToId, users.biomed);
    assert.ok(row.assignedToName);
    const notice = await prisma.notification.findFirst({ where: { userId: users.biomed, message: { contains: `${c.complaintNo} assigned to you` } } });
    assert.ok(notice, 'the engineer was not told');
    const audited = await prisma.auditLog.findFirst({ where: { entityId: c.id, action: 'complaint.assign' } });
    assert.ok(audited, 'assignment not in the audit log');
  });

  it('lets an engineer take an unassigned complaint, but not one that is someone else’s or for another person', async () => {
    const c = await raise();
    assert.equal((await assign(biomed, c.id, users.admin)).status, 403, 'engineer assigned someone else');
    assert.equal((await assign(biomed, c.id, users.biomed)).status, 200);
    const other = await raise();
    await assign(admin, other.id, users.admin);
    assert.equal((await assign(biomed, other.id, users.biomed)).status, 409, 'engineer took a complaint assigned to the HOD');
  });

  it('refuses people who cannot work on complaints, nursing staff, and resolved complaints', async () => {
    const c = await raise();
    assert.equal((await assign(admin, c.id, users.nurse)).status, 400, 'assigned to a nurse');
    assert.equal((await assign(nurse, c.id, users.nurse)).status, 403, 'a nurse took a complaint');
    await call(base, biomed, 'POST', `/complaints/${c.id}/start`);
    await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Replaced the sensor' });
    assert.equal((await assign(admin, c.id, users.admin)).status, 409, 'reassigned a resolved complaint');
  });

  it('starting an unassigned complaint makes it yours; starting someone else’s leaves it with them', async () => {
    const free = await raise();
    const started = (await (await call(base, biomed, 'POST', `/complaints/${free.id}/start`)).json()) as ComplaintRow;
    assert.equal(started.assignedToId, users.biomed);
    const theirs = await raise();
    await assign(admin, theirs.id, users.admin);
    const helped = (await (await call(base, biomed, 'POST', `/complaints/${theirs.id}/start`)).json()) as ComplaintRow;
    assert.equal(helped.assignedToId, users.admin);
  });

  it('the HOD can take an assignment away, and the history shows the current one', async () => {
    const c = await raise();
    await assign(admin, c.id, users.biomed);
    const detail = (await (await call(base, admin, 'GET', `/complaints/${c.id}`)).json()) as ComplaintDetail;
    assert.ok(detail.events.some((e) => e.kind === 'assigned' && /Assigned to/.test(e.title)), 'no assignment in the history');
    const cleared = (await (await assign(admin, c.id, null)).json()) as ComplaintRow;
    assert.equal(cleared.assignedToId, null);
  });
});

describe('Work lists', () => {
  it('"assigned to me" and "unassigned" list exactly those, unresolved only', async () => {
    const mine = await raise();
    const free = await raise();
    await assign(admin, mine.id, users.biomed);
    const get = async (q: string) => ((await (await call(base, biomed, 'GET', `/complaints?${q}&search=${PREFIX}&pageSize=100`)).json()) as Paged<ComplaintRow>).items;
    const assigned = await get('assignedTo=me&status=unresolved');
    assert.ok(assigned.some((c) => c.id === mine.id) && !assigned.some((c) => c.id === free.id));
    assert.ok(assigned.every((c) => c.assignedToId === users.biomed && c.status !== 'resolved'));
    const open = await get('assignedTo=none&status=unresolved');
    assert.ok(open.some((c) => c.id === free.id) && open.every((c) => c.assignedToId === null));
  });

  it('assignees are the people who can work on complaints, with their load; only for the HOD', async () => {
    const res = await call(base, admin, 'GET', '/complaints/assignees');
    assert.equal(res.status, 200);
    const list = (await res.json()) as Assignee[];
    assert.ok(list.some((a) => a.id === users.biomed) && !list.some((a) => a.id === users.nurse));
    const load = await prisma.complaint.count({ where: { assignedToId: users.biomed, status: { in: ['open', 'in_progress'] } } });
    assert.equal(list.find((a) => a.id === users.biomed)!.openCount, load);
    assert.equal((await call(base, biomed, 'GET', '/complaints/assignees')).status, 403);
  });
});
