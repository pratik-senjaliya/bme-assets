'use client';

import { Space, Typography } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import type { ComplaintRow, Paged } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { StatusTag } from '@/components/StatusTag';
import { useFetch } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';

// Read-only complaint list. The API applies the department scope, so a nurse only gets their own.
export function ComplaintsTable({ assetId, reloadKey = 0 }: { assetId?: string; reloadKey?: number }) {
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), pageSize: '20', ...(assetId ? { assetId } : {}) });
  const complaints = useFetch<Paged<ComplaintRow>>(`/complaints?${qs}&k=${reloadKey}`);

  return (
    <DataTable<ComplaintRow>
      rows={complaints.data?.items ?? null}
      loading={complaints.loading}
      error={complaints.error}
      onRetry={complaints.reload}
      emptyText="No complaints."
      pagination={{ current: page, pageSize: 20, total: complaints.data?.total ?? 0, showSizeChanger: false, hideOnSinglePage: true, onChange: setPage }}
      columns={[
        { title: 'No.', dataIndex: 'complaintNo', render: (n: string) => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{n}</span> },
        ...(assetId
          ? []
          : [
              {
                title: 'Equipment',
                key: 'asset',
                render: (_: unknown, c: ComplaintRow) => (
                  <Link href={`/assets/${c.assetId}`}>
                    {c.assetCode}
                    <div style={{ color: '#6B7280', fontSize: 12 }}>{c.assetName}</div>
                  </Link>
                ),
              },
            ]),
        { title: 'Problem', dataIndex: 'description', render: (d: string) => <Typography.Paragraph ellipsis={{ rows: 2, tooltip: d }} style={{ margin: 0, maxWidth: 360 }}>{d}</Typography.Paragraph> },
        { title: 'Raised', dataIndex: 'raisedAt', render: (v: string, c) => <Space direction="vertical" size={0}><span>{formatDateTime(v)}</span><span style={{ color: '#6B7280', fontSize: 12 }}>{c.raisedByName}</span></Space> },
        { title: 'Status', dataIndex: 'status', render: (s: ComplaintRow['status']) => <StatusTag status={s} /> },
        { title: 'Response', dataIndex: 'responseSeconds', align: 'right', render: formatDuration },
        { title: 'Downtime', dataIndex: 'downtimeSeconds', align: 'right', render: formatDuration },
      ]}
    />
  );
}
