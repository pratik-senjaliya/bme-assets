// Facility maintenance add-on, F3 (docs/requirements-facility.md): statutory licences, kept by the team of what they
// cover, renewed as a new record, reminded at the lead days and once expired, and listed in the compliance register.
// Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import type { AssetRow, LicenceRow, ReportData } from '@bme/shared';
import { ensureRolesAndPermissions, ensureStarterTypes } from './lib/baseData';
import { addDaysISO, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { generateReminders } from './modules/reminders/reminders.service';
import { call, login, PASSWORD, PNG, startServer } from './testUtils';

const PREFIX = 'LICTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let maint = '';
let nurse = '';
const ids = { lift: '', icu: '', icu1: '', maintUser: '' };

async function cleanUp() {
  const licences = (await prisma.licence.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((l) => l.id);
  await prisma.attachment.deleteMany({ where: { ownerType: 'licence', ownerId: { in: licences } } });
  await prisma.notification.deleteMany({ where: { licenceId: { in: licences } } });
  // Renewals point at the licence they renew: newest first.
  await prisma.licence.deleteMany({ where: { id: { in: licences }, renewsId: { not: null } } });
  await prisma.licence.deleteMany({ where: { id: { in: licences } } });
  await prisma.asset.deleteMany({ where: { name: { startsWith: PREFIX } } });
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
  ids.lift = (await prisma.equipmentType.findFirstOrThrow({ where: { code: 'LIFT' } })).id;
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
const add = async (who: string, body: object) => {
  const res = await call(base, who, 'POST', '/licences', { kind: 'other', name: `${PREFIX}${++n}`, authority: 'Test authority', validTo: addDaysISO(todayISO(), 200), ...body });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as LicenceRow;
};
const list = async (who: string, q = '') => ((await (await call(base, who, 'GET', `/licences${q}`)).json()) as LicenceRow[]).filter((l) => l.name.startsWith(PREFIX));

describe('Statutory licences', () => {
  it('belong to the team of what they cover; site-wide ones to the facility team; nursing has none', async () => {
    const lift = (await (await call(base, maint, 'POST', '/assets', { equipmentTypeId: ids.lift, name: `${PREFIX}Lift`, departmentId: ids.icu, locationId: ids.icu1 })).json()) as AssetRow;
    const forLift = await add(maint, { kind: 'lift', assetId: lift.id });
    assert.equal(forLift.register, 'facility');
    assert.equal(forLift.assetCode, lift.assetCode);
    const site = await add(admin, { kind: 'fire_noc' });
    assert.equal(site.register, 'facility');
    const aerb = await add(biomed, { kind: 'aerb' });
    assert.equal(aerb.register, 'biomedical');
    // Each team sees its own; the HOD sees all.
    const mine = (await list(maint)).map((l) => l.id);
    assert.ok(mine.includes(forLift.id) && mine.includes(site.id) && !mine.includes(aerb.id));
    assert.ok(!(await list(biomed)).some((l) => l.id === forLift.id));
    assert.equal((await list(admin)).length >= 3, true);
    assert.equal((await call(base, nurse, 'GET', '/licences')).status, 403);
    // Biomedical staff cannot file a licence against the facility register.
    assert.equal((await call(base, biomed, 'POST', '/licences', { kind: 'other', name: `${PREFIX}x`, authority: 'A', validTo: addDaysISO(todayISO(), 30), register: 'facility' })).status, 400);
  });

  it('read valid, ending or expired, and a renewal replaces the old one, which stays as history', async () => {
    const ending = await add(maint, { validTo: addDaysISO(todayISO(), 10) });
    const expired = await add(maint, { validTo: addDaysISO(todayISO(), -3) });
    assert.equal(ending.status, 'ending');
    assert.equal(expired.status, 'expired');
    assert.equal(expired.daysLeft, -3);
    assert.equal((await call(base, maint, 'POST', `/licences/${expired.id}/renew`, { validTo: addDaysISO(todayISO(), -10) })).status, 400);
    const renewed = await call(base, maint, 'POST', `/licences/${expired.id}/renew`, { number: 'NEW-1', validFrom: todayISO(), validTo: addDaysISO(todayISO(), 365) });
    assert.equal(renewed.status, 201);
    const next = (await renewed.json()) as LicenceRow;
    assert.equal(next.renewsId, expired.id);
    assert.equal(next.status, 'valid');
    assert.equal((await list(maint)).find((l) => l.id === expired.id)?.status, 'renewed');
    assert.equal((await call(base, maint, 'POST', `/licences/${expired.id}/renew`, { validTo: addDaysISO(todayISO(), 400) })).status, 409);
    const attention = (await list(maint, '?status=attention')).map((l) => l.id);
    assert.ok(attention.includes(ending.id) && !attention.includes(expired.id) && !attention.includes(next.id));
    // History stays: the renewed one cannot be deleted.
    assert.equal((await call(base, admin, 'DELETE', `/licences/${expired.id}`)).status, 409);
  });

  it('remind the team at the lead days and once when expired, and stop once renewed', async () => {
    const ending = await add(maint, { validTo: addDaysISO(todayISO(), 4) });
    const expired = await add(maint, { validTo: addDaysISO(todayISO(), -1) });
    await generateReminders(todayISO());
    await generateReminders(todayISO()); // again: nothing new
    const notes = await prisma.notification.findMany({ where: { userId: ids.maintUser, licenceId: { in: [ending.id, expired.id] } } });
    assert.equal(notes.filter((x) => x.licenceId === ending.id).length, 1);
    assert.match(notes.find((x) => x.licenceId === expired.id)?.message ?? '', /expired/);
    assert.equal(notes.filter((x) => x.licenceId === expired.id).length, 1);
    await call(base, maint, 'POST', `/licences/${ending.id}/renew`, { validTo: addDaysISO(todayISO(), 365) });
    assert.equal(await prisma.notification.count({ where: { licenceId: ending.id, readAt: null } }), 0);
    const biomedUser = await prisma.user.findUniqueOrThrow({ where: { email: 'biomed@demo.local' } });
    assert.equal(await prisma.notification.count({ where: { userId: biomedUser.id, licenceId: expired.id } }), 0, 'the other team is not told');
  });

  it('carry their documents, and are in the compliance register', async () => {
    const l = await add(maint, { kind: 'peso', validTo: addDaysISO(todayISO(), 5) });
    const form = new FormData();
    form.set('ownerType', 'licence');
    form.set('ownerId', l.id);
    form.set('kind', 'certificate');
    form.set('file', new Blob([PNG], { type: 'image/png' }), 'peso.png');
    assert.equal((await fetch(`${base}/attachments`, { method: 'POST', headers: { cookie: maint }, body: form })).status, 201);
    assert.equal((await call(base, biomed, 'GET', `/attachments?ownerType=licence&ownerId=${l.id}`)).status, 404); // the other team's: as if missing
    const report = (await (await call(base, admin, 'GET', '/reports/compliance?format=json')).json()) as ReportData;
    const row = report.sheets.find((s) => s.name === 'Expired or ending')!.rows.find((r) => r.name === l.name);
    assert.equal(row?.status, 'Ending soon');
    assert.equal(row?.docs, 1);
    // A licence with documents is a record: corrected, not deleted.
    assert.equal((await call(base, admin, 'DELETE', `/licences/${l.id}`)).status, 409);
  });

  it('do not exist while the add-on is off', async () => {
    await prisma.hospitalSettings.updateMany({ data: { facilityEnabled: false } });
    try {
      assert.equal((await call(base, admin, 'GET', '/licences')).status, 404);
    } finally {
      await prisma.hospitalSettings.updateMany({ data: { facilityEnabled: true } });
    }
  });
});
