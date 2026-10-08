'use client';

import { Alert, Button, DatePicker, Result, Segmented, Skeleton, Space } from 'antd';
import dayjs from 'dayjs';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { REPORTS, type ReportData } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { ExportMenu, ReportView } from '@/components/ReportView';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';

const fmt = (d: dayjs.Dayjs) => d.format('YYYY-MM-DD');

// Indian financial year: 1 April to 31 March.
const fyStart = (d: dayjs.Dayjs) => (d.month() >= 3 ? d.month(3).date(1) : d.subtract(1, 'year').month(3).date(1));

function ReportPage() {
  const { type } = useParams<{ type: string }>();
  const { can } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const meta = REPORTS.find((r) => r.type === type);

  const today = dayjs();
  const from = params.get('from') ?? fmt(today.subtract(12, 'month'));
  const to = params.get('to') ?? fmt(today);
  const group = params.get('group') === 'year' ? 'year' : 'month';
  const range = meta?.range ?? false;
  const query = new URLSearchParams({ ...(range ? { from, to } : {}), ...(meta && 'group' in meta ? { group } : {}) });
  const path = `/reports/${type}${query.size ? `?${query}` : ''}`;
  const report = useFetch<ReportData>(can('report.view') && meta ? `${path}${query.size ? '&' : '?'}format=json` : null);

  if (!can('report.view')) return <Result status="403" title="You cannot see reports" />;
  if (!meta) return <Result status="404" title="Report not found" extra={<Link href="/reports"><Button>All reports</Button></Link>} />;

  const set = (next: Record<string, string>) => router.replace(`${pathname}?${new URLSearchParams({ from, to, group, ...next })}`);

  return (
    <>
      <PageHeader title={meta.title} subtitle={meta.description} crumbs={['Reports', meta.title]} action={<ExportMenu path={path} name={`bme-${type}`} />} />
      {(range || 'group' in meta) && (
        <Space wrap size={16} style={{ marginBottom: 20 }}>
          {range && (
            <DatePicker.RangePicker
              allowClear={false}
              format="DD MMM YYYY"
              aria-label="Period"
              value={[dayjs(from), dayjs(to)]}
              disabledDate={(d) => d.isAfter(today, 'day')}
              presets={[
                { label: 'This month', value: [today.startOf('month'), today] },
                { label: 'Last 3 months', value: [today.subtract(3, 'month'), today] },
                { label: 'Last 12 months', value: [today.subtract(12, 'month'), today] },
                { label: 'This financial year', value: [fyStart(today), today] },
                { label: 'Last financial year', value: [fyStart(today).subtract(1, 'year'), fyStart(today).subtract(1, 'day')] },
              ]}
              onChange={(v) => v?.[0] && v?.[1] && set({ from: fmt(v[0]), to: fmt(v[1]) })}
            />
          )}
          {'group' in meta && <Segmented aria-label="Group by" value={group} options={[{ value: 'month', label: 'By month' }, { value: 'year', label: 'By year' }]} onChange={(v) => set({ group: String(v) })} />}
        </Space>
      )}
      {report.error ? (
        <Alert type="error" showIcon message="Could not load this report" description={report.error} action={<Button onClick={report.reload}>Retry</Button>} />
      ) : !report.data || report.loading ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <ReportView data={report.data} />
      )}
    </>
  );
}

export default function ReportRoute() {
  // useSearchParams needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={null}>
      <ReportPage />
    </Suspense>
  );
}
