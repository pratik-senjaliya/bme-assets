'use client';

import { App, Alert, Button, Card, Checkbox, Form, Input, InputNumber, Modal, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import {
  correctReadingSchema,
  READING_EVERY,
  READING_EVERY_LABEL,
  readingTypeSchema,
  recordReadingSchema,
  type AssetReadings,
  type ReadingRow,
  type ReadingTypeRow,
} from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { Pill } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';
import { formatDateTime } from '@/lib/format';
import { COLORS } from '@/theme';

export const rangeText = (t: Pick<ReadingTypeRow, 'min' | 'max' | 'unit'>) =>
  t.min != null && t.max != null ? `${t.min}–${t.max} ${t.unit}` : t.min != null ? `≥ ${t.min} ${t.unit}` : t.max != null ? `≤ ${t.max} ${t.unit}` : '';

// Take one reading now (the server stamps the time). Used by the machine's Logbook tab and the Logbook page.
export function RecordReadingModal({ type, onClose, onDone }: { type: ReadingTypeRow | null; onClose: () => void; onDone: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const single = useSingleFlight();
  async function save() {
    const input = parseForm(form, recordReadingSchema, { value: form.getFieldValue('value'), note: form.getFieldValue('note') ?? null });
    if (!input || !type) return;
    setSaving(true);
    try {
      const r = await api<ReadingRow>(`/readings/types/${type.id}`, { body: input });
      if (r.outOfRange) message.warning(`${type.name} ${r.value} ${type.unit} is outside the normal range; the team has been told.`, 6);
      else message.success(`${type.name} recorded`);
      onDone();
      onClose();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not record the reading');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal open={!!type} title={type ? `${type.name} · ${type.assetCode}` : ''} okText="Record reading" confirmLoading={saving} onOk={() => single(save)} onCancel={onClose} destroyOnHidden>
      {type && (
        <Typography.Paragraph type="secondary">
          The time is recorded by the system and the reading cannot be changed afterwards (a wrong one is corrected).
          {rangeText(type) && ` Normal: ${rangeText(type)}.`}
          {type.last && ` Last: ${type.last.value} ${type.unit} on ${formatDateTime(type.last.takenAt)}.`}
        </Typography.Paragraph>
      )}
      {/* preserve={false}: the dialog starts empty each time without clearing what is typed while it opens. */}
      <Form form={form} layout="vertical" requiredMark preserve={false}>
        <Form.Item label={`Reading${type ? ` (${type.unit})` : ''}`} name="value" rules={[{ required: true, message: 'Enter the reading' }]}>
          <InputNumber autoFocus style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Note" name="note">
          <Input maxLength={500} placeholder="Optional, e.g. topped up 200 L" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// A machine's logbook: what it is read for, the last values, run hours and PMS by hours, and the readings taken.
export function AssetLogbookTab({ assetId, gone }: { assetId: string; gone: boolean }) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const data = useFetch<AssetReadings>(`/readings/assets/${assetId}`, { fresh: true });
  const [recording, setRecording] = useState<ReadingTypeRow | null>(null);
  const [editing, setEditing] = useState<ReadingTypeRow | 'new' | null>(null);
  const [correcting, setCorrecting] = useState<ReadingRow | null>(null);
  const [typeForm] = Form.useForm();
  const [fixForm] = Form.useForm();
  const [hoursForm] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const single = useSingleFlight();
  const canSetUp = can('asset.edit') && !gone;
  const meterHours = data.data?.types.some((t) => t.runHours);
  const run = data.data?.runHours;

  function openType(row: ReadingTypeRow | 'new') {
    typeForm.resetFields();
    typeForm.setFieldsValue(row === 'new' ? { kind: 'level', every: 'day', active: true } : row);
    setEditing(row);
  }
  async function saveType() {
    const v = typeForm.getFieldsValue();
    const input = parseForm(typeForm, readingTypeSchema, { ...v, min: v.min ?? null, max: v.max ?? null, runHours: !!v.runHours, active: v.active ?? true });
    if (!input) return;
    setSaving(true);
    try {
      if (editing === 'new') await api(`/readings/assets/${assetId}/types`, { body: input });
      else await api(`/readings/types/${(editing as ReadingTypeRow).id}`, { method: 'PATCH', body: input });
      message.success(editing === 'new' ? `${input.name} added` : 'Reading updated');
      setEditing(null);
      data.reload();
    } catch (e) {
      if (!showApiFieldErrors(typeForm, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }
  async function correct() {
    const input = parseForm(fixForm, correctReadingSchema, fixForm.getFieldsValue());
    if (!input || !correcting) return;
    setSaving(true);
    try {
      await api(`/readings/${correcting.id}/correct`, { body: input });
      message.success('Reading corrected');
      setCorrecting(null);
      data.reload();
    } catch (e) {
      if (!showApiFieldErrors(fixForm, e)) message.error(e instanceof Error ? e.message : 'Could not correct');
    } finally {
      setSaving(false);
    }
  }
  async function saveHours(v: { pmsEveryHours?: number | null }) {
    try {
      await api(`/readings/assets/${assetId}/pms-hours`, { method: 'PUT', body: { pmsEveryHours: v.pmsEveryHours ?? null } });
      message.success(v.pmsEveryHours ? `PMS every ${v.pmsEveryHours} run hours` : 'PMS by run hours switched off');
      data.reload();
    } catch (e) {
      if (!showApiFieldErrors(hoursForm, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    }
  }

  const kind = Form.useWatch('kind', typeForm);
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {data.error && <Alert type="error" showIcon message="Could not load the logbook" description={data.error} />}
      <Card
        title="What it is read for"
        extra={canSetUp && <Button onClick={() => openType('new')}>Add reading</Button>}
        styles={{ body: { padding: data.data?.types.length ? '4px 20px' : 20 } }}
      >
        {data.data && !data.data.types.length && <Typography.Text type="secondary">Nothing yet. Add what is read on this item, e.g. run hours, diesel level, a temperature or a meter.</Typography.Text>}
        {data.data?.types.map((t) => (
          <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `1px solid ${COLORS.lineSoft}`, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: COLORS.ink }}>
                {t.name} {!t.active && <Pill tone="neutral">Not read any more</Pill>} {t.runHours && <Pill tone="info">Run hours</Pill>}
              </div>
              <div style={{ color: COLORS.muted, fontSize: 12.5 }}>
                {READING_EVERY_LABEL[t.every]}
                {t.kind === 'meter' ? ' · meter' : ''}
                {rangeText(t) && ` · normal ${rangeText(t)}`}
              </div>
            </div>
            <Space wrap size={6}>
              {t.last ? (
                <span className="num" style={{ fontWeight: 600, color: t.last.outOfRange ? COLORS.bad.fg : COLORS.ink }}>
                  {t.last.value} {t.unit}
                  <span style={{ color: COLORS.muted, fontWeight: 400 }}> · {formatDateTime(t.last.takenAt)}</span>
                </span>
              ) : (
                <span style={{ color: COLORS.muted }}>No readings yet</span>
              )}
              {t.dueNow && <Pill tone="warn">Due</Pill>}
              {t.last?.outOfRange && <Pill tone="bad">Out of range</Pill>}
              {can('reading.record') && t.active && !gone && <Button size="small" type="primary" onClick={() => setRecording(t)}>Record</Button>}
              {canSetUp && <Button size="small" type="text" onClick={() => openType(t)}>Edit</Button>}
            </Space>
          </div>
        ))}
      </Card>
      {meterHours && run && (
        <Card title="PMS by run hours">
          <Space wrap size={24} style={{ marginBottom: canSetUp ? 12 : 0 }}>
            <span>Hours now: <b className="num">{run.hoursNow ?? '—'}</b></span>
            <span>Last PMS at: <b className="num">{run.lastPmsHours ?? '—'}</b></span>
            <span>Next PMS at: <b className="num">{run.pmsDueAtHours ?? '—'}</b></span>
            {run.hoursLeft != null && <Pill tone={run.hoursLeft <= 0 ? 'bad' : run.hoursLeft <= 25 ? 'warn' : 'good'}>{run.hoursLeft <= 0 ? `Due, ${-run.hoursLeft} h over` : `${run.hoursLeft} h left`}</Pill>}
          </Space>
          {canSetUp && (
            <Form form={hoursForm} layout="inline" initialValues={{ pmsEveryHours: run.pmsEveryHours }} onFinish={saveHours}>
              <Form.Item label="PMS every" name="pmsEveryHours">
                <InputNumber min={1} max={100000} addonAfter="hours" placeholder="e.g. 250" style={{ width: 180 }} />
              </Form.Item>
              <Button htmlType="submit">Save</Button>
            </Form>
          )}
        </Card>
      )}
      <Card title="Readings taken" styles={{ body: { padding: 0 } }}>
        <DataTable<ReadingRow>
          rows={data.data?.readings ?? null}
          loading={data.loading}
          emptyText="No readings yet."
          columns={[
            { title: 'Taken', dataIndex: 'takenAt', className: 'm-title', render: (v: string) => <span className="num">{formatDateTime(v)}</span> },
            { title: 'Reading', dataIndex: 'typeName' },
            {
              title: 'Value',
              dataIndex: 'value',
              align: 'right',
              render: (v: number, r) => (
                <Space size={6}>
                  <span className="num" style={{ textDecoration: r.corrected ? 'line-through' : undefined, color: r.outOfRange ? COLORS.bad.fg : undefined }}>{v} {r.unit}</span>
                  {r.correctsId && <Pill tone="info">Correction</Pill>}
                </Space>
              ),
            },
            { title: 'By', dataIndex: 'takenByName', className: 'm-hide' },
            { title: 'Note', key: 'note', className: 'm-hide', render: (_: unknown, r) => r.correctionReason ?? r.note },
            {
              title: <span className="sr-only">Actions</span>,
              key: 'actions',
              align: 'right',
              render: (_: unknown, r) =>
                can('reading.record') && !r.corrected && !gone ? (
                  <Button size="small" type="text" onClick={() => { fixForm.resetFields(); setCorrecting(r); }}>Correct</Button>
                ) : null,
            },
          ]}
        />
      </Card>
      <RecordReadingModal type={recording} onClose={() => setRecording(null)} onDone={data.reload} />
      <Modal open={editing !== null} title={editing === 'new' ? 'Add reading' : 'Edit reading'} okText="Save" confirmLoading={saving} onOk={() => single(saveType)} onCancel={() => setEditing(null)} destroyOnHidden>
        <Form form={typeForm} layout="vertical" requiredMark>
          <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Name it' }]}>
            <Input maxLength={80} placeholder="e.g. Diesel level, Run hours, Supply temperature" />
          </Form.Item>
          <Form.Item label="Unit" name="unit" rules={[{ required: true, message: 'The unit' }]}>
            <Input maxLength={20} placeholder="%, °C, h, kWh, m³, ppm, bar" />
          </Form.Item>
          <Form.Item label="Kind" name="kind" extra="A meter only goes up (run hours, kWh, water); what was used is the difference between readings.">
            <Select options={[{ value: 'level', label: 'A level or value' }, { value: 'meter', label: 'A meter' }]} />
          </Form.Item>
          {kind === 'meter' && (
            <Form.Item name="runHours" valuePropName="checked" style={{ marginBottom: 12 }}>
              <Checkbox>This meter counts the machine’s run hours (PMS can then be due every N hours)</Checkbox>
            </Form.Item>
          )}
          <Space.Compact block>
            <Form.Item label="Normal from" name="min" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="Normal to" name="max" style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
          </Space.Compact>
          <Form.Item label="How often" name="every">
            <Select options={READING_EVERY.map((e) => ({ value: e, label: READING_EVERY_LABEL[e] }))} />
          </Form.Item>
          {editing !== 'new' && (
            <Form.Item name="active" valuePropName="checked">
              <Checkbox>Still read</Checkbox>
            </Form.Item>
          )}
        </Form>
      </Modal>
      <Modal open={!!correcting} title="Correct a reading" okText="Save correction" confirmLoading={saving} onOk={() => single(correct)} onCancel={() => setCorrecting(null)} destroyOnHidden>
        {correcting && (
          <Typography.Paragraph type="secondary">
            {correcting.typeName} {correcting.value} {correcting.unit}, {formatDateTime(correcting.takenAt)}. The original stays, marked corrected.
          </Typography.Paragraph>
        )}
        <Form form={fixForm} layout="vertical" requiredMark>
          <Form.Item label="Right value" name="value" rules={[{ required: true, message: 'Enter the right value' }]}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="What was wrong" name="reason" rules={[{ required: true, message: 'Say what was wrong' }]}>
            <Input maxLength={500} placeholder="e.g. Misread the gauge" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
