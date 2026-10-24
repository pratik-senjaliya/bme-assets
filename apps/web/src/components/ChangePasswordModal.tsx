'use client';

import { App, Form, Input, Modal, Typography } from 'antd';
import { useState } from 'react';
import { changePasswordSchema } from '@bme/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';

// Everyone can change their own password. The current one is asked for, so a PC left signed in cannot be used to
// take over the account. `required`: a password given by the HOD must be replaced before anything else (cannot be closed).
export function ChangePasswordModal({ open, onClose, required = false, onSignOut }: { open: boolean; onClose: () => void; required?: boolean; onSignOut?: () => void }) {
  const { message } = App.useApp();
  const { refresh } = useAuth();
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
      if (!required) await refresh(); // the change starts a fresh session: its new end time
      message.success(required ? 'Password changed. Welcome!' : 'Password changed. Use the new one next time you sign in.');
      onClose();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not change the password');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={required ? 'Choose your own password' : 'Change password'}
      okText="Change password"
      confirmLoading={saving}
      onOk={() => single(save)}
      onCancel={required ? onSignOut : onClose}
      closable={!required}
      maskClosable={!required}
      keyboard={!required}
      cancelText={required ? 'Sign out' : undefined}
      afterClose={() => form.resetFields()}
      destroyOnHidden
    >
      {required && (
        <Typography.Paragraph type="secondary">
          Your password was set by the Biomedical HOD. Choose one only you know before you start; the HOD will not see it.
        </Typography.Paragraph>
      )}
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item label={required ? 'Password given to you' : 'Current password'} name="currentPassword" rules={[{ required: true, message: 'Enter your current password' }]}>
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
