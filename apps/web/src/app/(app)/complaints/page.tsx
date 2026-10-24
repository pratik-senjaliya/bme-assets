'use client';

import { CheckCircleOutlined } from '@ant-design/icons';
import { Button, Card, Col, Row, Segmented, Space, Tabs, Typography } from 'antd';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import type { ComplaintRow, Paged } from '@bme/shared';
import { CardSkeleton, ComplaintCard, ToClose, useComplaintWork } from '@/components/ComplaintWork';
import { PageHeader } from '@/components/PageHeader';
import { TradeFilter } from '@/components/TradeFilter';
import { EmptyState } from '@/components/Skeletons';
import { api, useFetch } from '@/lib/api';
import { REGISTER_OPTIONS, useAuth, useTwoTeams } from '@/lib/auth';
import { COLORS } from '@/theme';

// The history tab, the details drawer and the raise dialog load when first opened, so the board shows sooner.
const ComplaintDrawer = dynamic(() => import('@/components/ComplaintDrawer').then((m) => m.ComplaintDrawer));
const ComplaintsHistory = dynamic(() => import('@/components/ComplaintsHistory').then((m) => m.ComplaintsHistory));
const RaiseComplaintModal = dynamic(() => import('@/components/RaiseComplaintModal').then((m) => m.RaiseComplaintModal));

// "done" = resolved (waiting for whoever raised it to close) and closed, latest first.
type Column = 'open' | 'in_progress' | 'on_hold' | 'done';
const COLUMNS: { status: Column; title: string; empty: string }[] = [
  { status: 'open', title: 'Open', empty: 'Nothing waiting.' },
  { status: 'in_progress', title: 'In progress', empty: 'Nothing being worked on.' },
  { status: 'on_hold', title: 'On hold', empty: 'Nothing on hold.' },
  { status: 'done', title: 'Recently resolved', empty: 'No resolved complaints yet.' },
];

// A bell notice links here with ?open=<complaint>: open its details (also when already on this page).
function OpenFromAddress({ onOpen }: { onOpen: (id: string) => void }) {
  const open = useSearchParams().get('open');
  useEffect(() => {
    if (open) onOpen(open);
  }, [open, onOpen]);
  return null;
}

export default function ComplaintsPage() {
  const { can } = useAuth();
  const [raising, setRaising] = useState(false);
  const [version, setVersion] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const canWork = can('complaint.start') || can('complaint.resolve');

  return (
    <>
      <PageHeader
        title="Complaints"
        subtitle={canWork ? 'Breakdowns and faults, longest waiting first' : 'Complaints for your department'}
        crumbs={['Complaints']}
        action={can('complaint.create') && <Button type="primary" onClick={() => setRaising(true)}>Raise complaint</Button>}
      />
      <ToClose version={version} onChanged={() => setVersion((v) => v + 1)} onOpen={setOpenId} />
      {canWork ? (
        <Tabs
          defaultActiveKey="board"
          items={[
            { key: 'board', label: 'Board', children: <Board version={version} onChanged={() => setVersion((v) => v + 1)} onOpen={setOpenId} /> },
            { key: 'history', label: 'History', children: <ComplaintsHistory reloadKey={version} onChanged={() => setVersion((v) => v + 1)} /> },
          ]}
        />
      ) : (
        <ComplaintsHistory reloadKey={version} />
      )}
      <Suspense fallback={null}>
        <OpenFromAddress onOpen={setOpenId} />
      </Suspense>
      <ComplaintDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => setVersion((v) => v + 1)} />
      <RaiseComplaintModal open={raising} onClose={() => setRaising(false)} onRaised={() => setVersion((v) => v + 1)} />
    </>
  );
}

function Board({ version, onChanged, onOpen }: { version: number; onChanged: () => void; onOpen: (id: string) => void }) {
  const { actions, dialogs } = useComplaintWork(onChanged);
  // Someone who sees both teams' complaints (the HOD) can look at one team's board.
  const twoTeams = useTwoTeams();
  const [register, setRegister] = useState('');
  const [tradeId, setTradeId] = useState<string>();
  // The board is watched for a while: refresh it every minute (new complaints, waiting times), but not while the
  // tab is hidden.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1);
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <Space wrap size={12} style={{ marginBottom: 14 }}>
        {twoTeams && (
          <Segmented
            aria-label="Equipment"
            value={register}
            options={[{ value: '', label: 'All equipment' }, ...REGISTER_OPTIONS]}
            onChange={(v) => (setRegister(String(v)), setTradeId(undefined))}
          />
        )}
        <TradeFilter value={tradeId} onChange={setTradeId} register={register || undefined} />
      </Space>
      <Row gutter={16}>
        {COLUMNS.map((col) => (
          <Col key={col.status} xs={24} md={12} xl={6}>
            <BoardColumn {...col} register={register} tradeId={tradeId} version={version * 10_000 + tick} onOpen={onOpen} actions={actions} />
          </Col>
        ))}
      </Row>
      {dialogs}
    </>
  );
}

const DOT: Record<Column, string> = { open: COLORS.bad.dot, in_progress: COLORS.warn.dot, on_hold: COLORS.info.dot, done: COLORS.good.dot };

function BoardColumn({
  status,
  title,
  empty,
  register,
  tradeId,
  version,
  onOpen,
  actions,
}: {
  status: Column;
  title: string;
  empty: string;
  register: string;
  tradeId?: string;
  version: number;
  onOpen: (id: string) => void;
  actions: (c: ComplaintRow) => ReactNode;
}) {
  const team = `${register ? `&register=${register}` : ''}${tradeId ? `&tradeId=${tradeId}` : ''}`;
  const list = useFetch<Paged<ComplaintRow>>(`/complaints?status=${status}${team}&pageSize=${status === 'done' ? 10 : 50}&k=${version}`);
  // Open and in-progress columns show 50 at a time; "Show more" loads the next 50, so every complaint can be worked on.
  const [more, setMore] = useState<ComplaintRow[]>([]);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setMore([]);
    setPage(1);
  }, [version]);
  const first = list.data?.items ?? [];
  const shown = [...first, ...more.filter((m) => !first.some((f) => f.id === m.id))];
  const total = list.data?.total ?? 0;
  async function showMore() {
    setLoadingMore(true);
    try {
      const next = await api<Paged<ComplaintRow>>(`/complaints?status=${status}${team}&pageSize=50&page=${page + 1}&k=${version}`);
      setMore((m) => [...m, ...next.items]);
      setPage((p) => p + 1);
    } finally {
      setLoadingMore(false);
    }
  }
  return (
    <Card
      size="small"
      title={
        <Space size={10}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: DOT[status], display: 'inline-block' }} />
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>{title}</span>
          {/* Resolved shows the latest few, so its badge says so instead of an all-time total. */}
          <span className="num" style={{ color: COLORS.muted, fontWeight: 600, fontSize: 12.5, background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 4, padding: '0 7px' }}>{status === 'done' ? `Latest ${first.length}` : total}</span>
        </Space>
      }
      style={{ marginBottom: 16, background: COLORS.surfaceAlt, borderColor: COLORS.line, borderRadius: 8 }}
      styles={{ header: { borderBottom: 0, minHeight: 48 }, body: { padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 8 } }}
    >
      {list.error && (
        <Typography.Text type="danger">
          Could not load. <a onClick={list.reload}>Retry</a>
        </Typography.Text>
      )}
      {list.loading && !list.data && <CardSkeleton />}
      {list.data?.items.length === 0 && <EmptyState compact icon={<CheckCircleOutlined />} title={empty} />}
      {shown.map((c) => (
        <ComplaintCard key={c.id} c={c} actions={actions(c)} onOpen={() => onOpen(c.id)} />
      ))}
      {status !== 'done' && list.data && shown.length < total && (
        <Button block loading={loadingMore} onClick={() => void showMore()}>
          Show more ({total - shown.length} more)
        </Button>
      )}
    </Card>
  );
}
