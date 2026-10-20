// Step 5 of docs/requirements-2026-10-20.md: the suppliers directory (companies with the people to call) and the
// supplier / service vendor on each machine, from the form and the Excel import. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import type { AssetDetail, ImportResult, VendorRow } from '@bme/shared';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

const PREFIX = 'VNDTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nurse = '';
const ids = { vent: '', icu: '', icu1: '' };

async function cleanUp() {
  const assets = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  await prisma.asset.deleteMany({ where: { id: { in: assets } } });
  await prisma.vendor.deleteMany({ where: { name: { startsWith: PREFIX, mode: 'insensitive' } } });
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

const addVendor = async (name: string, extra: object = {}) => {
  const res = await call(base, biomed, 'POST', '/vendors', { name, ...extra });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as VendorRow;
};
let n = 0;
const makeAsset = (extra: object = {}) =>
  call(base, biomed, 'POST', '/assets', { equipmentTypeId: ids.vent, name: `${PREFIX}${++n}`, departmentId: ids.icu, locationId: ids.icu1, ...extra });

describe('The suppliers list', () => {
  it('keeps a company with its contacts; an edit replaces the contacts; every change is audited', async () => {
    const v = await addVendor(`${PREFIX}Philips`, {
      phone: '1800 102 2929',
      email: 'service@philips.example',
      contacts: [{ name: 'A. Shah', role: 'Service engineer', phone: '98250 00000' }, { name: 'B. Patel', role: 'Sales' }],
    });
    assert.deepEqual(v.contacts.map((c) => c.name), ['A. Shah', 'B. Patel']);
    const edited = await call(base, biomed, 'PUT', `/vendors/${v.id}`, { name: `${PREFIX}Philips Healthcare`, contacts: [{ name: 'C. Mehta', email: 'c.mehta@philips.example' }] });
    assert.equal(edited.status, 200, await edited.clone().text());
    const row = (await edited.json()) as VendorRow;
    assert.equal(row.name, `${PREFIX}Philips Healthcare`);
    assert.deepEqual(row.contacts.map((c) => c.name), ['C. Mehta']);
    assert.equal(row.phone, null, 'a field left out of the edit was kept');
    assert.equal(await prisma.vendorContact.count({ where: { vendorId: v.id } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { entityId: v.id, action: { in: ['vendor.create', 'vendor.update'] } } }), 2);
  });

  it('refuses the same name twice, whatever the capitals', async () => {
    await addVendor(`${PREFIX}Mindray`);
    const again = await call(base, biomed, 'POST', '/vendors', { name: `${PREFIX}MINDRAY ` });
    assert.equal(again.status, 409);
    const other = await addVendor(`${PREFIX}GE`);
    assert.equal((await call(base, biomed, 'PUT', `/vendors/${other.id}`, { name: `${PREFIX}mindray` })).status, 409);
  });

  it('is for people who register or edit equipment, not nursing', async () => {
    assert.equal((await call(base, nurse, 'GET', '/vendors')).status, 403);
    assert.equal((await call(base, nurse, 'POST', '/vendors', { name: `${PREFIX}Nurse co` })).status, 403);
    assert.equal((await call(base, admin, 'GET', '/vendors')).status, 200);
  });

  it('finds a company by a contact name', async () => {
    await addVendor(`${PREFIX}Drager`, { contacts: [{ name: 'Zubin Kapadia' }] });
    const found = (await (await call(base, biomed, 'GET', '/vendors?search=zubin')).json()) as VendorRow[];
    assert.deepEqual(found.map((v) => v.name), [`${PREFIX}Drager`]);
  });
});

describe('Supplier and service vendor on equipment', () => {
  it('are set when adding and editing a machine, shown with contacts, and cleared with null', async () => {
    const sup = await addVendor(`${PREFIX}Supplier one`, { contacts: [{ name: 'D. Joshi', phone: '99999 11111' }] });
    const svc = await addVendor(`${PREFIX}Service one`);
    const res = await makeAsset({ supplierId: sup.id });
    assert.equal(res.status, 201, await res.clone().text());
    const a = (await res.json()) as AssetDetail;
    assert.equal(a.supplier?.name, `${PREFIX}Supplier one`);
    assert.equal(a.supplier?.contacts[0].phone, '99999 11111');
    assert.equal(a.serviceVendor, null);

    const patched = await call(base, biomed, 'PATCH', `/assets/${a.id}`, { serviceVendorId: svc.id });
    assert.equal(patched.status, 200, await patched.clone().text());
    const nurseView = (await (await call(base, nurse, 'GET', `/assets/${a.id}`)).json()) as AssetDetail;
    assert.equal(nurseView.serviceVendor?.name, `${PREFIX}Service one`, 'nursing does not see who to call');

    await call(base, biomed, 'PATCH', `/assets/${a.id}`, { supplierId: null });
    assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).supplierId, null);
  });

  it('refuses a company that is not in the list', async () => {
    const res = await makeAsset({ supplierId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /suppliers list/);
  });

  it('a company used by equipment stays in the list; an unused one can be removed', async () => {
    const used = await addVendor(`${PREFIX}Used`);
    await makeAsset({ serviceVendorId: used.id });
    assert.equal((await call(base, biomed, 'DELETE', `/vendors/${used.id}`)).status, 409);
    const row = (await (await call(base, biomed, 'GET', `/vendors/${used.id}`)).json()) as VendorRow;
    assert.deepEqual([row.suppliedCount, row.servicedCount], [0, 1]);
    const unused = await addVendor(`${PREFIX}Unused`);
    assert.equal((await call(base, biomed, 'DELETE', `/vendors/${unused.id}`)).status, 204);
    assert.equal(await prisma.vendor.count({ where: { id: unused.id } }), 0);
  });
});

describe('Suppliers in the Excel import', () => {
  const send = async (rows: string[][]) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Assets');
    ws.addRow(['Equipment type code', 'Name', 'Department code', 'Location code', 'Supplier', 'Service vendor']);
    rows.forEach((r) => ws.addRow(r));
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(Buffer.from(await wb.xlsx.writeBuffer()))]), 'assets.xlsx');
    return fetch(`${base}/import/assets`, { method: 'POST', headers: { cookie: biomed }, body: form });
  };

  it('matches company names whatever the capitals, and names an unknown one', async () => {
    await addVendor(`${PREFIX}Import co`);
    const bad = await send([['VENT', `${PREFIX}imp-1`, 'ICU', 'ICU1', `${PREFIX}No such co`, '']]);
    assert.equal(bad.status, 422);
    const result = (await bad.json()) as ImportResult;
    assert.equal(result.errors[0].field, 'Supplier');
    assert.match(result.errors[0].message, /Add it under Suppliers first/);

    const ok = await send([['VENT', `${PREFIX}imp-2`, 'ICU', 'ICU1', `${PREFIX}IMPORT CO`, `${PREFIX}import co`]]);
    assert.equal(ok.status, 200, await ok.clone().text());
    const asset = await prisma.asset.findFirstOrThrow({ where: { name: `${PREFIX}imp-2` }, include: { supplier: true, serviceVendor: true } });
    assert.equal(asset.supplier?.name, `${PREFIX}Import co`);
    assert.equal(asset.serviceVendor?.name, `${PREFIX}Import co`);
  });

  it('the template lists the suppliers', async () => {
    const res = await fetch(`${base}/import/template`, { headers: { cookie: biomed } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await res.arrayBuffer()) as ArrayBuffer);
    const header = (wb.getWorksheet('Assets')!.getRow(1).values as unknown[]).map(String);
    assert.ok(header.includes('Supplier') && header.includes('Service vendor'));
    const lists = wb.getWorksheet('Lists')!;
    const names = (lists.getColumn('I').values as unknown[]).map(String);
    assert.ok(names.includes(`${PREFIX}Import co`), 'supplier not in the template list');
  });
});
