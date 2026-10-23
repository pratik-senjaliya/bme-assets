import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import { APP_VERSION, UNRESOLVED_STATUSES, updateSettingsSchema, type Register, type SettingsResponse, type UpdateSettingsInput } from '@bme/shared';
import { audit, audited } from '../../lib/audit';
import { ensureStarterTrades, ensureStarterTypes } from '../../lib/baseData';
import { usersWithPermissions } from '../../lib/people';
import { notify } from '../approvals/approvals.service';
import { currentUser, requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { diskSpace } from '../../lib/storage';
import { validate } from '../../lib/validate';

export const settingsRouter = Router();
settingsRouter.use(requirePermission('setup.manage'));

type Row = Awaited<ReturnType<typeof prisma.hospitalSettings.findFirstOrThrow>>;

const toResponse = async (s: Row): Promise<SettingsResponse> => {
  const disk = await diskSpace();
  return {
  name: s.name,
  shortCode: s.shortCode,
  assetIdPattern: s.assetIdPattern,
  patternLocked: s.patternLocked,
  reminderDays: s.reminderDays,
  criticalDowntimeHours: s.criticalDowntimeHours,
  complaintCloseDays: s.complaintCloseDays,
  transfersEnabled: s.transfersEnabled,
  facilityEnabled: s.facilityEnabled,
  medicalGasRegister: s.medicalGasRegister,
  biomedContact: s.biomedContact,
  facilityContact: s.facilityContact,
  idleLogoutMinutes: s.idleLogoutMinutes,
  smtpHost: s.smtpHost,
  smtpPort: s.smtpPort,
  smtpUser: s.smtpUser,
  smtpFrom: s.smtpFrom,
  smtpPasswordSet: !!s.smtpPassword, // the password itself is never sent back
  mailLastSentAt: s.mailLastSentAt?.toISOString() ?? null,
  mailLastError: s.mailLastError,
  mailLastErrorAt: s.mailLastErrorAt?.toISOString() ?? null,
  backupLastAt: s.backupLastAt?.toISOString() ?? null,
  backupLastError: s.backupLastError,
  backupLastErrorAt: s.backupLastErrorAt?.toISOString() ?? null,
  labelBaseUrl: s.labelBaseUrl,
  system: { version: APP_VERSION, dailyJobLastRunAt: s.dailyJobLastRunAt?.toISOString() ?? null, storageFreeBytes: disk?.free ?? null, storageTotalBytes: disk?.total ?? null },
  };
};

// One row per install (no multi-tenancy).
const load = () => prisma.hospitalSettings.findFirstOrThrow();

settingsRouter.get('/', async (_req, res) => {
  res.json(await toResponse(await load()));
});

settingsRouter.put('/', validate(updateSettingsSchema), async (req, res) => {
  const input = req.body as UpdateSettingsInput;
  const { smtpPassword, ...rest } = input; // blank password = keep the stored one
  const before = await load();

  if (input.assetIdPattern !== undefined && input.assetIdPattern !== before.assetIdPattern) {
    if (!currentUser(req).permissions.includes('settings.pattern')) {
      throw new HttpError(403, 'Only the super admin can change the asset ID pattern');
    }
    // Locks with the first asset; re-checked here so a stale flag can't allow a change.
    if (before.patternLocked || (await prisma.asset.count()) > 0) {
      throw new HttpError(409, 'The asset ID pattern is locked because assets already exist');
    }
  }

  // The facility add-on is the vendor's to switch on (decision K), like the asset ID pattern.
  if (input.facilityEnabled !== undefined && input.facilityEnabled !== before.facilityEnabled && currentUser(req).role !== 'super_admin') {
    throw new HttpError(403, 'Only the super admin can switch the facility maintenance add-on on or off');
  }

  // Medical gases go to maintenance only while the add-on is on; switching it off first needs them back with
  // biomedical, or their equipment and complaints would belong to a team that no longer exists.
  const facilityAfter = input.facilityEnabled ?? before.facilityEnabled;
  const gasesAfter = input.medicalGasRegister ?? before.medicalGasRegister;
  if (gasesAfter === 'facility' && !facilityAfter) {
    throw new HttpError(409, before.facilityEnabled ? 'Medical gases are looked after by maintenance: give them back to biomedical before switching the add-on off' : 'Medical gases can go to maintenance once the facility add-on is on', { fieldErrors: { medicalGasRegister: ['Only with the facility add-on'] } });
  }

  // The hospital code is part of every asset ID (rule 2): once IDs carry it, a new code would make new IDs disagree.
  if (input.shortCode !== undefined && input.shortCode !== before.shortCode && before.assetIdPattern.includes('{HOSP}') && (await prisma.asset.count()) > 0) {
    throw new HttpError(409, 'The hospital code is part of the asset IDs already given out, so it can no longer be changed', { fieldErrors: { shortCode: ['Locked: asset IDs already use it'] } });
  }

  const gasesMove = gasesAfter !== before.medicalGasRegister;
  const row = await audited(req, { action: 'settings.update', entityType: 'hospital_settings', before }, async (tx) => {
    const updated = await tx.hospitalSettings.update({ where: { id: before.id }, data: { ...rest, ...(smtpPassword ? { smtpPassword } : {}) } });
    if (gasesMove) await moveMedicalGases(tx, req, gasesAfter);
    return updated;
  });
  // Switched on for the first time: the starter facility types, checklists and trades, so the team can start.
  if (row.facilityEnabled && !before.facilityEnabled) {
    if (!(await prisma.equipmentType.count({ where: { register: 'facility' } }))) await ensureStarterTypes('facility');
    await ensureStarterTrades();
  }
  res.json(await toResponse(row));
});

// Decision I: medical gases change team. In the same transaction as the setting: the gas equipment types, their
// equipment, the Medical gas trade, and the unresolved complaints about any of them move to the other team. Those
// complaints lose their assignment (the other team takes them) and any pending escalation; records already made stay
// as they are and show under the new team. Both teams and the HOD are told.
async function moveMedicalGases(tx: Prisma.TransactionClient, req: Request, to: Register) {
  const types = await tx.equipmentType.findMany({ where: { medicalGas: true }, select: { id: true } });
  const typeIds = types.map((t) => t.id);
  const trades = await tx.trade.findMany({ where: { medicalGas: true }, select: { id: true } });
  const complaints = await tx.complaint.findMany({
    where: { status: { in: UNRESOLVED_STATUSES }, OR: [{ asset: { equipmentTypeId: { in: typeIds } } }, { tradeId: { in: trades.map((t) => t.id) } }] },
    select: { id: true, complaintNo: true, register: true, assignedToId: true },
  });
  await tx.equipmentType.updateMany({ where: { id: { in: typeIds } }, data: { register: to } });
  const assets = await tx.asset.updateMany({ where: { equipmentTypeId: { in: typeIds } }, data: { register: to } });
  await tx.trade.updateMany({ where: { medicalGas: true }, data: { register: to } });
  await tx.complaint.updateMany({ where: { id: { in: complaints.map((c) => c.id) } }, data: { register: to, assignedToId: null, assignedAt: null, assignedBy: null, escalatedAt: null, escalatedBy: null } });
  const after = { register: to, equipmentTypes: typeIds.length, assets: assets.count, trades: trades.length, complaints: complaints.map((c) => c.complaintNo) };
  await audit(tx, req, { action: 'medical_gas.move', entityType: 'hospital_settings', entityId: null, before: { register: to === 'facility' ? 'biomedical' : 'facility' }, after });
  const team = to === 'facility' ? 'maintenance' : 'biomedical';
  const open = complaints.length ? ` ${complaints.length} unresolved ${complaints.length === 1 ? 'complaint goes' : 'complaints go'} to the ${team} board unassigned: ${complaints.map((c) => c.complaintNo).join(', ')}.` : '';
  // Both teams (one gains the equipment, the other loses it) and the HOD, except whoever changed it.
  const told = new Set([...(await usersWithPermissions('complaint.start', 'notification.view')), ...(await usersWithPermissions('approval.decide', 'notification.view'))]);
  told.delete(currentUser(req).id);
  await notify(tx, [...told], `Medical gases are now looked after by the ${team} team: ${assets.count} ${assets.count === 1 ? 'machine' : 'machines'} moved.${open}`, null);
}
