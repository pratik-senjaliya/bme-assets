// Gap review, batch 4a (operations): the running version is known, the daily job and disk are watched, QR labels can
// point at one fixed address, and a deputy HOD can approve while the HOD is away.
// Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { APP_VERSION, type AssetLabelsResponse, type HealthResponse, type SessionUser, type SettingsResponse, type UserRow } from '@bme/shared';
import { usersWithPermissions } from './lib/people';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

const EMAIL = 'opstest-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';

async function cleanUp() {
  const users = (await prisma.user.findMany({ where: { email: { startsWith: EMAIL } }, select: { id: true } })).map((u) => u.id);
  await prisma.notification.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.hospitalSettings.updateMany({ data: { labelBaseUrl: null } });
}

before(async () => {
  await cleanUp();
  ({ server, base } = startServer());
  admin = await login(base, 'admin@demo.local');
});
after(async () => {
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

describe('Version and health', () => {
  it('health tells the version and when the daily job last ran; Hospital settings shows the same and the disk', async () => {
    const health = (await (await fetch(`${base}/health`)).json()) as HealthResponse;
    assert.equal(health.version, APP_VERSION);
    assert.ok('dailyJobLastRunAt' in health);
    const s = (await (await call(base, admin, 'GET', '/settings')).json()) as SettingsResponse;
    assert.equal(s.system.version, APP_VERSION);
    assert.ok(s.system.storageTotalBytes! > 0 && s.system.storageFreeBytes! >= 0, JSON.stringify(s.system));
  });
});

describe('The address on QR labels', () => {
  it('is a plain site address set by the HOD, and comes with the labels', async () => {
    assert.equal((await call(base, admin, 'PUT', '/settings', { labelBaseUrl: 'bme.hospital.local' })).status, 400);
    assert.equal((await call(base, admin, 'PUT', '/settings', { labelBaseUrl: 'http://bme.hospital.local/path' })).status, 400);
    assert.equal((await call(base, admin, 'PUT', '/settings', { labelBaseUrl: 'http://bme.hospital.local:8080/' })).status, 200);
    const labels = (await (await call(base, admin, 'GET', '/assets/labels?pageSize=1')).json()) as AssetLabelsResponse;
    assert.equal(labels.baseUrl, 'http://bme.hospital.local:8080');
    assert.equal((await call(base, admin, 'PUT', '/settings', { labelBaseUrl: '' })).status, 200);
    assert.equal(((await (await call(base, admin, 'GET', '/assets/labels?pageSize=1')).json()) as AssetLabelsResponse).baseUrl, null);
  });
});

describe('A deputy HOD', () => {
  it('a biomedical engineer marked deputy can decide approvals and assign complaints; nobody else gets it', async () => {
    const make = async (who: string, role: string, deputy: boolean, extra: object = {}) => {
      const res = await call(base, admin, 'POST', '/users', { name: `OPS ${who}`, email: `${EMAIL}${who}@demo.local`, role, deputy, password: 'Demo@1234', ...extra });
      assert.equal(res.status, 201, await res.clone().text());
      const row = (await res.json()) as UserRow;
      await prisma.user.update({ where: { id: row.id }, data: { mustChangePassword: false } });
      return row;
    };
    const deputy = await make('deputy', 'biomed', true);
    assert.equal(deputy.deputy, true);
    const icu = (await prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } })).id;
    const nurse = await make('nurse', 'nursing', true, { departmentId: icu });
    assert.equal(nurse.deputy, false, 'a nurse cannot be deputy HOD');

    const cookie = await login(base, deputy.email);
    const me = (await (await call(base, cookie, 'GET', '/auth/me')).json()) as SessionUser;
    assert.ok(me.permissions.includes('approval.decide') && me.permissions.includes('complaint.assign'));
    assert.equal((await call(base, cookie, 'GET', '/complaints/assignees')).status, 200);
    assert.ok((await usersWithPermissions('approval.decide')).includes(deputy.id), 'deputies are not told about requests');

    // Taken away: at once, on the next request.
    assert.equal((await call(base, admin, 'PATCH', `/users/${deputy.id}`, { name: deputy.name, email: deputy.email, role: 'biomed', deputy: false })).status, 200);
    assert.equal((await call(base, cookie, 'GET', '/complaints/assignees')).status, 403);
    assert.ok(!(await usersWithPermissions('approval.decide')).includes(deputy.id));
  });
});
