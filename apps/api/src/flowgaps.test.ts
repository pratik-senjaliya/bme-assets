// Regression tests for the workflow gaps found in the October 2026 review (items 8–17): who hears about complaints,
// taking back a complaint or a photo raised by mistake, overlapping complaints, reminders that clear, condemned and
// moved equipment, PMS corrections, password changes, withdrawing requests, and asset-ID codes.
// Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ReportData } from '@bme/shared';
import { config } from './lib/config';
import { todayISO } from './lib/dates';
import { recordFailure, resetLoginThrottle } from './lib/loginThrottle';
import { prisma } from './lib/prisma';
import { machineDownMs } from './modules/complaints/complaints.service';
import { generateReminders, OVERDUE_THRESHOLD } from './modules/reminders/reminders.service';
import { call, condemnForm, login, startServer } from './testUtils';

const PREFIX = 'FTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nursing = '';
const ids = { icu: '', icu1: '', icu2: '', rad: '', xr1: '', type: '', biomedUser: '', nursingUser: '' };
const startedAt = new Date();

before(async () => {
  await cleanUp();
  ({ server, base } = startServer());
  resetLoginThrottle();
  [admin, biomed, nursing] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  const [icu, rad, icu1, icu2, xr1, b, n] = await Promise.all([
    prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } }),
    prisma.department.findUniqueOrThrow({ where: { code: 'RAD' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'ICU2' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'XR1' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'biomed@demo.local' } }),
    prisma.user.findUniqueOrThrow({ where: { email: 'nursing@demo.local' } }),
  ]);
  Object.assign(ids, { icu: icu.id, rad: rad.id, icu1: icu1.id, icu2: icu2.id, xr1: xr1.id, biomedUser: b.id, nursingUser: n.id });
  const type = await (await call(base, admin, 'POST', '/equipment-types', { name: `${PREFIX}type`, code: 'FTT', defaultPmsMonths: 3, defaultCalibrationMonths: 12 })).json();
  ids.type = type.id;
  assert.equal((await call(base, admin, 'POST', '/pms-templates', { equipmentTypeId: ids.type, items: [{ id: 'ok', label: 'Unit works', type: 'check', required: true }, { id: 'old', label: 'Old check', type: 'check', required: true }] })).status, 201);
});

// Removes everything these tests create. Also run first, so a run that was stopped half-way leaves nothing behind.
async function cleanUp() {
  const assets = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  await prisma.notification.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { createdAt: { gte: startedAt } }] } });
  await prisma.approvalRequest.deleteMany({ where: { OR: [{ targetId: { in: assetIds } }, { createdAt: { gte: startedAt } }] } });
  const complaints = await prisma.complaint.findMany({ where: { assetId: { in: assetIds } }, select: { id: true } });
  await prisma.attachment.deleteMany({ where: { ownerId: { in: [...assetIds, ...complaints.map((c) => c.id)] } } });
  await prisma.serviceExpense.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.complaint.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.$transaction([
    prisma.$queryRaw`select set_config('bme.allow_pms_cleanup', 'on', true)`,
    prisma.pmsRecord.deleteMany({ where: { assetId: { in: assetIds } } }),
  ]);
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  await prisma.location.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: 'ftest-' } } });
  await prisma.department.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.pmsTemplate.deleteMany({ where: { equipmentType: { code: 'FTT' } } });
  await prisma.equipmentType.deleteMany({ where: { code: 'FTT' } });
}

after(async () => {
  await cleanUp();
  resetLoginThrottle();
  server.close();
  await prisma.$disconnect();
});

let n = 0;
type Asset = { id: string; assetCode: string };
const makeAsset = async (extra: object = {}) => {
  const res = await call(base, admin, 'POST', '/assets', { equipmentTypeId: ids.type, name: `${PREFIX}${++n}`, departmentId: ids.icu, locationId: ids.icu1, ...extra });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as Asset;
};
const raise = async (assetId: string, cookie = nursing) => {
  const res = await call(base, cookie, 'POST', '/complaints', { assetId, description: `${PREFIX}not working` });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { id: string; complaintNo: string };
};
const unread = (userId: string, assetId: string, type: string) => prisma.notification.count({ where: { userId, assetId, type, readAt: null } });
const condemn = async (assetId: string) => {
  const form = condemnForm('Beyond economical repair');
  assert.equal((await fetch(`${base}/assets/${assetId}/condemn`, { method: 'POST', headers: { cookie: biomed }, body: form })).status, 201);
  const request = await prisma.approvalRequest.findFirstOrThrow({ where: { targetId: assetId, type: 'condemn', status: 'pending' } });
  assert.equal((await call(base, admin, 'POST', `/approvals/${request.id}/approve`, {})).status, 200);
};

describe('8. People hear about complaints', () => {
  it('a new complaint tells the biomedical staff; resolving it tells the person who raised it (the wards have the bell too)', async () => {
    const a = await makeAsset();
    const c = await raise(a.id);
    assert.equal(await unread(ids.biomedUser, a.id, 'complaint'), 1, 'biomed is told');
    // Raised by biomed, resolved by the HOD: biomed hears it is fixed.
    const own = await raise(a.id, biomed);
    await call(base, admin, 'POST', `/complaints/${own.id}/start`);
    assert.equal((await call(base, admin, 'POST', `/complaints/${own.id}/resolve`, { resolutionNotes: 'Replaced the fuse' })).status, 200);
    const told = await prisma.notification.findFirst({ where: { userId: ids.biomedUser, assetId: a.id, message: { contains: `${own.complaintNo} resolved` } } });
    assert.ok(told, 'the raiser is told it is resolved');
    // Nursing has the bell by default (gap review #6): the ward that raised it hears it is fixed.
    await call(base, admin, 'POST', `/complaints/${c.id}/start`);
    await call(base, admin, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Fixed' });
    assert.equal(await prisma.notification.count({ where: { userId: ids.nursingUser, assetId: a.id, message: { contains: `${c.complaintNo} resolved` } } }), 1);
  });
});

describe('9. A complaint or a photo raised by mistake', () => {
  it('a complaint nobody has started can be deleted with HOD approval; a started one cannot', async () => {
    const a = await makeAsset();
    const wrong = await raise(a.id);
    const asked = await call(base, biomed, 'POST', '/approvals/delete', { targetType: 'complaint', targetId: wrong.id, reason: 'Raised on the wrong ventilator' });
    assert.equal(asked.status, 201, await asked.clone().text());
    const request = await prisma.approvalRequest.findFirstOrThrow({ where: { targetId: wrong.id, status: 'pending' } });
    const rows = await (await call(base, admin, 'GET', '/approvals?status=pending')).json();
    assert.match(rows.find((r: { id: string }) => r.id === request.id).summary, new RegExp(`Delete complaint ${wrong.complaintNo}`));
    assert.equal((await call(base, admin, 'POST', `/approvals/${request.id}/approve`, {})).status, 200);
    assert.equal(await prisma.complaint.findUnique({ where: { id: wrong.id } }), null);

    const started = await raise(a.id);
    await call(base, biomed, 'POST', `/complaints/${started.id}/start`);
    assert.equal((await call(base, biomed, 'POST', '/approvals/delete', { targetType: 'complaint', targetId: started.id, reason: 'Raised on the wrong ventilator' })).status, 409);
  });

  it('the person who added a photo can remove it while the complaint is open, not after it is resolved', async () => {
    const a = await makeAsset();
    const c = await raise(a.id);
    const form = new FormData();
    form.set('ownerType', 'complaint');
    form.set('ownerId', c.id);
    form.set('kind', 'photo');
    form.set('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'wrong.pdf');
    const up = await fetch(`${base}/attachments`, { method: 'POST', headers: { cookie: nursing }, body: form });
    assert.equal(up.status, 201, await up.clone().text());
    const file = await up.json();
    const list = await (await call(base, nursing, 'GET', `/attachments?ownerType=complaint&ownerId=${c.id}`)).json();
    assert.equal(list[0].canRemove, true);
    assert.equal((await call(base, nursing, 'DELETE', `/attachments/${file.id}`)).status, 204);
    assert.equal(await prisma.attachment.count({ where: { ownerId: c.id } }), 0);
    // After resolution the complaint's documents are kept.
    const again = await fetch(`${base}/attachments`, { method: 'POST', headers: { cookie: nursing }, body: form });
    const kept = await again.json();
    await call(base, biomed, 'POST', `/complaints/${c.id}/start`);
    await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Fixed' });
    assert.equal((await call(base, nursing, 'DELETE', `/attachments/${kept.id}`)).status, 409);
  });
});

describe('10. Overlapping complaints on one machine', () => {
  it('count its downtime once', () => {
    const t = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
    // 08–12 and 10–14 overlap (down 08–14 = 6 h); 20–22 is separate (2 h); open one from 23 runs to the end (1 h).
    const down = machineDownMs([{ raisedAt: t(8), resolvedAt: t(12) }, { raisedAt: t(10), resolvedAt: t(14) }, { raisedAt: t(20), resolvedAt: t(22) }, { raisedAt: t(23), resolvedAt: null }], t(0), t(24));
    assert.equal(down / 3_600_000, 9);
    assert.equal(machineDownMs([{ raisedAt: t(8), resolvedAt: t(12) }], t(10), t(11)) / 3_600_000, 1, 'clipped to the period');
  });
});

describe('11. Reminders that clear and that say "overdue"', () => {
  it('an overdue PMS gets one "overdue" reminder, and doing the PMS clears it', async () => {
    const a = await makeAsset({ installationDate: '2025-01-01' }); // PMS overdue
    await generateReminders(todayISO());
    await generateReminders(todayISO()); // safe to run again
    const sent = await prisma.notification.findMany({ where: { userId: ids.biomedUser, assetId: a.id, type: 'pms' } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].thresholdDays, OVERDUE_THRESHOLD);
    assert.match(sent[0].message, /overdue by/);
    assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/pms`, { answers: { ok: 'pass', old: 'pass' } })).status, 201);
    assert.equal(await unread(ids.biomedUser, a.id, 'pms'), 0);
  });

  it('setting equipment not in use clears its reminders', async () => {
    const a = await makeAsset({ installationDate: '2025-01-01' });
    await generateReminders(todayISO());
    assert.ok((await unread(ids.biomedUser, a.id, 'pms')) > 0);
    assert.equal((await call(base, admin, 'PATCH', `/assets/${a.id}`, { status: 'not_in_use' })).status, 200);
    assert.equal(await unread(ids.biomedUser, a.id, 'pms'), 0);
  });
});

describe('12. Condemned equipment is closed', () => {
  it('condemnation closes its open complaints with a note (no invented start time) and clears its reminders', async () => {
    const a = await makeAsset({ installationDate: '2025-01-01' });
    const c = await raise(a.id);
    await generateReminders(todayISO());
    await condemn(a.id);
    const closed = await prisma.complaint.findUniqueOrThrow({ where: { id: c.id } });
    // Closed outright: nobody is asked to close a complaint on condemned equipment.
    assert.equal(closed.status, 'closed');
    assert.ok(closed.resolvedAt && closed.closedAt);
    assert.equal(closed.startedAt, null);
    assert.match(closed.resolutionNotes ?? '', /condemned/);
    assert.equal(await unread(ids.biomedUser, a.id, 'pms'), 0);
  });

  it('takes no new purchase orders or contracts; a late expense can still be recorded', async () => {
    const a = await makeAsset();
    await condemn(a.id);
    assert.equal((await call(base, admin, 'POST', `/assets/${a.id}/purchase-orders`, { poNumber: `${PREFIX}PO`, poDate: '2026-01-01', vendor: 'Vendor', cost: 1000 })).status, 409);
    assert.equal((await call(base, admin, 'POST', `/assets/${a.id}/expenses`, { type: 'repair', date: todayISO(), amount: 500, description: `${PREFIX}final repair invoice` })).status, 201);
  });
});

describe('13. Equipment moved to another department', () => {
  it('takes its open complaints along; resolved ones stay with the department that raised them', async () => {
    const a = await makeAsset();
    const done = await raise(a.id);
    await call(base, biomed, 'POST', `/complaints/${done.id}/start`);
    await call(base, biomed, 'POST', `/complaints/${done.id}/resolve`, { resolutionNotes: 'Fixed' });
    const open = await raise(a.id);
    assert.equal((await call(base, admin, 'PATCH', `/assets/${a.id}`, { departmentId: ids.rad, locationId: ids.xr1 })).status, 200);
    assert.equal((await prisma.complaint.findUniqueOrThrow({ where: { id: open.id } })).departmentId, ids.rad);
    assert.equal((await prisma.complaint.findUniqueOrThrow({ where: { id: done.id } })).departmentId, ids.icu);
  });
});

describe('14. PMS corrections', () => {
  it('count once in the PMS report, with the corrected result', async () => {
    const a = await makeAsset({ installationDate: '2026-01-01' });
    const original = await (await call(base, biomed, 'POST', `/assets/${a.id}/pms`, { answers: { ok: 'pass', old: 'pass' } })).json();
    const corr = await call(base, biomed, 'POST', `/assets/${a.id}/pms`, { answers: { ok: 'fail', old: 'pass' }, correctsRecordId: original.id, correctionReason: 'Battery test was misread' });
    assert.equal(corr.status, 201, await corr.clone().text());
    const report = (await (await call(base, admin, 'GET', `/reports/pms?format=json&from=${todayISO()}&to=${todayISO()}&departmentId=${ids.icu}`)).json()) as ReportData;
    const mine = await prisma.pmsRecord.count({ where: { asset: { name: { startsWith: PREFIX } }, performedOn: new Date(todayISO()), correctsRecordId: null } });
    const kpi = (label: string) => report.kpis.find((k) => k.label === label)?.value;
    // Our original counts once (other suites may add their own PMS today, so compare with what is in the database).
    const originalsToday = await prisma.pmsRecord.count({ where: { performedOn: new Date(todayISO()), correctsRecordId: null, asset: { departmentId: ids.icu } } });
    assert.equal(kpi('PMS done'), originalsToday);
    assert.ok(mine >= 1);
    const failedOriginals = await prisma.pmsRecord.count({ where: { performedOn: new Date(todayISO()), correctsRecordId: null, asset: { departmentId: ids.icu }, result: 'fail' } });
    assert.ok((kpi('Failed') as number) >= failedOriginals + 1, 'the corrected result (fail) is the one counted');
  });

  it('a correction uses the checklist the original was done with, after the checklist has changed', async () => {
    const a = await makeAsset({ installationDate: '2026-01-01' });
    const original = await (await call(base, biomed, 'POST', `/assets/${a.id}/pms`, { answers: { ok: 'pass', old: 'pass' } })).json();
    // The HOD removes "Old check" from the checklist.
    assert.equal((await call(base, admin, 'POST', '/pms-templates', { equipmentTypeId: ids.type, items: [{ id: 'ok', label: 'Unit works', type: 'check', required: true }] })).status, 201);
    const corr = await call(base, biomed, 'POST', `/assets/${a.id}/pms`, { answers: { ok: 'pass', old: 'fail' }, correctsRecordId: original.id, correctionReason: 'Old check was misread' });
    assert.equal(corr.status, 201, await corr.clone().text());
    const saved = await prisma.pmsRecord.findUniqueOrThrow({ where: { id: (await corr.json()).id } });
    assert.equal(saved.templateId, (await prisma.pmsRecord.findUniqueOrThrow({ where: { id: original.id } })).templateId);
    // Put the two-item checklist back for the other tests.
    await call(base, admin, 'POST', '/pms-templates', { equipmentTypeId: ids.type, items: [{ id: 'ok', label: 'Unit works', type: 'check', required: true }, { id: 'old', label: 'Old check', type: 'check', required: true }] });
  });
});

describe('15. Passwords and sessions', () => {
  const email = 'ftest-nurse@demo.local';
  const signIn = async (password: string) => fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];

  it('changing your password ends your other sessions and keeps this one', async () => {
    resetLoginThrottle();
    assert.equal((await call(base, admin, 'POST', '/users', { name: `${PREFIX}Nurse`, email, password: 'First@12345', role: 'nursing', departmentId: ids.icu })).status, 201);
    const s1 = cookieOf(await signIn('First@12345'));
    const s2 = cookieOf(await signIn('First@12345'));
    const changed = await call(base, s2, 'POST', '/auth/password', { currentPassword: 'First@12345', newPassword: 'Second@12345' });
    assert.equal(changed.status, 204);
    const s2now = cookieOf(changed) || s2;
    assert.equal((await call(base, s1, 'GET', '/auth/me')).status, 401, 'the other session ended');
    assert.equal((await call(base, s2now, 'GET', '/auth/me')).status, 200, 'this session carries on');
  });

  it('the HOD’s reset ends sessions and lifts the login lock', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const s = cookieOf(await signIn('Second@12345'));
    for (let i = 0; i < config.loginMaxFailures; i++) recordFailure(email);
    assert.equal((await signIn('Second@12345')).status, 429, 'locked');
    assert.equal((await call(base, admin, 'PATCH', `/users/${user.id}`, { name: user.name, email, role: 'nursing', departmentId: ids.icu, active: true, password: 'Third@12345' })).status, 200);
    assert.equal((await call(base, s, 'GET', '/auth/me')).status, 401, 'old session ended');
    assert.equal((await signIn('Third@12345')).status, 200, 'the reset lets them in');
    const entry = await prisma.auditLog.findFirst({ where: { action: 'user.update', entityId: user.id }, orderBy: { at: 'desc' } });
    assert.ok(JSON.stringify(entry?.after).includes('"sessionVersion":2'), 'the reset is visible in the audit log');
  });
});

describe('16. Taking back an approval request', () => {
  it('the requester can withdraw a pending request; a second request for the same asset is refused meanwhile', async () => {
    const a = await makeAsset({ serialNo: `${PREFIX}SN` });
    assert.equal((await call(base, biomed, 'PATCH', `/assets/${a.id}`, { serialNo: `${PREFIX}SN-1` })).status, 200);
    const again = await call(base, biomed, 'PATCH', `/assets/${a.id}`, { serialNo: `${PREFIX}SN-2` });
    assert.equal(again.status, 409);
    assert.match((await again.json()).error.message, /withdraw/);
    const request = await prisma.approvalRequest.findFirstOrThrow({ where: { targetId: a.id, status: 'pending' } });
    assert.equal((await call(base, admin, 'POST', `/approvals/${request.id}/withdraw`)).status, 404, 'only the requester');
    assert.equal((await call(base, biomed, 'POST', `/approvals/${request.id}/withdraw`)).status, 200);
    assert.equal((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'withdrawn');
    assert.equal((await call(base, admin, 'POST', `/approvals/${request.id}/approve`, {})).status, 409, 'a withdrawn request cannot be approved');
    assert.equal((await call(base, biomed, 'PATCH', `/assets/${a.id}`, { serialNo: `${PREFIX}SN-2` })).status, 200, 'a new request can be made');
  });
});

describe('17. Asset ID codes', () => {
  // A department and location of the tests' own, so a failing run can never rename the hospital's real ones.
  const own = async (tag: string) => {
    const dept = await (await call(base, admin, 'POST', '/departments', { name: `${PREFIX}Dept ${tag}`, code: `FTD${tag}` })).json();
    const loc = await (await call(base, admin, 'POST', '/locations', { departmentId: dept.id, name: `${PREFIX}Bay`, code: 'FTB1' })).json();
    return { dept, loc };
  };

  it('a code in use by asset IDs is locked; names can still change', async () => {
    const { dept, loc } = await own('A');
    await makeAsset({ departmentId: dept.id, locationId: loc.id });
    assert.equal((await call(base, admin, 'PATCH', `/departments/${dept.id}`, { code: 'FTDX' })).status, 409);
    assert.equal((await call(base, admin, 'PATCH', `/departments/${dept.id}`, { name: `${PREFIX}Dept renamed` })).status, 200);
    assert.equal((await call(base, admin, 'PATCH', `/locations/${loc.id}`, { code: 'FTBX' })).status, 409);
    assert.equal((await call(base, admin, 'PATCH', `/equipment-types/${ids.type}`, { code: 'FTX' })).status, 409);
    const settings = await prisma.hospitalSettings.findFirstOrThrow();
    const res = await call(base, admin, 'PUT', '/settings', { shortCode: settings.shortCode === 'ZZZ' ? 'ZZY' : 'ZZZ' });
    if (res.status !== 409) await prisma.hospitalSettings.update({ where: { id: settings.id }, data: { shortCode: settings.shortCode } }); // never leave it changed
    assert.equal(res.status, 409);
  });

  it('location codes are unique within a department, and a location with equipment cannot move department', async () => {
    const { dept, loc } = await own('B');
    assert.equal((await call(base, admin, 'POST', '/locations', { departmentId: dept.id, name: `${PREFIX}Dup`, code: 'ftb1' })).status, 409);
    await makeAsset({ departmentId: dept.id, locationId: loc.id });
    assert.equal((await call(base, admin, 'PATCH', `/locations/${loc.id}`, { departmentId: ids.rad })).status, 409);
    const empty = await (await call(base, admin, 'POST', '/locations', { departmentId: dept.id, name: `${PREFIX}Store`, code: 'FTS1' })).json();
    assert.equal((await call(base, admin, 'PATCH', `/locations/${empty.id}`, { departmentId: ids.rad })).status, 200, 'an empty location can move');
  });
});
