'use client';

import { PaperClipOutlined } from '@ant-design/icons';
import { App, Button, Card, Col, Form, Input, Modal, Row, Skeleton, Space, Tabs, Typography } from 'antd';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { resolveComplaintSchema, type ComplaintRow, type ComplaintStatus, type Paged } from '@bme/shared';
import { ComplaintDrawer } from '@/components/ComplaintDrawer';
import { ComplaintsHistory } from '@/components/ComplaintsHistory';
import { PageHeader } from '@/components/PageHeader';
import { RaiseComplaintModal } from '@/components/RaiseComplaintModal';
import { CriticalityTag, Pill } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatDuration } from '@/lib/format';
import { COLORS } from '@/theme';
import { parseForm } from '@/lib/forms';

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

  async function start(c: ComplaintRow) {
    try {
      await api(`/complaints/${c.id}/start`, { method: 'POST' });
      message.success(`${c.complaintNo} started`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not start');
    }
    onChanged();
  }

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
              version={version}
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
        onOk={resolve}
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
        <Space>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: DOT[status], display: 'inline-block' }} />
          {title}
          <span style={{ color: COLORS.muted, fontWeight: 500 }}>{list.data?.total ?? 0}</span>
        </Space>
      }
      style={{ marginBottom: 16, background: '#EBEFF4', borderColor: 'transparent' }}
      styles={{ body: { padding: 12, display: 'flex', flexDirection: 'column', gap: 12 } }}
    >
      {list.error && (
        <Typography.Text type="danger">
          Could not load. <a onClick={list.reload}>Retry</a>
        </Typography.Text>
      )}
      {list.loading && !list.data && <Skeleton active />}
      {list.data?.items.length === 0 && <div style={{ color: COLORS.muted, textAlign: 'center', padding: '32px 0' }}>{empty}</div>}
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
  return (
    <Card size="small" styles={{ body: { padding: 14 } }}>
      <Space style={{ display: 'flex', justifyContent: 'space-between' }}>
        <strong className="code">{c.complaintNo}</strong>
        <CriticalityTag value={c.criticality} />
      </Space>
      {c.overDowntimeLimit && (
        <div style={{ marginTop: 6 }}>
          <Pill tone="bad">Over downtime limit</Pill>
        </div>
      )}
      <div style={{ marginTop: 4 }}>
        <Link href={`/assets/${c.assetId}`} className="code">
          {c.assetCode}
        </Link>
        <span style={muted}> · {c.assetName}</span>
      </div>
      <Typography.Paragraph ellipsis={{ rows: 3, tooltip: c.description }} style={{ margin: '8px 0' }}>
        {c.description}
      </Typography.Paragraph>
      <div style={muted}>
        {c.departmentName} · raised by {c.raisedByName}
      </div>
      <div style={muted}>{formatDateTime(c.raisedAt)}</div>
      {waiting && <div style={{ marginTop: 4 }}>Waiting {waiting}</div>}
      {c.startedAt && (
        <div style={{ marginTop: 4 }}>
          Response {formatDuration(c.responseSeconds)}
          <span style={muted}> · started by {c.startedByName}</span>
        </div>
      )}
      {c.resolvedAt && (
        <>
          <div>Downtime {formatDuration(c.downtimeSeconds)}</div>
          <div style={{ ...muted, marginTop: 4 }}>{c.resolutionNotes}</div>
        </>
      )}
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Button type="link" style={{ padding: 0 }} onClick={onOpen}>
          Details{c.attachmentCount > 0 && <span style={{ marginLeft: 8, color: COLORS.muted }}><PaperClipOutlined /> {c.attachmentCount}</span>}
        </Button>
        <Space>{actions}</Space>
      </div>
    </Card>
  );
}
