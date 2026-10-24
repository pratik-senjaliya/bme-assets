// Pending improvements (review of 24 Oct 2026): starter types for fire pump, medical air and vacuum; the trade filter on
// complaint lists; costs on ward complaints without a machine; the sign-in lock kept in the database; the session's end
// time and "Stay signed in". Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ComplaintRow, Paged, ReportData, SessionUser } from '@bme/shared';
import { ensureRolesAndPermissions, ensureStarterTrades, ensureStarterTypes } from './lib/baseData';
import { config } from './lib/config';
import { todayISO } from './lib/dates';
import { resetLoginThrottle } from './lib/loginThrottle';
import { prisma } from './lib/prisma';
import { call, login, PASSWORD, startServer } from './testUtils';

const PREFIX = 'IMPTEST-';
const EMAIL = 'imptest-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let maint = '';
let nurse = '';
const ids = { vent: '', icu: '', icu1: '', plumbing: '' };

async function cleanUp() {
  const assets = (await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const complaints = (await prisma.complaint.findMany({ where: { OR: [{ assetId: { in: assets } }, { description: { startsWith: PREFIX } }] }, select: { id: true } })).map((c) => c.id);
  await prisma.notification.deleteMany({ where: { OR: [{ assetId: { in: assets } }, { complaintId: { in: complaints } }] } });
  await prisma.serviceExpense.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.complaintStep.deleteMany({ where: { complaintId: { in: complaints } } });
  await prisma.complaint.deleteMany({ where: { id: { in: complaints } } });
  await prisma.asset.deleteMany({ where: { id: { in: assets } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL } } });
  await prisma.loginAttempt.deleteMany({ where: { key: { startsWith: EMAIL } } });
}

before(async () => {
  await cleanUp();
  await ensureRolesAndPermissions();
  await prisma.hospitalSettings.updateMany({ data: { facilityEnabled: true } });
  await ensureStarterTypes();
  await ensureStarterTrades();
  ({ server, base } = startServer());
  [admin, biomed, maint, nurse] = await Promise.all(['admin', 'biomed', 'maintenance', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  ids.vent = (await prisma.equipmentType.findUniqueOrThrow({ where: { code: 'VENT' } })).id;
  ids.icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
  ids.icu1 = (await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })).id;
  ids.plumbing = (await prisma.trade.findUniqueOrThrow({ where: { name: 'Plumbing and water' } })).id;
});
after(async () => {
  await cleanUp();
  await resetLoginThrottle();
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const wardFault = async () => {
  const res = await call(base, nurse, 'POST', '/complaints', { tradeId: ids.plumbing, locationId: ids.icu1, description: `${PREFIX}${++n} tap leaking` });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as ComplaintRow;
};
const machineFault = async () => {
  const a = await (await call(base, admin, 'POST', '/assets', { equipmentTypeId: ids.vent, name: `${PREFIX}vent ${++n}`, departmentId: ids.icu, locationId: ids.icu1 })).json();
  const res = await call(base, nurse, 'POST', '/complaints', { assetId: a.id, description: `${PREFIX}${n} alarm sounding` });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as ComplaintRow;
};

describe('Starter types', () => {
  it('include a fire pump for maintenance, and medical air and vacuum with the medical gas team, each with a checklist', async () => {
    const { medicalGasRegister } = await prisma.hospitalSettings.findFirstOrThrow({ select: { medicalGasRegister: true } });
    const types = await prisma.equipmentType.findMany({ where: { code: { in: ['FIREP', 'MAC', 'MVP'] } }, include: { pmsTemplates: true }, orderBy: { code: 'asc' } });
    assert.deepEqual(types.map((t) => [t.code, t.register, t.medicalGas]), [['FIREP', 'facility', false], ['MAC', medicalGasRegister, true], ['MVP', medicalGasRegister, true]]);
    for (const t of types) assert.ok((t.pmsTemplates[0]?.schema as { items: unknown[] }).items.length >= 4, `${t.code} has no checklist`);
  });
});

describe('Trade filter', () => {
  it('lists one trade’s ward faults, or only complaints about a machine', async () => {
    const ward = await wardFault();
    const machine = await machineFault();
    const list = async (q: string) => ((await (await call(base, admin, 'GET', `/complaints?search=${PREFIX}&pageSize=100&${q}`)).json()) as Paged<ComplaintRow>).items.map((c) => c.id);
    const byTrade = await list(`tradeId=${ids.plumbing}`);
    assert.ok(byTrade.includes(ward.id) && !byTrade.includes(machine.id));
    const machines = await list('tradeId=none');
    assert.ok(machines.includes(machine.id) && !machines.includes(ward.id));
  });
});

describe('Costs on a ward complaint', () => {
  it('are booked on the complaint without a machine, show in the expenses report and stay with that team', async () => {
    const c = await wardFault();
    assert.equal((await call(base, maint, 'POST', `/complaints/${c.id}/start`, {})).status, 200);
    const res = await call(base, maint, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'Changed the tap', costs: [{ type: 'spare_part', description: `${PREFIX}tap`, amount: 850, vendor: 'Local hardware' }] });
    assert.equal(res.status, 200, await res.clone().text());
    const [e] = await prisma.serviceExpense.findMany({ where: { complaintId: c.id } });
    assert.deepEqual([e.assetId, Number(e.amount)], [null, 850]);

    const report = async (who: string) => ((await (await call(base, who, 'GET', `/reports/expenses?format=json&from=${todayISO()}&to=${todayISO()}`)).json()) as ReportData).sheets[0].rows;
    const row = (await report(admin)).find((r) => r.desc === `${PREFIX}tap`);
    assert.ok(row, 'the HOD does not see the ward cost');
    assert.equal(row.status, 'Ward complaint');
    assert.match(String(row.name), /Plumbing and water/);
    assert.ok(!(await report(biomed)).some((r) => r.desc === `${PREFIX}tap`), 'the biomedical team sees the maintenance team’s cost');
    // The complaint's own story shows it to those who see costs.
    const detail = await (await call(base, maint, 'GET', `/complaints/${c.id}`)).json();
    assert.equal(detail.expenses.length, 1);
  });

  it('are refused by the database without a machine or a complaint', async () => {
    await assert.rejects(prisma.serviceExpense.create({ data: { type: 'repair', description: `${PREFIX}nothing`, amount: 1, date: new Date() } }));
  });
});

describe('The sign-in lock', () => {
  it('is kept in the database, so a restart does not lift it', async () => {
    const key = `${EMAIL}nobody@demo.local`;
    const attempt = () => fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: key, password: 'wrong' }) });
    for (let i = 0; i < config.loginMaxFailures; i++) assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 429);
    const row = await prisma.loginAttempt.findUniqueOrThrow({ where: { key } });
    assert.ok(row.lockedUntil && row.lockedUntil > new Date(), 'no lock stored');
  });
});

describe('Session end', () => {
  it('sign-in tells when the session ends; "Stay signed in" starts a fresh one, only for an active login', async () => {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'biomed@demo.local', password: PASSWORD }) });
    const ends = Date.parse(((await res.json()) as SessionUser).sessionEndsAt!);
    assert.ok(Math.abs(ends - (Date.now() + config.sessionHours * 3_600_000)) < 60_000, 'end time is not 12 hours away');
    const me = (await (await call(base, biomed, 'GET', '/auth/me')).json()) as SessionUser;
    assert.ok(me.sessionEndsAt);

    await new Promise((r) => setTimeout(r, 1100)); // tokens count whole seconds
    const refreshed = await call(base, biomed, 'POST', '/auth/refresh');
    assert.equal(refreshed.status, 200);
    const cookie = (refreshed.headers.get('set-cookie') ?? '').split(';')[0];
    const later = Date.parse(((await refreshed.json()) as { sessionEndsAt: string }).sessionEndsAt);
    assert.ok(later > Date.parse(me.sessionEndsAt!), 'the session was not extended');
    assert.equal((await call(base, cookie, 'GET', '/assets?pageSize=1')).status, 200);

    // A login deactivated meanwhile cannot carry on.
    const made = await (await call(base, admin, 'POST', '/users', { name: `${PREFIX}leaving`, email: `${EMAIL}leaving@demo.local`, role: 'biomed', password: PASSWORD })).json();
    await prisma.user.update({ where: { id: made.id }, data: { mustChangePassword: false } });
    const theirs = await login(base, `${EMAIL}leaving@demo.local`);
    assert.equal((await call(base, admin, 'DELETE', `/users/${made.id}`)).status, 204);
    assert.equal((await call(base, theirs, 'POST', '/auth/refresh')).status, 401);
  });
});
