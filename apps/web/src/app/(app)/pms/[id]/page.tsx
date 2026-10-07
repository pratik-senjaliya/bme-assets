'use client';

import { LockOutlined, PrinterOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Result, Skeleton, Space, Table, Tooltip, Typography } from 'antd';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { AssetDetail, PmsItem, PmsRecordRow } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { useFetch } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';

const itemOk = (i: PmsItem, v: unknown) => {
  if (i.type === 'check') return v === 'pass';
  if (i.type === 'reading' && typeof v === 'number') return !((i.min != null && v < i.min) || (i.max != null && v > i.max));
  return true;
};

export default function PmsRecordPage() {
  const { id } = useParams<{ id: string }>();
  const rec = useFetch<PmsRecordRow>(`/pms/${id}`);
  const asset = useFetch<AssetDetail>(rec.data ? `/assets/${rec.data.assetId}` : null);

  if (rec.error) return <Result status="404" title="PMS record not found" extra={<Link href="/assets"><Button>Back to assets</Button></Link>} />;
  if (!rec.data) return <Skeleton active />;
  const r = rec.data;
  const a = asset.data;

  return (
    <>
      <div className="no-print">
        <PageHeader
          title={`PMS record · ${r.assetCode}`}
          subtitle={`${r.assetName} · ${formatDate(r.performedOn)}`}
          crumbs={['Assets', r.assetCode, 'PMS record']}
          action={
            <Space>
              <Link href={`/assets/${r.assetId}/pms/new?corrects=${r.id}`}>
                <Button>Record a correction</Button>
              </Link>
              <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
                Print
              </Button>
            </Space>
          }
        />
      </div>

      {r.correctsRecordId && (
        <Alert
          className="no-print"
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message={
            <span>
              This is a correction of <Link href={`/pms/${r.correctsRecordId}`}>an earlier record</Link>: {r.correctionReason}
            </span>
          }
        />
      )}
      {r.correctedByRecordId && (
        <Alert
          className="no-print"
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message={
            <span>
              A later record <Link href={`/pms/${r.correctedByRecordId}`}>corrects this one</Link>. This record is kept unchanged.
            </span>
          }
        />
      )}

      <Card className="print-sheet" style={{ maxWidth: 900 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          {r.hospitalName}
        </Typography.Title>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          Preventive maintenance report · {r.equipmentTypeName}
        </Typography.Title>

        <Descriptions size="small" column={{ xs: 1, sm: 2 }} style={{ marginBottom: 16 }}>
          <Descriptions.Item label="Asset ID">{r.assetCode}</Descriptions.Item>
          <Descriptions.Item label="Name">{r.assetName}</Descriptions.Item>
          <Descriptions.Item label="Make · model">{a ? [a.make, a.model].filter(Boolean).join(' · ') || '—' : '…'}</Descriptions.Item>
          <Descriptions.Item label="Serial number">{a ? (a.serialNo ?? '—') : '…'}</Descriptions.Item>
          <Descriptions.Item label="Department · location">{a ? `${a.departmentName} · ${a.locationName}` : '…'}</Descriptions.Item>
          <Descriptions.Item label="Result">
            <StatusTag status={r.result} />
          </Descriptions.Item>
          <Descriptions.Item label="Performed on">
            <Tooltip title="Recorded by the system. It cannot be changed.">
              <span>
                {formatDate(r.performedOn)} <LockOutlined aria-label="Locked" style={{ color: '#6B7280' }} />
              </span>
            </Tooltip>
          </Descriptions.Item>
          <Descriptions.Item label="Performed by">{r.performedByName}</Descriptions.Item>
          <Descriptions.Item label="Submitted">{formatDateTime(r.submittedAt)}</Descriptions.Item>
          <Descriptions.Item label="Checklist">Version {r.templateVersion}</Descriptions.Item>
        </Descriptions>

        <Table<PmsItem>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={r.items}
          columns={[
            { title: 'Check', dataIndex: 'label' },
            {
              title: 'Recorded',
              key: 'answer',
              render: (_: unknown, i) => {
                const v = r.answers[i.id];
                if (v === undefined) return '—';
                if (i.type === 'check') return v === 'pass' ? 'Pass' : 'Fail';
                return i.type === 'reading' ? `${v} ${i.unit ?? ''}` : String(v);
              },
            },
            {
              title: 'Allowed',
              key: 'range',
              render: (_: unknown, i) => (i.type === 'reading' && (i.min != null || i.max != null) ? `${i.min ?? '…'} – ${i.max ?? '…'} ${i.unit ?? ''}` : ''),
            },
            {
              title: '',
              key: 'ok',
              width: 90,
              render: (_: unknown, i) => (i.type === 'text' || r.answers[i.id] === undefined ? '' : <StatusTag status={itemOk(i, r.answers[i.id]) ? 'pass' : 'fail'} />),
            },
          ]}
        />

        <div style={{ display: 'flex', gap: 48, marginTop: 48, flexWrap: 'wrap' }}>
          {['Performed by (signature)', 'Verified by (Biomedical HOD)'].map((label) => (
            <div key={label} style={{ flex: '1 1 260px' }}>
              <div style={{ borderBottom: '1px solid #9CA3AF', height: 40 }} />
              <div style={{ color: '#6B7280', fontSize: 12, marginTop: 4 }}>{label} · Date</div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
