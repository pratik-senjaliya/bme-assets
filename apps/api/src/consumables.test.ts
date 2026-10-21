// Step 6 of docs/requirements-2026-10-20.md: consumables (decision F). Stock moves only through recorded movements
// and never goes below zero; issues go to a department, perhaps for one machine or complaint; reaching the reorder
// level tells the people who keep the stock; the register reports it all. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ConsumableDetail, ConsumableMovementRow, ConsumableRow, ReportData, TimelineEvent } from '@bme/shared';
import { addDaysISO, todayISO } from './lib/dates';
import { ensureRolesAndPermissions } from './lib/baseData';
import { prisma } from './lib/prisma';
import { call, condemnForm, login, startServer } from './testUtils';

const PREFIX = 'CONTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nurse = '';
const ids = { vent: '', icu: '', icu1: '', otherDept: '', biomedUser: '' };
const today = todayISO();

async function cleanUp() {
  const items = (await prisma.consumableItem.findMany({ where: { name: { startsWith: PREFIX, mode: 'insensitive' } }, select: { id: true } })).map((i) => i.id);
  const assets = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  await prisma.consumableMovement.deleteMany({ where: { OR: [{ itemId: { in: items } }, { assetId: { in: assets } }] } });
  await prisma.consumableItem.deleteMany({ where: { id: { in: items } } });
  await prisma.notification.deleteMany({ where: { OR: [{ message: { contains: PREFIX } }, { assetId: { in: assets } }] } });
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: assets } } });
  const complaints = (await prisma.complaint.findMany({ where: { assetId: { in: assets } }, select: { id: true } })).map((c) => c.id);
  await prisma.complaintStep.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.complaint.deleteMany({ where: { id: { in: complaints } } });
  await prisma.attachment.deleteMany({ where: { ownerType: 'asset', ownerId: { in: assets } } });
  await prisma.asset.deleteMany({ where: { id: { in: assets } } });
  await prisma.vendor.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  await cleanUp();
  await ensureRolesAndPermissions(); // grants consumable.manage on a database seeded before it existed
  ({ server, base } = startServer());
  [admin, biomed, nurse] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  ids.vent = (await prisma.equipmentType.findFirstOrThrow({ where: { code: 'VENT' } })).id;
  ids.icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
  ids.icu1 = (await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })).id;
  ids.otherDept = (await prisma.department.findFirstOrThrow({ where: { code: { not: 'ICU' } } })).id;
  ids.biomedUser = (await prisma.user.findUniqueOrThrow({ where: { email: 'biomed@demo.local' } })).id;
});
after(async () => {
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const addItem = async (extra: object = {}) => {
  const res = await call(base, biomed, 'POST', '/consumables', { name: `${PREFIX}${++n} SpO2 probe`, unit: 'pcs', ...extra });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as ConsumableRow;
};
const makeAsset = async () => {
  const res = await call(base, biomed, 'POST', '/assets', { equipmentTypeId: ids.vent, name: `${PREFIX}vent ${++n}`, departmentId: ids.icu, locationId: ids.icu1 });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { id: string; assetCode: string };
};
const issue = (itemId: string, body: object) => call(base, biomed, 'POST', `/consumables/${itemId}/issue`, { quantity: 1, date: today, departmentId: ids.icu, reason: 'Replaced the broken one', ...body });
const stockOf = async (id: string) => (await prisma.consumableItem.findUniqueOrThrow({ where: { id } })).stock;

describe('Items and stock in', () => {
  it('an item starts with what is on the shelf, as its first movement; names are unique whatever the capitals', async () => {
    const item = await addItem({ openingStock: 12, reorderLevel: 3, unitCost: 450 });
    assert.deepEqual([item.stock, item.low, item.unitCost], [12, false, 450]);
    const detail = (await (await call(base, biomed, 'GET', `/consumables/${item.id}`)).json()) as ConsumableDetail;
    assert.deepEqual(detail.movements.map((m) => [m.kind, m.quantity, m.stockAfter, m.reason]), [['adjust', 12, 12, 'Opening stock']]);
    assert.equal((await call(base, biomed, 'POST', '/consumables', { name: item.name.toUpperCase() })).status, 409);
  });

  it('stock in adds to the stock, and the price paid becomes the unit cost', async () => {
    const vendor = await prisma.vendor.create({ data: { name: `${PREFIX}Medisupply` } });
    const item = await addItem({ unitCost: 400 });
    const res = await call(base, biomed, 'POST', `/consumables/${item.id}/in`, { quantity: 20, date: addDaysISO(today, -3), unitCost: 425, supplierId: vendor.id, reference: 'INV-889' });
    assert.equal(res.status, 201, await res.clone().text());
    const m = (await res.json()) as ConsumableMovementRow;
    assert.deepEqual([m.kind, m.quantity, m.stockAfter, m.supplierName, m.reference], ['in', 20, 20, `${PREFIX}Medisupply`, 'INV-889']);
    const row = (await (await call(base, biomed, 'GET', `/consumables/${item.id}`)).json()) as ConsumableDetail;
    assert.deepEqual([row.stock, row.unitCost], [20, 425]);
    assert.ok(await prisma.auditLog.findFirst({ where: { entityId: item.id, action: 'consumable.in' } }), 'not audited');
  });

  it('refuses a date ahead of today, or further back than 30 days', async () => {
    const item = await addItem();
    assert.equal((await call(base, biomed, 'POST', `/consumables/${item.id}/in`, { quantity: 5, date: addDaysISO(today, 1) })).status, 400);
    assert.equal((await call(base, biomed, 'POST', `/consumables/${item.id}/in`, { quantity: 5, date: addDaysISO(today, -31) })).status, 400);
    assert.equal(await stockOf(item.id), 0);
  });

  it('is for the biomedical team, not nursing', async () => {
    assert.equal((await call(base, nurse, 'GET', '/consumables')).status, 403);
    assert.equal((await call(base, nurse, 'POST', '/consumables', { name: `${PREFIX}nurse item` })).status, 403);
    assert.equal((await call(base, admin, 'GET', '/consumables')).status, 200);
  });
});

describe('Giving out', () => {
  it('takes from the stock, never more than there is', async () => {
    const item = await addItem({ openingStock: 3 });
    assert.equal((await issue(item.id, { quantity: 2 })).status, 201);
    const tooMany = await issue(item.id, { quantity: 2 });
    assert.equal(tooMany.status, 409);
    assert.match(await tooMany.text(), /Only 1 pcs/);
    assert.equal(await stockOf(item.id), 1);
  });

  it('two people giving out the last one: only one of them can', async () => {
    const item = await addItem({ openingStock: 1 });
    const results = await Promise.all([issue(item.id, {}), issue(item.id, {})]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await stockOf(item.id), 0);
    assert.equal(await prisma.consumableMovement.count({ where: { itemId: item.id, kind: 'out' } }), 1);
  });

  it('a machine must be in that department and still in the hospital; a complaint names its machine', async () => {
    const item = await addItem({ openingStock: 10, unitCost: 300 });
    const asset = await makeAsset();
    assert.equal((await issue(item.id, { assetId: asset.id, departmentId: ids.otherDept })).status, 400);
    const complaint = (await (await call(base, nurse, 'POST', '/complaints', { assetId: asset.id, description: `${PREFIX}probe broken` })).json()) as { id: string; complaintNo: string };
    const other = await makeAsset();
    assert.equal((await issue(item.id, { assetId: other.id, complaintId: complaint.id })).status, 400, 'complaint about another machine');

    const res = await issue(item.id, { complaintId: complaint.id, quantity: 2 });
    assert.equal(res.status, 201, await res.clone().text());
    const m = (await res.json()) as ConsumableMovementRow;
    assert.deepEqual([m.quantity, m.asset?.id, m.complaint?.complaintNo, m.unitCost], [-2, asset.id, complaint.complaintNo, 300]);
    const timeline = (await (await call(base, nurse, 'GET', `/assets/${asset.id}/timeline`)).json()) as TimelineEvent[];
    assert.ok(timeline.some((e) => e.kind === 'consumable' && /Given: 2 pcs/.test(e.title) && e.detail?.includes(complaint.complaintNo)), 'not on the machine timeline');

    const form = condemnForm('Beyond economical repair');
    assert.equal((await fetch(`${base}/assets/${other.id}/condemn`, { method: 'POST', headers: { cookie: biomed }, body: form })).status, 201);
    const request = await prisma.approvalRequest.findFirstOrThrow({ where: { targetId: other.id, status: 'pending' } });
    assert.equal((await call(base, admin, 'POST', `/approvals/${request.id}/approve`, {})).status, 200);
    assert.equal((await issue(item.id, { assetId: other.id })).status, 409, 'given to a condemned machine');
  });

  it('an item no longer in use cannot be given out', async () => {
    const item = await addItem({ openingStock: 2 });
    assert.equal((await call(base, biomed, 'PUT', `/consumables/${item.id}`, { name: item.name, unit: 'pcs', active: false })).status, 200);
    assert.equal((await issue(item.id, {})).status, 409);
  });
});

describe('Low stock', () => {
  const notices = (itemName: string) => prisma.notification.count({ where: { userId: ids.biomedUser, type: 'stock', message: { contains: itemName } } });

  it('tells the stock keepers once when the item reaches its reorder level, and again after a restock', async () => {
    const item = await addItem({ openingStock: 6, reorderLevel: 3 });
    await issue(item.id, { quantity: 2 });
    assert.equal(await notices(item.name), 0, 'told while still above the level');
    await issue(item.id, { quantity: 1 });
    assert.equal(await notices(item.name), 1);
    await issue(item.id, { quantity: 1 });
    assert.equal(await notices(item.name), 1, 'told again while already low');
    const low = (await (await call(base, biomed, 'GET', '/consumables?low=true')).json()) as ConsumableRow[];
    assert.ok(low.some((r) => r.id === item.id && r.low));

    await call(base, biomed, 'POST', `/consumables/${item.id}/in`, { quantity: 10, date: today });
    await issue(item.id, { quantity: 9 });
    assert.equal(await notices(item.name), 2);
  });
});

describe('Stock count corrections', () => {
  it('change the stock with a reason, never below zero', async () => {
    const item = await addItem({ openingStock: 4 });
    assert.equal((await call(base, biomed, 'POST', `/consumables/${item.id}/adjust`, { change: -1 })).status, 400, 'no reason');
    assert.equal((await call(base, biomed, 'POST', `/consumables/${item.id}/adjust`, { change: -5, reason: 'Counted on the shelf' })).status, 409);
    const res = await call(base, biomed, 'POST', `/consumables/${item.id}/adjust`, { change: -1, reason: 'One found broken in the box' });
    assert.equal(res.status, 201);
    assert.equal(await stockOf(item.id), 3);
  });

  it('an item with movements stays in the register; one entered by mistake can be removed', async () => {
    const used = await addItem({ openingStock: 1 });
    assert.equal((await call(base, biomed, 'DELETE', `/consumables/${used.id}`)).status, 409);
    const mistake = await addItem();
    assert.equal((await call(base, biomed, 'DELETE', `/consumables/${mistake.id}`)).status, 204);
  });
});

describe('The consumables register', () => {
  it('lists what was given out with its value, what was received, and the stock today', async () => {
    const item = await addItem({ openingStock: 5, unitCost: 200, reorderLevel: 2 });
    await issue(item.id, { quantity: 3, reason: `${PREFIX}spare for ICU` });
    const report = (await (await call(base, admin, 'GET', `/reports/consumables?format=json&from=${addDaysISO(today, -7)}&to=${today}`)).json()) as ReportData;
    const sheet = (name: string) => report.sheets.find((s) => s.name === name)!.rows;
    const given = sheet('Given out').find((r) => r.reason === `${PREFIX}spare for ICU`);
    assert.ok(given, 'not in the register');
    assert.deepEqual([given.item, given.qty, given.value], [item.name, 3, 600]);
    const stock = sheet('Stock today').find((r) => r.item === item.name);
    assert.deepEqual([stock?.stock, stock?.state, stock?.value], [2, 'Low', 400]);
    assert.ok(report.sheets.some((s) => s.name === 'Received'));
    const xlsx = await fetch(`${base}/reports/consumables?format=xlsx`, { headers: { cookie: admin } });
    assert.equal(xlsx.status, 200);
  });
});
