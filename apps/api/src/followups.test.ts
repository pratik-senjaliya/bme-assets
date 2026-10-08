// Integration tests for the follow-ups from the meeting review: opening (last done) dates for existing equipment,
// the service log, documents on records with the department scope, complaint history and filters, the critical
// downtime limit, and the per-equipment Excel history. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { addMonths, addDaysISO, isoDate, parseDate, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

const PREFIX = 'FTEST-';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_PATH = path.join(os.tmpdir(), `bme-ftest-${process.pid}`);

let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nursing = '';
const ids = { icu: '', icu1: '', bme: '', wksp: '', type: '' };

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  ({ server, base } = startServer());
  [admin, biomed, nursing] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  const [icu, icu1, bme, wksp, type] = await Promise.all([
    prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } }),
    prisma.department.findUniqueOrThrow({ where: { code: 'BME' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'WKSP' } }),
    prisma.equipmentType.findFirstOrThrow({ where: { code: 'VENT' } }),
  ]);
  Object.assign(ids, { icu: icu.id, icu1: icu1.id, bme: bme.id, wksp: wksp.id, type: type.id });
});

after(async () => {
  const assets = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  const complaints = await prisma.complaint.findMany({ where: { assetId: { in: assetIds } }, select: { id: true } });
  const logs = await prisma.serviceLog.findMany({ where: { assetId: { in: assetIds } }, select: { id: true } });
  const owners = [...assetIds, ...complaints.map((c) => c.id), ...logs.map((l) => l.id)];
  await prisma.attachment.deleteMany({ where: { ownerId: { in: owners } } });
  await prisma.serviceExpense.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.complaint.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.serviceLog.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.$transaction([
    prisma.$queryRaw`select set_config('bme.allow_pms_cleanup', 'on', true)`,
    prisma.pmsRecord.deleteMany({ where: { assetId: { in: assetIds } } }),
  ]);
  await prisma.notification.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  await prisma.hospitalSettings.updateMany({ data: { criticalDowntimeHours: 24 } });
  await rm(process.env.STORAGE_PATH!, { recursive: true, force: true });
  server.close();
  await prisma.$disconnect();
});

let n = 0;
type Made = { id: string; assetCode: string; nextPmsDue: string | null; nextCalibrationDue: string | null; openingPmsOn: string | null };
const makeAsset = async (extra: object = {}, dept: 'icu' | 'bme' = 'icu') =>
  (await (await call(base, biomed, 'POST', '/assets', {
    equipmentTypeId: ids.type, name: `${PREFIX}${++n}`, departmentId: dept === 'icu' ? ids.icu : ids.bme, locationId: dept === 'icu' ? ids.icu1 : ids.wksp, pmsFrequencyMonths: 6, ...extra,
  })).json()) as Made;
const raise = (cookie: string, assetId: string, description = 'Alarm keeps sounding') => call(base, cookie, 'POST', '/complaints', { assetId, description });
const upload = (cookie: string, fields: Record<string, string>, file = PNG, name = 'photo.png') => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('file', new Blob([file], { type: 'image/png' }), name);
  return fetch(`${base}/attachments`, { method: 'POST', headers: { cookie }, body: form });
};

describe('Opening dates for existing equipment', () => {
  it('runs the first due dates from the last PMS and calibration done before this system', async () => {
    const a = await makeAsset({ installationDate: '2019-03-01', openingPmsOn: '2026-08-01', openingCalibrationOn: '2026-05-10' });
    assert.equal(a.nextPmsDue, '2027-02-01'); // 1 Aug 2026 + 6 months, not 2019 + 6 months
    assert.equal(a.openingPmsOn, '2026-08-01');
    assert.ok(a.nextCalibrationDue && a.nextCalibrationDue > todayISO(), 'calibration is due in the future, not years overdue');
    const plain = await makeAsset({ installationDate: '2019-03-01' });
    assert.equal(plain.nextPmsDue, isoDate(addMonths(parseDate('2019-03-01'), 6)), 'without it the old behaviour is unchanged');
  });

  it('rejects a future date and one before installation, with a field error', async () => {
    for (const extra of [{ openingPmsOn: addDaysISO(todayISO(), 1) }, { installationDate: '2024-01-01', openingPmsOn: '2023-12-31' }, { openingCalibrationOn: addDaysISO(todayISO(), 5) }]) {
      const res = await call(base, biomed, 'POST', '/assets', { equipmentTypeId: ids.type, name: `${PREFIX}bad`, departmentId: ids.icu, locationId: ids.icu1, ...extra });
      assert.equal(res.status, 400);
      assert.ok(Object.keys((await res.json()).error.details.fieldErrors).some((k) => k.startsWith('opening')));
    }
    assert.equal(await prisma.asset.count({ where: { name: `${PREFIX}bad` } }), 0);
  });

  it('can be set on an existing asset only while no PMS has been recorded', async () => {
    const a = await makeAsset({ installationDate: '2020-01-01' });
    const ok = await call(base, biomed, 'PATCH', `/assets/${a.id}`, { openingPmsOn: '2026-09-01' });
    assert.equal(ok.status, 200);
    assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).nextPmsDue?.toISOString().slice(0, 10), '2027-03-01');

    await prisma.pmsRecord.create({
      data: { assetId: a.id, templateId: (await prisma.pmsTemplate.findFirstOrThrow()).id, performedOn: parseDate(todayISO()), performedBy: (await prisma.user.findFirstOrThrow({ where: { email: 'biomed@demo.local' } })).id, answers: {}, result: 'pass' },
    });
    const locked = await call(base, biomed, 'PATCH', `/assets/${a.id}`, { openingPmsOn: '2026-01-01' });
    assert.equal(locked.status, 409);
  });
});

describe('Opening dates in the Excel import', () => {
  const sheet = async (rows: (string | number)[][]) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Assets');
    ws.addRow(['Equipment type code', 'Name', 'Department code', 'Location code', 'Installation date', 'PMS frequency months', 'Last PMS done', 'Last calibration done']);
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const send = (file: Buffer) => {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(file)]), 'assets.xlsx');
    return fetch(`${base}/import/assets`, { method: 'POST', headers: { cookie: biomed }, body: form });
  };

  it('sets the first due dates from the last-done columns, and rejects a bad one without inserting anything', async () => {
    const bad = await send(await sheet([['VENT', `${PREFIX}imp-ok`, 'ICU', 'ICU1', '2019-03-01', 6, '2026-08-01', ''], ['VENT', `${PREFIX}imp-bad`, 'ICU', 'ICU1', '2019-03-01', 6, addDaysISO(todayISO(), 3), '']]));
    assert.equal(bad.status, 422);
    assert.ok(((await bad.json()) as { errors: { row: number; field: string }[] }).errors.some((e) => e.row === 3 && e.field === 'Last PMS done'));
    assert.equal(await prisma.asset.count({ where: { name: { startsWith: `${PREFIX}imp-` } } }), 0, 'all or nothing');

    const ok = await send(await sheet([['VENT', `${PREFIX}imp-ok`, 'ICU', 'ICU1', '2019-03-01', 6, '01/08/2026', '']]));
    assert.equal(ok.status, 200);
    const row = await prisma.asset.findFirstOrThrow({ where: { name: `${PREFIX}imp-ok` } });
    assert.equal(isoDate(row.nextPmsDue!), '2027-02-01');
    assert.equal(isoDate(row.openingPmsOn!), '2026-08-01');
  });
});

describe('Service log', () => {
  it('is entered by biomedical staff, cannot be future dated, and shows on the timeline', async () => {
    const a = await makeAsset();
    const ok = await call(base, biomed, 'POST', `/assets/${a.id}/service-logs`, { serviceDate: '2026-06-15', kind: 'amc_visit', vendor: 'Drager Service', description: 'Quarterly AMC visit, filters changed' });
    assert.equal(ok.status, 201);
    const future = await call(base, biomed, 'POST', `/assets/${a.id}/service-logs`, { serviceDate: addDaysISO(todayISO(), 1), kind: 'repair', description: 'Tomorrow' });
    assert.equal(future.status, 400);
    const list = (await (await call(base, biomed, 'GET', `/assets/${a.id}/service-logs`)).json()) as { serviceDate: string }[];
    assert.equal(list.length, 1);
    const timeline = (await (await call(base, biomed, 'GET', `/assets/${a.id}/timeline`)).json()) as { kind: string; title: string }[];
    assert.ok(timeline.some((e) => e.kind === 'service' && e.title.includes('AMC visit')));
  });

  it('is not writable by nursing, and a foreign department’s log looks missing', async () => {
    const own = await makeAsset();
    const foreign = await makeAsset({}, 'bme');
    assert.equal((await call(base, nursing, 'POST', `/assets/${own.id}/service-logs`, { serviceDate: '2026-06-15', kind: 'repair', description: 'Nurse tries' })).status, 403);
    assert.equal((await call(base, nursing, 'GET', `/assets/${foreign.id}/service-logs`)).status, 404);
  });
});

describe('Documents on records', () => {
  it('lets nursing attach a photo to its own department’s open complaint, and nobody else’s', async () => {
    const own = await makeAsset();
    const foreign = await makeAsset({}, 'bme');
    const mine = await (await raise(nursing, own.id)).json();
    const theirs = await (await raise(biomed, foreign.id)).json();

    const up = await upload(nursing, { ownerType: 'complaint', ownerId: mine.id, kind: 'photo' });
    assert.equal(up.status, 201);
    const file = await up.json();
    assert.equal((await upload(nursing, { ownerType: 'complaint', ownerId: theirs.id, kind: 'photo' })).status, 404, 'foreign complaint looks missing');

    const download = await fetch(`${base}/attachments/${file.id}/download`, { headers: { cookie: nursing } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/png');
    const other = await upload(biomed, { ownerType: 'complaint', ownerId: theirs.id, kind: 'photo' });
    const otherFile = await other.json();
    assert.equal((await fetch(`${base}/attachments/${otherFile.id}/download`, { headers: { cookie: nursing } })).status, 404, 'nursing cannot download another department’s file');
  });

  it('keeps costs and calibration documents away from nursing, and closes a resolved complaint to new files', async () => {
    const a = await makeAsset();
    const c = await (await raise(nursing, a.id)).json();
    assert.equal((await upload(nursing, { ownerType: 'service_expense', ownerId: c.id, kind: 'invoice' })).status, 403);
    assert.equal((await upload(nursing, { ownerType: 'asset', ownerId: a.id, kind: 'manual' })).status, 403);

    await call(base, biomed, 'POST', `/complaints/${c.id}/start`);
    await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Replaced the filter' });
    assert.equal((await upload(biomed, { ownerType: 'complaint', ownerId: c.id, kind: 'photo' })).status, 409);
  });

  it('attaches a service report to a log entry and counts it', async () => {
    const a = await makeAsset();
    const log = await (await call(base, biomed, 'POST', `/assets/${a.id}/service-logs`, { serviceDate: '2026-07-01', kind: 'cmc_visit', description: 'CMC visit' })).json();
    assert.equal((await upload(biomed, { ownerType: 'service_log', ownerId: log.id, kind: 'service_report' })).status, 201);
    const list = (await (await call(base, biomed, 'GET', `/attachments?ownerType=service_log&ownerId=${log.id}`)).json()) as { kind: string }[];
    assert.deepEqual(list.map((f) => f.kind), ['service_report']);
    const logs = (await (await call(base, biomed, 'GET', `/assets/${a.id}/service-logs`)).json()) as { attachmentCount: number }[];
    assert.equal(logs[0].attachmentCount, 1);
  });

  it('rejects a file that is not PDF, JPG or PNG', async () => {
    const a = await makeAsset();
    const res = await upload(biomed, { ownerType: 'asset', ownerId: a.id, kind: 'manual' }, Buffer.from('MZ not a document'), 'virus.pdf');
    assert.equal(res.status, 415);
  });
});

describe('Complaint history', () => {
  it('filters by search text and by raised date, and tells the whole story of one complaint', async () => {
    const a = await makeAsset();
    const c = await (await raise(nursing, a.id, 'Display flickers during use')).json();
    await upload(nursing, { ownerType: 'complaint', ownerId: c.id, kind: 'photo' });
    await call(base, biomed, 'POST', `/complaints/${c.id}/start`);
    await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Cable reseated' });

    const find = async (qs: string) => ((await (await call(base, biomed, 'GET', `/complaints?${qs}`)).json()) as { items: { complaintNo: string }[] }).items.map((i) => i.complaintNo);
    assert.ok((await find(`search=flickers`)).includes(c.complaintNo));
    assert.ok((await find(`search=${a.assetCode}`)).includes(c.complaintNo));
    assert.ok(!(await find(`search=flickers&from=${addDaysISO(todayISO(), 1)}`)).includes(c.complaintNo), 'a later start date excludes it');
    assert.ok((await find(`search=flickers&from=${todayISO()}&to=${todayISO()}&status=resolved`)).includes(c.complaintNo));

    const detail = await (await call(base, biomed, 'GET', `/complaints/${c.id}`)).json();
    assert.deepEqual(detail.events.map((e: { kind: string }) => e.kind), ['raised', 'document', 'started', 'resolved']);
    assert.equal(detail.attachments.length, 1);
    assert.equal(detail.attachmentCount, 1);
  });

  it('shows nursing the story of its own complaints only, without costs', async () => {
    const own = await makeAsset();
    const foreign = await makeAsset({}, 'bme');
    const mine = await (await raise(nursing, own.id)).json();
    const theirs = await (await raise(biomed, foreign.id)).json();
    await call(base, biomed, 'POST', `/assets/${own.id}/expenses`, { type: 'repair', description: 'Sensor', amount: 4500, date: todayISO(), complaintId: mine.id });

    const asBiomed = await (await call(base, biomed, 'GET', `/complaints/${mine.id}`)).json();
    const asNurse = await (await call(base, nursing, 'GET', `/complaints/${mine.id}`)).json();
    assert.equal(asBiomed.expenses.length, 1);
    assert.deepEqual(asNurse.expenses, []);
    assert.ok(!asNurse.events.some((e: { kind: string }) => e.kind === 'expense'));
    assert.equal((await call(base, nursing, 'GET', `/complaints/${theirs.id}`)).status, 404);
  });
});

describe('Critical downtime limit', () => {
  it('flags critical equipment that has been down longer than the hospital’s limit, including a running breakdown', async () => {
    const critical = await makeAsset({ criticality: 'critical' });
    const ordinary = await makeAsset({ criticality: 'medium' });
    const [c1, c2] = await Promise.all([raise(nursing, critical.id), raise(nursing, ordinary.id)].map(async (p) => (await p).json()));
    const longAgo = new Date(Date.now() - 30 * 3600_000);
    await prisma.complaint.updateMany({ where: { id: { in: [c1.id, c2.id] } }, data: { raisedAt: longAgo } });

    const flag = async (id: string) => (await (await call(base, biomed, 'GET', `/complaints/${id}`)).json()).overDowntimeLimit as boolean;
    assert.equal(await flag(c1.id), true, '30 h down on a critical asset is over the default 24 h');
    assert.equal(await flag(c2.id), false, 'only critical equipment is flagged');

    assert.equal((await call(base, admin, 'PUT', '/settings', { criticalDowntimeHours: 48 })).status, 200);
    assert.equal(await flag(c1.id), false, 'the limit is the hospital’s to set');
    await call(base, admin, 'PUT', '/settings', { criticalDowntimeHours: 24 });
  });
});

describe('Equipment history workbook', () => {
  it('has one sheet per kind of record, and is for report viewers within their department scope', async () => {
    const a = await makeAsset({ installationDate: '2021-01-01', openingPmsOn: '2026-02-01' });
    const c = await (await raise(nursing, a.id)).json();
    await call(base, biomed, 'POST', `/complaints/${c.id}/start`);
    await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Fixed' });
    await call(base, biomed, 'POST', `/assets/${a.id}/service-logs`, { serviceDate: '2026-06-15', kind: 'inspection', description: 'Safety inspection' });
    await call(base, biomed, 'POST', `/assets/${a.id}/expenses`, { type: 'spare_part', description: 'Filter', amount: 1200, date: todayISO() });

    const res = await call(base, biomed, 'GET', `/assets/${a.id}/history`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await res.arrayBuffer()) as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    for (const sheet of ['Summary', 'Purchase orders', 'Contracts', 'PMS', 'Calibration', 'Complaints', 'Service log', 'Expenses', 'Documents', 'About']) assert.ok(names.includes(sheet), `${sheet} sheet`);
    assert.equal(wb.getWorksheet('Complaints')!.rowCount, 2); // header + the one complaint
    assert.equal(wb.getWorksheet('Service log')!.rowCount, 2);
    assert.equal(wb.getWorksheet('Expenses')!.rowCount, 3); // header + row + total

    assert.equal((await call(base, nursing, 'GET', `/assets/${a.id}/history`)).status, 403);
    const foreign = await makeAsset({}, 'bme');
    assert.equal((await call(base, nursing, 'GET', `/assets/${foreign.id}/history`)).status, 403);
  });
});
