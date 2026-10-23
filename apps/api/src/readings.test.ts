// Facility maintenance add-on, F4 (docs/requirements-facility.md): the logbook. Readings are dated by the server and
// read-only (corrections are new rows), out-of-range readings tell the team, missed ones show, meters never go back,
// PMS can be due by run hours, and the consumption report adds up the meters. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import type { AssetReadings, AssetRow, ReadingAttention, ReadingRow, ReadingTypeRow, ReportData, RunHoursInfo } from '@bme/shared';
import { ensureRolesAndPermissions, ensureStarterTypes } from './lib/baseData';
import { addDaysISO, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { call, login, PASSWORD, startServer } from './testUtils';

const PREFIX = 'READTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let maint = '';
let nurse = '';
const ids = { dg: '', icu: '', icu1: '', maintUser: '' };

async function cleanUp() {
  const assets = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  await prisma.$transaction([
    prisma.$queryRaw`select set_config('bme.allow_pms_cleanup', 'on', true)`,
    prisma.reading.deleteMany({ where: { assetId: { in: assets }, correctsId: { not: null } } }),
    prisma.reading.deleteMany({ where: { assetId: { in: assets } } }),
    prisma.pmsRecord.deleteMany({ where: { assetId: { in: assets } } }),
  ]);
  await prisma.readingType.deleteMany({ where: { assetId: { in: assets } } });
  await prisma.notification.deleteMany({ where: { assetId: { in: assets } } });
  await prisma.asset.deleteMany({ where: { id: { in: assets } } });
}

before(async () => {
  await cleanUp();
  await ensureRolesAndPermissions();
  await ensureStarterTypes('facility');
  await prisma.hospitalSettings.updateMany({ data: { facilityEnabled: true } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'maintenance' } });
  await prisma.user.upsert({ where: { email: 'maintenance@demo.local' }, update: {}, create: { name: 'Suresh Mehta', email: 'maintenance@demo.local', roleId: role.id, passwordHash: await bcrypt.hash(PASSWORD, 10) } });
  ({ server, base } = startServer());
  [admin, biomed, maint, nurse] = await Promise.all(['admin', 'biomed', 'maintenance', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  ids.dg = (await prisma.equipmentType.findFirstOrThrow({ where: { code: 'DG' } })).id;
  ids.icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
  ids.icu1 = (await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })).id;
  ids.maintUser = (await prisma.user.findUniqueOrThrow({ where: { email: 'maintenance@demo.local' } })).id;
});
after(async () => {
  await prisma.hospitalSettings.updateMany({ data: { facilityEnabled: true } });
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const makeDg = async () => (await (await call(base, maint, 'POST', '/assets', { equipmentTypeId: ids.dg, name: `${PREFIX}DG ${++n}`, departmentId: ids.icu, locationId: ids.icu1 })).json()) as AssetRow;
const addType = async (assetId: string, body: object) => {
  const res = await call(base, maint, 'POST', `/readings/assets/${assetId}/types`, { unit: 'h', ...body });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as ReadingTypeRow;
};
const read = (typeId: string, value: number, who = maint) => call(base, who, 'POST', `/readings/types/${typeId}`, { value });

describe('The logbook', () => {
  it('readings are server-dated and read-only; a correction is a new linked reading', async () => {
    const dg = await makeDg();
    const diesel = await addType(dg.id, { name: 'Diesel level', unit: '%', min: 30, max: 100 });
    const before = Date.now();
    const r = (await (await call(base, maint, 'POST', `/readings/types/${diesel.id}`, { value: 70, takenAt: '2020-01-01T00:00:00Z' })).json()) as ReadingRow;
    assert.ok(new Date(r.takenAt).getTime() >= before - 1000, 'the server sets the time');
    await assert.rejects(prisma.reading.update({ where: { id: r.id }, data: { value: 1 } }), /read-only/);
    await assert.rejects(prisma.reading.delete({ where: { id: r.id } }), /read-only/);
    const fixed = await call(base, maint, 'POST', `/readings/${r.id}/correct`, { value: 75, reason: 'Misread the gauge' });
    assert.equal(fixed.status, 201);
    assert.equal((await call(base, maint, 'POST', `/readings/${r.id}/correct`, { value: 76, reason: 'Again' })).status, 409);
    const all = (await (await call(base, maint, 'GET', `/readings/assets/${dg.id}`)).json()) as AssetReadings;
    assert.equal(all.types[0].last?.value, 75);
    assert.equal(all.readings.find((x) => x.id === r.id)?.corrected, true);
  });

  it('a reading outside its range tells the team, not the other team', async () => {
    const dg = await makeDg();
    const diesel = await addType(dg.id, { name: 'Diesel level', unit: '%', min: 30, max: 100 });
    const r = (await (await read(diesel.id, 12, admin)).json()) as ReadingRow;
    assert.equal(r.outOfRange, true);
    const note = await prisma.notification.findFirst({ where: { userId: ids.maintUser, type: 'reading', assetId: dg.id } });
    assert.match(note?.message ?? '', /Diesel level 12 %/);
    const biomedUser = await prisma.user.findUniqueOrThrow({ where: { email: 'biomed@demo.local' } });
    assert.equal(await prisma.notification.count({ where: { userId: biomedUser.id, type: 'reading', assetId: dg.id } }), 0);
    const attention = (await (await call(base, maint, 'GET', '/readings/attention')).json()) as ReadingAttention;
    assert.ok(attention.outOfRange.some((t) => t.id === diesel.id));
  });

  it('a reading not yet taken today shows as missed', async () => {
    const dg = await makeDg();
    const t = await addType(dg.id, { name: 'Battery voltage', unit: 'V', every: 'day' });
    let attention = (await (await call(base, maint, 'GET', '/readings/attention')).json()) as ReadingAttention;
    assert.ok(attention.missed.some((x) => x.id === t.id));
    await read(t.id, 24);
    attention = (await (await call(base, maint, 'GET', '/readings/attention')).json()) as ReadingAttention;
    assert.ok(!attention.missed.some((x) => x.id === t.id));
  });

  it('a meter never goes back, and PMS by run hours counts from the last PMS', async () => {
    const dg = await makeDg();
    const hours = await addType(dg.id, { name: 'Run hours', kind: 'meter', runHours: true });
    assert.equal((await call(base, maint, 'POST', `/readings/assets/${dg.id}/types`, { name: 'Second meter', unit: 'h', kind: 'meter', runHours: true })).status, 409);
    assert.equal((await read(hours.id, 1000)).status, 201);
    assert.equal((await read(hours.id, 990)).status, 400);
    const set = await call(base, maint, 'PUT', `/readings/assets/${dg.id}/pms-hours`, { pmsEveryHours: 250 });
    assert.equal(set.status, 200);
    assert.deepEqual(((await set.json()) as RunHoursInfo).pmsDueAtHours, 1250);
    await read(hours.id, 1240);
    let attention = (await (await call(base, maint, 'GET', '/readings/attention')).json()) as ReadingAttention;
    assert.equal(attention.hoursDue.find((h) => h.assetId === dg.id)?.hoursLeft, 10);
    // An in-house PMS restarts the count from the meter now.
    const template = await prisma.pmsTemplate.findFirstOrThrow({ where: { equipmentTypeId: ids.dg }, orderBy: { version: 'desc' } });
    const items = (template.schema as { items: { id: string; type: string; min?: number }[] }).items;
    const answers = Object.fromEntries(items.map((i) => [i.id, i.type === 'check' ? 'pass' : i.type === 'reading' ? (i.min ?? 0) : '']));
    const pms = await call(base, maint, 'POST', `/assets/${dg.id}/pms`, { templateId: template.id, answers });
    assert.equal(pms.status, 201, await pms.clone().text());
    const info = ((await (await call(base, maint, 'GET', `/readings/assets/${dg.id}`)).json()) as AssetReadings).runHours;
    assert.equal(info.lastPmsHours, 1240);
    assert.equal(info.pmsDueAtHours, 1490);
    attention = (await (await call(base, maint, 'GET', '/readings/attention')).json()) as ReadingAttention;
    assert.ok(!attention.hoursDue.some((h) => h.assetId === dg.id));
  });

  it('the consumption report adds up the meters by month and lists out-of-range readings', async () => {
    const dg = await makeDg();
    const energy = await addType(dg.id, { name: 'Energy', unit: 'kWh', kind: 'meter' });
    await read(energy.id, 100);
    await read(energy.id, 160);
    await read(energy.id, 175);
    const report = (await (await call(base, admin, 'GET', `/reports/consumption?format=json&from=${addDaysISO(todayISO(), -1)}&to=${todayISO()}`)).json()) as ReportData;
    const row = report.sheets.find((s) => s.name === 'Used per month')!.rows.find((r) => String(r.item).includes(dg.assetCode) && r.reading === 'Energy' && Number(r.used) > 0);
    assert.equal(row?.used, 75);
  });

  it('is for the teams, not the wards, each its own equipment, and only with the add-on', async () => {
    const dg = await makeDg();
    assert.equal((await call(base, nurse, 'GET', `/readings/assets/${dg.id}`)).status, 403);
    assert.equal((await call(base, biomed, 'GET', `/readings/assets/${dg.id}`)).status, 404);
    await prisma.hospitalSettings.updateMany({ data: { facilityEnabled: false } });
    try {
      assert.equal((await call(base, admin, 'GET', '/readings/logbook')).status, 404);
    } finally {
      await prisma.hospitalSettings.updateMany({ data: { facilityEnabled: true } });
    }
  });
});
