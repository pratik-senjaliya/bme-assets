import { Router } from 'express';
import { REPORTS, reportQuerySchema, type ReportType } from '@bme/shared';
import { audit } from '../../lib/audit';
import { requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { buildReport } from './reports.service';

export const reportsRouter = Router();

// Excel only (.xlsx). Date range and grouping come from the query; every download is audited.
reportsRouter.get('/reports/:type', requirePermission('report.view'), async (req, res) => {
  const type = String(req.params.type) as ReportType;
  if (!REPORTS.some((r) => r.type === type)) throw new HttpError(404, 'Unknown report');
  const q = reportQuerySchema.parse(req.query);

  const { wb, filename, from, to } = await buildReport(type, req, q);
  await audit(prisma, req, { action: 'report.export', entityType: 'report', after: { type, from, to, group: q.group } });

  const buffer = await wb.xlsx.writeBuffer();
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.send(Buffer.from(buffer));
});
