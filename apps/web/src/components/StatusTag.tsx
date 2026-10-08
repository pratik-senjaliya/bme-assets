import { Tag } from 'antd';

// The one status → colour mapping. Text always shown, never colour alone.
// green = good, gold = attention, red = problem, default = neutral, blue = info.
const STATUS = {
  active: { color: 'green', label: 'Active' },
  inactive: { color: 'default', label: 'Inactive' },
  not_in_use: { color: 'default', label: 'Not in use' },
  condemned: { color: 'default', label: 'Condemned' },
  open: { color: 'red', label: 'Open' },
  in_progress: { color: 'gold', label: 'In progress' },
  resolved: { color: 'green', label: 'Resolved' },
  pending: { color: 'blue', label: 'Pending approval' },
  approved: { color: 'green', label: 'Approved' },
  rejected: { color: 'default', label: 'Rejected' },
  pass: { color: 'green', label: 'Pass' },
  fail: { color: 'red', label: 'Fail' },
  warranty_active: { color: 'green', label: 'In warranty' },
  warranty_expiring: { color: 'gold', label: 'Expiring soon' },
  warranty_expired: { color: 'default', label: 'Out of warranty' },
} as const;

export type StatusKind = keyof typeof STATUS;

export function StatusTag({ status }: { status: StatusKind }) {
  const s = STATUS[status];
  return <Tag color={s.color}>{s.label}</Tag>;
}

const WARRANTY = { active: 'warranty_active', expiring: 'warranty_expiring', expired: 'warranty_expired' } as const;

export function WarrantyTag({ status }: { status: 'none' | 'active' | 'expiring' | 'expired' }) {
  return status === 'none' ? <span aria-label="No warranty recorded">—</span> : <StatusTag status={WARRANTY[status]} />;
}

// Criticality is a property of the asset, not a status, so it stays neutral (colour is reserved for status).
export function CriticalityTag({ value }: { value: string }) {
  return <Tag style={{ textTransform: 'capitalize', fontWeight: value === 'critical' ? 600 : 400 }}>{value}</Tag>;
}

// Due dates: overdue is a problem (red), within 30 days needs attention (amber), later is fine.
export function DueTag({ daysLeft }: { daysLeft: number }) {
  if (daysLeft < 0) return <Tag color="red">Overdue by {-daysLeft} {-daysLeft === 1 ? 'day' : 'days'}</Tag>;
  if (daysLeft === 0) return <Tag color="gold">Due today</Tag>;
  if (daysLeft <= 30) return <Tag color="gold">Due in {daysLeft} {daysLeft === 1 ? 'day' : 'days'}</Tag>;
  return <Tag color="green">Due in {daysLeft} days</Tag>;
}
