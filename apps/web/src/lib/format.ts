import type { ValueFmt } from '@bme/shared';
const TZ = 'Asia/Kolkata';

// 07 Oct 2026
export const formatDate = (value: string | Date | null | undefined) =>
  value ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ }).format(new Date(value)) : '—';

// 07 Oct 2026, 14:35
export const formatDateTime = (value: string | Date | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: TZ,
      })
        .format(new Date(value))
        .replace(/(\d{4}) /, '$1, ')
    : '—';

// ₹ 12,500
export const formatMoney = (value: number) => `₹ ${new Intl.NumberFormat('en-IN').format(value)}`;
// Props for a rupee InputNumber: shows 12,34,567.50 while typing (Indian grouping), stores the plain number.
export const moneyInputProps = {
  prefix: '₹',
  formatter: (value: number | string | undefined) => {
    const s = String(value ?? '');
    if (!s) return '';
    const [whole, paise] = s.split('.');
    const grouped = whole ? new Intl.NumberFormat('en-IN').format(Number(whole)) : '';
    return paise !== undefined ? `${grouped}.${paise}` : grouped;
  },
  parser: (text: string | undefined) => (text ?? '').replace(/[^\d.]/g, ''),
};

// 2 y 3 m, 5 m, < 1 m
export const formatAge = (months: number | null | undefined) => {
  if (months == null) return '—';
  const y = Math.floor(months / 12);
  const m = months % 12;
  return y ? (m ? `${y} y ${m} m` : `${y} y`) : m ? `${m} m` : '< 1 m';
};

// 3.5 MB, 120 KB
export const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// 2 h 15 m, 25 m, 3 d 4 h, < 1 m. Used for response time and downtime.
export const formatDuration = (seconds: number | null | undefined) => {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  if (m < 1) return '< 1 m';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  return h ? (m % 60 ? `${h} h ${m % 60} m` : `${h} h`) : `${m} m`;
};

// Today in the hospital's timezone as YYYY-MM-DD. For display and picking filters only: dates that are
// stored (PMS date, due dates, reminders) are decided by the server.
export const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

export const addDaysISO = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Last day of the month that `iso` falls in.
export const endOfMonthISO = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export const daysFromToday = (iso: string) => Math.round((new Date(`${iso}T00:00:00Z`).getTime() - new Date(`${todayIST()}T00:00:00Z`).getTime()) / 86_400_000);

// "Dr. Meera Shah (HOD)" → "Dr. Meera Shah"; first name "Meera"; initials "MS". Titles are not names.
const TITLE = /^(dr|mr|mrs|ms|sister|sr|nurse)\.?\s+/i;
export const shortName = (name: string) => name.replace(/\s*\(.*\)\s*$/, '').trim();
export const firstName = (name: string) => shortName(name).replace(TITLE, '').split(/\s+/)[0] ?? '';
export const initials = (name: string) =>
  shortName(name)
    .replace(TITLE, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

// A number or text as its report column or chart says it should read.
export function formatValue(v: unknown, fmt: ValueFmt | undefined): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'string') return fmt === 'date' ? formatDate(v) : v;
  if (typeof v !== 'number') return String(v);
  const n = (digits: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
  switch (fmt) {
    case 'money':
      return `₹ ${n(0)}`;
    case 'pct':
      return `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(v * 100)}%`;
    case 'hours':
      return `${n(1)} h`;
    case 'years':
      return `${n(1)} y`;
    default:
      return n(Number.isInteger(v) ? 0 : 1);
  }
}

// Short numbers for chart axes: 1.2L, 45K, 98%.
export function formatAxis(v: number, fmt: ValueFmt): string {
  if (fmt === 'pct') return `${Math.round(v * 100)}%`;
  const abs = Math.abs(v);
  const short = abs >= 1e7 ? `${+(v / 1e7).toFixed(1)}Cr` : abs >= 1e5 ? `${+(v / 1e5).toFixed(1)}L` : abs >= 1e4 ? `${+(v / 1e3).toFixed(0)}K` : String(+v.toFixed(1));
  return fmt === 'money' ? `₹${short}` : short;
}
