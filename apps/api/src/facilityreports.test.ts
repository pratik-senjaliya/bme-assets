// Facility maintenance add-on, F5 (docs/requirements-facility.md): the facility side on the dashboard and in the
// monthly report, by register. Needs a migrated + seeded database (with the add-on on).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import type { DashboardResponse, ReportData } from '@bme/shared';
import { ensureRolesAndPermissions, ensureStarterTrades } from './lib/baseData';
import { todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { call, login, PASSWORD, startServer } from './testUtils';

let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let maint = '';
let nurse = '';
const DESC = 'F5TEST bulb fused';

before(async () => {
  await ensureRolesAndPermissions();
  await prisma.hospitalSettings.updateMany({ data: { facilityEnabled: true } });
  await ensureStarterTrades();
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'maintenance' } });
  await prisma.user.upsert({ where: { email: 'maintenance@demo.local' }, update: {}, create: { name: 'Suresh Mehta', email: 'maintenance@demo.local', roleId: role.id, passwordHash: await bcrypt.hash(PASSWORD, 10) } });
  ({ server, base } = startServer());
  [admin, biomed, maint, nurse] = await Promise.all(['admin', 'biomed', 'maintenance', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  const electrical = await prisma.trade.findUniqueOrThrow({ where: { name: 'Electrical' } });
  const icu1 = await prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } });
  assert.equal((await call(base, nurse, 'POST', '/complaints', { tradeId: electrical.id, locationId: icu1.id, description: DESC })).status, 201);
});
after(async () => {
  const ids = (await prisma.complaint.findMany({ where: { description: DESC }, select: { id: true } })).map((c) => c.id);
  await prisma.notification.deleteMany({ where: { complaintId: { in: ids } } });
  await prisma.complaint.deleteMany({ where: { id: { in: ids } } });
  server.close();
  await prisma.$disconnect();
});

const dashboard = async (who: string, q = '') => (await (await call(base, who, 'GET', `/dashboard${q}`)).json()) as DashboardResponse;
const monthly = async (who: string, q = '') => (await (await call(base, who, 'GET', `/reports/monthly?month=${todayISO().slice(0, 7)}&format=json${q}`)).json()) as ReportData;

describe('Facility reports', () => {
  it('the dashboard shows the facility side to the maintenance team and the HOD, not to biomedical staff or wards', async () => {
    const m = await dashboard(maint);
    assert.ok(m.facility, 'no facility figures for maintenance');
    assert.ok(m.facility.wardOpen >= 1);
    assert.ok((await dashboard(admin)).facility);
    assert.equal((await dashboard(admin, '?register=biomedical')).facility, null, 'shown on the biomedical view');
    assert.equal((await dashboard(biomed)).facility, null);
    assert.equal((await dashboard(nurse)).facility, null);
  });

  it('the monthly report adds the facility section when it covers facility equipment', async () => {
    const all = await monthly(admin);
    assert.ok(all.sheets.some((s) => s.name === 'Ward complaints by trade'));
    assert.ok(all.kpis.some((k) => k.label === 'Ward complaints'));
    const facility = await monthly(admin, '&register=facility');
    assert.ok(facility.sheets.find((s) => s.name === 'Ward complaints by trade')!.rows.some((r) => r.trade === 'Electrical'));
    const bio = await monthly(admin, '&register=biomedical');
    assert.ok(!bio.sheets.some((s) => s.name === 'Ward complaints by trade'), 'facility section on the biomedical report');
    assert.ok(!(await monthly(biomed)).kpis.some((k) => k.label === 'Ward complaints'));
  });
});
