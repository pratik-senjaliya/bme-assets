import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import type { DashboardDueItem, DashboardMonth, DashboardResponse } from '@bme/shared';
import { currentUser, departmentScope, requirePermission } from '../../lib/auth';
import { addMonths, daysFromToday, endOfMonthISO, isoDate, monthInTz, parseDate, todayISO, zonedDayStart } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { complaintInclude, toComplaintRows } from '../complaints/complaints.service';

export const dashboardRouter = Router();

const round1 = (n: number) => Math.round(n * 10) / 10;

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
  };
  res.json(body);
});
