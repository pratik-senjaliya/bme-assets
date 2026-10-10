'use client';

import { CheckCircleOutlined, PaperClipOutlined } from '@ant-design/icons';
import { App, Button, Card, Col, Form, Input, Modal, Row, Space, Tabs, Typography } from 'antd';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { resolveComplaintSchema, type ComplaintRow, type ComplaintStatus, type Paged } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { Bar, EmptyState } from '@/components/Skeletons';
import { CriticalityTag, Pill } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatDuration } from '@/lib/format';
import { COLORS } from '@/theme';
import { parseForm, useSingleFlight } from '@/lib/forms';

// The history tab, the details drawer and the raise dialog load when first opened, so the board shows sooner.
const ComplaintDrawer = dynamic(() => import('@/components/ComplaintDrawer').then((m) => m.ComplaintDrawer));
const ComplaintsHistory = dynamic(() => import('@/components/ComplaintsHistory').then((m) => m.ComplaintsHistory));
const RaiseComplaintModal = dynamic(() => import('@/components/RaiseComplaintModal').then((m) => m.RaiseComplaintModal));

const COLUMNS: { status: ComplaintStatus; title: string; empty: string }[] = [
  { status: 'open', title: 'Open', empty: 'Nothing waiting.' },
  { status: 'in_progress', title: 'In progress', empty: 'Nothing being worked on.' },
  { status: 'resolved', title: 'Recently resolved', empty: 'No resolved complaints yet.' },
];

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
      <ComplaintDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => setVersion((v) => v + 1)} />
      <RaiseComplaintModal open={raising} onClose={() => setRaising(false)} onRaised={() => setVersion((v) => v + 1)} />
    </>
  );
}

function Board({ version, onChanged, onOpen }: { version: number; onChanged: () => void; onOpen: (id: string) => void }) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const [resolving, setResolving] = useState<ComplaintRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  // The board is watched for a while: refresh it every minute (new complaints, waiting times), but not while the
  // tab is hidden or someone is writing a resolution.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && !resolving) setTick((n) => n + 1);
    }, 60_000);
    return () => clearInterval(t);
  }, [resolving]);

  async function start(c: ComplaintRow) {
    try {
      await api(`/complaints/${c.id}/start`, { method: 'POST' });
      message.success(`${c.complaintNo} started`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not start');
    }
    onChanged();
  }

  const single = useSingleFlight();

  async function resolve() {
    const input = parseForm(form, resolveComplaintSchema, form.getFieldsValue());
    if (!input || !resolving) return;
    setSaving(true);
    try {
      await api(`/complaints/${resolving.id}/resolve`, { body: input });
      message.success(`${resolving.complaintNo} resolved`);
      setResolving(null);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not resolve');
    } finally {
      setSaving(false);
      onChanged();
    }
  }

  return (
    <>
      <Row gutter={16}>
        {COLUMNS.map((col) => (
          <Col key={col.status} xs={24} lg={8}>
            <BoardColumn
              {...col}
              version={version * 10_000 + tick}
              onOpen={onOpen}
              actions={(c) => (
                <>
                  {c.status === 'open' && can('complaint.start') && (
                    <Button onClick={() => start(c)}>
                      Start work
                    </Button>
                  )}
                  {c.status === 'in_progress' && can('complaint.resolve') && (
                    <Button
                      onClick={() => {
                        form.resetFields();
                        setResolving(c);
                      }}
                    >
                      Resolve
                    </Button>
                  )}
                </>
              )}
            />
          </Col>
        ))}
      </Row>
      <Modal
        open={!!resolving}
        title={`Resolve ${resolving?.complaintNo ?? ''}`}
        okText="Mark resolved"
        confirmLoading={saving}
        onOk={() => single(resolve)}
        onCancel={() => setResolving(null)}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          This stops the downtime clock for {resolving?.assetCode}. The time is recorded by the system and cannot be changed.
        </Typography.Paragraph>
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="What was done?" name="resolutionNotes" rules={[{ required: true, message: 'Say what was done' }]}>
            <Input.TextArea rows={4} maxLength={2000} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

const DOT: Record<ComplaintStatus, string> = { open: COLORS.bad.dot, in_progress: COLORS.warn.dot, resolved: COLORS.good.dot };

function BoardColumn({
  status,
  title,
  empty,
  version,
  onOpen,
  actions,
}: {
  status: ComplaintStatus;
  title: string;
  empty: string;
  version: number;
  onOpen: (id: string) => void;
  actions: (c: ComplaintRow) => ReactNode;
}) {
  const list = useFetch<Paged<ComplaintRow>>(`/complaints?status=${status}&pageSize=${status === 'resolved' ? 10 : 50}&k=${version}`);
  return (
    <Card
      size="small"
      title={
        <Space size={10}>
          <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: DOT[status], display: 'inline-block' }} />
          <span style={{ fontWeight: 800, fontSize: 15 }}>{title}</span>
          <span className="num" style={{ color: COLORS.muted, fontWeight: 700, fontSize: 13, background: '#fff', borderRadius: 10, padding: '1px 10px' }}>{list.data?.total ?? 0}</span>
        </Space>
      }
      style={{ marginBottom: 16, background: '#EAEFF1', borderColor: 'transparent', boxShadow: 'none', borderRadius: 18 }}
      styles={{ header: { borderBottom: 0, minHeight: 52 }, body: { padding: '4px 12px 12px', display: 'flex', flexDirection: 'column', gap: 10 } }}
    >
      {list.error && (
        <Typography.Text type="danger">
          Could not load. <a onClick={list.reload}>Retry</a>
        </Typography.Text>
      )}
      {list.loading && !list.data && <CardSkeleton />}
      {list.data?.items.length === 0 && <EmptyState compact icon={<CheckCircleOutlined />} title={empty} />}
      {list.data?.items.map((c) => (
        <ComplaintCard key={c.id} c={c} actions={actions(c)} onOpen={() => onOpen(c.id)} />
      ))}
    </Card>
  );
}

function ComplaintCard({ c, actions, onOpen }: { c: ComplaintRow; actions: ReactNode; onOpen: () => void }) {
  // Display only: how long it has been waiting by this browser's clock. Stored times are the server's.
  const waiting = c.status === 'open' ? formatDuration((Date.now() - new Date(c.raisedAt).getTime()) / 1000) : null;
  const muted = { color: COLORS.muted, fontSize: 12.5 };
  // The clock that matters for this column, in a box so it reads at a glance; red once over the downtime limit.
  const clock = { background: c.overDowntimeLimit ? COLORS.bad.bg : COLORS.surfaceAlt, color: c.overDowntimeLimit ? COLORS.bad.fg : COLORS.ink, borderRadius: 10, padding: '8px 12px', marginTop: 10, fontWeight: 700 };
  return (
    <Card size="small" styles={{ body: { padding: 16 } }} style={{ borderRadius: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="code" style={{ color: COLORS.faint, fontSize: 12.5, fontWeight: 700 }}>{c.complaintNo}</span>
        <CriticalityTag value={c.criticality} />
      </div>
      {c.overDowntimeLimit && (
        <div style={{ marginTop: 8 }}>
          <Pill tone="bad">Over downtime limit</Pill>
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <Link href={`/assets/${c.assetId}`} className="code" style={{ fontWeight: 700 }}>
          {c.assetCode}
        </Link>
        <div style={{ color: COLORS.ink, fontWeight: 700, fontSize: 14.5, marginTop: 1 }}>{c.assetName}</div>
      </div>
      <Typography.Paragraph ellipsis={{ rows: 3, tooltip: c.description }} style={{ margin: '8px 0', color: COLORS.text }}>
        {c.description}
      </Typography.Paragraph>
      <div style={muted}>
        {c.departmentName} · raised by {c.raisedByName}
      </div>
      <div style={muted} className="num">{formatDateTime(c.raisedAt)}</div>
      {waiting && <div style={clock} className="num">Waiting {waiting}</div>}
      {c.startedAt && (
        <div style={{ ...clock, ...(c.resolvedAt ? { background: 'transparent', padding: 0, color: COLORS.text, fontWeight: 600 } : {}) }} className="num">
          Response {formatDuration(c.responseSeconds)}
          <span style={{ ...muted, fontWeight: 500 }}> · started by {c.startedByName}</span>
        </div>
      )}
      {c.resolvedAt && (
        <>
          <div style={{ ...clock, background: c.overDowntimeLimit ? COLORS.bad.bg : COLORS.good.bg, color: c.overDowntimeLimit ? COLORS.bad.fg : COLORS.good.fg }} className="num">Downtime {formatDuration(c.downtimeSeconds)}</div>
          <div style={{ ...muted, marginTop: 6 }}>{c.resolutionNotes}</div>
        </>
      )}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${COLORS.lineSoft}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Button type="link" style={{ padding: 0, fontWeight: 700 }} onClick={onOpen}>
          Details{c.attachmentCount > 0 && <span style={{ marginLeft: 8, color: COLORS.muted }}><PaperClipOutlined /> {c.attachmentCount}</span>}
        </Button>
        <Space>{actions}</Space>
      </div>
    </Card>
  );
}

// One placeholder card per column while it loads.
function CardSkeleton() {
  return (
    <Card size="small" aria-hidden styles={{ body: { padding: 16, display: 'flex', flexDirection: 'column', gap: 10 } }} style={{ borderRadius: 14 }}>
      {[40, 70, 90, 55].map((w, i) => (
        <Bar key={i} w={`${w}%`} h={i === 2 ? 32 : 12} />
      ))}
    </Card>
  );
}
