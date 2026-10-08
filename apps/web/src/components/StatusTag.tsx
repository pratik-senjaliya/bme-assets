import type { ReactNode } from 'react';
import { formatDate } from '@/lib/format';
import { COLORS } from '@/theme';

// The one status → colour mapping. Text is always shown, never colour alone.
// good = green, warn = amber, bad = red, info = blue, neutral = grey.
export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="pill" style={{ color: COLORS[tone].fg, background: COLORS[tone].bg }}>
      {children}
    </span>
  );
}

const STATUS = {
  active: { tone: 'good', label: 'Active' },
  inactive: { tone: 'neutral', label: 'Inactive' },
  not_in_use: { tone: 'neutral', label: 'Not in use' },
  condemned: { tone: 'neutral', label: 'Condemned' },
  open: { tone: 'bad', label: 'Open' },
  in_progress: { tone: 'warn', label: 'In progress' },
  resolved: { tone: 'good', label: 'Resolved' },
  pending: { tone: 'info', label: 'Pending approval' },
  approved: { tone: 'good', label: 'Approved' },
  rejected: { tone: 'neutral', label: 'Rejected' },
  pass: { tone: 'good', label: 'Pass' },
  fail: { tone: 'bad', label: 'Fail' },
  warranty_active: { tone: 'good', label: 'In warranty' },
  warranty_expiring: { tone: 'warn', label: 'Expiring soon' },
  warranty_expired: { tone: 'neutral', label: 'Out of warranty' },
} as const satisfies Record<string, { tone: Tone; label: string }>;

export type StatusKind = keyof typeof STATUS;

export function StatusTag({ status }: { status: StatusKind }) {
  const s = STATUS[status];
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

const WARRANTY = { active: 'warranty_active', expiring: 'warranty_expiring', expired: 'warranty_expired' } as const;

// Only "expiring soon" is loud; in warranty / out of warranty are quiet text so a list is not a wall of pills.
export function WarrantyTag({ status }: { status: 'none' | 'active' | 'expiring' | 'expired' }) {
  if (status === 'none') return <span aria-label="No warranty recorded" style={{ color: COLORS.faint }}>—</span>;
  if (status === 'expiring') return <StatusTag status={WARRANTY[status]} />;
  return <span style={{ color: COLORS.muted }}>{status === 'active' ? 'In warranty' : 'Out of warranty'}</span>;
}

// Criticality is a property of the asset, not a status, so it stays neutral (colour is reserved for status).
// Only "critical" is marked; the other levels are quiet text so a long list is not a wall of badges.
export function CriticalityTag({ value }: { value: string }) {
  const label = value[0].toUpperCase() + value.slice(1);
  return value === 'critical' ? (
    <span style={{ fontWeight: 600, color: COLORS.ink, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.ink }} />
      {label}
    </span>
  ) : (
    <span style={{ color: COLORS.muted }}>{label}</span>
  );
}

// Due dates: overdue is a problem (red), within 30 days needs attention (amber), later is fine.
const plural = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
export function DueTag({ daysLeft }: { daysLeft: number }) {
  if (daysLeft < 0) return <Pill tone="bad">Overdue by {plural(-daysLeft)}</Pill>;
  if (daysLeft === 0) return <Pill tone="warn">Due today</Pill>;
  if (daysLeft <= 30) return <Pill tone="warn">Due in {plural(daysLeft)}</Pill>;
  return <Pill tone="good">Due in {plural(daysLeft)}</Pill>;
}

// A due date in a table cell: the date, and under it how far away or overdue it is (coloured, with words).
export function DueCell({ date, daysLeft }: { date: string | null; daysLeft: number | null }) {
  if (!date || daysLeft === null) return <span style={{ color: COLORS.faint }}>—</span>;
  const tone: Tone = daysLeft < 0 ? 'bad' : daysLeft <= 30 ? 'warn' : 'neutral';
  const words = daysLeft < 0 ? `${plural(-daysLeft)} overdue` : daysLeft === 0 ? 'Due today' : `in ${plural(daysLeft)}`;
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>{formatDate(date)}</div>
      <div style={{ fontSize: 12, color: COLORS[tone].fg, fontWeight: tone === 'bad' ? 600 : 400 }}>{words}</div>
    </div>
  );
}

// "190 days overdue" / "in 12 days" as coloured words, for dense lists where a pill per row would be noise.
export function DueText({ daysLeft }: { daysLeft: number }) {
  const tone: Tone = daysLeft < 0 ? 'bad' : daysLeft <= 30 ? 'warn' : 'good';
  const words = daysLeft < 0 ? `${plural(-daysLeft)} overdue` : daysLeft === 0 ? 'Due today' : `Due in ${plural(daysLeft)}`;
  return <span style={{ color: COLORS[tone].fg, fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>{words}</span>;
}
