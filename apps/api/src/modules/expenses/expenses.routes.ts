import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { createExpenseSchema, type CreateExpenseInput, type ExpenseList, type ExpenseRow } from '@bme/shared';
import { audited } from '../../lib/audit';
import { currentUser, requirePermission } from '../../lib/auth';
import { isoDate, parseDate, todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { validate } from '../../lib/validate';
import { findScopedAsset } from '../assets/assets.service';

// Mounted under /assets: /assets/:id/expenses. Costs are for biomedical staff and the HOD only
// (nursing has no expense permission), and the asset lookup applies the department scope.
export const expensesRouter = Router();

type Row = Prisma.ServiceExpenseGetPayload<{ include: { complaint: true } }>;
const toRow = (e: Row): ExpenseRow => ({
  id: e.id,
  type: e.type,
  description: e.description,
  amount: Number(e.amount),
  date: isoDate(e.date),
  vendor: e.vendor,
  complaintId: e.complaintId,
  complaintNo: e.complaint?.complaintNo ?? null,
});

expensesRouter.get('/:id/expenses', requirePermission('expense.manage'), async (req, res) => {
  const asset = await findScopedAsset(req);
  const rows = await prisma.serviceExpense.findMany({ where: { assetId: asset.id }, include: { complaint: true }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
  const items = rows.map(toRow);
  const body: ExpenseList = { items, total: items.reduce((sum, e) => sum + e.amount, 0) };
  res.json(body);
});

expensesRouter.post('/:id/expenses', requirePermission('expense.manage'), validate(createExpenseSchema), async (req, res) => {
  const asset = await findScopedAsset(req);
  const input = req.body as CreateExpenseInput;
  if (input.date > todayISO()) throw new HttpError(400, 'The expense date cannot be in the future', { fieldErrors: { date: ['Cannot be in the future'] } });
  if (input.complaintId) {
    const complaint = await prisma.complaint.findUnique({ where: { id: input.complaintId } });
    if (!complaint || complaint.assetId !== asset.id) {
      throw new HttpError(400, 'That complaint is not for this asset', { fieldErrors: { complaintId: ['Choose a complaint for this asset'] } });
    }
  }
  const row = await audited(req, { action: 'service_expense.create', entityType: 'service_expense' }, (tx) =>
    tx.serviceExpense.create({
      data: { ...input, date: parseDate(input.date), complaintId: input.complaintId ?? null, vendor: input.vendor ?? null, assetId: asset.id, createdBy: currentUser(req).id },
    }),
  );
  res.status(201).json(toRow(await prisma.serviceExpense.findUniqueOrThrow({ where: { id: row.id }, include: { complaint: true } })));
});
