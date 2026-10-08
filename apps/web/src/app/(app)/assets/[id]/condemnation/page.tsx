'use client';

import { PrinterOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Skeleton, Typography } from 'antd';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { AssetDetail, CondemnationInfo } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { useFetch } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { StatusResult } from '@/components/StatusResult';

// Printable certificate for an approved condemnation.
export default function CondemnationCertificatePage() {
  const { id } = useParams<{ id: string }>();
  const asset = useFetch<AssetDetail>(`/assets/${id}`);
  const info = useFetch<CondemnationInfo>(`/assets/${id}/condemnation`);

  if (info.error) return <StatusResult status="404" title="No condemnation certificate" subTitle="This asset has not been condemned." extra={<Link href={`/assets/${id}`}><Button>Back to the asset</Button></Link>} />;
  if (!info.data || !asset.data) return <Skeleton active />;
  const a = asset.data;
  const c = info.data;

  return (
    <>
      <div className="no-print">
        <PageHeader
          title="Condemnation certificate"
          subtitle={`${a.assetCode} · ${a.name}`}
          crumbs={['Assets', a.assetCode, 'Condemnation']}
          action={<Button icon={<PrinterOutlined />} onClick={() => window.print()}>Print</Button>}
        />
      </div>
      <Card className="print-sheet" style={{ maxWidth: 800 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>{c.hospitalName}</Typography.Title>
        <Typography.Title level={5} style={{ marginTop: 0 }}>Condemnation certificate</Typography.Title>
        <Descriptions size="small" column={{ xs: 1, sm: 2 }} style={{ margin: '16px 0' }}>
          <Descriptions.Item label="Asset ID">{a.assetCode}</Descriptions.Item>
          <Descriptions.Item label="Name">{a.name}</Descriptions.Item>
          <Descriptions.Item label="Equipment type">{a.equipmentTypeName}</Descriptions.Item>
          <Descriptions.Item label="Make · model">{[a.make, a.model].filter(Boolean).join(' · ') || '—'}</Descriptions.Item>
          <Descriptions.Item label="Serial number">{a.serialNo ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Department · location">{a.departmentName} · {a.locationName}</Descriptions.Item>
          <Descriptions.Item label="Installed">{formatDate(a.installationDate)}</Descriptions.Item>
          <Descriptions.Item label="Age at condemnation">{a.installationDate ? `${Math.floor((a.ageMonths ?? 0) / 12)} years` : '—'}</Descriptions.Item>
        </Descriptions>
        <Typography.Paragraph strong style={{ marginBottom: 4 }}>Reason</Typography.Paragraph>
        <Typography.Paragraph>{c.reason}</Typography.Paragraph>
        <Descriptions size="small" column={{ xs: 1, sm: 2 }}>
          <Descriptions.Item label="Requested by">{c.requestedByName}, {formatDate(c.requestedAt)}</Descriptions.Item>
          <Descriptions.Item label="Approved by">{c.approvedByName}, {formatDate(c.approvedAt)}</Descriptions.Item>
          <Descriptions.Item label="End-of-life letter">{c.eolLetter?.fileName ?? 'None attached'}</Descriptions.Item>
        </Descriptions>
        <div style={{ display: 'flex', gap: 48, marginTop: 48, flexWrap: 'wrap' }}>
          {['Biomedical HOD (signature)', 'Hospital administration (signature)'].map((label) => (
            <div key={label} style={{ flex: '1 1 260px' }}>
              <div style={{ borderBottom: '1px solid #9CA3AF', height: 40 }} />
              <div style={{ color: '#526173', fontSize: 12, marginTop: 4 }}>{label} · Date</div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
