'use client';

import { App, Button, Form, Input, Modal, Popconfirm, Select, Space, Switch } from 'antd';
import { useState } from 'react';
import { ROLE_LABELS, ROLE_NAMES, createUserSchema, updateUserSchema, type RoleName, type UserRow } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { parseForm, showApiFieldErrors } from '@/lib/forms';

type Department = { id: string; name: string };
type FormValues = { name: string; email: string; role: RoleName; departmentId?: string; password?: string; active: boolean };

export default function UsersPage() {
  const { message } = App.useApp();
  const { user: me } = useAuth();
  const users = useFetch<UserRow[]>('/users');
  const departments = useFetch<Department[]>('/departments');
  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const role = Form.useWatch('role', form);

  // Only the super admin can hand out the super admin role.
  const roleOptions = ROLE_NAMES.filter((r) => r !== 'super_admin' || me?.role === 'super_admin').map((r) => ({
    value: r,
    label: ROLE_LABELS[r],
  }));

  function open(row: UserRow | 'new') {
    form.resetFields();
    form.setFieldsValue(
      row === 'new'
        ? { role: 'biomed', active: true }
        : { name: row.name, email: row.email, role: row.role, departmentId: row.departmentId ?? undefined, active: row.active },
    );
    setEditing(row);
  }

  async function save() {
    const isNew = editing === 'new';
    const input = parseForm(form, isNew ? createUserSchema : updateUserSchema, {
      ...form.getFieldsValue(),
      password: form.getFieldValue('password') || undefined,
      departmentId: form.getFieldValue('departmentId') ?? null,
    });
    if (!input) return;
    setSaving(true);
    try {
      if (isNew) await api('/users', { body: input });
      else await api(`/users/${(editing as UserRow).id}`, { method: 'PATCH', body: input });
      message.success(isNew ? `User ${input.name} created` : 'User updated');
      setEditing(null);
      users.reload();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(row: UserRow) {
    try {
      await api(`/users/${row.id}`, { method: 'DELETE' });
      message.success(`${row.name} deactivated`);
      users.reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not deactivate');
    }
  }

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Logins for biomedical and nursing staff"
        crumbs={['Admin', 'Users']}
        action={
          <Button type="primary" onClick={() => open('new')}>
            Add user
          </Button>
        }
      />
      <DataTable<UserRow>
        rows={users.data}
        loading={users.loading}
        error={users.error}
        onRetry={users.reload}
        emptyText="No users yet. Add the first one."
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Email', dataIndex: 'email' },
          { title: 'Role', dataIndex: 'roleLabel' },
          { title: 'Department', dataIndex: 'departmentName', render: (v) => v ?? '—' },
          { title: 'Status', dataIndex: 'active', render: (a: boolean) => <StatusTag status={a ? 'active' : 'inactive'} /> },
          { title: 'Added', dataIndex: 'createdAt', render: formatDate },
          {
            title: '',
            key: 'actions',
            align: 'right',
            render: (_: unknown, row) => (
              <Space>
                <Button size="small" type="text" onClick={() => open(row)}>
                  Edit
                </Button>
                {row.active && row.id !== me?.id && (
                  <Popconfirm
                    title={`Deactivate ${row.name}?`}
                    description="They can no longer sign in. Their history is kept."
                    okText="Deactivate"
                    onConfirm={() => deactivate(row)}
                  >
                    <Button size="small" type="text" danger>
                      Deactivate
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'Add user' : 'Edit user'}
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
          <Form.Item label="Email" name="email" rules={[{ required: true, message: 'Enter an email' }]}>
            <Input type="email" />
          </Form.Item>
          <Form.Item label="Role" name="role" rules={[{ required: true }]}>
            <Select options={roleOptions} />
          </Form.Item>
          {role === 'nursing' && (
            <Form.Item
              label="Department"
              name="departmentId"
              extra="Nursing users only see and raise complaints for this department."
              rules={[{ required: true, message: 'Choose a department' }]}
            >
              <Select options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
            </Form.Item>
          )}
          <Form.Item
            label={editing === 'new' ? 'Password' : 'New password'}
            name="password"
            extra={editing === 'new' ? 'At least 8 characters.' : 'Leave blank to keep the current password.'}
            rules={editing === 'new' ? [{ required: true, message: 'Set a password' }] : []}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          {editing !== 'new' && (
            <Form.Item label="Active" name="active" valuePropName="checked">
              <Switch disabled={typeof editing === 'object' && editing?.id === me?.id} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
}
