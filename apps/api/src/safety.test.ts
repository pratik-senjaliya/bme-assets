// Gap review, batch 1 (safety): a failed PMS or calibration flags the machine until one passes and tells the HOD; a
// machine with an unfixed fault shows it wherever it is listed; urgent complaints come first and are emailed; the
// biomedical contact and the idle sign-out time are hospital settings every signed-in person can read.
// Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import type net from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { AssetDetail, AssetRow, ComplaintRow, HospitalInfo, Paged } from '@bme/shared';
import { todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { call, fakeSmtp, login, startServer } from './testUtils';

const PREFIX = 'SAFETEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nurse = '';
const ids = { icu: '', icu1: '', type: '', adminUser: '' };
const startedAt = new Date();

before(async () => {
  await cleanUp();
  ({ server, base } = startServer());
  [admin, biomed, nurse] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  ids.icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
  ids.icu1 = (await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })).id;
  ids.adminUser = (await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } })).id;
  const type = await (await call(base, admin, 'POST', '/equipment-types', { name: `${PREFIX}type`, code: 'SFT', defaultPmsMonths: 3, defaultCalibrationMonths: 12 })).json();
  ids.type = type.id;
  assert.equal((await call(base, admin, 'POST', '/pms-templates', { equipmentTypeId: ids.type, items: [{ id: 'ok', label: 'Alarms work', type: 'check', required: true }] })).status, 201);
});

async function cleanUp() {
  const assetIds = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const complaints = (await prisma.complaint.findMany({ where: { assetId: { in: assetIds } }, select: { id: true } })).map((c) => c.id);
  await prisma.notification.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { createdAt: { gte: startedAt }, message: { contains: PREFIX } }] } });
  await prisma.complaintStep.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.complaint.deleteMany({ where: { id: { in: complaints } } });
  await prisma.calibrationRecord.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.$transaction([prisma.$queryRaw`select set_config('bme.allow_pms_cleanup', 'on', true)`, prisma.pmsRecord.deleteMany({ where: { assetId: { in: assetIds } } })]);
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  await prisma.pmsTemplate.deleteMany({ where: { equipmentType: { code: 'SFT' } } });
  await prisma.equipmentType.deleteMany({ where: { code: 'SFT' } });
  await prisma.hospitalSettings.updateMany({ data: { biomedContact: null, idleLogoutMinutes: 30, smtpHost: null, smtpPort: null, smtpFrom: null } });
}

after(async () => {
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const makeAsset = async () => {
  const res = await call(base, admin, 'POST', '/assets', { equipmentTypeId: ids.type, name: `${PREFIX}${++n}`, departmentId: ids.icu, locationId: ids.icu1 });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as AssetDetail;
};
const detail = async (id: string, cookie = biomed) => (await (await call(base, cookie, 'GET', `/assets/${id}`)).json()) as AssetDetail;
const listed = async (condition: string, cookie = biomed) => ((await (await call(base, cookie, 'GET', `/assets?condition=${condition}&search=${PREFIX}&pageSize=100`)).json()) as Paged<AssetRow>).items.map((a) => a.id);
const pms = (assetId: string, answer: 'pass' | 'fail', extra: object = {}) => call(base, biomed, 'POST', `/assets/${assetId}/pms`, { answers: { ok: answer }, ...extra });

describe('A failed PMS', () => {
  it('flags the machine as not safe until a PMS passes, and tells the HOD', async () => {
    const a = await makeAsset();
    const res = await pms(a.id, 'fail');
    assert.equal(res.status, 201, await res.clone().text());
    assert.equal((await detail(a.id)).pmsFailedOn, todayISO());
    assert.ok((await listed('failed')).includes(a.id));
    assert.ok((await listed('unsafe')).includes(a.id));
    const told = await prisma.notification.findFirst({ where: { userId: ids.adminUser, assetId: a.id, type: 'pms', message: { contains: 'FAILED' } } });
    assert.ok(told, 'the HOD was not told');

    assert.equal((await pms(a.id, 'pass')).status, 201);
    assert.equal((await detail(a.id)).pmsFailedOn, null);
    assert.ok(!(await listed('failed')).includes(a.id));
  });

  it('a correction that changes the result moves the flag with it', async () => {
    const a = await makeAsset();
    const original = (await (await pms(a.id, 'fail')).json()) as { id: string };
    assert.ok((await detail(a.id)).pmsFailedOn);
    const corr = await pms(a.id, 'pass', { correctsRecordId: original.id, correctionReason: 'Alarm test was misread' });
    assert.equal(corr.status, 201, await corr.clone().text());
    assert.equal((await detail(a.id)).pmsFailedOn, null, 'still flagged after the correction passed');
  });
});

describe('A failed calibration', () => {
  it('flags the machine until a calibration passes (the due date rule is unchanged)', async () => {
    const a = await makeAsset();
    const cal = (result: 'pass' | 'fail') => call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: todayISO(), agency: 'Cal Lab', result });
    assert.equal((await cal('fail')).status, 201);
    const failed = await detail(a.id);
    assert.equal(failed.calibrationFailedOn, todayISO());
    assert.ok(failed.nextCalibrationDue, 'no due date');
    assert.ok((await listed('failed')).includes(a.id));
    assert.ok(await prisma.notification.findFirst({ where: { userId: ids.adminUser, assetId: a.id, type: 'calibration', message: { contains: 'FAILED' } } }));
    assert.equal((await cal('pass')).status, 201);
    assert.equal((await detail(a.id)).calibrationFailedOn, null);
  });
});

describe('A machine with a fault not yet fixed', () => {
  it('carries its open complaints wherever it is listed; only an urgent one makes it "not safe"', async () => {
    const a = await makeAsset();
    const normal = (await (await call(base, nurse, 'POST', '/complaints', { assetId: a.id, description: `${PREFIX}screen flickers` })).json()) as ComplaintRow;
    assert.equal(normal.urgent, false);
    const row = (await detail(a.id, nurse)).openComplaints;
    assert.deepEqual(row.map((c) => [c.complaintNo, c.status, c.urgent]), [[normal.complaintNo, 'open', false]]);
    assert.ok(!(await listed('unsafe', nurse)).includes(a.id), 'a minor fault made it "not safe"');

    const urgent = await call(base, nurse, 'POST', '/complaints', { assetId: a.id, description: `${PREFIX}will not switch on`, urgent: true });
    assert.equal(urgent.status, 201, await urgent.clone().text());
    assert.ok((await listed('unsafe', nurse)).includes(a.id));
    const list = ((await (await call(base, biomed, 'GET', `/complaints?status=unresolved&pageSize=100`)).json()) as Paged<ComplaintRow>).items;
    assert.ok(list.findIndex((c) => c.urgent) < list.findIndex((c) => !c.urgent), 'urgent complaints are not listed first');
    assert.ok(await prisma.notification.findFirst({ where: { assetId: a.id, type: 'complaint', message: { startsWith: 'URGENT' } } }), 'no urgent bell notice');
  });

  it('an urgent complaint is emailed to the biomedical team when the hospital has email', async () => {
    const smtp = fakeSmtp();
    await new Promise<void>((resolve) => smtp.server.listen(0, resolve));
    try {
      await prisma.hospitalSettings.updateMany({ data: { smtpHost: '127.0.0.1', smtpPort: (smtp.server.address() as net.AddressInfo).port, smtpFrom: 'bme@hospital.test' } });
      const a = await makeAsset();
      const c = (await (await call(base, nurse, 'POST', '/complaints', { assetId: a.id, description: `${PREFIX}ventilator alarm, no air`, urgent: true })).json()) as ComplaintRow;
      // One email per person who works on complaints; the engineer's is the one to find.
      const toEngineer = () => smtp.messages.find((m) => m.includes(c.complaintNo) && m.includes('To: biomed@demo.local'));
      for (let i = 0; i < 50 && !toEngineer(); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(toEngineer(), 'no email to the biomedical engineer');
      assert.match(toEngineer()!, /Subject: URGENT complaint/);
    } finally {
      smtp.server.close();
      await prisma.hospitalSettings.updateMany({ data: { smtpHost: null, smtpPort: null, smtpFrom: null } });
    }
  });
});

describe('The biomedical contact and idle sign-out', () => {
  it('are set by the HOD and read by everyone signed in', async () => {
    const put = await call(base, admin, 'PUT', '/settings', { biomedContact: 'Biomedical on call: 98250 00000', idleLogoutMinutes: 15 });
    assert.equal(put.status, 200, await put.clone().text());
    const info = (await (await call(base, nurse, 'GET', '/hospital')).json()) as HospitalInfo;
    assert.deepEqual([info.biomedContact, info.idleLogoutMinutes], ['Biomedical on call: 98250 00000', 15]);
    assert.equal((await call(base, admin, 'PUT', '/settings', { idleLogoutMinutes: 1000 })).status, 400);
    assert.equal((await call(base, nurse, 'PUT', '/settings', { idleLogoutMinutes: 0 })).status, 403);
  });
});
