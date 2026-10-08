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
import { useAuth } from '@/lib/auth';
import { addDaysISO, endOfMonthISO, formatDate, todayIST } from '@/lib/format';
import { StatusResult } from '@/components/StatusResult';

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
  const until = untilFor(range);
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
            render: (_: unknown, r) => (
              <Link href={`/assets/${r.assetId}?tab=${kind}`}>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{r.assetCode}</span>
                <div style={{ color: '#526173', fontSize: 12 }}>{r.assetName}</div>
              </Link>
            ),
          },
          { title: 'Type', dataIndex: 'equipmentTypeName' },
          { title: 'Location', key: 'loc', render: (_: unknown, r) => `${r.departmentName} · ${r.locationName}` },
          { title: 'Criticality', dataIndex: 'criticality', render: (v: string) => <CriticalityTag value={v} /> },
          { title: 'Due', dataIndex: 'dueDate', render: formatDate },
          { title: 'Status', dataIndex: 'daysLeft', render: (d: number) => <DueText daysLeft={d} /> },
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
      <Space style={{ marginBottom: 16 }}>
        <Select aria-label="Period" style={{ minWidth: 260 }} value={range} options={RANGES} onChange={setRange} />
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
