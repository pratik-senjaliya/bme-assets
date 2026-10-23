import { Router } from 'express';
import { APP_VERSION, updateSettingsSchema, type SettingsResponse, type UpdateSettingsInput } from '@bme/shared';
import { audited } from '../../lib/audit';
import { ensureStarterTypes } from '../../lib/baseData';
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
  biomedContact: s.biomedContact,
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

  // The hospital code is part of every asset ID (rule 2): once IDs carry it, a new code would make new IDs disagree.
  if (input.shortCode !== undefined && input.shortCode !== before.shortCode && before.assetIdPattern.includes('{HOSP}') && (await prisma.asset.count()) > 0) {
    throw new HttpError(409, 'The hospital code is part of the asset IDs already given out, so it can no longer be changed', { fieldErrors: { shortCode: ['Locked: asset IDs already use it'] } });
  }

  const row = await audited(req, { action: 'settings.update', entityType: 'hospital_settings', before }, (tx) =>
    tx.hospitalSettings.update({ where: { id: before.id }, data: { ...rest, ...(smtpPassword ? { smtpPassword } : {}) } }),
  );
  // Switched on for the first time: the starter facility types and checklists, so the team can start registering.
  if (row.facilityEnabled && !before.facilityEnabled && !(await prisma.equipmentType.count({ where: { register: 'facility' } }))) await ensureStarterTypes('facility');
  res.json(await toResponse(row));
});
