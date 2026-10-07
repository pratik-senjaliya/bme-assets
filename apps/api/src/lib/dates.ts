import { config } from './config';

// Dates in the DB are calendar dates (@db.Date) held as UTC midnight; the API speaks 'YYYY-MM-DD'.
export const parseDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const isoDateOrNull = (d: Date | null) => (d ? isoDate(d) : null);

// Today in the hospital's timezone (APP_TIMEZONE), as YYYY-MM-DD. Never use the client's clock.
export const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());

// Adds months, clamping the day (31 Jan + 1 month = 28/29 Feb).
export function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay)));
}

export const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 86_400_000);

// Whole days from today (hospital timezone) to a due date; negative = overdue.
export const daysFromToday = (due: Date) => daysBetween(parseDate(todayISO()), due);

// 07 Oct 2026, for messages and emails.
export const prettyDate = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
