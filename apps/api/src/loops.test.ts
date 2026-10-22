// Gap review, batch 2 (loops): the ward hears what happens to its complaint, the next shift can close it, late
// documents still fit, the HOD cannot lock the install out of itself, own-request decisions are marked, decided
// requests keep what they were about, email failures are kept, and types without a PMS checklist are flagged.
// Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { ApprovalRow, ComplaintDetail, ComplaintRow, NotificationList, Paged, SessionUser, SettingsResponse } from '@bme/shared';
import { prisma } from './lib/prisma';
import { call, login, PNG, startServer } from './testUtils';

process.env.STORAGE_DRIVER = 'local';

const PREFIX = 'LOOPTEST-';
const EMAIL = 'looptest-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nurse = '';
let nurse2 = '';
let radNurse = '';
const ids = { vent: '', icu: '', icu1: '', rad: '', nurseUser: '', nurse2User: '' };
const startedAt = new Date();

async function cleanUp() {
  const assetIds = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const complaints = (await prisma.complaint.findMany({ where: { assetId: { in: assetIds } }, select: { id: true } })).map((c) => c.id);
  const users = (await prisma.user.findMany({ where: { email: { startsWith: EMAIL } }, select: { id: true } })).map((u) => u.id);
  await prisma.notification.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { userId: { in: users } }] } });
  await prisma.approvalRequest.deleteMany({ where: { OR: [{ targetId: { in: assetIds } }, { createdAt: { gte: startedAt }, requestedBy: { in: users } }] } });
  await prisma.attachment.deleteMany({ where: { ownerId: { in: [...assetIds, ...complaints] } } });
  await prisma.complaintStep.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.complaint.deleteMany({ where: { id: { in: complaints } } });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.hospitalSettings.updateMany({ data: { smtpHost: null, smtpPort: null, smtpFrom: null } });
}

before(async () => {
  await cleanUp();
  ({ server, base } = startServer());
  [admin, biomed, nurse] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  ids.vent = (await prisma.equipmentType.findFirstOrThrow({ where: { code: 'VENT' } })).id;
  ids.icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
  ids.rad = (await prisma.department.findUniqueOrThrow({ where: { code: 'RAD' } })).id;
  ids.icu1 = (await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })).id;
  ids.nurseUser = (await prisma.user.findUniqueOrThrow({ where: { email: 'nursing@demo.local' } })).id;
  const make = async (email: string, departmentId: string) => {
    const res = await call(base, admin, 'POST', '/users', { name: `${PREFIX}${email}`, email: `${EMAIL}${email}@demo.local`, role: 'nursing', departmentId, password: 'Demo@1234' });
    assert.equal(res.status, 201, await res.clone().text());
    return ((await res.json()) as { id: string }).id;
  };
  ids.nurse2User = await make('icu2', ids.icu);
  await make('rad', ids.rad);
  [nurse2, radNurse] = await Promise.all([login(base, `${EMAIL}icu2@demo.local`), login(base, `${EMAIL}rad@demo.local`)]);
});
after(async () => {
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const makeAsset = async () => {
  const res = await call(base, admin, 'POST', '/assets', { equipmentTypeId: ids.vent, name: `${PREFIX}${++n}`, departmentId: ids.icu, locationId: ids.icu1 });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { id: string; assetCode: string };
};
const raise = async (assetId: string, cookie = nurse) => (await (await call(base, cookie, 'POST', '/complaints', { assetId, description: `${PREFIX}alarm keeps sounding` })).json()) as ComplaintRow;
const bell = async (userId: string, complaintId: string) => prisma.notification.findMany({ where: { userId, complaintId }, orderBy: { createdAt: 'asc' } });
const resolved = async () => {
  const a = await makeAsset();
  const c = await raise(a.id);
  assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/start`, {})).status, 200);
  assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Replaced the sensor' })).status, 200);
  return { a, c };
};

describe('The ward hears what happens to its complaint', () => {
  it('nursing has the bell, and hears of the start (with its note), the assignment and a hold; each notice opens the complaint', async () => {
    const me = (await (await call(base, nurse, 'GET', '/auth/me')).json()) as SessionUser;
    assert.ok(me.permissions.includes('notification.view'), 'nursing has no bell');
    const a = await makeAsset();
    const c = await raise(a.id);
    const biomedUser = await prisma.user.findUniqueOrThrow({ where: { email: 'biomed@demo.local' } });
    assert.equal((await call(base, admin, 'POST', `/complaints/${c.id}/assign`, { userId: biomedUser.id })).status, 200);
    assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/start`, { note: 'Checking the power board' })).status, 200);
    assert.equal((await call(base, admin, 'POST', `/complaints/${c.id}/hold`, { note: 'OEM engineer on Thursday' })).status, 200);
    const told = (await bell(ids.nurseUser, c.id)).map((x) => x.message);
    assert.ok(told.some((m) => /is with/.test(m)), `not told of the assignment: ${told}`);
    assert.ok(told.some((m) => /started work/.test(m) && /Checking the power board/.test(m)), 'not told of the start and its note');
    assert.ok(told.some((m) => /on hold/.test(m) && /Thursday/.test(m)), 'not told of the hold');
    const list = (await (await call(base, nurse, 'GET', '/notifications')).json()) as NotificationList;
    assert.ok(list.items.some((x) => x.complaintId === c.id), 'the notice does not carry the complaint');
    const detail = (await (await call(base, nurse, 'GET', `/complaints/${c.id}`)).json()) as ComplaintDetail;
    assert.ok(detail.events.some((e) => e.kind === 'started' && e.detail?.includes('Checking the power board')), 'the start note is not in the history');
  });
});

describe('Closing at shift handover', () => {
  it('anyone of that department can close a resolved complaint; another department cannot', async () => {
    const { c } = await resolved();
    const mine = ((await (await call(base, nurse2, 'GET', '/complaints?closable=me&pageSize=100')).json()) as Paged<ComplaintRow>).items;
    assert.ok(mine.some((x) => x.id === c.id), 'not offered to the next shift');
    assert.equal((await call(base, radNurse, 'POST', `/complaints/${c.id}/close`, {})).status, 404, 'another department saw it');
    const res = await call(base, nurse2, 'POST', `/complaints/${c.id}/close`, { note: 'Checked on the night shift' });
    assert.equal(res.status, 200, await res.clone().text());
  });

  it('a nurse who moved department still sees and closes the complaints they raised', async () => {
    const a = await makeAsset();
    const c = await raise(a.id, nurse2);
    assert.equal((await call(base, admin, 'PATCH', `/users/${ids.nurse2User}`, { name: `${PREFIX}icu2`, email: `${EMAIL}icu2@demo.local`, role: 'nursing', departmentId: ids.rad })).status, 200);
    try {
      const moved = await login(base, `${EMAIL}icu2@demo.local`);
      assert.equal((await call(base, moved, 'GET', `/complaints/${c.id}`)).status, 200);
      await call(base, biomed, 'POST', `/complaints/${c.id}/start`, {});
      await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Fixed' });
      assert.equal((await call(base, moved, 'POST', `/complaints/${c.id}/close`, {})).status, 200);
    } finally {
      await call(base, admin, 'PATCH', `/users/${ids.nurse2User}`, { name: `${PREFIX}icu2`, email: `${EMAIL}icu2@demo.local`, role: 'nursing', departmentId: ids.icu });
    }
  });
});

describe('Late documents', () => {
  it('a resolved complaint still takes the service report from the biomedical team, not from the ward', async () => {
    const { a, c } = await resolved();
    const upload = (cookie: string) => {
      const form = new FormData();
      form.set('ownerType', 'complaint');
      form.set('ownerId', c.id);
      form.set('kind', 'service_report');
      form.set('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'report.png');
      return fetch(`${base}/attachments`, { method: 'POST', headers: { cookie }, body: form });
    };
    assert.equal((await upload(biomed)).status, 201);
    assert.equal((await upload(nurse)).status, 409);
    assert.ok(a.id);
  });
});

describe('Guard rails for the HOD', () => {
  it('the Admin role cannot lose users, roles, setup or approvals', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'admin' }, include: { rolePermissions: { include: { permission: true } } } });
    const now = role.rolePermissions.map((rp) => rp.permission.code);
    const res = await call(base, admin, 'PUT', `/roles/${role.id}/permissions`, { permissions: now.filter((c) => c !== 'role.manage') });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /role\.manage/);
    assert.ok((await prisma.rolePermission.count({ where: { roleId: role.id, permission: { code: 'role.manage' } } })) === 1, 'removed anyway');
  });

  it('an own request decided is marked, and an approved deletion keeps the asset it was about', async () => {
    const a = await makeAsset();
    assert.equal((await call(base, admin, 'POST', '/approvals/delete', { targetType: 'asset', targetId: a.id, reason: 'Entered twice by mistake' })).status, 201);
    const pending = ((await (await call(base, admin, 'GET', '/approvals?status=pending')).json()) as ApprovalRow[]).find((r) => r.assetId === a.id)!;
    assert.equal((await call(base, admin, 'POST', `/approvals/${pending.id}/approve`, {})).status, 200);
    const row = ((await (await call(base, admin, 'GET', '/approvals?status=all')).json()) as ApprovalRow[]).find((r) => r.id === pending.id)!;
    assert.equal(row.selfApproved, true);
    assert.deepEqual([row.assetCode, row.assetName], [a.assetCode, `${PREFIX}${n}`], 'the deleted asset lost its name');
    assert.equal(row.assetId, null, 'links to a deleted asset');
  });

  it('a failed email is kept, for Hospital settings to show', async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, r));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r())); // nothing listens there now
    await prisma.hospitalSettings.updateMany({ data: { smtpHost: '127.0.0.1', smtpPort: port, smtpFrom: 'bme@hospital.test' } });
    assert.equal((await call(base, admin, 'POST', '/settings/smtp-test', { to: 'hod@hospital.test' })).status, 502);
    const s = (await (await call(base, admin, 'GET', '/settings')).json()) as SettingsResponse;
    assert.ok(s.mailLastError?.includes('hod@hospital.test'), `no error kept: ${s.mailLastError}`);
    assert.ok(s.mailLastErrorAt);
  });

  it('equipment types say which have no PMS checklist', async () => {
    const types = (await (await call(base, admin, 'GET', '/equipment-types')).json()) as { code: string; checklistVersion: number | null }[];
    assert.ok((types.find((t) => t.code === 'VENT')?.checklistVersion ?? 0) >= 1, 'the ventilator checklist is not shown');
    assert.ok(types.every((t) => 'checklistVersion' in t));
  });
});
