'use client';

import { LockOutlined } from '@ant-design/icons';
import { Button, Card, Space, Tooltip, Typography } from 'antd';
import Link from 'next/link';
import type { AssetDetail, PmsRecordRow } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { DueTag, StatusTag } from '@/components/StatusTag';
import { useFetch } from '@/lib/api';
import { daysFromToday, formatDate, formatDateTime } from '@/lib/format';

export function AssetPmsTab({ asset }: { asset: AssetDetail }) {
  const records = useFetch<PmsRecordRow[]>(`/assets/${asset.id}/pms`);
  const active = asset.status === 'active';

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space size={32} wrap align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space size={32} wrap>
            <div>
              <div style={{ color: '#526173', fontSize: 12, marginBottom: 4 }}>Next PMS due</div>
              {asset.nextPmsDue ? (
                <Space>
                  <span>{formatDate(asset.nextPmsDue)}</span>
                  <DueTag daysLeft={daysFromToday(asset.nextPmsDue)} />
                </Space>
              ) : (
                '—'
              )}
            </div>
            <div>
              <div style={{ color: '#526173', fontSize: 12, marginBottom: 4 }}>Interval</div>
              {asset.pmsFrequencyMonths ? `Every ${asset.pmsFrequencyMonths} months` : '—'}
            </div>
          </Space>
          {active && (
            <Link href={`/assets/${asset.id}/pms/new`}>
              <Button>Perform PMS</Button>
            </Link>
          )}
        </Space>
      </Card>
      <DataTable<PmsRecordRow>
        rows={records.data}
        loading={records.loading}
        error={records.error}
        onRetry={records.reload}
        emptyText="No PMS recorded yet."
        columns={[
          {
            title: 'Date',
            dataIndex: 'performedOn',
            render: (d: string) => (
              <Tooltip title="Recorded by the system. It cannot be changed.">
                <span>
                  {formatDate(d)} <LockOutlined aria-label="Locked" style={{ color: '#526173' }} />
                </span>
              </Tooltip>
            ),
          },
          { title: 'Result', dataIndex: 'result', render: (r: PmsRecordRow['result']) => <StatusTag status={r} /> },
          { title: 'Done by', dataIndex: 'performedByName' },
          { title: 'Checklist', dataIndex: 'templateVersion', render: (v: number) => `v${v}` },
          {
            title: 'Note',
            key: 'note',
            render: (_: unknown, r) =>
              r.correctsRecordId ? (
                <Typography.Text type="secondary">Correction: {r.correctionReason}</Typography.Text>
              ) : r.correctedByRecordId ? (
                <Typography.Text type="secondary">Corrected later</Typography.Text>
              ) : (
                ''
              ),
          },
          { title: 'Submitted', dataIndex: 'submittedAt', render: formatDateTime },
          {
            title: <span className="sr-only">Actions</span>,
            key: 'view',
            align: 'right',
            render: (_: unknown, r) => (
              <Link href={`/pms/${r.id}`}>
                <Button size="small">View</Button>
              </Link>
            ),
          },
        ]}
      />
    </Space>
  );
}
