// Regression tests for the report and dashboard numbers found wrong in the October 2026 review (items 18–25).
// Each checks a size or range edge the earlier tests never reached: more than 8 items, more than 24 months, a quiet
// month, a financial year, condemned equipment, and impossible dates. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import type { DashboardResponse, ReportData } from '@bme/shared';
import { addMonths, isoDate, parseDate, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';
import { call, login, startServer } from './testUtils';

const PREFIX = 'NTEST-';
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
const ids = { icu: '', icu1: '', type: '' };

async function cleanUp() {
  const assets = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  await prisma.notification.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: assetIds } } });
  await prisma.complaint.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  await prisma.equipmentType.deleteMany({ where: { code: 'NTT' } });
}

before(async () => {
  await cleanUp();
  ({ server, base } = startServer());
  admin = await login(base, 'admin@demo.local');
  const [icu, icu1] = await Promise.all([prisma.department.findUniqueOrThrow({ where: { code: 'ICU' } }), prisma.location.findFirstOrThrow({ where: { code: 'ICU1' } })]);
  const type = await (await call(base, admin, 'POST', '/equipment-types', { name: `${PREFIX}type`, code: 'NTT', defaultPmsMonths: 6, defaultCalibrationMonths: 12 })).json();
  Object.assign(ids, { icu: icu.id, icu1: icu1.id, type: type.id });
});
after(async () => {
  await cleanUp();
  server.close();
  await prisma.$disconnect();
});

let n = 0;
const makeAsset = async (extra: object = {}) => {
  const res = await call(base, admin, 'POST', '/assets', { equipmentTypeId: ids.type, name: `${PREFIX}${++n}`, departmentId: ids.icu, locationId: ids.icu1, ...extra });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { id: string; assetCode: string };
};
const report = async (path: string) => (await (await call(base, admin, 'GET', path)).json()) as ReportData;

// The text drawn in a PDFKit file: inflate each content stream and decode its hex strings (WinAnsi text).
async function pdfText(path: string) {
  const buf = Buffer.from(await (await call(base, admin, 'GET', path)).arrayBuffer());
  const raw = buf.toString('latin1');
  let out = '';
  for (let i = raw.indexOf('stream\n'); i >= 0; i = raw.indexOf('stream\n', i + 1)) {
    const end = raw.indexOf('endstream', i);
    try {
      const content = inflateSync(buf.subarray(i + 7, end)).toString('latin1');
      for (const m of content.matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(m[1], 'hex').toString('latin1');
      out += '\n';
    } catch {
      // not a compressed content stream (fonts, images)
    }
  }
  return out;
}

describe('18. Dashboard "Cover ending in 60 days"', () => {
  it('counts every warranty ending, not just the 8 listed', async () => {
    // Ten warranties ending in about 20 days.
    const install = isoDate(addMonths(parseDate(todayISO()), -12));
    const soon = new Date(parseDate(todayISO()).getTime() + 20 * 86_400_000);
    for (let i = 0; i < 10; i++) {
      const a = await makeAsset({ installationDate: install, warrantyMonths: 12 });
      await prisma.asset.update({ where: { id: a.id }, data: { warrantyEnd: soon } });
    }
    const d = (await (await call(base, admin, 'GET', '/dashboard')).json()) as DashboardResponse;
    const figure = d.kpis.find((k) => k.label === 'Cover ending in 60 days')!.value as number;
    assert.ok(figure >= 10, `figure ${figure}`);
    assert.ok(d.expiring!.length <= 8, 'the list still shows at most 8');
    assert.match(d.kpis.find((k) => k.label === 'Service spend this month')!.hint ?? '', /This financial year/);
  });
});

describe('19–20. PDF exports', () => {
  it('a range longer than 2 years shows the most recent months, says so, and prints Rs. instead of ₹', async () => {
    const text = await pdfText(`/reports/expenses?format=pdf&from=2022-01-01&to=${todayISO()}`);
    assert.match(text, /Last 24 of \d+ shown/);
    const latest = new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(parseDate(todayISO()));
    assert.ok(text.includes(latest), `the newest month (${latest}) is in the chart`);
    assert.ok(!text.includes('Jan 22'), 'the oldest months are the ones left out');
    assert.ok(!/¹/.test(text), 'no garbled rupee sign');
  });
});

describe('21. Financial-year grouping', () => {
  it('"By financial year" gives one period for 1 April – 31 March', async () => {
    const r = await report('/reports/breakdowns?format=json&from=2025-04-01&to=2026-03-31&group=fy');
    assert.equal(r.group, 'fy');
    const chart = r.charts.find((c) => c.id === 'breakdowns-per-period')!;
    assert.deepEqual(chart.data.map((d) => d.label), ['FY 2025-26']);
    assert.ok(r.sheets.some((s) => s.name === 'By financial year'));
    // "By year" keeps its calendar meaning.
    const y = await report('/reports/breakdowns?format=json&from=2025-04-01&to=2026-03-31&group=year');
    assert.deepEqual(y.charts.find((c) => c.id === 'breakdowns-per-period')!.data.map((d) => d.label), ['2025', '2026']);
  });
});

describe('22. Quiet months', () => {
  it('show as zero in the breakdowns report and the expenses "By month" sheet', async () => {
    const months = 13; // 1 Sep 2025 – 30 Sep 2026
    const b = await report('/reports/breakdowns?format=json&from=2025-09-01&to=2026-09-30');
    assert.equal(b.charts.find((c) => c.id === 'breakdowns-per-period')!.data.length, months);
    assert.equal(b.sheets.find((s) => s.name === 'By month')!.rows.length, months);
    const e = await report('/reports/expenses?format=json&from=2025-09-01&to=2026-09-30');
    assert.equal(e.sheets.find((s) => s.name === 'By month')!.rows.length, months);
  });
});

describe('23. Uptime of condemned equipment', () => {
  it('is measured up to the day it was condemned', async () => {
    const a = await makeAsset();
    const now = Date.now();
    await prisma.asset.update({ where: { id: a.id }, data: { createdAt: new Date(now - 30 * 86_400_000), status: 'condemned' } });
    const me = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
    await prisma.approvalRequest.create({ data: { type: 'condemn', targetType: 'asset', targetId: a.id, payload: { reason: 'NTEST' }, requestedBy: me.id, createdBy: me.id, status: 'approved', decidedBy: me.id, decidedAt: new Date(now - 10 * 86_400_000) } });
    const r = await report(`/reports/uptime?format=json&from=${isoDate(new Date(now - 40 * 86_400_000))}&to=${todayISO()}`);
    const row = r.sheets.find((s) => s.name === 'Uptime')!.rows.find((x) => x.code === a.assetCode)!;
    const hours = Number(row.period);
    assert.ok(hours > 19 * 24 && hours < 21 * 24, `about 20 days measured, got ${hours} h`);
  });
});

describe('25. Impossible report dates', () => {
  it('are refused with a message instead of crashing or hanging', async () => {
    for (const q of ['from=0001-01-01', 'to=9999-12-31', 'from=2099-01-01']) {
      const res = await call(base, admin, 'GET', `/reports/breakdowns?format=json&${q}`);
      assert.equal(res.status, 400, q);
      assert.ok((await res.json()).error.message, q);
    }
    assert.equal((await call(base, admin, 'GET', '/reports/breakdowns?format=json&from=1990-01-01')).status, 200, 'a long but real range works');
  });
});
