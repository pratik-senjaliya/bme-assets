import type { PermissionCode } from '@bme/shared';
import type { NotificationType, RunRemindersResult } from '@bme/shared';
import { addMonths, daysBetween, parseDate, prettyDate } from '../../lib/dates';
import { sendMail, smtpConfigured } from '../../lib/mail';
import { usersWithPermissions } from '../../lib/people';
import { prisma } from '../../lib/prisma';

// Who gets which reminder: people whose role can act on it (and can read notifications).
const RECIPIENT_PERMISSION: Record<'pms' | 'calibration' | 'warranty' | 'contract', PermissionCode> = {
  pms: 'pms.perform',
  calibration: 'calibration.manage',
  warranty: 'asset.edit',
  contract: 'asset.edit',
};

const recipients = (type: NotificationType) => usersWithPermissions(RECIPIENT_PERMISSION[type as keyof typeof RECIPIENT_PERMISSION], 'notification.view');

type Candidate = { type: NotificationType; assetId: string; dueDate: Date; message: (daysLeft: number) => string };

const inDays = (n: number) => (n === 1 ? '1 day' : `${n} days`);
const when = (daysLeft: number) => (daysLeft < 0 ? `overdue by ${inDays(-daysLeft)}` : daysLeft === 0 ? 'due today' : `due in ${inDays(daysLeft)}`);
const ends = (daysLeft: number) => (daysLeft === 0 ? 'ends today' : `ends in ${inDays(daysLeft)}`);

// Business rule 8. Safe to run as often as you like (daily 06:00, at startup, from the admin button):
// for every item the *tightest threshold already crossed* produces one reminder per person, and the
// unique index makes a repeat impossible. If the server was off for a few days, it still sends one
// reminder for where things stand now instead of a burst for every missed threshold.
// `today` is a YYYY-MM-DD string so tests can fake the clock.
export async function generateReminders(today: string): Promise<RunRemindersResult> {
  const settings = await prisma.hospitalSettings.findFirst();
  if (!settings) return { created: 0, emailed: 0 }; // a brand-new install that has not been set up yet
  const thresholds = [...settings.reminderDays].sort((a, b) => a - b);
  if (thresholds.length === 0) return { created: 0, emailed: 0 };

  const todayDate = parseDate(today);
  const horizon = addMonths(todayDate, 0);
  horizon.setUTCDate(horizon.getUTCDate() + thresholds[thresholds.length - 1]);

  // Condemned and not-in-use equipment never produce reminders (business rule 7).
  const active = { status: 'active' as const };
  const [pms, calibration, warranty, contracts] = await Promise.all([
    prisma.asset.findMany({ where: { ...active, nextPmsDue: { not: null, lte: horizon } } }),
    prisma.asset.findMany({ where: { ...active, nextCalibrationDue: { not: null, lte: horizon } } }),
    prisma.asset.findMany({ where: { ...active, warrantyEnd: { gte: todayDate, lte: horizon } } }),
    prisma.serviceContract.findMany({ where: { endDate: { gte: todayDate, lte: horizon }, asset: active }, include: { asset: true } }),
  ]);

  const label = (a: { assetCode: string; name: string }) => `${a.assetCode} ${a.name}`;
  const candidates: Candidate[] = [
    ...pms.map((a): Candidate => ({ type: 'pms', assetId: a.id, dueDate: a.nextPmsDue!, message: (d) => `PMS ${when(d)}: ${label(a)} (${prettyDate(a.nextPmsDue!)})` })),
    ...calibration.map((a): Candidate => ({ type: 'calibration', assetId: a.id, dueDate: a.nextCalibrationDue!, message: (d) => `Calibration ${when(d)}: ${label(a)} (${prettyDate(a.nextCalibrationDue!)})` })),
    ...warranty.map((a): Candidate => ({ type: 'warranty', assetId: a.id, dueDate: a.warrantyEnd!, message: (d) => `Warranty ${ends(d)}: ${label(a)} (${prettyDate(a.warrantyEnd!)})` })),
    ...contracts.map((c): Candidate => ({ type: 'contract', assetId: c.assetId, dueDate: c.endDate, message: (d) => `${c.type.toUpperCase().replace('_', '-')} contract with ${c.vendor} ${ends(d)}: ${label(c.asset)} (${prettyDate(c.endDate)})` })),
  ];

  const people = new Map<NotificationType, string[]>();
  for (const type of Object.keys(RECIPIENT_PERMISSION) as NotificationType[]) people.set(type, await recipients(type));

  const data = candidates.flatMap((c) => {
    const daysLeft = daysBetween(todayDate, c.dueDate);
    const threshold = thresholds.find((t) => daysLeft <= t);
    if (threshold === undefined) return [];
    return (people.get(c.type) ?? []).map((userId) => ({
      userId,
      type: c.type,
      assetId: c.assetId,
      dueDate: c.dueDate,
      thresholdDays: threshold,
      message: c.message(daysLeft),
    }));
  });

  const created = data.length ? await prisma.notification.createManyAndReturn({ data, skipDuplicates: true, select: { id: true } }) : [];
  const emailed = await sendPendingEmails();
  return { created: created.length, emailed };
}

// One digest email per person for reminders not yet emailed. Only when SMTP is set up; a failed send
// leaves the rows unsent so the next run retries (for 3 days, then the in-app reminder stands alone).
export async function sendPendingEmails(): Promise<number> {
  const settings = await prisma.hospitalSettings.findFirst();
  if (!settings || !smtpConfigured(settings)) return 0;

  const since = new Date(Date.now() - 3 * 86_400_000);
  const pending = await prisma.notification.findMany({
    where: { emailedAt: null, createdAt: { gte: since }, user: { active: true } },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });
  const byUser = new Map<string, typeof pending>();
  for (const n of pending) byUser.set(n.userId!, [...(byUser.get(n.userId!) ?? []), n]);

  let sent = 0;
  for (const rows of byUser.values()) {
    const user = rows[0].user!;
    try {
      const lines = rows.map((r) => `• ${r.message}`).join('\n');
      await sendMail(settings, user.email, `BME reminders: ${rows.length} item${rows.length === 1 ? '' : 's'} need attention`, `Hello ${user.name},\n\n${lines}\n\nSign in to the BME Asset Management system for details.`);
      await prisma.notification.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { emailedAt: new Date() } });
      sent += rows.length;
    } catch (e) {
      console.error(`Reminder email to ${user.email} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}
