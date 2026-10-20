'use client';

import { App, DatePicker, Form, Input, InputNumber, Modal, Select, Typography, Upload } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { CONDEMN_REASON_LABEL, CONDEMN_REASONS, MAX_UPLOAD_BYTES, condemnRequestSchema, deleteRequestSchema, transferRequestSchema, type DeletableTarget } from '@bme/shared';
import { api } from '@/lib/api';
import { moneyInputProps } from '@/lib/format';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';

// Condemning, transferring and deleting are requests: nothing changes until the Biomedical HOD approves.
// The condemnation request is the committee's form: reason, details, estimated value today and the committee date.
export function RequestCondemnModal({ open, asset, onClose, onRequested }: { open: boolean; asset: { id: string; assetCode: string }; onClose: () => void; onRequested: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ reasonCategory?: string; reason: string; estimatedValue?: number; committeeDate?: Dayjs }>();
  const [letter, setLetter] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  // Start clean each time it opens (not after the opening animation, which would wipe what was just typed).
  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ committeeDate: dayjs() });
      setLetter(null);
    }
  }, [open, form]);

  const single = useSingleFlight();

  async function save() {
    const v = form.getFieldsValue();
    const input = parseForm(form, condemnRequestSchema, { ...v, committeeDate: v.committeeDate?.format('YYYY-MM-DD') });
    if (!input) return;
    const body = new FormData();
    body.set('reasonCategory', input.reasonCategory);
    body.set('reason', input.reason);
    body.set('estimatedValue', String(input.estimatedValue));
    body.set('committeeDate', input.committeeDate);
    if (letter) body.set('file', letter);
    setSaving(true);
    try {
      await api(`/assets/${asset.id}/condemn`, { body });
      message.success('Condemnation request sent to the HOD');
      onClose();
      onRequested();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not send the request');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={`Request condemnation · ${asset.assetCode}`}
      okText="Send request"
      okButtonProps={{ danger: true }}
      confirmLoading={saving}
      onOk={() => single(save)}
      onCancel={onClose}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        The asset stays active until the HOD approves. Once condemned it leaves the active lists and reminders, can no longer be edited, and keeps its ID and full history.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item label="Reason" name="reasonCategory" rules={[{ required: true, message: 'Choose the reason' }]}>
          <Select placeholder="Choose the reason" options={CONDEMN_REASONS.map((r) => ({ value: r, label: CONDEMN_REASON_LABEL[r] }))} />
        </Form.Item>
        <Form.Item label="Details" name="reason" rules={[{ required: true, message: 'Say why' }]}>
          <Input.TextArea rows={3} maxLength={1000} showCount placeholder="What happened, for the committee: e.g. the OEM no longer supplies the display board." />
        </Form.Item>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Form.Item label="Estimated value today" name="estimatedValue" rules={[{ required: true, message: 'Enter the value (0 if it has none)' }]} style={{ flex: '1 1 200px' }}>
            <InputNumber {...moneyInputProps} min={0} style={{ width: '100%' }} placeholder="e.g. 50,000" />
          </Form.Item>
          <Form.Item label="Condemnation committee date" name="committeeDate" rules={[{ required: true, message: 'Pick the date' }]} style={{ flex: '1 1 200px' }}>
            <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
          </Form.Item>
        </div>
        <Form.Item label="End-of-life letter (optional)" extra="The manufacturer's or vendor's letter, if you have one.">
          <Upload.Dragger
            accept=".pdf,.jpg,.jpeg,.png"
            maxCount={1}
            fileList={letter ? [{ uid: '1', name: letter.name, status: 'done' }] : []}
            onRemove={() => setLetter(null)}
            beforeUpload={(f) => {
              if (f.size > MAX_UPLOAD_BYTES) message.error('That file is over 10 MB');
              else setLetter(f);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p className="ant-upload-text">Drop the letter here or click to choose</p>
            <p className="ant-upload-hint">PDF, JPG or PNG, up to 10 MB</p>
          </Upload.Dragger>
        </Form.Item>
      </Form>
    </Modal>
  );
}

// Permanently to another unit of the group. Offered only where the hospital has turned transfers on.
export function RequestTransferModal({ open, asset, onClose, onRequested }: { open: boolean; asset: { id: string; assetCode: string }; onClose: () => void; onRequested: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ toUnit: string; reason: string }>();
  const [saving, setSaving] = useState(false);
  const single = useSingleFlight();
  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  async function save() {
    const input = parseForm(form, transferRequestSchema, form.getFieldsValue());
    if (!input) return;
    setSaving(true);
    try {
      await api(`/assets/${asset.id}/transfer`, { body: input });
      message.success('Transfer request sent to the HOD');
      onClose();
      onRequested();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not send the request');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title={`Request transfer · ${asset.assetCode}`} okText="Send request" confirmLoading={saving} onOk={() => single(save)} onCancel={onClose} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Nothing changes until the HOD approves. Then it leaves this hospital&apos;s active lists, reminders and open complaints, and keeps its ID and full history here, marked transferred. The other unit registers it afresh.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item label="Transfer to" name="toUnit" rules={[{ required: true, message: 'Name the unit' }]}>
          <Input maxLength={150} placeholder="e.g. Indore unit" />
        </Form.Item>
        <Form.Item label="Why?" name="reason" rules={[{ required: true, message: 'Say why' }]}>
          <Input.TextArea rows={3} maxLength={1000} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export type DeleteTarget = { type: DeletableTarget; id: string; label: string };

export function RequestDeleteModal({ target, onClose, onRequested }: { target: DeleteTarget | null; onClose: () => void; onRequested: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ reason: string }>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target) form.resetFields();
  }, [target, form]);

  const single = useSingleFlight();

  async function save() {
    if (!target) return;
    const input = parseForm(form, deleteRequestSchema, { targetType: target.type, targetId: target.id, reason: form.getFieldValue('reason') });
    if (!input) return;
    setSaving(true);
    try {
      await api('/approvals/delete', { body: input });
      message.success('Deletion request sent to the HOD');
      onClose();
      onRequested();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not send the request');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!target}
      title="Request deletion of a wrong entry"
      okText="Send request"
      okButtonProps={{ danger: true }}
      confirmLoading={saving}
      onOk={() => single(save)}
      onCancel={onClose}
      destroyOnHidden
    >
      <Typography.Paragraph>
        <strong>{target?.label}</strong>
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">It is removed only if the HOD approves. The removal is kept in the audit log.</Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item label="Why is this entry wrong?" name="reason" rules={[{ required: true, message: 'Say why' }]}>
          <Input.TextArea rows={3} maxLength={1000} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}
