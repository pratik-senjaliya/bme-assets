'use client';

import { App, Form, Input, Modal, Typography, Upload } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { MAX_UPLOAD_BYTES, condemnRequestSchema, deleteRequestSchema, type DeletableTarget } from '@bme/shared';
import { api } from '@/lib/api';
import { parseForm, showApiFieldErrors } from '@/lib/forms';

// Condemning and deleting are requests: nothing changes until the Biomedical HOD approves.
export function RequestCondemnModal({ open, asset, onClose, onRequested }: { open: boolean; asset: { id: string; assetCode: string }; onClose: () => void; onRequested: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ reason: string }>();
  const [letter, setLetter] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  // Start clean each time it opens (not after the opening animation, which would wipe what was just typed).
  useEffect(() => {
    if (open) {
      form.resetFields();
      setLetter(null);
    }
  }, [open, form]);

  async function save() {
    const input = parseForm(form, condemnRequestSchema, form.getFieldsValue());
    if (!input) return;
    const body = new FormData();
    body.set('reason', input.reason);
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
      onOk={save}
      onCancel={onClose}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        The asset stays active until the HOD approves. Once condemned it leaves the active lists and reminders, can no longer be edited, and keeps its ID and full history.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item label="Why should it be condemned?" name="reason" rules={[{ required: true, message: 'Say why' }]}>
          <Input.TextArea rows={4} maxLength={1000} showCount />
        </Form.Item>
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

export type DeleteTarget = { type: DeletableTarget; id: string; label: string };

export function RequestDeleteModal({ target, onClose, onRequested }: { target: DeleteTarget | null; onClose: () => void; onRequested: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ reason: string }>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target) form.resetFields();
  }, [target, form]);

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
      onOk={save}
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
