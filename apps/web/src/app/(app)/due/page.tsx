'use client';

import { Button, Select, Space, Tabs } from 'antd';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { DueRow } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { CriticalityTag, DueText } from '@/components/StatusTag';
import { useFetch } from '@/lib/api';
import { REGISTER_OPTIONS, useAuth, useTwoTeams } from '@/lib/auth';
import { addDaysISO, endOfMonthISO, formatDate, todayIST } from '@/lib/format';
import { StatusResult } from '@/components/StatusResult';
import { COLORS } from '@/theme';

type Range = 'overdue' | 'month' | '30' | '60' | '90';
const RANGES: { value: Range; label: string }[] = [
  { value: 'overdue', label: 'Overdue only' },
  { value: 'month', label: 'Due this month and overdue' },
  { value: '30', label: 'Next 30 days and overdue' },
  { value: '60', label: 'Next 60 days and overdue' },
  { value: '90', label: 'Next 90 days and overdue' },
];

// The picker only chooses the cut-off date. Which items are due, and how many days are left, come from the server.
const untilFor = (r: Range) => {
  const today = todayIST();
  return r === 'overdue' ? addDaysISO(today, -1) : r === 'month' ? endOfMonthISO(today) : addDaysISO(today, Number(r));
};

function DueList() {
  const { can } = useAuth();
  const asked = useSearchParams().get('range');
  const [range, setRange] = useState<Range>(RANGES.some((r) => r.value === asked) ? (asked as Range) : 'month');
  const [tab, setTab] = useState<'pms' | 'calibration'>('pms');
  const twoTeams = useTwoTeams();
  const [register, setRegister] = useState<string>();
  const until = `${untilFor(range)}${register ? `&register=${register}` : ''}`;
  const pms = useFetch<DueRow[]>(can('pms.perform') ? `/pms/due?until=${until}` : null);
  const calibration = useFetch<DueRow[]>(can('calibration.manage') ? `/calibration/due?until=${until}` : null);

  const table = (kind: 'pms' | 'calibration') => {
    const list = kind === 'pms' ? pms : calibration;
    return (
      <DataTable<DueRow & { id: string }>
        rows={list.data?.map((r) => ({ ...r, id: r.assetId })) ?? null}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        emptyText={range === 'overdue' ? 'Nothing is overdue.' : 'Nothing is due in this period.'}
        columns={[
          {
            title: 'Asset',
            key: 'asset',
            className: 'm-title',
            render: (_: unknown, r) => (
              <Link href={`/assets/${r.assetId}?tab=${kind}`}>
                <span className="code">{r.assetCode}</span>
                <div style={{ color: COLORS.muted, fontSize: 12.5 }}>{r.assetName}</div>
              </Link>
            ),
          },
          { title: 'Type', dataIndex: 'equipmentTypeName', className: 'm-hide' },
          { title: 'Location', key: 'loc', render: (_: unknown, r) => `${r.departmentName} · ${r.locationName}` },
          { title: 'Criticality', dataIndex: 'criticality', className: 'm-hide', render: (v: string) => <CriticalityTag value={v} /> },
          { title: 'Due', dataIndex: 'dueDate', render: formatDate },
          { title: 'Status', dataIndex: 'daysLeft', className: 'm-end', render: (d: number) => <DueText daysLeft={d} /> },
          {
            title: <span className="sr-only">Actions</span>,
            key: 'action',
            align: 'right',
            render: (_: unknown, r) =>
              kind === 'pms' ? (
                <Link href={`/assets/${r.assetId}/pms/new`}>
                  <Button size="small">Perform PMS</Button>
                </Link>
              ) : (
                <Link href={`/assets/${r.assetId}?tab=calibration`}>
                  <Button size="small">Record calibration</Button>
                </Link>
              ),
          },
        ]}
      />
    );
  };

  if (!can('pms.perform') && !can('calibration.manage')) return <StatusResult status="403" title="You cannot see due lists" />;

  const items = [
    ...(can('pms.perform') ? [{ key: 'pms', label: `PMS${pms.data ? ` (${pms.data.length})` : ''}`, children: table('pms') }] : []),
    ...(can('calibration.manage') ? [{ key: 'calibration', label: `Calibration${calibration.data ? ` (${calibration.data.length})` : ''}`, children: table('calibration') }] : []),
  ];

  return (
    <>
      <PageHeader title="Due & overdue" subtitle="Equipment in active use that needs PMS or calibration, soonest first" crumbs={['Due & overdue']} />
      <Space style={{ marginBottom: 20 }} wrap>
        <span style={{ color: COLORS.muted, fontWeight: 600, fontSize: 13 }}>Period</span>
        <Select aria-label="Period" style={{ minWidth: 280 }} value={range} options={RANGES} onChange={setRange} />
        {twoTeams && <Select allowClear aria-label="Equipment" placeholder="All equipment" style={{ minWidth: 180 }} value={register} options={REGISTER_OPTIONS} onChange={setRegister} />}
      </Space>
      <Tabs activeKey={tab} onChange={(k) => setTab(k as 'pms' | 'calibration')} items={items} />
    </>
  );
}

export default function DuePage() {
  // useSearchParams needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={null}>
      <DueList />
    </Suspense>
  );
}
