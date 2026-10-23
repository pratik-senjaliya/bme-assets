// Facility maintenance add-on, F1 (docs/requirements-facility.md, decisions G, H, K): every machine belongs to a
// register, each team sees and hears about its own register only, wards see both in their department, the HOD sees
// everything, and only the super admin switches the add-on. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import type { AssetRow, Assignee, ComplaintRow, ConsumableRow, DueRow, Paged, SessionUser } from '@bme/shared';
import { ensureRolesAndPermissions, ensureStarterTypes } from './lib/baseData';
import { addDaysISO, parseDate, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { generateReminders } from './modules/reminders/reminders.service';
import { call, login, PASSWORD, startServer } from './testUtils';

const PREFIX = 'FACTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let maint = '';
let nurse = '';
let superAdmin = '';
const ids = { vent: '', dg: '', ahu: '', icu: '', icu1: '', eng: '', engLoc: '', maintUser: '', biomedUser: '' };

async function cleanUp() {
  const assets = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const items = (await prisma.consumableItem.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((i) => i.id);
  await prisma.consumableMovement.deleteMany({ where: { OR: [{ itemId: { in: items } }, { assetId: { in: assets } }] } });
  await prisma.consumableItem.deleteMany({ where: { id: { in: items } } });
  await prisma.notification.deleteMany({ where: { OR: [{ message: { contains: PREFIX } }, { assetId: { in: assets } }] } });
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: assets } } });
  const complaints = (await prisma.complaint.findMany({ where: { assetId: { in: assets } }, select: { id: true } })).map((c) => c.id);
  await prisma.complaintStep.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.complaint.deleteMany({ where: { id: { in: complaints } } });
  await prisma.asset.deleteMany({ where: { id: { in: assets } } });
  await prisma.equipmentType.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX.toLowerCase() } } });
}

const facility = (enabled: boolean) => prisma.hospitalSettings.updateMany({ data: { facilityEnabled: enabled } });

before(async () => {
  await cleanUp();
  await ensureRolesAndPermissions(); // the maintenance role and register.* on a database seeded before they existed
  await ensureStarterTypes('facility');
  await facility(true);
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'maintenance' } });
  await prisma.user.upsert({ where: { email: 'maintenance@demo.local' }, update: {}, create: { name: 'Suresh Mehta', email: 'maintenance@demo.local', roleId: role.id, passwordHash: await bcrypt.hash(PASSWORD, 10) } });
  ({ server, base } = startServer());
  [admin, biomed, maint, nurse, superAdmin] = await Promise.all(['admin', 'biomed', 'maintenance', 'nursing', 'superadmin'].map((r) => login(base, `${r}@demo.local`)));
  ids.vent = (await prisma.equipmentType.findFirstOrThrow({ where: { code: 'VENT' } })).id;
  ids.dg = (await prisma.equipmentType.findFirstOrThrow({ where: { code: 'DG' } })).id;
  ids.ahu = (await prisma.equipmentType.findFirstOrThrow({ where: { code: 'AHU' } })).id;
  ids.icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
  ids.icu1 = (await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })).id;
  ids.eng = (await prisma.department.findFirstOrThrow({ where: { code: { not: 'ICU' } } })).id;
  ids.engLoc = (await prisma.location.findFirstOrThrow({ where: { departmentId: ids.eng } })).id;
  ids.maintUser = (await prisma.user.findUniqueOrThrow({ where: { email: 'maintenance@demo.local' } })).id;
  ids.biomedUser = (await prisma.user.findUniqueOrThrow({ where: { email: 'biomed@demo.local' } })).id;
});
after(async () => {
  await facility(true);
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const makeAsset = async (who: string, equipmentTypeId: string, departmentId = ids.icu, locationId = ids.icu1, extra: object = {}) => {
  const res = await call(base, who, 'POST', '/assets', { equipmentTypeId, name: `${PREFIX}${++n}`, departmentId, locationId, ...extra });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as AssetRow;
};
const list = async (who: string, query = '') => ((await (await call(base, who, 'GET', `/assets?status=all&pageSize=100&search=${PREFIX}${query}`)).json()) as Paged<AssetRow>).items.map((a) => a.id);

describe('Two registers, two teams', () => {
  it('each team registers and sees only its own equipment; the ward sees both in its department; the HOD sees all', async () => {
    const vent = await makeAsset(biomed, ids.vent);
    const ahu = await makeAsset(maint, ids.ahu); // facility equipment in the ICU (the ward's AC)
    assert.equal(vent.register, 'biomedical');
    assert.equal(ahu.register, 'facility');

    assert.deepEqual(await list(biomed), [vent.id]);
    assert.deepEqual(await list(maint), [ahu.id]);
    assert.deepEqual((await list(nurse)).sort(), [vent.id, ahu.id].sort());
    assert.deepEqual((await list(admin)).sort(), [vent.id, ahu.id].sort());
    assert.deepEqual(await list(admin, '&register=facility'), [ahu.id], 'the HOD can look at one team');
    assert.deepEqual(await list(biomed, '&register=facility'), [], 'a filter never widens what someone sees');

    // A foreign machine looks like a missing one, by id and by its label.
    assert.equal((await call(base, biomed, 'GET', `/assets/${ahu.id}`)).status, 404);
    assert.equal((await call(base, maint, 'GET', `/assets/${vent.id}`)).status, 404);
    assert.equal((await call(base, biomed, 'GET', `/assets/by-code/${ahu.assetCode}`)).status, 404);
    assert.equal((await call(base, maint, 'PATCH', `/assets/${vent.id}`, { name: 'x' })).status, 404);
    assert.equal((await call(base, nurse, 'GET', `/assets/${ahu.id}`)).status, 200);
  });

  it('a team cannot register the other team’s equipment, nor move a machine to a type of the other register', async () => {
    const res = await call(base, biomed, 'POST', '/assets', { equipmentTypeId: ids.dg, name: `${PREFIX}dg`, departmentId: ids.eng, locationId: ids.engLoc });
    assert.equal(res.status, 403);
    assert.ok((await res.json()).error.details.fieldErrors.equipmentTypeId);
    const vent = await makeAsset(biomed, ids.vent);
    const move = await call(base, admin, 'PATCH', `/assets/${vent.id}`, { equipmentTypeId: ids.dg });
    assert.equal(move.status, 400);
    assert.ok((await move.json()).error.details.fieldErrors.equipmentTypeId);

    const types = (await (await call(base, maint, 'GET', '/equipment-types')).json()) as { register: string }[];
    assert.ok(types.length > 0 && types.every((t) => t.register === 'facility'), 'maintenance staff are offered facility types only');
  });

  it('a type keeps its register once equipment of it exists', async () => {
    const t = await (await call(base, admin, 'POST', '/equipment-types', { name: `${PREFIX}Fire pump`, code: 'FTFP', defaultPmsMonths: 1, register: 'facility' })).json();
    assert.equal(t.register, 'facility');
    assert.equal((await call(base, admin, 'PATCH', `/equipment-types/${t.id}`, { register: 'biomedical' })).status, 200, 'free while unused');
    assert.equal((await call(base, admin, 'PATCH', `/equipment-types/${t.id}`, { register: 'facility' })).status, 200);
    await makeAsset(maint, t.id, ids.eng, ids.engLoc);
    const locked = await call(base, admin, 'PATCH', `/equipment-types/${t.id}`, { register: 'biomedical' });
    assert.equal(locked.status, 409);
  });
});

describe('Complaints go to the right team', () => {
  it('the ward raises one on facility equipment: the maintenance team hears and sees it, the biomedical team does not', async () => {
    const ahu = await makeAsset(maint, ids.ahu);
    const res = await call(base, nurse, 'POST', '/complaints', { assetId: ahu.id, description: `${PREFIX}AC not cooling` });
    assert.equal(res.status, 201);
    const c = (await res.json()) as ComplaintRow;
    assert.equal(c.register, 'facility');

    const heard = await prisma.notification.findMany({ where: { message: { contains: `${PREFIX}AC not cooling` } }, select: { userId: true } });
    assert.ok(heard.some((x) => x.userId === ids.maintUser), 'maintenance told');
    assert.ok(!heard.some((x) => x.userId === ids.biomedUser), 'biomedical not told');

    const seen = async (who: string) => ((await (await call(base, who, 'GET', `/complaints?search=${PREFIX}`)).json()) as Paged<ComplaintRow>).items.map((x) => x.id);
    assert.ok((await seen(maint)).includes(c.id));
    assert.ok(!(await seen(biomed)).includes(c.id));
    assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/start`, {})).status, 404);

    // The HOD gives it to the maintenance team only.
    const people = (await (await call(base, admin, 'GET', '/complaints/assignees')).json()) as Assignee[];
    assert.deepEqual(people.find((p) => p.id === ids.maintUser)?.registers, ['facility']);
    assert.deepEqual(people.find((p) => p.id === ids.biomedUser)?.registers, ['biomedical']);
    assert.equal((await call(base, admin, 'POST', `/complaints/${c.id}/assign`, { userId: ids.biomedUser })).status, 400);
    assert.equal((await call(base, admin, 'POST', `/complaints/${c.id}/assign`, { userId: ids.maintUser })).status, 200);
    assert.equal((await call(base, maint, 'POST', `/complaints/${c.id}/start`, {})).status, 200);
  });
});

describe('Due lists, reminders and stores follow the register', () => {
  it('PMS due and the daily reminder reach the team of the machine', async () => {
    const today = todayISO();
    const dg = await makeAsset(maint, ids.dg, ids.eng, ids.engLoc);
    await prisma.asset.update({ where: { id: dg.id }, data: { nextPmsDue: parseDate(addDaysISO(today, 3)) } });
    const due = async (who: string) => ((await (await call(base, who, 'GET', '/pms/due')).json()) as DueRow[]).map((d) => d.assetId);
    assert.ok((await due(maint)).includes(dg.id));
    assert.ok(!(await due(biomed)).includes(dg.id));

    await generateReminders(today);
    const told = await prisma.notification.findMany({ where: { assetId: dg.id, type: 'pms' }, select: { userId: true } });
    assert.ok(told.some((x) => x.userId === ids.maintUser));
    assert.ok(!told.some((x) => x.userId === ids.biomedUser));
  });

  it('each team keeps its own consumables store', async () => {
    const add = async (who: string) => (await (await call(base, who, 'POST', '/consumables', { name: `${PREFIX}${++n} item`, openingStock: 5 })).json()) as ConsumableRow;
    const bulb = await add(maint);
    const probe = await add(biomed);
    assert.deepEqual([bulb.register, probe.register], ['facility', 'biomedical']);
    const names = async (who: string) => ((await (await call(base, who, 'GET', `/consumables?search=${PREFIX}`)).json()) as ConsumableRow[]).map((i) => i.id);
    assert.deepEqual(await names(maint), [bulb.id]);
    assert.deepEqual(await names(biomed), [probe.id]);
    assert.equal((await call(base, biomed, 'GET', `/consumables/${bulb.id}`)).status, 404);
    // A part from one store is not given out for the other team's machine.
    const vent = await makeAsset(biomed, ids.vent);
    const wrong = await call(base, admin, 'POST', `/consumables/${bulb.id}/issue`, { quantity: 1, date: todayISO(), departmentId: ids.icu, assetId: vent.id, reason: 'Replaced the fused one' });
    assert.equal(wrong.status, 400);
  });
});

describe('The add-on switch', () => {
  it('only the super admin switches it; off, facility equipment and the maintenance role disappear', async () => {
    const ahu = await makeAsset(maint, ids.ahu);
    assert.equal((await call(base, admin, 'PUT', '/settings', { facilityEnabled: false })).status, 403);
    assert.equal((await call(base, superAdmin, 'PUT', '/settings', { facilityEnabled: false })).status, 200);
    try {
      assert.equal((await (await call(base, admin, 'GET', '/hospital')).json()).facilityEnabled, false);
      const me = (await (await call(base, admin, 'GET', '/auth/me')).json()) as SessionUser;
      assert.deepEqual(me.registers, ['biomedical']);
      assert.ok(!(await list(admin)).includes(ahu.id), 'facility equipment is out of sight');
      assert.ok(!(await list(nurse)).includes(ahu.id));
      assert.equal((await call(base, maint, 'GET', `/assets/${ahu.id}`)).status, 404);
      const roles = (await (await call(base, admin, 'GET', '/roles')).json()) as { name: string }[];
      assert.ok(!roles.some((r) => r.name === 'maintenance'));
      const add = await call(base, admin, 'POST', '/users', { name: `${PREFIX}fitter`, email: `${PREFIX.toLowerCase()}fitter@demo.local`, role: 'maintenance', password: 'Fitter@1234' });
      assert.equal(add.status, 400);
    } finally {
      assert.equal((await call(base, superAdmin, 'PUT', '/settings', { facilityEnabled: true })).status, 200);
    }
    assert.ok((await list(admin)).includes(ahu.id));
  });

  it('a maintenance engineer can be the deputy HOD', async () => {
    const res = await call(base, admin, 'POST', '/users', { name: `${PREFIX}deputy`, email: `${PREFIX.toLowerCase()}deputy@demo.local`, role: 'maintenance', deputy: true, password: 'Deputy@1234' });
    assert.equal(res.status, 201, await res.clone().text());
    assert.equal((await res.json()).deputy, true);
  });
});
