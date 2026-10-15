'use client';

import { PaperClipOutlined, UserOutlined } from '@ant-design/icons';
import { App, Button, Card, Form, Input, Modal, Select, Space, Typography } from 'antd';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { resolveComplaintSchema, type Assignee, type ComplaintRow } from '@bme/shared';
import { Bar } from '@/components/Skeletons';
import { CriticalityTag, Pill } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatDuration } from '@/lib/format';
import { parseForm, useSingleFlight } from '@/lib/forms';
import { COLORS } from '@/theme';

// Working on complaints, shared by the complaints board and "My work": the card, and the buttons for the next step
// (Take it, Start work, Resolve, Assign) with their dialogs. The server checks every step again.
export function useComplaintWork(onChanged: () => void) {
  const { can, user } = useAuth();
  const { message } = App.useApp();
  const [resolving, setResolving] = useState<ComplaintRow | null>(null);
  const [assigning, setAssigning] = useState<ComplaintRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [assignForm] = Form.useForm();
  const isHod = can('complaint.assign');
  const assignees = useFetch<Assignee[]>(isHod && assigning ? '/complaints/assignees' : null, { fresh: true });
  const single = useSingleFlight();

  async function step(c: ComplaintRow, path: string, body: unknown, done: string) {
    try {
      await api(`/complaints/${c.id}/${path}`, { method: 'POST', body });
      message.success(done);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not save');
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

  async function assign() {
    if (!assigning) return;
    const userId: string | null = assignForm.getFieldValue('userId') ?? null;
    const who = assignees.data?.find((a) => a.id === userId)?.name;
    setSaving(true);
    try {
      await api(`/complaints/${assigning.id}/assign`, { body: { userId } });
      message.success(who ? `${assigning.complaintNo} assigned to ${who}` : `${assigning.complaintNo} is unassigned`);
      setAssigning(null);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not assign');
    } finally {
      setSaving(false);
      onChanged();
    }
  }

  // The buttons for the next step, or null when this person has none (nursing staff, a resolved complaint).
  const actions = (c: ComplaintRow): ReactNode => {
    if (c.status === 'resolved') return null;
    const free = !c.assignedToId;
    const take = () => single(() => step(c, 'assign', { userId: user?.id }, `${c.complaintNo} is yours`));
    const buttons = [
      isHod && (
        <Button
          key="assign"
          onClick={() => {
            assignForm.setFieldsValue({ userId: c.assignedToId ?? undefined });
            setAssigning(c);
          }}
        >
          {free ? 'Assign' : 'Reassign'}
        </Button>
      ),
      !isHod && free && can('complaint.start') && (
        <Button key="take" onClick={take}>
          Take it
        </Button>
      ),
      c.status === 'open' && can('complaint.start') && (
        <Button key="start" type="primary" onClick={() => single(() => step(c, 'start', undefined, `${c.complaintNo} started`))}>
          Start work
        </Button>
      ),
      c.status === 'in_progress' && can('complaint.resolve') && (
        <Button
          key="resolve"
          type="primary"
          onClick={() => {
            form.resetFields();
            setResolving(c);
          }}
        >
          Resolve
        </Button>
      ),
    ].filter(Boolean);
    return buttons.length ? <>{buttons}</> : null;
  };

  const dialogs = (
    <>
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
      <Modal
        open={!!assigning}
        title={`Assign ${assigning?.complaintNo ?? ''}`}
        okText="Save"
        confirmLoading={saving}
        onOk={() => single(assign)}
        onCancel={() => setAssigning(null)}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          {assigning?.assetCode} · {assigning?.assetName}. The person you choose is told at once. The number after each name is how many unresolved complaints they already have.
        </Typography.Paragraph>
        <Form form={assignForm} layout="vertical">
          <Form.Item label="Assign to" name="userId">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Nobody yet"
              loading={assignees.loading}
              options={(assignees.data ?? []).map((a) => ({ value: a.id, label: `${a.name} · ${a.openCount}` }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );

  return { actions, dialogs };
}

// Who has it: the assignee, or "Unassigned" (quiet, so a board of unassigned work is not a wall of warnings).
export function AssigneeLine({ c }: { c: ComplaintRow }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: c.assignedToName ? COLORS.ink : COLORS.muted, marginTop: 6 }}>
      <UserOutlined aria-hidden />
      {c.assignedToName ? <span>Assigned to <strong style={{ fontWeight: 600 }}>{c.assignedToName}</strong></span> : <span>Unassigned</span>}
    </div>
  );
}

export function ComplaintCard({ c, actions, onOpen }: { c: ComplaintRow; actions: ReactNode; onOpen: () => void }) {
  // Display only: how long it has been waiting by this browser's clock. Stored times are the server's.
  const waiting = c.status === 'open' ? formatDuration((Date.now() - new Date(c.raisedAt).getTime()) / 1000) : null;
  const muted = { color: COLORS.muted, fontSize: 12.5 };
  // The clock that matters for this column, in a box so it reads at a glance; red once over the downtime limit.
  const clock = { background: c.overDowntimeLimit ? COLORS.bad.bg : COLORS.surfaceAlt, color: c.overDowntimeLimit ? COLORS.bad.fg : COLORS.ink, borderRadius: 4, padding: '6px 10px', marginTop: 10, fontWeight: 600 };
  return (
    <Card size="small" styles={{ body: { padding: 14 } }} style={{ borderRadius: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="code" style={{ color: COLORS.muted, fontSize: 12.5 }}>{c.complaintNo}</span>
        <CriticalityTag value={c.criticality} />
      </div>
      {c.overDowntimeLimit && (
        <div style={{ marginTop: 8 }}>
          <Pill tone="bad">Over downtime limit</Pill>
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <div style={{ color: COLORS.ink, fontWeight: 700, fontSize: 14.5 }}>{c.assetName}</div>
        <Link href={`/assets/${c.assetId}`} className="code" style={{ fontSize: 12.5 }}>
          {c.assetCode}
        </Link>
      </div>
      <Typography.Paragraph ellipsis={{ rows: 3, tooltip: c.description }} style={{ margin: '8px 0', color: COLORS.text }}>
        {c.description}
      </Typography.Paragraph>
      <div style={muted}>
        {c.departmentName} · raised by {c.raisedByName}
      </div>
      <div style={muted} className="num">{formatDateTime(c.raisedAt)}</div>
      {c.status !== 'resolved' && <AssigneeLine c={c} />}
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
        <Button type="link" style={{ padding: 0, fontWeight: 600 }} onClick={onOpen}>
          Details{c.attachmentCount > 0 && <span style={{ marginLeft: 8, color: COLORS.muted }}><PaperClipOutlined /> {c.attachmentCount}</span>}
        </Button>
        <Space wrap size={6} style={{ justifyContent: 'flex-end' }}>
          {actions}
        </Space>
      </div>
    </Card>
  );
}

// One placeholder card while a list of complaints loads.
export function CardSkeleton() {
  return (
    <Card size="small" aria-hidden styles={{ body: { padding: 14, display: 'flex', flexDirection: 'column', gap: 10 } }} style={{ borderRadius: 6 }}>
      {[40, 70, 90, 55].map((w, i) => (
        <Bar key={i} w={`${w}%`} h={i === 2 ? 32 : 12} />
      ))}
    </Card>
  );
}
