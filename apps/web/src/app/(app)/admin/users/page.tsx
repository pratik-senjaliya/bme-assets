'use client';

import { App, Button, Form, Input, Modal, Popconfirm, Select, Space, Switch } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import { DEPUTY_ROLES, ROLE_LABELS, ROLE_NAMES, createUserSchema, updateUserSchema, type HospitalInfo, type RoleName, type UserRow } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { Pill, StatusTag } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';
import { RequirePermission } from '@/components/RequirePermission';
import { COLORS } from '@/theme';

type Department = { id: string; name: string };
type FormValues = { name: string; email: string; username?: string; deputy?: boolean; role: RoleName; departmentId?: string; password?: string; active: boolean };

function UsersPageScreen() {
  const { message } = App.useApp();
  const { user: me } = useAuth();
  const users = useFetch<UserRow[]>('/users');
  const departments = useFetch<Department[]>('/departments');
  const hospital = useFetch<HospitalInfo>('/hospital');
  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const role = Form.useWatch('role', form);

  // Only the super admin can hand out the super admin role.
  // Maintenance staff only where the facility maintenance add-on is on.
  const roleOptions = ROLE_NAMES.filter((r) => (r !== 'super_admin' || me?.role === 'super_admin') && (r !== 'maintenance' || hospital.data?.facilityEnabled || (editing !== 'new' && editing?.role === 'maintenance'))).map((r) => ({
    value: r,
    label: ROLE_LABELS[r],
  }));

  function open(row: UserRow | 'new') {
    form.resetFields();
    form.setFieldsValue(
      row === 'new'
        ? { role: 'biomed', active: true }
        : { name: row.name, email: row.email, username: row.username ?? undefined, deputy: row.deputy, role: row.role, departmentId: row.departmentId ?? undefined, active: row.active },
    );
    setEditing(row);
  }

  const single = useSingleFlight();

  async function save() {
    const isNew = editing === 'new';
    const input = parseForm(form, isNew ? createUserSchema : updateUserSchema, {
      ...form.getFieldsValue(),
      username: form.getFieldValue('username') ?? null,
      deputy: DEPUTY_ROLES.includes(form.getFieldValue('role')) && !!form.getFieldValue('deputy'),
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
          <Space wrap>
            <Link href="/admin/users/import">
              <Button>Import from Excel</Button>
            </Link>
            <Button type="primary" onClick={() => open('new')}>
              Add user
            </Button>
          </Space>
        }
      />
      <DataTable<UserRow>
        rows={users.data}
        loading={users.loading}
        error={users.error}
        onRetry={users.reload}
        emptyText="No users yet. Add the first one."
        columns={[
          { title: 'Name', dataIndex: 'name', className: 'm-title' },
          {
            title: 'Sign-in',
            dataIndex: 'email',
            className: 'm-plain',
            render: (email: string, row) => (
              <div style={{ lineHeight: 1.35 }}>
                <div>{email}</div>
                {row.username && <div className="code" style={{ color: COLORS.muted, fontSize: 12.5 }}>{row.username}</div>}
              </div>
            ),
          },
          { title: 'Role', dataIndex: 'roleLabel', render: (r: string, row) => (row.deputy ? <Space size={4} wrap>{r}<Pill tone="info">Deputy HOD</Pill></Space> : r) },
          { title: 'Department', dataIndex: 'departmentName', render: (v) => v ?? '—' },
          { title: 'Status', dataIndex: 'active', className: 'm-end', render: (a: boolean, row) => (
              <Space size={4} wrap>
                <StatusTag status={a ? 'active' : 'inactive'} />
                {a && row.mustChangePassword && <Pill tone="warn">New password not chosen yet</Pill>}
              </Space>
            ) },
          { title: 'Added', dataIndex: 'createdAt', className: 'm-hide', render: formatDate },
          {
            title: <span className="sr-only">Actions</span>,
            key: 'actions',
            align: 'right',
            // The vendor's super admin login is not the hospital's to change; the server refuses it, so do not offer it.
            render: (_: unknown, row) => row.role === 'super_admin' && me?.role !== 'super_admin' ? <span style={{ color: COLORS.muted }}>Managed by the vendor</span> : (
              <Space>
                <Button size="small" type="text" onClick={() => open(row)}>
                  Edit
                </Button>
                {row.active && row.id !== me?.id && (
                  <Popconfirm
                    title={`Deactivate ${row.name}?`}
                    description="They can no longer sign in. Their history is kept. Complaints assigned to them go back to the board, and the HOD is told."
                    okText="Deactivate"
                    okButtonProps={{ danger: true }}
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
        onOk={() => single(save)}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Enter a name' }]}>
            <Input placeholder="Full name, e.g. Ravi Patel" />
          </Form.Item>
          <Form.Item label="Email" name="email" rules={[{ required: true, message: 'Enter an email' }]}>
            <Input type="email" placeholder="name@hospital.in" />
          </Form.Item>
          <Form.Item label="Username (optional)" name="username" extra="A short name to sign in with instead of the email, e.g. icu.sister1.">
            <Input autoComplete="off" maxLength={30} placeholder="e.g. icu.sister1" />
          </Form.Item>
          <Form.Item label="Role" name="role" rules={[{ required: true }]}>
            <Select options={roleOptions} />
          </Form.Item>
          {DEPUTY_ROLES.includes(role) && (
            <Form.Item
              label="Deputy HOD"
              name="deputy"
              valuePropName="checked"
              extra="Can also decide approvals, assign complaints and put them on hold, for when the HOD is away. Every decision is recorded under their name."
            >
              <Switch aria-label="Deputy HOD" />
            </Form.Item>
          )}
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
            extra={editing === 'new' ? 'At least 8 characters. They choose their own when they first sign in.' : 'Leave blank to keep the current password. A new one must be changed at the next sign-in.'}
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


export default function UsersPage() {
  return (
    <RequirePermission code="user.manage" what="manage users">
      <UsersPageScreen />
    </RequirePermission>
  );
}
