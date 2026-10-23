'use client';

import { Alert, App, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch } from 'antd';
import { useState } from 'react';
import { REGISTERS, TEAM_LABEL, tradeSchema, type Register, type TradeRow } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { Pill } from '@/components/StatusTag';
import { RequirePermission } from '@/components/RequirePermission';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';

// What a ward fault without a machine can be about (facility add-on, decision J): the team it goes to and how soon
// work should start. The Medical gas trade follows Hospital settings > Medical gases.
function TradesScreen() {
  const { message } = App.useApp();
  const trades = useFetch<TradeRow[]>('/trades');
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<TradeRow | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const single = useSingleFlight();
  const gas = editing !== 'new' && editing?.medicalGas;

  function open(row: TradeRow | 'new') {
    form.resetFields();
    form.setFieldsValue(row === 'new' ? { register: 'facility', active: true } : row);
    setEditing(row);
  }

  async function save() {
    const input = parseForm(form, tradeSchema, { ...form.getFieldsValue(), responseHours: form.getFieldValue('responseHours') ?? null });
    if (!input) return;
    setSaving(true);
    try {
      if (editing === 'new') await api('/trades', { body: input });
      else await api(`/trades/${(editing as TradeRow).id}`, { method: 'PATCH', body: input });
      message.success(editing === 'new' ? `${input.name} added` : 'Trade updated');
      setEditing(null);
      trades.reload();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: TradeRow) {
    try {
      await api(`/trades/${row.id}`, { method: 'DELETE' });
      message.success(`${row.name} removed`);
      trades.reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not remove');
    }
  }

  return (
    <>
      <PageHeader
        title="Trades"
        subtitle="What a ward can report without a machine, which team it goes to, and how soon work should start"
        crumbs={['Admin', 'Trades']}
        action={
          <Button type="primary" onClick={() => open('new')}>
            Add trade
          </Button>
        }
      />
      <DataTable<TradeRow>
        rows={trades.data}
        loading={trades.loading}
        error={trades.error}
        onRetry={trades.reload}
        emptyText="No trades yet. Add the first one."
        columns={[
          {
            title: 'Trade',
            dataIndex: 'name',
            className: 'm-title',
            render: (v: string, t) => (
              <Space size={6} wrap>
                {v}
                {!t.active && <Pill tone="neutral">Switched off</Pill>}
                {t.medicalGas && <Pill tone="info">Medical gas</Pill>}
              </Space>
            ),
          },
          { title: 'Goes to', dataIndex: 'register', render: (r: Register) => TEAM_LABEL[r] },
          { title: 'Response target', dataIndex: 'responseHours', align: 'right', render: (h: number | null) => (h ? `${h} h` : '—') },
          { title: 'Complaints', dataIndex: 'complaintCount', align: 'right', className: 'm-hide' },
          {
            title: <span className="sr-only">Actions</span>,
            key: 'actions',
            align: 'right',
            render: (_: unknown, row) => (
              <Space>
                <Button size="small" type="text" onClick={() => open(row)}>
                  Edit
                </Button>
                {!row.medicalGas && !row.complaintCount && (
                  <Popconfirm title={`Remove ${row.name}?`} okText="Remove" okButtonProps={{ danger: true }} onConfirm={() => remove(row)}>
                    <Button size="small" type="text" danger>
                      Remove
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal open={editing !== null} title={editing === 'new' ? 'Add trade' : 'Edit trade'} okText="Save" confirmLoading={saving} onOk={() => single(save)} onCancel={() => setEditing(null)} destroyOnHidden>
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Enter a name' }]}>
            <Input maxLength={60} placeholder="e.g. Electrical" />
          </Form.Item>
          {gas ? (
            <Alert type="info" showIcon style={{ marginBottom: 16 }} message={`Goes to the ${TEAM_LABEL[(editing as TradeRow).register].toLowerCase()}`} description="The medical gas trade follows Hospital settings > Medical gases." />
          ) : (
            <Form.Item label="Goes to" name="register" extra="New complaints go to this team; ones already raised stay with theirs.">
              <Select options={REGISTERS.map((r) => ({ value: r, label: TEAM_LABEL[r] }))} />
            </Form.Item>
          )}
          <Form.Item label="Response target (hours)" name="responseHours" extra="Optional. Complaints where work starts later than this are flagged.">
            <InputNumber min={1} max={720} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Wards can choose it" name="active" valuePropName="checked" extra="Switch off a trade you no longer use; its complaints keep it.">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export default function TradesPage() {
  const { user } = useAuth();
  if (user && !user.registers.includes('facility')) {
    return <Alert type="info" showIcon message="Trades are part of the facility maintenance add-on, which is off." />;
  }
  return (
    <RequirePermission code="setup.manage" what="change trades">
      <TradesScreen />
    </RequirePermission>
  );
}
