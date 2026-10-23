import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { LICENCE_KIND_LABEL, ASSET_STATUS_LABEL, COMPLAINT_STATUS_LABEL, CONDEMN_REASON_LABEL, CONDEMN_REASONS, CRITICAL_LEVELS, CRITICALITIES, CRITICALITY_LABEL, isCritical, isLowStock, REGISTER_LABEL, REPORTS, type ChartSpec, type Kpi, type ReportColumn, type ReportData, type ReportQuery, type ReportSheetData, type ReportType, type ValueFmt, type CondemnReason } from '@bme/shared';
import { currentUser, scopeOf, type Scope } from '../../lib/auth';
import { addDaysISO, addMonths, daysFromToday, isoDate, monthInTz, parseDate, prettyDate, todayISO, zonedDayStart } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { facilityOn } from '../../lib/people';
import { assetInclude, toAssetRow, type AssetWithRefs } from '../assets/assets.service';
import { complaintMetrics, machineDownMs } from '../complaints/complaints.service';
import { licenceInclude, toLicenceRows } from '../licences/licences.routes';
import { effective, runHoursInfo } from '../readings/readings.service';

// ---------- What a builder produces ----------

// Builders add tables (sheets), headline figures and charts here. The screen shows them as they are; Excel and PDF are
// made from the same data (reports.export.ts), so the three can never disagree.
type Col = ReportColumn;
type Row = Record<string, unknown>;
export type Collector = { sheets: ReportSheetData[]; kpis: Kpi[]; charts: ChartSpec[] };

// Dates become YYYY-MM-DD here, once, so everything downstream is plain JSON.
const plain = (v: unknown): string | number | null => (v instanceof Date ? isoDate(v) : typeof v === 'number' ? v : v == null || v === '' ? null : String(v));

export function addSheet(out: Collector, name: string, cols: Col[], rows: Row[], totals?: string[]) {
  out.sheets.push({
    name,
    columns: cols.map((c) => ({ ...c, width: c.width ?? Math.max(12, c.header.length + 2) })),
    // A date-time column keeps the instant (ISO); the screen, Excel and PDF show it in hospital time.
    rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c.key, c.fmt === 'datetime' && r[c.key] instanceof Date ? (r[c.key] as Date).toISOString() : plain(r[c.key])]))),
    totals,
  });
}

export const kpi = (out: Collector, label: string, value: number | string | null, fmt: ValueFmt, hint?: string, tone?: Kpi['tone']) => out.kpis.push({ label, value, fmt, hint, tone });

// A chart of one measure. `entries` are [label, value] pairs in the order to show.
export const oneSeries = (id: string, title: string, kind: 'column' | 'bar' | 'line', unit: string, entries: [string, number][], fmt: ValueFmt, subtitle?: string): ChartSpec => ({
  id, title, subtitle, kind, fmt, series: [{ key: 'v', label: unit }], data: entries.map(([label, v]) => ({ label, v })),
});
// Oct 2025 (the longer form, for table cells); monthLabel is the short one for chart axes.
export const monthFull = (key: string) => new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(parseDate(`${key}-01`));
export const monthLabel = (key: string) => new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(parseDate(`${key}-01`));
// Every month from `from` to `to` (YYYY-MM-DD), so a quiet month shows as zero instead of vanishing.
export const monthKeys = (from: string, to: string) => {
  const keys: string[] = [];
  for (let d = parseDate(`${from.slice(0, 7)}-01`); isoDate(d).slice(0, 7) <= to.slice(0, 7); d = addMonths(d, 1)) keys.push(isoDate(d).slice(0, 7));
  return keys;
};
// Periods for "by month / by year / by financial year" summaries. Every period in the range is listed, so a quiet
// one shows as zero instead of vanishing. A financial year runs 1 April to 31 March: FY2025 = Apr 2025 – Mar 2026.
type Group = ReportQuery['group'];
const periodOfMonth = (monthKey: string, group: Group) => {
  if (group === 'month') return monthKey;
  const [y, m] = monthKey.split('-').map(Number);
  return group === 'year' ? String(y) : `FY${m >= 4 ? y : y - 1}`;
};
const periodKeys = (from: string, to: string, group: Group) => [...new Set(monthKeys(from, to).map((m) => periodOfMonth(m, group)))];
const periodName = (p: string, group: Group, full = false) => {
  if (group === 'month') return full ? monthFull(p) : monthLabel(p);
  if (group === 'year') return p;
  const y = Number(p.slice(2));
  return `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};
const PER: Record<Group, string> = { month: 'per month', year: 'per year', fy: 'per financial year' };

export const top = <T,>(items: T[], n: number) => items.slice(0, n);
const span = (c: { from: string; to: string }) => `${prettyDate(parseDate(c.from))} to ${prettyDate(parseDate(c.to))}`;
// Count items by a label, biggest first.
export const tally = <T,>(items: T[], label: (t: T) => string): [string, number][] => {
  const m = new Map<string, number>();
  for (const i of items) m.set(label(i), (m.get(label(i)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};
export const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

export type Ctx = { q: ReportQuery; from: string; to: string; fromAt: Date; toAt: Date; scope: Scope };
// A period in hospital days, for one department and / or register, or (empty scope) the whole hospital.
export const periodCtx = (from: string, to: string, scope: Ctx['scope'], q: Partial<ReportQuery> = {}): Ctx => ({
  q: { group: 'month', format: 'json', ...q } as ReportQuery,
  from,
  to,
  fromAt: zonedDayStart(from),
  toAt: zonedDayStart(addDaysISO(to, 1)),
  scope,
});

export const STATUS_LABEL: Record<string, string> = { active: 'Active', not_in_use: 'Not in use', condemned: 'CONDEMNED', transferred: 'TRANSFERRED' };
export const hours = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100;
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
    ...(q.search && { OR: ['assetCode', 'name', 'serialNo', 'tagNo', 'make', 'model'].map((f) => ({ [f]: { contains: q.search, mode: 'insensitive' as const } })) }),
  };
  const assets = await prisma.asset.findMany({ where, include: assetInclude, orderBy: { assetCode: 'asc' } });
  const rowsOf = assets.map(toAssetRow);
  const active = assets.filter((a) => a.status === 'active');
  kpi(wb, 'Assets', assets.length, 'int', 'All, including archived');
  kpi(wb, 'Active', active.length, 'int');
  kpi(wb, 'Not in use', assets.filter((a) => a.status === 'not_in_use').length, 'int');
  kpi(wb, 'Condemned', assets.filter((a) => a.status === 'condemned').length, 'int');
  const transferred = assets.filter((a) => a.status === 'transferred').length;
  if (transferred) kpi(wb, 'Transferred', transferred, 'int', 'To other units');
  kpi(wb, 'Critical (active)', active.filter((a) => isCritical(a.criticality)).length, 'int');
  const expiring = rowsOf.filter((r, i) => assets[i].status === 'active' && r.warrantyStatus === 'expiring').length;
  kpi(wb, 'Warranty ending in 30 days', expiring, 'int', expiring ? 'Plan a contract' : 'None', expiring ? 'warn' : 'good');
  wb.charts.push(oneSeries('by-department', 'Active equipment by department', 'bar', 'Assets', tally(active, (a) => a.department.name), 'int'));
  wb.charts.push(oneSeries('by-type', 'Active equipment by type', 'bar', 'Assets', top(tally(active, (a) => a.equipmentType.name), 10), 'int'));
  wb.charts.push(oneSeries('by-criticality', 'Active equipment by criticality', 'column', 'Assets', CRITICALITIES.map((c) => [CRITICALITY_LABEL[c], active.filter((a) => a.criticality === c).length] as [string, number]), 'int'));
  wb.charts.push(oneSeries('by-status', 'Equipment by status', 'column', 'Assets', [['Active', active.length], ['Not in use', assets.filter((a) => a.status === 'not_in_use').length], ['Condemned', assets.filter((a) => a.status === 'condemned').length], ...(transferred ? [['Transferred', transferred] as [string, number]] : [])], 'int'));
  addSheet(wb, 'Asset master', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Name', key: 'name', width: 28 }, { header: 'Equipment type', key: 'type', width: 18 },
    { header: 'Make', pdf: false, key: 'make' }, { header: 'Model', pdf: false, key: 'model' }, { header: 'Serial no', pdf: false, key: 'serial', width: 18 },
    { header: 'Tag no', pdf: false, key: 'tag', width: 16 }, { header: 'Department', key: 'dept', width: 22 }, { header: 'Location', key: 'loc', width: 16 }, { header: 'Criticality', key: 'crit' },
    { header: 'Status', key: 'status' }, { header: 'Installed', key: 'installed', fmt: 'date' }, { header: 'Age (years)', pdf: false, key: 'age', fmt: 'years' },
    { header: 'Warranty ends', key: 'warranty', fmt: 'date' }, { header: 'PMS every (months)', pdf: false, key: 'pmsMonths', fmt: 'int' },
    { header: 'Next PMS due', key: 'pms', fmt: 'date' }, { header: 'Next calibration due', key: 'cal', fmt: 'date' },
    { header: 'Supplier', pdf: false, key: 'supplier', width: 22 }, { header: 'Service vendor', pdf: false, key: 'servicer', width: 22 },
  ], assets.map((a) => {
    const r = toAssetRow(a);
    return {
      code: a.assetCode, name: a.name, type: a.equipmentType.name, make: a.make, model: a.model, serial: a.serialNo, tag: a.tagNo, dept: a.department.name, loc: a.location.name,
      crit: CRITICALITY_LABEL[a.criticality], status: STATUS_LABEL[a.status], installed: a.installationDate, age: r.ageMonths == null ? null : Math.round((r.ageMonths / 12) * 10) / 10,
      warranty: a.warrantyEnd, pmsMonths: a.pmsFrequencyMonths, pms: a.status === 'active' ? a.nextPmsDue : null, cal: a.status === 'active' ? a.nextCalibrationDue : null,
      supplier: a.supplier?.name ?? null, servicer: a.serviceVendor?.name ?? null,
    };
  }));
}

// Each PMS counts once. A correction is a new record (rule 1) but not another PMS: it replaces the result of the PMS
// it corrects, whenever it was made. Returns the PMS that were done (originals, on their own date) with the result of
// their latest correction.
export async function pmsDone<T extends { id: string; correctsRecordId: string | null; result: string }>(records: T[]): Promise<T[]> {
  const originals = records.filter((r) => !r.correctsRecordId);
  const rootOf = new Map(originals.map((r) => [r.id, r.id]));
  const latest = new Map<string, { result: string; submittedAt: Date }>();
  for (let frontier = originals.map((r) => r.id); frontier.length; ) {
    const corrections = await prisma.pmsRecord.findMany({ where: { correctsRecordId: { in: frontier } }, select: { id: true, correctsRecordId: true, result: true, submittedAt: true } });
    for (const x of corrections) {
      const root = rootOf.get(x.correctsRecordId!)!;
      rootOf.set(x.id, root);
      const seen = latest.get(root);
      if (!seen || x.submittedAt > seen.submittedAt) latest.set(root, x);
    }
    frontier = corrections.map((x) => x.id);
  }
  return originals.map((r) => ({ ...r, result: latest.get(r.id)?.result ?? r.result }));
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
    { header: 'Department', key: 'dept', width: 22 }, { header: 'Asset status', pdf: false, key: 'status' }, { header: 'Result', key: 'result' }, { header: 'Done by', key: 'doneBy', width: 26 },
    { header: 'Entered by', pdf: false, key: 'by', width: 20 },
    { header: 'Checklist version', pdf: false, key: 'version', fmt: 'int' }, { header: 'Correction', key: 'correction' }, { header: 'Correction reason', pdf: false, key: 'reason', width: 30 },
  ], records.map((r) => ({
    date: r.performedOn, code: r.asset.assetCode, name: r.asset.name, type: r.asset.equipmentType.name, dept: r.asset.department.name, status: STATUS_LABEL[r.asset.status],
    result: r.result.toUpperCase(), by: users.find((u) => u.id === r.performedBy)?.name ?? '', version: r.template?.version ?? null,
    // In-house: the engineer who did and entered it. OEM: the engineer and company from their report.
    doneBy: r.kind === 'oem' ? `OEM: ${r.serviceBy ?? ''}` : (users.find((u) => u.id === r.performedBy)?.name ?? ''), correction: r.correctsRecordId ? 'Yes' : 'No', reason: r.correctionReason,
  })));
  const done = await pmsDone(records);
  const byType = new Map<string, { count: number; pass: number }>();
  for (const r of done) {
    const t = byType.get(r.asset.equipmentType.name) ?? { count: 0, pass: 0 };
    byType.set(r.asset.equipmentType.name, { count: t.count + 1, pass: t.pass + (r.result === 'pass' ? 1 : 0) });
  }
  const passed = done.filter((r) => r.result === 'pass').length;
  kpi(wb, 'PMS done', done.length, 'int', span(c));
  kpi(wb, 'Pass rate', done.length ? passed / done.length : null, 'pct', done.length ? undefined : 'No PMS in this period', done.length && passed / done.length < 0.9 ? 'warn' : 'good');
  kpi(wb, 'Failed', done.length - passed, 'int', done.length - passed ? 'Check these assets' : 'None', done.length - passed ? 'bad' : 'good');
  kpi(wb, 'Corrections', records.filter((r) => r.correctsRecordId).length, 'int', 'Records that correct an earlier one');
  const months = monthKeys(c.from, c.to);
  wb.charts.push(oneSeries('pms-per-month', 'PMS done per month', 'column', 'PMS done', months.map((m) => [monthLabel(m), done.filter((r) => isoDate(r.performedOn).slice(0, 7) === m).length] as [string, number]), 'int'));
  wb.charts.push({ ...oneSeries('pms-by-type', 'PMS done by equipment type', 'bar', 'PMS done', [...byType].map(([t, v]) => [t, v.count] as [string, number]).sort((a, b) => b[1] - a[1]), 'int'), print: false });
  addSheet(wb, 'Summary', [
    { header: 'Equipment type', key: 'type', width: 22 }, { header: 'PMS done', key: 'count', fmt: 'int' }, { header: 'Passed', key: 'pass', fmt: 'int' }, { header: 'Failed', key: 'fail', fmt: 'int' },
    { header: 'Pass rate', key: 'rate', fmt: 'pct' },
  ], [...byType].map(([type, t]) => ({ type, count: t.count, pass: t.pass, fail: t.count - t.pass, rate: t.pass / t.count })), ['count', 'pass', 'fail']);
}

async function calibration(wb: Collector, c: Ctx) {
  // A record replaced by a correction no longer counts; the correction does.
  const records = await prisma.calibrationRecord.findMany({
    where: { doneOn: { gte: parseDate(c.from), lte: parseDate(c.to) }, asset: { ...c.scope }, correctedBy: { is: null } },
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

// Breakdowns are complaints about a machine; ward faults without one are in the trades report.
async function breakdowns(wb: Collector, c: Ctx) {
  const found = await prisma.complaint.findMany({
    where: { raisedAt: { gte: c.fromAt, lt: c.toAt }, assetId: { not: null }, ...c.scope, ...(c.q.departmentId && { departmentId: c.q.departmentId }), ...(c.q.complaintStatus && { status: c.q.complaintStatus }),
      ...(c.q.search && { OR: [{ complaintNo: { contains: c.q.search, mode: 'insensitive' as const } }, { description: { contains: c.q.search, mode: 'insensitive' as const } }, { asset: { assetCode: { contains: c.q.search, mode: 'insensitive' as const } } }, { asset: { name: { contains: c.q.search, mode: 'insensitive' as const } } }] }) },
    include: { asset: true, department: true, raisedBy: true },
    orderBy: { raisedAt: 'asc' },
  });
  const complaints = found.map((x) => ({ ...x, asset: x.asset! }));
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(complaints.flatMap((x) => [x.startedBy, x.resolvedBy]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? '') : '');
  const rows = complaints.map((x) => ({ x, m: complaintMetrics(x) }));
  addSheet(wb, 'Breakdowns', [
    { header: 'Complaint no.', key: 'no' }, { header: 'Raised', key: 'raised', fmt: 'datetime', width: 20 }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'asset', width: 26 },
    { header: 'Department', key: 'dept', width: 22 }, { header: 'Criticality', key: 'crit' }, { header: 'Asset status', pdf: false, key: 'astatus' }, { header: 'Problem', key: 'desc', width: 40 },
    { header: 'Raised by', pdf: false, key: 'by', width: 20 }, { header: 'Status', key: 'status' }, { header: 'Started', pdf: false, key: 'started', fmt: 'datetime', width: 20 }, { header: 'Started by', pdf: false, key: 'startedBy', width: 20 },
    { header: 'Resolved', pdf: false, key: 'resolved', fmt: 'datetime', width: 20 }, { header: 'Resolved by', pdf: false, key: 'resolvedBy', width: 20 }, { header: 'Closed', pdf: false, key: 'closed', fmt: 'datetime', width: 20 },
    { header: 'Response time (h)', key: 'resp', fmt: 'hours', width: 18 },
    { header: 'Downtime (h)', key: 'down', fmt: 'hours' }, { header: 'Resolution', key: 'notes', width: 40 },
  ], rows.map(({ x, m }) => ({
    no: x.complaintNo, raised: x.raisedAt, code: x.asset.assetCode, asset: x.asset.name, dept: x.department.name, crit: CRITICALITY_LABEL[x.asset.criticality], astatus: STATUS_LABEL[x.asset.status], desc: x.description,
    by: x.raisedBy.name, status: COMPLAINT_STATUS_LABEL[x.status], started: x.startedAt, startedBy: name(x.startedBy), resolved: x.resolvedAt, resolvedBy: name(x.resolvedBy), closed: x.closedAt,
    resp: hoursOf(m.responseSeconds), down: hoursOf(m.downtimeSeconds), notes: x.resolutionNotes,
  })));

  const downs = rows.map((r) => r.m.downtimeSeconds).filter((v): v is number => v != null);
  const resps = rows.map((r) => r.m.responseSeconds).filter((v): v is number => v != null);
  const stillOpen = rows.filter((r) => !r.x.resolvedAt).length;
  kpi(wb, 'Breakdowns', rows.length, 'int', span(c));
  kpi(wb, 'Still open', stillOpen, 'int', stillOpen ? 'Waiting for a fix' : 'All resolved', stillOpen ? 'warn' : 'good');
  kpi(wb, 'Average response', avg(resps) == null ? null : avg(resps)! / 3600, 'hours', 'Raised to started');
  kpi(wb, 'Average downtime', avg(downs) == null ? null : avg(downs)! / 3600, 'hours', 'Raised to resolved');
  kpi(wb, 'Total downtime', downs.reduce((a, b) => a + b, 0) / 3600, 'hours', 'Resolved breakdowns');
  // Summary by month, by year or by financial year (hospital calendar), every period in the range.
  const group = c.q.group;
  const groups = new Map<string, typeof rows>(periodKeys(c.from, c.to, group).map((p) => [p, []]));
  for (const r of rows) groups.get(periodOfMonth(monthInTz(r.x.raisedAt), group))?.push(r);
  const periods = [...groups];
  const plabel = (p: string) => periodName(p, group);
  wb.charts.push({ ...oneSeries('breakdowns-per-period', `Breakdowns ${PER[group]}`, 'column', 'Breakdowns', periods.map(([p, g]) => [plabel(p), g.length] as [string, number]), 'int'), print: false });
  wb.charts.push({ ...oneSeries('downtime-per-period', `Downtime ${PER[group]}`, 'column', 'Downtime (h)', periods.map(([p, g]) => [plabel(p), Math.round((g.reduce((s, r) => s + (r.m.downtimeSeconds ?? 0), 0) / 3600) * 10) / 10] as [string, number]), 'hours', 'Resolved breakdowns'), print: false });
  wb.charts.push(oneSeries('top-breakdowns', 'Equipment with the most breakdowns', 'bar', 'Breakdowns', top(tally(rows, (r) => `${r.x.asset.assetCode} ${r.x.asset.name}`), 10), 'int'));
  wb.charts.push(oneSeries('breakdowns-by-department', 'Breakdowns by department', 'bar', 'Breakdowns', tally(rows, (r) => r.x.department.name), 'int'));
  addSheet(wb, group === 'month' ? 'By month' : group === 'year' ? 'By year' : 'By financial year', [
    { header: group === 'month' ? 'Month' : group === 'year' ? 'Year' : 'Financial year', key: 'period' }, { header: 'Breakdowns', key: 'count', fmt: 'int' }, { header: 'Resolved', key: 'resolved', fmt: 'int' },
    { header: 'Average response (h)', key: 'resp', fmt: 'hours', width: 20 }, { header: 'Total downtime (h)', key: 'down', fmt: 'hours', width: 18 }, { header: 'Average downtime (h)', key: 'avgDown', fmt: 'hours', width: 20 },
  ], periods.map(([period, g]) => {
    const down = g.map((r) => r.m.downtimeSeconds).filter((v): v is number => v != null);
    const resp = g.map((r) => r.m.responseSeconds).filter((v): v is number => v != null);
    return { period: periodName(period, group, true), count: g.length, resolved: down.length, resp: avg(resp) == null ? null : avg(resp)! / 3600, down: down.reduce((a, b) => a + b, 0) / 3600, avgDown: avg(down) == null ? null : avg(down)! / 3600 };
  }), ['count', 'resolved', 'down']);
}

// The logbook in a period (facility add-on, F4): what the meters say was used per month (diesel, kWh, water), the
// readings outside their range, and each run-hours machine's PMS by hours.
async function consumption(wb: Collector, c: Ctx) {
  const assetWhere = { ...c.scope } satisfies Prisma.AssetWhereInput;
  const [meters, outOfRange, taken, runAssets] = await Promise.all([
    prisma.readingType.findMany({ where: { kind: 'meter', asset: assetWhere }, include: { asset: { select: { assetCode: true, name: true } } }, orderBy: [{ asset: { assetCode: 'asc' } }, { name: 'asc' }] }),
    prisma.reading.findMany({ where: { outOfRange: true, takenAt: { gte: c.fromAt, lt: c.toAt }, asset: assetWhere, ...effective }, include: { type: true, asset: { select: { assetCode: true, name: true } } }, orderBy: { takenAt: 'asc' } }),
    prisma.reading.count({ where: { takenAt: { gte: c.fromAt, lt: c.toAt }, asset: assetWhere } }),
    prisma.asset.findMany({ where: { ...assetWhere, pmsEveryHours: { not: null } }, select: { id: true, assetCode: true, name: true, pmsEveryHours: true, lastPmsHours: true } }),
  ]);
  const months = periodKeys(c.from, c.to, 'month');
  const used: Record<string, string | number | null>[] = [];
  for (const m of meters) {
    // The last reading before the period too, so the first month's use is counted.
    const readings = await prisma.reading.findMany({ where: { readingTypeId: m.id, takenAt: { lt: c.toAt }, ...effective }, orderBy: { takenAt: 'asc' }, select: { value: true, takenAt: true } });
    const byMonth = new Map<string, number>();
    for (let i = 1; i < readings.length; i++) {
      if (readings[i].takenAt < c.fromAt) continue;
      const month = monthInTz(readings[i].takenAt);
      byMonth.set(month, (byMonth.get(month) ?? 0) + Math.max(0, readings[i].value - readings[i - 1].value));
    }
    for (const month of months) used.push({ item: `${m.asset.assetCode} ${m.asset.name}`, reading: m.name, unit: m.unit, month: periodName(month, 'month', true), used: Math.round((byMonth.get(month) ?? 0) * 100) / 100 });
  }
  kpi(wb, 'Readings taken', taken, 'int', span(c));
  kpi(wb, 'Out of range', outOfRange.length, 'int', outOfRange.length ? 'Listed below' : 'None', outOfRange.length ? 'warn' : 'good');
  kpi(wb, 'Meters', meters.length, 'int', 'Diesel, energy, water, run hours');
  addSheet(wb, 'Used per month', [
    { header: 'Item', key: 'item', width: 30 }, { header: 'Meter', key: 'reading', width: 22 }, { header: 'Unit', key: 'unit' }, { header: 'Month', key: 'month' }, { header: 'Used', key: 'used', fmt: 'hours' },
  ], used);
  addSheet(wb, 'Out of range', [
    { header: 'Taken', key: 'at', fmt: 'datetime', width: 20 }, { header: 'Item', key: 'item', width: 30 }, { header: 'Reading', key: 'reading', width: 22 }, { header: 'Value', key: 'value', fmt: 'hours' },
    { header: 'Unit', key: 'unit' }, { header: 'Normal', key: 'normal', width: 16 }, { header: 'Note', key: 'note', width: 30 },
  ], outOfRange.map((r) => ({ at: r.takenAt, item: `${r.asset.assetCode} ${r.asset.name}`, reading: r.type.name, value: r.value, unit: r.type.unit, normal: `${r.type.min ?? ''} – ${r.type.max ?? ''}`, note: r.note })));
  const hours = await Promise.all(runAssets.map(async (a) => ({ a, info: await runHoursInfo(a) })));
  addSheet(wb, 'PMS by run hours', [
    { header: 'Item', key: 'item', width: 30 }, { header: 'Hours now', key: 'now', fmt: 'hours' }, { header: 'PMS every (h)', key: 'every', fmt: 'int' },
    { header: 'Last PMS at (h)', key: 'last', fmt: 'hours' }, { header: 'Next PMS at (h)', key: 'due', fmt: 'hours' }, { header: 'Hours left', key: 'left', fmt: 'hours' },
  ], hours.map(({ a, info }) => ({ item: `${a.assetCode} ${a.name}`, now: info.hoursNow, every: info.pmsEveryHours, last: info.lastPmsHours, due: info.pmsDueAtHours, left: info.hoursLeft })));
}

// Statutory licences and inspections as at today (facility add-on, F3): the compliance register an inspector asks
// for. Only the latest of each renewal chain is "current"; the earlier ones are the history.
async function compliance(wb: Collector, c: Ctx) {
  const where = { register: c.scope.register, ...(c.scope.departmentId && { OR: [{ assetId: null }, { asset: { departmentId: c.scope.departmentId } }] }) } satisfies Prisma.LicenceWhereInput;
  const rows = await toLicenceRows(await prisma.licence.findMany({ where, include: licenceInclude, orderBy: [{ validTo: 'asc' }, { name: 'asc' }] }));
  const current = rows.filter((r) => r.status !== 'renewed');
  const STATUS = { valid: 'Valid', ending: 'Ending soon', expired: 'EXPIRED', renewed: 'Renewed' } as const;
  const expired = current.filter((r) => r.status === 'expired').length;
  const ending = current.filter((r) => r.status === 'ending').length;
  kpi(wb, 'Licences', current.length, 'int', 'Current, one per renewal chain');
  kpi(wb, 'Expired', expired, 'int', expired ? 'Renew now' : 'None', expired ? 'bad' : 'good');
  kpi(wb, 'Ending soon', ending, 'int', ending ? 'Start the renewal' : 'None', ending ? 'warn' : 'good');
  const cols = [
    { header: 'Licence', key: 'name', width: 30 }, { header: 'Kind', key: 'kind', width: 22 }, { header: 'Covers', key: 'covers', width: 26 }, { header: 'Authority', key: 'authority', width: 24 },
    { header: 'Number', key: 'number', width: 18 }, { header: 'Valid from', key: 'from', fmt: 'date' as const }, { header: 'Valid to', key: 'to', fmt: 'date' as const }, { header: 'Days left', key: 'days', fmt: 'int' as const },
    { header: 'Status', key: 'status' }, { header: 'Team', pdf: false, key: 'team' }, { header: 'Documents', pdf: false, key: 'docs', fmt: 'int' as const },
  ];
  const line = (r: (typeof rows)[number]) => ({
    name: r.name, kind: LICENCE_KIND_LABEL[r.kind], covers: r.assetCode ? `${r.assetCode} ${r.assetName}` : 'Whole site', authority: r.authority, number: r.number,
    from: r.validFrom ? parseDate(r.validFrom) : null, to: parseDate(r.validTo), days: r.daysLeft, status: STATUS[r.status], team: REGISTER_LABEL[r.register], docs: r.attachmentCount,
  });
  addSheet(wb, 'Licences', cols, current.map(line));
  addSheet(wb, 'Expired or ending', cols, current.filter((r) => r.status !== 'valid').map(line));
  addSheet(wb, 'Renewal history', cols, rows.filter((r) => r.status === 'renewed').map(line));
}

// Ward complaints without a machine (facility add-on, F2): by trade and by location, with response and resolution
// times and the ones over their trade's response target. Department scope applies as for every complaint.
async function trades(wb: Collector, c: Ctx) {
  const found = await prisma.complaint.findMany({
    where: { raisedAt: { gte: c.fromAt, lt: c.toAt }, tradeId: { not: null }, ...c.scope },
    include: { trade: true, location: true, department: true, raisedBy: true },
    orderBy: { raisedAt: 'asc' },
  });
  const now = Date.now();
  const rows = found.map((x) => {
    const m = complaintMetrics(x);
    const target = x.trade!.responseHours;
    const waited = m.responseSeconds ?? Math.round((now - x.raisedAt.getTime()) / 1000);
    return { x, trade: x.trade!.name, where: `${x.department.name} · ${x.location!.name}`, m, over: target != null && waited > target * 3600 };
  });
  const hrs = (v: (number | null)[]) => {
    const a = avg(v.filter((n): n is number => n != null));
    return a == null ? null : a / 3600;
  };
  const over = rows.filter((r) => r.over).length;
  const open = rows.filter((r) => !r.x.resolvedAt).length;
  kpi(wb, 'Complaints', rows.length, 'int', span(c));
  kpi(wb, 'Still open', open, 'int', open ? 'Waiting for a fix' : 'All resolved', open ? 'warn' : 'good');
  kpi(wb, 'Average response', hrs(rows.map((r) => r.m.responseSeconds)), 'hours', 'Raised to started');
  kpi(wb, 'Average resolution', hrs(rows.map((r) => r.m.downtimeSeconds)), 'hours', 'Raised to resolved');
  kpi(wb, 'Over response target', over, 'int', over ? 'Started later than the trade’s target' : 'None', over ? 'bad' : 'good');
  const summary = (key: (r: (typeof rows)[number]) => string) => {
    const groups = new Map<string, typeof rows>();
    for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    return [...groups].sort((a, b) => b[1].length - a[1].length).map(([name, g]) => ({
      name, count: g.length, open: g.filter((r) => !r.x.resolvedAt).length, resp: hrs(g.map((r) => r.m.responseSeconds)), res: hrs(g.map((r) => r.m.downtimeSeconds)), over: g.filter((r) => r.over).length,
    }));
  };
  const cols = (first: string) => [
    { header: first, key: 'name', width: 30 }, { header: 'Complaints', key: 'count', fmt: 'int' as const }, { header: 'Still open', key: 'open', fmt: 'int' as const },
    { header: 'Average response (h)', key: 'resp', fmt: 'hours' as const, width: 20 }, { header: 'Average resolution (h)', key: 'res', fmt: 'hours' as const, width: 20 }, { header: 'Over target', key: 'over', fmt: 'int' as const },
  ];
  const byTrade = summary((r) => r.trade);
  wb.charts.push({ ...oneSeries('by-trade', 'Complaints by trade', 'bar', 'Complaints', byTrade.map((t) => [t.name, t.count] as [string, number]), 'int'), print: false });
  addSheet(wb, 'By trade', cols('Trade'), byTrade, ['count', 'open', 'over']);
  addSheet(wb, 'By location', cols('Location'), summary((r) => r.where), ['count', 'open', 'over']);
  addSheet(wb, 'Complaints', [
    { header: 'Complaint no.', key: 'no' }, { header: 'Raised', key: 'raised', fmt: 'datetime', width: 20 }, { header: 'Trade', key: 'trade', width: 20 }, { header: 'Department', key: 'dept', width: 22 },
    { header: 'Location', key: 'loc', width: 18 }, { header: 'Problem', key: 'desc', width: 40 }, { header: 'Raised by', pdf: false, key: 'by', width: 20 }, { header: 'Status', key: 'status' },
    { header: 'Response (h)', key: 'resp', fmt: 'hours' }, { header: 'Resolution (h)', key: 'res', fmt: 'hours' }, { header: 'Target (h)', key: 'target', fmt: 'int' }, { header: 'Over target', key: 'over' },
    { header: 'Resolution notes', pdf: false, key: 'notes', width: 40 },
  ], rows.map(({ x, trade, m, over: late }) => ({
    no: x.complaintNo, raised: x.raisedAt, trade, dept: x.department.name, loc: x.location!.name, desc: x.description, by: x.raisedBy.name, status: COMPLAINT_STATUS_LABEL[x.status],
    resp: hoursOf(m.responseSeconds), res: hoursOf(m.downtimeSeconds), target: x.trade!.responseHours, over: late ? 'YES' : '', notes: x.resolutionNotes,
  })));
}

// Downtime hours of one complaint inside [from, to): from raised until resolved (or until now / the end of the period if still open).
const overlapMs = (raised: Date, resolved: Date | null, from: Date, to: Date) => {
  const start = Math.max(raised.getTime(), from.getTime());
  const end = Math.min((resolved ?? new Date()).getTime(), to.getTime());
  return Math.max(0, end - start);
};

// Uptime of each asset over the period: 24 hours a day from when it was registered, up to now (the future has no uptime
// yet) or the day it was condemned. Overlapping complaints about one machine count once (machineDownMs).
export async function uptimeData(c: Ctx, criticalOnly: boolean) {
  const now = new Date();
  const periodEnd = new Date(Math.min(c.toAt.getTime(), now.getTime())); // the future has no uptime yet
  const assets = await prisma.asset.findMany({
    where: { ...c.scope, ...(criticalOnly ? { criticality: { in: CRITICAL_LEVELS } } : {}), createdAt: { lt: periodEnd } },
    include: assetInclude,
    orderBy: { assetCode: 'asc' },
  });
  const complaints = await prisma.complaint.findMany({
    where: { assetId: { in: assets.map((a) => a.id) }, raisedAt: { lt: periodEnd }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: c.fromAt } }] },
    orderBy: { raisedAt: 'asc' },
  });

  // Condemned or transferred equipment is measured up to the day it left, not counted as running after it.
  const condemnations = await prisma.approvalRequest.findMany({
    where: { type: { in: ['condemn', 'transfer'] }, status: 'approved', targetId: { in: assets.filter((a) => a.status === 'condemned' || a.status === 'transferred').map((a) => a.id) } },
    select: { targetId: true, decidedAt: true },
  });
  const condemnedAt = new Map(condemnations.map((r) => [r.targetId, r.decidedAt]));

  const rows = assets.map((a) => {
    const start = new Date(Math.max(c.fromAt.getTime(), a.createdAt.getTime())); // an asset has no uptime before it was registered
    const end = new Date(Math.min(periodEnd.getTime(), condemnedAt.get(a.id)?.getTime() ?? Infinity));
    const periodMs = Math.max(0, end.getTime() - start.getTime());
    const mine = complaints.filter((x) => x.assetId === a.id);
    const downMs = machineDownMs(mine, start, end);
    return { a, mine, periodMs, downMs };
  }).filter((r) => r.periodMs > 0);
  return { rows, periodEnd };
}

async function uptimeSheets(wb: Collector, c: Ctx, criticalOnly: boolean) {
  const { rows, periodEnd } = await uptimeData(c, criticalOnly);
  addSheet(wb, 'Uptime', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Equipment type', key: 'type', width: 18 }, { header: 'Department', key: 'dept', width: 22 },
    { header: 'Criticality', key: 'crit' }, { header: 'Status', key: 'status' }, { header: 'Hours in period', key: 'period', fmt: 'hours', width: 16 }, { header: 'Breakdowns', key: 'count', fmt: 'int' },
    { header: 'Downtime (h)', key: 'down', fmt: 'hours' }, { header: 'Uptime', key: 'uptime', fmt: 'pct' },
  ], rows.map(({ a, mine, periodMs, downMs }) => ({
    code: a.assetCode, name: a.name, type: a.equipmentType.name, dept: a.department.name, crit: CRITICALITY_LABEL[a.criticality], status: STATUS_LABEL[a.status], period: hours(periodMs),
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
  wb.charts.push({ ...oneSeries('lowest-uptime', 'Lowest uptime', 'bar', 'Uptime', top([...rows].sort((x, y) => x.downMs / x.periodMs - y.downMs / y.periodMs).reverse(), 10).map((r) => [`${r.a.assetCode} ${r.a.name}`, 1 - r.downMs / r.periodMs] as [string, number]), 'pct'), print: false });
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
      { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Complaint no.', key: 'no' }, { header: 'Raised', key: 'raised', fmt: 'datetime', width: 20 },
      { header: 'Resolved', key: 'resolved', fmt: 'datetime', width: 20 }, { header: 'Downtime in period (h)', key: 'down', fmt: 'hours', width: 22 }, { header: 'Whole event (h)', key: 'whole', fmt: 'hours', width: 16 },
      { header: `Over ${criticalDowntimeHours} h limit`, key: 'over', width: 16 }, { header: 'Problem', key: 'desc', width: 40 },
    ], events.map(({ a, x }) => ({ whole: lengthH(x), over: lengthH(x) > criticalDowntimeHours ? 'YES' : '',  code: a.assetCode, name: a.name, no: x.complaintNo, raised: x.raisedAt, resolved: x.resolvedAt ?? 'Still open', down: hours(overlapMs(x.raisedAt, x.resolvedAt, c.fromAt, periodEnd)), desc: x.description })));
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
  wb.charts.push({ ...oneSeries('age-bands', 'Equipment by age band', 'column', 'Assets', bands.map((b) => [b, list.filter((l) => band(l.years) === b).length] as [string, number]), 'int'), print: false });
  wb.charts.push({ ...oneSeries('age-by-type', 'Average age by equipment type', 'bar', 'Years', [...types].map(([t, ys]) => [t, Math.round((ys.reduce((a, y) => a + y, 0) / ys.length) * 10) / 10] as [string, number]).sort((a, b) => b[1] - a[1]), 'years'), print: false });
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
    id: 'spend-per-month', title: 'Spend per month', kind: 'stacked', fmt: 'money', print: false,
    series: [{ key: 'repair', label: 'Repairs' }, { key: 'spare', label: 'Spare parts' }],
    data: monthKeys(c.from, c.to).map((m) => ({ label: monthLabel(m), repair: sum(rows.filter((e) => e.type === 'repair' && isoDate(e.date).slice(0, 7) === m)), spare: sum(rows.filter((e) => e.type === 'spare_part' && isoDate(e.date).slice(0, 7) === m)) })),
  });
  const spendByAsset = new Map<string, number>();
  for (const e of rows) spendByAsset.set(`${e.asset.assetCode} ${e.asset.name}`, (spendByAsset.get(`${e.asset.assetCode} ${e.asset.name}`) ?? 0) + Number(e.amount));
  wb.charts.push({ ...oneSeries('spend-by-asset', 'Equipment with the highest spend', 'bar', 'Spend', top([...spendByAsset].sort((a, b) => b[1] - a[1]), 10), 'money'), print: false });
  const byAsset = new Map<string, { name: string; count: number; repair: number; spare: number }>();
  for (const e of rows) {
    const t = byAsset.get(e.asset.assetCode) ?? { name: e.asset.name, count: 0, repair: 0, spare: 0 };
    byAsset.set(e.asset.assetCode, { ...t, count: t.count + 1, repair: t.repair + (e.type === 'repair' ? Number(e.amount) : 0), spare: t.spare + (e.type === 'spare_part' ? Number(e.amount) : 0) });
  }
  addSheet(wb, 'By asset', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Entries', key: 'count', fmt: 'int' }, { header: 'Repairs', key: 'repair', fmt: 'money', width: 16 },
    { header: 'Spare parts', key: 'spare', fmt: 'money', width: 16 }, { header: 'Total', key: 'total', fmt: 'money', width: 16 },
  ], [...byAsset].map(([code, t]) => ({ code, name: t.name, count: t.count, repair: t.repair, spare: t.spare, total: t.repair + t.spare })).sort((a, b) => b.total - a.total), ['count', 'repair', 'spare', 'total']);

  const byMonth = new Map<string, number>(monthKeys(c.from, c.to).map((m) => [m, 0]));
  for (const e of rows) byMonth.set(isoDate(e.date).slice(0, 7), (byMonth.get(isoDate(e.date).slice(0, 7)) ?? 0) + Number(e.amount));
  addSheet(wb, 'By month', [{ header: 'Month', key: 'month' }, { header: 'Total', key: 'total', fmt: 'money', width: 16 }],
    [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, total]) => ({ month: monthFull(month), total })), ['total']);
}

// The condemnation committee's register: equipment condemned with HOD approval, dated by the committee's meeting
// (requests from before the committee form existed use the approval date). Purchase cost is what its purchase orders
// add up to.
async function condemnationRegister(wb: Collector, c: Ctx) {
  const approved = await prisma.approvalRequest.findMany({ where: { type: 'condemn', status: 'approved' }, orderBy: { decidedAt: 'asc' } });
  type Form = { reason?: string; reasonCategory?: CondemnReason; estimatedValue?: number; committeeDate?: string };
  const dated = approved.map((r) => ({ r, p: r.payload as Form, date: (r.payload as Form).committeeDate ?? isoDate(r.decidedAt!) })).filter((x) => x.date >= c.from && x.date <= c.to);
  const assets = await prisma.asset.findMany({ where: { id: { in: dated.map((x) => x.r.targetId) }, ...c.scope }, include: { equipmentType: true, department: true, purchaseOrders: true } });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(dated.flatMap((x) => [x.r.requestedBy, x.r.decidedBy ?? '']))] } }, select: { id: true, name: true } });
  const name = (id: string | null) => users.find((u) => u.id === id)?.name ?? '';
  const rows = dated.flatMap(({ r, p, date }) => {
    const a = assets.find((x) => x.id === r.targetId);
    if (!a) return [];
    const cost = a.purchaseOrders.reduce((t, o) => t + Number(o.cost), 0);
    const years = a.installationDate ? (parseDate(date).getTime() - a.installationDate.getTime()) / (365.25 * 86400_000) : null;
    return [{
      committee: date, code: a.assetCode, name: a.name, type: a.equipmentType.name, make: [a.make, a.model].filter(Boolean).join(' '), serial: a.serialNo, dept: a.department.name,
      installed: a.installationDate, age: years == null ? null : Math.round(years * 10) / 10, cost: cost || null, value: p.estimatedValue ?? null,
      reason: p.reasonCategory ? CONDEMN_REASON_LABEL[p.reasonCategory] : '', details: p.reason ?? '', by: name(r.requestedBy), approver: r.decidedBy && r.decidedBy === r.requestedBy ? `${name(r.decidedBy)} (own request)` : name(r.decidedBy), approved: r.decidedAt, category: p.reasonCategory ?? 'other',
    }];
  }).sort((x, y) => x.committee.localeCompare(y.committee) || x.code.localeCompare(y.code));
  kpi(wb, 'Equipment condemned', rows.length, 'int', span(c));
  kpi(wb, 'Purchase cost', rows.reduce((t, r) => t + (r.cost ?? 0), 0), 'money', 'From their purchase orders');
  kpi(wb, 'Estimated value today', rows.reduce((t, r) => t + (r.value ?? 0), 0), 'money', 'As given to the committee');
  wb.charts.push(oneSeries('by-reason', 'Equipment condemned by reason', 'bar', 'Equipment', CONDEMN_REASONS.map((k) => [CONDEMN_REASON_LABEL[k], rows.filter((r) => r.category === k).length] as [string, number]), 'int'));
  addSheet(wb, 'Condemnation register', [
    { header: 'Committee date', key: 'committee', fmt: 'date' }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Equipment', key: 'name', width: 26 }, { header: 'Type', pdf: false, key: 'type', width: 18 },
    { header: 'Make / model', key: 'make', width: 22 }, { header: 'Serial no.', key: 'serial', width: 18 }, { header: 'Department', key: 'dept', width: 22 }, { header: 'Installed', pdf: false, key: 'installed', fmt: 'date' },
    { header: 'Age (years)', key: 'age', fmt: 'years' }, { header: 'Purchase cost', key: 'cost', fmt: 'money' }, { header: 'Estimated value today', key: 'value', fmt: 'money', width: 20 },
    { header: 'Reason', key: 'reason', width: 34 }, { header: 'Details', key: 'details', width: 40 }, { header: 'Asked by', pdf: false, key: 'by', width: 20 },
    { header: 'Approved by', key: 'approver', width: 20 }, { header: 'Approved on', pdf: false, key: 'approved', fmt: 'date' },
  ], rows, ['cost', 'value']);
}

// The consumables register (decision F): everything given out in the period (to whom, for which machine or complaint,
// why, and its value where the item has a cost), what was received, and the stock today. A department-scoped reader
// sees only what was given to their department.
async function consumables(wb: Collector, c: Ctx) {
  const include = { item: true, department: true, asset: true, complaint: true, supplier: true, by: { select: { name: true } } } as const;
  const inPeriod = { date: { gte: parseDate(c.from), lte: parseDate(c.to) } };
  const scoped = !!c.scope.departmentId;
  const store = c.scope.register && { register: c.scope.register }; // each team's own store
  const [given, received, items] = await Promise.all([
    prisma.consumableMovement.findMany({ where: { ...inPeriod, kind: 'out', item: { ...store }, ...(scoped && { departmentId: c.scope.departmentId }) }, include, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
    scoped ? [] : prisma.consumableMovement.findMany({ where: { ...inPeriod, kind: 'in', item: { ...store } }, include, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
    scoped ? [] : prisma.consumableItem.findMany({ where: { ...store }, orderBy: { name: 'asc' } }),
  ]);
  const value = (m: { quantity: number; unitCost: Prisma.Decimal | null }) => (m.unitCost == null ? null : Math.abs(m.quantity) * Number(m.unitCost));
  const total = (ms: typeof given) => ms.reduce((t, m) => t + (value(m) ?? 0), 0);
  kpi(wb, 'Times given out', given.length, 'int', span(c));
  kpi(wb, 'Value given out', total(given), 'money', given.some((m) => m.unitCost == null) ? 'Items with no unit cost are not counted' : undefined);
  if (!scoped) {
    kpi(wb, 'Value received', total(received), 'money');
    const low = items.filter((i) => i.active && isLowStock(i));
    kpi(wb, 'Items low on stock', low.length, 'int', low.length ? 'At or below the reorder level' : 'None', low.length ? 'warn' : 'good');
  }
  wb.charts.push({
    id: 'given-per-month', title: 'Value given out per month', kind: 'column', fmt: 'money', series: [{ key: 'v', label: 'Value' }],
    data: monthKeys(c.from, c.to).map((m) => ({ label: monthLabel(m), v: total(given.filter((g) => isoDate(g.date).slice(0, 7) === m)) })),
  });
  wb.charts.push(oneSeries('given-by-dept', 'Times given out by department', 'bar', 'Times', tally(given, (g) => g.department?.name ?? '—'), 'int'));

  addSheet(wb, 'Given out', [
    { header: 'Date', key: 'date', fmt: 'date' }, { header: 'Item', key: 'item', width: 26 }, { header: 'Quantity', key: 'qty', fmt: 'int' }, { header: 'Unit', key: 'unit', width: 8 },
    { header: 'Department', key: 'dept', width: 22 }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Equipment', pdf: false, key: 'asset', width: 24 }, { header: 'Complaint', key: 'complaint' },
    { header: 'Reason', key: 'reason', width: 34 }, { header: 'Unit cost', pdf: false, key: 'cost', fmt: 'money' }, { header: 'Value', key: 'value', fmt: 'money' }, { header: 'Given by', key: 'by', width: 20 },
  ], given.map((m) => ({ date: m.date, item: m.item.name, qty: -m.quantity, unit: m.item.unit, dept: m.department?.name, code: m.asset?.assetCode, asset: m.asset?.name, complaint: m.complaint?.complaintNo, reason: m.reason, cost: m.unitCost == null ? null : Number(m.unitCost), value: value(m), by: m.by.name })), ['qty', 'value']);

  const byItem = new Map<string, { unit: string; qty: number; times: number; value: number }>();
  for (const m of given) {
    const t = byItem.get(m.item.name) ?? { unit: m.item.unit, qty: 0, times: 0, value: 0 };
    byItem.set(m.item.name, { ...t, qty: t.qty - m.quantity, times: t.times + 1, value: t.value + (value(m) ?? 0) });
  }
  addSheet(wb, 'By item', [{ header: 'Item', key: 'item', width: 26 }, { header: 'Unit', key: 'unit', width: 8 }, { header: 'Quantity given', key: 'qty', fmt: 'int', width: 16 }, { header: 'Times', key: 'times', fmt: 'int' }, { header: 'Value', key: 'value', fmt: 'money' }],
    [...byItem].map(([item, t]) => ({ item, ...t })).sort((a, b) => b.value - a.value || b.qty - a.qty), ['times', 'value']);
  if (scoped) return;

  addSheet(wb, 'Received', [
    { header: 'Date', key: 'date', fmt: 'date' }, { header: 'Item', key: 'item', width: 26 }, { header: 'Quantity', key: 'qty', fmt: 'int' }, { header: 'Unit', key: 'unit', width: 8 },
    { header: 'Supplier', key: 'supplier', width: 24 }, { header: 'Invoice / PO', key: 'ref', width: 16 }, { header: 'Unit cost', key: 'cost', fmt: 'money' }, { header: 'Value', key: 'value', fmt: 'money' }, { header: 'Entered by', pdf: false, key: 'by', width: 20 },
  ], received.map((m) => ({ date: m.date, item: m.item.name, qty: m.quantity, unit: m.item.unit, supplier: m.supplier?.name, ref: m.reference, cost: m.unitCost == null ? null : Number(m.unitCost), value: value(m), by: m.by.name })), ['qty', 'value']);
  addSheet(wb, 'Stock today', [
    { header: 'Item', key: 'item', width: 26 }, { header: 'Unit', key: 'unit', width: 8 }, { header: 'In stock', key: 'stock', fmt: 'int' }, { header: 'Reorder at', key: 'reorder', fmt: 'int' },
    { header: 'State', key: 'state' }, { header: 'Unit cost', key: 'cost', fmt: 'money' }, { header: 'Stock value', key: 'value', fmt: 'money' },
  ], items.map((i) => ({
    item: i.name, unit: i.unit, stock: i.stock, reorder: i.reorderLevel || null, state: !i.active ? 'Not in use' : i.stock === 0 ? 'Out of stock' : isLowStock(i) ? 'Low' : 'OK',
    cost: i.unitCost == null ? null : Number(i.unitCost), value: i.unitCost == null ? null : i.stock * Number(i.unitCost),
  })), ['value']);
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
  ], noCover.map((a) => ({ code: a.assetCode, name: a.name, dept: a.department.name, crit: CRITICALITY_LABEL[a.criticality], ended: a.warrantyEnd })).sort((x, y) => (x.crit === 'critical' ? -1 : 0) - (y.crit === 'critical' ? -1 : 0)));
}

// ---------- Entry point ----------

// Reports that are "as at today" rather than for a period.
const SNAPSHOT: ReportType[] = ['asset-master', 'equipment-age', 'warranty-contracts', 'replacement', 'compliance'];

export async function buildReport(type: ReportType, req: Request, q: ReportQuery): Promise<{ data: ReportData; filename: string }> {
  const me = currentUser(req);
  return buildReportAs(type, q, me.name, scopeOf(me, q.register));
}

// The same report for someone named `by`, limited to `scope` (empty: the whole hospital). Used by the audit pack.
export async function buildReportAs(type: ReportType, q: ReportQuery, by: string, scope: Ctx['scope']): Promise<{ data: ReportData; filename: string }> {
  const today = todayISO();
  const to = q.to ?? today;
  const from = q.from ?? isoDate(addMonths(parseDate(to), -12));
  if (from > to) throw new HttpError(400, 'The start date is after the end date. Choose an end date on or after it.', { fieldErrors: { to: ['Before the start date'] } });
  const ctx = periodCtx(from, to, scope, q);

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
    condemnation: () => condemnationRegister(out, ctx),
    consumables: () => consumables(out, ctx),
    engineers: () => engineers(out, ctx),
    suppliers: () => suppliers(out, ctx),
    replacement: () => replacement(out, ctx),
    trades: () => trades(out, ctx),
    compliance: () => compliance(out, ctx),
    consumption: () => consumption(out, ctx),
  };
  await builders[type]();

  const ranged = !SNAPSHOT.includes(type);
  // What the report covers, in words, for the PDF and Excel headings. The list filters apply to the two reports
  // that the asset and complaint lists export.
  const filtered = type === 'asset-master' || type === 'breakdowns';
  const deptId = scope.departmentId ?? (filtered ? q.departmentId : undefined);
  const [dept, eqType] = await Promise.all([
    deptId ? prisma.department.findUnique({ where: { id: deptId }, select: { name: true } }) : null,
    filtered && q.equipmentTypeId ? prisma.equipmentType.findUnique({ where: { id: q.equipmentTypeId }, select: { name: true } }) : null,
  ]);
  // One team's equipment, in a hospital that has both.
  const team = scope.register?.in.length === 1 && (await facilityOn()) ? scope.register.in[0] : null;
  const filters = [
    ...(team ? [`Equipment: ${REGISTER_LABEL[team]}`] : []),
    ...(dept ? [`Department: ${dept.name}`] : []),
    ...(eqType ? [`Equipment type: ${eqType.name}`] : []),
    ...(filtered && q.criticality ? [`Criticality: ${CRITICALITY_LABEL[q.criticality]}`] : []),
    ...(type === 'asset-master' && q.assetStatus && q.assetStatus !== 'all' ? [`Status: ${ASSET_STATUS_LABEL[q.assetStatus]}`] : []),
    ...(type === 'breakdowns' && q.complaintStatus ? [`Status: ${COMPLAINT_STATUS_LABEL[q.complaintStatus]}`] : []),
    ...(filtered && q.search ? [`Search: "${q.search}"`] : []),
  ];
  const meta = REPORTS.find((r) => r.type === type)!;
  const data: ReportData = {
    type,
    title: meta.title,
    hospital: settings.name,
    from: ranged ? from : null,
    to: ranged ? to : null,
    group: type === 'breakdowns' ? q.group : null,
    generatedAt: new Date().toISOString(),
    generatedBy: by,
    filters,
    note:
      type === 'condemnation'
        ? 'Condemnation committee members (name, designation, signature, date): ________________________________'
        : type === 'consumables'
          ? 'Stock today is as at the day this report was made, not the end of the period. Value = quantity × the unit cost at the time.'
          : type === 'engineers'
            ? 'Response = work started − complaint raised; repair = resolved − work started. "Sent back" counts fixes the ward reported as still not working. PMS counts each PMS once (corrections are not another PMS).'
            : type === 'suppliers'
              ? 'A company looks after equipment it services, or that it sold when no service company is set. Downtime adds up each breakdown, so overlapping faults on one machine count twice here (the uptime report counts them once).'
              : type === 'consumption'
                ? 'Used = the rise of a meter between two readings, counted in the month of the later one. Corrected readings count as corrected. Run hours are as at the day this report was made.'
              : type === 'compliance'
                ? 'As at the day this report was made. A renewed licence is listed once, as its latest renewal; earlier ones are in the renewal history.'
              : type === 'trades'
                ? 'Ward complaints without a machine. Response = work started − raised; resolution = resolved − raised. Over target: work started (or has still not started) later than the trade’s response target.'
              : type === 'replacement'
                ? `Consider replacing: ${REPLACE_AGE_YEARS}+ years old, ${REPLACE_BREAKDOWNS_12M}+ breakdowns in 12 months, or repairs costing over ${REPLACE_SPEND_SHARE * 100}% of the purchase price in 12 months. Active equipment only.`
          : 'Condemned, transferred and not-in-use assets are included and labelled in the Status column.',
    ...out,
  };
  return { data, filename: `bme-${type}-${ranged ? `${from}_to_${to}` : today}` };
}

// ---------- Replacement and renewals (also in the monthly report) ----------

// Equipment due for a replacement decision: any one of these is enough, and every reason is listed.
export const REPLACE_AGE_YEARS = 10;
export const REPLACE_BREAKDOWNS_12M = 4;
export const REPLACE_SPEND_SHARE = 0.5; // repairs and spares in 12 months, against what the equipment cost

// Active equipment to consider replacing, over the 12 months up to `to` (inclusive).
export async function replacementCandidates(active: AssetWithRefs[], to: string) {
  const toAt = zonedDayStart(addDaysISO(to, 1));
  const yearAgo = zonedDayStart(isoDate(addMonths(parseDate(addDaysISO(to, 1)), -12)));
  const ids = active.map((a) => a.id);
  const [breaks12, spend12, orders] = await Promise.all([
    prisma.complaint.groupBy({ by: ['assetId'], where: { assetId: { in: ids }, raisedAt: { gte: yearAgo, lt: toAt } }, _count: true }),
    prisma.serviceExpense.groupBy({ by: ['assetId'], where: { assetId: { in: ids }, date: { gte: yearAgo, lte: parseDate(to) } }, _sum: { amount: true } }),
    prisma.purchaseOrder.groupBy({ by: ['assetId'], where: { assetId: { in: ids } }, _sum: { cost: true } }),
  ]);
  return active.flatMap((a) => {
    const ageMonths = toAssetRow(a).ageMonths;
    const years = ageMonths == null ? null : ageMonths / 12;
    const breaks = breaks12.find((b) => b.assetId === a.id)?._count ?? 0;
    const spent = Number(spend12.find((s) => s.assetId === a.id)?._sum.amount ?? 0);
    const cost = Number(orders.find((o) => o.assetId === a.id)?._sum.cost ?? 0);
    const reasons = [
      years != null && years >= REPLACE_AGE_YEARS && `${Math.floor(years)} years old`,
      breaks >= REPLACE_BREAKDOWNS_12M && `${breaks} breakdowns in 12 months`,
      cost > 0 && spent >= cost * REPLACE_SPEND_SHARE && `repairs ${Math.round((spent / cost) * 100)}% of its cost in 12 months`,
    ].filter((r): r is string => !!r);
    return reasons.length ? [{ a, years, breaks, spent, cost, reasons }] : [];
  });
}
export function replacementSheet(out: Collector, name: string, candidates: Awaited<ReturnType<typeof replacementCandidates>>) {
  addSheet(out, name, [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 22 }, { header: 'Age (years)', key: 'years', fmt: 'years' },
    { header: 'Breakdowns, 12 months', key: 'breaks', fmt: 'int', width: 20 }, { header: 'Repair spend, 12 months', key: 'spent', fmt: 'money', width: 22 },
    { header: 'Purchase cost', key: 'cost', fmt: 'money', width: 16 }, { header: 'Why', key: 'why', width: 40 },
  ], candidates.map((r) => ({ code: r.a.assetCode, name: r.a.name, dept: r.a.department.name, years: r.years == null ? null : Math.round(r.years * 10) / 10, breaks: r.breaks, spent: r.spent, cost: r.cost || null, why: r.reasons.join('; ') })));
}

// Warranties and contracts of active equipment ending from `asAt` to `days` later, soonest first.
export async function coverEnding(active: AssetWithRefs[], scope: Ctx['scope'], asAt: string, days: number) {
  const horizon = addDaysISO(asAt, days);
  const contracts = await prisma.serviceContract.findMany({ where: { endDate: { gte: parseDate(asAt), lte: parseDate(horizon) }, asset: { status: 'active', ...scope } }, include: { asset: { include: { department: true } } } });
  return [
    ...active.filter((a) => a.warrantyEnd && isoDate(a.warrantyEnd) >= asAt && isoDate(a.warrantyEnd) <= horizon).map((a) => ({ what: 'Warranty', a, dept: a.department.name, ends: a.warrantyEnd!, vendor: '' })),
    ...contracts.map((k) => ({ what: `${k.type.toUpperCase().replace('_', '-')} contract`, a: k.asset, dept: k.asset.department.name, ends: k.endDate, vendor: k.vendor })),
  ].sort((x, y) => x.ends.getTime() - y.ends.getTime());
}
export function coverSheet(out: Collector, name: string, cover: Awaited<ReturnType<typeof coverEnding>>) {
  addSheet(out, name, [
    { header: 'Cover', key: 'what' }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 22 },
    { header: 'Vendor', key: 'vendor', width: 20 }, { header: 'Ends', key: 'ends', fmt: 'date' },
  ], cover.map((r) => ({ what: r.what, code: r.a.assetCode, name: r.a.name, dept: r.dept, vendor: r.vendor, ends: r.ends })));
}

// As things stand today: what to plan for replacing, and what cover runs out in the next 90 days.
async function replacement(wb: Collector, c: Ctx) {
  const today = todayISO();
  const active = await prisma.asset.findMany({ where: { status: 'active', ...c.scope }, include: assetInclude, orderBy: { assetCode: 'asc' } });
  const candidates = await replacementCandidates(active, today);
  const cover = await coverEnding(active, c.scope, today, 90);
  kpi(wb, 'To consider replacing', candidates.length, 'int', `Of ${active.length} active`, candidates.length ? 'warn' : 'good');
  kpi(wb, `${REPLACE_AGE_YEARS}+ years old`, candidates.filter((r) => r.years != null && r.years >= REPLACE_AGE_YEARS).length, 'int');
  kpi(wb, `${REPLACE_BREAKDOWNS_12M}+ breakdowns in 12 months`, candidates.filter((r) => r.breaks >= REPLACE_BREAKDOWNS_12M).length, 'int');
  kpi(wb, 'Cover ending in 90 days', cover.length, 'int', cover.length ? 'Renew or plan' : 'None', cover.length ? 'warn' : 'good');
  if (candidates.length) wb.charts.push(oneSeries('replace-by-department', 'To consider replacing, by department', 'bar', 'Assets', tally(candidates, (r) => r.a.department.name), 'int'));
  replacementSheet(wb, 'Equipment to consider replacing', candidates);
  coverSheet(wb, 'Cover ending in 90 days', cover); // sheet names: 31 characters at most
}

// Per engineer in the period: complaints started and resolved, how fast, fixes sent back as still not working, PMS
// done and calibrations recorded. Whoever did the work counts, including people who have since left.
async function engineers(wb: Collector, c: Ctx) {
  const inPeriod = { gte: c.fromAt, lt: c.toAt };
  const assetScope = { asset: { ...c.scope } };
  const [started, resolved, sentBack, pmsRows, calibrations] = await Promise.all([
    prisma.complaint.findMany({ where: { startedAt: inPeriod, startedBy: { not: null }, ...c.scope }, select: { startedBy: true, raisedAt: true, startedAt: true } }),
    prisma.complaint.findMany({ where: { resolvedAt: inPeriod, resolvedBy: { not: null }, ...c.scope }, select: { resolvedBy: true, startedAt: true, resolvedAt: true } }),
    // A reopened complaint keeps the undone resolution as a `resolved` step, by whoever resolved it.
    prisma.complaintStep.findMany({ where: { kind: 'resolved', at: inPeriod, by: { not: null }, complaint: { ...c.scope } }, select: { by: true } }),
    prisma.pmsRecord.findMany({ where: { performedOn: { gte: parseDate(c.from), lte: parseDate(c.to) }, correctsRecordId: null, ...assetScope }, select: { performedBy: true } }),
    prisma.calibrationRecord.findMany({ where: { doneOn: { gte: parseDate(c.from), lte: parseDate(c.to) }, createdBy: { not: null }, ...assetScope }, select: { createdBy: true } }),
  ]);
  const open = await prisma.complaint.groupBy({ by: ['assignedToId'], where: { status: { in: ['open', 'in_progress', 'on_hold'] }, assignedToId: { not: null }, ...c.scope }, _count: true });
  const ids = [...new Set([...started.map((x) => x.startedBy!), ...resolved.map((x) => x.resolvedBy!), ...sentBack.map((x) => x.by!), ...pmsRows.map((x) => x.performedBy), ...calibrations.map((x) => x.createdBy!), ...open.map((o) => o.assignedToId!)])];
  const people = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, active: true }, orderBy: { name: 'asc' } });
  const h = (ms: number[]) => (ms.length ? Math.round((ms.reduce((s, v) => s + v, 0) / ms.length / 3_600_000) * 10) / 10 : null);
  const rows = people.map((p) => {
    const mine = started.filter((x) => x.startedBy === p.id);
    const fixed = resolved.filter((x) => x.resolvedBy === p.id);
    return {
      name: p.active ? p.name : `${p.name} (left)`,
      started: mine.length,
      response: h(mine.map((x) => x.startedAt!.getTime() - x.raisedAt.getTime())),
      resolved: fixed.length,
      repair: h(fixed.filter((x) => x.startedAt).map((x) => x.resolvedAt!.getTime() - x.startedAt!.getTime())),
      sentBack: sentBack.filter((x) => x.by === p.id).length,
      open: open.find((o) => o.assignedToId === p.id)?._count ?? 0,
      pms: pmsRows.filter((x) => x.performedBy === p.id).length,
      cal: calibrations.filter((x) => x.createdBy === p.id).length,
    };
  });
  kpi(wb, 'Complaints resolved', resolved.length, 'int', span(c));
  kpi(wb, 'Average response', h(started.map((x) => x.startedAt!.getTime() - x.raisedAt.getTime())), 'hours', 'Raised to work started');
  kpi(wb, 'Average repair', h(resolved.filter((x) => x.startedAt).map((x) => x.resolvedAt!.getTime() - x.startedAt!.getTime())), 'hours', 'Work started to resolved');
  kpi(wb, 'Fixes sent back', sentBack.length, 'int', 'Reported still not working', sentBack.length ? 'warn' : 'good');
  if (rows.some((r) => r.resolved)) wb.charts.push(oneSeries('resolved-by-engineer', 'Complaints resolved, by engineer', 'bar', 'Complaints', rows.filter((r) => r.resolved).map((r) => [r.name, r.resolved] as [string, number]).sort((a, b) => b[1] - a[1]), 'int'));
  addSheet(wb, 'Engineers', [
    { header: 'Engineer', key: 'name', width: 24 }, { header: 'Started', key: 'started', fmt: 'int' }, { header: 'Average response (h)', key: 'response', fmt: 'hours', width: 20 },
    { header: 'Resolved', key: 'resolved', fmt: 'int' }, { header: 'Average repair (h)', key: 'repair', fmt: 'hours', width: 18 }, { header: 'Sent back', key: 'sentBack', fmt: 'int' },
    { header: 'Unresolved now', key: 'open', fmt: 'int', width: 16 }, { header: 'PMS done', key: 'pms', fmt: 'int' }, { header: 'Calibrations recorded', key: 'cal', fmt: 'int', width: 20 },
  ], rows, ['started', 'resolved', 'sentBack', 'open', 'pms', 'cal']);
}

// Per company in the suppliers list: what it sold and looks after, how that equipment broke down in the period, what
// was spent on it and the company's contracts running today.
async function suppliers(wb: Collector, c: Ctx) {
  const today = parseDate(todayISO());
  const [vendors, assets, contracts] = await Promise.all([
    prisma.vendor.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.asset.findMany({ where: { ...c.scope, OR: [{ supplierId: { not: null } }, { serviceVendorId: { not: null } }] }, select: { id: true, status: true, supplierId: true, serviceVendorId: true } }),
    prisma.serviceContract.findMany({ where: { endDate: { gte: today }, startDate: { lte: today }, asset: { ...c.scope } }, select: { vendor: true } }),
  ]);
  const caredFor = (vid: string) => assets.filter((a) => (a.serviceVendorId ?? a.supplierId) === vid).map((a) => a.id);
  const allCared = [...new Set(assets.map((a) => a.id))];
  const [complaints, spend, orders] = await Promise.all([
    prisma.complaint.findMany({ where: { assetId: { in: allCared }, raisedAt: { gte: c.fromAt, lt: c.toAt } }, select: { assetId: true, raisedAt: true, startedAt: true, resolvedAt: true } }),
    prisma.serviceExpense.groupBy({ by: ['assetId'], where: { assetId: { in: allCared }, date: { gte: parseDate(c.from), lte: parseDate(c.to) } }, _sum: { amount: true } }),
    prisma.purchaseOrder.groupBy({ by: ['assetId'], where: { assetId: { in: allCared } }, _sum: { cost: true } }),
  ]);
  const rows = vendors.flatMap((v) => {
    const supplied = assets.filter((a) => a.supplierId === v.id);
    const looked = new Set(caredFor(v.id));
    const theirs = complaints.filter((x) => looked.has(x.assetId!));
    const running = contracts.filter((k) => k.vendor.trim().toLowerCase() === v.name.trim().toLowerCase()).length;
    if (!supplied.length && !looked.size && !running) return [];
    const down = theirs.reduce((s, x) => s + (complaintMetrics(x).downtimeSeconds ?? 0), 0);
    return [{
      name: v.name,
      supplied: supplied.length,
      suppliedActive: supplied.filter((a) => a.status === 'active').length,
      bought: supplied.reduce((s, a) => s + Number(orders.find((o) => o.assetId === a.id)?._sum.cost ?? 0), 0) || null,
      looked: looked.size,
      breakdowns: theirs.length,
      downtime: Math.round((down / 3600) * 10) / 10,
      spent: [...looked].reduce((s, id) => s + Number(spend.find((x) => x.assetId === id)?._sum.amount ?? 0), 0),
      contracts: running,
    }];
  });
  kpi(wb, 'Companies', rows.length, 'int', 'With equipment or contracts');
  kpi(wb, 'Breakdowns', rows.reduce((s, r) => s + r.breakdowns, 0), 'int', 'On equipment they look after');
  kpi(wb, 'Service spend', rows.reduce((s, r) => s + r.spent, 0), 'money', span(c));
  if (rows.some((r) => r.breakdowns)) wb.charts.push(oneSeries('breakdowns-by-supplier', 'Breakdowns of the equipment each company looks after', 'bar', 'Breakdowns', top(rows.filter((r) => r.breakdowns).map((r) => [r.name, r.breakdowns] as [string, number]).sort((a, b) => b[1] - a[1]), 10), 'int'));
  addSheet(wb, 'Suppliers', [
    { header: 'Company', key: 'name', width: 26 }, { header: 'Equipment sold', key: 'supplied', fmt: 'int', width: 16 }, { header: 'Still in use', key: 'suppliedActive', fmt: 'int' },
    { header: 'Bought for', key: 'bought', fmt: 'money', width: 16 }, { header: 'Looks after', key: 'looked', fmt: 'int' }, { header: 'Breakdowns', key: 'breakdowns', fmt: 'int' },
    { header: 'Downtime (h)', key: 'downtime', fmt: 'hours' }, { header: 'Service spend', key: 'spent', fmt: 'money', width: 16 }, { header: 'Contracts running', key: 'contracts', fmt: 'int', width: 18 },
  ], rows, ['supplied', 'suppliedActive', 'bought', 'looked', 'breakdowns', 'downtime', 'spent', 'contracts']);
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
  const asset = await prisma.asset.findFirstOrThrow({ where: { id: assetId, ...scopeOf(me) }, include: assetInclude });
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
    .filter((f) => canSeeCosts || !['service_expense', 'purchase_order', 'service_contract'].includes(f.ownerType));
  const users = await prisma.user.findMany({ where: { id: { in: pmsRecords.map((p) => p.performedBy) } }, select: { id: true, name: true } });
  const r = toAssetRow(asset);
  const downtimeS = complaints.reduce((s, c) => s + (complaintMetrics(c).downtimeSeconds ?? 0), 0);

  const wb: Collector = { sheets: [], kpis: [], charts: [] };
  kpi(wb, 'PMS done', pmsRecords.filter((p) => !p.correctsRecordId).length, 'int', 'In this system');
  kpi(wb, 'Calibrations', calibrations.length, 'int');
  kpi(wb, 'Breakdowns', complaints.length, 'int');
  kpi(wb, 'Total downtime', hoursOf(downtimeS), 'hours');
  kpi(wb, 'Service entries', logs.length, 'int');
  if (canSeeCosts) kpi(wb, 'Total expenses', expenses.reduce((t, e) => t + Number(e.amount), 0), 'money');
  kpi(wb, 'Documents', files.length, 'int');

  addSheet(wb, 'Summary', [{ header: 'Item', key: 'k', width: 30 }, { header: 'Value', key: 'v', width: 50 }], [
    { k: 'Asset ID', v: asset.assetCode }, { k: 'Name', v: asset.name }, { k: 'Equipment type', v: asset.equipmentType.name },
    { k: 'Make / model', v: [asset.make, asset.model].filter(Boolean).join(' ') }, { k: 'Serial no', v: asset.serialNo },
    { k: 'Department / location', v: `${asset.department.name} / ${asset.location.name}` }, { k: 'Criticality', v: CRITICALITY_LABEL[asset.criticality] },
    { k: 'Status', v: STATUS_LABEL[asset.status] }, { k: 'Installed', v: asset.installationDate ? isoDate(asset.installationDate) : '' },
    { k: 'Age (years)', v: r.ageMonths == null ? '' : Math.round((r.ageMonths / 12) * 10) / 10 }, { k: 'Warranty ends', v: asset.warrantyEnd ? isoDate(asset.warrantyEnd) : '' },
    { k: 'PMS every (months)', v: asset.pmsFrequencyMonths }, { k: 'Last PMS before this system', v: asset.openingPmsOn ? isoDate(asset.openingPmsOn) : '' },
    { k: 'Last calibration before this system', v: asset.openingCalibrationOn ? isoDate(asset.openingCalibrationOn) : '' },
    { k: 'Next PMS due', v: asset.nextPmsDue ? isoDate(asset.nextPmsDue) : '' }, { k: 'Next calibration due', v: asset.nextCalibrationDue ? isoDate(asset.nextCalibrationDue) : '' },
    { k: 'PMS done (this system)', v: pmsRecords.filter((p) => !p.correctsRecordId).length }, { k: 'Calibrations recorded', v: calibrations.length }, { k: 'Breakdowns', v: complaints.length },
    { k: 'Total downtime (hours)', v: hoursOf(downtimeS) }, { k: 'Service entries', v: logs.length },
    ...(canSeeCosts ? [{ k: 'Total expenses (₹)', v: expenses.reduce((s, e) => s + Number(e.amount), 0) }] : []),
    { k: 'Documents on file', v: files.length },
  ]);
  const costColumn = canSeeCosts ? [{ header: 'Cost', key: 'cost', fmt: 'money' as const, width: 16 }] : [];
  addSheet(wb, 'Purchase orders', [{ header: 'PO number', key: 'no', width: 20 }, { header: 'PO date', key: 'date', fmt: 'date' }, { header: 'Vendor', key: 'vendor', width: 26 }, ...costColumn],
    orders.map((o) => ({ no: o.poNumber, date: o.poDate, vendor: o.vendor, cost: Number(o.cost) })));
  addSheet(wb, 'Contracts', [{ header: 'Type', key: 'type' }, { header: 'Vendor', key: 'vendor', width: 26 }, { header: 'Start', key: 'start', fmt: 'date' }, { header: 'End', key: 'end', fmt: 'date' }, ...costColumn],
    contracts.map((c) => ({ type: c.type.toUpperCase().replace('_', '-'), vendor: c.vendor, start: c.startDate, end: c.endDate, cost: c.cost == null ? null : Number(c.cost) })));
  addSheet(wb, 'PMS', [{ header: 'Date', key: 'date', fmt: 'date' }, { header: 'Done by', key: 'by', width: 22 }, { header: 'Result', key: 'result' }, { header: 'Correction of an earlier record', key: 'corr', width: 30 }, { header: 'Correction reason', key: 'why', width: 36 }],
    pmsRecords.map((p) => ({ date: p.performedOn, by: users.find((u) => u.id === p.performedBy)?.name ?? '', result: p.result.toUpperCase(), corr: p.correctsRecordId ? 'Yes' : '', why: p.correctionReason })));
  addSheet(wb, 'Calibration', [{ header: 'Done on', key: 'done', fmt: 'date' }, { header: 'Next due', key: 'due', fmt: 'date' }, { header: 'Agency', key: 'agency', width: 24 }, { header: 'Result', key: 'result' }],
    calibrations.map((c) => ({ done: c.doneOn, due: c.dueOn, agency: c.agency, result: c.result.toUpperCase() })));
  addSheet(wb, 'Complaints', [
    { header: 'Complaint no.', key: 'no', width: 14 }, { header: 'Raised', key: 'raised', fmt: 'datetime', width: 20 }, { header: 'Raised by', key: 'by', width: 20 }, { header: 'Problem', key: 'desc', width: 40 },
    { header: 'Status', key: 'status' }, { header: 'Started', key: 'started', fmt: 'datetime', width: 20 }, { header: 'Resolved', key: 'resolved', fmt: 'datetime', width: 20 }, { header: 'Response (h)', key: 'resp', fmt: 'hours' },
    { header: 'Downtime (h)', key: 'down', fmt: 'hours' }, { header: 'What was done', key: 'notes', width: 40 },
  ], complaints.map((c) => {
    const m = complaintMetrics(c);
    return { no: c.complaintNo, raised: c.raisedAt, by: c.raisedBy.name, desc: c.description, status: COMPLAINT_STATUS_LABEL[c.status], started: c.startedAt, resolved: c.resolvedAt, resp: hoursOf(m.responseSeconds), down: hoursOf(m.downtimeSeconds), notes: c.resolutionNotes };
  }));
  addSheet(wb, 'Service log', [{ header: 'Date', key: 'date', fmt: 'date' }, { header: 'Kind', key: 'kind' }, { header: 'Vendor', key: 'vendor', width: 24 }, { header: 'What was done', key: 'desc', width: 50 }],
    logs.map((l) => ({ date: l.serviceDate, kind: SERVICE_KIND[l.kind], vendor: l.vendor, desc: l.description })));
  if (canSeeCosts) {
    addSheet(wb, 'Expenses', [{ header: 'Date', key: 'date', fmt: 'date' }, { header: 'Type', key: 'type' }, { header: 'Description', key: 'desc', width: 40 }, { header: 'Vendor', key: 'vendor', width: 22 }, { header: 'Complaint', key: 'complaint' }, { header: 'Amount', key: 'amount', fmt: 'money', width: 16 }],
      expenses.map((e) => ({ date: e.date, type: e.type === 'spare_part' ? 'Spare part' : 'Repair', desc: e.description, vendor: e.vendor, complaint: e.complaint?.complaintNo, amount: Number(e.amount) })), ['amount']);
  }
  addSheet(wb, 'Documents', [{ header: 'File', key: 'name', width: 40 }, { header: 'Kind', key: 'kind', width: 20 }, { header: 'Attached to', key: 'owner', width: 20 }, { header: 'Added', key: 'added', fmt: 'datetime', width: 20 }],
    files.map((f) => ({ name: f.fileName, kind: DOC_KIND[f.kind] ?? f.kind, owner: f.ownerType.replace(/_/g, ' '), added: f.createdAt })));
  const data: ReportData = {
    type: 'asset-history',
    title: `Full history of ${asset.assetCode}`,
    hospital: settings.name,
    from: null,
    to: null,
    group: null,
    generatedAt: new Date().toISOString(),
    generatedBy: me.name,
    filters: [`Equipment: ${asset.name}`, `Department: ${asset.department.name}`],
    note: asset.status === 'condemned' ? 'This equipment has been CONDEMNED. Its history is kept.' : asset.status === 'transferred' ? 'This equipment has been TRANSFERRED to another unit. Its history up to then is kept.' : null,
    ...wb,
  };
  return { data, filename: `bme-history-${asset.assetCode}-${todayISO()}`, assetCode: asset.assetCode };
}
