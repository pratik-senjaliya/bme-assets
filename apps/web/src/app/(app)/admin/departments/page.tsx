'use client';

import { App, Button, Form, Input, Modal, Popconfirm, Select, Space, Tabs } from 'antd';
import { useState } from 'react';
import { departmentSchema, locationSchema } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { api, useFetch } from '@/lib/api';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';
import { RequirePermission } from '@/components/RequirePermission';

type Department = { id: string; name: string; code: string };
type Location = { id: string; departmentId: string; name: string; code: string };
type Editing = { kind: 'department'; row: Department | null } | { kind: 'location'; row: Location | null } | null;

function DepartmentsPageScreen() {
  const { message } = App.useApp();
  const departments = useFetch<Department[]>('/departments');
  const locations = useFetch<Location[]>('/locations');
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<Editing>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('departments');

  const deptName = (id: string) => departments.data?.find((d) => d.id === id)?.name ?? '—';

  function open(next: NonNullable<Editing>) {
    form.resetFields();
    form.setFieldsValue(next.row ?? {});
    setEditing(next);
  }

  const single = useSingleFlight();

  async function save() {
    if (!editing) return;
    const { kind, row } = editing;
    const input = parseForm(form, kind === 'department' ? departmentSchema : locationSchema, form.getFieldsValue());
    if (!input) return;
    const path = kind === 'department' ? '/departments' : '/locations';
    setSaving(true);
    try {
      if (row) await api(`${path}/${row.id}`, { method: 'PATCH', body: input });
      else await api(path, { body: input });
      message.success(`${kind === 'department' ? 'Department' : 'Location'} ${row ? 'updated' : 'added'}`);
      setEditing(null);
      (kind === 'department' ? departments : locations).reload();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function remove(path: string, reload: () => void) {
    try {
      await api(path, { method: 'DELETE' });
      message.success('Removed');
      reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not remove');
    }
  }

  return (
    <>
      <PageHeader
        title="Departments & locations"
        subtitle="Codes are used in generated asset IDs"
        crumbs={['Admin', 'Departments & locations']}
        action={
          <Button type="primary" onClick={() => open(tab === 'departments' ? { kind: 'department', row: null } : { kind: 'location', row: null })}>
            {tab === 'departments' ? 'Add department' : 'Add location'}
          </Button>
        }
      />
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'departments',
            label: 'Departments',
            children: (
              <DataTable<Department>
                rows={departments.data}
                loading={departments.loading}
                error={departments.error}
                onRetry={departments.reload}
                emptyText="No departments yet. Add the first one."
                columns={[
                  { title: 'Name', dataIndex: 'name' },
                  { title: 'Code', dataIndex: 'code' },
                  {
                    title: <span className="sr-only">Actions</span>,
                    key: 'actions',
                    align: 'right',
                    render: (_: unknown, row) => (
                      <Space>
                        <Button size="small" onClick={() => open({ kind: 'department', row })}>
                          Edit
                        </Button>
                        <Popconfirm
                          title={`Remove ${row.name}?`}
                          description="Not possible if assets, locations or users already use it."
                          okText="Remove"
                          onConfirm={() => remove(`/departments/${row.id}`, departments.reload)}
                        >
                          <Button size="small" danger>
                            Remove
                          </Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'locations',
            label: 'Locations',
            children: (
              <DataTable<Location>
                rows={locations.data}
                loading={locations.loading}
                error={locations.error}
                onRetry={locations.reload}
                emptyText="No locations yet. Add the first one."
                columns={[
                  { title: 'Name', dataIndex: 'name' },
                  { title: 'Code', dataIndex: 'code' },
                  { title: 'Department', dataIndex: 'departmentId', render: deptName },
                  {
                    title: <span className="sr-only">Actions</span>,
                    key: 'actions',
                    align: 'right',
                    render: (_: unknown, row) => (
                      <Space>
                        <Button size="small" onClick={() => open({ kind: 'location', row })}>
                          Edit
                        </Button>
                        <Popconfirm
                          title={`Remove ${row.name}?`}
                          description="Not possible if assets already use it."
                          okText="Remove"
                          onConfirm={() => remove(`/locations/${row.id}`, locations.reload)}
                        >
                          <Button size="small" danger>
                            Remove
                          </Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
      <Modal
        open={editing !== null}
        title={`${editing?.row ? 'Edit' : 'Add'} ${editing?.kind ?? ''}`}
        okText="Save"
        confirmLoading={saving}
        onOk={() => single(save)}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark>
          {editing?.kind === 'location' && (
            <Form.Item label="Department" name="departmentId" rules={[{ required: true, message: 'Choose a department' }]}>
              <Select options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
            </Form.Item>
          )}
          <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Enter a name' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Code" name="code" extra="2–10 letters or digits, used in asset IDs (e.g. ICU1)." rules={[{ required: true, message: 'Enter a code' }]}>
            <Input style={{ textTransform: 'uppercase' }} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}


export default function DepartmentsPage() {
  return (
    <RequirePermission code="setup.manage" what="change departments and locations">
      <DepartmentsPageScreen />
    </RequirePermission>
  );
}
