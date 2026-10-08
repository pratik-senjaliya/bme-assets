// Integration tests for Phase 5B: Excel reports, the dashboard and the audit log.
// Needs a migrated + seeded database (npm run db:seed -w apps/api).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { REPORTS } from '@bme/shared';
import { addDaysISO, isoDate, parseDate, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

const PREFIX = 'RTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nursing = '';
const ids = { icu: '', icu1: '', vent: '' };
const startedAt = new Date();
const today = todayISO();

before(async () => {
  ({ server, base } = startServer());
  [admin, biomed, nursing] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  const [icu, icu1, vent] = await Promise.all([
    prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } }),
    prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } }),
    prisma.equipmentType.findUniqueOrThrow({ where: { code: 'VENT' } }),
  ]);
  Object.assign(ids, { icu: icu.id, icu1: icu1.id, vent: vent.id });
});

after(async () => {
  const assets = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  await prisma.notification.deleteMany({ where: { createdAt: { gte: startedAt } } });
  await prisma.serviceExpense.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.complaint.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const makeAsset = async (extra: object = {}) =>
  (await (await call(base, biomed, 'POST', '/assets', { equipmentTypeId: ids.vent, name: `${PREFIX}${++n}`, departmentId: ids.icu, locationId: ids.icu1, ...extra })).json()) as { id: string; assetCode: string };

async function report(cookie: string, type: string, query = '') {
  const res = await fetch(`${base}/reports/${type}${query}`, { headers: { cookie } });
  assert.equal(res.status, 200, `${type}: ${res.status}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
  return { wb, res };
}
// Rows of a sheet as objects keyed by header.
const table = (wb: ExcelJS.Workbook, sheet: string) => {
  const ws = wb.getWorksheet(sheet);
  assert.ok(ws, `sheet "${sheet}" exists (have: ${wb.worksheets.map((w) => w.name).join(', ')})`);
  const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  const out: Record<string, unknown>[] = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    out.push(Object.fromEntries(header.map((h, k) => [h, (row.values as unknown[])[k + 1]])));
  });
  return out;
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

describe('every report downloads as a valid Excel file', () => {
  it('has all nine, each with data sheets and an About sheet', async () => {
    const expected: Record<string, string[]> = {
      'asset-master': ['Asset master'], pms: ['PMS records', 'Summary'], calibration: ['Calibrations done', 'Next due (active assets)'], breakdowns: ['Breakdowns', 'By month'],
      uptime: ['Uptime', 'Summary'], 'critical-downtime': ['Uptime', 'Downtime events'], 'equipment-age': ['Assets by age', 'Age bands', 'By equipment type'], expenses: ['Expenses', 'By asset', 'By month'], 'warranty-contracts': ['Warranty', 'Contracts', 'No cover (active)'],
    };
    assert.deepEqual(REPORTS.map((r) => r.type).sort(), Object.keys(expected).sort());
    for (const [type, sheets] of Object.entries(expected)) {
      const { wb, res } = await report(biomed, type);
      assert.match(res.headers.get('content-type') ?? '', /spreadsheetml/);
      assert.match(res.headers.get('content-disposition') ?? '', new RegExp(`bme-${type}-.*\\.xlsx`));
      for (const s of [...sheets, 'About']) assert.ok(wb.getWorksheet(s), `${type} has sheet ${s}`);
    }
  });

  it('is for report viewers only, and validates its query', async () => {
    assert.equal((await fetch(`${base}/reports/pms`, { headers: { cookie: nursing } })).status, 403);
    assert.equal((await fetch(`${base}/reports/nope`, { headers: { cookie: biomed } })).status, 404);
    assert.equal((await fetch(`${base}/reports/pms?from=2026-02-30`, { headers: { cookie: biomed } })).status, 400);
    assert.equal((await fetch(`${base}/reports/pms?from=2026-05-01&to=2026-01-01`, { headers: { cookie: biomed } })).status, 400);
  });

  it('every download is audited', async () => {
    await report(biomed, 'expenses', `?from=2026-01-01&to=${today}`);
    const log = await prisma.auditLog.findFirst({ where: { action: 'report.export', at: { gte: startedAt } }, orderBy: { at: 'desc' } });
    assert.ok(log);
    assert.equal((log!.after as { type: string }).type, 'expenses');
  });
});

describe('condemned and not-in-use equipment stay in the exports, labelled (rule 7)', () => {
  it('asset master, expenses and breakdowns carry a Status label', async () => {
    const a = await makeAsset();
    await call(base, biomed, 'POST', `/assets/${a.id}/expenses`, { type: 'repair', description: 'Last repair', amount: 750, date: today });
    const c = await (await call(base, biomed, 'POST', '/complaints', { assetId: a.id, description: 'Display went blank' })).json();
    await prisma.asset.update({ where: { id: a.id }, data: { status: 'condemned' } });

    const master = table((await report(biomed, 'asset-master')).wb, 'Asset master').find((r) => r['Asset ID'] === a.assetCode);
    assert.equal(master?.Status, 'CONDEMNED');
    assert.ok(master?.['Next PMS due'] == null, 'no due dates for condemned equipment');
    assert.equal(table((await report(biomed, 'expenses')).wb, 'Expenses').find((r) => r['Asset ID'] === a.assetCode)?.['Asset status'], 'CONDEMNED');
    assert.equal(table((await report(biomed, 'breakdowns')).wb, 'Breakdowns').find((r) => r['Complaint no.'] === c.complaintNo)?.['Asset status'], 'CONDEMNED');

    const idle = await makeAsset();
    await prisma.asset.update({ where: { id: idle.id }, data: { status: 'not_in_use' } });
    assert.equal(table((await report(biomed, 'asset-master')).wb, 'Asset master').find((r) => r['Asset ID'] === idle.assetCode)?.Status, 'Not in use');
  });
});

describe('uptime and downtime', () => {
  it('works out downtime from complaint timestamps, including a complaint still open', async () => {
    const a = await makeAsset({ criticality: 'critical' });
    await prisma.asset.update({ where: { id: a.id }, data: { createdAt: parseDate(addDaysISO(today, -30)) } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'nursing@demo.local' } });
    const make = async (raisedH: number, resolvedH: number | null, description: string) => {
      const row = await prisma.complaint.create({
        data: {
          complaintNo: `RT-${Math.random().toString(36).slice(2, 8)}`, assetId: a.id, raisedById: user.id, departmentId: ids.icu, description,
          status: resolvedH == null ? 'open' : 'resolved', raisedAt: hoursAgo(raisedH), resolvedAt: resolvedH == null ? null : hoursAgo(resolvedH),
        },
      });
      return row;
    };
    await make(10, 5, `${PREFIX}resolved after 5 hours down`); // 5 h
    await make(2, null, `${PREFIX}still open`); // 2 h and counting

    const from = addDaysISO(today, -1);
    const { wb } = await report(biomed, 'uptime', `?from=${from}&to=${today}`);
    const row = table(wb, 'Uptime').find((r) => r['Asset ID'] === a.assetCode)!;
    assert.ok(row, 'the asset is in the report');
    assert.ok(Math.abs(Number(row['Downtime (h)']) - 7) < 0.1, `downtime ${row['Downtime (h)']} ≈ 7 h`);
    assert.equal(row.Breakdowns, 2);
    const periodH = Number(row['Hours in period']);
    assert.ok(periodH > 24 && periodH <= 48.1, `period ${periodH} h covers yesterday and today so far`);
    assert.ok(Math.abs(Number(row.Uptime) - (1 - 7 / periodH)) < 0.002, `uptime ${row.Uptime}`);

    // The same asset is Critical, so it is in the critical report with both events listed.
    const critical = (await report(biomed, 'critical-downtime', `?from=${from}&to=${today}`)).wb;
    assert.ok(table(critical, 'Uptime').some((r) => r['Asset ID'] === a.assetCode));
    assert.ok(table(critical, 'Uptime').every((r) => r.Criticality === 'critical'), 'only critical equipment');
    const events = table(critical, 'Downtime events').filter((r) => r['Asset ID'] === a.assetCode);
    assert.equal(events.length, 2);
    assert.ok(events.some((e) => e.Resolved === 'Still open'));

    // Leaves it out of the plain-range maths when the period does not cover the downtime.
    const earlier = table((await report(biomed, 'uptime', `?from=${addDaysISO(today, -20)}&to=${addDaysISO(today, -10)}`)).wb, 'Uptime').find((r) => r['Asset ID'] === a.assetCode)!;
    assert.equal(earlier['Downtime (h)'], 0);
    assert.equal(earlier.Uptime, 1);
  });
});

describe('expenses and breakdown summaries', () => {
  it('totals expenses per asset and month, and groups breakdowns by month or year', async () => {
    const a = await makeAsset();
    for (const [type, amount] of [['repair', 100.5], ['spare_part', 200]] as const) {
      assert.equal((await call(base, biomed, 'POST', `/assets/${a.id}/expenses`, { type, description: `${PREFIX}${type}`, amount, date: today })).status, 201);
    }
    const wb = (await report(biomed, 'expenses', `?from=${addDaysISO(today, -5)}&to=${today}`)).wb;
    const mine = table(wb, 'By asset').find((r) => r['Asset ID'] === a.assetCode)!;
    assert.equal(mine.Repairs, 100.5);
    assert.equal(mine['Spare parts'], 200);
    assert.equal(mine.Total, 300.5);
    const total = table(wb, 'Expenses').find((r) => r.Date === 'Total');
    assert.ok(Number(total?.Amount) >= 300.5, 'a grand total row');

    assert.ok((await report(biomed, 'breakdowns', '?group=year')).wb.getWorksheet('By year'));
    assert.ok((await report(biomed, 'breakdowns', '?group=month')).wb.getWorksheet('By month'));
  });
});

describe('dashboard', () => {
  it('counts what the person is allowed to see', async () => {
    const a = await makeAsset();
    await call(base, biomed, 'POST', '/complaints', { assetId: a.id, description: `${PREFIX}dashboard test complaint` });
    const dash = await (await call(base, biomed, 'GET', '/dashboard')).json();
    assert.equal(dash.scope, 'hospital');
    assert.equal(dash.activeAssets, await prisma.asset.count({ where: { status: 'active' } }));
    assert.equal(dash.openComplaints, await prisma.complaint.count({ where: { status: { in: ['open', 'in_progress'] } } }));
    assert.equal(dash.months.length, 6);
    assert.equal(dash.months[5].month, today.slice(0, 7));
    assert.ok(dash.months[5].breakdowns >= 1);
    assert.equal(dash.pendingApprovals, null, 'biomed does not decide approvals');
    assert.ok(Array.isArray(dash.dueSoon));
    assert.ok(dash.openList.some((c: { description: string }) => c.description.includes('dashboard test complaint')));
    const adminDash = await (await call(base, admin, 'GET', '/dashboard')).json();
    assert.equal(typeof adminDash.pendingApprovals, 'number');
  });

  it('nursing sees only their own department, and no PMS, calibration or approval figures', async () => {
    const dash = await (await call(base, nursing, 'GET', '/dashboard')).json();
    assert.equal(dash.scope, 'department');
    assert.equal(dash.departmentName, 'Intensive Care Unit');
    assert.equal(dash.activeAssets, await prisma.asset.count({ where: { status: 'active', departmentId: ids.icu } }));
    assert.equal(dash.dueThisMonth, null);
    assert.equal(dash.overdue, null);
    assert.equal(dash.pendingApprovals, null);
    assert.equal(dash.dueSoon, null);
    assert.ok(dash.openList.every((c: { departmentId: string }) => c.departmentId === ids.icu));
  });

  it('counts overdue and due-this-month PMS from the due dates', async () => {
    const [overdue, soon] = [await makeAsset(), await makeAsset()];
    const before = await (await call(base, biomed, 'GET', '/dashboard')).json();
    await prisma.asset.update({ where: { id: overdue.id }, data: { nextPmsDue: parseDate(addDaysISO(today, -3)) } });
    await prisma.asset.update({ where: { id: soon.id }, data: { nextPmsDue: parseDate(today) } }); // due today counts as this month
    const dash = await (await call(base, biomed, 'GET', '/dashboard')).json();
    assert.equal(dash.overdue, before.overdue + 1);
    assert.equal(dash.dueThisMonth, before.dueThisMonth + 1);
    assert.ok(dash.dueSoon.length <= 8);
  });
});

describe('audit log', () => {
  it('is for those with audit.view, filterable and paged', async () => {
    assert.equal((await call(base, biomed, 'GET', '/audit-logs')).status, 403);
    assert.equal((await call(base, nursing, 'GET', '/audit-logs')).status, 403);

    const a = await makeAsset();
    const all = await (await call(base, admin, 'GET', `/audit-logs?entityType=asset&entityId=${a.id}`)).json();
    assert.equal(all.total, 1);
    assert.equal(all.items[0].action, 'asset.create');
    assert.equal(all.items[0].actorName, 'Ravi Patel');
    assert.equal(all.items[0].before, null);
    assert.equal(all.items[0].after.name, `${PREFIX}${n}`);

    const logins = await (await call(base, admin, 'GET', `/audit-logs?action=auth.login&from=${today}&to=${today}&pageSize=2`)).json();
    assert.ok(logins.total >= 3);
    assert.equal(logins.items.length, 2);
    assert.ok(logins.items.every((r: { action: string }) => r.action.startsWith('auth.login')));
    const page2 = await (await call(base, admin, 'GET', `/audit-logs?action=auth.login&from=${today}&to=${today}&pageSize=2&page=2`)).json();
    assert.notEqual(page2.items[0]?.id, logins.items[0].id);

    const none = await (await call(base, admin, 'GET', `/audit-logs?from=2001-01-01&to=2001-01-02`)).json();
    assert.equal(none.total, 0);
    assert.equal((await call(base, admin, 'GET', '/audit-logs?from=nonsense')).status, 400);
  });

  it('is append-only in the database itself: no update, no delete', async () => {
    const row = await prisma.auditLog.findFirstOrThrow({ orderBy: { at: 'desc' } });
    await assert.rejects(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } }), /append-only/);
    await assert.rejects(prisma.auditLog.delete({ where: { id: row.id } }), /append-only/);
    await assert.rejects(prisma.auditLog.deleteMany({ where: { id: row.id } }), /append-only/);
    assert.equal((await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } })).action, row.action);
    assert.equal(isoDate(parseDate(today)), today);
  });
});

describe('reports on screen and as PDF', () => {
  const asJson = async (cookie: string, type: string, qs = '') => {
    const res = await fetch(`${base}/reports/${type}?format=json${qs ? `&${qs.replace(/^\?/, '')}` : ''}`, { headers: { cookie } });
    return { res, data: (await res.json()) as import('@bme/shared').ReportData };
  };

  it('gives every report as data: figures, charts and tables, the same ones Excel is made from', async () => {
    for (const { type } of REPORTS) {
      const { res, data } = await asJson(biomed, type);
      assert.equal(res.status, 200, type);
      assert.match(res.headers.get('content-type') ?? '', /json/);
      assert.equal(data.type, type);
      assert.ok(data.kpis.length > 0, `${type} has headline figures`);
      assert.ok(data.sheets.length > 0, `${type} has tables`);
      for (const c of data.charts) {
        assert.ok(c.series.length > 0 && c.series.every((s) => c.data.every((d) => s.key in d)), `${type}/${c.id} chart data matches its series`);
      }
      // Excel is made from this very data: same sheet names and row counts.
      const { wb } = await report(biomed, type);
      for (const s of data.sheets) assert.equal(wb.getWorksheet(s.name)!.rowCount, s.rows.length + 1 + (s.totals?.length && s.rows.length ? 1 : 0), `${type}/${s.name} rows`);
    }
  });

  it('sends dates as plain YYYY-MM-DD and never records a screen view as an export', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'report.export' } });
    const { data } = await asJson(biomed, 'asset-master');
    const installed = data.sheets[0].rows.map((r) => r.installed).find((v) => v != null);
    assert.match(String(installed), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(await prisma.auditLog.count({ where: { action: 'report.export' } }), before, 'looking is not exporting');
  });

  it('makes a PDF that is a real PDF, audited like Excel, for report viewers only', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'report.export' } });
    const res = await fetch(`${base}/reports/breakdowns?format=pdf&from=2026-01-01&to=${today}`, { headers: { cookie: biomed } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition') ?? '', /bme-breakdowns-.*\.pdf/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(bytes.length > 2000);
    assert.equal(await prisma.auditLog.count({ where: { action: 'report.export' } }), before + 1);
    assert.equal((await fetch(`${base}/reports/breakdowns?format=pdf`, { headers: { cookie: nursing } })).status, 403);
    assert.equal((await fetch(`${base}/reports/breakdowns?format=json`, { headers: { cookie: nursing } })).status, 403);
  });

  it('makes a valid PDF of every report and of one equipment’s history (totals rows included)', async () => {
    const isPdf = async (res: Response) => {
      assert.equal(res.status, 200);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.ok(bytes.subarray(-1024).toString('latin1').includes('%%EOF'), 'the file is complete');
    };
    for (const { type } of REPORTS) await isPdf(await fetch(`${base}/reports/${type}?format=pdf`, { headers: { cookie: biomed } }));
    const asset = await prisma.asset.findFirstOrThrow({ orderBy: { assetCode: 'asc' } });
    await isPdf(await fetch(`${base}/assets/${asset.id}/history?format=pdf`, { headers: { cookie: biomed } }));
    const json = await fetch(`${base}/assets/${asset.id}/history?format=json`, { headers: { cookie: biomed } });
    assert.equal(((await json.json()) as import('@bme/shared').ReportData).type, 'asset-history');
    assert.equal((await fetch(`${base}/assets/${asset.id}/history?format=pdf`, { headers: { cookie: nursing } })).status, 403);
  });

  it('works out the warranty and contract picture, including active equipment with no cover', async () => {
    const { data } = await asJson(biomed, 'warranty-contracts');
    const k = Object.fromEntries(data.kpis.map((x) => [x.label, x.value]));
    assert.equal(typeof k['Active equipment with no cover'], 'number');
    const noCover = data.sheets.find((s) => s.name === 'No cover (active)')!;
    assert.equal(noCover.rows.length, k['Active equipment with no cover']);
  });
});

describe('richer dashboard', () => {
  const dash = async (cookie: string) => (await (await fetch(`${base}/dashboard`, { headers: { cookie } })).json()) as import('@bme/shared').DashboardResponse;

  it('gives the HOD figures and charts for the whole hospital, with every chart matching its series', async () => {
    const d = await dash(admin);
    const labels = d.kpis.map((k) => k.label);
    assert.ok(labels.includes('Uptime, last 30 days') && labels.includes('Service spend this month'));
    const ids = d.charts.map((c) => c.id);
    for (const id of ['breakdowns', 'downtime', 'due-ahead', 'by-department', 'spend', 'age']) assert.ok(ids.includes(id), `chart ${id}`);
    assert.equal(d.charts.find((c) => c.id === 'breakdowns')!.data.length, 12, 'twelve months, quiet ones as zero');
    for (const c of d.charts) assert.ok(c.series.every((s) => c.data.every((row) => s.key in row)), c.id);
    const uptime = d.kpis.find((k) => k.label === 'Uptime, last 30 days')!.value as number;
    assert.ok(uptime >= 0 && uptime <= 1);
    assert.ok(Array.isArray(d.topBreakdowns) && Array.isArray(d.expiring));
  });

  it('shows nursing only its own department, with no costs, due dates or cover figures', async () => {
    const d = await dash(nursing);
    assert.equal(d.scope, 'department');
    const ids = d.charts.map((c) => c.id);
    for (const id of ['spend', 'due-ahead', 'by-department']) assert.ok(!ids.includes(id), `no ${id} chart for nursing`);
    assert.ok(!d.kpis.some((k) => /spend|Cover/.test(k.label)));
    assert.equal(d.expiring, null);
  });
});
