// Step 4 of docs/requirements-2026-10-20.md: the condemnation committee's form (reason, estimated value, committee
// date) and its register, and transferring equipment to another unit (decision E: with HOD approval, only where the
// hospital turns transfers on). A transferred machine leaves like a condemned one: out of the active lists, reminders
// and open complaints, read-only, its history kept. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ApprovalRow, AssetRow, CondemnationInfo, HospitalInfo, Paged, ReportData, TimelineEvent, TransferInfo } from '@bme/shared';
import { addDaysISO, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { call, condemnForm, login, startServer } from './testUtils';

const PREFIX = 'CTTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nurse = '';
const ids = { vent: '', icu: '', icu1: '' };
const today = todayISO();

async function cleanUp() {
  const assets = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const complaints = (await prisma.complaint.findMany({ where: { assetId: { in: assets } }, select: { id: true } })).map((c) => c.id);
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: assets } } });
  await prisma.notification.deleteMany({ where: { assetId: { in: assets } } });
  await prisma.complaintStep.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.complaint.deleteMany({ where: { id: { in: complaints } } });
  await prisma.attachment.deleteMany({ where: { ownerType: 'asset', ownerId: { in: assets } } });
  await prisma.purchaseOrder.deleteMany({ where: { assetId: { in: assets } } });
  await prisma.asset.deleteMany({ where: { id: { in: assets } } });
  await prisma.hospitalSettings.updateMany({ data: { transfersEnabled: false } });
}

before(async () => {
  await cleanUp();
  ({ server, base } = startServer());
  [admin, biomed, nurse] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  ids.vent = (await prisma.equipmentType.findFirstOrThrow({ where: { code: 'VENT' } })).id;
  ids.icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
  ids.icu1 = (await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })).id;
});
after(async () => {
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const makeAsset = async (extra: object = {}) => {
  const res = await call(base, biomed, 'POST', '/assets', { equipmentTypeId: ids.vent, name: `${PREFIX}${++n}`, departmentId: ids.icu, locationId: ids.icu1, installationDate: '2016-04-01', ...extra });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { id: string; assetCode: string };
};
const pendingFor = async (assetId: string, type: string) =>
  ((await (await call(base, admin, 'GET', '/approvals?status=pending')).json()) as ApprovalRow[]).find((r) => r.assetId === assetId && r.type === type);
const approve = async (assetId: string, type: string) => {
  const r = await pendingFor(assetId, type);
  assert.ok(r, `no pending ${type} request`);
  const res = await call(base, admin, 'POST', `/approvals/${r.id}/approve`, {});
  assert.equal(res.status, 200, await res.clone().text());
};
const condemn = (assetId: string, form: FormData) => fetch(`${base}/assets/${assetId}/condemn`, { method: 'POST', headers: { cookie: biomed }, body: form });

describe('The condemnation committee form', () => {
  it('needs the reason, the estimated value and a committee date that is not in the future', async () => {
    const a = await makeAsset();
    const noCategory = condemnForm('No spares any more');
    noCategory.delete('reasonCategory');
    assert.equal((await condemn(a.id, noCategory)).status, 400);
    const noValue = condemnForm('No spares any more');
    noValue.delete('estimatedValue');
    assert.equal((await condemn(a.id, noValue)).status, 400);
    const future = condemnForm('No spares any more');
    future.set('committeeDate', addDaysISO(today, 1));
    assert.equal((await condemn(a.id, future)).status, 400);
    assert.equal(await prisma.approvalRequest.count({ where: { targetId: a.id } }), 0);
  });

  it('shows the form to the HOD, and on the certificate once approved', async () => {
    const a = await makeAsset();
    const form = condemnForm('Display board no longer made');
    form.set('reasonCategory', 'end_of_support');
    form.set('estimatedValue', '12500');
    form.set('committeeDate', addDaysISO(today, -2));
    assert.equal((await condemn(a.id, form)).status, 201);
    const summary = (await pendingFor(a.id, 'condemn'))!.summary;
    assert.match(summary, /End of support/);
    assert.match(summary, /12,500/);
    await approve(a.id, 'condemn');
    const info = (await (await call(base, biomed, 'GET', `/assets/${a.id}/condemnation`)).json()) as CondemnationInfo;
    assert.deepEqual([info.reasonCategory, info.estimatedValue, info.committeeDate, info.reason], ['end_of_support', 12500, addDaysISO(today, -2), 'Display board no longer made']);
    const timeline = (await (await call(base, biomed, 'GET', `/assets/${a.id}/timeline`)).json()) as TimelineEvent[];
    assert.equal(timeline[0].kind, 'condemned', 'the condemnation is not the latest event on the timeline');
  });

  it('the register lists it by committee date, with purchase cost and estimated value', async () => {
    const a = await makeAsset();
    await call(base, admin, 'POST', `/assets/${a.id}/purchase-orders`, { poNumber: `${PREFIX}PO`, poDate: '2016-03-01', vendor: 'Philips', cost: 800000 });
    const form = condemnForm('Repair quote 5 lakh');
    form.set('reasonCategory', 'repair_cost');
    form.set('estimatedValue', '40000');
    form.set('committeeDate', addDaysISO(today, -10));
    await condemn(a.id, form);
    await approve(a.id, 'condemn');
    const report = async (from: string, to: string) =>
      ((await (await call(base, admin, 'GET', `/reports/condemnation?format=json&from=${from}&to=${to}`)).json()) as ReportData).sheets[0].rows;
    const row = (await report(addDaysISO(today, -15), today)).find((r) => r.code === a.assetCode);
    assert.ok(row, 'not in the register');
    assert.deepEqual([row.committee, row.cost, row.value, row.reason], [addDaysISO(today, -10), 800000, 40000, 'Repair costs more than half its price']);
    assert.ok(!(await report(addDaysISO(today, -5), today)).some((r) => r.code === a.assetCode), 'dated by approval instead of the committee');
    const xlsx = await fetch(`${base}/reports/condemnation?format=xlsx&from=${addDaysISO(today, -15)}&to=${today}`, { headers: { cookie: admin } });
    assert.equal(xlsx.status, 200);
  });
});

describe('Transfer to another unit', () => {
  it('is refused until the hospital turns transfers on; everyone can see whether they are on', async () => {
    const a = await makeAsset();
    assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/transfer`, { toUnit: 'Indore unit', reason: 'Needed there' })).status, 409);
    assert.equal(((await (await call(base, nurse, 'GET', '/hospital')).json()) as HospitalInfo).transfersEnabled, false);
    await prisma.hospitalSettings.updateMany({ data: { transfersEnabled: true } });
    assert.equal(((await (await call(base, nurse, 'GET', '/hospital')).json()) as HospitalInfo).transfersEnabled, true);
    assert.equal((await call(base, nurse, 'POST', `/assets/${a.id}/transfer`, { toUnit: 'Indore unit', reason: 'Needed there' })).status, 403, 'nursing asked for a transfer');
  });

  it('waits for the HOD; one request at a time, and not alongside a condemnation', async () => {
    await prisma.hospitalSettings.updateMany({ data: { transfersEnabled: true } });
    const a = await makeAsset();
    assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/transfer`, { toUnit: 'Indore unit', reason: 'Second ventilator needed there' })).status, 201);
    assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).status, 'active', 'changed before approval');
    assert.match((await pendingFor(a.id, 'transfer'))!.summary, /Indore unit/);
    assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/transfer`, { toUnit: 'Indore unit', reason: 'Again' })).status, 409);
    assert.equal((await condemn(a.id, condemnForm('Beyond repair now'))).status, 409, 'condemnation asked while a transfer waits');
  });

  it('once approved, the asset leaves like a condemned one: read-only, out of the active lists, its complaints closed, its history kept', async () => {
    await prisma.hospitalSettings.updateMany({ data: { transfersEnabled: true } });
    const a = await makeAsset();
    const complaint = (await (await call(base, nurse, 'POST', '/complaints', { assetId: a.id, description: `${PREFIX}alarm` })).json()) as { id: string };
    await call(base, biomed, 'POST', `/assets/${a.id}/transfer`, { toUnit: 'Indore unit', reason: 'Second ventilator needed there' });
    await approve(a.id, 'transfer');

    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: a.id } });
    assert.equal(asset.status, 'transferred');
    assert.equal(asset.assetCode, a.assetCode, 'the asset ID changed');
    const c = await prisma.complaint.findUniqueOrThrow({ where: { id: complaint.id } });
    assert.equal(c.status, 'closed');
    assert.match(c.closeNote ?? '', /transferred to Indore unit/);

    assert.equal((await call(base, admin, 'PATCH', `/assets/${a.id}`, { name: `${PREFIX}renamed` })).status, 409, 'edited after transfer');
    assert.equal((await call(base, nurse, 'POST', '/complaints', { assetId: a.id, description: `${PREFIX}again` })).status, 409, 'complaint on a transferred asset');
    assert.equal((await call(base, admin, 'POST', `/assets/${a.id}/purchase-orders`, { poNumber: `${PREFIX}PO2`, poDate: today, vendor: 'X', cost: 1 })).status, 409);
    assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/transfer`, { toUnit: 'Elsewhere', reason: 'Again' })).status, 409);
    assert.equal((await condemn(a.id, condemnForm('After transfer'))).status, 409);

    const list = async (status: string) => ((await (await call(base, admin, 'GET', `/assets?status=${status}&search=${PREFIX}&pageSize=100`)).json()) as Paged<AssetRow>).items.map((x) => x.id);
    assert.ok(!(await list('active')).includes(a.id), 'still in the active list');
    assert.ok((await list('transferred')).includes(a.id));

    const info = (await (await call(base, nurse, 'GET', `/assets/${a.id}/transfer`)).json()) as TransferInfo;
    assert.equal(info.toUnit, 'Indore unit');
    const timeline = (await (await call(base, biomed, 'GET', `/assets/${a.id}/timeline`)).json()) as TimelineEvent[];
    assert.equal(timeline[0].title, 'Transferred to Indore unit');
    const master = (await (await call(base, admin, 'GET', `/reports/asset-master?format=json&assetStatus=all`)).json()) as ReportData;
    assert.equal(master.sheets[0].rows.find((r) => r.code === a.assetCode)?.status, 'TRANSFERRED');
    assert.ok(await prisma.auditLog.findFirst({ where: { entityId: a.id, action: 'asset.transfer' } }), 'transfer not audited');
  });
});
