import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import type { ChartSpec, DashboardDueItem, DashboardExpiry, DashboardMonth, DashboardResponse, DashboardTopAsset, Kpi } from '@bme/shared';
import { currentUser, departmentScope, requirePermission } from '../../lib/auth';
import { addMonths, daysFromToday, endOfMonthISO, isoDate, monthInTz, parseDate, todayISO, zonedDayStart } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { complaintInclude, toComplaintRows } from '../complaints/complaints.service';

export const dashboardRouter = Router();

const round1 = (n: number) => Math.round(n * 10) / 10;
const DAY = 86_400_000;
const monthName = (key: string) => new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(parseDate(`${key}-01`));
const monthsFrom = (first: string, n: number) => Array.from({ length: n }, (_, i) => isoDate(addMonths(parseDate(`${first}-01`), i)).slice(0, 7));
const overlap = (raised: Date, resolved: Date | null, from: Date, to: Date) => Math.max(0, Math.min((resolved ?? to).getTime(), to.getTime()) - Math.max(raised.getTime(), from.getTime()));
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

// One endpoint for the home screen. Every number is scoped like the rest of the API (nursing: own department
// only) and sections the person's role cannot see come back null.
dashboardRouter.get('/dashboard', requirePermission('asset.view'), async (req, res) => {
  const me = currentUser(req);
  const scope = departmentScope(me);
  const can = (code: (typeof me.permissions)[number]) => me.permissions.includes(code);
  const today = todayISO();
  const monthEnd = endOfMonthISO(today);

  const firstMonth = isoDate(addMonths(parseDate(`${today.slice(0, 7)}-01`), -5)).slice(0, 7);
  const monthKeys = Array.from({ length: 6 }, (_, i) => isoDate(addMonths(parseDate(`${firstMonth}-01`), i)).slice(0, 7));

  const dueWhere = (field: 'nextPmsDue' | 'nextCalibrationDue'): Prisma.AssetWhereInput => ({
    status: 'active',
    [field]: { not: null, lte: parseDate(monthEnd) },
    ...scope,
  });
  const dueAssets = async (field: 'nextPmsDue' | 'nextCalibrationDue', kind: DashboardDueItem['kind']): Promise<DashboardDueItem[]> => {
    const orderBy: Prisma.AssetOrderByWithRelationInput = { [field]: 'asc' };
    const assets = await prisma.asset.findMany({ where: dueWhere(field), orderBy });
    return assets.map((a) => {
      const due = a[field]!;
      return { kind, assetId: a.id, assetCode: a.assetCode, assetName: a.name, dueDate: isoDate(due), daysLeft: daysFromToday(due) };
    });
  };

  const showDue = can('pms.perform') || can('calibration.manage');
  const [activeAssets, openComplaints, pmsDue, calDue, pendingApprovals, complaints, openRows, department] = await Promise.all([
    prisma.asset.count({ where: { status: 'active', ...scope } }),
    prisma.complaint.count({ where: { status: { in: ['open', 'in_progress'] }, ...scope } }),
    can('pms.perform') ? dueAssets('nextPmsDue', 'pms') : [],
    can('calibration.manage') ? dueAssets('nextCalibrationDue', 'calibration') : [],
    can('approval.decide') ? prisma.approvalRequest.count({ where: { status: 'pending' } }) : null,
    can('complaint.view')
      ? prisma.complaint.findMany({ where: { raisedAt: { gte: zonedDayStart(`${firstMonth}-01`) }, ...scope }, select: { raisedAt: true, resolvedAt: true } })
      : [],
    can('complaint.view')
      ? prisma.complaint.findMany({ where: { status: { in: ['open', 'in_progress'] }, ...scope }, include: complaintInclude, orderBy: { raisedAt: 'asc' }, take: 8 })
      : [],
    scope.departmentId ? prisma.department.findUnique({ where: { id: scope.departmentId } }) : null,
  ]);

  // ---- The richer picture: the last 12 months and the next 6, scoped like everything above. ----
  const now = new Date();
  const first12 = isoDate(addMonths(parseDate(`${today.slice(0, 7)}-01`), -11)).slice(0, 7);
  const keys12 = monthsFrom(first12, 12);
  const win30 = new Date(now.getTime() - 30 * DAY);
  const showCosts = can('expense.manage');
  const showCover = can('asset.edit');
  const ahead = monthsFrom(today.slice(0, 7), 6);
  const aheadEnd = parseDate(endOfMonthISO(`${ahead[ahead.length - 1]}-01`));

  const [liveAssets, history, expenses, contracts] = await Promise.all([
    prisma.asset.findMany({ where: { status: 'active', ...scope }, select: { id: true, assetCode: true, name: true, criticality: true, installationDate: true, createdAt: true, warrantyEnd: true, nextPmsDue: true, nextCalibrationDue: true, department: { select: { name: true } } } }),
    can('complaint.view')
      ? prisma.complaint.findMany({ where: { raisedAt: { gte: zonedDayStart(`${first12}-01`) }, ...scope }, select: { raisedAt: true, startedAt: true, resolvedAt: true, assetId: true, asset: { select: { assetCode: true, name: true, status: true } } } })
      : [],
    showCosts ? prisma.serviceExpense.findMany({ where: { date: { gte: parseDate(`${first12}-01`) }, asset: { ...scope } }, select: { date: true, type: true, amount: true } }) : [],
    showCover ? prisma.serviceContract.findMany({ where: { endDate: { gte: parseDate(today), lte: parseDate(isoDate(new Date(parseDate(today).getTime() + 60 * DAY))) }, asset: { status: 'active', ...scope } }, select: { type: true, vendor: true, endDate: true, asset: { select: { id: true, assetCode: true, name: true } } } }) : [],
  ]);

  // Uptime over the last 30 days: hours the equipment was working out of the hours it was there (24 a day).
  const uptime = (pool: typeof liveAssets) => {
    const ids = new Set(pool.map((a) => a.id));
    const window = pool.reduce((t, a) => t + Math.max(0, now.getTime() - Math.max(win30.getTime(), a.createdAt.getTime())), 0);
    const down = history.filter((c) => ids.has(c.assetId)).reduce((t, c) => t + overlap(c.raisedAt, c.resolvedAt, win30, now), 0);
    return window ? Math.max(0, 1 - down / window) : null;
  };
  const recent = history.filter((c) => c.raisedAt >= win30);
  const respH = mean(recent.filter((c) => c.startedAt).map((c) => (c.startedAt!.getTime() - c.raisedAt.getTime()) / 3_600_000));
  const downH = mean(recent.filter((c) => c.resolvedAt).map((c) => (c.resolvedAt!.getTime() - c.raisedAt.getTime()) / 3_600_000));
  const critical = liveAssets.filter((a) => a.criticality === 'critical');

  const kpis: Kpi[] = [];
  if (can('complaint.view')) {
    const u = uptime(liveAssets);
    kpis.push({ label: 'Uptime, last 30 days', value: u, fmt: 'pct', hint: 'All active equipment', tone: u == null ? 'neutral' : u >= 0.98 ? 'good' : 'warn' });
    if (critical.length) {
      const cu = uptime(critical);
      kpis.push({ label: 'Critical equipment uptime', value: cu, fmt: 'pct', hint: `${critical.length} critical ${critical.length === 1 ? 'asset' : 'assets'}`, tone: cu == null ? 'neutral' : cu >= 0.98 ? 'good' : 'bad' });
    }
    kpis.push({ label: 'Average response', value: respH, fmt: 'hours', hint: recent.length ? 'Raised to started, 30 days' : 'No complaints in 30 days' });
    kpis.push({ label: 'Average downtime', value: downH, fmt: 'hours', hint: 'Raised to resolved, 30 days' });
  }
  if (showCosts) {
    const month = expenses.filter((e) => isoDate(e.date).slice(0, 7) === today.slice(0, 7)).reduce((t, e) => t + Number(e.amount), 0);
    const year = expenses.filter((e) => isoDate(e.date).slice(0, 4) === today.slice(0, 4)).reduce((t, e) => t + Number(e.amount), 0);
    kpis.push({ label: 'Service spend this month', value: month, fmt: 'money', hint: `This year ₹ ${new Intl.NumberFormat('en-IN').format(year)}` });
  }
  const expiring: DashboardExpiry[] | null = showCover
    ? [
        ...liveAssets.filter((a) => a.warrantyEnd && daysFromToday(a.warrantyEnd) >= 0 && daysFromToday(a.warrantyEnd) <= 60).map((a): DashboardExpiry => ({ kind: 'warranty', label: 'Warranty ends', assetId: a.id, assetCode: a.assetCode, assetName: a.name, date: isoDate(a.warrantyEnd!), daysLeft: daysFromToday(a.warrantyEnd!) })),
        ...contracts.map((k): DashboardExpiry => ({ kind: 'contract', label: `${k.type.toUpperCase().replace('_', '-')} contract ends`, assetId: k.asset.id, assetCode: k.asset.assetCode, assetName: k.asset.name, date: isoDate(k.endDate), daysLeft: daysFromToday(k.endDate) })),
      ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8)
    : null;
  if (expiring) kpis.push({ label: 'Cover ending in 60 days', value: expiring.length, fmt: 'int', hint: expiring.length ? 'Warranties and contracts' : 'Nothing ending soon', tone: expiring.length ? 'warn' : 'good' });

  const charts: ChartSpec[] = [];
  if (can('complaint.view')) {
    const per = (k: string) => history.filter((c) => monthInTz(c.raisedAt) === k);
    charts.push({ id: 'breakdowns', title: 'Breakdowns per month', subtitle: 'Last 12 months', kind: 'column', fmt: 'int', series: [{ key: 'v', label: 'Breakdowns' }], data: keys12.map((k) => ({ label: monthName(k), v: per(k).length })) });
    charts.push({
      id: 'downtime', title: 'Downtime per month', subtitle: 'Resolved breakdowns, hours', kind: 'column', fmt: 'hours', series: [{ key: 'v', label: 'Downtime (h)' }],
      data: keys12.map((k) => ({ label: monthName(k), v: round1(per(k).reduce((t, c) => t + (c.resolvedAt ? c.resolvedAt.getTime() - c.raisedAt.getTime() : 0), 0) / 3_600_000) })),
    });
  }
  if (showDue) {
    const dueIn = (field: 'nextPmsDue' | 'nextCalibrationDue', key: string | 'overdue') =>
      liveAssets.filter((a) => {
        const d = a[field];
        return d && d <= aheadEnd && (key === 'overdue' ? daysFromToday(d) < 0 : daysFromToday(d) >= 0 && isoDate(d).slice(0, 7) === key);
      }).length;
    charts.push({
      id: 'due-ahead', title: 'PMS and calibration due', subtitle: 'Overdue now, then the next 6 months', kind: 'stacked', fmt: 'int',
      series: [{ key: 'pms', label: 'PMS' }, { key: 'cal', label: 'Calibration' }],
      data: [{ label: 'Overdue', pms: can('pms.perform') ? dueIn('nextPmsDue', 'overdue') : 0, cal: can('calibration.manage') ? dueIn('nextCalibrationDue', 'overdue') : 0 }, ...ahead.map((k) => ({ label: monthName(k), pms: can('pms.perform') ? dueIn('nextPmsDue', k) : 0, cal: can('calibration.manage') ? dueIn('nextCalibrationDue', k) : 0 }))],
    });
  }
  if (!scope.departmentId) {
    const byDept = new Map<string, number>();
    for (const a of liveAssets) byDept.set(a.department.name, (byDept.get(a.department.name) ?? 0) + 1);
    charts.push({ id: 'by-department', title: 'Active equipment by department', kind: 'bar', fmt: 'int', series: [{ key: 'v', label: 'Assets' }], data: [...byDept].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, v]) => ({ label, v })) });
  }
  if (showCosts) {
    const sum = (k: string, type: 'repair' | 'spare_part') => expenses.filter((e) => e.type === type && isoDate(e.date).slice(0, 7) === k).reduce((t, e) => t + Number(e.amount), 0);
    charts.push({ id: 'spend', title: 'Service spend per month', subtitle: 'Last 12 months', kind: 'stacked', fmt: 'money', series: [{ key: 'repair', label: 'Repairs' }, { key: 'spare', label: 'Spare parts' }], data: keys12.map((k) => ({ label: monthName(k), repair: sum(k, 'repair'), spare: sum(k, 'spare_part') })) });
  }
  const yearsOld = (a: (typeof liveAssets)[number]) => (a.installationDate ? (now.getTime() - a.installationDate.getTime()) / (365.25 * DAY) : null);
  charts.push({
    id: 'age', title: 'Equipment by age', kind: 'column', fmt: 'int', series: [{ key: 'v', label: 'Assets' }],
    data: [['Under 2 years', (y: number | null) => y != null && y < 2], ['2 to 5 years', (y: number | null) => y != null && y >= 2 && y < 5], ['5 to 10 years', (y: number | null) => y != null && y >= 5 && y < 10], ['10 years or more', (y: number | null) => y != null && y >= 10]]
      .map(([label, test]) => ({ label: label as string, v: liveAssets.filter((a) => (test as (y: number | null) => boolean)(yearsOld(a))).length })),
  });

  const byAsset = new Map<string, DashboardTopAsset>();
  for (const c of history) {
    const t = byAsset.get(c.assetId) ?? { assetId: c.assetId, assetCode: c.asset.assetCode, assetName: c.asset.name, breakdowns: 0, downtimeHours: 0 };
    byAsset.set(c.assetId, { ...t, breakdowns: t.breakdowns + 1, downtimeHours: round1(t.downtimeHours + (c.resolvedAt ? (c.resolvedAt.getTime() - c.raisedAt.getTime()) / 3_600_000 : 0)) });
  }
  const topBreakdowns = can('complaint.view') ? [...byAsset.values()].sort((a, b) => b.breakdowns - a.breakdowns || b.downtimeHours - a.downtimeHours).slice(0, 5) : null;

  const items = [...pmsDue, ...calDue].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const label = (key: string) => new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(parseDate(`${key}-01`));
  const months: DashboardMonth[] = monthKeys.map((month) => {
    const inMonth = complaints.filter((c) => monthInTz(c.raisedAt) === month);
    const downtimeMs = inMonth.reduce((sum, c) => sum + (c.resolvedAt ? c.resolvedAt.getTime() - c.raisedAt.getTime() : 0), 0);
    return { month, label: label(month), breakdowns: inMonth.length, downtimeHours: round1(downtimeMs / 3_600_000) };
  });

  const body: DashboardResponse = {
    scope: scope.departmentId ? 'department' : 'hospital',
    departmentName: department?.name ?? null,
    activeAssets,
    openComplaints,
    dueThisMonth: showDue ? items.filter((i) => i.daysLeft >= 0).length : null,
    overdue: showDue ? items.filter((i) => i.daysLeft < 0).length : null,
    pendingApprovals,
    dueSoon: showDue ? items.slice(0, 8) : null,
    openList: await toComplaintRows(openRows),
    months,
    kpis,
    charts,
    topBreakdowns,
    expiring,
  };
  res.json(body);
});
