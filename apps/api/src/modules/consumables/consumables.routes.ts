import { Router, type Request } from 'express';
import { Prisma } from '@prisma/client';
import {
  CONSUMABLE_MAX_DAYS_BACK,
  consumableItemSchema,
  isGone,
  isLowStock,
  issueSchema,
  registerQuerySchema,
  newConsumableSchema,
  stockAdjustSchema,
  stockInSchema,
  type ConsumableDetail,
  type ConsumableItemInput,
  type ConsumableMovementRow,
  type ConsumableRow,
  type IssueInput,
  type StockAdjustInput,
  type StockInInput,
} from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, departmentScope, requirePermission } from '../../lib/auth';
import { addDaysISO, isoDate, parseDate, todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { registerTeam } from '../../lib/people';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';

// Consumables (step 6 of docs/requirements-2026-10-20.md, decision F): items kept in stock and given out. Stock moves
// only through movements (in, out, adjust), each written with the new stock in one transaction and never changed
// afterwards; a wrong entry is put right with an adjustment. Every movement is audited.
export const consumablesRouter = Router();
const MANAGE = requirePermission('consumable.manage');

type Db = Prisma.TransactionClient;
type Item = Prisma.ConsumableItemGetPayload<object>;
const movementInclude = {
  department: { select: { name: true } },
  asset: { select: { id: true, assetCode: true, name: true } },
  complaint: { select: { id: true, complaintNo: true } },
  supplier: { select: { name: true } },
  by: { select: { name: true } },
} satisfies Prisma.ConsumableMovementInclude;
type Movement = Prisma.ConsumableMovementGetPayload<{ include: typeof movementInclude }>;

const num = (d: Prisma.Decimal | null) => (d == null ? null : Number(d));
const toRow = (i: Item, lastIssuedOn: Date | null = null): ConsumableRow => ({
  id: i.id,
  name: i.name,
  unit: i.unit as ConsumableRow['unit'],
  stock: i.stock,
  reorderLevel: i.reorderLevel,
  low: isLowStock(i),
  unitCost: num(i.unitCost),
  notes: i.notes,
  active: i.active,
  register: i.register,
  lastIssuedOn: lastIssuedOn && isoDate(lastIssuedOn),
});
const toMovement = (m: Movement): ConsumableMovementRow => ({
  id: m.id,
  kind: m.kind,
  quantity: m.quantity,
  stockAfter: m.stockAfter,
  date: isoDate(m.date),
  unitCost: num(m.unitCost),
  departmentName: m.department?.name ?? null,
  asset: m.asset,
  complaint: m.complaint,
  supplierName: m.supplier?.name ?? null,
  reference: m.reference,
  reason: m.reason,
  byName: m.by.name,
  createdAt: m.createdAt.toISOString(),
});

// Each team keeps its own store: an item of the other register looks like a missing one.
async function findItem(req: Request) {
  const item = await prisma.consumableItem.findFirst({ where: { id: idOf(req), register: { in: currentUser(req).registers } } });
  if (!item) throw new HttpError(404, 'Item not found');
  return item;
}

async function assertNameFree(name: string, exceptId?: string) {
  const clash = await prisma.consumableItem.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (clash) throw new HttpError(409, `${clash.name} is already in the list`, { fieldErrors: { name: [`${clash.name} is already in the list`] } });
}

// Movements carry the day they happened: never ahead of today, at most CONSUMABLE_MAX_DAYS_BACK days back.
function checkDate(date: string) {
  const today = todayISO();
  if (date > today) throw new HttpError(400, 'The date cannot be in the future', { fieldErrors: { date: ['Not after today'] } });
  if (date < addDaysISO(today, -CONSUMABLE_MAX_DAYS_BACK)) {
    throw new HttpError(400, `Enter movements within ${CONSUMABLE_MAX_DAYS_BACK} days. For older stock, record a stock count instead.`, { fieldErrors: { date: [`At most ${CONSUMABLE_MAX_DAYS_BACK} days back`] } });
  }
}

// Moves the stock by `change` and records the movement, in the caller's transaction. Taking out more than is on the
// shelf is refused here (and by the CHECK constraint behind it), so two people issuing the last one cannot both win.
async function move(tx: Db, req: Request, item: Item, change: number, data: Omit<Prisma.ConsumableMovementUncheckedCreateInput, 'itemId' | 'quantity' | 'stockAfter' | 'createdBy'>) {
  const moved = await tx.consumableItem.updateMany({ where: { id: item.id, ...(change < 0 && { stock: { gte: -change } }) }, data: { stock: { increment: change } } });
  if (moved.count === 0) {
    const now = await tx.consumableItem.findUniqueOrThrow({ where: { id: item.id } });
    throw new HttpError(409, `Only ${now.stock} ${now.unit} of ${now.name} in stock`, { fieldErrors: { [data.kind === 'adjust' ? 'change' : 'quantity']: [`Only ${now.stock} in stock`] } });
  }
  const after = await tx.consumableItem.findUniqueOrThrow({ where: { id: item.id } });
  const m = await tx.consumableMovement.create({ data: { ...data, itemId: item.id, quantity: change, stockAfter: after.stock, createdBy: currentUser(req).id }, include: movementInclude });
  await audit(tx, req, { action: `consumable.${data.kind}`, entityType: 'consumable', entityId: item.id, before: { stock: item.stock }, after: { ...m, item: after.name } });
  // The moment an item reaches its reorder level, the people who keep the stock hear about it, once per crossing.
  if (!isLowStock(item) && isLowStock(after)) {
    const people = await registerTeam(item.register, 'consumable.manage', 'notification.view');
    const message = after.stock === 0 ? `${after.name} is out of stock` : `${after.name} is low: ${after.stock} ${after.unit} left (reorder at ${after.reorderLevel})`;
    if (people.length) await tx.notification.createMany({ data: people.map((userId) => ({ userId, type: 'stock', message })) });
  }
  return m;
}

consumablesRouter.get('/', MANAGE, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const { register } = registerQuerySchema.parse(req.query);
  const mine = currentUser(req).registers.filter((r) => !register || r === register);
  const items = await prisma.consumableItem.findMany({ where: { register: { in: mine }, ...(search && { name: { contains: search, mode: 'insensitive' } }) }, orderBy: { name: 'asc' }, take: 1000 });
  const last = await prisma.consumableMovement.groupBy({ by: ['itemId'], where: { kind: 'out', itemId: { in: items.map((i) => i.id) } }, _max: { date: true } });
  const lastOf = new Map(last.map((l) => [l.itemId, l._max.date]));
  let rows = items.map((i) => toRow(i, lastOf.get(i.id) ?? null));
  if (req.query.low === 'true') rows = rows.filter((r) => r.low && r.active);
  res.json(rows);
});

consumablesRouter.get('/:id', MANAGE, async (req, res) => {
  const item = await findItem(req);
  const movements = await prisma.consumableMovement.findMany({ where: { itemId: item.id }, include: movementInclude, orderBy: { createdAt: 'desc' }, take: 300 });
  const lastOut = movements.find((m) => m.kind === 'out');
  res.json({ ...toRow(item, lastOut?.date ?? null), movements: movements.map(toMovement) } satisfies ConsumableDetail);
});

const itemFields = (v: ConsumableItemInput) => ({ name: v.name, unit: v.unit, reorderLevel: v.reorderLevel, unitCost: v.unitCost ?? null, notes: v.notes ?? null, active: v.active });

consumablesRouter.post('/', MANAGE, validate(newConsumableSchema), async (req, res) => {
  const input = req.body as ConsumableItemInput & { openingStock: number };
  await assertNameFree(input.name);
  // Whose store: as chosen, else the person's own (biomedical for someone who keeps both).
  const mine = currentUser(req).registers;
  const register = input.register ?? mine[0];
  if (!register || !mine.includes(register)) throw new HttpError(403, 'You do not keep this store', { fieldErrors: { register: ['Choose your own team’s store'] } });
  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.consumableItem.create({ data: { ...itemFields(input), register, createdBy: currentUser(req).id } });
    await audit(tx, req, { action: 'consumable.create', entityType: 'consumable', entityId: created.id, after: created });
    // What is on the shelf today is the first movement, so the register adds up from the start.
    if (input.openingStock > 0) await move(tx, req, created, input.openingStock, { kind: 'adjust', date: parseDate(todayISO()), unitCost: created.unitCost, reason: 'Opening stock' });
    return tx.consumableItem.findUniqueOrThrow({ where: { id: created.id } });
  });
  res.status(201).json(toRow(item));
});

// Details only; the stock changes through movements.
consumablesRouter.put('/:id', MANAGE, validate(consumableItemSchema), async (req, res) => {
  const before = await findItem(req);
  const input = req.body as ConsumableItemInput;
  await assertNameFree(input.name, before.id);
  const item = await prisma.$transaction(async (tx) => {
    const updated = await tx.consumableItem.update({ where: { id: before.id }, data: itemFields(input) });
    await audit(tx, req, { action: 'consumable.update', entityType: 'consumable', entityId: before.id, before, after: updated });
    return updated;
  });
  res.json(toRow(item));
});

// Only an item entered by mistake, with nothing ever moved; anything else is set to not in use and keeps its history.
consumablesRouter.delete('/:id', MANAGE, async (req, res) => {
  const item = await findItem(req);
  if (await prisma.consumableMovement.count({ where: { itemId: item.id } })) {
    throw new HttpError(409, `${item.name} has stock movements, so it stays in the register. Edit it and switch off "In use" instead.`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.consumableItem.delete({ where: { id: item.id } });
    await audit(tx, req, { action: 'consumable.delete', entityType: 'consumable', entityId: item.id, before: item });
  });
  res.status(204).end();
});

// Stock in on purchase. A price paid becomes the item's unit cost from now on.
consumablesRouter.post('/:id/in', MANAGE, validate(stockInSchema), async (req, res) => {
  const item = await findItem(req);
  const input = req.body as StockInInput;
  checkDate(input.date);
  if (input.supplierId && !(await prisma.vendor.findUnique({ where: { id: input.supplierId } }))) {
    throw new HttpError(400, 'Choose a company from the suppliers list', { fieldErrors: { supplierId: ['Choose a company from the suppliers list'] } });
  }
  const m = await prisma.$transaction(async (tx) => {
    if (input.unitCost != null) await tx.consumableItem.update({ where: { id: item.id }, data: { unitCost: input.unitCost } });
    return move(tx, req, item, input.quantity, { kind: 'in', date: parseDate(input.date), unitCost: input.unitCost ?? item.unitCost, supplierId: input.supplierId ?? null, reference: input.reference ?? null, reason: input.note ?? null });
  });
  res.status(201).json(toMovement(m));
});

// Given out to a department, perhaps for one machine or one complaint. The machine must be that department's and
// still in the hospital; the complaint must be that machine's (or names the machine when none is given), or a ward
// fault of that department and team.
consumablesRouter.post('/:id/issue', MANAGE, validate(issueSchema), async (req, res) => {
  const item = await findItem(req);
  const input = req.body as IssueInput;
  checkDate(input.date);
  if (!item.active) throw new HttpError(409, `${item.name} is not in use any more`);
  const scope = departmentScope(currentUser(req));
  if (scope.departmentId && scope.departmentId !== input.departmentId) throw new HttpError(403, 'You can only give out to your own department');
  if (!(await prisma.department.findUnique({ where: { id: input.departmentId } }))) throw new HttpError(400, 'Choose the department', { fieldErrors: { departmentId: ['Choose the department'] } });

  let assetId = input.assetId ?? null;
  if (input.complaintId) {
    const complaint = await prisma.complaint.findUnique({ where: { id: input.complaintId } });
    if (!complaint) throw new HttpError(400, 'Complaint not found', { fieldErrors: { complaintId: ['Complaint not found'] } });
    if (assetId && assetId !== complaint.assetId) throw new HttpError(400, `${complaint.complaintNo} is about ${complaint.assetId ? 'another machine' : 'no machine'}`, { fieldErrors: { complaintId: [`${complaint.complaintNo} is about ${complaint.assetId ? 'another machine' : 'no machine'}`] } });
    // A ward fault without a machine (a tube light for an Electrical complaint): the same team and department.
    if (!complaint.assetId) {
      if (complaint.register !== item.register) throw new HttpError(400, `${item.name} is from the other team's store`, { fieldErrors: { complaintId: [`${complaint.complaintNo} is the other team's`] } });
      if (complaint.departmentId !== input.departmentId) throw new HttpError(400, `${complaint.complaintNo} is another department's`, { fieldErrors: { complaintId: [`${complaint.complaintNo} is another department's`] } });
    }
    assetId = complaint.assetId;
  }
  if (assetId) {
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw new HttpError(400, 'Machine not found', { fieldErrors: { assetId: ['Machine not found'] } });
    if (asset.register !== item.register) throw new HttpError(400, `${item.name} is from the other team's store`, { fieldErrors: { assetId: [`${asset.assetCode} is looked after by the other team`] } });
    if (asset.departmentId !== input.departmentId) throw new HttpError(400, `${asset.assetCode} belongs to another department`, { fieldErrors: { assetId: [`${asset.assetCode} belongs to another department`] } });
    if (isGone(asset.status)) throw new HttpError(409, `${asset.assetCode} has been ${asset.status}`, { fieldErrors: { assetId: [`${asset.assetCode} has been ${asset.status}`] } });
  }
  const m = await prisma.$transaction((tx) =>
    move(tx, req, item, -input.quantity, { kind: 'out', date: parseDate(input.date), unitCost: item.unitCost, departmentId: input.departmentId, assetId, complaintId: input.complaintId ?? null, reason: input.reason }),
  );
  res.status(201).json(toMovement(m));
});

// A stock count that differs from the books (or a wrong entry put right): the change and why, dated today.
consumablesRouter.post('/:id/adjust', MANAGE, validate(stockAdjustSchema), async (req, res) => {
  const item = await findItem(req);
  const input = req.body as StockAdjustInput;
  const m = await prisma.$transaction((tx) => move(tx, req, item, input.change, { kind: 'adjust', date: parseDate(todayISO()), unitCost: item.unitCost, reason: input.reason }));
  res.status(201).json(toMovement(m));
});
