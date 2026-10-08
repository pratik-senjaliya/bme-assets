// Integration tests for the Phase 3 rules. Needs a migrated + seeded database (npm run db:seed -w apps/api).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { complaintMetrics } from './modules/complaints/complaints.service';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

// Own prefix: test files run in parallel and each cleans up only what it created.
const PREFIX = 'CTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nursing = '';
let icuAsset: { id: string; assetCode: string };
let radAsset: { id: string; assetCode: string };

before(async () => {
  ({ server, base } = startServer());
  [admin, biomed, nursing] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  const [icu, rad, icu1, xr1, vent] = await Promise.all([
    prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } }),
    prisma.department.findUniqueOrThrow({ where: { code: 'RAD' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'XR1' } }),
    prisma.equipmentType.findUniqueOrThrow({ where: { code: 'VENT' } }),
  ]);
  const make = async (name: string, departmentId: string, locationId: string) =>
    (await (await call(base, biomed, 'POST', '/assets', { equipmentTypeId: vent.id, name: `${PREFIX}${name}`, departmentId, locationId })).json()) as { id: string; assetCode: string };
  icuAsset = await make('complaints-icu', icu.id, icu1.id);
  radAsset = await make('complaints-rad', rad.id, xr1.id);
});

after(async () => {
  const assets = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  await prisma.serviceExpense.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.complaint.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { description: { startsWith: PREFIX } }] } });
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: assetIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  server.close();
  await prisma.$disconnect();
});

const raise = (cookie: string, assetId: string, extra: object = {}, description = `${PREFIX}ventilator alarm keeps sounding`) =>
  call(base, cookie, 'POST', '/complaints', { assetId, description, ...extra });

describe('raising complaints', () => {
  it('nursing raises one for its own department; the server sets department, time and number', async () => {
    const res = await raise(nursing, icuAsset.id, {
      departmentId: 'ignored', // forged fields are not part of the schema
      raisedAt: '2001-01-01T00:00:00Z',
      status: 'resolved',
    });
    assert.equal(res.status, 201);
    const c = await res.json();
    assert.match(c.complaintNo, /^CMP-\d{4,}$/);
    assert.equal(c.status, 'open');
    assert.equal(c.raisedByName, 'Sister Anita Desai');
    assert.equal(c.assetCode, icuAsset.assetCode);
    assert.ok(Date.now() - new Date(c.raisedAt).getTime() < 10_000, 'raisedAt is the server clock');
    assert.equal(c.responseSeconds, null);
    assert.equal(c.downtimeSeconds, null);
    const row = await prisma.complaint.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal(row.departmentId, (await prisma.asset.findUniqueOrThrow({ where: { id: icuAsset.id } })).departmentId);
  });

  it('nursing cannot raise one for another department’s equipment', async () => {
    assert.equal((await raise(nursing, radAsset.id)).status, 404);
  });

  it('needs a real description', async () => {
    assert.equal((await raise(nursing, icuAsset.id, {}, 'no')).status, 400);
  });

  it('refuses condemned equipment', async () => {
    await prisma.asset.update({ where: { id: radAsset.id }, data: { status: 'condemned' } });
    try {
      assert.equal((await raise(biomed, radAsset.id)).status, 409);
    } finally {
      await prisma.asset.update({ where: { id: radAsset.id }, data: { status: 'active' } });
    }
  });

  it('10 parallel complaints get 10 different numbers', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => raise(biomed, icuAsset.id)));
    assert.ok(results.every((r) => r.status === 201));
    const numbers = (await Promise.all(results.map((r) => r.json()))).map((c) => c.complaintNo);
    assert.equal(new Set(numbers).size, 10);
  });
});

describe('workflow: open → in progress → resolved', () => {
  const fresh = async () => (await (await raise(nursing, icuAsset.id)).json()) as { id: string };

  it('nursing cannot start or resolve', async () => {
    const c = await fresh();
    assert.equal((await call(base, nursing, 'POST', `/complaints/${c.id}/start`)).status, 403);
    assert.equal((await call(base, nursing, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'done' })).status, 403);
  });

  it('cannot skip a step or repeat one', async () => {
    const c = await fresh();
    assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'fixed it' })).status, 409, 'resolve before start');
    assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/start`)).status, 200);
    assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/start`)).status, 409, 'start twice');
    assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: '' })).status, 400, 'notes required');
    assert.equal((await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'replaced the flow sensor' })).status, 200);
    assert.equal((await call(base, admin, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'again' })).status, 409, 'resolve twice');
  });

  it('two people starting at once: exactly one wins', async () => {
    const c = await fresh();
    const codes = (await Promise.all([biomed, admin].map((who) => call(base, who, 'POST', `/complaints/${c.id}/start`)))).map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409]);
  });
});

describe('response time and downtime', () => {
  it('response = started − raised, downtime = resolved − raised', () => {
    const m = complaintMetrics({
      raisedAt: new Date('2026-10-07T10:00:00Z'),
      startedAt: new Date('2026-10-07T10:25:00Z'),
      resolvedAt: new Date('2026-10-07T13:40:00Z'),
    });
    assert.equal(m.responseSeconds, 25 * 60);
    assert.equal(m.downtimeSeconds, 3 * 3600 + 40 * 60);
  });

  it('are null until the step has happened', () => {
    const raisedAt = new Date();
    assert.deepEqual(complaintMetrics({ raisedAt, startedAt: null, resolvedAt: null }), { responseSeconds: null, downtimeSeconds: null });
    assert.equal(complaintMetrics({ raisedAt, startedAt: new Date(raisedAt.getTime() + 60_000), resolvedAt: null }).downtimeSeconds, null);
  });

  it('the API reports them from the stored server timestamps', async () => {
    const c = await (await raise(nursing, icuAsset.id)).json();
    // Pretend it was raised 2 hours ago (the client can never do this; only the DB row can).
    await prisma.complaint.update({ where: { id: c.id }, data: { raisedAt: new Date(Date.now() - 2 * 3600_000) } });

    const started = await (await call(base, biomed, 'POST', `/complaints/${c.id}/start`)).json();
    assert.ok(Math.abs(started.responseSeconds - 7200) < 10, `response ${started.responseSeconds}`);
    assert.equal(started.downtimeSeconds, null);
    assert.equal(started.startedByName, 'Ravi Patel');

    const resolved = await (await call(base, biomed, 'POST', `/complaints/${c.id}/resolve`, { resolutionNotes: 'recalibrated and tested' })).json();
    assert.ok(resolved.downtimeSeconds >= 7200 && resolved.downtimeSeconds < 7210, `downtime ${resolved.downtimeSeconds}`);
    assert.ok(resolved.downtimeSeconds >= resolved.responseSeconds);
    assert.equal(resolved.status, 'resolved');
  });
});

describe('department scope', () => {
  it('nursing sees only its own department’s complaints', async () => {
    const other = await (await raise(biomed, radAsset.id)).json();
    const list = await (await call(base, nursing, 'GET', '/complaints?pageSize=100')).json();
    assert.ok(list.total > 0);
    assert.ok(list.items.every((c: { assetCode: string }) => !c.assetCode.includes('-RAD-')));
    assert.equal((await call(base, nursing, 'GET', `/complaints/${other.id}`)).status, 404);
    assert.equal((await call(base, nursing, 'GET', `/complaints?assetId=${radAsset.id}`)).status, 200);
    assert.equal((await (await call(base, nursing, 'GET', `/complaints?assetId=${radAsset.id}`)).json()).total, 0);
    assert.equal((await call(base, biomed, 'GET', `/complaints/${other.id}`)).status, 200);
  });
});

describe('service expenses', () => {
  const expense = (cookie: string, assetId: string, body: object) => call(base, cookie, 'POST', `/assets/${assetId}/expenses`, body);
  const valid = { type: 'spare_part', description: 'Flow sensor', amount: 12500, date: '2026-10-01', vendor: 'Drager' };

  it('records expenses, links them to a complaint, and totals them', async () => {
    const c = await (await raise(biomed, icuAsset.id)).json();
    const a = await expense(biomed, icuAsset.id, { ...valid, complaintId: c.id });
    assert.equal(a.status, 201);
    assert.equal((await a.json()).complaintNo, c.complaintNo);
    assert.equal((await expense(admin, icuAsset.id, { type: 'repair', description: 'Labour', amount: 2500.5, date: '2026-10-02' })).status, 201);

    const list = await (await call(base, biomed, 'GET', `/assets/${icuAsset.id}/expenses`)).json();
    assert.equal(list.items.length, 2);
    assert.equal(list.total, 15000.5);
  });

  it('nursing cannot see or add costs', async () => {
    assert.equal((await call(base, nursing, 'GET', `/assets/${icuAsset.id}/expenses`)).status, 403);
    assert.equal((await expense(nursing, icuAsset.id, valid)).status, 403);
  });

  it('rejects a future date, a zero amount and another asset’s complaint', async () => {
    assert.equal((await expense(biomed, icuAsset.id, { ...valid, date: '2099-01-01' })).status, 400);
    assert.equal((await expense(biomed, icuAsset.id, { ...valid, amount: 0 })).status, 400);
    const other = await (await raise(biomed, radAsset.id)).json();
    assert.equal((await expense(biomed, icuAsset.id, { ...valid, complaintId: other.id })).status, 400);
  });
});
