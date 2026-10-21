'use client';

import { Button, Input, Segmented, Space, Typography } from 'antd';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { ConsumableRow } from '@bme/shared';
import { ItemModal, MoveModal, StockPill, type MoveKind } from '@/components/ConsumableModals';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { RequirePermission } from '@/components/RequirePermission';
import { useFetch } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';

// Consumables (decision F): what is in stock, what is low, and the three things people do with an item.
function ConsumablesScreen() {
  const router = useRouter();
  const lowFirst = useSearchParams().get('low') === 'true';
  const items = useFetch<ConsumableRow[]>('/consumables');
  const [view, setView] = useState<'all' | 'low'>(lowFirst ? 'low' : 'all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ConsumableRow | 'new' | null>(null);
  const [moving, setMoving] = useState<{ kind: MoveKind; item: ConsumableRow | null } | null>(null);

  const q = search.trim().toLowerCase();
  const lowCount = items.data?.filter((i) => i.active && i.low).length ?? 0;
  const rows =
    items.data?.filter((i) => (view === 'low' ? i.active && i.low : i.active || q) && (!q || i.name.toLowerCase().includes(q))) ?? null;
  const done = () => {
    setMoving(null);
    void items.reload();
  };

  return (
    <>
      <PageHeader
        title="Consumables"
        subtitle="Stock of probes, leads, batteries and other items given out to departments"
        action={
          <Space wrap>
            <Link href="/reports/consumables">
              <Button>Register</Button>
            </Link>
            <Button onClick={() => setMoving({ kind: 'issue', item: null })}>Give out</Button>
            <Button type="primary" onClick={() => setEditing('new')}>
              Add item
            </Button>
          </Space>
        }
      />
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented
          aria-label="Show"
          value={view}
          onChange={(v) => setView(v as 'all' | 'low')}
          options={[
            { value: 'all', label: 'In use' },
            { value: 'low', label: `Low stock${lowCount ? ` (${lowCount})` : ''}` },
          ]}
        />
        <Input.Search allowClear placeholder="Search items" aria-label="Search items" style={{ width: 260 }} onChange={(e) => setSearch(e.target.value)} />
      </Space>
      <DataTable<ConsumableRow>
        rows={rows}
        loading={items.loading}
        error={items.error}
        onRetry={items.reload}
        emptyText={view === 'low' ? 'Nothing is low on stock.' : q ? 'No item matches that.' : 'No items yet. Add the first one.'}
        onRow={(row) => ({
          className: 'row-link',
          onClick: (e) => {
            if (!(e.target as HTMLElement).closest('a,button,.ant-dropdown')) router.push(`/consumables/${row.id}`);
          },
        })}
        columns={[
          {
            title: 'Item',
            dataIndex: 'name',
            className: 'm-title',
            render: (name: string, r) => (
              <Link href={`/consumables/${r.id}`} style={{ fontWeight: 600 }}>
                {name}
              </Link>
            ),
          },
          {
            title: 'In stock',
            dataIndex: 'stock',
            align: 'right',
            render: (n: number, r) => (
              <Space size={8}>
                <span className="num" style={{ fontWeight: 600 }}>
                  {n} {r.unit}
                </span>
                <StockPill item={r} />
              </Space>
            ),
          },
          { title: 'Reorder at', dataIndex: 'reorderLevel', align: 'right', className: 'm-hide', render: (n: number) => (n ? n : '—') },
          { title: 'Unit cost', dataIndex: 'unitCost', align: 'right', className: 'm-hide', render: (v: number | null) => (v == null ? '—' : formatMoney(v)) },
          { title: 'Last given', dataIndex: 'lastIssuedOn', className: 'm-hide', render: (d: string | null) => (d ? formatDate(d) : <Typography.Text type="secondary">Never</Typography.Text>) },
          {
            title: <span className="sr-only">Actions</span>,
            key: 'actions',
            align: 'right',
            className: 'm-end',
            render: (_: unknown, r) =>
              r.active && (
                <Space size={4}>
                  <Button size="small" onClick={() => setMoving({ kind: 'in', item: r })}>
                    Stock in
                  </Button>
                  <Button size="small" disabled={r.stock === 0} onClick={() => setMoving({ kind: 'issue', item: r })}>
                    Give out
                  </Button>
                </Space>
              ),
          },
        ]}
      />
      <ItemModal
        open={editing !== null}
        item={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(row) => {
          setEditing(null);
          router.push(`/consumables/${row.id}`);
        }}
      />
      <MoveModal kind={moving?.kind ?? null} item={moving?.item ?? null} onClose={() => setMoving(null)} onDone={done} />
    </>
  );
}

export default function ConsumablesPage() {
  return (
    <RequirePermission code="consumable.manage" what="see the consumables stock">
      <Suspense fallback={null}>
        <ConsumablesScreen />
      </Suspense>
    </RequirePermission>
  );
}
