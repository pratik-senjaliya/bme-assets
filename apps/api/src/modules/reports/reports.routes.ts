import { Router, type Response } from 'express';
import { REPORTS, reportQuerySchema, type ReportData, type ReportType } from '@bme/shared';
import { audit } from '../../lib/audit';
import { requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { idOf } from '../../lib/validate';
import { findScopedAsset } from '../assets/assets.service';
import { toPdf, toWorkbook } from './reports.export';
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
