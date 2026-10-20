'use client';

import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Button, Col, Form, Input, Modal, Popconfirm, Row, Space, Typography } from 'antd';
import { useState } from 'react';
import { vendorSchema, type VendorRow } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { RequirePermission } from '@/components/RequirePermission';
import { ContactLine } from '@/components/VendorCards';
import { api, useFetch } from '@/lib/api';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';

// The suppliers directory: companies that sell or service equipment, and the people to call there. The asset form
// picks the supplier and service vendor from this list.
function VendorsScreen() {
  const { message } = App.useApp();
  const vendors = useFetch<VendorRow[]>('/vendors');
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<VendorRow | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const single = useSingleFlight();

  function open(row: VendorRow | 'new') {
    form.resetFields();
    form.setFieldsValue(row === 'new' ? { contacts: [] } : row);
    setEditing(row);
  }

  async function save() {
    const v = form.getFieldsValue();
    const input = parseForm(form, vendorSchema, { ...v, contacts: v.contacts ?? [] });
    if (!input) return;
    setSaving(true);
    try {
      if (editing === 'new') await api('/vendors', { body: input });
      else await api(`/vendors/${(editing as VendorRow).id}`, { method: 'PUT', body: input });
      message.success(editing === 'new' ? `${input.name} added` : `${input.name} updated`);
      setEditing(null);
      void vendors.reload();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: VendorRow) {
    try {
      await api(`/vendors/${row.id}`, { method: 'DELETE' });
      message.success(`${row.name} removed`);
      void vendors.reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not remove');
    }
  }

  const count = (n: number) => (n ? `${n} ${n === 1 ? 'asset' : 'assets'}` : '—');
  const q = search.trim().toLowerCase();
  const rows = vendors.data?.filter((v) => !q || v.name.toLowerCase().includes(q) || v.contacts.some((c) => c.name.toLowerCase().includes(q))) ?? null;

  return (
    <>
      <PageHeader
        title="Suppliers"
        subtitle="Companies that sell and service your equipment, and who to call there"
        crumbs={['Equipment', 'Suppliers']}
        action={
          <Button type="primary" onClick={() => open('new')}>
            Add company
          </Button>
        }
      />
      <Input.Search allowClear placeholder="Search company or contact" aria-label="Search company or contact" style={{ maxWidth: 360, marginBottom: 16 }} onChange={(e) => setSearch(e.target.value)} />
      <DataTable<VendorRow>
        rows={rows}
        loading={vendors.loading}
        error={vendors.error}
        onRetry={vendors.reload}
        emptyText={q ? 'No company or contact matches that.' : 'No companies yet. Add the first one.'}
        columns={[
          {
            title: 'Company',
            dataIndex: 'name',
            className: 'm-title',
            render: (name: string, r) => (
              <Space direction="vertical" size={0}>
                <strong>{name}</strong>
                {(r.phone || r.email) && (
                  <Typography.Text type="secondary">
                    {r.phone && <a href={`tel:${r.phone}`} style={{ whiteSpace: 'nowrap' }}>{r.phone}</a>}
                    {r.phone && r.email && ' · '}
                    {r.email && <a href={`mailto:${r.email}`}>{r.email}</a>}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: 'Contacts',
            key: 'contacts',
            className: 'm-plain',
            render: (_: unknown, r) =>
              r.contacts.length ? (
                <Space direction="vertical" size={0}>
                  {r.contacts.map((c) => <ContactLine key={c.id} c={c} />)}
                </Space>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          { title: 'Supplied', dataIndex: 'suppliedCount', align: 'right', render: count },
          { title: 'Services', dataIndex: 'servicedCount', align: 'right', render: count },
          {
            title: <span className="sr-only">Actions</span>,
            key: 'actions',
            align: 'right',
            className: 'm-end',
            render: (_: unknown, row) => (
              <Space>
                <Button size="small" type="text" onClick={() => open(row)}>
                  Edit
                </Button>
                {row.suppliedCount + row.servicedCount === 0 && (
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
      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'Add company' : 'Edit company'}
        okText="Save"
        confirmLoading={saving}
        onOk={() => single(save)}
        onCancel={() => setEditing(null)}
        width={640}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="Company name" name="name" rules={[{ required: true, message: 'Enter the company name' }]}>
            <Input maxLength={150} placeholder="e.g. Philips Healthcare" />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item label="Phone" name="phone">
                <Input maxLength={30} inputMode="tel" placeholder="Office or helpline" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="Email" name="email">
                <Input maxLength={150} inputMode="email" placeholder="service@company.com" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="Address" name="address">
            <Input.TextArea rows={2} maxLength={300} />
          </Form.Item>
          <Form.List name="contacts">
            {(items, { add, remove: drop }) => (
              <Form.Item label="People to call">
                <Space direction="vertical" style={{ width: '100%' }}>
                  {items.map(({ key, name }) => (
                    <Row key={key} gutter={8} wrap align="top">
                      <Col xs={24} sm={7}>
                        <Form.Item name={[name, 'name']} rules={[{ required: true, message: 'Enter the name' }]} style={{ marginBottom: 8 }}>
                          <Input maxLength={120} placeholder="Name" aria-label="Contact name" />
                        </Form.Item>
                      </Col>
                      <Col xs={24} sm={5}>
                        <Form.Item name={[name, 'role']} style={{ marginBottom: 8 }}>
                          <Input maxLength={80} placeholder="Role" aria-label="Contact role" />
                        </Form.Item>
                      </Col>
                      <Col xs={12} sm={5}>
                        <Form.Item name={[name, 'phone']} style={{ marginBottom: 8 }}>
                          <Input maxLength={30} inputMode="tel" placeholder="Phone" aria-label="Contact phone" />
                        </Form.Item>
                      </Col>
                      <Col xs={10} sm={6}>
                        <Form.Item name={[name, 'email']} style={{ marginBottom: 8 }}>
                          <Input maxLength={150} inputMode="email" placeholder="Email" aria-label="Contact email" />
                        </Form.Item>
                      </Col>
                      <Col xs={2} sm={1}>
                        <Button type="text" icon={<MinusCircleOutlined />} aria-label="Remove this contact" onClick={() => drop(name)} />
                      </Col>
                    </Row>
                  ))}
                  <Button icon={<PlusOutlined />} onClick={() => add({})} disabled={items.length >= 30}>
                    Add a contact
                  </Button>
                </Space>
              </Form.Item>
            )}
          </Form.List>
          <Form.Item label="Notes" name="notes">
            <Input.TextArea rows={2} maxLength={1000} placeholder="e.g. Authorised for Philips ventilators in Gujarat" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export default function VendorsPage() {
  return (
    <RequirePermission code="asset.edit" what="change the suppliers list">
      <VendorsScreen />
    </RequirePermission>
  );
}
