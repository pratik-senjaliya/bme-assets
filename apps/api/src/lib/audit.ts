import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

type Db = Prisma.TransactionClient;

type Entry = {
  action: string; // e.g. department.create
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  actorId?: string | null; // defaults to the signed-in user
};

const SECRET_KEYS = new Set(['passwordHash', 'password', 'smtpPassword']);

// Plain JSON for the JSONB columns (dates, decimals → strings), never containing secrets.
const toJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  value == null ? undefined : JSON.parse(JSON.stringify(value, (k, v) => (SECRET_KEYS.has(k) ? undefined : v)));

// Append-only: this module only ever inserts into audit_logs.
export async function auditMany(db: Db, req: Request, entries: Entry[]) {
  await db.auditLog.createMany({
    data: entries.map((e) => ({
      actorId: e.actorId === undefined ? (req.user?.id ?? null) : e.actorId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      before: toJson(e.before),
      after: toJson(e.after),
      ip: req.ip ?? null,
    })),
  });
}

export const audit = (db: Db, req: Request, e: Entry) => auditMany(db, req, [e]);

// Runs a change and its audit entry in one transaction, so there is never a change without a log
// (or a log without a change). For `*.delete` actions the removed row is stored as `before` only.
export function audited<T extends { id: string }>(
  req: Request,
  entry: { action: string; entityType: string; before?: unknown },
  run: (tx: Db) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await run(tx);
    const isDelete = entry.action.endsWith('.delete');
    await audit(tx, req, {
      ...entry,
      entityId: result.id,
      before: isDelete ? result : entry.before,
      after: isDelete ? undefined : result,
    });
    return result;
  });
}
