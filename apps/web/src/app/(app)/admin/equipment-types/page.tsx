'use client';

import { App, Button, Form, Input, InputNumber, Modal, Popconfirm, Space } from 'antd';
import { useState } from 'react';
import { equipmentTypeSchema } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { api, useFetch } from '@/lib/api';
import { parseForm, showApiFieldErrors } from '@/lib/forms';

type EquipmentType = {
  id: string;
  name: string;
  code: string;
  defaultPmsMonths: number | null;
  defaultCalibrationMonths: number | null;
};

export default function EquipmentTypesPage() {
  const { message } = App.useApp();
  const types = useFetch<EquipmentType[]>('/equipment-types');
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<EquipmentType | 'new' | null>(null);
  const [saving, setSaving] = useState(false);

  function open(row: EquipmentType | 'new') {
    form.resetFields();
    form.setFieldsValue(row === 'new' ? {} : row);
    setEditing(row);
  }

  async function save() {
    const input = parseForm(form, equipmentTypeSchema, {
      ...form.getFieldsValue(),
      defaultPmsMonths: form.getFieldValue('defaultPmsMonths') ?? null,
      defaultCalibrationMonths: form.getFieldValue('defaultCalibrationMonths') ?? null,
    });
    if (!input) return;
    setSaving(true);
    try {
      if (editing === 'new') await api('/equipment-types', { body: input });
      else await api(`/equipment-types/${(editing as EquipmentType).id}`, { method: 'PATCH', body: input });
      message.success(editing === 'new' ? `${input.name} added` : 'Equipment type updated');
      setEditing(null);
      types.reload();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: EquipmentType) {
    try {
      await api(`/equipment-types/${row.id}`, { method: 'DELETE' });
      message.success(`${row.name} removed`);
      types.reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not remove');
    }
  }

  const months = (v: number | null) => (v ? `${v} months` : '—');

  return (
    <>
      <PageHeader
        title="Equipment types"
        subtitle="Default PMS and calibration intervals for each kind of equipment"
        crumbs={['Admin', 'Equipment types']}
        action={
          <Button type="primary" onClick={() => open('new')}>
            Add equipment type
          </Button>
        }
      />
      <DataTable<EquipmentType>
        rows={types.data}
        loading={types.loading}
        error={types.error}
        onRetry={types.reload}
        emptyText="No equipment types yet. Add the first one."
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Code', dataIndex: 'code' },
          { title: 'Default PMS', dataIndex: 'defaultPmsMonths', align: 'right', render: months },
          { title: 'Default calibration', dataIndex: 'defaultCalibrationMonths', align: 'right', render: months },
          {
            title: '',
            key: 'actions',
            align: 'right',
            render: (_: unknown, row) => (
              <Space>
                <Button size="small" onClick={() => open(row)}>
                  Edit
                </Button>
                <Popconfirm title={`Remove ${row.name}?`} description="Not possible if assets already use it." okText="Remove" onConfirm={() => remove(row)}>
                  <Button size="small" danger>
                    Remove
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'Add equipment type' : 'Edit equipment type'}
        okText="Save"
        confirmLoading={saving}
        onOk={save}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Enter a name' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Code" name="code" extra="2–10 letters or digits, used in asset IDs (e.g. VENT)." rules={[{ required: true, message: 'Enter a code' }]}>
            <Input style={{ textTransform: 'uppercase' }} />
          </Form.Item>
          <Form.Item label="Default PMS interval (months)" name="defaultPmsMonths">
            <InputNumber min={1} max={120} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Default calibration interval (months)" name="defaultCalibrationMonths">
            <InputNumber min={1} max={120} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
