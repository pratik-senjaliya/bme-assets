// Integration tests for the QA hardening: login lock, changing your own password, readable audit entries,
// sorting, and exports that match the list filters. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AuditRow, Paged, ReportData } from '@bme/shared';
import { config } from './lib/config';
import { resetLoginThrottle } from './lib/loginThrottle';
import { prisma } from './lib/prisma';
import { PASSWORD, call, login, startServer } from './testUtils';

let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nursing = '';
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const signIn = (email: string, password: string) => post('/auth/login', { email, password });
const PREFIX = 'HTEST-';

before(async () => {
  ({ server, base } = startServer());
  resetLoginThrottle();
  [admin, biomed, nursing] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
});
after(async () => {
  await prisma.asset.deleteMany({ where: { name: { startsWith: PREFIX } } });
  resetLoginThrottle();
  server.close();
  await prisma.$disconnect();
});

describe('Login lock (brute-force protection)', () => {
  it('locks one login after the allowed wrong passwords, even for the right password, and says for how long', async () => {
    resetLoginThrottle();
    const email = 'nursing@demo.local';
    for (let i = 0; i < config.loginMaxFailures; i++) assert.equal((await signIn(email, `wrong-${i}`)).status, 401);
    const blocked = await signIn(email, PASSWORD);
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error.message, /Try again in \d+ minutes?/);
    // Other people are not affected, and the lock is in the audit log.
    assert.equal((await signIn('biomed@demo.local', PASSWORD)).status, 200);
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'auth.login_locked' }, orderBy: { at: 'desc' } }), 'lock not audited');
    resetLoginThrottle();
    assert.equal((await signIn(email, PASSWORD)).status, 200, 'the lock can be cleared');
  });

  it('a correct password clears the count, so a few slips never add up to a lock', async () => {
    resetLoginThrottle();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < config.loginMaxFailures - 1; i++) await signIn('nursing@demo.local', 'slip');
      assert.equal((await signIn('nursing@demo.local', PASSWORD)).status, 200);
    }
  });
});

describe('Changing your own password', () => {
  it('needs the current password, and then the old one stops working (and it is put back)', async () => {
    resetLoginThrottle();
    const email = 'biomed@demo.local';
    const NEW = 'Changed@12345';
    const cookie = (await signIn(email, PASSWORD).then((r) => r.headers.get('set-cookie')))!.split(';')[0];
    try {
      assert.equal((await call(base, cookie, 'POST', '/auth/password', { currentPassword: 'not-it', newPassword: NEW })).status, 400);
      assert.equal((await call(base, cookie, 'POST', '/auth/password', { currentPassword: PASSWORD, newPassword: 'short' })).status, 400, 'too short');
      assert.equal((await call(base, cookie, 'POST', '/auth/password', { currentPassword: PASSWORD, newPassword: PASSWORD })).status, 400, 'same as before');
      assert.equal((await call(base, cookie, 'POST', '/auth/password', { currentPassword: PASSWORD, newPassword: NEW })).status, 204);
      assert.equal((await signIn(email, PASSWORD)).status, 401);
      assert.equal((await signIn(email, NEW)).status, 200);
      assert.ok(await prisma.auditLog.findFirst({ where: { action: 'auth.password_change' } }), 'not audited');
      assert.equal((await post('/auth/password', { currentPassword: 'x', newPassword: 'Another@12345' })).status, 401, 'signed-out people cannot use it');
    } finally {
      await call(base, cookie, 'POST', '/auth/password', { currentPassword: NEW, newPassword: PASSWORD });
      resetLoginThrottle();
    }
    assert.equal((await signIn(email, PASSWORD)).status, 200, 'the demo password is back');
  });
});

describe('Audit log is readable', () => {
  it('names the record (asset code, complaint number) and can hide routine sign-ins and exports', async () => {
    const types = (await (await call(base, admin, 'GET', '/equipment-types')).json()) as { id: string; code: string }[];
    const depts = (await (await call(base, admin, 'GET', '/departments')).json()) as { id: string; code: string }[];
    const locs = (await (await call(base, admin, 'GET', '/locations')).json()) as { id: string; code: string }[];
    const a = await (await call(base, biomed, 'POST', '/assets', { equipmentTypeId: types[0].id, name: `${PREFIX}audit`, departmentId: depts.find((d) => d.code === 'ICU')!.id, locationId: locs.find((l) => l.code === 'ICU1')!.id })).json();
    await call(base, admin, 'GET', '/reports/asset-master');
    const log = (await (await call(base, admin, 'GET', `/audit-logs?entityId=${a.id}`)).json()) as Paged<AuditRow>;
    assert.ok(log.items.length > 0 && log.items.every((r) => r.entityLabel?.startsWith(a.assetCode)), `labels: ${log.items.map((r) => r.entityLabel)}`);
    const all = (await (await call(base, admin, 'GET', '/audit-logs?pageSize=200')).json()) as Paged<AuditRow>;
    const quiet = (await (await call(base, admin, 'GET', '/audit-logs?pageSize=200&hideRoutine=true')).json()) as Paged<AuditRow>;
    assert.ok(all.items.some((r) => r.action === 'auth.login' || r.action === 'report.export'));
    assert.ok(quiet.items.every((r) => !['auth.login', 'auth.logout', 'report.export'].includes(r.action)), 'routine entries not hidden');
  });
});

describe('Sorting and filtered exports', () => {
  it('sorts the register by next PMS due either way, with equipment that has no date last', async () => {
    const get = async (qs: string) => ((await (await call(base, admin, 'GET', `/assets?status=all&pageSize=100&${qs}`)).json()) as Paged<{ nextPmsDue: string | null; departmentName: string }>).items;
    const asc = (await get('sortBy=nextPmsDue&order=asc')).map((x) => x.nextPmsDue);
    const dated = asc.filter((d): d is string => !!d);
    assert.deepEqual(dated, [...dated].sort(), 'ascending');
    assert.ok(asc.slice(0, dated.length).every(Boolean), 'undated assets should come last');
    const desc = (await get('sortBy=nextPmsDue&order=desc')).map((x) => x.nextPmsDue).filter((d): d is string => !!d);
    assert.deepEqual(desc, [...desc].sort().reverse(), 'descending');
    const byDept = (await get('sortBy=department&order=asc')).map((x) => x.departmentName);
    assert.deepEqual(byDept, [...byDept].sort((a, b) => a.localeCompare(b)));
    assert.equal((await call(base, admin, 'GET', '/assets?sortBy=password')).status, 400, 'unknown sort fields are refused');
  });
  it('sorts complaints by number or date', async () => {
    const items = ((await (await call(base, admin, 'GET', '/complaints?sortBy=complaintNo&order=asc&pageSize=100')).json()) as Paged<{ complaintNo: string }>).items.map((c) => c.complaintNo);
    assert.deepEqual(items, [...items].sort());
  });
  it('the asset master export follows the list filters, so Export gives what is on screen', async () => {
    const rows = async (qs: string) => ((await (await call(base, admin, 'GET', `/reports/asset-master?format=json&${qs}`)).json()) as ReportData).sheets[0].rows;
    const all = await rows('assetStatus=all');
    const ventsOnly = await rows('assetStatus=all&search=Ventilator');
    assert.ok(ventsOnly.length > 0 && ventsOnly.length < all.length, `${ventsOnly.length} of ${all.length}`);
    assert.ok(ventsOnly.every((r) => /Ventilator|VENT/i.test(`${r.name}${r.type}${r.code}`)));
    const criticalOnly = await rows('assetStatus=all&criticality=critical');
    assert.ok(criticalOnly.every((r) => r.crit === 'critical'));
    // Nursing still only gets its own department, whatever it asks for.
    const nurse = ((await (await call(base, nursing, 'GET', '/assets?pageSize=100')).json()) as Paged<{ departmentName: string }>).items;
    assert.ok(nurse.every((a) => a.departmentName === 'Intensive Care Unit'));
  });
  it('the breakdowns export follows the complaint filters', async () => {
    const rows = async (qs: string) => ((await (await call(base, admin, 'GET', `/reports/breakdowns?format=json&from=2020-01-01&${qs}`)).json()) as ReportData).sheets[0].rows;
    const all = await rows('');
    const open = await rows('complaintStatus=open');
    assert.ok(open.length <= all.length && open.every((r) => r.status === 'open'));
  });
});
