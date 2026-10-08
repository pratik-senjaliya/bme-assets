'use client';

import { App, Form, Input, Modal, Select } from 'antd';
import { useEffect, useState } from 'react';
import { createComplaintSchema, type AssetRow, type ComplaintRow, type Paged } from '@bme/shared';
import { FilePicker } from '@/components/FilePicker';
import { api } from '@/lib/api';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';
import { uploadAll } from '@/lib/uploads';

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
  const [files, setFiles] = useState<File[]>([]);

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
    setFiles([]);
    form.setFieldsValue({ assetId: asset?.id });
    if (!asset) void search('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asset]);

  const single = useSingleFlight();

  async function save() {
    const input = parseForm(form, createComplaintSchema, form.getFieldsValue());
    if (!input) return;
    setSaving(true);
    try {
      const c = await api<ComplaintRow>('/complaints', { body: input });
      // The complaint exists now; photos go up after it, one by one. A failed photo never loses the complaint.
      const failed = await uploadAll(files, { ownerType: 'complaint', ownerId: c.id }, (f) => (/\.pdf$/i.test(f.name) ? 'other' : 'photo'));
      if (failed.length) message.warning(`Complaint ${c.complaintNo} raised, but ${failed.join(', ')} could not be uploaded. Open the complaint to add ${failed.length === 1 ? 'it' : 'them'} again.`, 8);
      else message.success(`Complaint ${c.complaintNo} raised`);
      onClose();
      onRaised?.(c);
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not raise the complaint');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="Raise complaint" okText="Raise complaint" confirmLoading={saving} onOk={() => single(save)} onCancel={onClose} destroyOnHidden>
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
          <Input.TextArea rows={4} maxLength={2000} />
        </Form.Item>
        <Form.Item label="Photos or files" extra="Optional. A photo of the display, alarm or damage helps the biomedical team. PDF, JPG or PNG, up to 10 MB each.">
          <FilePicker files={files} onChange={setFiles} label="Add photos" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
