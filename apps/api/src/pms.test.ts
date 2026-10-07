// Integration tests for the Phase 4 rules (PMS date lock, read-only records, calibration, reminders).
// Needs a migrated + seeded database (npm run db:seed -w apps/api).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { addMonths, isoDate, parseDate, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { generateReminders } from './modules/reminders/reminders.service';
import { call, login, startServer } from './testUtils';

const PREFIX = 'PTEST-';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_PATH = path.join(os.tmpdir(), `bme-ptest-${process.pid}`);

let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nursing = '';
const ids = { icu: '', icu1: '', type: '' };
const startedAt = new Date();

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ITEMS = [
  { id: 'ok', label: 'Unit works', type: 'check', required: true },
  { id: 'temp', label: 'Temperature', type: 'reading', unit: '°C', min: 20, max: 25, required: true },
  { id: 'note', label: 'Notes', type: 'text', required: false },
];
const good = { ok: 'pass', temp: 22 };

before(async () => {
  ({ server, base } = startServer());
  [admin, biomed, nursing] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  const [icu, icu1] = await Promise.all([
    prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } }),
  ]);
  Object.assign(ids, { icu: icu.id, icu1: icu1.id });
  // An equipment type of our own, so the real checklists are never touched.
  const type = await (await call(base, admin, 'POST', '/equipment-types', { name: `${PREFIX}type`, code: 'PTT', defaultPmsMonths: 3, defaultCalibrationMonths: 12 })).json();
  ids.type = type.id;
  const t = await call(base, admin, 'POST', '/pms-templates', { equipmentTypeId: ids.type, items: ITEMS });
  assert.equal(t.status, 201);
});

after(async () => {
  const assets = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  await prisma.notification.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { createdAt: { gte: startedAt } }] } });
  await prisma.attachment.deleteMany({ where: { ownerType: 'calibration_record' } });
  await prisma.calibrationRecord.deleteMany({ where: { assetId: { in: assetIds } } });
  // PMS records are immutable; the tests (and only the tests) lift that for their own cleanup.
  await prisma.$transaction([
    prisma.$queryRaw`select set_config('bme.allow_pms_cleanup', 'on', true)`,
    prisma.pmsRecord.deleteMany({ where: { assetId: { in: assetIds } } }),
  ]);
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: assetIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  await prisma.pmsTemplate.deleteMany({ where: { equipmentTypeId: ids.type } });
  await prisma.equipmentType.deleteMany({ where: { id: ids.type } });
  await prisma.hospitalSettings.updateMany({ data: { smtpHost: null, smtpPort: null, smtpFrom: null, smtpUser: null, smtpPassword: null } });
  await rm(process.env.STORAGE_PATH!, { recursive: true, force: true });
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const makeAsset = async (extra: object = {}) =>
  (await (await call(base, biomed, 'POST', '/assets', { equipmentTypeId: ids.type, name: `${PREFIX}${++n}`, departmentId: ids.icu, locationId: ids.icu1, ...extra })).json()) as { id: string; assetCode: string; nextPmsDue: string | null };
const submit = (assetId: string, body: object, cookie = biomed) => call(base, cookie, 'POST', `/assets/${assetId}/pms`, body);
const nextPmsDue = async (id: string) => (await prisma.asset.findUniqueOrThrow({ where: { id } })).nextPmsDue;

describe('PMS date lock', () => {
  it('stamps today in the hospital timezone and ignores a date, person or result sent by the client', async () => {
    const a = await makeAsset();
    const res = await submit(a.id, { answers: good, performedOn: '2001-01-01', performed_on: '2001-01-01', performedBy: 'someone-else', result: 'fail', submittedAt: '2001-01-01T00:00:00Z' });
    assert.equal(res.status, 201);
    const r = await res.json();
    assert.equal(r.performedOn, todayISO());
    assert.equal(r.result, 'pass');
    assert.equal(r.performedByName, 'Ravi Patel');
    assert.equal(r.locked, true);
    assert.ok(Date.now() - new Date(r.submittedAt).getTime() < 10_000);
    const row = await prisma.pmsRecord.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(isoDate(row.performedOn), todayISO());
  });

  it('moves the next due date on from today by the asset’s interval', async () => {
    const a = await makeAsset({ pmsFrequencyMonths: 6 });
    await submit(a.id, { answers: good });
    assert.equal(isoDate((await nextPmsDue(a.id))!), isoDate(addMonths(parseDate(todayISO()), 6)));
  });
});

describe('checklist answers', () => {
  it('reports each item that is missing, malformed or not on the checklist', async () => {
    const a = await makeAsset();
    const res = await submit(a.id, { answers: { temp: 'warm', bogus: 'pass' } });
    assert.equal(res.status, 400);
    const { error } = await res.json();
    assert.deepEqual(Object.keys(error.details.fieldErrors).sort(), ['bogus', 'ok', 'temp']);
  });

  it('a reading outside its range is recorded as a FAIL, not rejected', async () => {
    const a = await makeAsset();
    const r = await (await submit(a.id, { answers: { ok: 'pass', temp: 31 } })).json();
    assert.equal(r.result, 'fail');
    const f = await (await submit(a.id, { answers: { ok: 'fail', temp: 22 } })).json();
    assert.equal(f.result, 'fail');
  });
});

describe('submitted records are read-only', () => {
  it('has no route that changes or removes a record, and the database refuses it too', async () => {
    const a = await makeAsset();
    const r = await (await submit(a.id, { answers: good })).json();
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      assert.equal((await call(base, admin, method, `/pms/${r.id}`, { answers: { ok: 'fail' } })).status, 404, method);
    }
    await assert.rejects(prisma.pmsRecord.update({ where: { id: r.id }, data: { result: 'fail' } }), /read-only/);
    await assert.rejects(prisma.pmsRecord.update({ where: { id: r.id }, data: { performedOn: parseDate('2001-01-01') } }), /read-only/);
    await assert.rejects(prisma.pmsRecord.delete({ where: { id: r.id } }), /read-only/);
    assert.equal((await prisma.pmsRecord.findUniqueOrThrow({ where: { id: r.id } })).result, 'pass');
  });
});

describe('corrections', () => {
  it('are new linked records; the original stays as it was and the schedule does not move', async () => {
    const a = await makeAsset();
    const original = await (await submit(a.id, { answers: { ok: 'pass', temp: 22 } })).json();
    const dueBefore = await nextPmsDue(a.id);

    assert.equal((await submit(a.id, { answers: good, correctsRecordId: original.id })).status, 400, 'a reason is required');
    const res = await submit(a.id, { answers: { ok: 'pass', temp: 21 }, correctsRecordId: original.id, correctionReason: 'Wrong reading typed' });
    assert.equal(res.status, 201);
    const fix = await res.json();
    assert.equal(fix.correctsRecordId, original.id);
    assert.equal(fix.correctionReason, 'Wrong reading typed');
    assert.notEqual(fix.id, original.id);

    const list = await (await call(base, biomed, 'GET', `/assets/${a.id}/pms`)).json();
    const o = list.find((r: { id: string }) => r.id === original.id);
    assert.equal(o.correctedByRecordId, fix.id);
    assert.equal(o.answers.temp, 22, 'the original is untouched');
    assert.deepEqual(await nextPmsDue(a.id), dueBefore);
  });

  it('must point at a record of the same asset', async () => {
    const [a, b] = [await makeAsset(), await makeAsset()];
    const other = await (await submit(b.id, { answers: good })).json();
    assert.equal((await submit(a.id, { answers: good, correctsRecordId: other.id, correctionReason: 'Mixed up the unit' })).status, 400);
  });
});

describe('checklist versions and permissions', () => {
  it('a new version leaves old records on the version they were done with', async () => {
    const a = await makeAsset();
    const old = await (await submit(a.id, { answers: good })).json();
    assert.equal(old.templateVersion, 1);

    const v2 = await call(base, admin, 'POST', '/pms-templates', { equipmentTypeId: ids.type, items: [...ITEMS, { id: 'extra', label: 'New check', type: 'check', required: true }] });
    assert.equal((await v2.json()).version, 2);

    assert.equal((await submit(a.id, { answers: good })).status, 400, 'the new checklist asks the new question');
    const fresh = await (await submit(a.id, { answers: { ...good, extra: 'pass' } })).json();
    assert.equal(fresh.templateVersion, 2);
    const again = await (await call(base, biomed, 'GET', `/pms/${old.id}`)).json();
    assert.equal(again.templateVersion, 1);
    assert.equal(again.items.length, 3);
  });

  it('only the admin edits checklists; nursing sees no PMS at all', async () => {
    const a = await makeAsset();
    assert.equal((await call(base, biomed, 'POST', '/pms-templates', { equipmentTypeId: ids.type, items: ITEMS })).status, 403);
    assert.equal((await call(base, nursing, 'GET', '/pms-templates')).status, 403);
    assert.equal((await call(base, nursing, 'GET', `/assets/${a.id}/pms`)).status, 403);
    assert.equal((await submit(a.id, { answers: good }, nursing)).status, 403);
    assert.equal((await call(base, nursing, 'GET', '/pms/due')).status, 403);
  });

  it('rejects a checklist with duplicate ids or an impossible range', async () => {
    const dup = await call(base, admin, 'POST', '/pms-templates', { equipmentTypeId: ids.type, items: [ITEMS[0], ITEMS[0]] });
    assert.equal(dup.status, 400);
    const range = await call(base, admin, 'POST', '/pms-templates', { equipmentTypeId: ids.type, items: [{ id: 'r', label: 'R', type: 'reading', min: 10, max: 5, required: true }] });
    assert.equal(range.status, 400);
  });
});

describe('due lists', () => {
  it('list overdue and soon-due equipment, soonest first, and leave out parked equipment', async () => {
    const [overdue, soon, idle, far] = [await makeAsset(), await makeAsset(), await makeAsset(), await makeAsset()];
    const day = (d: number) => { const x = parseDate(todayISO()); x.setUTCDate(x.getUTCDate() + d); return x; };
    await prisma.asset.update({ where: { id: overdue.id }, data: { nextPmsDue: day(-10) } });
    await prisma.asset.update({ where: { id: soon.id }, data: { nextPmsDue: day(7) } });
    await prisma.asset.update({ where: { id: idle.id }, data: { nextPmsDue: day(-3), status: 'not_in_use' } });
    await prisma.asset.update({ where: { id: far.id }, data: { nextPmsDue: day(200) } });

    const rows: { assetId: string; daysLeft: number }[] = await (await call(base, biomed, 'GET', '/pms/due')).json();
    const mine = rows.filter((r) => [overdue.id, soon.id, idle.id, far.id].includes(r.assetId));
    assert.deepEqual(mine.map((r) => [r.assetId, r.daysLeft]), [[overdue.id, -10], [soon.id, 7]]);
    const wider = await (await call(base, biomed, 'GET', `/pms/due?until=${isoDate(day(250))}`)).json();
    assert.ok(wider.some((r: { assetId: string }) => r.assetId === far.id));
  });
});

describe('calibration', () => {
  it('records it, moves the next due date, and rejects a future date', async () => {
    const a = await makeAsset();
    const done = isoDate(parseDate(todayISO()));
    const res = await call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: done, agency: 'NABL Lab', result: 'pass' });
    assert.equal(res.status, 201);
    const c = await res.json();
    assert.equal(c.dueOn, isoDate(addMonths(parseDate(done), 12)), 'default interval from the equipment type');
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: a.id } });
    assert.equal(isoDate(asset.nextCalibrationDue!), c.dueOn);

    const future = await call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: '2099-01-01', agency: 'X Lab', result: 'pass' });
    assert.equal(future.status, 400);
    const backwards = await call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: done, dueOn: '2020-01-01', agency: 'X Lab', result: 'pass' });
    assert.equal(backwards.status, 400);
    assert.equal((await call(base, nursing, 'GET', `/assets/${a.id}/calibrations`)).status, 403);
  });

  it('keeps the certificate private and serves it to the asset’s staff', async () => {
    const a = await makeAsset();
    const c = await (await call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: todayISO(), agency: 'NABL Lab', result: 'pass' })).json();
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(PNG)]), 'certificate.png');
    const up = await fetch(`${base}/calibration/records/${c.id}/certificate`, { method: 'POST', headers: { cookie: biomed }, body: form });
    assert.equal(up.status, 201);
    const cert = await up.json();
    const list = await (await call(base, biomed, 'GET', `/assets/${a.id}/calibrations`)).json();
    assert.equal(list[0].certificate.fileName, 'certificate.png');
    const dl = await fetch(`${base}/attachments/${cert.id}/download`, { headers: { cookie: biomed } });
    assert.equal(dl.status, 200);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), PNG);
  });
});

// ---- Reminders: a faked clock walks one item through every threshold ----

describe('reminders', () => {
  const dayOffset = (due: string, offset: number) => { const d = parseDate(due); d.setUTCDate(d.getUTCDate() + offset); return isoDate(d); };
  const mine = (assetId: string) => prisma.notification.findMany({ where: { assetId, type: 'pms' }, include: { user: { include: { role: true } } } });

  it('one reminder per person per threshold (30 / 15 / 5), however often the job runs', async () => {
    const a = await makeAsset();
    const due = dayOffset(todayISO(), 90);
    await prisma.asset.update({ where: { id: a.id }, data: { nextPmsDue: parseDate(due) } });

    const count = async () => (await mine(a.id)).length;
    await generateReminders(dayOffset(due, -31));
    assert.equal(await count(), 0, '31 days out: too early');

    const first = await generateReminders(dayOffset(due, -30));
    assert.ok(first.created >= 3, 'created for admin, biomed and super admin');
    const people = await count();
    assert.equal(people, 3);

    await generateReminders(dayOffset(due, -30));
    await Promise.all([generateReminders(dayOffset(due, -30)), generateReminders(dayOffset(due, -30))]);
    assert.equal(await count(), people, 'same day, run again and in parallel: no duplicates');

    for (const offset of [-29, -20, -16]) await generateReminders(dayOffset(due, offset));
    assert.equal(await count(), people, 'between thresholds: nothing new');

    await generateReminders(dayOffset(due, -15));
    assert.equal(await count(), people * 2);
    for (const offset of [-14, -6]) await generateReminders(dayOffset(due, offset));
    assert.equal(await count(), people * 2);

    await generateReminders(dayOffset(due, -5));
    assert.equal(await count(), people * 3);
    for (const offset of [-4, -1, 0, 3]) await generateReminders(dayOffset(due, offset)); // incl. overdue
    const all = await mine(a.id);
    assert.equal(all.length, people * 3, 'exactly one reminder per threshold per person');
    assert.deepEqual([...new Set(all.map((x) => x.thresholdDays))].sort((x, y) => (x ?? 0) - (y ?? 0)), [5, 15, 30]);
    assert.ok(all.every((x) => x.user!.role.name !== 'nursing'), 'nursing is not reminded');
    assert.ok(all.some((x) => /due in 30 days/.test(x.message)) && all.some((x) => /due in 5 days/.test(x.message)));
  });

  it('after downtime, one reminder for where things stand, not a burst', async () => {
    const a = await makeAsset();
    const due = dayOffset(todayISO(), 90);
    await prisma.asset.update({ where: { id: a.id }, data: { nextPmsDue: parseDate(due) } });
    await generateReminders(dayOffset(due, -3)); // the first run in a month
    const rows = await mine(a.id);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.thresholdDays === 5));
  });

  it('skips parked equipment, warns about a warranty and a contract, and honours changed lead days', async () => {
    const parked = await makeAsset();
    const covered = await makeAsset({ installationDate: '2024-01-10', warrantyMonths: 24 });
    const today = todayISO();
    await prisma.asset.update({ where: { id: parked.id }, data: { nextPmsDue: parseDate(dayOffset(today, 2)), status: 'not_in_use' } });
    await prisma.asset.update({ where: { id: covered.id }, data: { warrantyEnd: parseDate(dayOffset(today, 12)), nextPmsDue: null } });
    await prisma.serviceContract.create({ data: { assetId: covered.id, type: 'amc', vendor: 'Drager', startDate: parseDate('2025-01-01'), endDate: parseDate(dayOffset(today, 4)), cost: 1000 } });

    await generateReminders(today);
    assert.equal((await mine(parked.id)).length, 0);
    const warranty = await prisma.notification.findMany({ where: { assetId: covered.id, type: 'warranty' } });
    const contract = await prisma.notification.findMany({ where: { assetId: covered.id, type: 'contract' } });
    assert.equal(warranty.length, 3);
    assert.equal(warranty[0].thresholdDays, 15, '12 days left: the 15-day threshold');
    assert.equal(contract.length, 3);
    assert.equal(contract[0].thresholdDays, 5);
    assert.match(contract[0].message, /AMC contract with Drager ends in 4 days/);
    await prisma.serviceContract.deleteMany({ where: { assetId: covered.id } });
  });

  it('each person reads, and marks read, only their own', async () => {
    const mineList = await (await call(base, biomed, 'GET', '/notifications')).json();
    assert.ok(mineList.unread > 0);
    const target = mineList.items.find((x: { readAt: string | null }) => !x.readAt);
    const adminList = await (await call(base, admin, 'GET', '/notifications')).json();
    assert.ok(!adminList.items.some((x: { id: string }) => x.id === target.id), 'not in someone else’s list');
    assert.equal((await call(base, admin, 'POST', `/notifications/${target.id}/read`)).status, 404);
    assert.equal((await call(base, biomed, 'POST', `/notifications/${target.id}/read`)).status, 204);
    assert.equal((await (await call(base, biomed, 'GET', '/notifications')).json()).unread, mineList.unread - 1);
    assert.equal((await call(base, nursing, 'GET', '/notifications')).status, 403);
    assert.equal((await call(base, biomed, 'POST', '/reminders/run')).status, 403);
  });
});

// ---- Email only when SMTP is configured ----

function fakeSmtp() {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol).toUpperCase();
        buffer = buffer.slice(eol + 2);
        if (line.startsWith('EHLO') || line.startsWith('HELO')) socket.write('250 fake\r\n');
        else if (line === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n');
          return;
        } else socket.write('250 OK\r\n');
      }
    });
  });
  return { messages, server };
}

describe('email', () => {
  it('is skipped without SMTP, sent as one digest per person when configured, and the test button works', async () => {
    const a = await makeAsset();
    const today = todayISO();
    const due = new Date(parseDate(today)); due.setUTCDate(due.getUTCDate() + 3);
    await prisma.asset.update({ where: { id: a.id }, data: { nextPmsDue: due } });

    const without = await generateReminders(today);
    assert.equal(without.emailed, 0, 'no SMTP, no email');
    assert.equal((await prisma.notification.findMany({ where: { assetId: a.id, emailedAt: { not: null } } })).length, 0);

    const smtp = fakeSmtp();
    await new Promise<void>((resolve) => smtp.server.listen(0, resolve));
    try {
      const port = (smtp.server.address() as net.AddressInfo).port;
      const put = await call(base, admin, 'PUT', '/settings', { smtpHost: '127.0.0.1', smtpPort: port, smtpFrom: 'bme@hospital.test' });
      const saved = await put.json();
      assert.equal(put.status, 200);
      assert.equal(saved.smtpHost, '127.0.0.1');
      assert.ok(!('smtpPassword' in saved), 'the password is never returned');

      const run = await (await call(base, admin, 'POST', '/reminders/run')).json();
      assert.ok(run.emailed >= 3, `emailed ${run.emailed}`);
      assert.ok(smtp.messages.some((m) => m.includes(a.assetCode)), 'the digest names the asset');
      assert.ok((await prisma.notification.findMany({ where: { assetId: a.id, emailedAt: { not: null } } })).length >= 3);

      const before = smtp.messages.length;
      assert.equal((await (await call(base, admin, 'POST', '/reminders/run')).json()).emailed, 0, 'not sent twice');
      assert.equal(smtp.messages.length, before);

      assert.equal((await call(base, admin, 'POST', '/settings/smtp-test', { to: 'hod@hospital.test' })).status, 200);
      assert.ok(smtp.messages.some((m) => /test email/i.test(m)));
    } finally {
      smtp.server.close();
    }
  });
});
