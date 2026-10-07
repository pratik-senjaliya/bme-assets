'use client';

import { App, Form, Input, Modal, Select } from 'antd';
import { useEffect, useState } from 'react';
import { createComplaintSchema, type AssetRow, type ComplaintRow, type Paged } from '@bme/shared';
import { api } from '@/lib/api';
import { parseForm, showApiFieldErrors } from '@/lib/forms';

type AssetOption = { id: string; assetCode: string; name: string };

// Raise a complaint. With `asset` the equipment is fixed; without it the person searches for it
// (the API only returns equipment they are allowed to see: a nurse's own department).
export function RaiseComplaintModal({
  open,
  asset,
  onClose,
  onRaised,
}: {
  open: boolean;
  asset?: AssetOption;
  onClose: () => void;
  onRaised?: (c: ComplaintRow) => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ assetId?: string; description?: string }>();
  const [options, setOptions] = useState<AssetOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  async function search(text: string) {
    setSearching(true);
    try {
      const res = await api<Paged<AssetRow>>(`/assets?pageSize=20&search=${encodeURIComponent(text)}`);
      setOptions(res.items);
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({ assetId: asset?.id });
    if (!asset) void search('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asset]);

  async function save() {
    const input = parseForm(form, createComplaintSchema, form.getFieldsValue());
    if (!input) return;
    setSaving(true);
    try {
      const c = await api<ComplaintRow>('/complaints', { body: input });
      message.success(`Complaint ${c.complaintNo} raised`);
      onClose();
      onRaised?.(c);
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not raise the complaint');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="Raise complaint" okText="Raise complaint" confirmLoading={saving} onOk={save} onCancel={onClose} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item label="Equipment" name="assetId" rules={[{ required: true, message: 'Choose the equipment' }]}>
          {asset ? (
            <Select disabled options={[{ value: asset.id, label: `${asset.assetCode} · ${asset.name}` }]} />
          ) : (
            <Select
              showSearch
              filterOption={false}
              loading={searching}
              placeholder="Search by ID or name"
              onSearch={(t) => void search(t)}
              options={options.map((a) => ({ value: a.id, label: `${a.assetCode} · ${a.name}` }))}
            />
          )}
        </Form.Item>
        <Form.Item
          label="What is wrong?"
          name="description"
          extra="Say what you saw, e.g. an alarm, an error message, or what stopped working."
          rules={[{ required: true, message: 'Describe the problem' }]}
        >
          <Input.TextArea rows={4} maxLength={2000} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}
