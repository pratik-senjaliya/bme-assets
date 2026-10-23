'use client';

import { LockOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Descriptions, Form, Input, InputNumber, Select, Space, Switch, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { updateSettingsSchema, type RunRemindersResult, type SettingsResponse } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { api, clearFetchCache, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { parseForm, showApiFieldErrors } from '@/lib/forms';
import { RequirePermission } from '@/components/RequirePermission';
import { FormPageSkeleton } from '@/components/Skeletons';
import { formatDateTime, formatSize } from '@/lib/format';

function SettingsPageScreen() {
  const { message } = App.useApp();
  const { can, user, refresh } = useAuth();
  const vendor = user?.role === 'super_admin'; // only the vendor switches add-ons on (decision K)
  const settings = useFetch<SettingsResponse>('/settings', { fresh: true });
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState<'test' | 'run' | null>(null);

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
      criticalDowntimeHours: values.criticalDowntimeHours,
      complaintCloseDays: values.complaintCloseDays,
      transfersEnabled: values.transfersEnabled,
      ...(vendor && { facilityEnabled: values.facilityEnabled }),
      biomedContact: values.biomedContact ?? null,
      idleLogoutMinutes: values.idleLogoutMinutes ?? 0,
      labelBaseUrl: values.labelBaseUrl ?? null,
      smtpHost: values.smtpHost ?? null,
      smtpPort: values.smtpPort ?? null,
      smtpUser: values.smtpUser ?? null,
      smtpFrom: values.smtpFrom ?? null,
      smtpPassword: values.smtpPassword || undefined,
      // Only send the pattern when it can actually be changed.
      ...(patternDisabled ? {} : { assetIdPattern: values.assetIdPattern }),
    });
    if (!input) return;
    setSaving(true);
    try {
      await api('/settings', { method: 'PUT', body: input });
      message.success('Settings saved');
      // The add-on changes what everyone sees: start from a clean slate (menus, lists, who I am).
      if (vendor && input.facilityEnabled !== settings.data?.facilityEnabled) {
        clearFetchCache();
        await refresh();
      }
      form.setFieldValue('smtpPassword', undefined);
      settings.reload();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }


  async function sendTest() {
    setBusy('test');
    try {
      await api('/settings/smtp-test', { body: { to: testTo } });
      message.success(`Test email sent to ${testTo}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy(null);
    }
  }

  async function runReminders() {
    setBusy('run');
    try {
      const r = await api<RunRemindersResult>('/reminders/run', { method: 'POST' });
      message.success(r.created ? `${r.created} new reminders created${r.emailed ? `, ${r.emailed} emailed` : ''}` : 'Nothing new to remind about');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not run');
    } finally {
      setBusy(null);
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
      {settings.loading && !settings.data && <FormPageSkeleton sections={2} />}
      {settings.data && (
        <Form form={form} layout="vertical" requiredMark>
          <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 640 }}>
            <Card title="Hospital and asset IDs">
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
            <Form.Item
              label="Critical equipment downtime limit (hours)"
              name="criticalDowntimeHours"
              extra="A breakdown on Critical or Most critical equipment that runs longer than this is flagged on the complaints board, history and the critical downtime report."
            >
              <InputNumber min={1} max={720} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item
              label="Close resolved complaints after (days)"
              name="complaintCloseDays"
              extra="Whoever raised a complaint closes it once the equipment works again. If they have not after this many days, it closes by itself. Downtime is not affected."
            >
              <InputNumber min={1} max={30} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item
              label="Transfers to other units"
              name="transfersEnabled"
              valuePropName="checked"
              extra="For hospitals with other units. Equipment can then be transferred to another unit with the HOD's approval; it keeps its history here, marked transferred."
            >
              <Switch aria-label="Allow transfers to other units" />
            </Form.Item>
            <Form.Item
              label="Facility maintenance"
              name="facilityEnabled"
              valuePropName="checked"
              extra={
                vendor
                  ? 'The add-on for the maintenance team: DG sets, chillers, lifts, UPS and other facility equipment, with their own staff, complaints, PMS and stock. Off: none of it shows.'
                  : 'An add-on for the maintenance team (DG sets, chillers, lifts, UPS…). Switched on by your vendor.'
              }
            >
              <Switch aria-label="Facility maintenance add-on" disabled={!vendor} />
            </Form.Item>
            <Form.Item
              label="Biomedical contact for the wards"
              name="biomedContact"
              extra="Shown to nursing on their dashboard and when they raise a complaint, for emergencies."
            >
              <Input maxLength={200} placeholder="e.g. Biomedical on call: 98250 00000, ext. 214" />
            </Form.Item>
            <Form.Item
              label="Sign out after inactivity (minutes)"
              name="idleLogoutMinutes"
              extra="For shared ward computers: a login that has not been used for this long is signed out, so the next person does not act under someone else's name. 0 = never."
            >
              <InputNumber min={0} max={720} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item
              label="Address on QR labels"
              name="labelBaseUrl"
              extra="The address staff use on the hospital network, e.g. http://bme.hospital.local. QR labels open it whichever computer prints them. Leave empty to use the address the labels are printed from."
            >
              <Input maxLength={200} placeholder="http://bme.hospital.local" />
            </Form.Item>
            </Card>
          <Card title="Email for reminders (optional)">
            <Typography.Paragraph type="secondary">
              Reminders always appear in the app. If this server can reach a mail server, they are also emailed once a day. Leave the host empty to keep reminders in-app only.
            </Typography.Paragraph>
            {/* The last attempt, so a mail server that stopped working is noticed here (gap review #21). */}
            {settings.data.mailLastError && (!settings.data.mailLastSentAt || settings.data.mailLastErrorAt! > settings.data.mailLastSentAt) ? (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                message={`The last email could not be sent (${formatDateTime(settings.data.mailLastErrorAt)})`}
                description={`${settings.data.mailLastError}. Check the settings below and send a test email.`}
              />
            ) : (
              settings.data.mailLastSentAt && <Alert type="success" showIcon style={{ marginBottom: 16 }} message={`Email is working: last sent ${formatDateTime(settings.data.mailLastSentAt)}`} />
            )}
              <Form.Item label="SMTP host" name="smtpHost"><Input placeholder="smtp.hospital.local" /></Form.Item>
              <Space wrap align="start" size={16}>
                <Form.Item label="Port" name="smtpPort"><InputNumber min={1} max={65535} placeholder="587" /></Form.Item>
                <Form.Item label="Username" name="smtpUser"><Input autoComplete="off" style={{ width: 200 }} /></Form.Item>
                <Form.Item label="Password" name="smtpPassword" extra={settings.data.smtpPasswordSet ? 'A password is saved. Leave blank to keep it.' : undefined}>
                  <Input.Password autoComplete="new-password" style={{ width: 200 }} />
                </Form.Item>
              </Space>
              <Form.Item label="From address" name="smtpFrom"><Input placeholder="bme@hospital.local" /></Form.Item>
            <Space wrap>
              <Input aria-label="Send a test email to" placeholder="Send a test to…" style={{ width: 240 }} value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              <Button loading={busy === 'test'} disabled={!testTo || !settings.data.smtpHost} onClick={sendTest}>Send test email</Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>Save the settings first, then send a test.</Typography.Paragraph>
          </Card>
          <Card title="Reminders">
            <Typography.Paragraph type="secondary">
              The check runs automatically every day at 06:00. Run it now after changing lead times, or to show how it works. It never sends the same reminder twice.
            </Typography.Paragraph>
            <Button loading={busy === 'run'} onClick={runReminders}>Run reminders now</Button>
          </Card>
          {/* For support: which release runs here and whether the daily job and the disk are fine (gap review #24). */}
          <Card title="System">
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="Version">{settings.data.system.version}</Descriptions.Item>
              <Descriptions.Item label="Daily check last ran">{settings.data.system.dailyJobLastRunAt ? formatDateTime(settings.data.system.dailyJobLastRunAt) : 'Not yet'}</Descriptions.Item>
              {settings.data.system.storageFreeBytes != null && settings.data.system.storageTotalBytes != null && (
                <Descriptions.Item label="Free space for documents">
                  {formatSize(settings.data.system.storageFreeBytes)} of {formatSize(settings.data.system.storageTotalBytes)}
                </Descriptions.Item>
              )}
            </Descriptions>
          </Card>
          {/* Written by the nightly backup on the hospital server (deploy/backup.sh). The daily check tells the HOD if
              it failed or stopped (gap review #23). */}
          <Card title="Backups">
            {!settings.data.backupLastAt && !settings.data.backupLastErrorAt ? (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                No backup has been recorded on this server. On the hospital server the backup runs every night by itself (see the install guide); a hosted demo is backed up by its provider.
              </Typography.Paragraph>
            ) : settings.data.backupLastErrorAt && (!settings.data.backupLastAt || settings.data.backupLastErrorAt > settings.data.backupLastAt) ? (
              <Alert
                type="error"
                showIcon
                message={`The last backup failed (${formatDateTime(settings.data.backupLastErrorAt)})`}
                description={`${settings.data.backupLastError ?? 'No details'}. Ask whoever looks after the server to check it (docker compose logs backup).`}
              />
            ) : (
              <Alert type="success" showIcon message={`Last backup: ${formatDateTime(settings.data.backupLastAt)}`} description="Copy the backups folder off the server regularly: a backup on the same disk does not survive the disk failing." />
            )}
          </Card>
          </Space>
        </Form>
      )}
    </>
  );
}


export default function SettingsPage() {
  return (
    <RequirePermission code="setup.manage" what="change hospital settings">
      <SettingsPageScreen />
    </RequirePermission>
  );
}
