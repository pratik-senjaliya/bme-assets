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
