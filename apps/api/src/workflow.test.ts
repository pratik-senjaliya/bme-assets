// Gap review, batch 3 (workflow): a complaint that is not really fixed goes back to the engineer, costs are booked
// while resolving, a wrong calibration is corrected by a linked record, Add asset records its purchase order, the audit
// log exports to Excel, passwords given by the HOD are changed at first sign-in (with short usernames and a "forgot"
// request to the HOD), a leaver's complaints go back to the board, and a failed or stopped backup reaches the HOD.
// Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import type { AssetDetail, CalibrationRow, ComplaintDetail, ComplaintRow, SessionUser, SettingsResponse } from '@bme/shared';
import { todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

const PREFIX = 'WFTEST-';
const EMAIL = 'wftest-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nurse = '';
const ids = { vent: '', icu: '', icu1: '', adminUser: '', biomedUser: '' };
const startedAt = new Date();

async function cleanUp() {
  const assetIds = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const complaints = (await prisma.complaint.findMany({ where: { assetId: { in: assetIds } }, select: { id: true } })).map((c) => c.id);
  const users = (await prisma.user.findMany({ where: { email: { startsWith: EMAIL } }, select: { id: true } })).map((u) => u.id);
  await prisma.notification.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { userId: { in: users } }, { createdAt: { gte: startedAt }, type: { in: ['system', 'account'] } }] } });
  await prisma.serviceExpense.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.complaintStep.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.complaint.deleteMany({ where: { id: { in: complaints } } });
  await prisma.calibrationRecord.updateMany({ where: { assetId: { in: assetIds } }, data: { correctsRecordId: null } });
  await prisma.calibrationRecord.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.hospitalSettings.updateMany({ data: { backupLastAt: null, backupLastError: null, backupLastErrorAt: null } });
}

before(async () => {
  await cleanUp();
  ({ server, base } = startServer());
  [admin, biomed, nurse] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  ids.vent = (await prisma.equipmentType.findFirstOrThrow({ where: { code: 'VENT' } })).id;
  ids.icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
  ids.icu1 = (await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })).id;
  ids.adminUser = (await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } })).id;
  ids.biomedUser = (await prisma.user.findUniqueOrThrow({ where: { email: 'biomed@demo.local' } })).id;
});
after(async () => {
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const makeAsset = async (extra: object = {}) => {
  const res = await call(base, admin, 'POST', '/assets', { equipmentTypeId: ids.vent, name: `${PREFIX}${++n}`, departmentId: ids.icu, locationId: ids.icu1, ...extra });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as AssetDetail;
};
const raise = async (assetId: string) => (await (await call(base, nurse, 'POST', '/complaints', { assetId, description: `${PREFIX}alarm keeps sounding` })).json()) as ComplaintRow;
const detail = async (id: string, cookie = biomed) => (await (await call(base, cookie, 'GET', `/complaints/${id}`)).json()) as ComplaintDetail;
const resolved = async () => {
  const a = await makeAsset();
  const c = await raise(a.id);
  assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/start`, {})).status, 200);
  assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Replaced the sensor' })).status, 200);
  return { a, c };
};

describe('A complaint that is not really fixed', () => {
  it('goes back to the engineer when whoever raised it says so; the downtime carries on', async () => {
    const { c } = await resolved();
    // A note is required, and the engineer cannot send their own work back.
    assert.equal((await call(base, nurse, 'POST', `/complaints/${c.id}/reopen`, {})).status, 400);
    assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/reopen`, { note: 'Not my call' })).status, 403);

    const res = await call(base, nurse, 'POST', `/complaints/${c.id}/reopen`, { note: 'Alarm still sounds after ten minutes' });
    assert.equal(res.status, 200, await res.clone().text());
    const row = (await res.json()) as ComplaintRow;
    assert.equal(row.status, 'in_progress');
    assert.equal(row.resolvedAt, null);
    assert.equal(row.downtimeSeconds, null, 'downtime stopped although it is still down');
    assert.equal(row.assignedToId, ids.biomedUser, 'it should stay with the engineer');
    const told = await prisma.notification.findFirst({ where: { userId: ids.biomedUser, complaintId: c.id, message: { contains: 'not fixed' } } });
    assert.ok(told, 'the engineer was not told');

    // The first resolution stays in the history, followed by the reopening.
    const story = (await detail(c.id)).events.map((e) => [e.kind, e.detail ?? '']);
    const kinds = story.map(([k]) => k);
    assert.ok(kinds.indexOf('resolved') < kinds.indexOf('reopened'), JSON.stringify(story));
    assert.ok(story.some(([k, d]) => k === 'resolved' && d.includes('Replaced the sensor')));

    // Fixed properly this time: downtime runs from the first report.
    assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Replaced the valve' })).status, 200);
    const done = await prisma.complaint.findUniqueOrThrow({ where: { id: c.id } });
    assert.ok(done.resolvedAt!.getTime() > done.raisedAt.getTime());
    assert.equal(done.resolutionNotes, 'Replaced the valve');
  });

  it('cannot be reopened once closed', async () => {
    const { c } = await resolved();
    assert.equal((await call(base, nurse, 'POST', `/complaints/${c.id}/close`, {})).status, 200);
    assert.equal((await call(base, nurse, 'POST', `/complaints/${c.id}/reopen`, { note: 'Broke again' })).status, 409);
  });
});

describe('Resolving with costs', () => {
  it('books the parts and bills against the complaint, dated today, in the same step', async () => {
    const a = await makeAsset();
    const c = await raise(a.id);
    await call(base, biomed, 'POST', `/complaints/${c.id}/start`, {});
    // A bad line refuses the whole step: nothing is resolved or booked.
    const bad = await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Fixed', costs: [{ type: 'spare_part', description: 'Sensor', amount: 0 }] });
    assert.equal(bad.status, 400);
    assert.equal((await prisma.complaint.findUniqueOrThrow({ where: { id: c.id } })).status, 'in_progress');

    const res = await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, {
      resolutionNotes: 'Replaced the flow sensor',
      costs: [
        { type: 'spare_part', description: 'Flow sensor', amount: 4200, vendor: 'Medi Spares' },
        { type: 'repair', description: 'OEM visit', amount: 1500 },
      ],
    });
    assert.equal(res.status, 200, await res.clone().text());
    const booked = await prisma.serviceExpense.findMany({ where: { complaintId: c.id }, orderBy: { amount: 'asc' } });
    assert.deepEqual(booked.map((e) => [e.type, Number(e.amount), e.vendor, e.assetId, e.date.toISOString().slice(0, 10)]), [
      ['repair', 1500, null, a.id, todayISO()],
      ['spare_part', 4200, 'Medi Spares', a.id, todayISO()],
    ]);
    assert.equal((await detail(c.id)).expenses.length, 2);
  });
});

describe('Correcting a calibration', () => {
  it('a linked record replaces a wrong one: flags and due date follow the correction, the original stays marked', async () => {
    const a = await makeAsset();
    const first = (await (await call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: todayISO(), agency: 'Cal Lab', result: 'fail', dueOn: '2099-01-01' })).json()) as CalibrationRow;
    assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).calibrationFailedOn?.toISOString().slice(0, 10), todayISO());

    assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: todayISO(), agency: 'Cal Lab', result: 'pass', correctsRecordId: first.id })).status, 400, 'a reason is required');
    const res = await call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: todayISO(), agency: 'Cal Lab', result: 'pass', correctsRecordId: first.id, correctionReason: 'Result entered wrongly: the certificate says pass' });
    assert.equal(res.status, 201, await res.clone().text());
    const correction = (await res.json()) as CalibrationRow;

    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: a.id } });
    assert.equal(asset.calibrationFailedOn, null, 'still flagged as failed');
    assert.equal(asset.nextCalibrationDue?.toISOString().slice(0, 10), correction.dueOn, 'due date did not follow the correction');

    const list = (await (await call(base, biomed, 'GET', `/assets/${a.id}/calibrations`)).json()) as CalibrationRow[];
    assert.equal(list.find((r) => r.id === first.id)?.correctedById, correction.id);
    assert.equal(list.find((r) => r.id === correction.id)?.correctsRecordId, first.id);
    // Corrected once only; another asset's record cannot be corrected from here.
    assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: todayISO(), agency: 'Cal Lab', result: 'pass', correctsRecordId: first.id, correctionReason: 'Second go at it' })).status, 409);
    const other = await makeAsset();
    assert.equal((await call(base, biomed, 'POST', `/assets/${other.id}/calibrations`, { doneOn: todayISO(), agency: 'Cal Lab', result: 'pass', correctsRecordId: correction.id, correctionReason: 'Wrong machine' })).status, 400);
  });
});

describe('Add asset with its purchase order', () => {
  it('records the PO with the asset, or neither when the PO is incomplete', async () => {
    const a = await makeAsset({ purchaseOrder: { poNumber: 'PO/26/0412', poDate: todayISO(), vendor: 'Medi Supplies', cost: 850000 } });
    const pos = await prisma.purchaseOrder.findMany({ where: { assetId: a.id } });
    assert.deepEqual(pos.map((p) => [p.poNumber, p.vendor, Number(p.cost)]), [['PO/26/0412', 'Medi Supplies', 850000]]);

    const before = await prisma.asset.count();
    const bad = await call(base, admin, 'POST', '/assets', { equipmentTypeId: ids.vent, name: `${PREFIX}no-vendor`, departmentId: ids.icu, locationId: ids.icu1, purchaseOrder: { poNumber: 'PO/1', poDate: todayISO(), vendor: '', cost: 10 } });
    assert.equal(bad.status, 400);
    assert.equal(await prisma.asset.count(), before);
  });
});

describe('Audit log export', () => {
  it('gives the filtered log as an Excel workbook, and is itself logged', async () => {
    await makeAsset();
    assert.equal((await call(base, biomed, 'GET', '/audit-logs/export')).status, 403);
    const res = await call(base, admin, 'GET', `/audit-logs/export?action=asset.create&from=${todayISO()}`);
    assert.equal(res.status, 200, await res.clone().text());
    assert.match(res.headers.get('content-type') ?? '', /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer);
    const text = wb.worksheets.map((ws) => ws.getSheetValues().flat().join(' ')).join(' ');
    assert.match(text, /asset\.create/);
    assert.match(text, new RegExp(`${PREFIX}\\d+`));
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'audit.export', actorId: ids.adminUser, at: { gte: startedAt } } }));
  });
});

describe('Passwords and sign-in names', () => {
  it('a password given by the HOD must be changed before anything else; a username works for signing in', async () => {
    const created = await call(base, admin, 'POST', '/users', { name: `${PREFIX}sister`, email: `${EMAIL}sister@demo.local`, username: 'ICU.Sister1', role: 'nursing', departmentId: ids.icu, password: 'Given@1234' });
    assert.equal(created.status, 201, await created.clone().text());
    assert.equal(((await created.json()) as { username: string }).username, 'icu.sister1');
    // Usernames are unique.
    const dup = await call(base, admin, 'POST', '/users', { name: `${PREFIX}other`, email: `${EMAIL}other@demo.local`, username: 'icu.sister1', role: 'biomed', password: 'Given@1234' });
    assert.equal(dup.status, 409);

    const signIn = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ICU.SISTER1', password: 'Given@1234' }) });
    assert.equal(signIn.status, 200);
    let cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0];
    assert.equal(((await signIn.json()) as SessionUser).mustChangePassword, true);
    const blocked = await call(base, cookie, 'GET', '/assets');
    assert.equal(blocked.status, 403);
    assert.match(await blocked.text(), /choose your own password/i);

    const changed = await call(base, cookie, 'POST', '/auth/password', { currentPassword: 'Given@1234', newPassword: 'Mine@56789' });
    assert.equal(changed.status, 204);
    cookie = (changed.headers.get('set-cookie') ?? '').split(';')[0];
    assert.equal(((await (await call(base, cookie, 'GET', '/auth/me')).json()) as SessionUser).mustChangePassword, false);
    assert.equal((await call(base, cookie, 'GET', '/assets')).status, 200);

    // A reset by the HOD asks again.
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'icu.sister1' } });
    assert.equal((await call(base, admin, 'PATCH', `/users/${user.id}`, { name: user.name, email: user.email, role: 'nursing', departmentId: ids.icu, password: 'Again@1234' })).status, 200);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).mustChangePassword, true);
  });

  it('"forgot password" tells the HOD once, and says nothing about whether the login exists', async () => {
    await call(base, admin, 'POST', '/users', { name: `${PREFIX}forgetful`, email: `${EMAIL}forgetful@demo.local`, username: 'forgetful', role: 'biomed', password: 'Given@1234' });
    const ask = (login: string) => fetch(`${base}/auth/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login }) });
    assert.equal((await ask('forgetful')).status, 204);
    assert.equal((await ask(`${EMAIL}forgetful@demo.local`)).status, 204);
    assert.equal((await ask('nobody-at-all')).status, 204);
    const notices = await prisma.notification.findMany({ where: { userId: ids.adminUser, type: 'account', createdAt: { gte: startedAt } } });
    assert.equal(notices.filter((x) => x.message.includes(`${PREFIX}forgetful`)).length, 1, 'asked twice, told twice');
    assert.ok(!notices.some((x) => x.message.includes('nobody-at-all')));
  });
});

describe('Someone who leaves', () => {
  it('their unresolved complaints go back to the board and the HOD is told', async () => {
    const res = await call(base, admin, 'POST', '/users', { name: `${PREFIX}leaver`, email: `${EMAIL}leaver@demo.local`, role: 'biomed', password: 'Given@1234' });
    const leaver = (await res.json()) as { id: string };
    const a = await makeAsset();
    const c = await raise(a.id);
    assert.equal((await call(base, admin, 'POST', `/complaints/${c.id}/assign`, { userId: leaver.id })).status, 200);
    assert.equal((await call(base, admin, 'DELETE', `/users/${leaver.id}`)).status, 204);
    const after = await prisma.complaint.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal(after.assignedToId, null);
    assert.ok(await prisma.notification.findFirst({ where: { userId: ids.adminUser, complaintId: c.id, message: { contains: 'left' } } }), 'the HOD was not told');
  });
});

describe('Backups', () => {
  it('Hospital settings show the last backup; a failed or stopped one reaches the HOD once a day', async () => {
    const settings = async () => (await (await call(base, admin, 'GET', '/settings')).json()) as SettingsResponse;
    const run = () => call(base, admin, 'POST', '/reminders/run');
    const told = () => prisma.notification.count({ where: { userId: ids.adminUser, type: 'system', createdAt: { gte: startedAt } } });

    // Nothing backs up here (the hosted demo): nothing to say.
    assert.equal((await run()).status, 200);
    assert.equal(await told(), 0);

    await prisma.hospitalSettings.updateMany({ data: { backupLastAt: new Date() } });
    assert.ok((await settings()).backupLastAt);
    await run();
    assert.equal(await told(), 0, 'a fresh backup is not news');

    await prisma.hospitalSettings.updateMany({ data: { backupLastError: 'stopped at line 18 (exit 1)', backupLastErrorAt: new Date(Date.now() + 1000) } });
    await run();
    await run();
    assert.equal(await told(), 1);
    assert.match((await prisma.notification.findFirstOrThrow({ where: { userId: ids.adminUser, type: 'system' }, orderBy: { createdAt: 'desc' } })).message, /failed/i);

    // Stopped: the last one is more than two days old.
    await prisma.notification.deleteMany({ where: { type: 'system', createdAt: { gte: startedAt } } });
    await prisma.hospitalSettings.updateMany({ data: { backupLastAt: new Date(Date.now() - 3 * 86_400_000), backupLastError: null, backupLastErrorAt: null } });
    await run();
    assert.match((await prisma.notification.findFirstOrThrow({ where: { userId: ids.adminUser, type: 'system' } })).message, /no backup/i);
  });
});
