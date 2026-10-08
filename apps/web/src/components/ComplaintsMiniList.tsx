import { Typography } from 'antd';
import Link from 'next/link';
import type { ComplaintRow } from '@bme/shared';
import { CheckCircleOutlined } from '@ant-design/icons';
import { EmptyState } from '@/components/Skeletons';
import { StatusTag } from '@/components/StatusTag';
import { COLORS } from '@/theme';
import { formatDateTime } from '@/lib/format';

// Compact list of complaints for the dashboard, longest-waiting first.
export function ComplaintsMiniList({ rows }: { rows: ComplaintRow[] }) {
  if (rows.length === 0) return <EmptyState compact icon={<CheckCircleOutlined />} title="No open complaints" hint="Everything is running." />;
  return (
    <>
      {rows.map((c) => (
        <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 0', borderBottom: `1px solid ${COLORS.lineSoft}` }}>
          <div style={{ minWidth: 0 }}>
            <span className="code">{c.complaintNo}</span>{' · '}
            <Link href={`/assets/${c.assetId}`} className="code">
              {c.assetCode}
            </Link>
            {c.criticality === 'critical' && <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, color: COLORS.ink }}>Critical</span>}
            <Typography.Paragraph ellipsis={{ rows: 1, tooltip: c.description }} style={{ margin: '3px 0 0', color: COLORS.text, fontSize: 13 }}>
              {c.description}
            </Typography.Paragraph>
            <div style={{ color: COLORS.faint, fontSize: 12 }} className="num">{formatDateTime(c.raisedAt)}</div>
          </div>
          <StatusTag status={c.status} />
        </div>
      ))}
    </>
  );
}
