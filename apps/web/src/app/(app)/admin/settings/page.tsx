'use client';

import { LockOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Form, Input, Select, Skeleton, Tooltip } from 'antd';
import { useEffect, useState } from 'react';
import { updateSettingsSchema, type SettingsResponse } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { parseForm, showApiFieldErrors } from '@/lib/forms';

export default function SettingsPage() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const settings = useFetch<SettingsResponse>('/settings');
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings.data) form.setFieldsValue(settings.data);
  }, [settings.data, form]);

  // The pattern is for the vendor's super admin, and locks once the first asset exists.
  const patternDisabled = !can('settings.pattern') || !!settings.data?.patternLocked;
  const patternReason = settings.data?.patternLocked
    ? 'Locked because assets already exist, so existing asset IDs never change.'
    : 'Only the super admin can change this.';

  async function save() {
    const values = form.getFieldsValue();
    const input = parseForm(form, updateSettingsSchema, {
      name: values.name,
      shortCode: values.shortCode,
      reminderDays: values.reminderDays,
      // Only send the pattern when it can actually be changed.
      ...(patternDisabled ? {} : { assetIdPattern: values.assetIdPattern }),
    });
    if (!input) return;
    setSaving(true);
    try {
      await api('/settings', { method: 'PUT', body: input });
      message.success('Settings saved');
      settings.reload();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Hospital settings"
        subtitle="Name, asset ID pattern and reminder lead times"
        crumbs={['Admin', 'Hospital settings']}
        action={
          <Button type="primary" onClick={save} loading={saving} disabled={!settings.data}>
            Save changes
          </Button>
        }
      />
      {settings.error && <Alert type="error" showIcon message="Could not load settings" description={settings.error} />}
      {settings.loading && !settings.data && <Skeleton active />}
      {settings.data && (
        <Card style={{ maxWidth: 640 }}>
          <Form form={form} layout="vertical" requiredMark>
            <Form.Item label="Hospital name" name="name" rules={[{ required: true, message: 'Enter the hospital name' }]}>
              <Input />
            </Form.Item>
            <Form.Item label="Short code" name="shortCode" extra="Used as {HOSP} in asset IDs." rules={[{ required: true, message: 'Enter a short code' }]}>
              <Input style={{ width: 160, textTransform: 'uppercase' }} />
            </Form.Item>
            <Form.Item
              label={
                <span>
                  Asset ID pattern{' '}
                  {patternDisabled && (
                    <Tooltip title={patternReason}>
                      <LockOutlined aria-label="Locked" />
                    </Tooltip>
                  )}
                </span>
              }
              name="assetIdPattern"
              extra="Tokens: {HOSP} {DEPT} {TYPE} {LOC} {SEQ:3}. Example: SHL-BME-VENT-ICU1-001"
            >
              <Input disabled={patternDisabled} style={{ fontVariantNumeric: 'tabular-nums' }} />
            </Form.Item>
            <Form.Item
              label="Reminder lead times (days before due)"
              name="reminderDays"
              extra="In-app reminders for PMS, calibration, warranty and contracts."
            >
              <Select
                mode="tags"
                tokenSeparators={[',', ' ']}
                open={false}
                onChange={(v: string[]) => form.setFieldValue('reminderDays', v.map(Number).filter((n) => Number.isInteger(n) && n > 0))}
              />
            </Form.Item>
          </Form>
        </Card>
      )}
    </>
  );
}
