import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { REPORTS, type ChartSpec, type Kpi, type ReportColumn, type ReportData, type ReportQuery, type ReportSheetData, type ReportType, type ValueFmt } from '@bme/shared';
import { currentUser, departmentScope } from '../../lib/auth';
import { config } from '../../lib/config';
import { addDaysISO, addMonths, daysFromToday, isoDate, monthInTz, parseDate, prettyDate, todayISO, zonedDayStart } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { assetInclude, toAssetRow } from '../assets/assets.service';
import { complaintMetrics } from '../complaints/complaints.service';

// ---------- What a builder produces ----------

// Builders add tables (sheets), headline figures and charts here. The screen shows them as they are; Excel and PDF are
// made from the same data (reports.export.ts), so the three can never disagree.
type Col = ReportColumn;
type Row = Record<string, unknown>;
export type Collector = { sheets: ReportSheetData[]; kpis: Kpi[]; charts: ChartSpec[] };

// Dates become YYYY-MM-DD here, once, so everything downstream is plain JSON.
const plain = (v: unknown): string | number | null => (v instanceof Date ? isoDate(v) : typeof v === 'number' ? v : v == null || v === '' ? null : String(v));

function addSheet(out: Collector, name: string, cols: Col[], rows: Row[], totals?: string[]) {
  out.sheets.push({
    name,
    columns: cols.map((c) => ({ ...c, width: c.width ?? Math.max(12, c.header.length + 2) })),
    rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c.key, plain(r[c.key])]))),
    totals,
  });
}

const kpi = (out: Collector, label: string, value: number | string | null, fmt: ValueFmt, hint?: string, tone?: Kpi['tone']) => out.kpis.push({ label, value, fmt, hint, tone });

// A chart of one measure. `entries` are [label, value] pairs in the order to show.
const oneSeries = (id: string, title: string, kind: 'column' | 'bar' | 'line', unit: string, entries: [string, number][], fmt: ValueFmt, subtitle?: string): ChartSpec => ({
  id, title, subtitle, kind, fmt, series: [{ key: 'v', label: unit }], data: entries.map(([label, v]) => ({ label, v })),
});
// Oct 2025 (the longer form, for table cells); monthLabel is the short one for chart axes.
const monthFull = (key: string) => new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(parseDate(`${key}-01`));
const monthLabel = (key: string) => new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(parseDate(`${key}-01`));
// Every month from `from` to `to` (YYYY-MM-DD), so a quiet month shows as zero instead of vanishing.
const monthKeys = (from: string, to: string) => {
  const keys: string[] = [];
  for (let d = parseDate(`${from.slice(0, 7)}-01`); isoDate(d).slice(0, 7) <= to.slice(0, 7); d = addMonths(d, 1)) keys.push(isoDate(d).slice(0, 7));
  return keys;
};
const top = <T,>(items: T[], n: number) => items.slice(0, n);
const span = (c: { from: string; to: string }) => `${prettyDate(parseDate(c.from))} to ${prettyDate(parseDate(c.to))}`;
// Count items by a label, biggest first.
const tally = <T,>(items: T[], label: (t: T) => string): [string, number][] => {
  const m = new Map<string, number>();
  for (const i of items) m.set(label(i), (m.get(label(i)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};
const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

type Ctx = { req: Request; q: ReportQuery; from: string; to: string; fromAt: Date; toAt: Date; scope: { departmentId?: string } };

const STATUS_LABEL: Record<string, string> = { active: 'Active', not_in_use: 'Not in use', condemned: 'CONDEMNED' };
const stamp = (d: Date | null) => (d ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone }).format(d).replace(/(\d{4}) /, '$1, ') : '');
const hours = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100;
const hoursOf = (seconds: number | null) => (seconds == null ? null : Math.round((seconds / 3600) * 100) / 100);


// ---------- The eight reports ----------
// Business rule 7: condemned and not-in-use assets stay in every export, labelled in a Status column.

async function assetMaster(wb: Collector, c: Ctx) {
  const { q } = c;
  const where: Prisma.AssetWhereInput = {
    ...c.scope,
    ...(q.assetStatus && q.assetStatus !== 'all' && { status: q.assetStatus }),
    ...(q.departmentId && { departmentId: q.departmentId }),
    ...(q.equipmentTypeId && { equipmentTypeId: q.equipmentTypeId }),
    ...(q.criticality && { criticality: q.criticality }),
    ...(q.search && { OR: ['assetCode', 'name', 'serialNo', 'make', 'model'].map((f) => ({ [f]: { contains: q.search, mode: 'insensitive' as const } })) }),
  };
  const assets = await prisma.asset.findMany({ where, include: assetInclude, orderBy: { assetCode: 'asc' } });
  const rowsOf = assets.map(toAssetRow);
  const active = assets.filter((a) => a.status === 'active');
  kpi(wb, 'Assets', assets.length, 'int', 'All, including archived');
  kpi(wb, 'Active', active.length, 'int');
  kpi(wb, 'Not in use', assets.filter((a) => a.status === 'not_in_use').length, 'int');
  kpi(wb, 'Condemned', assets.filter((a) => a.status === 'condemned').length, 'int');
  kpi(wb, 'Critical (active)', active.filter((a) => a.criticality === 'critical').length, 'int');
  const expiring = rowsOf.filter((r, i) => assets[i].status === 'active' && r.warrantyStatus === 'expiring').length;
  kpi(wb, 'Warranty ending in 30 days', expiring, 'int', expiring ? 'Plan a contract' : 'None', expiring ? 'warn' : 'good');
  wb.charts.push(oneSeries('by-department', 'Active equipment by department', 'bar', 'Assets', tally(active, (a) => a.department.name), 'int'));
  wb.charts.push(oneSeries('by-type', 'Active equipment by type', 'bar', 'Assets', top(tally(active, (a) => a.equipmentType.name), 10), 'int'));
  wb.charts.push(oneSeries('by-criticality', 'Active equipment by criticality', 'column', 'Assets', ['low', 'medium', 'high', 'critical'].map((c) => [c[0].toUpperCase() + c.slice(1), active.filter((a) => a.criticality === c).length] as [string, number]), 'int'));
  wb.charts.push(oneSeries('by-status', 'Equipment by status', 'column', 'Assets', [['Active', active.length], ['Not in use', assets.filter((a) => a.status === 'not_in_use').length], ['Condemned', assets.filter((a) => a.status === 'condemned').length]], 'int'));
  addSheet(wb, 'Asset master', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Name', key: 'name', width: 28 }, { header: 'Equipment type', key: 'type', width: 18 },
    { header: 'Make', pdf: false, key: 'make' }, { header: 'Model', pdf: false, key: 'model' }, { header: 'Serial no', pdf: false, key: 'serial', width: 18 },
    { header: 'Department', key: 'dept', width: 22 }, { header: 'Location', key: 'loc', width: 16 }, { header: 'Criticality', key: 'crit' },
    { header: 'Status', key: 'status' }, { header: 'Installed', key: 'installed', fmt: 'date' }, { header: 'Age (years)', pdf: false, key: 'age', fmt: 'years' },
    { header: 'Warranty ends', key: 'warranty', fmt: 'date' }, { header: 'PMS every (months)', pdf: false, key: 'pmsMonths', fmt: 'int' },
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

async function pms(wb: Collector, c: Ctx) {
  const records = await prisma.pmsRecord.findMany({
    where: { performedOn: { gte: parseDate(c.from), lte: parseDate(c.to) }, asset: { ...c.scope } },
    include: { asset: { include: { equipmentType: true, department: true } }, template: true },
    orderBy: [{ performedOn: 'asc' }, { submittedAt: 'asc' }],
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(records.map((r) => r.performedBy))] } }, select: { id: true, name: true } });
  addSheet(wb, 'PMS records', [
    { header: 'Date', key: 'date', fmt: 'date' }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Equipment type', key: 'type', width: 18 },
    { header: 'Department', key: 'dept', width: 22 }, { header: 'Asset status', pdf: false, key: 'status' }, { header: 'Result', key: 'result' }, { header: 'Done by', key: 'by', width: 20 },
    { header: 'Checklist version', pdf: false, key: 'version', fmt: 'int' }, { header: 'Correction', key: 'correction' }, { header: 'Correction reason', pdf: false, key: 'reason', width: 30 },
  ], records.map((r) => ({
    date: r.performedOn, code: r.asset.assetCode, name: r.asset.name, type: r.asset.equipmentType.name, dept: r.asset.department.name, status: STATUS_LABEL[r.asset.status],
    result: r.result.toUpperCase(), by: users.find((u) => u.id === r.performedBy)?.name ?? '', version: r.template.version, correction: r.correctsRecordId ? 'Yes' : 'No', reason: r.correctionReason,
  })));
  const byType = new Map<string, { count: number; pass: number }>();
  for (const r of records) {
    const t = byType.get(r.asset.equipmentType.name) ?? { count: 0, pass: 0 };
    byType.set(r.asset.equipmentType.name, { count: t.count + 1, pass: t.pass + (r.result === 'pass' ? 1 : 0) });
  }
  const passed = records.filter((r) => r.result === 'pass').length;
  kpi(wb, 'PMS done', records.length, 'int', span(c));
  kpi(wb, 'Pass rate', records.length ? passed / records.length : null, 'pct', records.length ? undefined : 'No PMS in this period', records.length && passed / records.length < 0.9 ? 'warn' : 'good');
  kpi(wb, 'Failed', records.length - passed, 'int', records.length - passed ? 'Check these assets' : 'None', records.length - passed ? 'bad' : 'good');
  kpi(wb, 'Corrections', records.filter((r) => r.correctsRecordId).length, 'int', 'Records that correct an earlier one');
  const months = monthKeys(c.from, c.to);
  wb.charts.push(oneSeries('pms-per-month', 'PMS done per month', 'column', 'PMS done', months.map((m) => [monthLabel(m), records.filter((r) => isoDate(r.performedOn).slice(0, 7) === m).length] as [string, number]), 'int'));
  wb.charts.push(oneSeries('pms-by-type', 'PMS done by equipment type', 'bar', 'PMS done', [...byType].map(([t, v]) => [t, v.count] as [string, number]).sort((a, b) => b[1] - a[1]), 'int'));
  addSheet(wb, 'Summary', [
    { header: 'Equipment type', key: 'type', width: 22 }, { header: 'PMS done', key: 'count', fmt: 'int' }, { header: 'Passed', key: 'pass', fmt: 'int' }, { header: 'Failed', key: 'fail', fmt: 'int' },
    { header: 'Pass rate', key: 'rate', fmt: 'pct' },
  ], [...byType].map(([type, t]) => ({ type, count: t.count, pass: t.pass, fail: t.count - t.pass, rate: t.pass / t.count })), ['count', 'pass', 'fail']);
}

async function calibration(wb: Collector, c: Ctx) {
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
  const overdueCal = due.filter((a) => daysFromToday(a.nextCalibrationDue!) < 0).length;
  const soonCal = due.filter((a) => { const d = daysFromToday(a.nextCalibrationDue!); return d >= 0 && d <= 30; }).length;
  kpi(wb, 'Calibrations done', records.length, 'int', span(c));
  kpi(wb, 'Failed', records.filter((r) => r.result !== 'pass').length, 'int', undefined, records.some((r) => r.result !== 'pass') ? 'bad' : 'good');
  kpi(wb, 'Overdue now', overdueCal, 'int', overdueCal ? 'Calibrate first' : 'None', overdueCal ? 'bad' : 'good');
  kpi(wb, 'Due in 30 days', soonCal, 'int', undefined, soonCal ? 'warn' : 'good');
  wb.charts.push(oneSeries('cal-per-month', 'Calibrations done per month', 'column', 'Calibrations', monthKeys(c.from, c.to).map((m) => [monthLabel(m), records.filter((r) => isoDate(r.doneOn).slice(0, 7) === m).length] as [string, number]), 'int'));
  const upcoming = monthKeys(todayISO(), isoDate(addMonths(parseDate(todayISO()), 11)));
  wb.charts.push(oneSeries('cal-due-ahead', 'Calibrations due, next 12 months', 'column', 'Due', [['Overdue', overdueCal] as [string, number], ...upcoming.map((m) => [monthLabel(m), due.filter((a) => isoDate(a.nextCalibrationDue!).slice(0, 7) === m && daysFromToday(a.nextCalibrationDue!) >= 0).length] as [string, number])], 'int', 'Active equipment'));
  addSheet(wb, 'Next due (active assets)', [
    { header: 'Next calibration due', key: 'due', fmt: 'date' }, { header: 'Days left (negative = overdue)', key: 'days', fmt: 'int', width: 26 }, { header: 'Asset ID', key: 'code', width: 26 },
    { header: 'Asset', key: 'name', width: 26 }, { header: 'Equipment type', key: 'type', width: 18 }, { header: 'Department', key: 'dept', width: 22 }, { header: 'Criticality', key: 'crit' },
  ], due.map((a) => ({ due: a.nextCalibrationDue, days: daysFromToday(a.nextCalibrationDue!), code: a.assetCode, name: a.name, type: a.equipmentType.name, dept: a.department.name, crit: a.criticality })));
}

async function breakdowns(wb: Collector, c: Ctx) {
  const complaints = await prisma.complaint.findMany({
    where: { raisedAt: { gte: c.fromAt, lt: c.toAt }, ...c.scope, ...(c.q.departmentId && { departmentId: c.q.departmentId }), ...(c.q.complaintStatus && { status: c.q.complaintStatus }),
      ...(c.q.search && { OR: [{ complaintNo: { contains: c.q.search, mode: 'insensitive' as const } }, { description: { contains: c.q.search, mode: 'insensitive' as const } }, { asset: { assetCode: { contains: c.q.search, mode: 'insensitive' as const } } }, { asset: { name: { contains: c.q.search, mode: 'insensitive' as const } } }] }) },
    include: { asset: true, department: true, raisedBy: true },
    orderBy: { raisedAt: 'asc' },
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(complaints.flatMap((x) => [x.startedBy, x.resolvedBy]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? '') : '');
  const rows = complaints.map((x) => ({ x, m: complaintMetrics(x) }));
  addSheet(wb, 'Breakdowns', [
    { header: 'Complaint no.', key: 'no' }, { header: 'Raised', key: 'raised', width: 20 }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'asset', width: 26 },
    { header: 'Department', key: 'dept', width: 22 }, { header: 'Criticality', key: 'crit' }, { header: 'Asset status', pdf: false, key: 'astatus' }, { header: 'Problem', key: 'desc', width: 40 },
    { header: 'Raised by', pdf: false, key: 'by', width: 20 }, { header: 'Status', key: 'status' }, { header: 'Started', pdf: false, key: 'started', width: 20 }, { header: 'Started by', pdf: false, key: 'startedBy', width: 20 },
    { header: 'Resolved', pdf: false, key: 'resolved', width: 20 }, { header: 'Resolved by', pdf: false, key: 'resolvedBy', width: 20 }, { header: 'Response time (h)', key: 'resp', fmt: 'hours', width: 18 },
    { header: 'Downtime (h)', key: 'down', fmt: 'hours' }, { header: 'Resolution', key: 'notes', width: 40 },
  ], rows.map(({ x, m }) => ({
    no: x.complaintNo, raised: stamp(x.raisedAt), code: x.asset.assetCode, asset: x.asset.name, dept: x.department.name, crit: x.asset.criticality, astatus: STATUS_LABEL[x.asset.status], desc: x.description,
    by: x.raisedBy.name, status: x.status.replace('_', ' '), started: stamp(x.startedAt), startedBy: name(x.startedBy), resolved: stamp(x.resolvedAt), resolvedBy: name(x.resolvedBy),
    resp: hoursOf(m.responseSeconds), down: hoursOf(m.downtimeSeconds), notes: x.resolutionNotes,
  })));

  const downs = rows.map((r) => r.m.downtimeSeconds).filter((v): v is number => v != null);
  const resps = rows.map((r) => r.m.responseSeconds).filter((v): v is number => v != null);
  const stillOpen = rows.filter((r) => r.x.status !== 'resolved').length;
  kpi(wb, 'Breakdowns', rows.length, 'int', span(c));
  kpi(wb, 'Still open', stillOpen, 'int', stillOpen ? 'Waiting for a fix' : 'All resolved', stillOpen ? 'warn' : 'good');
  kpi(wb, 'Average response', avg(resps) == null ? null : avg(resps)! / 3600, 'hours', 'Raised to started');
  kpi(wb, 'Average downtime', avg(downs) == null ? null : avg(downs)! / 3600, 'hours', 'Raised to resolved');
  kpi(wb, 'Total downtime', downs.reduce((a, b) => a + b, 0) / 3600, 'hours', 'Resolved breakdowns');
  // Summary by month or by year (hospital calendar).
  const key = (d: Date) => (c.q.group === 'year' ? monthInTz(d).slice(0, 4) : monthInTz(d));
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(key(r.x.raisedAt), [...(groups.get(key(r.x.raisedAt)) ?? []), r]);
  const periods = [...groups].sort(([a], [b]) => a.localeCompare(b));
  const plabel = (p: string) => (c.q.group === 'year' ? p : monthLabel(p));
  wb.charts.push(oneSeries('breakdowns-per-period', c.q.group === 'year' ? 'Breakdowns per year' : 'Breakdowns per month', 'column', 'Breakdowns', periods.map(([p, g]) => [plabel(p), g.length] as [string, number]), 'int'));
  wb.charts.push(oneSeries('downtime-per-period', c.q.group === 'year' ? 'Downtime per year' : 'Downtime per month', 'column', 'Downtime (h)', periods.map(([p, g]) => [plabel(p), Math.round((g.reduce((s, r) => s + (r.m.downtimeSeconds ?? 0), 0) / 3600) * 10) / 10] as [string, number]), 'hours', 'Resolved breakdowns'));
  wb.charts.push(oneSeries('top-breakdowns', 'Equipment with the most breakdowns', 'bar', 'Breakdowns', top(tally(rows, (r) => `${r.x.asset.assetCode} ${r.x.asset.name}`), 10), 'int'));
  wb.charts.push(oneSeries('breakdowns-by-department', 'Breakdowns by department', 'bar', 'Breakdowns', tally(rows, (r) => r.x.department.name), 'int'));
  addSheet(wb, c.q.group === 'year' ? 'By year' : 'By month', [
    { header: c.q.group === 'year' ? 'Year' : 'Month', key: 'period' }, { header: 'Breakdowns', key: 'count', fmt: 'int' }, { header: 'Resolved', key: 'resolved', fmt: 'int' },
    { header: 'Average response (h)', key: 'resp', fmt: 'hours', width: 20 }, { header: 'Total downtime (h)', key: 'down', fmt: 'hours', width: 18 }, { header: 'Average downtime (h)', key: 'avgDown', fmt: 'hours', width: 20 },
  ], [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([period, g]) => {
    const down = g.map((r) => r.m.downtimeSeconds).filter((v): v is number => v != null);
    const resp = g.map((r) => r.m.responseSeconds).filter((v): v is number => v != null);
    return { period: c.q.group === 'year' ? period : monthFull(period), count: g.length, resolved: down.length, resp: avg(resp) == null ? null : avg(resp)! / 3600, down: down.reduce((a, b) => a + b, 0) / 3600, avgDown: avg(down) == null ? null : avg(down)! / 3600 };
  }), ['count', 'resolved', 'down']);
}

// Downtime hours of one complaint inside [from, to): from raised until resolved (or until now / the end of the period if still open).
const overlapMs = (raised: Date, resolved: Date | null, from: Date, to: Date) => {
  const start = Math.max(raised.getTime(), from.getTime());
  const end = Math.min((resolved ?? new Date()).getTime(), to.getTime());
  return Math.max(0, end - start);
};

async function uptimeSheets(wb: Collector, c: Ctx, criticalOnly: boolean) {
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
  const withDown = rows.filter((r) => r.downMs > 0).sort((x, y) => y.downMs - x.downMs);
  kpi(wb, 'Overall uptime', totalPeriod ? 1 - totalDown / totalPeriod : null, 'pct', 'Planned hours: 24 a day', totalPeriod && totalDown / totalPeriod > 0.02 ? 'warn' : 'good');
  kpi(wb, 'Total downtime', hours(totalDown), 'hours');
  kpi(wb, criticalOnly ? 'Critical assets' : 'Assets measured', rows.length, 'int');
  kpi(wb, 'Assets with downtime', withDown.length, 'int', withDown.length ? undefined : 'None', withDown.length ? 'warn' : 'good');
  wb.charts.push(oneSeries('most-downtime', 'Equipment with the most downtime', 'bar', 'Downtime (h)', top(withDown, 10).map((r) => [`${r.a.assetCode} ${r.a.name}`, hours(r.downMs)] as [string, number]), 'hours'));
  wb.charts.push(oneSeries('lowest-uptime', 'Lowest uptime', 'bar', 'Uptime', top([...rows].sort((x, y) => x.downMs / x.periodMs - y.downMs / y.periodMs).reverse(), 10).map((r) => [`${r.a.assetCode} ${r.a.name}`, 1 - r.downMs / r.periodMs] as [string, number]), 'pct'));
  addSheet(wb, 'Summary', [{ header: 'Measure', key: 'k', width: 34 }, { header: 'Value', key: 'v', width: 16 }], [
    { k: criticalOnly ? 'Critical assets in the report' : 'Assets in the report', v: rows.length },
    { k: 'Total downtime (hours)', v: hours(totalDown) },
    { k: 'Overall uptime', v: totalPeriod ? `${((1 - totalDown / totalPeriod) * 100).toFixed(2)}%` : '—' },
    { k: 'Basis', v: '24 hours a day, from the date the asset was registered' },
  ]);

  if (criticalOnly) {
    const { criticalDowntimeHours } = await prisma.hospitalSettings.findFirstOrThrow({ select: { criticalDowntimeHours: true } });
    // Whole length of the event (not just the part inside the period); still-open ones count up to now.
    const lengthH = (x: { raisedAt: Date; resolvedAt: Date | null }) => hours((x.resolvedAt ?? new Date()).getTime() - x.raisedAt.getTime());
    const events = rows.flatMap(({ a, mine }) => mine.map((x) => ({ a, x })));
    const overLimit = events.filter(({ x }) => lengthH(x) > criticalDowntimeHours).length;
    kpi(wb, `Events over ${criticalDowntimeHours} h`, overLimit, 'int', overLimit ? 'Longer than the hospital limit' : 'None', overLimit ? 'bad' : 'good');
    kpi(wb, 'Downtime events', events.length, 'int');
    addSheet(wb, 'Downtime events', [
      { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Complaint no.', key: 'no' }, { header: 'Raised', key: 'raised', width: 20 },
      { header: 'Resolved', key: 'resolved', width: 20 }, { header: 'Downtime in period (h)', key: 'down', fmt: 'hours', width: 22 }, { header: 'Whole event (h)', key: 'whole', fmt: 'hours', width: 16 },
      { header: `Over ${criticalDowntimeHours} h limit`, key: 'over', width: 16 }, { header: 'Problem', key: 'desc', width: 40 },
    ], events.map(({ a, x }) => ({ whole: lengthH(x), over: lengthH(x) > criticalDowntimeHours ? 'YES' : '',  code: a.assetCode, name: a.name, no: x.complaintNo, raised: stamp(x.raisedAt), resolved: x.resolvedAt ? stamp(x.resolvedAt) : 'Still open', down: hours(overlapMs(x.raisedAt, x.resolvedAt, c.fromAt, periodEnd)), desc: x.description })));
  }
}

async function equipmentAge(wb: Collector, c: Ctx) {
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
  const aged = list.filter((l) => l.years != null).map((l) => l.years!);
  kpi(wb, 'Assets', list.length, 'int', 'All, including archived');
  kpi(wb, 'Average age', avg(aged), 'years');
  kpi(wb, 'Oldest', aged.length ? Math.max(...aged) : null, 'years');
  const old = aged.filter((y) => y >= 10).length;
  kpi(wb, '10 years or more', old, 'int', old ? 'Plan replacement' : 'None', old ? 'warn' : 'good');
  addSheet(wb, 'Age bands', [{ header: 'Age band', key: 'band', width: 24 }, { header: 'Assets', key: 'count', fmt: 'int' }, { header: 'Share', key: 'share', fmt: 'pct' }],
    bands.map((b) => ({ band: b, count: list.filter((l) => band(l.years) === b).length, share: list.length ? list.filter((l) => band(l.years) === b).length / list.length : 0 })), ['count']);

  const types = new Map<string, number[]>();
  for (const { a, years } of list) if (years != null) types.set(a.equipmentType.name, [...(types.get(a.equipmentType.name) ?? []), years]);
  wb.charts.push(oneSeries('age-bands', 'Equipment by age band', 'column', 'Assets', bands.map((b) => [b, list.filter((l) => band(l.years) === b).length] as [string, number]), 'int'));
  wb.charts.push(oneSeries('age-by-type', 'Average age by equipment type', 'bar', 'Years', [...types].map(([t, ys]) => [t, Math.round((ys.reduce((a, y) => a + y, 0) / ys.length) * 10) / 10] as [string, number]).sort((a, b) => b[1] - a[1]), 'years'));
  addSheet(wb, 'By equipment type', [{ header: 'Equipment type', key: 'type', width: 24 }, { header: 'Assets with an age', key: 'count', fmt: 'int', width: 18 }, { header: 'Average age (years)', key: 'avg', fmt: 'years', width: 20 }, { header: 'Oldest (years)', key: 'max', fmt: 'years' }],
    [...types].map(([type, ys]) => ({ type, count: ys.length, avg: ys.reduce((s, y) => s + y, 0) / ys.length, max: Math.max(...ys) })).sort((x, y) => y.avg - x.avg));
}

async function expenses(wb: Collector, c: Ctx) {
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

  const sum = (xs: typeof rows) => xs.reduce((t, e) => t + Number(e.amount), 0);
  const repairs = sum(rows.filter((e) => e.type === 'repair'));
  const spares = sum(rows.filter((e) => e.type === 'spare_part'));
  kpi(wb, 'Total spend', repairs + spares, 'money', span(c));
  kpi(wb, 'Repairs', repairs, 'money');
  kpi(wb, 'Spare parts', spares, 'money');
  kpi(wb, 'Entries', rows.length, 'int', rows.length ? `Average ₹ ${new Intl.NumberFormat('en-IN').format(Math.round((repairs + spares) / rows.length))}` : undefined);
  wb.charts.push({
    id: 'spend-per-month', title: 'Spend per month', kind: 'stacked', fmt: 'money',
    series: [{ key: 'repair', label: 'Repairs' }, { key: 'spare', label: 'Spare parts' }],
    data: monthKeys(c.from, c.to).map((m) => ({ label: monthLabel(m), repair: sum(rows.filter((e) => e.type === 'repair' && isoDate(e.date).slice(0, 7) === m)), spare: sum(rows.filter((e) => e.type === 'spare_part' && isoDate(e.date).slice(0, 7) === m)) })),
  });
  const spendByAsset = new Map<string, number>();
  for (const e of rows) spendByAsset.set(`${e.asset.assetCode} ${e.asset.name}`, (spendByAsset.get(`${e.asset.assetCode} ${e.asset.name}`) ?? 0) + Number(e.amount));
  wb.charts.push(oneSeries('spend-by-asset', 'Equipment with the highest spend', 'bar', 'Spend', top([...spendByAsset].sort((a, b) => b[1] - a[1]), 10), 'money'));
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
    [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, total]) => ({ month: monthFull(month), total })), ['total']);
}

async function warrantyContracts(wb: Collector, c: Ctx) {
  const today = parseDate(todayISO());
  const [assets, contracts] = await Promise.all([
    prisma.asset.findMany({ where: { ...c.scope }, include: assetInclude, orderBy: { assetCode: 'asc' } }),
    prisma.serviceContract.findMany({ where: { asset: { ...c.scope } }, include: { asset: { include: { department: true } } }, orderBy: { endDate: 'asc' } }),
  ]);
  const left = (d: Date) => daysFromToday(d);
  const contractState = (k: (typeof contracts)[number]) => (k.endDate < today ? 'Ended' : k.startDate > today ? 'Upcoming' : left(k.endDate) <= 30 ? 'Ends soon' : 'Running');
  const running = (assetId: string) => contracts.some((k) => k.assetId === assetId && k.startDate <= today && k.endDate >= today);
  const covered = (a: (typeof assets)[number]) => (a.warrantyEnd != null && a.warrantyEnd >= today) || running(a.id);
  const noCover = assets.filter((a) => a.status === 'active' && !covered(a));
  const warranties = assets.filter((a) => a.warrantyEnd);

  const wEnd = (max: number) => warranties.filter((a) => a.status === 'active' && left(a.warrantyEnd!) >= 0 && left(a.warrantyEnd!) <= max).length;
  const kEnd = contracts.filter((k) => k.asset.status === 'active' && left(k.endDate) >= 0 && left(k.endDate) <= 30).length;
  kpi(wb, 'Warranty ending in 30 days', wEnd(30), 'int', undefined, wEnd(30) ? 'warn' : 'good');
  kpi(wb, 'Warranty ending in 90 days', wEnd(90), 'int');
  kpi(wb, 'Contracts ending in 30 days', kEnd, 'int', kEnd ? 'Renew or replace' : 'None', kEnd ? 'warn' : 'good');
  kpi(wb, 'Active equipment with no cover', noCover.length, 'int', noCover.length ? 'Out of warranty and no running contract' : 'All covered', noCover.length ? 'bad' : 'good');
  const ahead = monthKeys(todayISO(), isoDate(addMonths(today, 11)));
  wb.charts.push({
    id: 'expiries-ahead', title: 'Warranties and contracts ending, next 12 months', kind: 'stacked', fmt: 'int',
    series: [{ key: 'warranty', label: 'Warranties' }, { key: 'contract', label: 'Contracts' }],
    data: ahead.map((m) => ({
      label: monthLabel(m),
      warranty: warranties.filter((a) => a.status === 'active' && left(a.warrantyEnd!) >= 0 && isoDate(a.warrantyEnd!).slice(0, 7) === m).length,
      contract: contracts.filter((k) => k.asset.status === 'active' && left(k.endDate) >= 0 && isoDate(k.endDate).slice(0, 7) === m).length,
    })),
  });
  wb.charts.push(oneSeries('cover-state', 'Active equipment by cover', 'column', 'Assets', [
    ['Under warranty', assets.filter((a) => a.status === 'active' && a.warrantyEnd != null && a.warrantyEnd >= today).length],
    ['Under contract', assets.filter((a) => a.status === 'active' && !(a.warrantyEnd != null && a.warrantyEnd >= today) && running(a.id)).length],
    ['No cover', noCover.length],
  ], 'int', 'Warranty first, then a running contract'));

  addSheet(wb, 'Warranty', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 22 }, { header: 'Status', key: 'status' },
    { header: 'Installed', key: 'installed', fmt: 'date' }, { header: 'Warranty ends', key: 'ends', fmt: 'date' }, { header: 'Days left (negative = ended)', key: 'days', fmt: 'int', width: 26 },
  ], warranties.map((a) => ({ code: a.assetCode, name: a.name, dept: a.department.name, status: STATUS_LABEL[a.status], installed: a.installationDate, ends: a.warrantyEnd, days: left(a.warrantyEnd!) })).sort((x, y) => x.days - y.days));
  addSheet(wb, 'Contracts', [
    { header: 'Type', key: 'type' }, { header: 'Vendor', key: 'vendor', width: 24 }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Asset status', key: 'astatus' },
    { header: 'Starts', key: 'start', fmt: 'date' }, { header: 'Ends', key: 'end', fmt: 'date' }, { header: 'Days left (negative = ended)', key: 'days', fmt: 'int', width: 26 }, { header: 'State', key: 'state' }, { header: 'Cost', key: 'cost', fmt: 'money', width: 16 },
  ], contracts.map((k) => ({ type: k.type.toUpperCase().replace('_', '-'), vendor: k.vendor, code: k.asset.assetCode, name: k.asset.name, astatus: STATUS_LABEL[k.asset.status], start: k.startDate, end: k.endDate, days: left(k.endDate), state: contractState(k), cost: k.cost == null ? null : Number(k.cost) })));
  addSheet(wb, 'No cover (active)', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 22 }, { header: 'Criticality', key: 'crit' }, { header: 'Warranty ended', key: 'ended', fmt: 'date' },
  ], noCover.map((a) => ({ code: a.assetCode, name: a.name, dept: a.department.name, crit: a.criticality, ended: a.warrantyEnd })).sort((x, y) => (x.crit === 'critical' ? -1 : 0) - (y.crit === 'critical' ? -1 : 0)));
}

// ---------- Entry point ----------

// Reports that are "as at today" rather than for a period.
const SNAPSHOT: ReportType[] = ['asset-master', 'equipment-age', 'warranty-contracts'];

export async function buildReport(type: ReportType, req: Request, q: ReportQuery): Promise<{ data: ReportData; filename: string }> {
  const today = todayISO();
  const to = q.to ?? today;
  const from = q.from ?? isoDate(addMonths(parseDate(to), -12));
  const ctx: Ctx = { req, q, from, to, fromAt: zonedDayStart(from), toAt: zonedDayStart(addDaysISO(to, 1)), scope: departmentScope(currentUser(req)) };

  const out: Collector = { sheets: [], kpis: [], charts: [] };
  const settings = await prisma.hospitalSettings.findFirstOrThrow({ select: { name: true } });

  const builders: Record<ReportType, () => Promise<void>> = {
    'asset-master': () => assetMaster(out, ctx),
    pms: () => pms(out, ctx),
    calibration: () => calibration(out, ctx),
    breakdowns: () => breakdowns(out, ctx),
    uptime: () => uptimeSheets(out, ctx, false),
    'critical-downtime': () => uptimeSheets(out, ctx, true),
    'equipment-age': () => equipmentAge(out, ctx),
    expenses: () => expenses(out, ctx),
    'warranty-contracts': () => warrantyContracts(out, ctx),
  };
  await builders[type]();

  const ranged = !SNAPSHOT.includes(type);
  const meta = REPORTS.find((r) => r.type === type)!;
  const data: ReportData = {
    type,
    title: meta.title,
    hospital: settings.name,
    from: ranged ? from : null,
    to: ranged ? to : null,
    group: type === 'breakdowns' ? q.group : null,
    generatedAt: new Date().toISOString(),
    generatedBy: currentUser(req).name,
    note: 'Condemned and not-in-use assets are included and labelled in the Status column.',
    ...out,
  };
  return { data, filename: `bme-${type}-${ranged ? `${from}_to_${to}` : today}` };
}

// ---------- One asset's whole life ----------

const SERVICE_KIND: Record<string, string> = { amc_visit: 'AMC visit', cmc_visit: 'CMC visit', repair: 'Repair', inspection: 'Inspection', other: 'Other' };
const DOC_KIND: Record<string, string> = {
  po: 'Purchase order', installation_report: 'Installation report', photo: 'Photo', manual: 'Manual', certificate: 'Certificate', eol_letter: 'End-of-life letter',
  contract: 'Contract copy', service_report: 'Service report', invoice: 'Invoice', condemnation_form: 'Condemnation form', other: 'Other',
};

// "From installation to today" for one piece of equipment: what it is, what was bought, every PMS, calibration,
// breakdown, service and (for those allowed to see costs) expense, and the documents on file. One sheet each.
export async function buildAssetHistory(req: Request, assetId: string) {
  const me = currentUser(req);
  const asset = await prisma.asset.findFirstOrThrow({ where: { id: assetId, ...departmentScope(me) }, include: assetInclude });
  const canSeeCosts = me.permissions.includes('expense.manage');
  const [orders, contracts, pmsRecords, calibrations, complaints, logs, expenses, settings] = await Promise.all([
    prisma.purchaseOrder.findMany({ where: { assetId }, orderBy: { poDate: 'asc' } }),
    prisma.serviceContract.findMany({ where: { assetId }, orderBy: { startDate: 'asc' } }),
    prisma.pmsRecord.findMany({ where: { assetId }, orderBy: { performedOn: 'asc' } }),
    prisma.calibrationRecord.findMany({ where: { assetId }, orderBy: { doneOn: 'asc' } }),
    prisma.complaint.findMany({ where: { assetId }, include: { raisedBy: true }, orderBy: { raisedAt: 'asc' } }),
    prisma.serviceLog.findMany({ where: { assetId }, orderBy: { serviceDate: 'asc' } }),
    canSeeCosts ? prisma.serviceExpense.findMany({ where: { assetId }, include: { complaint: true }, orderBy: { date: 'asc' } }) : [],
    prisma.hospitalSettings.findFirstOrThrow({ select: { name: true } }),
  ]);

  // Documents on the asset itself and on each of its records.
  const owners: [string, string[]][] = [
    ['asset', [assetId]], ['purchase_order', orders.map((o) => o.id)], ['service_contract', contracts.map((c) => c.id)], ['complaint', complaints.map((c) => c.id)],
    ['service_log', logs.map((l) => l.id)], ['calibration_record', calibrations.map((c) => c.id)], ['service_expense', expenses.map((e) => e.id)],
  ];
  const files = (await Promise.all(owners.map(([ownerType, ids]) => prisma.attachment.findMany({ where: { ownerType, ownerId: { in: ids } }, orderBy: { createdAt: 'asc' } })))).flat()
    .filter((f) => canSeeCosts || f.ownerType !== 'service_expense');
  const users = await prisma.user.findMany({ where: { id: { in: pmsRecords.map((p) => p.performedBy) } }, select: { id: true, name: true } });
  const r = toAssetRow(asset);
  const downtimeS = complaints.reduce((s, c) => s + (complaintMetrics(c).downtimeSeconds ?? 0), 0);

  const wb: Collector = { sheets: [], kpis: [], charts: [] };
  kpi(wb, 'PMS done', pmsRecords.length, 'int', 'In this system');
  kpi(wb, 'Calibrations', calibrations.length, 'int');
  kpi(wb, 'Breakdowns', complaints.length, 'int');
  kpi(wb, 'Total downtime', hoursOf(downtimeS), 'hours');
  kpi(wb, 'Service entries', logs.length, 'int');
  if (canSeeCosts) kpi(wb, 'Total expenses', expenses.reduce((t, e) => t + Number(e.amount), 0), 'money');
  kpi(wb, 'Documents', files.length, 'int');

  addSheet(wb, 'Summary', [{ header: 'Item', key: 'k', width: 30 }, { header: 'Value', key: 'v', width: 50 }], [
    { k: 'Asset ID', v: asset.assetCode }, { k: 'Name', v: asset.name }, { k: 'Equipment type', v: asset.equipmentType.name },
    { k: 'Make / model', v: [asset.make, asset.model].filter(Boolean).join(' ') }, { k: 'Serial no', v: asset.serialNo },
    { k: 'Department / location', v: `${asset.department.name} / ${asset.location.name}` }, { k: 'Criticality', v: asset.criticality },
    { k: 'Status', v: STATUS_LABEL[asset.status] }, { k: 'Installed', v: asset.installationDate ? isoDate(asset.installationDate) : '' },
    { k: 'Age (years)', v: r.ageMonths == null ? '' : Math.round((r.ageMonths / 12) * 10) / 10 }, { k: 'Warranty ends', v: asset.warrantyEnd ? isoDate(asset.warrantyEnd) : '' },
    { k: 'PMS every (months)', v: asset.pmsFrequencyMonths }, { k: 'Last PMS before this system', v: asset.openingPmsOn ? isoDate(asset.openingPmsOn) : '' },
    { k: 'Last calibration before this system', v: asset.openingCalibrationOn ? isoDate(asset.openingCalibrationOn) : '' },
    { k: 'Next PMS due', v: asset.nextPmsDue ? isoDate(asset.nextPmsDue) : '' }, { k: 'Next calibration due', v: asset.nextCalibrationDue ? isoDate(asset.nextCalibrationDue) : '' },
    { k: 'PMS done (this system)', v: pmsRecords.length }, { k: 'Calibrations recorded', v: calibrations.length }, { k: 'Breakdowns', v: complaints.length },
    { k: 'Total downtime (hours)', v: hoursOf(downtimeS) }, { k: 'Service entries', v: logs.length },
    ...(canSeeCosts ? [{ k: 'Total expenses (₹)', v: expenses.reduce((s, e) => s + Number(e.amount), 0) }] : []),
    { k: 'Documents on file', v: files.length },
  ]);
  addSheet(wb, 'Purchase orders', [{ header: 'PO number', key: 'no', width: 20 }, { header: 'PO date', key: 'date', fmt: 'date' }, { header: 'Vendor', key: 'vendor', width: 26 }, { header: 'Cost', key: 'cost', fmt: 'money', width: 16 }],
    orders.map((o) => ({ no: o.poNumber, date: o.poDate, vendor: o.vendor, cost: Number(o.cost) })));
  addSheet(wb, 'Contracts', [{ header: 'Type', key: 'type' }, { header: 'Vendor', key: 'vendor', width: 26 }, { header: 'Start', key: 'start', fmt: 'date' }, { header: 'End', key: 'end', fmt: 'date' }, { header: 'Cost', key: 'cost', fmt: 'money', width: 16 }],
    contracts.map((c) => ({ type: c.type.toUpperCase().replace('_', '-'), vendor: c.vendor, start: c.startDate, end: c.endDate, cost: c.cost == null ? null : Number(c.cost) })));
  addSheet(wb, 'PMS', [{ header: 'Date', key: 'date', fmt: 'date' }, { header: 'Done by', key: 'by', width: 22 }, { header: 'Result', key: 'result' }, { header: 'Correction of an earlier record', key: 'corr', width: 30 }, { header: 'Correction reason', key: 'why', width: 36 }],
    pmsRecords.map((p) => ({ date: p.performedOn, by: users.find((u) => u.id === p.performedBy)?.name ?? '', result: p.result.toUpperCase(), corr: p.correctsRecordId ? 'Yes' : '', why: p.correctionReason })));
  addSheet(wb, 'Calibration', [{ header: 'Done on', key: 'done', fmt: 'date' }, { header: 'Next due', key: 'due', fmt: 'date' }, { header: 'Agency', key: 'agency', width: 24 }, { header: 'Result', key: 'result' }],
    calibrations.map((c) => ({ done: c.doneOn, due: c.dueOn, agency: c.agency, result: c.result.toUpperCase() })));
  addSheet(wb, 'Complaints', [
    { header: 'Complaint no.', key: 'no', width: 14 }, { header: 'Raised', key: 'raised', width: 20 }, { header: 'Raised by', key: 'by', width: 20 }, { header: 'Problem', key: 'desc', width: 40 },
    { header: 'Status', key: 'status' }, { header: 'Started', key: 'started', width: 20 }, { header: 'Resolved', key: 'resolved', width: 20 }, { header: 'Response (h)', key: 'resp', fmt: 'hours' },
    { header: 'Downtime (h)', key: 'down', fmt: 'hours' }, { header: 'What was done', key: 'notes', width: 40 },
  ], complaints.map((c) => {
    const m = complaintMetrics(c);
    return { no: c.complaintNo, raised: stamp(c.raisedAt), by: c.raisedBy.name, desc: c.description, status: c.status.replace('_', ' '), started: stamp(c.startedAt), resolved: stamp(c.resolvedAt), resp: hoursOf(m.responseSeconds), down: hoursOf(m.downtimeSeconds), notes: c.resolutionNotes };
  }));
  addSheet(wb, 'Service log', [{ header: 'Date', key: 'date', fmt: 'date' }, { header: 'Kind', key: 'kind' }, { header: 'Vendor', key: 'vendor', width: 24 }, { header: 'What was done', key: 'desc', width: 50 }],
    logs.map((l) => ({ date: l.serviceDate, kind: SERVICE_KIND[l.kind], vendor: l.vendor, desc: l.description })));
  if (canSeeCosts) {
    addSheet(wb, 'Expenses', [{ header: 'Date', key: 'date', fmt: 'date' }, { header: 'Type', key: 'type' }, { header: 'Description', key: 'desc', width: 40 }, { header: 'Vendor', key: 'vendor', width: 22 }, { header: 'Complaint', key: 'complaint' }, { header: 'Amount', key: 'amount', fmt: 'money', width: 16 }],
      expenses.map((e) => ({ date: e.date, type: e.type === 'spare_part' ? 'Spare part' : 'Repair', desc: e.description, vendor: e.vendor, complaint: e.complaint?.complaintNo, amount: Number(e.amount) })), ['amount']);
  }
  addSheet(wb, 'Documents', [{ header: 'File', key: 'name', width: 40 }, { header: 'Kind', key: 'kind', width: 20 }, { header: 'Attached to', key: 'owner', width: 20 }, { header: 'Added', key: 'added', width: 20 }],
    files.map((f) => ({ name: f.fileName, kind: DOC_KIND[f.kind] ?? f.kind, owner: f.ownerType.replace(/_/g, ' '), added: stamp(f.createdAt) })));
  const data: ReportData = {
    type: 'asset-history',
    title: `Full history of ${asset.assetCode}`,
    hospital: settings.name,
    from: null,
    to: null,
    group: null,
    generatedAt: new Date().toISOString(),
    generatedBy: me.name,
    note: asset.status === 'condemned' ? 'This equipment has been CONDEMNED. Its history is kept.' : null,
    ...wb,
  };
  return { data, filename: `bme-history-${asset.assetCode}-${todayISO()}`, assetCode: asset.assetCode };
}
