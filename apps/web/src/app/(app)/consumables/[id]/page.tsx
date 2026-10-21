'use client';

import { Button, Card, Descriptions, Dropdown, Space, Typography } from 'antd';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import type { ConsumableDetail, ConsumableMovementRow } from '@bme/shared';
import { ItemModal, MoveModal, StockPill, type MoveKind } from '@/components/ConsumableModals';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { RequirePermission } from '@/components/RequirePermission';
import { DetailPageSkeleton } from '@/components/Skeletons';
import { StatusResult } from '@/components/StatusResult';
import { useFetch } from '@/lib/api';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { COLORS } from '@/theme';

const KIND: Record<ConsumableMovementRow['kind'], string> = { in: 'Stock in', out: 'Given out', adjust: 'Count corrected' };

// Where it went or came from, in one line.
function Details({ m }: { m: ConsumableMovementRow }) {
  if (m.kind === 'in') return <span>{[m.supplierName, m.reference && `Invoice / PO ${m.reference}`].filter(Boolean).join(' · ') || '—'}</span>;
  if (m.kind === 'adjust') return <span>—</span>;
  return (
    <span>
      {m.departmentName}
      {m.asset && (
        <>
          {' · '}
          <Link href={`/assets/${m.asset.id}`} className="code">
            {m.asset.assetCode}
          </Link>
        </>
      )}
      {m.complaint && ` · ${m.complaint.complaintNo}`}
    </span>
  );
}

// One item: what is left, and every movement in or out, newest first. Nothing here can be edited; a wrong entry is
// put right with a stock count correction.
function ConsumableScreen() {
  const { id } = useParams<{ id: string }>();
  const item = useFetch<ConsumableDetail>(`/consumables/${id}`, { fresh: true });
  const [moving, setMoving] = useState<MoveKind | null>(null);
  const [editing, setEditing] = useState(false);

  if (item.error) return <StatusResult status="404" title="Item not found" extra={<Link href="/consumables"><Button>Back to consumables</Button></Link>} />;
  if (!item.data) return <DetailPageSkeleton kpis={4} />;
  const i = item.data;
  const done = () => {
    setMoving(null);
    void item.reload();
  };

  return (
    <>
      <PageHeader
        title={i.name}
        subtitle={`Counted in ${i.unit}`}
        crumbs={['Consumables', i.name]}
        meta={<StockPill item={i} />}
        action={
          <Space wrap>
            {i.active && (
              <>
                <Button onClick={() => setMoving('in')}>Stock in</Button>
                <Button type="primary" disabled={i.stock === 0} onClick={() => setMoving('issue')}>
                  Give out
                </Button>
              </>
            )}
            <Dropdown
              menu={{
                items: [
                  { key: 'adjust', label: 'Correct the stock count' },
                  { key: 'edit', label: 'Edit item' },
                ],
                onClick: ({ key }) => (key === 'edit' ? setEditing(true) : setMoving('adjust')),
              }}
            >
              <Button>More</Button>
            </Dropdown>
          </Space>
        }
      />
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card>
          <Descriptions
            column={{ xs: 2, md: 4 }}
            layout="vertical"
            colon={false}
            styles={{ label: { color: COLORS.muted, fontSize: 12.5, fontWeight: 500 }, content: { color: COLORS.ink, fontWeight: 600, fontSize: 15 } }}
          >
            <Descriptions.Item label="In stock">
              <span className="num">
                {i.stock} {i.unit}
              </span>
            </Descriptions.Item>
            <Descriptions.Item label="Reorder at">{i.reorderLevel ? `${i.reorderLevel} ${i.unit}` : 'No warning set'}</Descriptions.Item>
            <Descriptions.Item label="Unit cost">{i.unitCost == null ? '—' : formatMoney(i.unitCost)}</Descriptions.Item>
            <Descriptions.Item label="Stock value">{i.unitCost == null ? '—' : formatMoney(i.unitCost * i.stock)}</Descriptions.Item>
          </Descriptions>
          {i.notes && <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>{i.notes}</Typography.Paragraph>}
        </Card>
        <DataTable<ConsumableMovementRow>
          rows={i.movements}
          loading={false}
          error={null}
          onRetry={item.reload}
          emptyText="Nothing has moved yet. Record a stock in to start."
          columns={[
            { title: 'Date', dataIndex: 'date', className: 'm-title', render: (d: string, m) => `${formatDate(d)} · ${KIND[m.kind]}` },
            {
              title: 'Quantity',
              dataIndex: 'quantity',
              align: 'right',
              render: (q: number) => (
                <span className="num" style={{ fontWeight: 600, color: q < 0 ? COLORS.ink : COLORS.good.fg }}>
                  {q > 0 ? `+${q}` : `−${-q}`}
                </span>
              ),
            },
            { title: 'Left', dataIndex: 'stockAfter', align: 'right', className: 'm-hide', render: (n: number) => <span className="num">{n}</span> },
            { title: 'To / from', key: 'details', render: (_: unknown, m) => <Details m={m} /> },
            { title: 'Reason', dataIndex: 'reason', render: (r: string | null) => r ?? '—' },
            { title: 'By', dataIndex: 'byName', className: 'm-hide', render: (n: string, m) => <span title={formatDateTime(m.createdAt)}>{n}</span> },
          ]}
        />
      </Space>
      <MoveModal kind={moving} item={i} onClose={() => setMoving(null)} onDone={done} />
      <ItemModal
        open={editing}
        item={i}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          void item.reload();
        }}
      />
    </>
  );
}

export default function ConsumablePage() {
  return (
    <RequirePermission code="consumable.manage" what="see the consumables stock">
      <ConsumableScreen />
    </RequirePermission>
  );
}
