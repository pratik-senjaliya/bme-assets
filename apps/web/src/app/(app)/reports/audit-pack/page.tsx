'use client';

import { DownloadOutlined } from '@ant-design/icons';
import { Segmented, Alert, Button, Card, DatePicker, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { auditPackQuerySchema, type AuditPackSummary } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { KpiSkeleton } from '@/components/Skeletons';
import { StatusResult } from '@/components/StatusResult';
import { useFetch } from '@/lib/api';
import { REGISTER_OPTIONS, useAuth, useTwoTeams } from '@/lib/auth';
import { COLORS } from '@/theme';
import { hospitalToday } from '@/lib/format';

type Option = { id: string; name: string };
const fmt = (d: dayjs.Dayjs) => d.format('YYYY-MM-DD');
// Indian financial year: 1 April to 31 March.
const fyStart = (d: dayjs.Dayjs) => (d.month() >= 3 ? d.month(3).date(1) : d.subtract(1, 'year').month(3).date(1));

const CONTENTS: { key: keyof AuditPackSummary; label: string }[] = [
  { key: 'assets', label: 'Equipment in the inventory' },
  { key: 'pmsRecords', label: 'PMS checklists' },
  { key: 'calibrations', label: 'Calibrations' },
  { key: 'oemReports', label: 'OEM PMS reports' },
  { key: 'certificates', label: 'Calibration certificates' },
  { key: 'complaints', label: 'Breakdowns' },
  { key: 'condemnations', label: 'Equipment condemned' },
  { key: 'documents', label: 'Condemnation letters' },
  { key: 'licences', label: 'Licence documents' }, // facility add-on: shown only when there are any
];

// Everything an NABH or internal auditor asks for, for one period, in one ZIP: the inventory, the PMS and
// calibration records with their checklists and certificates, breakdowns and downtime, cover, age and condemnations.
function AuditPackPage() {
  const { can, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const today = hospitalToday();
  const from = params.get('from') ?? fmt(fyStart(today).subtract(1, 'year'));
  const to = params.get('to') ?? fmt(fyStart(today).subtract(1, 'day'));
  const departmentId = params.get('departmentId') ?? '';
  const twoTeams = useTwoTeams();
  const register = twoTeams && (params.get('register') === 'biomedical' || params.get('register') === 'facility') ? (params.get('register') as 'biomedical' | 'facility') : undefined;
  const allowed = can('report.view');
  const wholeHospital = user?.role !== 'nursing';
  const q = auditPackQuerySchema.safeParse({ from, to, ...(departmentId ? { departmentId } : {}), ...(register && { register }) });
  const query = q.success ? new URLSearchParams({ from: q.data.from, to: q.data.to, ...(q.data.departmentId ? { departmentId: q.data.departmentId } : {}), ...(q.data.register ? { register: q.data.register } : {}) }) : null;
  const summary = useFetch<AuditPackSummary>(allowed && query ? `/reports/audit-pack/summary?${query}` : null, { fresh: true });
  const departments = useFetch<Option[]>(allowed && wholeHospital ? '/departments' : null);

  if (!allowed) return <StatusResult status="403" title="You cannot see reports" />;
  const set = (next: Record<string, string>) => {
    const p = new URLSearchParams({ from, to, departmentId, register: register ?? '', ...next });
    if (!p.get('departmentId')) p.delete('departmentId');
    if (!p.get('register')) p.delete('register');
    router.replace(`${pathname}?${p}`);
  };
  const problem = q.success ? summary.error : q.error.issues[0]?.message;

  return (
    <>
      <PageHeader
        title="Audit pack"
        subtitle="Everything an auditor asks for, for one period, in one ZIP file: inventory, PMS checklists, calibration certificates, breakdowns, downtime, cover and condemnations."
        crumbs={['Reports', 'Audit pack']}
      />
      <Space wrap size={16} style={{ marginBottom: 20 }}>
        <DatePicker.RangePicker
          allowClear={false}
          format="DD MMM YYYY"
          aria-label="Period"
          value={[dayjs(from), dayjs(to)]}
          disabledDate={(d) => d.isAfter(today, 'day')}
          presets={[
            { label: 'Last financial year', value: [fyStart(today).subtract(1, 'year'), fyStart(today).subtract(1, 'day')] },
            { label: 'This financial year', value: [fyStart(today), today] },
            { label: 'Last 12 months', value: [today.subtract(12, 'month'), today] },
            { label: 'Last 3 months', value: [today.subtract(3, 'month'), today] },
          ]}
          onChange={(v) => v?.[0] && v?.[1] && set({ from: fmt(v[0]), to: fmt(v[1]) })}
        />
        {wholeHospital && (
          <Select
            aria-label="Department"
            style={{ minWidth: 220 }}
            value={departmentId}
            loading={departments.loading}
            options={[{ value: '', label: 'Whole hospital' }, ...(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))]}
            onChange={(v) => set({ departmentId: v })}
          />
        )}
        {twoTeams && <Segmented aria-label="Equipment" value={register ?? ''} onChange={(v) => set({ register: String(v) })} options={[{ value: '', label: 'All equipment' }, ...REGISTER_OPTIONS]} />}
      </Space>
      {problem ? (
        <Alert type="error" showIcon message="Cannot make this pack" description={problem} />
      ) : (
        <Card styles={{ body: { padding: 20 } }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: COLORS.ink, margin: '0 0 4px' }}>
            {dayjs(from).format('DD MMM YYYY')} to {dayjs(to).format('DD MMM YYYY')}
            {departmentId ? ` · ${departments.data?.find((d) => d.id === departmentId)?.name ?? ''}` : wholeHospital ? ' · Whole hospital' : ''}
          </h2>
          <p style={{ color: COLORS.muted, margin: '0 0 16px' }}>The pack will hold:</p>
          {!summary.data ? (
            <KpiSkeleton count={4} />
          ) : (
            <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))', gap: '12px 24px', margin: '0 0 20px' }}>
              {CONTENTS.filter((c) => c.key !== 'licences' || summary.data?.licences).map((c) => (
                <div key={c.key}>
                  <dt style={{ color: COLORS.muted, fontSize: 13 }}>{c.label}</dt>
                  <dd style={{ margin: 0, fontSize: 20, fontWeight: 700, color: COLORS.ink }}>{summary.data![c.key].toLocaleString('en-IN')}</dd>
                </div>
              ))}
            </dl>
          )}
          {/* A plain link: the server streams the ZIP straight to disk, so a large pack never sits in the browser's memory. */}
          <Button type="primary" icon={<DownloadOutlined />} href={`/api/v1/reports/audit-pack?${query}`} download disabled={!summary.data}>
            Download audit pack (.zip)
          </Button>
          <p style={{ color: COLORS.muted, fontSize: 12.5, margin: '12px 0 0' }}>
            A large pack can take a minute to start. The download is recorded in the audit log. Files that could not be found are listed in the pack&apos;s index.
          </p>
        </Card>
      )}
    </>
  );
}

export default function AuditPackRoute() {
  return (
    <Suspense fallback={null}>
      <AuditPackPage />
    </Suspense>
  );
}
