// Integration tests for HOD approvals (business rule 3). Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

const PREFIX = 'ATEST-';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_PATH = path.join(os.tmpdir(), `bme-atest-${process.pid}`);

let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nursing = '';
let superAdmin = '';
const ids = { icu: '', icu1: '', rad: '', xr1: '', vent: '' };
const startedAt = new Date();

before(async () => {
  ({ server, base } = startServer());
  [admin, biomed, nursing, superAdmin] = await Promise.all(['admin', 'biomed', 'nursing', 'superadmin'].map((r) => login(base, `${r}@demo.local`)));
  const [icu, rad, icu1, xr1, vent] = await Promise.all([
    prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } }),
    prisma.department.findUniqueOrThrow({ where: { code: 'RAD' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'XR1' } }),
    prisma.equipmentType.findUniqueOrThrow({ where: { code: 'VENT' } }),
  ]);
  Object.assign(ids, { icu: icu.id, icu1: icu1.id, rad: rad.id, xr1: xr1.id, vent: vent.id });
});

after(async () => {
  const assets = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  await prisma.notification.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { createdAt: { gte: startedAt } }] } });
  await prisma.approvalRequest.deleteMany({ where: { OR: [{ targetId: { in: assetIds } }, { createdAt: { gte: startedAt } }] } });
  await prisma.serviceExpense.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.complaint.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.attachment.deleteMany({ where: { ownerId: { in: assetIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.serviceContract.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const makeAsset = async (extra: object = {}) =>
  (await (await call(base, biomed, 'POST', '/assets', { equipmentTypeId: ids.vent, name: `${PREFIX}${++n}`, departmentId: ids.icu, locationId: ids.icu1, ...extra })).json()) as { id: string; assetCode: string };
const detail = async (id: string) => (await call(base, biomed, 'GET', `/assets/${id}`)).json();
const pending = async (cookie = admin) => (await (await call(base, cookie, 'GET', '/approvals?status=pending')).json()) as { id: string; assetId: string; type: string; summary: string }[];
const requestFor = async (assetId: string, type?: string) => (await pending()).find((r) => r.assetId === assetId && (!type || r.type === type))!;

describe('key-field edits', () => {
  it('stay a proposal until the HOD approves, then apply — and the asset ID never changes', async () => {
    const a = await makeAsset({ serialNo: `${PREFIX}OLD` });
    const edit = await (await call(base, biomed, 'PATCH', `/assets/${a.id}`, { serialNo: `${PREFIX}NEW`, departmentId: ids.rad, locationId: ids.xr1 })).json();
    assert.equal(edit.pendingApproval, true);
    assert.equal(edit.asset.serialNo, `${PREFIX}OLD`);

    const request = await requestFor(a.id, 'edit_key_field');
    assert.match(request.summary, /serial number from .*OLD to .*NEW/);
    assert.match(request.summary, /department from Intensive Care Unit to Radiology/);

    const done = await call(base, admin, 'POST', `/approvals/${request.id}/approve`, {});
    assert.equal(done.status, 200);
    const after = await detail(a.id);
    assert.equal(after.serialNo, `${PREFIX}NEW`);
    assert.equal(after.departmentId, ids.rad);
    assert.equal(after.assetCode, a.assetCode, 'the ID is permanent');
  });

  it('a rejected request changes nothing, and the requester is told why', async () => {
    const a = await makeAsset({ serialNo: `${PREFIX}KEEP` });
    await call(base, biomed, 'PATCH', `/assets/${a.id}`, { serialNo: `${PREFIX}NOPE` });
    const request = await requestFor(a.id);
    assert.equal((await call(base, admin, 'POST', `/approvals/${request.id}/reject`, {})).status, 400, 'a reason is required');
    const res = await call(base, admin, 'POST', `/approvals/${request.id}/reject`, { reason: 'Serial checked on the nameplate' });
    assert.equal(res.status, 200);
    assert.equal((await detail(a.id)).serialNo, `${PREFIX}KEEP`);
    const mine = await (await call(base, biomed, 'GET', '/approvals?status=rejected')).json();
    assert.equal(mine.find((r: { id: string }) => r.id === request.id).decisionNote, 'Serial checked on the nameplate');
    const bell = await (await call(base, biomed, 'GET', '/notifications')).json();
    assert.ok(bell.items.some((x: { type: string; message: string }) => x.type === 'approval' && /rejected/.test(x.message)));
  });

  it('is refused (and stays pending) when it no longer holds, e.g. the serial is now taken', async () => {
    const [a, b] = [await makeAsset(), await makeAsset()];
    await call(base, biomed, 'PATCH', `/assets/${a.id}`, { serialNo: `${PREFIX}CLASH` });
    await call(base, admin, 'PATCH', `/assets/${b.id}`, { serialNo: `${PREFIX}CLASH` }); // admin edits directly
    const request = await requestFor(a.id);
    const res = await call(base, admin, 'POST', `/approvals/${request.id}/approve`, {});
    assert.equal(res.status, 409);
    assert.equal((await pending()).some((r) => r.id === request.id), true, 'the failed approval rolled back');
  });
});

describe('who may decide', () => {
  it('biomed and the super admin can ask but never decide, and cannot edit key fields directly', async () => {
    const a = await makeAsset({ serialNo: `${PREFIX}SA` });
    const sa = await (await call(base, superAdmin, 'PATCH', `/assets/${a.id}`, { serialNo: `${PREFIX}SA2` })).json();
    assert.equal(sa.pendingApproval, true, 'the super admin cannot bypass the HOD');
    assert.equal(sa.asset.serialNo, `${PREFIX}SA`);

    const request = await requestFor(a.id);
    for (const who of [biomed, superAdmin, nursing]) {
      assert.equal((await call(base, who, 'POST', `/approvals/${request.id}/approve`, {})).status, 403);
      assert.equal((await call(base, who, 'POST', `/approvals/${request.id}/reject`, { reason: 'no' })).status, 403);
    }
    assert.equal((await call(base, nursing, 'GET', '/approvals')).status, 403);
  });

  it('a requester sees only their own requests; the HOD sees all', async () => {
    const a = await makeAsset({ serialNo: `${PREFIX}OWN` });
    await call(base, biomed, 'PATCH', `/assets/${a.id}`, { serialNo: `${PREFIX}OWN2` });
    assert.ok((await pending(biomed)).some((r) => r.assetId === a.id));
    assert.equal((await pending(superAdmin)).some((r) => r.assetId === a.id), false);
    assert.ok((await pending(admin)).some((r) => r.assetId === a.id));
  });

  it('two decisions on one request: exactly one wins', async () => {
    const a = await makeAsset({ serialNo: `${PREFIX}RACE` });
    await call(base, biomed, 'PATCH', `/assets/${a.id}`, { serialNo: `${PREFIX}RACE2` });
    const request = await requestFor(a.id);
    const codes = (await Promise.all([
      call(base, admin, 'POST', `/approvals/${request.id}/approve`, {}),
      call(base, admin, 'POST', `/approvals/${request.id}/reject`, { reason: 'changed my mind' }),
    ])).map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409]);
  });
});

describe('condemnation', () => {
  const condemn = (cookie: string, assetId: string, reason = 'Beyond economical repair, no spares available') => {
    const form = new FormData();
    form.set('reason', reason);
    return fetch(`${base}/assets/${assetId}/condemn`, { method: 'POST', headers: { cookie }, body: form });
  };

  it('asset stays active until approved; then it leaves active lists, reminders and PMS but keeps its ID and history', async () => {
    const a = await makeAsset({ installationDate: '2025-01-01', warrantyMonths: 12 });
    const res = await condemn(biomed, a.id);
    assert.equal(res.status, 201);
    assert.equal((await detail(a.id)).status, 'active');
    assert.equal((await condemn(biomed, a.id)).status, 409, 'one pending request at a time');
    assert.equal((await condemn(nursing, a.id)).status, 403);

    const request = await requestFor(a.id, 'condemn');
    assert.equal((await call(base, admin, 'POST', `/approvals/${request.id}/approve`, { note: 'Agreed' })).status, 200);

    const after = await detail(a.id);
    assert.equal(after.status, 'condemned');
    assert.equal(after.assetCode, a.assetCode);
    const active = await (await call(base, biomed, 'GET', `/assets?search=${a.assetCode}`)).json();
    assert.equal(active.total, 0);
    assert.equal((await (await call(base, biomed, 'GET', `/assets?search=${a.assetCode}&status=condemned`)).json()).total, 1);

    // Read-only from now on
    assert.equal((await call(base, biomed, 'PATCH', `/assets/${a.id}`, { name: `${PREFIX}renamed` })).status, 409);
    assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: '2026-01-01', agency: 'Lab', result: 'pass' })).status, 409);
    assert.equal((await call(base, biomed, 'POST', '/complaints', { assetId: a.id, description: 'ventilator still alarming' })).status, 409);
    assert.equal((await condemn(biomed, a.id)).status, 409, 'cannot condemn twice');

    const info = await (await call(base, biomed, 'GET', `/assets/${a.id}/condemnation`)).json();
    assert.equal(info.approvedByName, 'Dr. Meera Shah (HOD)');
    assert.match(info.reason, /economical repair/);
    assert.equal((await call(base, biomed, 'GET', `/assets/${(await makeAsset()).id}/condemnation`)).status, 404);
  });

  it('keeps the end-of-life letter with the request', async () => {
    const a = await makeAsset();
    const form = new FormData();
    form.set('reason', 'Manufacturer ended support');
    form.set('file', new Blob([new Uint8Array(Buffer.from('%PDF-1.4\nEOL letter'))]), 'eol-letter.pdf');
    const res = await fetch(`${base}/assets/${a.id}/condemn`, { method: 'POST', headers: { cookie: biomed }, body: form });
    assert.equal(res.status, 201);
    await call(base, admin, 'POST', `/approvals/${(await requestFor(a.id, 'condemn')).id}/approve`, {});
    const info = await (await call(base, biomed, 'GET', `/assets/${a.id}/condemnation`)).json();
    assert.equal(info.eolLetter.fileName, 'eol-letter.pdf');
    const dl = await fetch(`${base}/attachments/${info.eolLetter.id}/download`, { headers: { cookie: admin } });
    assert.equal(dl.status, 200);
  });
});

describe('deleting a wrong entry', () => {
  const ask = (cookie: string, targetType: string, targetId: string, reason = 'Entered against the wrong asset') =>
    call(base, cookie, 'POST', '/approvals/delete', { targetType, targetId, reason });

  it('a purchase order, contract and expense are removed only on approval, and the removal is audited', async () => {
    const a = await makeAsset();
    const po = await (await call(base, biomed, 'POST', `/assets/${a.id}/purchase-orders`, { poNumber: 'WRONG-1', poDate: '2026-01-01', vendor: 'X', cost: 1000 })).json();
    const contract = await (await call(base, biomed, 'POST', `/assets/${a.id}/contracts`, { type: 'amc', vendor: 'X', startDate: '2026-01-01', endDate: '2026-12-31' })).json();
    const expense = await (await call(base, biomed, 'POST', `/assets/${a.id}/expenses`, { type: 'repair', description: 'Wrong expense', amount: 500, date: '2026-01-01' })).json();

    for (const [type, id] of [['purchase_order', po.id], ['service_contract', contract.id], ['service_expense', expense.id]] as const) {
      assert.equal((await ask(biomed, type, id)).status, 201);
      assert.equal((await ask(biomed, type, id)).status, 409, 'no duplicate request');
    }
    assert.equal((await call(base, biomed, 'GET', `/assets/${a.id}/purchase-orders`)).status, 200);
    assert.equal((await (await call(base, biomed, 'GET', `/assets/${a.id}/purchase-orders`)).json()).length, 1, 'still there');

    for (const r of (await pending()).filter((x) => x.assetId === a.id)) {
      assert.equal((await call(base, admin, 'POST', `/approvals/${r.id}/approve`, {})).status, 200);
    }
    assert.equal((await (await call(base, biomed, 'GET', `/assets/${a.id}/purchase-orders`)).json()).length, 0);
    assert.equal((await (await call(base, biomed, 'GET', `/assets/${a.id}/contracts`)).json()).length, 0);
    assert.equal((await (await call(base, biomed, 'GET', `/assets/${a.id}/expenses`)).json()).items.length, 0);

    const log = await prisma.auditLog.findFirst({ where: { entityType: 'purchase_order', entityId: po.id, action: 'purchase_order.delete' } });
    assert.ok(log, 'the deletion is in the audit log');
    assert.equal((log!.before as { poNumber: string }).poNumber, 'WRONG-1', 'with what was removed');
    assert.equal(log!.after, null);
  });

  it('an asset entered by mistake can be deleted, and its ID is never handed out again', async () => {
    const mistake = await makeAsset();
    assert.equal((await ask(biomed, 'asset', mistake.id)).status, 201);
    const approved = await call(base, admin, 'POST', `/approvals/${(await requestFor(mistake.id, 'delete')).id}/approve`, {});
    assert.equal(approved.status, 200, JSON.stringify(await approved.json()));
    assert.equal((await call(base, biomed, 'GET', `/assets/${mistake.id}`)).status, 404);
    const next = await makeAsset();
    assert.notEqual(next.assetCode, mistake.assetCode);
    assert.ok(Number(next.assetCode.split('-').pop()) > Number(mistake.assetCode.split('-').pop()));
  });

  it('an asset with history cannot be deleted: the HOD must reject and condemn instead', async () => {
    const a = await makeAsset();
    await call(base, biomed, 'POST', `/assets/${a.id}/expenses`, { type: 'repair', description: 'Real repair', amount: 100, date: '2026-01-01' });
    await ask(biomed, 'asset', a.id);
    const res = await call(base, admin, 'POST', `/approvals/${(await requestFor(a.id, 'delete')).id}/approve`, {});
    assert.equal(res.status, 409);
    assert.match((await res.json()).error.message, /condemn the asset instead/);
    assert.equal((await call(base, biomed, 'GET', `/assets/${a.id}`)).status, 200);
  });

  it('nursing cannot ask, and nobody can ask about a missing entry', async () => {
    const a = await makeAsset();
    assert.equal((await ask(nursing, 'asset', a.id)).status, 403);
    assert.equal((await ask(biomed, 'purchase_order', '00000000-0000-4000-8000-000000000000')).status, 404);
  });
});
