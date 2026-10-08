'use client';

import { DownloadOutlined } from '@ant-design/icons';
import { App, Button, Card, DatePicker, Result, Segmented, Space, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { REPORTS, type ReportType } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { useAuth } from '@/lib/auth';
import { downloadFile } from '@/lib/download';

type Report = (typeof REPORTS)[number];

function ReportCard({ report }: { report: Report }) {
  const { message } = App.useApp();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(12, 'month').add(1, 'day'), dayjs()]);
  const [group, setGroup] = useState<'month' | 'year'>('month');
  const [busy, setBusy] = useState(false);

  async function download() {
    const q = new URLSearchParams();
    if (report.range) {
      q.set('from', range[0].format('YYYY-MM-DD'));
      q.set('to', range[1].format('YYYY-MM-DD'));
    }
    if ('group' in report) q.set('group', group);
    setBusy(true);
    try {
      await downloadFile(`/reports/${report.type}?${q}`, `${report.type}.xlsx`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not download the report');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="small" title={report.title} style={{ height: '100%' }}>
      <Typography.Paragraph type="secondary" style={{ minHeight: 66 }}>
        {report.description}
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        {report.range && (
          <DatePicker.RangePicker
            aria-label={`Period for ${report.title}`}
            allowClear={false}
            format="DD MMM YYYY"
            value={range}
            onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])}
            disabledDate={(d) => d.isAfter(dayjs(), 'day')}
          />
        )}
        {'group' in report && (
          <Segmented aria-label="Summarise by" value={group} onChange={(v) => setGroup(v as 'month' | 'year')} options={[{ label: 'By month', value: 'month' }, { label: 'By year', value: 'year' }]} />
        )}
      </Space>
      <div>
        <Button icon={<DownloadOutlined />} loading={busy} onClick={download}>
          Download Excel
        </Button>
      </div>
    </Card>
  );
}

export default function ReportsPage() {
  const { can } = useAuth();
  if (!can('report.view')) return <Result status="403" title="You cannot see reports" />;
  return (
    <>
      <PageHeader title="Reports" subtitle="Excel downloads. Condemned and not-in-use equipment are included and labelled." crumbs={['Reports']} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
        {REPORTS.map((r) => (
          <ReportCard key={r.type satisfies ReportType} report={r} />
        ))}
      </div>
    </>
  );
}
