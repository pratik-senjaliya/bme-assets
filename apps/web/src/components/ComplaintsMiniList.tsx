import { Typography } from 'antd';
import Link from 'next/link';
import type { ComplaintRow } from '@bme/shared';
import { StatusTag } from '@/components/StatusTag';
import { COLORS } from '@/theme';
import { formatDateTime } from '@/lib/format';

// Compact list of complaints for the dashboard, longest-waiting first.
export function ComplaintsMiniList({ rows }: { rows: ComplaintRow[] }) {
  if (rows.length === 0) return <div style={{ color: COLORS.muted, padding: '24px 0', textAlign: 'center' }}>No open complaints. Everything is running.</div>;
  return (
    <>
      {rows.map((c) => (
        <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `1px solid ${COLORS.lineSoft}` }}>
          <div style={{ minWidth: 0 }}>
            <span className="code">{c.complaintNo}</span>{' · '}
            <Link href={`/assets/${c.assetId}`} className="code">
              {c.assetCode}
            </Link>
            {c.criticality === 'critical' && <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600 }}>Critical</span>}
            <Typography.Paragraph ellipsis={{ rows: 1, tooltip: c.description }} style={{ margin: 0, color: COLORS.muted, fontSize: 12.5 }}>
              {c.description}
            </Typography.Paragraph>
            <div style={{ color: COLORS.muted, fontSize: 12 }}>{formatDateTime(c.raisedAt)}</div>
          </div>
          <StatusTag status={c.status} />
        </div>
      ))}
    </>
  );
}
