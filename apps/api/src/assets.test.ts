// Integration tests for the Phase 2 rules. Needs a migrated + seeded database (npm run db:seed -w apps/api).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

// Uploads in tests go to a throwaway folder, never ./uploads.
const uploadDir = path.join(os.tmpdir(), `bme-test-${process.pid}`);
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_PATH = uploadDir;

const PREFIX = 'TEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nursing = '';
const ids: Record<string, string> = {};

// Smallest valid PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  ({ server, base } = startServer());
  [admin, biomed, nursing] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  const [icu, rad, icu1, xr1, vent] = await Promise.all([
    prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } }),
    prisma.department.findUniqueOrThrow({ where: { code: 'RAD' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'XR1' } }),
    prisma.equipmentType.findUniqueOrThrow({ where: { code: 'VENT' } }),
  ]);
  Object.assign(ids, { icu: icu.id, rad: rad.id, icu1: icu1.id, xr1: xr1.id, vent: vent.id });
});

after(async () => {
  const test = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = test.map((a) => a.id);
  await prisma.attachment.deleteMany({ where: { ownerType: 'asset', ownerId: { in: assetIds } } });
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: assetIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.serviceContract.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  await rm(uploadDir, { recursive: true, force: true });
  server.close();
  await prisma.$disconnect();
});

const newAsset = (n: string | number, extra: object = {}) => ({
  equipmentTypeId: ids.vent,
  name: `${PREFIX}${n}`,
  departmentId: ids.icu,
  locationId: ids.icu1,
  ...extra,
});

describe('asset ID generation', () => {
  it('20 parallel creates give 20 unique IDs from one increasing sequence', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => call(base, biomed, 'POST', '/assets', newAsset(`par-${i}`))));
    assert.ok(responses.every((r) => r.status === 201), 'every create should succeed');
    const assets = await Promise.all(responses.map((r) => r.json()));

    const codes = new Set(assets.map((a) => a.assetCode));
    assert.equal(codes.size, 20);
    assert.ok(assets.every((a) => /^SHL-ICU-VENT-ICU1-\d{3,}$/.test(a.assetCode)), assets[0].assetCode);

    const rows = await prisma.asset.findMany({ where: { id: { in: assets.map((a) => a.id) } }, select: { sequenceNo: true } });
    const seqs = rows.map((r) => r.sequenceNo).sort((a, b) => a - b);
    assert.equal(new Set(seqs).size, 20);
    assert.equal(seqs[19] - seqs[0], 19, 'sequence numbers are consecutive, none skipped or reused');
  });

  it('locks the pattern once an asset exists', async () => {
    assert.equal((await prisma.hospitalSettings.findFirstOrThrow()).patternLocked, true);
  });

  it('rejects a location from another department', async () => {
    const res = await call(base, biomed, 'POST', '/assets', newAsset('bad-loc', { locationId: ids.xr1 }));
    assert.equal(res.status, 400);
  });

  it('nursing cannot create assets', async () => {
    assert.equal((await call(base, nursing, 'POST', '/assets', newAsset('nurse'))).status, 403);
  });
});

describe('calculated fields', () => {
  it('works out age and warranty from the installation date', async () => {
    const res = await call(base, biomed, 'POST', '/assets', newAsset('calc', { installationDate: '2020-01-15', warrantyMonths: 12 }));
    const a = await res.json();
    assert.equal(a.warrantyEnd, '2021-01-15');
    assert.equal(a.warrantyStatus, 'expired');
    assert.ok(a.ageMonths >= 60);
  });
});

describe('department scope', () => {
  it('nursing lists only its own department, even when asking for another', async () => {
    const res = await call(base, nursing, 'GET', `/assets?departmentId=${ids.rad}&status=all&pageSize=100`);
    const body = await res.json();
    assert.ok(body.total > 0);
    assert.ok(body.items.every((a: { departmentId: string }) => a.departmentId === ids.icu));
  });

  it('another department’s asset looks like it does not exist', async () => {
    const other = await prisma.asset.findFirstOrThrow({ where: { departmentId: ids.rad } });
    assert.equal((await call(base, nursing, 'GET', `/assets/${other.id}`)).status, 404);
    assert.equal((await call(base, nursing, 'GET', `/assets/${other.id}/timeline`)).status, 404);
    assert.equal((await call(base, biomed, 'GET', `/assets/${other.id}`)).status, 200);
  });
});

describe('active list', () => {
  it('not-in-use assets leave the default list but stay findable', async () => {
    const a = await (await call(base, biomed, 'POST', '/assets', newAsset('idle'))).json();
    const patched = await call(base, biomed, 'PATCH', `/assets/${a.id}`, { status: 'not_in_use' });
    assert.equal(patched.status, 200);

    const search = `search=${a.assetCode}`;
    assert.equal((await (await call(base, biomed, 'GET', `/assets?${search}`)).json()).total, 0);
    assert.equal((await (await call(base, biomed, 'GET', `/assets?${search}&status=all`)).json()).total, 1);
  });
});

describe('key-field edits need HOD approval', () => {
  it('biomed’s serial-number change becomes a request; the asset is untouched', async () => {
    const a = await (await call(base, biomed, 'POST', '/assets', newAsset('key', { serialNo: `${PREFIX}SN-OLD` }))).json();
    const res = await call(base, biomed, 'PATCH', `/assets/${a.id}`, { serialNo: `${PREFIX}SN-NEW`, name: `${PREFIX}key-renamed` });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.pendingApproval, true);
    assert.equal(body.asset.serialNo, `${PREFIX}SN-OLD`, 'key field not applied');
    assert.equal(body.asset.name, `${PREFIX}key-renamed`, 'non-key field applied');

    const request = await prisma.approvalRequest.findFirstOrThrow({ where: { targetId: a.id, status: 'pending' } });
    assert.equal(request.type, 'edit_key_field');
    assert.deepEqual((request.payload as { changes: object }).changes, { serialNo: `${PREFIX}SN-NEW` });
  });

  it('the admin can change it directly', async () => {
    const a = await (await call(base, biomed, 'POST', '/assets', newAsset('key2', { serialNo: `${PREFIX}SN-A` }))).json();
    const body = await (await call(base, admin, 'PATCH', `/assets/${a.id}`, { serialNo: `${PREFIX}SN-B` })).json();
    assert.equal(body.pendingApproval, false);
    assert.equal(body.asset.serialNo, `${PREFIX}SN-B`);
  });

  it('the asset ID never changes when the location does', async () => {
    const a = await (await call(base, admin, 'POST', '/assets', newAsset('stable'))).json();
    const body = await (await call(base, admin, 'PATCH', `/assets/${a.id}`, { departmentId: ids.rad, locationId: ids.xr1 })).json();
    assert.equal(body.asset.departmentId, ids.rad);
    assert.equal(body.asset.assetCode, a.assetCode);
  });
});

describe('attachments', () => {
  const form = (bytes: Buffer, name: string, kind = 'photo') => {
    const f = new FormData();
    f.set('kind', kind);
    f.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name);
    return f;
  };
  const upload = (cookie: string, assetId: string, body: FormData) =>
    fetch(`${base}/assets/${assetId}/attachments`, { method: 'POST', headers: { cookie }, body });

  it('stores a PNG privately and serves it back; refuses other types', async () => {
    const a = await (await call(base, biomed, 'POST', '/assets', newAsset('files'))).json();

    const ok = await upload(biomed, a.id, form(PNG, 'front.png'));
    assert.equal(ok.status, 201);
    const file = await ok.json();
    assert.equal(file.mime, 'image/png');

    const download = await fetch(`${base}/attachments/${file.id}/download`, { headers: { cookie: nursing } });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG);

    // Renaming a text file to .png does not fool the byte check.
    const fake = await upload(biomed, a.id, form(Buffer.from('just text'), 'notes.png'));
    assert.equal(fake.status, 415);
  });

  it('refuses files over 10 MB', async () => {
    const a = await (await call(base, biomed, 'POST', '/assets', newAsset('big'))).json();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 10)]);
    assert.equal((await upload(biomed, a.id, form(big, 'big.pdf', 'manual'))).status, 413);
  });

  it('nursing cannot download another department’s file', async () => {
    const other = await prisma.asset.findFirstOrThrow({ where: { departmentId: ids.rad } });
    const file = await prisma.attachment.create({
      data: { ownerType: 'asset', ownerId: other.id, kind: 'photo', fileName: 'x.png', filePath: 'assets/none/x.png', mime: 'image/png', size: 1 },
    });
    try {
      assert.equal((await fetch(`${base}/attachments/${file.id}/download`, { headers: { cookie: nursing } })).status, 404);
    } finally {
      await prisma.attachment.delete({ where: { id: file.id } });
    }
  });
});

describe('purchase orders, contracts and timeline', () => {
  it('records them and shows them on the timeline, newest first', async () => {
    const a = await (await call(base, biomed, 'POST', '/assets', newAsset('life', { installationDate: '2024-03-01', warrantyMonths: 24 }))).json();
    const po = await call(base, biomed, 'POST', `/assets/${a.id}/purchase-orders`, { poNumber: 'PO-1', poDate: '2024-01-10', vendor: 'Drager', cost: 1250000 });
    assert.equal(po.status, 201);
    const contract = await call(base, biomed, 'POST', `/assets/${a.id}/contracts`, { type: 'amc', vendor: 'Drager', startDate: '2026-03-01', endDate: '2027-02-28' });
    assert.equal(contract.status, 201);
    const bad = await call(base, biomed, 'POST', `/assets/${a.id}/contracts`, { type: 'amc', vendor: 'X', startDate: '2026-03-01', endDate: '2026-01-01' });
    assert.equal(bad.status, 400);

    const events: { date: string; kind: string }[] = await (await call(base, biomed, 'GET', `/assets/${a.id}/timeline`)).json();
    const kinds = events.map((e) => e.kind);
    for (const k of ['registered', 'purchase_order', 'installation', 'warranty', 'contract']) assert.ok(kinds.includes(k), `timeline has ${k}`);
    const dates = events.map((e) => e.date);
    assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
  });
});

describe('Excel import', () => {
  const HEADERS = ['Equipment type code', 'Name', 'Make', 'Model', 'Serial no', 'Department code', 'Location code', 'Criticality', 'Installation date', 'Warranty months', 'PMS frequency months'];

  async function workbook(rows: (string | number | undefined)[][]) {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Assets');
    sheet.addRow(HEADERS);
    rows.forEach((r) => sheet.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  const send = (cookie: string, file: Buffer, query = '') => {
    const f = new FormData();
    f.set('file', new Blob([new Uint8Array(file)]), 'import.xlsx');
    return fetch(`${base}/import/assets${query}`, { method: 'POST', headers: { cookie }, body: f });
  };

  const good = (i: number) => ['VENT', `${PREFIX}imp-${i}`, 'Drager', 'V300', `${PREFIX}IMP-SN-${i}`, 'ICU', 'ICU1', 'high', '2025-01-15', 24, 3];

  it('50 rows with 3 bad ones inserts nothing and reports exactly those 3', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => good(i + 1));
    rows[6][0] = 'NOPE'; // row 8: unknown type
    rows[19][8] = '31-02-2025'; // row 21: not a real date
    rows[33][4] = rows[32][4]; // row 35: serial repeated from row 34
    const before = await prisma.asset.count();

    const res = await send(admin, await workbook(rows));
    const body = await res.json();
    assert.equal(res.status, 422);
    assert.equal(body.ok, false);
    assert.deepEqual(body.errors.map((e: { row: number }) => e.row), [8, 21, 35]);
    assert.equal(await prisma.asset.count(), before, 'nothing inserted');
  });

  it('a clean file can be checked first (dry run), then imported with consecutive IDs', async () => {
    const file = await workbook(Array.from({ length: 5 }, (_, i) => good(100 + i)));
    const before = await prisma.asset.count();

    const dry = await (await send(admin, file, '?dryRun=true')).json();
    assert.equal(dry.ok, true);
    assert.equal(await prisma.asset.count(), before, 'dry run inserts nothing');

    const res = await send(admin, file);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.created, 5);
    const rows = await prisma.asset.findMany({ where: { name: { startsWith: `${PREFIX}imp-10` } }, orderBy: { sequenceNo: 'asc' } });
    assert.equal(rows.length, 5);
    assert.equal(rows[4].sequenceNo - rows[0].sequenceNo, 4);
    assert.equal(rows[0].warrantyEnd?.toISOString().slice(0, 10), '2027-01-15');

    // Importing the same file again is refused: the serial numbers now exist.
    const again = await send(admin, file);
    assert.equal(again.status, 422);
  });

  it('serves a template with the expected columns; nursing is refused', async () => {
    const res = await fetch(`${base}/import/template`, { headers: { cookie: admin } });
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const header = wb.getWorksheet('Assets')!.getRow(1).values as unknown[];
    assert.deepEqual(Array.from(header).slice(1), HEADERS);
    assert.equal((await fetch(`${base}/import/template`, { headers: { cookie: nursing } })).status, 403);
  });
});
