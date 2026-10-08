// Integration tests for the Phase 1 rules. Needs a migrated + seeded database (npm run db:seed -w apps/api).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { formatAssetCode } from './lib/assetCode';
import { prisma } from './lib/prisma';
import { login as loginTo, startServer } from './testUtils';

let base = '';
let server: ReturnType<typeof startServer>['server'];

before(() => {
  ({ server, base } = startServer());
});
after(async () => {
  server.close();
  await prisma.$disconnect();
});

const login = (email: string) => loginTo(base, email);

const get = (path: string, cookie?: string) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });

describe('auth', () => {
  it('rejects anonymous calls and bad passwords', async () => {
    assert.equal((await get('/departments')).status, 401);
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@demo.local', password: 'wrong-password' }),
    });
    assert.equal(res.status, 401);
  });

  it('returns the role permissions on /auth/me', async () => {
    const me = await (await get('/auth/me', await login('biomed@demo.local'))).json();
    assert.equal(me.role, 'biomed');
    assert.ok(me.permissions.includes('asset.create'));
    assert.ok(!me.permissions.includes('user.manage'));
  });
});

describe('permissions', () => {
  it('nursing gets 403 on admin routes called directly', async () => {
    const cookie = await login('nursing@demo.local');
    for (const path of ['/users', '/roles', '/settings']) {
      assert.equal((await get(path, cookie)).status, 403, path);
    }
    const create = await fetch(`${base}/departments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Sneaky', code: 'SNK' }),
    });
    assert.equal(create.status, 403);
  });

  it('nursing only sees its own department', async () => {
    const nurse = await (await get('/auth/me', await login('nursing@demo.local'))).json();
    const rows = await (await get('/departments', await login('nursing@demo.local'))).json();
    assert.deepEqual(rows.map((d: { id: string }) => d.id), [nurse.departmentId]);
    const locations = await (await get('/locations', await login('nursing@demo.local'))).json();
    assert.ok(locations.length > 0);
    assert.ok(locations.every((l: { departmentId: string }) => l.departmentId === nurse.departmentId));
  });

  it('admin cannot change the asset ID pattern (super admin only)', async () => {
    const cookie = await login('admin@demo.local');
    const res = await fetch(`${base}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ assetIdPattern: '{HOSP}-{SEQ:4}' }),
    });
    assert.equal(res.status, 403);
  });

  it('admin cannot manage the super admin login', async () => {
    const cookie = await login('admin@demo.local');
    const users = await (await get('/users', cookie)).json();
    const sa = users.find((u: { role: string }) => u.role === 'super_admin');
    const res = await fetch(`${base}/users/${sa.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 403);
  });
});

describe('audit log', () => {
  it('records a department create with the actor', async () => {
    const cookie = await login('admin@demo.local');
    const code = `T${Date.now().toString().slice(-8)}`;
    const res = await fetch(`${base}/departments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: `Test ${code}`, code }),
    });
    assert.equal(res.status, 201);
    const dept = await res.json();
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'department', entityId: dept.id } });
    assert.equal(entry.action, 'department.create');
    assert.ok(entry.actorId);
    assert.equal(entry.before, null);
    await fetch(`${base}/departments/${dept.id}`, { method: 'DELETE', headers: { cookie } });
  });
});

describe('asset code', () => {
  it('formats the example pattern', () => {
    assert.equal(
      formatAssetCode('{HOSP}-{DEPT}-{TYPE}-{LOC}-{SEQ:3}', { hosp: 'SHL', dept: 'BME', type: 'VENT', loc: 'ICU1', seq: 1 }),
      'SHL-BME-VENT-ICU1-001',
    );
  });
});
