import type { Prisma } from '@prisma/client';
import { CRITICALITY_LABEL, isCritical, type Kpi, type ReportData } from '@bme/shared';
import { addDaysISO, addMonths, daysBetween, isoDate, monthInTz, parseDate, todayISO, zonedDayStart } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { sendMail, smtpConfigured } from '../../lib/mail';
import { usersWithPermissions } from '../../lib/people';
import { prisma } from '../../lib/prisma';
import { assetInclude, toAssetRow } from '../assets/assets.service';
import { complaintMetrics } from '../complaints/complaints.service';
import { toPdf } from './reports.export';
import {
  STATUS_LABEL,
  addSheet,
  avg,
  hours,
  kpi,
  monthFull,
  monthKeys,
  monthLabel,
  oneSeries,
  periodCtx,
  pmsDone,
  tally,
  top,
  uptimeData,
  type Collector,
  type Ctx,
} from './reports.service';

// The monthly management report: one page the Biomedical HOD can forward to hospital management. It is made from
// the same records and the same rules as the other reports (uptime 24 hours a day, overlapping complaints counted
// once, a PMS correction is not another PMS), so its numbers agree with them.
//
// Who it is for: the whole hospital (`scope` {}), or one department for someone scoped to it.
export type Viewer = { name: string; scope: Ctx['scope'] };

// Equipment due for a replacement decision: any one of these is enough, and every reason is listed.
export const REPLACE_AGE_YEARS = 10;
export const REPLACE_BREAKDOWNS_12M = 4;
export const REPLACE_SPEND_SHARE = 0.5; // repairs and spares in 12 months, against what the equipment cost

export const monthStart = (month: string) => `${month}-01`;
export const monthEnd = (month: string) => addDaysISO(isoDate(addMonths(parseDate(monthStart(month)), 1)), -1);
export const previousMonth = (month: string) => isoDate(addMonths(parseDate(monthStart(month)), -1)).slice(0, 7);
export const monthName = (month: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseDate(monthStart(month)));
// The Indian financial year the month falls in starts on 1 April.
const fyStart = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${m >= 4 ? y : y - 1}-04-01`;
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// Breakdowns raised in a period, with their response time and downtime.
async function breakdownsIn(c: Ctx) {
  const rows = await prisma.complaint.findMany({
    where: { raisedAt: { gte: c.fromAt, lt: c.toAt }, ...c.scope },
    include: { asset: { include: { department: true } } },
    orderBy: { raisedAt: 'asc' },
  });
  return rows.map((x) => ({ x, m: complaintMetrics(x) }));
}
const avgHours = (secs: (number | null)[]) => {
  const v = avg(secs.filter((s): s is number => s != null));
  return v == null ? null : v / 3600;
};
const uptimeOf = (rows: { periodMs: number; downMs: number }[]) => {
  const total = rows.reduce((s, r) => s + r.periodMs, 0);
  return total ? 1 - rows.reduce((s, r) => s + r.downMs, 0) / total : null;
};
// "Last month 98.9%": the same figure a month earlier, so the trend reads at a glance.
const versus = (before: number | null, fmt: (v: number) => string) => (before == null ? 'No figure for last month' : `Last month ${fmt(before)}`);

export async function buildMonthlyReport(month: string, viewer: Viewer, now = new Date()): Promise<ReportData> {
  const from = monthStart(month);
  const to = monthEnd(month);
  const today = todayISO();
  if (from > today) throw new HttpError(400, 'That month has not started yet. Choose this month or an earlier one.', { fieldErrors: { month: ['In the future'] } });
  const c = periodCtx(from, to, viewer.scope);
  const p = periodCtx(monthStart(previousMonth(month)), monthEnd(previousMonth(month)), viewer.scope);
  const asAt = today; // compliance and "what is overdue" are always as things stand when the report is made
  const out: Collector = { sheets: [], kpis: [], charts: [] };

  const [settings, uptime, uptimePrev, critical, criticalPrev, raised, raisedPrev, pmsRecords] = await Promise.all([
    prisma.hospitalSettings.findFirstOrThrow({ select: { name: true, criticalDowntimeHours: true } }),
    uptimeData(c, false),
    uptimeData(p, false),
    uptimeData(c, true),
    uptimeData(p, true),
    breakdownsIn(c),
    breakdownsIn(p),
    prisma.pmsRecord.findMany({ where: { performedOn: { gte: parseDate(from), lte: parseDate(to) }, asset: { ...c.scope } }, select: { id: true, correctsRecordId: true, result: true } }),
  ]);

  // ---- Breakdowns and uptime ----
  const fleet = uptimeOf(uptime.rows);
  const fleetPrev = uptimeOf(uptimePrev.rows);
  const crit = uptimeOf(critical.rows);
  const critPrev = uptimeOf(criticalPrev.rows);
  const tone = (u: number | null): Kpi['tone'] => (u == null ? undefined : u < 0.98 ? 'warn' : 'good');
  kpi(out, 'Equipment uptime', fleet, 'pct', versus(fleetPrev, pct), tone(fleet));
  kpi(out, 'Critical equipment uptime', crit, 'pct', versus(critPrev, pct), tone(crit));
  kpi(out, 'Breakdowns', raised.length, 'int', `Last month ${raisedPrev.length}`, raised.length > raisedPrev.length ? 'warn' : 'good');
  const resp = avgHours(raised.map((r) => r.m.responseSeconds));
  const respPrev = avgHours(raisedPrev.map((r) => r.m.responseSeconds));
  kpi(out, 'Average response', resp, 'hours', respPrev == null ? 'Raised to started' : `Last month ${respPrev.toFixed(1)} h`);
  const down = avgHours(raised.map((r) => r.m.downtimeSeconds));
  kpi(out, 'Average downtime', down, 'hours', 'Raised to resolved');
  const limit = settings.criticalDowntimeHours;
  const lengthH = (x: { raisedAt: Date; resolvedAt: Date | null }) => hours((x.resolvedAt ?? now).getTime() - x.raisedAt.getTime());
  const overLimit = raised.filter(({ x }) => isCritical(x.asset.criticality) && lengthH(x) > limit);
  kpi(out, `Critical down over ${limit} h`, overLimit.length, 'int', overLimit.length ? 'Longer than the hospital limit' : 'None', overLimit.length ? 'bad' : 'good');

  // ---- PMS and calibration ----
  const done = await pmsDone(pmsRecords);
  const failed = done.filter((r) => r.result !== 'pass').length;
  kpi(out, 'PMS done', done.length, 'int', failed ? `${failed} failed` : 'All passed', failed ? 'warn' : 'good');
  const active = await prisma.asset.findMany({ where: { status: 'active', ...c.scope }, include: assetInclude, orderBy: { assetCode: 'asc' } });
  const scheduled = (key: 'nextPmsDue' | 'nextCalibrationDue') => active.filter((a) => a[key]);
  const overdue = (key: 'nextPmsDue' | 'nextCalibrationDue') => scheduled(key).filter((a) => isoDate(a[key]!) < asAt);
  const compliance = (key: 'nextPmsDue' | 'nextCalibrationDue') => (scheduled(key).length ? 1 - overdue(key).length / scheduled(key).length : null);
  const pmsOk = compliance('nextPmsDue');
  const calOk = compliance('nextCalibrationDue');
  kpi(out, 'PMS on schedule', pmsOk, 'pct', `${overdue('nextPmsDue').length} overdue · as at ${stampDay(asAt)}`, pmsOk != null && pmsOk < 1 ? 'warn' : 'good');
  kpi(out, 'Calibration on schedule', calOk, 'pct', `${overdue('nextCalibrationDue').length} overdue · as at ${stampDay(asAt)}`, calOk != null && calOk < 1 ? 'warn' : 'good');

  // ---- Spend ----
  const spendIn = async (a: string, b: string) => {
    const r = await prisma.serviceExpense.aggregate({ _sum: { amount: true }, where: { date: { gte: parseDate(a), lte: parseDate(b) }, asset: { ...c.scope } } });
    return Number(r._sum.amount ?? 0);
  };
  const [spend, spendFy] = await Promise.all([spendIn(from, to), spendIn(fyStart(month), to)]);
  kpi(out, 'Service spend', spend, 'money', `Financial year to date ₹ ${new Intl.NumberFormat('en-IN').format(Math.round(spendFy))}`);

  // ---- Charts ----
  const firstOfYear = monthStart(isoDate(addMonths(parseDate(from), -11)).slice(0, 7));
  const year = await prisma.complaint.findMany({ where: { raisedAt: { gte: zonedDayStart(firstOfYear), lt: c.toAt }, ...c.scope }, select: { raisedAt: true } });
  out.charts.push(oneSeries('breakdowns-12', 'Breakdowns per month', 'column', 'Breakdowns', monthKeys(firstOfYear, to).map((m) => [monthLabel(m), year.filter((x) => monthInTz(x.raisedAt) === m).length] as [string, number]), 'int', 'Last 12 months'));
  const depts = new Map<string, typeof uptime.rows>();
  for (const r of uptime.rows) depts.set(r.a.department.name, [...(depts.get(r.a.department.name) ?? []), r]);
  out.charts.push({ ...oneSeries('uptime-by-department', 'Uptime by department', 'bar', 'Uptime', [...depts].map(([d, rs]) => [d, uptimeOf(rs) ?? 1] as [string, number]).sort((a, b) => a[1] - b[1]), 'pct'), print: false });

  // ---- Tables ----
  addSheet(out, 'Departments', [
    { header: 'Department', key: 'dept', width: 24 }, { header: 'Equipment measured', key: 'assets', fmt: 'int', width: 18 }, { header: 'Breakdowns', key: 'count', fmt: 'int' },
    { header: 'Downtime (h)', key: 'down', fmt: 'hours' }, { header: 'Uptime', key: 'uptime', fmt: 'pct' },
  ], [...depts].map(([dept, rs]) => ({
    dept, assets: rs.length, count: raised.filter((r) => r.x.asset.department.name === dept).length, down: hours(rs.reduce((s, r) => s + r.downMs, 0)), uptime: uptimeOf(rs),
  })).sort((a, b) => (a.uptime ?? 1) - (b.uptime ?? 1)), ['assets', 'count', 'down']);

  const byAsset = new Map<string, typeof raised>();
  for (const r of raised) byAsset.set(r.x.assetId, [...(byAsset.get(r.x.assetId) ?? []), r]);
  addSheet(out, 'Most breakdowns this month', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 22 },
    { header: 'Breakdowns', key: 'count', fmt: 'int' }, { header: 'Downtime (h)', key: 'down', fmt: 'hours' },
  ], top([...byAsset.values()].sort((a, b) => b.length - a.length), 10).map((rs) => ({
    code: rs[0].x.asset.assetCode, name: rs[0].x.asset.name, dept: rs[0].x.asset.department.name, count: rs.length, down: hours(rs.reduce((s, r) => s + (r.m.downtimeSeconds ?? 0) * 1000, 0)),
  })));

  addSheet(out, `Critical equipment down over ${limit} h`, [
    { header: 'Complaint no.', key: 'no' }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Raised', key: 'raised', fmt: 'datetime', width: 20 },
    { header: 'Resolved', key: 'resolved', fmt: 'datetime', width: 20 }, { header: 'Down (h)', key: 'down', fmt: 'hours' }, { header: 'Problem', key: 'desc', width: 36 },
  ], overLimit.map(({ x }) => ({ no: x.complaintNo, code: x.asset.assetCode, name: x.asset.name, raised: x.raisedAt, resolved: x.resolvedAt ?? 'Still open', down: lengthH(x), desc: x.description })));

  const late = [
    ...overdue('nextPmsDue').map((a) => ({ a, what: 'PMS', due: a.nextPmsDue! })),
    ...overdue('nextCalibrationDue').map((a) => ({ a, what: 'Calibration', due: a.nextCalibrationDue! })),
  ].sort((x, y) => x.due.getTime() - y.due.getTime());
  addSheet(out, `Overdue PMS and calibration (as at ${stampDay(asAt)})`, [
    { header: 'What', key: 'what' }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 22 },
    { header: 'Criticality', key: 'crit' }, { header: 'Was due', key: 'due', fmt: 'date' }, { header: 'Days overdue', key: 'days', fmt: 'int' },
  ], late.map(({ a, what, due }) => ({ what, code: a.assetCode, name: a.name, dept: a.department.name, crit: CRITICALITY_LABEL[a.criticality], due, days: daysBetween(due, parseDate(asAt)) })));

  // Replacement: as things stand at the end of the month, over the 12 months up to it.
  const yearAgo = zonedDayStart(isoDate(addMonths(parseDate(addDaysISO(to, 1)), -12)));
  const [breaks12, spend12, orders] = await Promise.all([
    prisma.complaint.groupBy({ by: ['assetId'], where: { assetId: { in: active.map((a) => a.id) }, raisedAt: { gte: yearAgo, lt: c.toAt } }, _count: true }),
    prisma.serviceExpense.groupBy({ by: ['assetId'], where: { assetId: { in: active.map((a) => a.id) }, date: { gte: yearAgo, lte: parseDate(to) } }, _sum: { amount: true } }),
    prisma.purchaseOrder.groupBy({ by: ['assetId'], where: { assetId: { in: active.map((a) => a.id) } }, _sum: { cost: true } }),
  ]);
  const candidates = active.flatMap((a) => {
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
  addSheet(out, 'Equipment to consider replacing', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 22 }, { header: 'Age (years)', key: 'years', fmt: 'years' },
    { header: 'Breakdowns, 12 months', key: 'breaks', fmt: 'int', width: 20 }, { header: 'Repair spend, 12 months', key: 'spent', fmt: 'money', width: 22 },
    { header: 'Purchase cost', key: 'cost', fmt: 'money', width: 16 }, { header: 'Why', key: 'why', width: 40 },
  ], candidates.map((r) => ({ code: r.a.assetCode, name: r.a.name, dept: r.a.department.name, years: r.years == null ? null : Math.round(r.years * 10) / 10, breaks: r.breaks, spent: r.spent, cost: r.cost || null, why: r.reasons.join('; ') })));

  const horizon = addDaysISO(asAt, 60);
  const contracts = await prisma.serviceContract.findMany({ where: { endDate: { gte: parseDate(asAt), lte: parseDate(horizon) }, asset: { status: 'active', ...c.scope } }, include: { asset: { include: { department: true } } } });
  const cover = [
    ...active.filter((a) => a.warrantyEnd && isoDate(a.warrantyEnd) >= asAt && isoDate(a.warrantyEnd) <= horizon).map((a) => ({ what: 'Warranty', a, dept: a.department.name, ends: a.warrantyEnd!, vendor: '' })),
    ...contracts.map((k) => ({ what: `${k.type.toUpperCase().replace('_', '-')} contract`, a: k.asset, dept: k.asset.department.name, ends: k.endDate, vendor: k.vendor })),
  ].sort((x, y) => x.ends.getTime() - y.ends.getTime());
  addSheet(out, 'Warranty and contracts ending in 60 days', [
    { header: 'Cover', key: 'what' }, { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 22 },
    { header: 'Vendor', key: 'vendor', width: 20 }, { header: 'Ends', key: 'ends', fmt: 'date' },
  ], cover.map((r) => ({ what: r.what, code: r.a.assetCode, name: r.a.name, dept: r.dept, vendor: r.vendor, ends: r.ends })));

  return {
    type: 'monthly',
    title: `Monthly report: ${monthName(month)}`,
    hospital: settings.name,
    from,
    to,
    group: null,
    generatedAt: now.toISOString(),
    generatedBy: viewer.name,
    note: `Uptime counts 24 hours a day. PMS and calibration on schedule, overdue items, replacement and cover ending are as at ${stampDay(asAt)}. Condemned and not-in-use equipment is left out of these; the other reports list it.`,
    ...out,
  };
}

const stampDay = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(parseDate(iso));

// ---------- Saving it on the 1st, telling the HOD ----------

const AUTHOR = 'BME Assets (automatic)';
const isUniqueClash = (e: unknown) => (e as Prisma.PrismaClientKnownRequestError)?.code === 'P2002';

// Save the report for `month` if it has not been saved yet, then tell the people it is for (the HOD: whoever can
// decide approvals and read reports) in the bell, and by email with the PDF when email is set up. Safe to run any
// number of times and from two servers at once: the unique month lets exactly one save win, and only the winner
// tells anyone. Returns whether this call saved it.
export async function saveMonthlyReport(month: string, now = new Date()): Promise<{ saved: boolean; notified: number; emailed: number }> {
  const none = { saved: false, notified: 0, emailed: 0 };
  // A brand-new install that has not been set up has nothing to report yet.
  if (!(await prisma.hospitalSettings.findFirst())) return none;
  if (await prisma.monthlyReport.findUnique({ where: { month } })) return none;
  const data = await buildMonthlyReport(month, { name: AUTHOR, scope: {} }, now);
  try {
    await prisma.monthlyReport.create({ data: { month, data: data as unknown as Prisma.InputJsonValue } });
  } catch (e) {
    if (isUniqueClash(e)) return none;
    throw e;
  }

  const ids = await usersWithPermissions('approval.decide', 'report.view');
  const people = await prisma.user.findMany({ where: { id: { in: ids }, active: true } });
  const figure = (label: string) => data.kpis.find((k) => k.label === label);
  const uptime = figure('Equipment uptime')?.value;
  const summary = [
    typeof uptime === 'number' ? `uptime ${pct(uptime)}` : null,
    `${figure('Breakdowns')?.value ?? 0} breakdowns`,
    typeof figure('PMS on schedule')?.value === 'number' ? `PMS ${pct(figure('PMS on schedule')!.value as number)} on schedule` : null,
  ].filter(Boolean).join(', ');
  const message = `Monthly report for ${monthName(month)} is ready: ${summary}`;
  const withBell = new Set(await usersWithPermissions('notification.view'));
  const bell = people.filter((u) => withBell.has(u.id));
  if (bell.length) {
    // emailedAt is set: the report goes out below as its own email with the PDF, not in the reminder digest.
    await prisma.notification.createMany({ data: bell.map((u) => ({ userId: u.id, type: 'report', dueDate: parseDate(monthStart(month)), message, emailedAt: now })) });
  }

  let emailed = 0;
  const settings = await prisma.hospitalSettings.findFirstOrThrow();
  if (smtpConfigured(settings) && people.length) {
    const pdf = await toPdf(data);
    for (const u of people) {
      try {
        await sendMail(
          settings,
          u.email,
          `${settings.name}: biomedical equipment report for ${monthName(month)}`,
          `Hello ${u.name},\n\nThe monthly report for ${monthName(month)} is attached: ${summary}.\n\nIt is also in the BME Asset Management system under Reports, Monthly report, and can be downloaded again as PDF or Excel.`,
          [{ filename: `bme-monthly-report-${month}.pdf`, content: pdf }],
        );
        emailed++;
      } catch (err) {
        // The saved report and the bell notice stand; a failed email is logged, not retried (the report is one click away).
        console.error(`Monthly report email to ${u.email} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return { saved: true, notified: bell.length, emailed };
}

// The month before `today` (YYYY-MM-DD, hospital date). On the 1st this is the month that just ended; on any later
// day it is still last month, so a server that was off on the 1st catches up when it starts.
export const lastMonth = (today: string) => previousMonth(today.slice(0, 7));

export const MONTHLY_TIME = '30 6 1 * *'; // 06:30 hospital time on the 1st, after the 06:00 reminders
