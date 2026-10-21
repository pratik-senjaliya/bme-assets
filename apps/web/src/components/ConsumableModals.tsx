'use client';

import { App, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Switch } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import {
  COMPLAINT_STATUS_LABEL,
  CONSUMABLE_MAX_DAYS_BACK,
  CONSUMABLE_UNITS,
  consumableItemSchema,
  issueSchema,
  newConsumableSchema,
  stockAdjustSchema,
  stockInSchema,
  type AssetRow,
  type ComplaintRow,
  type ConsumableRow,
  type Paged,
  type VendorRow,
} from '@bme/shared';
import { Pill } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { moneyInputProps, todayIST } from '@/lib/format';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';

type Department = { id: string; name: string };

// How much is left, in words as well as colour.
export function StockPill({ item }: { item: Pick<ConsumableRow, 'stock' | 'low' | 'active'> }) {
  if (!item.active) return <Pill tone="neutral">Not in use</Pill>;
  if (item.stock === 0) return <Pill tone="bad">Out of stock</Pill>;
  if (item.low) return <Pill tone="warn">Low</Pill>;
  return null;
}

export type MoveKind = 'in' | 'issue' | 'adjust';

// Movements are dated: never ahead of today, at most CONSUMABLE_MAX_DAYS_BACK days back (the server checks the same).
// The hospital's today (India), as the server dates movements, whatever the device's own clock says.
const today = () => dayjs(todayIST());
const outsideWindow = (d: Dayjs) => d.isAfter(today(), 'day') || d.isBefore(today().subtract(CONSUMABLE_MAX_DAYS_BACK, 'day'), 'day');
const DateField = () => (
  <Form.Item label="Date" name="date" rules={[{ required: true, message: 'Pick the date' }]} extra={`Today or up to ${CONSUMABLE_MAX_DAYS_BACK} days back.`}>
    <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} disabledDate={outsideWindow} />
  </Form.Item>
);

// Add or edit an item. A new item can start with what is on the shelf today.
export function ItemModal({ item, open, onClose, onSaved }: { item: ConsumableRow | null; open: boolean; onClose: () => void; onSaved: (row: ConsumableRow) => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const single = useSingleFlight();

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(item ? { ...item, unitCost: item.unitCost ?? undefined } : { unit: 'pcs', reorderLevel: 0, openingStock: 0, active: true });
  }, [open, item, form]);

  async function save() {
    const v = form.getFieldsValue();
    const values = { ...v, unitCost: v.unitCost ?? null, reorderLevel: v.reorderLevel ?? 0, ...(item ? {} : { openingStock: v.openingStock ?? 0 }) };
    const input = parseForm(form, item ? consumableItemSchema : newConsumableSchema, values);
    if (!input) return;
    setSaving(true);
    try {
      const row = await api<ConsumableRow>(item ? `/consumables/${item.id}` : '/consumables', { method: item ? 'PUT' : 'POST', body: input });
      message.success(item ? `${row.name} updated` : `${row.name} added`);
      onSaved(row);
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title={item ? 'Edit item' : 'Add item'} okText="Save" confirmLoading={saving} onOk={() => single(save)} onCancel={onClose} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item label="Item" name="name" rules={[{ required: true, message: 'Enter the item name' }]}>
          <Input maxLength={150} placeholder="e.g. SpO2 probe, adult, reusable" />
        </Form.Item>
        <Row gutter={12}>
          <Col xs={12}>
            <Form.Item label="Counted in" name="unit">
              <Select options={CONSUMABLE_UNITS.map((u) => ({ value: u, label: u }))} />
            </Form.Item>
          </Col>
          <Col xs={12}>
            <Form.Item label="Reorder at" name="reorderLevel" extra="Warn when stock falls to this. 0 = never.">
              <InputNumber min={0} max={100000} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={12}>
            <Form.Item label="Unit cost (optional)" name="unitCost" extra="So spend shows in reports.">
              <InputNumber {...moneyInputProps} min={0} style={{ width: '100%' }} placeholder="e.g. 450" />
            </Form.Item>
          </Col>
          {!item && (
            <Col xs={12}>
              <Form.Item label="In stock today" name="openingStock" extra="What is on the shelf now.">
                <InputNumber min={0} max={100000} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          )}
        </Row>
        <Form.Item label="Notes" name="notes">
          <Input.TextArea rows={2} maxLength={500} placeholder="e.g. Fits Philips MX450 monitors" />
        </Form.Item>
        {item && (
          <Form.Item label="In use" name="active" valuePropName="checked" extra="Switch off for an item you no longer keep. Its history stays.">
            <Switch />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

const TITLE: Record<MoveKind, string> = { in: 'Stock in', issue: 'Give out', adjust: 'Correct the stock count' };

// Stock in, give out or correct the count of one item. Giving out can start from a machine (the asset page), and then
// asks which item; the department follows the machine.
export function MoveModal({
  kind,
  item,
  asset,
  onClose,
  onDone,
}: {
  kind: MoveKind | null;
  item: ConsumableRow | null;
  asset?: { id: string; assetCode: string; name: string; departmentId: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const single = useSingleFlight();
  const open = kind !== null;
  const issuing = kind === 'issue';
  const items = useFetch<ConsumableRow[]>(open && !item ? '/consumables' : null);
  const departments = useFetch<Department[]>(issuing ? '/departments' : null);
  const vendors = useFetch<VendorRow[]>(kind === 'in' ? '/vendors' : null);
  const itemId = Form.useWatch('itemId', form) as string | undefined;
  const departmentId = Form.useWatch('departmentId', form) as string | undefined;
  const assetId = Form.useWatch('assetId', form) as string | undefined;
  const [assetSearch, setAssetSearch] = useState('');
  const machines = useFetch<Paged<AssetRow>>(issuing && departmentId ? `/assets?departmentId=${departmentId}&pageSize=50${assetSearch ? `&search=${encodeURIComponent(assetSearch)}` : ''}` : null);
  const complaints = useFetch<Paged<ComplaintRow>>(issuing && assetId ? `/complaints?assetId=${assetId}&pageSize=20` : null);
  const chosen = item ?? items.data?.find((i) => i.id === itemId) ?? null;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setAssetSearch('');
    form.setFieldsValue({ date: today(), ...(asset && { departmentId: asset.departmentId, assetId: asset.id }) });
  }, [open, kind, asset, form]);

  async function save() {
    const v = form.getFieldsValue();
    const target = item?.id ?? v.itemId;
    if (!target) {
      form.setFields([{ name: 'itemId', errors: ['Choose the item'] }]);
      return;
    }
    const date = v.date ? (v.date as Dayjs).format('YYYY-MM-DD') : undefined;
    const input =
      kind === 'in'
        ? parseForm(form, stockInSchema, { quantity: v.quantity, date, unitCost: v.unitCost ?? null, supplierId: v.supplierId ?? null, reference: v.reference, note: v.note })
        : kind === 'issue'
          ? parseForm(form, issueSchema, { quantity: v.quantity, date, departmentId: v.departmentId, assetId: v.assetId ?? null, complaintId: v.complaintId ?? null, reason: v.reason })
          : parseForm(form, stockAdjustSchema, { change: v.change, reason: v.reason });
    if (!input) return;
    setSaving(true);
    try {
      await api(`/consumables/${target}/${kind}`, { body: input });
      const name = chosen?.name ?? 'Item';
      message.success(kind === 'in' ? `${name}: stock added` : kind === 'issue' ? `${name}: given out` : `${name}: count corrected`);
      onDone();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const unit = chosen?.unit ?? '';
  const stockHint = chosen ? `${chosen.stock} ${unit} in stock` : undefined;

  return (
    <Modal
      open={open}
      title={kind ? `${TITLE[kind]}${item ? ` · ${item.name}` : ''}` : ''}
      okText={kind === 'in' ? 'Add to stock' : kind === 'issue' ? 'Give out' : 'Save count'}
      confirmLoading={saving}
      onOk={() => single(save)}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark>
        {!item && (
          <Form.Item label="Item" name="itemId" rules={[{ required: true, message: 'Choose the item' }]} extra={stockHint}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Choose the item"
              loading={items.loading}
              options={items.data?.filter((i) => i.active && (kind !== 'issue' || i.stock > 0)).map((i) => ({ value: i.id, label: `${i.name} (${i.stock} ${i.unit})` }))}
              notFoundContent="Nothing in stock. Add items under Consumables."
            />
          </Form.Item>
        )}
        {kind === 'adjust' ? (
          <>
            <Form.Item
              label={`More (+) or fewer (−) than the books${unit ? `, in ${unit}` : ''}`}
              name="change"
              rules={[{ required: true, message: 'Enter the difference' }]}
              extra={stockHint ? `The books say ${stockHint}. Enter −2 if two fewer were counted.` : undefined}
            >
              <InputNumber min={-100000} max={100000} precision={0} style={{ width: 200 }} />
            </Form.Item>
            <Form.Item label="Why" name="reason" rules={[{ required: true, message: 'Say why the count is different' }]}>
              <Input.TextArea rows={2} maxLength={300} placeholder="e.g. Monthly count: one found broken in the box" />
            </Form.Item>
          </>
        ) : (
          <Row gutter={12}>
            <Col xs={12}>
              <Form.Item label={`Quantity${unit ? ` (${unit})` : ''}`} name="quantity" rules={[{ required: true, message: 'Enter the quantity' }]} extra={issuing && item ? stockHint : undefined}>
                <InputNumber min={1} max={issuing && chosen ? Math.max(chosen.stock, 1) : 100000} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12}>
              <DateField />
            </Col>
          </Row>
        )}
        {kind === 'in' && (
          <>
            <Row gutter={12}>
              <Col xs={12}>
                <Form.Item label="Unit cost paid (optional)" name="unitCost" extra="Becomes the item's unit cost.">
                  <InputNumber {...moneyInputProps} min={0} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={12}>
                <Form.Item label="Invoice / PO no." name="reference">
                  <Input maxLength={80} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label="Supplier (optional)" name="supplierId">
              <Select allowClear showSearch optionFilterProp="label" placeholder="From the suppliers list" options={vendors.data?.map((v) => ({ value: v.id, label: v.name }))} />
            </Form.Item>
            <Form.Item label="Note" name="note">
              <Input maxLength={300} />
            </Form.Item>
          </>
        )}
        {issuing && (
          <>
            <Form.Item label="Department" name="departmentId" rules={[{ required: true, message: 'Choose the department' }]}>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="Who it goes to"
                disabled={!!asset}
                options={departments.data?.map((d) => ({ value: d.id, label: d.name }))}
                onChange={() => form.setFieldsValue({ assetId: undefined, complaintId: undefined })}
              />
            </Form.Item>
            <Form.Item label="For a machine (optional)" name="assetId">
              <Select
                allowClear
                showSearch
                filterOption={false}
                onSearch={setAssetSearch}
                disabled={!departmentId || !!asset}
                placeholder={departmentId ? 'Search by asset ID or name' : 'Choose the department first'}
                loading={machines.loading}
                options={(asset ? [{ value: asset.id, label: `${asset.assetCode} · ${asset.name}` }] : machines.data?.items.map((a) => ({ value: a.id, label: `${a.assetCode} · ${a.name}` }))) ?? []}
                onChange={() => form.setFieldsValue({ complaintId: undefined })}
              />
            </Form.Item>
            {assetId && (
              <Form.Item label="For a complaint (optional)" name="complaintId">
                <Select
                  allowClear
                  placeholder={complaints.data?.items.length === 0 ? 'No complaints on this machine' : 'Choose the complaint'}
                  loading={complaints.loading}
                  options={complaints.data?.items.map((c) => ({ value: c.id, label: `${c.complaintNo} · ${COMPLAINT_STATUS_LABEL[c.status]} · ${c.description.slice(0, 50)}` }))}
                />
              </Form.Item>
            )}
            <Form.Item label="Reason" name="reason" rules={[{ required: true, message: 'Say why it was given' }]}>
              <Input.TextArea rows={2} maxLength={300} placeholder="e.g. Replaced the broken one" />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
}
