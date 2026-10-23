'use client';

import { Alert, App, Checkbox, Form, Input, Modal, Segmented, Select } from 'antd';
import { useEffect, useState } from 'react';
import { createComplaintSchema, TEAM_LABEL, type AssetRow, type ComplaintRow, type HospitalInfo, type Paged, type Register, type TradeRow } from '@bme/shared';
import { FilePicker } from '@/components/FilePicker';
import { api, useFetch } from '@/lib/api';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';
import { formatDateTime } from '@/lib/format';
import { uploadAll } from '@/lib/uploads';

type AssetOption = { id: string; assetCode: string; name: string; register?: Register };
type Place = { id: string; name: string; departmentId: string };

// Raise a complaint. With `asset` the equipment is fixed; without it the person searches for it
// (the API only returns equipment they are allowed to see: a nurse's own department). `description` pre-fills the
// problem (e.g. the items a failed PMS found). With the facility add-on the ward can also report something that is
// not a machine (a leaking tap, a light): what it is about (the trade) and where; the trade decides the team.
export function RaiseComplaintModal({
  open,
  asset,
  description,
  onClose,
  onRaised,
}: {
  open: boolean;
  asset?: AssetOption;
  description?: string;
  onClose: () => void;
  onRaised?: (c: ComplaintRow) => void;
}) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<{ assetId?: string; tradeId?: string; locationId?: string; description?: string; urgent?: boolean }>();
  const hospital = useFetch<HospitalInfo>(open ? '/hospital' : null);
  // Trades come back only while the add-on is on; without them the dialog is the machine one, as before.
  const trades = useFetch<TradeRow[]>(open && !asset ? '/trades' : null);
  const activeTrades = (trades.data ?? []).filter((t) => t.active);
  const places = useFetch<Place[]>(open && activeTrades.length ? '/locations' : null);
  const depts = useFetch<{ id: string; name: string }[]>(open && activeTrades.length ? '/departments' : null);
  const [kind, setKind] = useState<'machine' | 'ward'>('machine');
  const ward = kind === 'ward' && !asset;
  const [options, setOptions] = useState<AssetOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  // A complaint already open on the chosen equipment, so the same fault is not reported twice (a warning only).
  const chosen = Form.useWatch('assetId', form);
  const chosenTrade = Form.useWatch('tradeId', form);
  // Whose number to call: the team of the chosen machine or trade.
  const team: Register = ward ? (activeTrades.find((t) => t.id === chosenTrade)?.register ?? 'facility') : ((asset ?? options.find((o) => o.id === chosen))?.register ?? 'biomedical');
  const contact = team === 'facility' ? hospital.data?.facilityContact : hospital.data?.biomedContact;
  const [already, setAlready] = useState<ComplaintRow | null>(null);
  useEffect(() => {
    setAlready(null);
    if (!open || !chosen) return;
    let current = true;
    void api<Paged<ComplaintRow>>(`/complaints?assetId=${chosen}&status=unresolved&pageSize=1`)
      .catch(() => null)
      .then((list) => {
        if (current) setAlready(list?.items[0] ?? null);
      });
    return () => {
      current = false;
    };
  }, [open, chosen]);

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
    setKind('machine');
    form.setFieldsValue({ assetId: asset?.id, description, urgent: false });
    if (!asset) void search('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asset, description]);

  const single = useSingleFlight();

  async function save() {
    const { assetId, tradeId, locationId, ...rest } = form.getFieldsValue();
    const input = parseForm(form, createComplaintSchema, { ...rest, ...(ward ? { tradeId, locationId } : { assetId }), urgent: !!form.getFieldValue('urgent') });
    if (!input) return;
    setSaving(true);
    try {
      const c = await api<ComplaintRow>('/complaints', { body: input });
      // The complaint exists now; photos go up after it, one by one. A failed photo never loses the complaint.
      const failed = await uploadAll(files, { ownerType: 'complaint', ownerId: c.id }, (f) => (/\.pdf$/i.test(f.name) ? 'other' : 'photo'));
      if (failed.length) message.warning(`Complaint ${c.complaintNo} raised, but ${failed.join(', ')} could not be uploaded. Open the complaint to add ${failed.length === 1 ? 'it' : 'them'} again.`, 8);
      else message.success(`Complaint ${c.complaintNo} raised`);
      // Urgent: the team has been told, and the ward also gets the number to call.
      const call = c.register === 'facility' ? hospital.data?.facilityContact : hospital.data?.biomedContact;
      if (c.urgent && call) modal.info({ title: `${c.complaintNo} raised as urgent`, content: `The team that looks after it has been told. If a patient is waiting, also call: ${call}` });
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
        {!asset && activeTrades.length > 0 && (
          <Form.Item label="What is it about?">
            <Segmented
              block
              value={kind}
              onChange={(v) => setKind(v as 'machine' | 'ward')}
              options={[
                { value: 'machine', label: 'A machine' },
                { value: 'ward', label: 'Something else in the ward' },
              ]}
            />
          </Form.Item>
        )}
        {ward && (
          <>
            <Form.Item label="What kind of problem" name="tradeId" rules={[{ required: true, message: 'Choose what it is about' }]} extra="Lights and sockets are Electrical, taps and drains Plumbing; not sure? Choose Other.">
              <Select showSearch optionFilterProp="label" placeholder="Electrical, plumbing, AC…" options={activeTrades.map((t) => ({ value: t.id, label: t.name }))} />
            </Form.Item>
            <Form.Item label="Where" name="locationId" rules={[{ required: true, message: 'Choose where it is' }]}>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="Room or area"
                options={(places.data ?? []).map((l) => ({ value: l.id, label: (depts.data?.length ?? 0) > 1 ? `${depts.data?.find((d) => d.id === l.departmentId)?.name ?? ''} · ${l.name}` : l.name }))}
              />
            </Form.Item>
          </>
        )}
        <Form.Item label="Equipment" name="assetId" hidden={ward} rules={[{ required: !ward, message: 'Choose the equipment' }]}>
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
        {already && !ward && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={`This equipment already has a complaint ${already.status === 'open' ? 'waiting' : 'being worked on'}: ${already.complaintNo}`}
            description={`Raised ${formatDateTime(already.raisedAt)}: "${already.description.slice(0, 120)}". If it is the same fault, there is no need to raise another; raise this only for a different problem.`}
          />
        )}
        <Form.Item
          label="What is wrong?"
          name="description"
          extra={ward ? 'Say what and exactly where, e.g. "Tap leaking in the toilet next to bed 4".' : 'Say what you saw, e.g. an alarm, an error message, or what stopped working.'}
          rules={[{ required: true, message: 'Describe the problem' }]}
        >
          <Input.TextArea rows={4} maxLength={2000} />
        </Form.Item>
        <Form.Item name="urgent" valuePropName="checked" style={{ marginBottom: 12 }}>
          <Checkbox>{ward ? 'Urgent: patient care or safety is affected' : 'Urgent: the machine cannot be used, or patient care is affected'}</Checkbox>
        </Form.Item>
        {contact && <Alert type="info" showIcon style={{ marginBottom: 16 }} message={`For an emergency, also call the ${TEAM_LABEL[team].toLowerCase()}: ${contact}`} />}
        <Form.Item label="Photos or files" extra="Optional. A photo of the display, alarm, leak or damage helps the engineer. PDF, JPG or PNG, up to 10 MB each.">
          <FilePicker files={files} onChange={setFiles} label="Add photos" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
