'use client';

import { PaperClipOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, DatePicker, Input, Segmented, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ComplaintRow, Paged } from '@bme/shared';
import { ComplaintDrawer } from '@/components/ComplaintDrawer';
import { DataTable } from '@/components/DataTable';
import { ExportMenu } from '@/components/ExportMenu';
import { Pill, StatusTag } from '@/components/StatusTag';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatDuration } from '@/lib/format';
import { COLORS } from '@/theme';

type StatusFilter = 'all' | ComplaintRow['status'];

// Every complaint, newest first, with filters; click a row for its whole story. The API applies the department
// scope, so a nurse only ever gets their own. With `assetId` it is one equipment's complaint history.
export function ComplaintsHistory({ assetId, reloadKey = 0, onChanged }: { assetId?: string; reloadKey?: number; onChanged?: () => void }) {
  const { user, can } = useAuth();
  const [search, setSearch] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [departmentId, setDepartmentId] = useState<string>();
  const [range, setRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ by?: 'raisedAt' | 'complaintNo' | 'status'; order: 'asc' | 'desc' }>({ order: 'desc' });

  useEffect(() => {
    const t = setTimeout(() => (setText(search), setPage(1)), 300);
    return () => clearTimeout(t);
  }, [search]);

  const departments = useFetch<{ id: string; name: string }[]>(!assetId && user?.role !== 'nursing' ? '/departments' : null);
  const qs = new URLSearchParams({
    page: String(page),
    pageSize: '20',
    ...(assetId && { assetId }),
    ...(status !== 'all' && { status }),
    ...(text && { search: text }),
    ...(departmentId && { departmentId }),
    ...(range?.[0] && { from: range[0].format('YYYY-MM-DD') }),
    ...(range?.[1] && { to: range[1].format('YYYY-MM-DD') }),
    ...(sort.by && { sortBy: sort.by, order: sort.order }),
  });
  // Export gives what is on screen. With no dates chosen it covers everything since the system began.
  const exportQuery = new URLSearchParams({
    from: range?.[0]?.format('YYYY-MM-DD') ?? '2000-01-01',
    to: range?.[1]?.format('YYYY-MM-DD') ?? dayjs().format('YYYY-MM-DD'),
    ...(text && { search: text }),
    ...(departmentId && { departmentId }),
    ...(status !== 'all' && { complaintStatus: status }),
  });
  const sortOf = (key: string) => (sort.by === key ? (sort.order === 'asc' ? ('ascend' as const) : ('descend' as const)) : null);
  const complaints = useFetch<Paged<ComplaintRow>>(`/complaints?${qs}&k=${reloadKey}`);
  const filtered = !!(text || departmentId || range?.[0] || range?.[1] || status !== 'all');

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: COLORS.faint }} />}
          placeholder="Search number, equipment or problem"
          aria-label="Search complaints"
          style={{ width: 300, maxWidth: '100%' }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {departments.data && (
          <Select allowClear placeholder="Department" aria-label="Department" style={{ minWidth: 190 }} value={departmentId} options={departments.data.map((d) => ({ value: d.id, label: d.name }))} onChange={(v) => (setDepartmentId(v), setPage(1))} />
        )}
        <DatePicker.RangePicker
          allowEmpty={[true, true]}
          format="DD MMM YYYY"
          aria-label="Raised between"
          placeholder={['Raised from', 'to']}
          value={range}
          onChange={(v) => (setRange(v), setPage(1))}
          disabledDate={(d) => d.isAfter(dayjs())}
        />
        {filtered && (
          <Button
            type="link"
            onClick={() => {
              setSearch('');
              setText('');
              setStatus('all');
              setDepartmentId(undefined);
              setRange(null);
              setPage(1);
            }}
          >
            Clear filters
          </Button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', maxWidth: '100%' }}>
          {can('report.view') && !assetId && <ExportMenu path={`/reports/breakdowns?${exportQuery}`} name="bme-complaints" />}
          <span style={{ color: COLORS.muted }}>{complaints.data ? `${complaints.data.total.toLocaleString('en-IN')} ${complaints.data.total === 1 ? 'complaint' : 'complaints'}` : ' '}</span>
          <Segmented
            aria-label="Status"
            value={status}
            options={[
              { value: 'all', label: 'All' },
              { value: 'open', label: 'Open' },
              { value: 'in_progress', label: 'In progress' },
              { value: 'resolved', label: 'Resolved' },
            ]}
            onChange={(v) => (setStatus(v as StatusFilter), setPage(1))}
          />
        </div>
      </div>
      <DataTable<ComplaintRow>
        rows={complaints.data?.items ?? null}
        loading={complaints.loading}
        error={complaints.error}
        onRetry={complaints.reload}
        emptyText={filtered ? 'No complaints match these filters.' : 'No complaints yet.'}
        pagination={{ current: page, pageSize: 20, total: complaints.data?.total ?? 0, showSizeChanger: false, hideOnSinglePage: true, onChange: setPage }}
        onChange={(_p, _f, sorter, extra) => {
          if (extra.action !== 'sort') return;
          const one = Array.isArray(sorter) ? sorter[0] : sorter;
          setSort(one?.order ? { by: String(one.columnKey) as 'raisedAt', order: one.order === 'ascend' ? 'asc' : 'desc' } : { order: 'desc' });
          setPage(1);
        }}
        onRow={(c) => ({
          className: 'row-link',
          onClick: (e) => {
            if (!(e.target as HTMLElement).closest('a,button')) setOpenId(c.id);
          },
        })}
        columns={[
          {
            title: 'No.',
            key: 'complaintNo',
            dataIndex: 'complaintNo',
            sorter: true,
            sortOrder: sortOf('complaintNo'),
            render: (n: string, c) => (
              <Button type="link" style={{ padding: 0, height: 'auto' }} className="code" onClick={() => setOpenId(c.id)}>
                {n}
              </Button>
            ),
          },
          ...(assetId
            ? []
            : [
                {
                  title: 'Equipment',
                  key: 'asset',
                  render: (_: unknown, c: ComplaintRow) => (
                    <div style={{ lineHeight: 1.35 }}>
                      <Link href={`/assets/${c.assetId}`} className="code">
                        {c.assetCode}
                      </Link>
                      <div style={{ color: COLORS.muted, fontSize: 12.5 }}>
                        {c.assetName} · {c.departmentName}
                      </div>
                    </div>
                  ),
                },
              ]),
          {
            title: 'Problem',
            dataIndex: 'description',
            render: (d: string, c) => (
              <div style={{ maxWidth: 360 }}>
                <Typography.Paragraph ellipsis={{ rows: 2, tooltip: d }} style={{ margin: 0 }}>
                  {d}
                </Typography.Paragraph>
                {c.attachmentCount > 0 && (
                  <span style={{ color: COLORS.muted, fontSize: 12.5 }} aria-label={`${c.attachmentCount} documents`}>
                    <PaperClipOutlined /> {c.attachmentCount}
                  </span>
                )}
              </div>
            ),
          },
          {
            title: 'Raised',
            key: 'raisedAt',
            dataIndex: 'raisedAt',
            sorter: true,
            sortOrder: sortOf('raisedAt'),
            render: (v: string, c) => (
              <div style={{ lineHeight: 1.35 }}>
                <div>{formatDateTime(v)}</div>
                <div style={{ color: COLORS.muted, fontSize: 12.5 }}>{c.raisedByName}</div>
              </div>
            ),
          },
          {
            title: 'Status',
            key: 'status',
            dataIndex: 'status',
            sorter: true,
            sortOrder: sortOf('status'),
            render: (s: ComplaintRow['status'], c) => (
              <div style={{ display: 'grid', gap: 4, justifyItems: 'start' }}>
                <StatusTag status={s} />
                {c.overDowntimeLimit && <Pill tone="bad">Over downtime limit</Pill>}
              </div>
            ),
          },
          { title: 'Response', dataIndex: 'responseSeconds', align: 'right', render: formatDuration },
          { title: 'Downtime', dataIndex: 'downtimeSeconds', align: 'right', render: formatDuration },
        ]}
      />
      <ComplaintDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => (complaints.reload(), onChanged?.())} />
    </>
  );
}
