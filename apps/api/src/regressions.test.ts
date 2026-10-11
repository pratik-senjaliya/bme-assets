// Regression tests for bugs found in the October 2026 review. Each one does what the earlier tests did not:
// change something after it was created, run two things against the same record, or delete something others
// depend on. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addMonths, isoDate, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

const PREFIX = 'RTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
const ids = { icu: '', icu1: '', type: '', otherType: '' };
const startedAt = new Date();

before(async () => {
  ({ server, base } = startServer());
  [admin, biomed] = await Promise.all(['admin', 'biomed'].map((r) => login(base, `${r}@demo.local`)));
  const [icu, icu1] = await Promise.all([
    prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } }),
  ]);
  Object.assign(ids, { icu: icu.id, icu1: icu1.id });
  // Equipment types of our own (with a checklist), so the real ones are never touched.
  const type = await (await call(base, admin, 'POST', '/equipment-types', { name: `${PREFIX}type`, code: 'RTT', defaultPmsMonths: 3, defaultCalibrationMonths: 12 })).json();
  const other = await (await call(base, admin, 'POST', '/equipment-types', { name: `${PREFIX}other`, code: 'RTO', defaultPmsMonths: 6, defaultCalibrationMonths: 6 })).json();
  Object.assign(ids, { type: type.id, otherType: other.id });
  const t = await call(base, admin, 'POST', '/pms-templates', { equipmentTypeId: ids.type, items: [{ id: 'ok', label: 'Unit works', type: 'check', required: true }] });
  assert.equal(t.status, 201);
});

after(async () => {
  const assets = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  await prisma.notification.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { createdAt: { gte: startedAt } }] } });
  await prisma.approvalRequest.deleteMany({ where: { OR: [{ targetId: { in: assetIds } }, { createdAt: { gte: startedAt } }] } });
  await prisma.calibrationRecord.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.$transaction([
    prisma.$queryRaw`select set_config('bme.allow_pms_cleanup', 'on', true)`,
    prisma.pmsRecord.deleteMany({ where: { assetId: { in: assetIds } } }),
  ]);
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: 'rtest-' } } });
  await prisma.department.deleteMany({ where: { code: 'RTD' } });
  await prisma.pmsTemplate.deleteMany({ where: { equipmentTypeId: { in: [ids.type, ids.otherType] } } });
  await prisma.equipmentType.deleteMany({ where: { id: { in: [ids.type, ids.otherType] } } });
  server.close();
  await prisma.$disconnect();
});

let n = 0;
type Asset = { id: string; nextPmsDue: string | null; nextCalibrationDue: string | null; serialNo: string | null };
const makeAsset = async (extra: object = {}) => {
  const res = await call(base, admin, 'POST', '/assets', { equipmentTypeId: ids.type, name: `${PREFIX}${++n}`, departmentId: ids.icu, locationId: ids.icu1, ...extra });
  assert.equal(res.status, 201);
  return (await res.json()) as Asset;
};
const patch = async (id: string, body: object, cookie = admin) => {
  const res = await call(base, cookie, 'PATCH', `/assets/${id}`, body);
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { asset: Asset }).asset;
};
const plus = (iso: string, months: number) => isoDate(addMonths(new Date(`${iso}T00:00:00Z`), months));
const pendingFor = async (assetId: string) => prisma.approvalRequest.findMany({ where: { targetId: assetId, status: 'pending' }, orderBy: { createdAt: 'asc' } });

describe('Due dates follow later edits (equipment never drops off the due lists)', () => {
  it('an installation date added after registration sets the PMS and calibration due dates', async () => {
    const a = await makeAsset();
    assert.equal(a.nextPmsDue, null);
    const after = await patch(a.id, { installationDate: '2026-01-15' });
    assert.equal(after.nextPmsDue, plus('2026-01-15', 3));
    assert.equal(after.nextCalibrationDue, plus('2026-01-15', 12));
  });

  it('changing the installation date or the PMS interval moves the due date', async () => {
    const a = await makeAsset({ installationDate: '2026-01-15' });
    assert.equal((await patch(a.id, { pmsFrequencyMonths: 1 })).nextPmsDue, plus('2026-01-15', 1));
    assert.equal((await patch(a.id, { installationDate: '2026-02-01' })).nextPmsDue, plus('2026-02-01', 1));
  });

  it('after a PMS, a new interval counts from that PMS, not from installation', async () => {
    const a = await makeAsset({ installationDate: '2025-01-01' });
    assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/pms`, { answers: { ok: 'pass' } })).status, 201);
    assert.equal((await patch(a.id, { pmsFrequencyMonths: 6 })).nextPmsDue, plus(todayISO(), 6));
  });

  it('clearing the interval clears the PMS due date, and a PMS then leaves it clear (no overdue for ever)', async () => {
    const a = await makeAsset({ installationDate: '2025-01-01' }); // overdue
    assert.equal((await patch(a.id, { pmsFrequencyMonths: null })).nextPmsDue, null);
    // An asset left overdue by the old behaviour is put right by its next PMS.
    await prisma.asset.update({ where: { id: a.id }, data: { nextPmsDue: new Date('2025-04-01') } });
    assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/pms`, { answers: { ok: 'pass' } })).status, 201);
    assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).nextPmsDue, null);
  });

  it('a calibration record keeps deciding the calibration date when other fields change', async () => {
    const a = await makeAsset({ installationDate: '2026-01-15' });
    const cal = await call(base, biomed, 'POST', `/assets/${a.id}/calibrations`, { doneOn: '2026-03-01', dueOn: '2026-09-01', agency: 'RTEST lab', result: 'pass' });
    assert.equal(cal.status, 201, await cal.clone().text());
    assert.equal((await patch(a.id, { installationDate: '2026-02-01' })).nextCalibrationDue, '2026-09-01');
  });

  it('an approved change of equipment type re-plans the calibration date with the new type', async () => {
    const a = await makeAsset({ installationDate: '2026-01-15' });
    await patch(a.id, { equipmentTypeId: ids.otherType }, biomed); // a key field: becomes a request
    const [request] = await pendingFor(a.id);
    assert.equal((await call(base, admin, 'POST', `/approvals/${request.id}/approve`, {})).status, 200);
    const after = await prisma.asset.findUniqueOrThrow({ where: { id: a.id } });
    assert.equal(isoDate(after.nextCalibrationDue!), plus('2026-01-15', 6));
  });
});

describe('Approvals against a changed or deleted asset', () => {
  it('an older request cannot undo a newer approved change; it can still be rejected', async () => {
    const a = await makeAsset({ serialNo: `${PREFIX}SN0` });
    await patch(a.id, { serialNo: `${PREFIX}SN-A` }, biomed);
    await patch(a.id, { serialNo: `${PREFIX}SN-B` }, biomed);
    const [first, second] = await pendingFor(a.id);
    assert.equal((await call(base, admin, 'POST', `/approvals/${first.id}/approve`, {})).status, 200);
    const stale = await call(base, admin, 'POST', `/approvals/${second.id}/approve`, {});
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error.message, /changed since this request was made/);
    assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).serialNo, `${PREFIX}SN-A`, 'the newer value stays');
    assert.equal((await call(base, admin, 'POST', `/approvals/${second.id}/reject`, { reason: 'Superseded' })).status, 200);
  });

  it('an older request cannot undo the HOD’s own direct edit', async () => {
    const a = await makeAsset({ serialNo: `${PREFIX}SN1` });
    await patch(a.id, { serialNo: `${PREFIX}SN1-asked` }, biomed);
    await patch(a.id, { serialNo: `${PREFIX}SN1-direct` }); // the HOD edits directly
    const [request] = await pendingFor(a.id);
    assert.equal((await call(base, admin, 'POST', `/approvals/${request.id}/approve`, {})).status, 409);
    assert.equal((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).serialNo, `${PREFIX}SN1-direct`);
  });

  it('once an asset is deleted, its other pending requests can still be decided (nothing is stuck)', async () => {
    const a = await makeAsset();
    await patch(a.id, { serialNo: `${PREFIX}GONE` }, biomed);
    const del = await call(base, biomed, 'POST', '/approvals/delete', { targetType: 'asset', targetId: a.id, reason: 'Entered twice by mistake' });
    assert.equal(del.status, 201);
    const requests = await pendingFor(a.id);
    const deleteRequest = requests.find((r) => r.type === 'delete')!;
    const editRequest = requests.find((r) => r.type === 'edit_key_field')!;
    assert.equal((await call(base, admin, 'POST', `/approvals/${deleteRequest.id}/approve`, {})).status, 200);
    assert.equal(await prisma.asset.findUnique({ where: { id: a.id } }), null);
    // Approving says why it cannot; rejecting works.
    assert.equal((await call(base, admin, 'POST', `/approvals/${editRequest.id}/approve`, {})).status, 409);
    assert.equal((await call(base, admin, 'POST', `/approvals/${editRequest.id}/reject`, { reason: 'Asset was removed' })).status, 200);
    assert.equal((await pendingFor(a.id)).length, 0);
  });

  it('a condemned asset cannot be deleted as a wrong entry (asked before or after condemnation)', async () => {
    const a = await makeAsset();
    const del = await call(base, biomed, 'POST', '/approvals/delete', { targetType: 'asset', targetId: a.id, reason: 'Entered twice by mistake' });
    assert.equal(del.status, 201);
    await prisma.asset.update({ where: { id: a.id }, data: { status: 'condemned' } });
    const [request] = await pendingFor(a.id);
    assert.equal((await call(base, admin, 'POST', `/approvals/${request.id}/approve`, {})).status, 409);
    assert.ok(await prisma.asset.findUnique({ where: { id: a.id } }), 'the condemned asset is kept');
    await call(base, admin, 'POST', `/approvals/${request.id}/reject`, { reason: 'Condemned' });
    const again = await call(base, biomed, 'POST', '/approvals/delete', { targetType: 'asset', targetId: a.id, reason: 'Entered twice by mistake' });
    assert.equal(again.status, 409);
  });
});

describe('Deleting a department that people still use', () => {
  it('is refused while a login belongs to it, and allowed once it is empty', async () => {
    const dept = await (await call(base, admin, 'POST', '/departments', { name: `${PREFIX}Dept`, code: 'RTD' })).json();
    const user = await call(base, admin, 'POST', '/users', { name: `${PREFIX}Nurse`, email: 'rtest-nurse@demo.local', password: 'Rtest@12345', role: 'nursing', departmentId: dept.id });
    assert.equal(user.status, 201, await user.clone().text());
    const refused = await call(base, admin, 'DELETE', `/departments/${dept.id}`);
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error.message, /in use: 1 login belongs to it/);
    assert.ok((await prisma.user.findUniqueOrThrow({ where: { email: 'rtest-nurse@demo.local' } })).departmentId, 'the login keeps its department');
    await prisma.user.deleteMany({ where: { email: 'rtest-nurse@demo.local' } });
    assert.equal((await call(base, admin, 'DELETE', `/departments/${dept.id}`)).status, 204);
  });
});
