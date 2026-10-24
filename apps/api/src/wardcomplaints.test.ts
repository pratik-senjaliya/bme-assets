// Facility maintenance add-on, F2 (docs/requirements-facility.md, decisions I and J): a ward raises a fault without a
// machine (a trade at a location), it reaches the trade's team and follows the usual workflow without downtime, the
// response target is flagged, and medical gases move between teams with one setting. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import type { AssetRow, ComplaintRow, Paged, ReportData, TradeRow } from '@bme/shared';
import { ensureRolesAndPermissions, ensureStarterTrades, ensureStarterTypes } from './lib/baseData';
import { addDaysISO, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { call, login, PASSWORD, PNG, startServer } from './testUtils';

const PREFIX = 'WARDTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let maint = '';
let nurse = '';
let superAdmin = '';
const ids = { icu: '', icu1: '', otherLoc: '', plumbing: '', gasTrade: '', maintUser: '' };

async function cleanUp() {
  const assets = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const complaints = (await prisma.complaint.findMany({ where: { OR: [{ description: { startsWith: PREFIX } }, { assetId: { in: assets } }] }, select: { id: true } })).map((c) => c.id);
  await prisma.attachment.deleteMany({ where: { ownerType: 'complaint', ownerId: { in: complaints } } });
  await prisma.notification.deleteMany({ where: { OR: [{ complaintId: { in: complaints } }, { assetId: { in: assets } }, { message: { contains: 'Medical gases are now' } }] } });
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: [...assets, ...complaints] } } });
  await prisma.complaintStep.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.serviceExpense.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.complaint.deleteMany({ where: { id: { in: complaints } } });
  await prisma.asset.deleteMany({ where: { id: { in: assets } } });
  await prisma.equipmentType.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.trade.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

const settings = (data: { facilityEnabled?: boolean; medicalGasRegister?: 'biomedical' | 'facility' }) => prisma.hospitalSettings.updateMany({ data });

before(async () => {
  await cleanUp();
  await ensureRolesAndPermissions();
  await settings({ facilityEnabled: true, medicalGasRegister: 'biomedical' });
  await prisma.trade.updateMany({ where: { medicalGas: true }, data: { register: 'biomedical' } });
  await prisma.equipmentType.updateMany({ where: { medicalGas: true }, data: { register: 'biomedical' } });
  await ensureStarterTypes();
  await ensureStarterTrades();
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'maintenance' } });
  await prisma.user.upsert({ where: { email: 'maintenance@demo.local' }, update: {}, create: { name: 'Suresh Mehta', email: 'maintenance@demo.local', roleId: role.id, passwordHash: await bcrypt.hash(PASSWORD, 10) } });
  ({ server, base } = startServer());
  [admin, biomed, maint, nurse, superAdmin] = await Promise.all(['admin', 'biomed', 'maintenance', 'nursing', 'superadmin'].map((r) => login(base, `${r}@demo.local`)));
  ids.icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
  ids.icu1 = (await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })).id;
  ids.otherLoc = (await prisma.location.findFirstOrThrow({ where: { departmentId: { not: ids.icu } } })).id;
  ids.plumbing = (await prisma.trade.findUniqueOrThrow({ where: { name: 'Plumbing and water' } })).id;
  ids.gasTrade = (await prisma.trade.findFirstOrThrow({ where: { medicalGas: true } })).id;
  ids.maintUser = (await prisma.user.findUniqueOrThrow({ where: { email: 'maintenance@demo.local' } })).id;
});
after(async () => {
  await settings({ facilityEnabled: true, medicalGasRegister: 'biomedical' });
  await prisma.trade.updateMany({ where: { medicalGas: true }, data: { register: 'biomedical' } });
  await prisma.equipmentType.updateMany({ where: { medicalGas: true }, data: { register: 'biomedical' } });
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const raise = (who: string, body: object) => call(base, who, 'POST', '/complaints', { description: `${PREFIX}${++n} tap leaking`, ...body });
const raiseOk = async (who: string, body: object) => {
  const res = await raise(who, body);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as ComplaintRow;
};
const board = async (who: string) => ((await (await call(base, who, 'GET', `/complaints?pageSize=100&search=${PREFIX}`)).json()) as Paged<ComplaintRow>).items.map((c) => c.id);
const report = async (type: string) => (await (await call(base, admin, 'GET', `/reports/${type}?format=json&from=${addDaysISO(todayISO(), -1)}&to=${todayISO()}`)).json()) as ReportData;

describe('Ward complaints without a machine', () => {
  it('only exist while the add-on is on', async () => {
    await settings({ facilityEnabled: false });
    try {
      assert.deepEqual(await (await call(base, nurse, 'GET', '/trades')).json(), []);
      assert.equal((await raise(nurse, { tradeId: ids.plumbing, locationId: ids.icu1 })).status, 400);
    } finally {
      await settings({ facilityEnabled: true });
    }
    const trades = (await (await call(base, nurse, 'GET', '/trades')).json()) as TradeRow[];
    assert.ok(trades.some((t) => t.name === 'Plumbing and water'));
  });

  it('need a trade and a place in the ward', async () => {
    const res = await raise(nurse, { tradeId: ids.plumbing });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error.details.fieldErrors.locationId);
    // Another department's place is not the ward's to report.
    assert.equal((await raise(nurse, { tradeId: ids.plumbing, locationId: ids.otherLoc })).status, 400);
  });

  it('reach the trade’s team, follow the workflow and have a resolution time but no downtime', async () => {
    const c = await raiseOk(nurse, { tradeId: ids.plumbing, locationId: ids.icu1, urgent: true });
    assert.equal(c.register, 'facility');
    assert.equal(c.departmentId, ids.icu);
    assert.equal(c.assetId, null);
    assert.equal(c.tradeName, 'Plumbing and water');
    assert.equal(c.locationName, 'ICU 1');
    assert.match(c.subject, /Plumbing and water · ICU 1/);
    assert.ok((await board(maint)).includes(c.id), 'maintenance board misses it');
    assert.ok(!(await board(biomed)).includes(c.id), 'biomedical board shows it');
    const notice = await prisma.notification.findFirst({ where: { userId: ids.maintUser, complaintId: c.id } });
    assert.match(notice?.message ?? '', /URGENT.*Plumbing and water · ICU 1/);

    assert.equal((await call(base, maint, 'POST', `/complaints/${c.id}/start`, {})).status, 200);
    // A part bought for a ward fault is booked on the complaint itself (it has no machine).
    const resolved = (await (await call(base, maint, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Washer replaced', costs: [{ type: 'spare_part', description: 'Washer', amount: 20 }] })).json()) as ComplaintRow;
    assert.deepEqual((await prisma.serviceExpense.findMany({ where: { complaintId: c.id } })).map((e) => [e.assetId, Number(e.amount)]), [[null, 20]]);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.downtimeSeconds, null);
    assert.ok(resolved.resolutionSeconds != null);
    assert.equal((await call(base, nurse, 'POST', `/complaints/${c.id}/close`, {})).status, 200);
  });

  it('take photos from the ward', async () => {
    const c = await raiseOk(nurse, { tradeId: ids.plumbing, locationId: ids.icu1 });
    const form = new FormData();
    form.set('ownerType', 'complaint');
    form.set('ownerId', c.id);
    form.set('kind', 'photo');
    form.set('file', new Blob([PNG], { type: 'image/png' }), 'leak.png');
    const up = await fetch(`${base}/attachments`, { method: 'POST', headers: { cookie: nurse }, body: form });
    assert.equal(up.status, 201, await up.clone().text());
    const files = (await (await call(base, maint, 'GET', `/attachments?ownerType=complaint&ownerId=${c.id}`)).json()) as { id: string }[];
    assert.equal(files.length, 1);
    assert.equal((await call(base, maint, 'GET', `/attachments/${files[0].id}/download`)).status, 200);
    assert.equal((await call(base, biomed, 'GET', `/attachments/${files[0].id}/download`)).status, 404);
  });

  it('are flagged when work starts later than the trade’s response target', async () => {
    const trade = (await (await call(base, admin, 'POST', '/trades', { name: `${PREFIX}Electrical`, responseHours: 1 })).json()) as TradeRow;
    const c = await raiseOk(nurse, { tradeId: trade.id, locationId: ids.icu1 });
    assert.equal(c.overResponseTarget, false);
    await prisma.complaint.update({ where: { id: c.id }, data: { raisedAt: new Date(Date.now() - 2 * 3_600_000) } });
    const late = (await (await call(base, maint, 'GET', `/complaints/${c.id}`)).json()) as ComplaintRow;
    assert.equal(late.overResponseTarget, true);
    assert.equal(late.responseTargetHours, 1);
  });

  it('are counted in the trades report, not as breakdowns', async () => {
    const c = await raiseOk(nurse, { tradeId: ids.plumbing, locationId: ids.icu1 });
    const trades = await report('trades');
    assert.ok(trades.sheets.find((s) => s.name === 'Complaints')!.rows.some((r) => r.no === c.complaintNo));
    assert.ok(trades.sheets.find((s) => s.name === 'By trade')!.rows.some((r) => r.name === 'Plumbing and water'));
    const breakdowns = await report('breakdowns');
    assert.ok(!breakdowns.sheets[0].rows.some((r) => r.no === c.complaintNo));
  });

  it('can be deleted through the HOD when raised by mistake', async () => {
    const c = await raiseOk(nurse, { tradeId: ids.plumbing, locationId: ids.icu1 });
    const req = await call(base, maint, 'POST', '/approvals/delete', { targetType: 'complaint', targetId: c.id, reason: 'Raised twice by the ward' });
    assert.equal(req.status, 201, await req.clone().text());
  });
});

describe('Trades in Setup', () => {
  it('names are unique, a used trade is switched off rather than deleted, and the gas trade stays', async () => {
    assert.equal((await call(base, admin, 'POST', '/trades', { name: 'plumbing AND water' })).status, 409);
    assert.equal((await call(base, admin, 'DELETE', `/trades/${ids.plumbing}`)).status, 409);
    assert.equal((await call(base, admin, 'DELETE', `/trades/${ids.gasTrade}`)).status, 409);
    const spare = (await (await call(base, admin, 'POST', '/trades', { name: `${PREFIX}Spare` })).json()) as TradeRow;
    assert.equal((await call(base, admin, 'DELETE', `/trades/${spare.id}`)).status, 204);
    // Nursing cannot change trades.
    assert.equal((await call(base, nurse, 'POST', '/trades', { name: `${PREFIX}Nope` })).status, 403);
  });
});

describe('Medical gases (decision I)', () => {
  it('a gas type takes the gas team; switching the setting moves equipment, the gas trade and open complaints', async () => {
    const typeRes = await call(base, admin, 'POST', '/equipment-types', { name: `${PREFIX}Vacuum`, code: 'WTVAC', medicalGas: true, register: 'facility' });
    assert.equal(typeRes.status, 201, await typeRes.clone().text());
    const type = await typeRes.json();
    assert.equal(type.register, 'biomedical');
    const pump = (await (await call(base, biomed, 'POST', '/assets', { equipmentTypeId: type.id, name: `${PREFIX}Vacuum pump`, departmentId: ids.icu, locationId: ids.icu1 })).json()) as AssetRow;
    const onPump = await raiseOk(nurse, { assetId: pump.id });
    await call(base, biomed, 'POST', `/complaints/${onPump.id}/assign`, { userId: (await prisma.user.findUniqueOrThrow({ where: { email: 'biomed@demo.local' } })).id });
    const outlet = await raiseOk(nurse, { tradeId: ids.gasTrade, locationId: ids.icu1 });
    assert.equal(outlet.register, 'biomedical');

    const moved = await call(base, admin, 'PUT', '/settings', { medicalGasRegister: 'facility' });
    assert.equal(moved.status, 200, await moved.clone().text());
    assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: pump.id } })).register, 'facility');
    assert.equal((await prisma.trade.findUniqueOrThrow({ where: { id: ids.gasTrade } })).register, 'facility');
    const c = await prisma.complaint.findUniqueOrThrow({ where: { id: onPump.id } });
    assert.equal(c.register, 'facility');
    assert.equal(c.assignedToId, null, 'the other team takes it');
    assert.equal((await prisma.complaint.findUniqueOrThrow({ where: { id: outlet.id } })).register, 'facility');
    assert.ok((await board(maint)).includes(onPump.id));
    assert.ok(!(await board(biomed)).includes(onPump.id));
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'medical_gas.move' }, orderBy: { at: 'desc' } }));
    assert.ok(await prisma.notification.findFirst({ where: { message: { contains: 'Medical gases are now looked after by the maintenance team' } } }));

    // The add-on cannot go off while maintenance holds the gases.
    assert.equal((await call(base, superAdmin, 'PUT', '/settings', { facilityEnabled: false })).status, 409);

    assert.equal((await call(base, admin, 'PUT', '/settings', { medicalGasRegister: 'biomedical' })).status, 200);
    assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: pump.id } })).register, 'biomedical');
  });

  it('a type with equipment cannot be marked as medical gas when that moves it to the other team', async () => {
    await settings({ medicalGasRegister: 'facility' });
    try {
      const type = await (await call(base, admin, 'POST', '/equipment-types', { name: `${PREFIX}Compressor`, code: 'WTCMP' })).json();
      await call(base, biomed, 'POST', '/assets', { equipmentTypeId: type.id, name: `${PREFIX}Compressor 1`, departmentId: ids.icu, locationId: ids.icu1 });
      const res = await call(base, admin, 'PATCH', `/equipment-types/${type.id}`, { medicalGas: true });
      assert.equal(res.status, 409);
      assert.ok((await res.json()).error.details.fieldErrors.medicalGas);
    } finally {
      await settings({ medicalGasRegister: 'biomedical' });
    }
  });
});
