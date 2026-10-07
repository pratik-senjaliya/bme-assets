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
} as const;

export type StatusKind = keyof typeof STATUS;

export function StatusTag({ status }: { status: StatusKind }) {
  const s = STATUS[status];
  return <Tag color={s.color}>{s.label}</Tag>;
}
