'use client';

import { DeleteOutlined, PaperClipOutlined, PlusOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Typography } from 'antd';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { complaintNoteSchema, EXPENSE_TYPES, optionalNoteSchema, resolveComplaintSchema, type Assignee, type ComplaintRow, type Paged } from '@bme/shared';
import { Bar } from '@/components/Skeletons';
import { CriticalityTag, Pill } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatDuration, moneyInputProps } from '@/lib/format';
import { parseForm, useSingleFlight } from '@/lib/forms';
import { COLORS } from '@/theme';

// The steps that take a short note, with the words for their dialog. Escalating and holding need a reason; going
// back to work and closing do not.
const NOTE_STEPS = {
  start: {
    title: 'Start work',
    ok: 'Start work',
    label: 'What happens next? (optional)',
    initial: '',
    placeholder: 'e.g. Checking the power board; back within the hour.',
    intro: 'The response time stops now, and whoever raised it is told someone is on it.',
    required: false,
  },
  escalate: {
    title: 'Escalate to the HOD',
    ok: 'Escalate',
    label: 'Why can it not be fixed here?',
    initial: 'Needs OEM support',
    placeholder: '',
    intro: 'The HOD is told at once and decides what happens next (for example, putting it on hold for the OEM engineer). It stays with you meanwhile.',
    required: true,
  },
  hold: {
    title: 'Put on hold',
    ok: 'Put on hold',
    label: 'Why, and what happens next?',
    initial: '',
    placeholder: 'e.g. Spoke to the company engineer: he will attend in two days with the spare part.',
    intro: 'The engineer it is assigned to is told. The downtime clock keeps running: the equipment is still down.',
    required: true,
  },
  resume: { title: 'Back to work', ok: 'Back to work', label: 'Note (optional)', initial: '', placeholder: '', intro: 'The engineer it is assigned to is told it is back with them.', required: false },
  close: {
    title: 'Close complaint',
    ok: 'Close complaint',
    label: 'Anything to add? (optional)',
    initial: '',
    placeholder: 'e.g. Working fine since this morning.',
    intro: 'Close it once the equipment has been checked and works again. If it still does not work, choose "Still not working" instead.',
    required: false,
  },
  reopen: {
    title: 'Still not working',
    ok: 'Send back to the engineer',
    label: 'What is still wrong?',
    initial: '',
    placeholder: 'e.g. The alarm still sounds after ten minutes of use.',
    intro: 'The complaint goes back to the engineer as in progress, and the downtime carries on from when it was first raised.',
    required: true,
  },
} as const;
type NoteStep = keyof typeof NOTE_STEPS;

// Working on complaints, shared by the complaints board, "My work" and the details drawer: the card, and the buttons
// for the next step (Take it, Start work, Escalate, Put on hold, Back to work, Resolve, Assign, Close) with their
// dialogs. The server checks every step again.
export function useComplaintWork(onChanged: () => void) {
  const { can, user } = useAuth();
  const { message } = App.useApp();
  const [resolving, setResolving] = useState<ComplaintRow | null>(null);
  const [assigning, setAssigning] = useState<ComplaintRow | null>(null);
  const [noting, setNoting] = useState<{ c: ComplaintRow; step: NoteStep } | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [assignForm] = Form.useForm();
  const [noteForm] = Form.useForm();
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

  function askNote(c: ComplaintRow, step: NoteStep) {
    noteForm.setFieldsValue({ note: NOTE_STEPS[step].initial });
    setNoting({ c, step });
  }

  async function saveNote() {
    if (!noting) return;
    const { c, step } = noting;
    const input = parseForm(noteForm, NOTE_STEPS[step].required ? complaintNoteSchema : optionalNoteSchema, noteForm.getFieldsValue());
    if (!input) return;
    setSaving(true);
    try {
      await api(`/complaints/${c.id}/${step}`, { body: input });
      message.success({ start: `${c.complaintNo} started`, escalate: `${c.complaintNo} sent to the HOD`, hold: `${c.complaintNo} is on hold`, resume: `${c.complaintNo} is back in progress`, close: `${c.complaintNo} closed`, reopen: `${c.complaintNo} is back with the engineer` }[step]);
      setNoting(null);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not save');
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

  // The buttons for the next step, or null when this person has none.
  const actions = (c: ComplaintRow): ReactNode => {
    if (c.status === 'closed') return null;
    // Resolved: closing it is left, by whoever raised it or someone from that department (the next shift).
    // Not fixed after all: send it back to the engineer instead.
    if (c.status === 'resolved')
      return c.raisedById === user?.id || (!!user?.departmentId && user.departmentId === c.departmentId && can('complaint.create')) ? (
        <>
          <Button type="primary" onClick={() => askNote(c, 'close')}>
            Close complaint
          </Button>
          <Button onClick={() => askNote(c, 'reopen')}>Still not working</Button>
        </>
      ) : null;
    const free = !c.assignedToId;
    const canHold = can('complaint.hold');
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
        <Button key="start" type="primary" onClick={() => askNote(c, 'start')}>
          Start work
        </Button>
      ),
      // The HOD answers an escalation (or ends a hold) by sending it back to work, or puts it on hold.
      canHold && (c.status === 'on_hold' || c.escalatedAt) && (
        <Button key="resume" onClick={() => askNote(c, 'resume')}>
          Back to work
        </Button>
      ),
      canHold && c.status === 'in_progress' && (
        <Button key="hold" onClick={() => askNote(c, 'hold')}>
          Put on hold
        </Button>
      ),
      // Engineers escalate; the HOD, who would receive it, puts it on hold instead.
      !canHold && c.status === 'in_progress' && !c.escalatedAt && can('complaint.start') && (
        <Button key="escalate" onClick={() => askNote(c, 'escalate')}>
          Escalate
        </Button>
      ),
      (c.status === 'in_progress' || c.status === 'on_hold') && can('complaint.resolve') && (
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
          This stops the {resolving?.assetId ? 'downtime' : 'resolution'} clock for {resolving?.subject}. The time is recorded by the system and cannot be changed.
        </Typography.Paragraph>
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="What was done?" name="resolutionNotes" rules={[{ required: true, message: 'Say what was done' }]}>
            <Input.TextArea rows={4} maxLength={2000} showCount />
          </Form.Item>
          {/* Parts and bills can be booked here, dated today and linked to this complaint (also later on the asset). */}
          {can('expense.manage') && resolving?.assetId && (
            <Form.List name="costs">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((f) => (
                    <div key={f.key} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '12px 12px 0', marginBottom: 12 }}>
                      <Space.Compact block>
                        <Form.Item name={[f.name, 'type']} initialValue="spare_part" style={{ width: 130 }}>
                          <Select aria-label="Type" options={EXPENSE_TYPES.map((t) => ({ value: t, label: t === 'spare_part' ? 'Spare part' : 'Repair' }))} />
                        </Form.Item>
                        <Form.Item name={[f.name, 'amount']} rules={[{ required: true, message: 'Amount' }]} style={{ flex: 1 }}>
                          <InputNumber aria-label="Amount (₹)" min={0} {...moneyInputProps} placeholder="Amount" style={{ width: '100%' }} />
                        </Form.Item>
                        <Button aria-label="Remove this cost" icon={<DeleteOutlined />} onClick={() => remove(f.name)} />
                      </Space.Compact>
                      <Form.Item name={[f.name, 'description']} rules={[{ required: true, message: 'Describe it' }]}>
                        <Input aria-label="What was paid for" maxLength={500} placeholder="What was paid for, e.g. Flow sensor" />
                      </Form.Item>
                      <Form.Item name={[f.name, 'vendor']}>
                        <Input aria-label="Vendor" maxLength={150} placeholder="Vendor (optional)" />
                      </Form.Item>
                    </div>
                  ))}
                  {fields.length < 10 && (
                    <Button icon={<PlusOutlined />} onClick={() => add()}>
                      {fields.length ? 'Add another cost' : 'Add a part or cost'}
                    </Button>
                  )}
                </>
              )}
            </Form.List>
          )}
        </Form>
      </Modal>
      <Modal
        open={!!noting}
        title={noting ? `${NOTE_STEPS[noting.step].title} · ${noting.c.complaintNo}` : ''}
        okText={noting ? NOTE_STEPS[noting.step].ok : 'Save'}
        confirmLoading={saving}
        onOk={() => single(saveNote)}
        onCancel={() => setNoting(null)}
        destroyOnHidden
      >
        {noting && (
          <>
            <Typography.Paragraph type="secondary">
              {noting.c.subject}. {NOTE_STEPS[noting.step].intro}
            </Typography.Paragraph>
            <Form form={noteForm} layout="vertical" requiredMark>
              <Form.Item label={NOTE_STEPS[noting.step].label} name="note" rules={NOTE_STEPS[noting.step].required ? [{ required: true, message: 'Say why in a few words' }] : []}>
                <Input.TextArea rows={3} maxLength={1000} showCount placeholder={NOTE_STEPS[noting.step].placeholder || undefined} />
              </Form.Item>
            </Form>
          </>
        )}
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
          {assigning?.subject}. The person you choose is told at once. The number after each name is how many unresolved complaints they already have.
        </Typography.Paragraph>
        <Form form={assignForm} layout="vertical">
          <Form.Item label="Assign to" name="userId">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Nobody yet"
              loading={assignees.loading}
              options={(assignees.data ?? []).filter((a) => !assigning || a.registers.includes(assigning.register)).map((a) => ({ value: a.id, label: `${a.name} · ${a.openCount}` }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );

  return { actions, dialogs };
}

// Where it stands when it is waiting on someone other than the engineer: escalated to the HOD, or on hold.
export function StepNote({ c }: { c: ComplaintRow }) {
  if (c.status === 'on_hold')
    return <Alert style={{ marginTop: 10 }} type="info" showIcon message="On hold" description={c.holdNote} />;
  if (c.escalatedAt)
    return <Alert style={{ marginTop: 10 }} type="warning" showIcon message={`Escalated to the HOD · ${formatDateTime(c.escalatedAt)}`} description={c.escalationNote} />;
  return null;
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
        {c.criticality ? <CriticalityTag value={c.criticality} /> : <Pill tone="neutral">No machine</Pill>}
      </div>
      {(c.urgent || c.overDowntimeLimit || c.overResponseTarget) && (
        <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {c.urgent && !c.resolvedAt && <Pill tone="bad">{c.assetId ? 'Urgent: cannot be used' : 'Urgent'}</Pill>}
          {c.overDowntimeLimit && <Pill tone="bad">Over downtime limit</Pill>}
          {c.overResponseTarget && <Pill tone="warn">Over {c.responseTargetHours} h response target</Pill>}
        </div>
      )}
      <ComplaintAbout c={c} />
      <Typography.Paragraph ellipsis={{ rows: 3, tooltip: c.description }} style={{ margin: '8px 0', color: COLORS.text }}>
        {c.description}
      </Typography.Paragraph>
      <div style={muted}>
        {c.departmentName} · raised by {c.raisedByName}
      </div>
      <div style={muted} className="num">{formatDateTime(c.raisedAt)}</div>
      {!c.resolvedAt && <AssigneeLine c={c} />}
      <StepNote c={c} />
      {waiting && <div style={clock} className="num">Waiting {waiting}</div>}
      {c.startedAt && (
        <div style={{ ...clock, ...(c.resolvedAt ? { background: 'transparent', padding: 0, color: COLORS.text, fontWeight: 600 } : {}) }} className="num">
          Response {formatDuration(c.responseSeconds)}
          <span style={{ ...muted, fontWeight: 500 }}> · started by {c.startedByName}</span>
        </div>
      )}
      {c.resolvedAt && (
        <>
          <div style={{ ...clock, background: c.overDowntimeLimit ? COLORS.bad.bg : COLORS.good.bg, color: c.overDowntimeLimit ? COLORS.bad.fg : COLORS.good.fg }} className="num">{c.assetId ? 'Downtime' : 'Resolved in'} {formatDuration(c.resolutionSeconds)}</div>
          <div style={{ ...muted, marginTop: 6 }}>{c.resolutionNotes}</div>
          <div style={{ ...muted, marginTop: 6 }}>
            {c.status === 'resolved' ? `Waiting for ${c.raisedByName} to close` : c.closedByName ? `Closed by ${c.closedByName}` : 'Closed automatically'}
          </div>
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

// The fixed complaints this person may close (decision B): raised by them, or in their department (shift handover). Shown above the
// complaints list for anyone who raises complaints; nothing at all when there are none.
export function ToClose({ version, onChanged, onOpen }: { version: number; onChanged: () => void; onOpen?: (id: string) => void }) {
  const { can } = useAuth();
  const list = useFetch<Paged<ComplaintRow>>(can('complaint.create') ? `/complaints?closable=me&pageSize=50&k=${version}` : null, { fresh: true });
  const { actions, dialogs } = useComplaintWork(onChanged);
  const items = list.data?.items ?? [];
  if (!items.length) return null;
  return (
    <Card style={{ marginBottom: 20, borderColor: COLORS.good.dot }} styles={{ body: { padding: '14px 18px' } }}>
      <div style={{ fontWeight: 700, color: COLORS.ink, fontSize: 15 }}>Fixed: please check and close ({items.length})</div>
      <div style={{ color: COLORS.muted, fontSize: 13, marginBottom: 6 }}>
        Raised by you or your department. Close each one once it works again; any not closed close by themselves after a few days.
      </div>
      {items.map((c) => (
        <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: `1px solid ${COLORS.lineSoft}`, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: '1 1 260px' }}>
            {onOpen ? (
              <Button type="link" className="code" style={{ padding: 0, height: 'auto' }} onClick={() => onOpen(c.id)}>
                {c.complaintNo}
              </Button>
            ) : (
              <span className="code">{c.complaintNo}</span>
            )}
            <span style={{ color: COLORS.ink, fontWeight: 600 }}> · {c.assetName ?? c.subject}</span>
            <div style={{ color: COLORS.muted, fontSize: 12.5 }}>
              Resolved {c.resolvedAt ? formatDateTime(c.resolvedAt) : ''}
              {c.resolvedByName && ` by ${c.resolvedByName}`}
              {c.resolutionNotes && `: ${c.resolutionNotes}`}
            </div>
          </div>
          {actions(c)}
        </div>
      ))}
      {dialogs}
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

// What a complaint is about: the machine (name, and its ID linking to it), or for a ward fault without one the trade
// and where it is.
export function ComplaintAbout({ c }: { c: ComplaintRow }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ color: COLORS.ink, fontWeight: 700, fontSize: 14.5 }}>{c.assetName ?? c.tradeName}</div>
      {c.assetId ? (
        <Link href={`/assets/${c.assetId}`} className="code" style={{ fontSize: 12.5 }}>
          {c.assetCode}
        </Link>
      ) : (
        <div style={{ color: COLORS.muted, fontSize: 12.5 }}>{c.locationName}</div>
      )}
    </div>
  );
}
