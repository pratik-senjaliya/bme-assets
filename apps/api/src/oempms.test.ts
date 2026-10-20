// Decision A: a PMS done by the OEM engineer carries the visit date from their report, within limits the server
// enforces (not after today, at most 30 days back, not before installation or the last PMS), with the report
// required and saved with the record. Both are read-only afterwards, like every PMS record. Needs a migrated +
// seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { PmsRecordRow } from '@bme/shared';
import { addDaysISO, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { getStorage } from './lib/storage';
import { call, login, PNG, startServer } from './testUtils';

const PREFIX = 'OTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let biomed = '';
let nurse = '';
const today = todayISO();
const daysAgo = (n: number) => addDaysISO(today, -n);

async function cleanUp() {
  const ids = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const records = (await prisma.pmsRecord.findMany({ where: { assetId: { in: ids } }, select: { id: true } })).map((r) => r.id);
  const files = await prisma.attachment.findMany({ where: { ownerType: 'pms_record', ownerId: { in: records } } });
  for (const f of files) await getStorage().remove(f.filePath).catch(() => undefined);
  await prisma.attachment.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
  await prisma.notification.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.$transaction([prisma.$queryRaw`select set_config('bme.allow_pms_cleanup', 'on', true)`, prisma.pmsRecord.deleteMany({ where: { assetId: { in: ids } } })]);
  await prisma.asset.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  await cleanUp();
  ({ server, base } = startServer());
  [biomed, nurse] = await Promise.all([login(base, 'biomed@demo.local'), login(base, 'nursing@demo.local')]);
});
after(async () => {
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

// Equipment installed two years ago, PMS every 6 months.
async function makeAsset(extra: Record<string, unknown> = {}) {
  const [type, icu, icu1] = await Promise.all([
    prisma.equipmentType.findFirstOrThrow({ where: { code: 'VENT' } }),
    prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } }),
  ]);
  const res = await call(base, biomed, 'POST', '/assets', { equipmentTypeId: type.id, name: `${PREFIX}vent`, departmentId: icu.id, locationId: icu1.id, installationDate: daysAgo(730), pmsFrequencyMonths: 6, ...extra });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { id: string };
}

const oem = (assetId: string, data: Record<string, unknown>, file: { bytes: Buffer; name: string } | null = { bytes: PNG, name: 'oem-report.png' }, cookie = biomed) => {
  const body = new FormData();
  body.set('data', JSON.stringify(data));
  if (file) body.set('file', new Blob([new Uint8Array(file.bytes)]), file.name);
  return fetch(`${base}/assets/${assetId}/pms/oem`, { method: 'POST', headers: { cookie }, body });
};
const visit = (performedOn: string, extra: Record<string, unknown> = {}) => ({ performedOn, serviceBy: 'Mr. A. Shah, Philips Healthcare', result: 'pass', ...extra });
const errorsOf = async (res: Response) => ((await res.json()) as { error: { details?: { fieldErrors?: Record<string, string[]> } } }).error.details?.fieldErrors ?? {};

describe('Recording a PMS done by the OEM engineer', () => {
  it('keeps the visit date from the report, attaches the report, and moves the schedule on from that date', async () => {
    const a = await makeAsset();
    const res = await oem(a.id, visit(daysAgo(10)));
    assert.equal(res.status, 201, await res.clone().text());
    const row = (await res.json()) as PmsRecordRow;
    assert.equal(row.kind, 'oem');
    assert.equal(row.performedOn, daysAgo(10));
    assert.equal(row.serviceBy, 'Mr. A. Shah, Philips Healthcare');
    assert.equal(row.result, 'pass');
    assert.equal(row.templateVersion, null);
    assert.ok(row.report, 'no report on the record');
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: a.id } });
    const due = new Date(`${daysAgo(10)}T00:00:00Z`);
    due.setUTCMonth(due.getUTCMonth() + 6);
    assert.equal(asset.nextPmsDue?.toISOString().slice(0, 10), due.toISOString().slice(0, 10), 'next PMS not six months after the visit');
    const dl = await fetch(`${base}/attachments/${row.report!.id}/download`, { headers: { cookie: biomed } });
    assert.equal(dl.status, 200);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), PNG);
    assert.ok(await prisma.auditLog.findFirst({ where: { entityId: row.id, action: 'pms.submit_oem' } }), 'not audited');
  });

  it('refuses a date after today, more than 30 days back, before installation, or before the last PMS', async () => {
    const a = await makeAsset();
    for (const [date, why] of [[addDaysISO(today, 1), 'future'], [daysAgo(31), '31 days back']] as const) {
      const res = await oem(a.id, visit(date));
      assert.equal(res.status, 400, why);
      assert.ok((await errorsOf(res)).performedOn, `no message on the date (${why})`);
    }
    const fresh = await makeAsset({ installationDate: daysAgo(5) });
    assert.equal((await oem(fresh.id, visit(daysAgo(6)))).status, 400, 'a visit before installation');
    assert.equal((await oem(a.id, visit(daysAgo(5)))).status, 201);
    const before = await oem(a.id, visit(daysAgo(8)));
    assert.equal(before.status, 400, 'a visit before the last PMS was accepted');
    assert.match((await errorsOf(before)).performedOn?.[0] ?? '', /last PMS/);
    assert.equal((await oem(a.id, visit(daysAgo(5)))).status, 201, 'the same day as the last PMS is allowed');
  });

  it('needs the report (a PDF or picture) and the result; nothing is saved without them', async () => {
    const a = await makeAsset();
    const none = await oem(a.id, visit(daysAgo(1)), null);
    assert.equal(none.status, 400);
    assert.ok((await errorsOf(none)).file);
    assert.equal((await oem(a.id, visit(daysAgo(1)), { bytes: Buffer.from('not a report'), name: 'notes.txt' })).status, 415);
    const noResult = await oem(a.id, { performedOn: daysAgo(1), serviceBy: 'Mr. A. Shah, Philips' });
    assert.equal(noResult.status, 400);
    assert.ok((await errorsOf(noResult)).result);
    assert.equal(await prisma.pmsRecord.count({ where: { assetId: a.id } }), 0, 'a record was saved without its report or result');
  });

  it('with our checklist filled in, works the result out from it', async () => {
    const a = await makeAsset();
    const template = await (await call(base, biomed, 'GET', `/assets/${a.id}/pms-template`)).json();
    const answers = Object.fromEntries((template.items as { id: string; type: string; min?: number }[]).map((i) => [i.id, i.type === 'check' ? 'pass' : i.type === 'reading' ? (i.min ?? 0) - 100 : 'ok']));
    const res = await oem(a.id, visit(daysAgo(2), { answers, result: 'pass' }));
    assert.equal(res.status, 201, await res.clone().text());
    const row = (await res.json()) as PmsRecordRow;
    assert.equal(row.result, 'fail', 'a reading outside its range did not fail the PMS');
    assert.equal(row.templateVersion, template.version);
  });

  it('is read-only like any PMS: the database refuses changes, and no file can be added to it later', async () => {
    const a = await makeAsset();
    const row = (await (await oem(a.id, visit(daysAgo(3)))).json()) as PmsRecordRow;
    await assert.rejects(prisma.pmsRecord.update({ where: { id: row.id }, data: { performedOn: new Date(`${daysAgo(60)}T00:00:00Z`) } }));
    const extra = new FormData();
    extra.set('ownerType', 'pms_record');
    extra.set('ownerId', row.id);
    extra.set('kind', 'service_report');
    extra.set('file', new Blob([new Uint8Array(PNG)]), 'swap.png');
    assert.equal((await fetch(`${base}/attachments`, { method: 'POST', headers: { cookie: biomed }, body: extra })).status, 403);
  });

  it('a correction replaces the entry but keeps its date and the schedule; in-house and OEM records are corrected their own way', async () => {
    const a = await makeAsset();
    const first = (await (await oem(a.id, visit(daysAgo(4)))).json()) as PmsRecordRow;
    const dueBefore = (await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).nextPmsDue;
    const res = await oem(a.id, visit(daysAgo(1), { result: 'fail', correctsRecordId: first.id, correctionReason: 'Wrong result copied from the report' }));
    assert.equal(res.status, 201, await res.clone().text());
    const fixed = (await res.json()) as PmsRecordRow;
    assert.equal(fixed.performedOn, daysAgo(4), 'the correction took a new date');
    assert.equal(fixed.correctsRecordId, first.id);
    assert.deepEqual((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).nextPmsDue, dueBefore, 'a correction moved the schedule');
    assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/pms`, { answers: {}, correctsRecordId: first.id, correctionReason: 'Trying the checklist route' })).status, 400);
  });

  it('is for the people who do PMS: nursing staff are refused', async () => {
    const a = await makeAsset();
    assert.equal((await oem(a.id, visit(daysAgo(1)), undefined, nurse)).status, 403);
  });
});
