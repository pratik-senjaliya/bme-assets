'use client';

import { Button, DatePicker, Input, Result, Select, Space, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AuditRow, Paged } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';

const ENTITY_TYPES = [
  'asset', 'complaint', 'pms_record', 'pms_template', 'calibration_record', 'approval_request', 'purchase_order', 'service_contract', 'service_expense', 'attachment',
  'user', 'role', 'department', 'location', 'equipment_type', 'hospital_settings', 'report', 'notification',
];

const Json = ({ value }: { value: unknown }) => (
  <pre style={{ margin: 0, padding: 8, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 6, fontSize: 12, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
    {value == null ? '—' : JSON.stringify(value, null, 2)}
  </pre>
);

export default function AuditPage() {
  const { can } = useAuth();
  const [entityType, setEntityType] = useState<string>();
  const [actorId, setActorId] = useState<string>();
  const [action, setAction] = useState('');
  const [typed, setTyped] = useState('');
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [page, setPage] = useState(1);
  const actors = useFetch<{ id: string; name: string }[]>(can('audit.view') ? '/audit-logs/actors' : null);

  // Debounce the free-text filter.
  useEffect(() => {
    const t = setTimeout(() => {
      setAction(typed);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  const q = new URLSearchParams({ page: String(page), pageSize: '50' });
  if (entityType) q.set('entityType', entityType);
  if (actorId) q.set('actorId', actorId);
  if (action) q.set('action', action);
  if (range?.[0]) q.set('from', range[0].format('YYYY-MM-DD'));
  if (range?.[1]) q.set('to', range[1].format('YYYY-MM-DD'));
  const log = useFetch<Paged<AuditRow>>(can('audit.view') ? `/audit-logs?${q}` : null);

  if (!can('audit.view')) return <Result status="403" title="You cannot see the audit log" />;
  const filtered = !!(entityType || actorId || action || range);
  const reset = (fn: () => void) => () => {
    fn();
    setPage(1);
  };

  return (
    <>
      <PageHeader title="Audit log" subtitle="Every create, change, delete, approval and sign-in. It cannot be edited or deleted." crumbs={['Admin', 'Audit log']} />
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search allowClear placeholder="Action, e.g. asset.update" aria-label="Action contains" style={{ width: 240 }} value={typed} onChange={(e) => setTyped(e.target.value)} />
        <Select allowClear showSearch placeholder="Record type" aria-label="Record type" style={{ width: 190 }} value={entityType} options={ENTITY_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))} onChange={(v) => { setEntityType(v); setPage(1); }} />
        <Select allowClear showSearch optionFilterProp="label" placeholder="Who" aria-label="Who" style={{ width: 190 }} value={actorId} options={(actors.data ?? []).map((a) => ({ value: a.id, label: a.name }))} onChange={(v) => { setActorId(v); setPage(1); }} />
        <DatePicker.RangePicker aria-label="Period" format="DD MMM YYYY" value={range} onChange={(v) => { setRange(v); setPage(1); }} />
        {filtered && (
          <Button type="link" onClick={reset(() => { setEntityType(undefined); setActorId(undefined); setTyped(''); setAction(''); setRange(null); })}>
            Clear
          </Button>
        )}
      </Space>
      <DataTable<AuditRow>
        rows={log.data?.items ?? null}
        loading={log.loading}
        error={log.error}
        onRetry={log.reload}
        emptyText="Nothing matches these filters."
        pagination={{ current: page, pageSize: 50, total: log.data?.total ?? 0, showSizeChanger: false, hideOnSinglePage: true, onChange: setPage, showTotal: (t) => `${t.toLocaleString('en-IN')} entries` }}
        expandable={{
          expandedRowRender: (r) => (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
              <div>
                <Typography.Text type="secondary">Before</Typography.Text>
                <Json value={r.before} />
              </div>
              <div>
                <Typography.Text type="secondary">After</Typography.Text>
                <Json value={r.after} />
              </div>
            </div>
          ),
          rowExpandable: (r) => r.before != null || r.after != null,
        }}
        columns={[
          { title: 'When', dataIndex: 'at', render: formatDateTime, width: 170 },
          { title: 'Who', dataIndex: 'actorName', render: (n: string | null) => n ?? <Typography.Text type="secondary">Not signed in</Typography.Text> },
          { title: 'Action', dataIndex: 'action', render: (a: string) => <Tag style={{ fontFamily: 'ui-monospace, monospace' }}>{a}</Tag> },
          {
            title: 'Record',
            key: 'entity',
            render: (_: unknown, r) => (
              <span>
                {r.entityType.replace(/_/g, ' ')}
                {r.entityId && (
                  <span style={{ color: '#6B7280', fontSize: 12 }}>
                    {' · '}
                    {r.entityType === 'asset' ? <Link href={`/assets/${r.entityId}`}>{r.entityId.slice(0, 8)}</Link> : r.entityId.slice(0, 8)}
                  </span>
                )}
              </span>
            ),
          },
          { title: 'From', dataIndex: 'ip', render: (ip: string | null) => ip ?? '—' },
        ]}
      />
    </>
  );
}
