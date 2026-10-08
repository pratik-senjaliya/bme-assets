import { Router } from 'express';
import type { HealthResponse } from '@bme/shared';
import { authenticate } from './lib/auth';
import { prisma } from './lib/prisma';
import { approvalsRouter } from './modules/approvals/approvals.routes';
import { assetsRouter, attachmentsRouter } from './modules/assets/assets.routes';
import { authRouter } from './modules/auth/auth.routes';
import { calibrationRouter } from './modules/calibration/calibration.routes';
import { complaintsRouter } from './modules/complaints/complaints.routes';
import { expensesRouter } from './modules/expenses/expenses.routes';
import { importRouter } from './modules/import/import.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { pmsRouter } from './modules/pms/pms.routes';
import { rolesRouter } from './modules/roles/roles.routes';
import { settingsRouter } from './modules/settings/settings.routes';
import { setupRouter } from './modules/setup/setup.routes';
import { usersRouter } from './modules/users/users.routes';

export const v1 = Router();

v1.get('/health', async (_req, res) => {
  let database: HealthResponse['database'] = 'up';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'down';
  }
  const body: HealthResponse = { status: 'ok', database, serverTime: new Date().toISOString() };
  res.status(database === 'up' ? 200 : 503).json(body);
});

v1.use('/auth', authRouter);

// Everything below needs a signed-in user; each route then declares its own permission.
v1.use(authenticate);
v1.use(approvalsRouter); // /assets/:id/condemn, /assets/:id/condemnation, /approvals
v1.use('/assets', assetsRouter);
v1.use('/assets', expensesRouter); // /assets/:id/expenses
v1.use('/complaints', complaintsRouter);
v1.use(pmsRouter); // /pms-templates, /assets/:id/pms, /pms/due, /pms/:id
v1.use(calibrationRouter); // /assets/:id/calibrations, /calibration/due
v1.use('/attachments', attachmentsRouter);
v1.use('/import', importRouter);
v1.use('/users', usersRouter);
v1.use(notificationsRouter); // /notifications, /reminders/run, /settings/smtp-test
v1.use('/roles', rolesRouter);
v1.use('/settings', settingsRouter);
v1.use(setupRouter); // /departments, /locations, /equipment-types
