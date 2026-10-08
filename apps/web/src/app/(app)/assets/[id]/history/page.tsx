'use client';

import { Button } from 'antd';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReportData } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { ExportMenu } from '@/components/ExportMenu';
import { ReportView } from '@/components/ReportView';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { StatusResult } from '@/components/StatusResult';
import { DashboardSkeleton } from '@/components/Skeletons';

// One equipment's whole life on screen: figures and a table for each kind of record. Excel and PDF are the same data.
export default function AssetHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const report = useFetch<ReportData>(can('report.view') ? `/assets/${id}/history?format=json` : null);

  if (!can('report.view')) return <StatusResult status="403" title="You cannot see reports" />;
  if (report.error) {
    return <StatusResult status="404" title="Could not load the history" subTitle={report.error} extra={<Link href={`/assets/${id}`}><Button>Back to the asset</Button></Link>} />;
  }
  const code = report.data?.title.replace('Full history of ', '') ?? '';
  return (
    <>
      <PageHeader
        title={report.data ? <span className="code">{code}</span> : 'Full history'}
        docTitle={code ? `History of ${code}` : 'Full history'}
        subtitle="Everything recorded for this equipment, from registration to today"
        crumbs={['Assets', code || '…', 'Full history']}
        action={<ExportMenu path={`/assets/${id}/history`} name={`bme-history-${code}`} />}
      />
      {!report.data ? <DashboardSkeleton header={false} /> : <ReportView data={report.data} />}
    </>
  );
}
