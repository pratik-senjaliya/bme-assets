import { Router, type Response } from 'express';
import { REPORTS, auditPackQuerySchema, monthlyReportQuerySchema, reportQuerySchema, type ReportData, type ReportType, type SavedMonthlyReport } from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, departmentScope, requirePermission } from '../../lib/auth';
import { config } from '../../lib/config';
import { todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { idOf } from '../../lib/validate';
import { findScopedAsset } from '../assets/assets.service';
import { toPdf, toWorkbook } from './reports.export';
import { auditPackSummary, sendAuditPack } from './auditpack.service';
import { buildMonthlyReport, monthName } from './monthly.service';
import { buildAssetHistory, buildReport } from './reports.service';

export const reportsRouter = Router();

// One report, three ways to read it: json (the screen), xlsx and pdf (downloads). Downloads are audited; looking on
// screen is not, the same as opening any other list.
async function respond(res: Response, data: ReportData, filename: string, format: 'json' | 'xlsx' | 'pdf', audited: () => Promise<void>) {
  res.set('Cache-Control', 'no-store');
  if (format === 'json') {
    res.json(data);
    return;
  }
  await audited();
  if (format === 'pdf') {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}.pdf"` });
    res.send(await toPdf(data));
    return;
  }
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
  });
  res.send(Buffer.from(await toWorkbook(data).xlsx.writeBuffer()));
}

// ---------- Monthly management report ----------
// (These come before /reports/:type, which would take "monthly" for an unknown report.)

// The saved copies are the whole hospital's, so they are only for people who see the whole hospital.
const seesWholeHospital = (req: Parameters<typeof currentUser>[0]) => Object.keys(departmentScope(currentUser(req))).length === 0;

reportsRouter.get('/reports/monthly/saved', requirePermission('report.view'), async (req, res) => {
  const rows = seesWholeHospital(req) ? await prisma.monthlyReport.findMany({ select: { month: true, createdAt: true }, orderBy: { month: 'desc' } }) : [];
  res.json(rows.map((r) => ({ month: r.month, savedAt: r.createdAt.toISOString() })) satisfies SavedMonthlyReport[]);
});

// A month that was saved on the 1st reads as saved (what management was sent); any other month, including the one
// still running, is made from the records now and says so.
reportsRouter.get('/reports/monthly', requirePermission('report.view'), async (req, res) => {
  const { month, format } = monthlyReportQuerySchema.parse(req.query);
  const me = currentUser(req);
  const saved = seesWholeHospital(req) ? await prisma.monthlyReport.findUnique({ where: { month } }) : null;
  let data: ReportData;
  if (saved) {
    const kept = saved.data as unknown as ReportData;
    data = { ...kept, note: `Saved on ${new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: config.timezone }).format(saved.createdAt)}: this is the report as it was sent. ${kept.note ?? ''}`.trim() };
  } else {
    data = await buildMonthlyReport(month, { name: me.name, scope: departmentScope(me) });
    const running = month === todayISO().slice(0, 7);
    data = { ...data, note: `${running ? `${monthName(month)} so far, made from the records now.` : 'Made from the records now (this month was not saved on the 1st).'} ${data.note ?? ''}`.trim() };
  }
  await respond(res, data, `bme-monthly-report-${month}`, format, () => audit(prisma, req, { action: 'report.export', entityType: 'report', after: { type: 'monthly', month, saved: !!saved, format } }));
});

// ---------- Audit pack ----------

// Whose equipment the pack covers: someone tied to a department only ever gets that department; others get the
// department they chose, or the whole hospital.
async function packScope(req: Parameters<typeof currentUser>[0], departmentId: string | undefined) {
  const own = departmentScope(currentUser(req));
  const scope = Object.keys(own).length ? own : departmentId ? { departmentId } : {};
  const dept = scope.departmentId ? await prisma.department.findUnique({ where: { id: scope.departmentId }, select: { name: true } }) : null;
  if (scope.departmentId && !dept) throw new HttpError(400, 'That department does not exist', { fieldErrors: { departmentId: ['Choose a department from the list'] } });
  return { scope, departmentName: dept?.name ?? null };
}

reportsRouter.get('/reports/audit-pack/summary', requirePermission('report.view'), async (req, res) => {
  const q = auditPackQuerySchema.parse(req.query);
  const { scope } = await packScope(req, q.departmentId);
  res.json(await auditPackSummary(q, scope));
});

reportsRouter.get('/reports/audit-pack', requirePermission('report.view'), async (req, res) => {
  const q = auditPackQuerySchema.parse(req.query);
  const { scope, departmentName } = await packScope(req, q.departmentId);
  await audit(prisma, req, { action: 'report.export', entityType: 'report', after: { type: 'audit-pack', from: q.from, to: q.to, departmentId: scope.departmentId ?? null } });
  await sendAuditPack(res, q, { name: currentUser(req).name, scope }, departmentName);
});

reportsRouter.get('/reports/:type', requirePermission('report.view'), async (req, res) => {
  const type = String(req.params.type) as ReportType;
  if (!REPORTS.some((r) => r.type === type)) throw new HttpError(404, 'Unknown report');
  const q = reportQuerySchema.parse(req.query);

  const { data, filename } = await buildReport(type, req, q);
  await respond(res, data, filename, q.format, () => audit(prisma, req, { action: 'report.export', entityType: 'report', after: { type, from: data.from, to: data.to, group: q.group, format: q.format } }));
});

// One equipment's full life. Same permission and department scope as the asset itself.
reportsRouter.get('/assets/:id/history', requirePermission('report.view'), async (req, res) => {
  const asset = await findScopedAsset(req, idOf(req));
  const { format } = reportQuerySchema.parse(req.query);
  const { data, filename } = await buildAssetHistory(req, asset.id);
  await respond(res, data, filename, format, () => audit(prisma, req, { action: 'report.export', entityType: 'asset', entityId: asset.id, after: { type: 'asset-history', format } }));
});
