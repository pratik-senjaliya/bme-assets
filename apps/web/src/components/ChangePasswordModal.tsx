'use client';

import { App, Form, Input, Modal } from 'antd';
import { useState } from 'react';
import { changePasswordSchema } from '@bme/shared';
import { api } from '@/lib/api';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';

// Everyone can change their own password. The current one is asked for, so a PC left signed in cannot be used to
// take over the account.
export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ currentPassword: string; newPassword: string; confirm: string }>();
  const [saving, setSaving] = useState(false);

  const single = useSingleFlight();

  async function save() {
    const v = form.getFieldsValue();
    if (v.newPassword !== v.confirm) {
      form.setFields([{ name: 'confirm', errors: ['The two passwords do not match'] }]);
      return;
    }
    const input = parseForm(form, changePasswordSchema, { currentPassword: v.currentPassword ?? '', newPassword: v.newPassword ?? '' });
    if (!input) return;
    setSaving(true);
    try {
      await api('/auth/password', { body: input });
      message.success('Password changed. Use the new one next time you sign in.');
      onClose();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not change the password');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="Change password" okText="Change password" confirmLoading={saving} onOk={() => single(save)} onCancel={onClose} afterClose={() => form.resetFields()} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item label="Current password" name="currentPassword" rules={[{ required: true, message: 'Enter your current password' }]}>
          <Input.Password autoComplete="current-password" autoFocus />
        </Form.Item>
        <Form.Item label="New password" name="newPassword" extra="At least 8 characters." rules={[{ required: true, message: 'Enter a new password' }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item label="Type the new password again" name="confirm" rules={[{ required: true, message: 'Type it again to be sure' }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
