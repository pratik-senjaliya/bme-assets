'use client';

import { Alert, Button, DatePicker, Segmented, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { monthSchema, type ReportData, type SavedMonthlyReport } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { ExportMenu } from '@/components/ExportMenu';
import { ReportView } from '@/components/ReportView';
import { useFetch } from '@/lib/api';
import { REGISTER_OPTIONS, useAuth, useTwoTeams } from '@/lib/auth';
import { formatDate, hospitalToday, todayIST } from '@/lib/format';
import { StatusResult } from '@/components/StatusResult';
import { DashboardSkeleton } from '@/components/Skeletons';

const monthLabel = (m: string) => dayjs(`${m}-01`).format('MMMM YYYY');

// The month in one page for the HOD and management. Saved on the 1st for the month before; that saved copy is what
// opens here (and what was emailed), so it never changes afterwards. Other months are made from the records now.
function MonthlyPage() {
  const { can, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const lastMonth = hospitalToday().subtract(1, 'month').format('YYYY-MM');
  const asked = params.get('month');
  const month = asked && monthSchema.safeParse(asked).success && asked <= todayIST().slice(0, 7) ? asked : lastMonth;
  const allowed = can('report.view');
  // One team's equipment, for people who see both (then it is made from the records, not the saved copy).
  const twoTeams = useTwoTeams();
  const register = twoTeams && (params.get('register') === 'biomedical' || params.get('register') === 'facility') ? params.get('register')! : '';
  const path = `/reports/monthly?month=${month}${register ? `&register=${register}` : ''}`;
  const report = useFetch<ReportData>(allowed ? `${path}&format=json` : null);
  const saved = useFetch<SavedMonthlyReport[]>(allowed && user?.role !== 'nursing' ? '/reports/monthly/saved' : null);

  if (!allowed) return <StatusResult status="403" title="You cannot see reports" />;
  const set = (m: string, r = register) => router.replace(`${pathname}?month=${m}${r ? `&register=${r}` : ''}`);

  return (
    <>
      <PageHeader
        title="Monthly report"
        subtitle="Uptime, breakdowns, PMS and calibration, spend and what needs attention, for one month. Saved and sent to the HOD on the 1st."
        crumbs={['Reports', 'Monthly report']}
        action={<ExportMenu path={path} name={`bme-monthly-report-${month}${register ? `-${register}` : ''}`} />}
      />
      <Space wrap size={16} style={{ marginBottom: 20 }}>
        <DatePicker
          picker="month"
          allowClear={false}
          format="MMMM YYYY"
          aria-label="Month"
          style={{ width: 190 }}
          value={dayjs(`${month}-01`)}
          disabledDate={(d) => d.isAfter(hospitalToday(), 'month') || d.isBefore(dayjs('2000-01-01'))}
          onChange={(d) => d && set(d.format('YYYY-MM'))}
        />
        {twoTeams && <Segmented aria-label="Equipment" value={register} onChange={(v) => set(month, String(v))} options={[{ value: '', label: 'All equipment' }, ...REGISTER_OPTIONS]} />}
        {!!saved.data?.length && !register && (
          <Select
            aria-label="Reports sent on the 1st"
            placeholder={`Reports sent (${saved.data.length})`}
            style={{ minWidth: 200 }}
            value={null}
            popupMatchSelectWidth={false}
            options={saved.data.map((s) => ({ value: s.month, label: `${monthLabel(s.month)} · sent ${formatDate(s.savedAt)}` }))}
            onChange={(m: string) => set(m)}
          />
        )}
      </Space>
      {report.error ? (
        <Alert type="error" showIcon message="Could not load this report" description={report.error} action={<Button onClick={report.reload}>Retry</Button>} />
      ) : !report.data || report.loading ? (
        <DashboardSkeleton header={false} kpis={8} />
      ) : (
        <ReportView data={report.data} />
      )}
    </>
  );
}

export default function MonthlyRoute() {
  return (
    <Suspense fallback={null}>
      <MonthlyPage />
    </Suspense>
  );
}
