import nodemailer from 'nodemailer';
import { prisma } from './prisma';

type Settings = Awaited<ReturnType<typeof prisma.hospitalSettings.findFirstOrThrow>>;

// Email is optional (hospital servers may have no internet). It counts as configured only when a host
// and a from-address are saved in Hospital settings.
export const smtpConfigured = (s: Settings) => !!(s.smtpHost && s.smtpFrom);

export async function sendMail(s: Settings, to: string, subject: string, text: string, attachments?: { filename: string; content: Buffer }[]) {
  const transport = nodemailer.createTransport({
    host: s.smtpHost!,
    port: s.smtpPort ?? 587,
    secure: s.smtpPort === 465,
    auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPassword ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  // Each attempt is written down (Hospital settings shows it), so a mail server that stopped working is noticed
  // instead of failing quietly in the server log.
  try {
    await transport.sendMail({ from: s.smtpFrom!, to, subject, text, attachments });
    await prisma.hospitalSettings.update({ where: { id: s.id }, data: { mailLastSentAt: new Date() } }).catch(() => undefined);
  } catch (e) {
    const error = `${to}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    await prisma.hospitalSettings.update({ where: { id: s.id }, data: { mailLastError: error, mailLastErrorAt: new Date() } }).catch(() => undefined);
    throw e;
  }
}
