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
