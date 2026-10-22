// Gap review, batch 4b: the Excel import brings the rest of the old register (tag no, status, calibration interval,
// purchase order, a contract) and loads users; three management reports (engineers, suppliers, replacement).
// Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import type { AssetDetail, AssetRow, CalibrationRow, ImportResult, Paged, ReportData } from '@bme/shared';
import { addMonths, isoDate, parseDate, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

const PREFIX = 'REGTEST-';
const EMAIL = 'regtest-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
const ids = { vendor: '' };

async function cleanUp() {
  const assetIds = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const complaints = (await prisma.complaint.findMany({ where: { assetId: { in: assetIds } }, select: { id: true } })).map((c) => c.id);
  await prisma.notification.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.complaintStep.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.complaint.deleteMany({ where: { id: { in: complaints } } });
  await prisma.calibrationRecord.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.serviceContract.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  await prisma.vendor.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL } } });
}

before(async () => {
  await cleanUp();
  ({ server, base } = startServer());
  [admin, biomed] = await Promise.all(['admin', 'biomed'].map((r) => login(base, `${r}@demo.local`)));
  const v = await call(base, admin, 'POST', '/vendors', { name: `${PREFIX}Medi Supplies`, contacts: [] });
  assert.equal(v.status, 201, await v.clone().text());
  ids.vendor = ((await v.json()) as { id: string }).id;
});
after(async () => {
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

async function workbook(sheetName: string, headers: string[], rows: (string | number | undefined)[][]) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(sheetName);
  sheet.addRow(headers);
  rows.forEach((r) => sheet.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const send = (path: string, file: Buffer, query = '') => {
  const f = new FormData();
  f.set('file', new Blob([new Uint8Array(file)]), 'import.xlsx');
  return fetch(`${base}${path}${query}`, { method: 'POST', headers: { cookie: admin }, body: f });
};

describe('Asset import: the rest of the old register', () => {
  const HEADERS = ['Equipment type code', 'Name', 'Department code', 'Location code', 'Installation date', 'Supplier', 'Tag no', 'Status', 'Calibration every (months)', 'PO number', 'PO date', 'Purchase cost', 'Contract type', 'Contract vendor', 'Contract start', 'Contract end', 'Contract cost'];
  const installed = isoDate(addMonths(parseDate(todayISO()), -2));

  it('refuses a half-filled purchase order or contract, and saves nothing', async () => {
    const file = await workbook('Assets', HEADERS, [
      ['VENT', `${PREFIX}no-supplier`, 'ICU', 'ICU1', installed, '', '', '', '', 'PO/1', installed, '1,00,000'],
      ['VENT', `${PREFIX}bad-contract`, 'ICU', 'ICU1', installed, '', '', '', '', '', '', '', 'AMC', 'Cool Service', '2026-10-01', '2026-01-01'],
      ['VENT', `${PREFIX}bad-status`, 'ICU', 'ICU1', installed, '', '', 'Broken'],
    ]);
    const res = await send('/import/assets', file);
    assert.equal(res.status, 422);
    const fields = ((await res.json()) as ImportResult).errors.map((e) => `${e.row}:${e.field}`);
    assert.ok(fields.includes('2:Supplier'), fields.join(','));
    assert.ok(fields.includes('3:Contract end') && fields.includes('4:Status'), fields.join(','));
    assert.equal(await prisma.asset.count({ where: { name: { startsWith: PREFIX } } }), 0);
  });

  it('creates the assets with tag no, status and calibration interval, and their PO and contract', async () => {
    const file = await workbook('Assets', HEADERS, [
      ['VENT', `${PREFIX}old-vent`, 'ICU', 'ICU1', installed, `${PREFIX}medi supplies`, 'BME/ICU/0412', 'Not in use', 6, 'PO/26/9', installed, '₹ 8,50,000', 'AMC', 'Cool Service', installed, isoDate(addMonths(parseDate(installed), 12)), 25000],
      ['VENT', `${PREFIX}plain-vent`, 'ICU', 'ICU1', installed],
    ]);
    const res = await send('/import/assets', file);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(((await res.json()) as ImportResult).created, 2);
    const a = await prisma.asset.findFirstOrThrow({ where: { name: `${PREFIX}old-vent` } });
    assert.deepEqual([a.tagNo, a.status, a.calibrationFrequencyMonths], ['BME/ICU/0412', 'not_in_use', 6]);
    assert.equal(isoDate(a.nextCalibrationDue!), isoDate(addMonths(parseDate(installed), 6)), 'the machine’s own interval was not used');
    const [po] = await prisma.purchaseOrder.findMany({ where: { assetId: a.id } });
    assert.deepEqual([po.poNumber, po.vendor, Number(po.cost)], ['PO/26/9', `${PREFIX}Medi Supplies`, 850000]);
    const [k] = await prisma.serviceContract.findMany({ where: { assetId: a.id } });
    assert.deepEqual([k.type, k.vendor, Number(k.cost)], ['amc', 'Cool Service', 25000]);
    const plain = await prisma.asset.findFirstOrThrow({ where: { name: `${PREFIX}plain-vent` } });
    assert.equal(plain.status, 'active');
    assert.equal(await prisma.purchaseOrder.count({ where: { assetId: plain.id } }), 0);

    // The tag no is searchable, and the machine's interval sets the next calibration.
    const found = ((await (await call(base, biomed, 'GET', '/assets?search=ICU/0412&status=all')).json()) as Paged<AssetRow>).items;
    assert.deepEqual(found.map((x) => x.id), [a.id]);
    await prisma.asset.update({ where: { id: a.id }, data: { status: 'active' } });
    const cal = (await (await call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: todayISO(), agency: 'Cal Lab', result: 'pass' })).json()) as CalibrationRow;
    assert.equal(cal.dueOn, isoDate(addMonths(parseDate(todayISO()), 6)));
    const detail = (await (await call(base, biomed, 'GET', `/assets/${a.id}`)).json()) as AssetDetail;
    assert.equal(detail.calibrationFrequencyMonths, 6);
  });
});

describe('User import', () => {
  const HEADERS = ['Name', 'Email', 'Username', 'Role', 'Department code', 'First password'];

  it('checks every row, then creates the logins together, each to change the first password', async () => {
    assert.equal((await call(base, admin, 'GET', '/users/import/template')).status, 200);
    const bad = await workbook('Users', HEADERS, [
      [`${PREFIX}Sister`, `${EMAIL}sister@demo.local`, 'reg.sister', 'Nursing staff', '', 'First@1234'],
      [`${PREFIX}Boss`, `${EMAIL}boss@demo.local`, '', 'Super admin', '', 'First@1234'],
      [`${PREFIX}Copy`, 'admin@demo.local', '', 'Biomedical staff', '', 'First@1234'],
    ]);
    const res = await send('/users/import', bad);
    assert.equal(res.status, 422);
    const fields = ((await res.json()) as ImportResult).errors.map((e) => `${e.row}:${e.field}`);
    assert.ok(fields.includes('2:Department code') && fields.includes('3:Role') && fields.includes('4:Email'), fields.join(','));

    const good = await workbook('Users', HEADERS, [
      [`${PREFIX}Sister`, `${EMAIL}sister@demo.local`, 'Reg.Sister', 'Nursing staff', 'icu', 'First@1234'],
      [`${PREFIX}Tech`, `${EMAIL}tech@demo.local`, '', 'biomed', '', 'First@5678'],
    ]);
    assert.equal(((await (await send('/users/import', good, '?dryRun=true')).json()) as ImportResult).ok, true);
    assert.equal(await prisma.user.count({ where: { email: { startsWith: EMAIL } } }), 0, 'a dry run saved users');
    const done = await send('/users/import', good);
    assert.equal(done.status, 200, await done.clone().text());
    const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL } }, include: { role: true, department: true }, orderBy: { email: 'asc' } });
    assert.deepEqual(users.map((u) => [u.username, u.role.name, u.department?.code ?? null, u.mustChangePassword]), [['reg.sister', 'nursing', 'ICU', true], [null, 'biomed', null, true]]);
    // Imported again: every row is now taken.
    assert.equal((await send('/users/import', good)).status, 422);
  });
});

describe('Management reports', () => {
  const report = async (type: string, query = '') => (await (await call(base, admin, 'GET', `/reports/${type}?format=json${query}`)).json()) as ReportData;

  it('engineer performance counts what each engineer started and fixed', async () => {
    const type = (await prisma.equipmentType.findFirstOrThrow({ where: { code: 'VENT' } })).id;
    const icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
    const icu1 = (await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })).id;
    const a = (await (await call(base, admin, 'POST', '/assets', { equipmentTypeId: type, name: `${PREFIX}report vent`, departmentId: icu, locationId: icu1, serviceVendorId: ids.vendor })).json()) as AssetDetail;
    const nurse = await login(base, 'nursing@demo.local');
    const c = (await (await call(base, nurse, 'POST', '/complaints', { assetId: a.id, description: `${PREFIX}screen blank` })).json()) as { id: string };
    await call(base, biomed, 'POST', `/complaints/${c.id}/start`, {});
    await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Reseated the cable' });
    await call(base, nurse, 'POST', `/complaints/${c.id}/reopen`, { note: 'Blank again' });

    const engineers = await report('engineers');
    const name = (await prisma.user.findUniqueOrThrow({ where: { email: 'biomed@demo.local' } })).name;
    const me = engineers.sheets[0].rows.find((r) => r.name === name);
    assert.ok(me, JSON.stringify(engineers.sheets[0].rows.map((r) => r.name)));
    assert.ok(Number(me.started) >= 1 && Number(me.sentBack) >= 1, JSON.stringify(me));

    const suppliers = await report('suppliers');
    const ours = suppliers.sheets[0].rows.find((r) => r.name === `${PREFIX}Medi Supplies`);
    assert.ok(ours && Number(ours.looked) >= 1 && Number(ours.breakdowns) >= 1, JSON.stringify(ours));
  });

  it('replacement and renewals lists old equipment and cover ending soon, and exports', async () => {
    const type = (await prisma.equipmentType.findFirstOrThrow({ where: { code: 'VENT' } })).id;
    const icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
    const icu1 = (await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })).id;
    const old = (await (await call(base, admin, 'POST', '/assets', { equipmentTypeId: type, name: `${PREFIX}old monitor`, departmentId: icu, locationId: icu1, installationDate: isoDate(addMonths(parseDate(todayISO()), -12 * 11)) })).json()) as AssetDetail;
    await call(base, admin, 'POST', `/assets/${old.id}/contracts`, { type: 'cmc', vendor: 'Ending Soon Ltd', startDate: isoDate(addMonths(parseDate(todayISO()), -11)), endDate: isoDate(addMonths(parseDate(todayISO()), 1)) });
    const r = await report('replacement');
    const [replace, cover] = r.sheets;
    assert.ok(replace.rows.some((x) => x.code === old.assetCode && /11 years old/.test(String(x.why))), JSON.stringify(replace.rows.slice(0, 3)));
    assert.ok(cover.rows.some((x) => x.code === old.assetCode && x.vendor === 'Ending Soon Ltd'));
    for (const format of ['xlsx', 'pdf']) assert.equal((await call(base, admin, 'GET', `/reports/replacement?format=${format}`)).status, 200);
  });
});
