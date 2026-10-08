import type { Request } from 'express';
import ExcelJS from 'exceljs';
import type { ReportQuery, ReportType } from '@bme/shared';
import { currentUser, departmentScope } from '../../lib/auth';
import { config } from '../../lib/config';
import { addDaysISO, addMonths, dayInTz, daysFromToday, isoDate, monthInTz, parseDate, todayISO, zonedDayStart } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { assetInclude, toAssetRow } from '../assets/assets.service';
import { complaintMetrics } from '../complaints/complaints.service';

// ---------- Workbook helpers ----------

type Fmt = 'date' | 'money' | 'hours' | 'pct' | 'int' | 'years';
type Col = { header: string; key: string; width?: number; fmt?: Fmt };
type Row = Record<string, unknown>;

const NUM_FMT: Record<Fmt, string> = {
  date: 'dd mmm yyyy',
  money: '"₹" #,##0.00',
  hours: '#,##0.0',
  pct: '0.0%',
  int: '#,##0',
  years: '0.0',
};

// A tidy table on its own sheet: bold header, frozen, filterable, typed number formats. `totals` adds a bold
// total row under the given numeric keys.
function addSheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: Row[], totals?: string[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 2) }));
  ws.addRows(rows);
  cols.forEach((c, i) => {
    if (c.fmt) ws.getColumn(i + 1).numFmt = NUM_FMT[c.fmt];
  });
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  if (totals && rows.length) {
    const total: Row = { [cols[0].key]: 'Total' };
    for (const key of totals) total[key] = rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
    ws.addRow(total).font = { bold: true };
  }
  return ws;
}

const STATUS_LABEL: Record<string, string> = { active: 'Active', not_in_use: 'Not in use', condemned: 'CONDEMNED' };
const stamp = (d: Date | null) => (d ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone }).format(d).replace(/(\d{4}) /, '$1, ') : '');
const hours = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100;
const hoursOf = (seconds: number | null) => (seconds == null ? null : Math.round((seconds / 3600) * 100) / 100);

type Ctx = { req: Request; q: ReportQuery; from: string; to: string; fromAt: Date; toAt: Date; scope: { departmentId?: string } };

// ---------- The eight reports ----------
// Business rule 7: condemned and not-in-use assets stay in every export, labelled in a Status column.

async function assetMaster(wb: ExcelJS.Workbook, c: Ctx) {
  const assets = await prisma.asset.findMany({ where: { ...c.scope }, include: assetInclude, orderBy: { assetCode: 'asc' } });
  addSheet(wb, 'Asset master', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Name', key: 'name', width: 28 }, { header: 'Equipment type', key: 'type', width: 18 },
    { header: 'Make', key: 'make' }, { header: 'Model', key: 'model' }, { header: 'Serial no', key: 'serial', width: 18 },
    { header: 'Department', key: 'dept', width: 22 }, { header: 'Location', key: 'loc', width: 16 }, { header: 'Criticality', key: 'crit' },
    { header: 'Status', key: 'status' }, { header: 'Installed', key: 'installed', fmt: 'date' }, { header: 'Age (years)', key: 'age', fmt: 'years' },
    { header: 'Warranty ends', key: 'warranty', fmt: 'date' }, { header: 'PMS every (months)', key: 'pmsMonths', fmt: 'int' },
    { header: 'Next PMS due', key: 'pms', fmt: 'date' }, { header: 'Next calibration due', key: 'cal', fmt: 'date' },
  ], assets.map((a) => {
    const r = toAssetRow(a);
    return {
      code: a.assetCode, name: a.name, type: a.equipmentType.name, make: a.make, model: a.model, serial: a.serialNo, dept: a.department.name, loc: a.location.name,
      crit: a.criticality, status: STATUS_LABEL[a.status], installed: a.installationDate, age: r.ageMonths == null ? null : Math.round((r.ageMonths / 12) * 10) / 10,
      warranty: a.warrantyEnd, pmsMonths: a.pmsFrequencyMonths, pms: a.status === 'active' ? a.nextPmsDue : null, cal: a.status === 'active' ? a.nextCalibrationDue : null,
    };
  }));
}

async function pms(wb: ExcelJS.Workbook, c: Ctx) {
  const records = await prisma.pmsRecord.findMany({
    where: { performedOn: { gte: parseDate(c.from), lte: parseDate(c.to) }, asset: { ...c.scope } },
    include: { asset: { include: { equipmentType: true, department: true } }, template: true },
    orderBy: [{ performedOn: 'asc' }, { submittedAt: 'asc' }],
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(records.map((r) => r.performedBy))] } }, select: { id: true, name: true } });
  addSheet(wb, 'PMS records', [
    { header: 'Date', key: 'date', fmt: 'date' }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Equipment type', key: 'type', width: 18 },
    { header: 'Department', key: 'dept', width: 22 }, { header: 'Asset status', key: 'status' }, { header: 'Result', key: 'result' }, { header: 'Done by', key: 'by', width: 20 },
    { header: 'Checklist version', key: 'version', fmt: 'int' }, { header: 'Correction', key: 'correction' }, { header: 'Correction reason', key: 'reason', width: 30 },
  ], records.map((r) => ({
    date: r.performedOn, code: r.asset.assetCode, name: r.asset.name, type: r.asset.equipmentType.name, dept: r.asset.department.name, status: STATUS_LABEL[r.asset.status],
    result: r.result.toUpperCase(), by: users.find((u) => u.id === r.performedBy)?.name ?? '', version: r.template.version, correction: r.correctsRecordId ? 'Yes' : 'No', reason: r.correctionReason,
  })));
  const byType = new Map<string, { count: number; pass: number }>();
  for (const r of records) {
    const t = byType.get(r.asset.equipmentType.name) ?? { count: 0, pass: 0 };
    byType.set(r.asset.equipmentType.name, { count: t.count + 1, pass: t.pass + (r.result === 'pass' ? 1 : 0) });
  }
  addSheet(wb, 'Summary', [
    { header: 'Equipment type', key: 'type', width: 22 }, { header: 'PMS done', key: 'count', fmt: 'int' }, { header: 'Passed', key: 'pass', fmt: 'int' }, { header: 'Failed', key: 'fail', fmt: 'int' },
    { header: 'Pass rate', key: 'rate', fmt: 'pct' },
  ], [...byType].map(([type, t]) => ({ type, count: t.count, pass: t.pass, fail: t.count - t.pass, rate: t.pass / t.count })), ['count', 'pass', 'fail']);
}

async function calibration(wb: ExcelJS.Workbook, c: Ctx) {
  const records = await prisma.calibrationRecord.findMany({
    where: { doneOn: { gte: parseDate(c.from), lte: parseDate(c.to) }, asset: { ...c.scope } },
    include: { asset: { include: { equipmentType: true, department: true } } },
    orderBy: [{ doneOn: 'asc' }],
  });
  addSheet(wb, 'Calibrations done', [
    { header: 'Done on', key: 'done', fmt: 'date' }, { header: 'Next due', key: 'due', fmt: 'date' }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 },
    { header: 'Equipment type', key: 'type', width: 18 }, { header: 'Department', key: 'dept', width: 22 }, { header: 'Asset status', key: 'status' },
    { header: 'Agency / engineer', key: 'agency', width: 26 }, { header: 'Result', key: 'result' },
  ], records.map((r) => ({ done: r.doneOn, due: r.dueOn, code: r.asset.assetCode, name: r.asset.name, type: r.asset.equipmentType.name, dept: r.asset.department.name, status: STATUS_LABEL[r.asset.status], agency: r.agency, result: r.result.toUpperCase() })));

  const due = await prisma.asset.findMany({ where: { status: 'active', nextCalibrationDue: { not: null }, ...c.scope }, include: assetInclude, orderBy: { nextCalibrationDue: 'asc' } });
  addSheet(wb, 'Next due (active assets)', [
    { header: 'Next calibration due', key: 'due', fmt: 'date' }, { header: 'Days left (negative = overdue)', key: 'days', fmt: 'int', width: 26 }, { header: 'Asset ID', key: 'code', width: 26 },
    { header: 'Asset', key: 'name', width: 26 }, { header: 'Equipment type', key: 'type', width: 18 }, { header: 'Department', key: 'dept', width: 22 }, { header: 'Criticality', key: 'crit' },
  ], due.map((a) => ({ due: a.nextCalibrationDue, days: daysFromToday(a.nextCalibrationDue!), code: a.assetCode, name: a.name, type: a.equipmentType.name, dept: a.department.name, crit: a.criticality })));
}

async function breakdowns(wb: ExcelJS.Workbook, c: Ctx) {
  const complaints = await prisma.complaint.findMany({
    where: { raisedAt: { gte: c.fromAt, lt: c.toAt }, ...c.scope },
    include: { asset: true, department: true, raisedBy: true },
    orderBy: { raisedAt: 'asc' },
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(complaints.flatMap((x) => [x.startedBy, x.resolvedBy]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? '') : '');
  const rows = complaints.map((x) => ({ x, m: complaintMetrics(x) }));
  addSheet(wb, 'Breakdowns', [
    { header: 'Complaint no.', key: 'no' }, { header: 'Raised', key: 'raised', width: 20 }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'asset', width: 26 },
    { header: 'Department', key: 'dept', width: 22 }, { header: 'Criticality', key: 'crit' }, { header: 'Asset status', key: 'astatus' }, { header: 'Problem', key: 'desc', width: 40 },
    { header: 'Raised by', key: 'by', width: 20 }, { header: 'Status', key: 'status' }, { header: 'Started', key: 'started', width: 20 }, { header: 'Started by', key: 'startedBy', width: 20 },
    { header: 'Resolved', key: 'resolved', width: 20 }, { header: 'Resolved by', key: 'resolvedBy', width: 20 }, { header: 'Response time (h)', key: 'resp', fmt: 'hours', width: 18 },
    { header: 'Downtime (h)', key: 'down', fmt: 'hours' }, { header: 'Resolution', key: 'notes', width: 40 },
  ], rows.map(({ x, m }) => ({
    no: x.complaintNo, raised: stamp(x.raisedAt), code: x.asset.assetCode, asset: x.asset.name, dept: x.department.name, crit: x.asset.criticality, astatus: STATUS_LABEL[x.asset.status], desc: x.description,
    by: x.raisedBy.name, status: x.status.replace('_', ' '), started: stamp(x.startedAt), startedBy: name(x.startedBy), resolved: stamp(x.resolvedAt), resolvedBy: name(x.resolvedBy),
    resp: hoursOf(m.responseSeconds), down: hoursOf(m.downtimeSeconds), notes: x.resolutionNotes,
  })));

  // Summary by month or by year (hospital calendar).
  const key = (d: Date) => (c.q.group === 'year' ? monthInTz(d).slice(0, 4) : monthInTz(d));
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(key(r.x.raisedAt), [...(groups.get(key(r.x.raisedAt)) ?? []), r]);
  const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  addSheet(wb, c.q.group === 'year' ? 'By year' : 'By month', [
    { header: c.q.group === 'year' ? 'Year' : 'Month', key: 'period' }, { header: 'Breakdowns', key: 'count', fmt: 'int' }, { header: 'Resolved', key: 'resolved', fmt: 'int' },
    { header: 'Average response (h)', key: 'resp', fmt: 'hours', width: 20 }, { header: 'Total downtime (h)', key: 'down', fmt: 'hours', width: 18 }, { header: 'Average downtime (h)', key: 'avgDown', fmt: 'hours', width: 20 },
  ], [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([period, g]) => {
    const down = g.map((r) => r.m.downtimeSeconds).filter((v): v is number => v != null);
    const resp = g.map((r) => r.m.responseSeconds).filter((v): v is number => v != null);
    return { period, count: g.length, resolved: down.length, resp: avg(resp) == null ? null : avg(resp)! / 3600, down: down.reduce((a, b) => a + b, 0) / 3600, avgDown: avg(down) == null ? null : avg(down)! / 3600 };
  }), ['count', 'resolved', 'down']);
}

// Downtime hours of one complaint inside [from, to): from raised until resolved (or until now / the end of the period if still open).
const overlapMs = (raised: Date, resolved: Date | null, from: Date, to: Date) => {
  const start = Math.max(raised.getTime(), from.getTime());
  const end = Math.min((resolved ?? new Date()).getTime(), to.getTime());
  return Math.max(0, end - start);
};

async function uptimeSheets(wb: ExcelJS.Workbook, c: Ctx, criticalOnly: boolean) {
  const now = new Date();
  const periodEnd = new Date(Math.min(c.toAt.getTime(), now.getTime())); // the future has no uptime yet
  const assets = await prisma.asset.findMany({
    where: { ...c.scope, ...(criticalOnly ? { criticality: 'critical' } : {}), createdAt: { lt: periodEnd } },
    include: assetInclude,
    orderBy: { assetCode: 'asc' },
  });
  const complaints = await prisma.complaint.findMany({
    where: { assetId: { in: assets.map((a) => a.id) }, raisedAt: { lt: periodEnd }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: c.fromAt } }] },
    orderBy: { raisedAt: 'asc' },
  });

  const rows = assets.map((a) => {
    const start = new Date(Math.max(c.fromAt.getTime(), a.createdAt.getTime())); // an asset has no uptime before it was registered
    const periodMs = Math.max(0, periodEnd.getTime() - start.getTime());
    const mine = complaints.filter((x) => x.assetId === a.id);
    const downMs = Math.min(periodMs, mine.reduce((s, x) => s + overlapMs(x.raisedAt, x.resolvedAt, start, periodEnd), 0));
    return { a, mine, periodMs, downMs };
  }).filter((r) => r.periodMs > 0);

  addSheet(wb, 'Uptime', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Equipment type', key: 'type', width: 18 }, { header: 'Department', key: 'dept', width: 22 },
    { header: 'Criticality', key: 'crit' }, { header: 'Status', key: 'status' }, { header: 'Hours in period', key: 'period', fmt: 'hours', width: 16 }, { header: 'Breakdowns', key: 'count', fmt: 'int' },
    { header: 'Downtime (h)', key: 'down', fmt: 'hours' }, { header: 'Uptime', key: 'uptime', fmt: 'pct' },
  ], rows.map(({ a, mine, periodMs, downMs }) => ({
    code: a.assetCode, name: a.name, type: a.equipmentType.name, dept: a.department.name, crit: a.criticality, status: STATUS_LABEL[a.status], period: hours(periodMs),
    count: mine.filter((x) => x.raisedAt >= c.fromAt).length, down: hours(downMs), uptime: 1 - downMs / periodMs,
  })).sort((x, y) => x.uptime - y.uptime || x.code.localeCompare(y.code)));

  const totalPeriod = rows.reduce((s, r) => s + r.periodMs, 0);
  const totalDown = rows.reduce((s, r) => s + r.downMs, 0);
  addSheet(wb, 'Summary', [{ header: 'Measure', key: 'k', width: 34 }, { header: 'Value', key: 'v', width: 16 }], [
    { k: criticalOnly ? 'Critical assets in the report' : 'Assets in the report', v: rows.length },
    { k: 'Total downtime (hours)', v: hours(totalDown) },
    { k: 'Overall uptime', v: totalPeriod ? `${((1 - totalDown / totalPeriod) * 100).toFixed(2)}%` : '—' },
    { k: 'Basis', v: '24 hours a day, from the date the asset was registered' },
  ]);

  if (criticalOnly) {
    const events = rows.flatMap(({ a, mine }) => mine.map((x) => ({ a, x })));
    addSheet(wb, 'Downtime events', [
      { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Complaint no.', key: 'no' }, { header: 'Raised', key: 'raised', width: 20 },
      { header: 'Resolved', key: 'resolved', width: 20 }, { header: 'Downtime in period (h)', key: 'down', fmt: 'hours', width: 22 }, { header: 'Problem', key: 'desc', width: 40 },
    ], events.map(({ a, x }) => ({ code: a.assetCode, name: a.name, no: x.complaintNo, raised: stamp(x.raisedAt), resolved: x.resolvedAt ? stamp(x.resolvedAt) : 'Still open', down: hours(overlapMs(x.raisedAt, x.resolvedAt, c.fromAt, periodEnd)), desc: x.description })));
  }
}

async function equipmentAge(wb: ExcelJS.Workbook, c: Ctx) {
  const assets = await prisma.asset.findMany({ where: { ...c.scope }, include: assetInclude, orderBy: { assetCode: 'asc' } });
  const list = assets.map((a) => {
    const r = toAssetRow(a);
    return { a, years: r.ageMonths == null ? null : r.ageMonths / 12 };
  });
  const band = (y: number | null) => (y == null ? 'No installation date' : y < 2 ? 'Under 2 years' : y < 5 ? '2 to 5 years' : y < 10 ? '5 to 10 years' : '10 years or more');
  addSheet(wb, 'Assets by age', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Equipment type', key: 'type', width: 18 }, { header: 'Department', key: 'dept', width: 22 },
    { header: 'Status', key: 'status' }, { header: 'Installed', key: 'installed', fmt: 'date' }, { header: 'Age (years)', key: 'years', fmt: 'years' }, { header: 'Age band', key: 'band', width: 22 },
  ], list.map(({ a, years }) => ({ code: a.assetCode, name: a.name, type: a.equipmentType.name, dept: a.department.name, status: STATUS_LABEL[a.status], installed: a.installationDate, years: years == null ? null : Math.round(years * 10) / 10, band: band(years) })).sort((x, y) => (y.years ?? -1) - (x.years ?? -1)));

  const bands = ['Under 2 years', '2 to 5 years', '5 to 10 years', '10 years or more', 'No installation date'];
  addSheet(wb, 'Age bands', [{ header: 'Age band', key: 'band', width: 24 }, { header: 'Assets', key: 'count', fmt: 'int' }, { header: 'Share', key: 'share', fmt: 'pct' }],
    bands.map((b) => ({ band: b, count: list.filter((l) => band(l.years) === b).length, share: list.length ? list.filter((l) => band(l.years) === b).length / list.length : 0 })), ['count']);

  const types = new Map<string, number[]>();
  for (const { a, years } of list) if (years != null) types.set(a.equipmentType.name, [...(types.get(a.equipmentType.name) ?? []), years]);
  addSheet(wb, 'By equipment type', [{ header: 'Equipment type', key: 'type', width: 24 }, { header: 'Assets with an age', key: 'count', fmt: 'int', width: 18 }, { header: 'Average age (years)', key: 'avg', fmt: 'years', width: 20 }, { header: 'Oldest (years)', key: 'max', fmt: 'years' }],
    [...types].map(([type, ys]) => ({ type, count: ys.length, avg: ys.reduce((s, y) => s + y, 0) / ys.length, max: Math.max(...ys) })).sort((x, y) => y.avg - x.avg));
}

async function expenses(wb: ExcelJS.Workbook, c: Ctx) {
  const rows = await prisma.serviceExpense.findMany({
    where: { date: { gte: parseDate(c.from), lte: parseDate(c.to) }, asset: { ...c.scope } },
    include: { asset: { include: { equipmentType: true, department: true } }, complaint: true },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  addSheet(wb, 'Expenses', [
    { header: 'Date', key: 'date', fmt: 'date' }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 22 },
    { header: 'Asset status', key: 'status' }, { header: 'Type', key: 'type' }, { header: 'Description', key: 'desc', width: 34 }, { header: 'Vendor', key: 'vendor', width: 20 },
    { header: 'Complaint', key: 'complaint' }, { header: 'Amount', key: 'amount', fmt: 'money', width: 16 },
  ], rows.map((e) => ({ date: e.date, code: e.asset.assetCode, name: e.asset.name, dept: e.asset.department.name, status: STATUS_LABEL[e.asset.status], type: e.type === 'spare_part' ? 'Spare part' : 'Repair', desc: e.description, vendor: e.vendor, complaint: e.complaint?.complaintNo, amount: Number(e.amount) })), ['amount']);

  const byAsset = new Map<string, { name: string; count: number; repair: number; spare: number }>();
  for (const e of rows) {
    const t = byAsset.get(e.asset.assetCode) ?? { name: e.asset.name, count: 0, repair: 0, spare: 0 };
    byAsset.set(e.asset.assetCode, { ...t, count: t.count + 1, repair: t.repair + (e.type === 'repair' ? Number(e.amount) : 0), spare: t.spare + (e.type === 'spare_part' ? Number(e.amount) : 0) });
  }
  addSheet(wb, 'By asset', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Entries', key: 'count', fmt: 'int' }, { header: 'Repairs', key: 'repair', fmt: 'money', width: 16 },
    { header: 'Spare parts', key: 'spare', fmt: 'money', width: 16 }, { header: 'Total', key: 'total', fmt: 'money', width: 16 },
  ], [...byAsset].map(([code, t]) => ({ code, name: t.name, count: t.count, repair: t.repair, spare: t.spare, total: t.repair + t.spare })).sort((a, b) => b.total - a.total), ['count', 'repair', 'spare', 'total']);

  const byMonth = new Map<string, number>();
  for (const e of rows) byMonth.set(isoDate(e.date).slice(0, 7), (byMonth.get(isoDate(e.date).slice(0, 7)) ?? 0) + Number(e.amount));
  addSheet(wb, 'By month', [{ header: 'Month', key: 'month' }, { header: 'Total', key: 'total', fmt: 'money', width: 16 }],
    [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, total]) => ({ month, total })), ['total']);
}

// ---------- Entry point ----------

export async function buildReport(type: ReportType, req: Request, q: ReportQuery) {
  const today = todayISO();
  const to = q.to ?? today;
  const from = q.from ?? isoDate(addMonths(parseDate(to), -12));
  const ctx: Ctx = { req, q, from, to, fromAt: zonedDayStart(from), toAt: zonedDayStart(addDaysISO(to, 1)), scope: departmentScope(currentUser(req)) };

  const wb = new ExcelJS.Workbook();
  wb.creator = currentUser(req).name;
  wb.created = new Date();
  const settings = await prisma.hospitalSettings.findFirstOrThrow({ select: { name: true } });

  const builders: Record<ReportType, () => Promise<void>> = {
    'asset-master': () => assetMaster(wb, ctx),
    pms: () => pms(wb, ctx),
    calibration: () => calibration(wb, ctx),
    breakdowns: () => breakdowns(wb, ctx),
    uptime: () => uptimeSheets(wb, ctx, false),
    'critical-downtime': () => uptimeSheets(wb, ctx, true),
    'equipment-age': () => equipmentAge(wb, ctx),
    expenses: () => expenses(wb, ctx),
  };
  await builders[type]();

  const ranged = !['asset-master', 'equipment-age'].includes(type);
  addSheet(wb, 'About', [{ header: 'Item', key: 'k', width: 20 }, { header: 'Value', key: 'v', width: 60 }], [
    { k: 'Hospital', v: settings.name },
    { k: 'Report', v: type },
    { k: 'Period', v: ranged ? `${from} to ${to}` : `As at ${dayInTz(new Date())}` },
    { k: 'Generated', v: stamp(new Date()) },
    { k: 'Generated by', v: currentUser(req).name },
    { k: 'Note', v: 'Condemned and not-in-use assets are included and labelled in the Status column.' },
  ]);
  return { wb, filename: `bme-${type}-${ranged ? `${from}_to_${to}` : today}.xlsx`, from, to };
}

