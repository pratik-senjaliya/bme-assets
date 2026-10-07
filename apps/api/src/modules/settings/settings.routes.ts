import { Router } from 'express';
import { updateSettingsSchema, type SettingsResponse, type UpdateSettingsInput } from '@bme/shared';
import { audited } from '../../lib/audit';
import { currentUser, requirePermission } from '../../lib/auth';
import { HttpError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { validate } from '../../lib/validate';

export const settingsRouter = Router();
settingsRouter.use(requirePermission('setup.manage'));

type Row = Awaited<ReturnType<typeof prisma.hospitalSettings.findFirstOrThrow>>;

const toResponse = (s: Row): SettingsResponse => ({
  name: s.name,
  shortCode: s.shortCode,
  assetIdPattern: s.assetIdPattern,
  patternLocked: s.patternLocked,
  reminderDays: s.reminderDays,
});

// One row per install (no multi-tenancy).
const load = () => prisma.hospitalSettings.findFirstOrThrow();

settingsRouter.get('/', async (_req, res) => {
  res.json(toResponse(await load()));
});

settingsRouter.put('/', validate(updateSettingsSchema), async (req, res) => {
  const input = req.body as UpdateSettingsInput;
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

  const row = await audited(req, { action: 'settings.update', entityType: 'hospital_settings', before }, (tx) =>
    tx.hospitalSettings.update({ where: { id: before.id }, data: input }),
  );
  res.json(toResponse(row));
});
