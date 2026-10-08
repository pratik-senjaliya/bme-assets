import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { smtpTestSchema, type NotificationList, type NotificationRow, type NotificationType, type RunRemindersResult } from '@bme/shared';
import { audit } from '../../lib/audit';
import { currentUser, requirePermission } from '../../lib/auth';
import { isoDateOrNull, todayISO } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { sendMail, smtpConfigured } from '../../lib/mail';
import { prisma } from '../../lib/prisma';
import { idOf, validate } from '../../lib/validate';
import { generateReminders } from '../reminders/reminders.service';

export const notificationsRouter = Router();

const toRow = (n: Prisma.NotificationGetPayload<object>): NotificationRow => ({
  id: n.id,
  type: n.type as NotificationType,
  assetId: n.assetId,
  message: n.message,
  dueDate: isoDateOrNull(n.dueDate),
  thresholdDays: n.thresholdDays,
  createdAt: n.createdAt.toISOString(),
  readAt: n.readAt?.toISOString() ?? null,
});

// Always the signed-in user's own notifications: there is no way to ask for anyone else's.
notificationsRouter.get('/notifications', requirePermission('notification.view'), async (req, res) => {
  const userId = currentUser(req).id;
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId }, orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }], take: 30 }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  res.json({ items: rows.map(toRow), unread } satisfies NotificationList);
});

notificationsRouter.post('/notifications/read-all', requirePermission('notification.view'), async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: currentUser(req).id, readAt: null }, data: { readAt: new Date() } });
  res.status(204).end();
});

notificationsRouter.post('/notifications/:id/read', requirePermission('notification.view'), async (req, res) => {
  const { count } = await prisma.notification.updateMany({ where: { id: idOf(req), userId: currentUser(req).id, readAt: null }, data: { readAt: new Date() } });
  if (count === 0 && !(await prisma.notification.findFirst({ where: { id: idOf(req), userId: currentUser(req).id } }))) throw new HttpError(404, 'Not found');
  res.status(204).end();
});

// Admin tools: run the daily check now (demo, or after changing reminder days), and test the SMTP settings.
notificationsRouter.post('/reminders/run', requirePermission('setup.manage'), async (req, res) => {
  const result = await generateReminders(todayISO());
  await audit(prisma, req, { action: 'reminders.run', entityType: 'notification', after: result });
  res.json(result satisfies RunRemindersResult);
});

notificationsRouter.post('/settings/smtp-test', requirePermission('setup.manage'), validate(smtpTestSchema), async (req, res) => {
  const settings = await prisma.hospitalSettings.findFirstOrThrow();
  if (!smtpConfigured(settings)) throw new HttpError(400, 'Save the SMTP host and from-address first');
  try {
    await sendMail(settings, req.body.to, 'BME Asset Management: test email', 'This is a test email. Reminder emails are set up correctly.');
  } catch (e) {
    throw new HttpError(502, `The mail server refused the message: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
  res.json({ ok: true });
});
