import { Tag, Typography } from 'antd';
import Link from 'next/link';
import type { ComplaintRow } from '@bme/shared';
import { StatusTag } from '@/components/StatusTag';
import { formatDateTime } from '@/lib/format';

// Compact list of complaints for the dashboard, longest-waiting first.
export function ComplaintsMiniList({ rows }: { rows: ComplaintRow[] }) {
  if (rows.length === 0) return <Typography.Text type="secondary">No open complaints.</Typography.Text>;
  return (
    <>
      {rows.map((c) => (
        <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid #F3F4F6' }}>
          <div style={{ minWidth: 0 }}>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{c.complaintNo}</span>{' '}
            <Link href={`/assets/${c.assetId}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {c.assetCode}
            </Link>
            {c.criticality === 'critical' && <Tag style={{ marginLeft: 8, fontWeight: 600 }}>Critical</Tag>}
            <Typography.Paragraph ellipsis={{ rows: 1, tooltip: c.description }} style={{ margin: 0, color: '#6B7280', fontSize: 12 }}>
              {c.description}
            </Typography.Paragraph>
            <div style={{ color: '#6B7280', fontSize: 12 }}>{formatDateTime(c.raisedAt)}</div>
          </div>
          <StatusTag status={c.status} />
        </div>
      ))}
    </>
  );
}
