'use client';

import { InboxOutlined, LockOutlined } from '@ant-design/icons';
import {
  Alert, App, Button, Card, DatePicker, Descriptions, Form, Input, InputNumber, Modal, Result, Select, Skeleton, Space, Tabs, Timeline, Tooltip, Typography, Upload,
} from 'antd';
import dayjs from 'dayjs';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  ATTACHMENT_KINDS,
  CONTRACT_TYPES,
  EXPENSE_TYPES,
  MAX_UPLOAD_BYTES,
  createExpenseSchema,
  purchaseOrderSchema,
  serviceContractSchema,
  type AssetDetail,
  type AttachmentRow,
  type ComplaintRow,
  type ExpenseList,
  type ExpenseRow,
  type Paged,
  type PurchaseOrderRow,
  type ServiceContractRow,
  type TimelineEvent,
} from '@bme/shared';
import { AssetCalibrationTab } from '@/components/AssetCalibrationTab';
import { AssetPmsTab } from '@/components/AssetPmsTab';
import { ComplaintsTable } from '@/components/ComplaintsTable';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { RaiseComplaintModal } from '@/components/RaiseComplaintModal';
import { CriticalityTag, DueTag, StatusTag, WarrantyTag } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { daysFromToday, formatAge, formatDate, formatDateTime, formatMoney, formatSize } from '@/lib/format';
import { parseForm, showApiFieldErrors } from '@/lib/forms';

const KIND_LABEL: Record<string, string> = {
  po: 'Purchase order',
  installation_report: 'Installation report',
  photo: 'Photo',
  manual: 'Manual',
  certificate: 'Certificate',
  eol_letter: 'End-of-life letter',
};
const TIMELINE_COLOR: Record<TimelineEvent['kind'], string> = {
  registered: 'blue', purchase_order: 'gray', installation: 'green', warranty: 'gray', contract: 'gray', document: 'gray', pms: 'green', calibration: 'green', complaint: 'red',
};

export default function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const asset = useFetch<AssetDetail>(`/assets/${id}`);
  const initialTab = useSearchParams().get('tab') ?? 'overview';
  const [raising, setRaising] = useState(false);
  const [complaintsVersion, setComplaintsVersion] = useState(0);

  if (asset.error) {
    return <Result status="404" title="Asset not found" subTitle="It may not exist, or it belongs to another department." extra={<Link href="/assets"><Button>Back to assets</Button></Link>} />;
  }
  if (!asset.data) return <Skeleton active />;
  const a = asset.data;

  return (
    <>
      <PageHeader
        title={a.assetCode}
        subtitle={a.name}
        crumbs={['Assets', a.assetCode]}
        action={
          <Space>
            {can('complaint.create') && a.status !== 'condemned' && (
              <Button type={can('asset.edit') ? 'default' : 'primary'} onClick={() => setRaising(true)}>
                Raise complaint
              </Button>
            )}
            {can('asset.edit') && (
              <Link href={`/assets/${a.id}/edit`}>
                <Button type="primary">Edit asset</Button>
              </Link>
            )}
          </Space>
        }
      />
      <Card style={{ marginBottom: 16 }}>
        <Space size={[32, 16]} wrap align="start">
          <Stat label="Status"><StatusTag status={a.status} /></Stat>
          <Stat label="Criticality"><CriticalityTag value={a.criticality} /></Stat>
          <Stat label="Department · location">{a.departmentName} · {a.locationName}</Stat>
          <Stat label="Make · model">{[a.make, a.model].filter(Boolean).join(' · ') || '—'}</Stat>
          <Stat label="Age">{formatAge(a.ageMonths)}</Stat>
          <Stat label="Warranty">
            <WarrantyTag status={a.warrantyStatus} />
            {a.warrantyEnd && <span style={{ marginLeft: 8, color: '#6B7280' }}>until {formatDate(a.warrantyEnd)}</span>}
          </Stat>
          <Stat label="Next PMS due">{a.nextPmsDue ? <Space size={4}>{formatDate(a.nextPmsDue)}<DueTag daysLeft={daysFromToday(a.nextPmsDue)} /></Space> : '—'}</Stat>
          <Stat label="Next calibration due">{a.nextCalibrationDue ? <Space size={4}>{formatDate(a.nextCalibrationDue)}<DueTag daysLeft={daysFromToday(a.nextCalibrationDue)} /></Space> : '—'}</Stat>
        </Space>
      </Card>
      <Tabs
        defaultActiveKey={initialTab}
        items={[
          { key: 'overview', label: 'Overview', children: <Overview a={a} /> },
          { key: 'timeline', label: 'Timeline', children: <TimelineTab id={a.id} /> },
          ...(can('pms.perform') ? [{ key: 'pms', label: 'PMS', children: <AssetPmsTab asset={a} /> }] : []),
          ...(can('calibration.manage') ? [{ key: 'calibration', label: 'Calibration', children: <AssetCalibrationTab asset={a} onChanged={asset.reload} /> }] : []),
          ...(can('complaint.view') ? [{ key: 'complaints', label: 'Complaints', children: <ComplaintsTable assetId={a.id} reloadKey={complaintsVersion} /> }] : []),
          ...(can('expense.manage') ? [{ key: 'expenses', label: 'Expenses', children: <ExpensesTab id={a.id} /> }] : []),
          { key: 'purchase', label: 'Purchase & contracts', children: <PurchaseTab id={a.id} canEdit={can('asset.edit')} /> },
          { key: 'documents', label: 'Documents', children: <DocumentsTab id={a.id} canEdit={can('asset.edit')} /> },
        ]}
      />
      <RaiseComplaintModal
        open={raising}
        asset={{ id: a.id, assetCode: a.assetCode, name: a.name }}
        onClose={() => setRaising(false)}
        onRaised={() => setComplaintsVersion((v) => v + 1)}
      />
    </>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ color: '#6B7280', fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Overview({ a }: { a: AssetDetail }) {
  return (
    <Card>
      <Descriptions column={{ xs: 1, md: 2 }} size="small">
        <Descriptions.Item label={<span>Asset ID <Tooltip title="Generated by the system and never changes"><LockOutlined aria-label="Locked" /></Tooltip></span>}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{a.assetCode}</span>
        </Descriptions.Item>
        <Descriptions.Item label="Equipment type">{a.equipmentTypeName}</Descriptions.Item>
        <Descriptions.Item label="Serial number">{a.serialNo ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Installed">{formatDate(a.installationDate)}</Descriptions.Item>
        <Descriptions.Item label="Warranty">{a.warrantyMonths != null ? `${a.warrantyMonths} months` : '—'}</Descriptions.Item>
        <Descriptions.Item label="PMS interval">{a.pmsFrequencyMonths ? `Every ${a.pmsFrequencyMonths} months` : '—'}</Descriptions.Item>
        <Descriptions.Item label="Registered">{formatDateTime(a.createdAt)}</Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function TimelineTab({ id }: { id: string }) {
  const events = useFetch<TimelineEvent[]>(`/assets/${id}/timeline`);
  if (events.error) return <Alert type="error" showIcon message="Could not load the timeline" action={<Button onClick={events.reload}>Retry</Button>} />;
  if (!events.data) return <Skeleton active />;
  const today = new Date().toISOString();
  return (
    <Card>
      <Timeline
        items={events.data.map((e) => ({
          color: TIMELINE_COLOR[e.kind],
          children: (
            <div>
              <div style={{ color: '#6B7280', fontSize: 12 }}>
                {e.date.length > 10 ? formatDateTime(e.date) : formatDate(e.date)}
                {e.date > today && ' · upcoming'}
              </div>
              <div>{e.title}</div>
              {e.detail && <div style={{ color: '#6B7280' }}>{e.detail}</div>}
            </div>
          ),
        }))}
      />
    </Card>
  );
}

// ---------- Purchase orders and contracts ----------

function PurchaseTab({ id, canEdit }: { id: string; canEdit: boolean }) {
  const { message } = App.useApp();
  const orders = useFetch<PurchaseOrderRow[]>(`/assets/${id}/purchase-orders`);
  const contracts = useFetch<ServiceContractRow[]>(`/assets/${id}/contracts`);
  const [adding, setAdding] = useState<'po' | 'contract' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  async function save() {
    const v = form.getFieldsValue();
    const date = (d?: dayjs.Dayjs) => (d ? d.format('YYYY-MM-DD') : undefined);
    const po = adding === 'po';
    const input = parseForm(
      form,
      po ? purchaseOrderSchema : serviceContractSchema,
      po ? { ...v, poDate: date(v.poDate), cost: v.cost ?? undefined } : { ...v, startDate: date(v.startDate), endDate: date(v.endDate), cost: v.cost ?? null },
    );
    if (!input) return;
    setSaving(true);
    try {
      await api(`/assets/${id}/${po ? 'purchase-orders' : 'contracts'}`, { body: input });
      message.success(po ? 'Purchase order added' : 'Contract added');
      setAdding(null);
      (po ? orders : contracts).reload();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const add = (kind: 'po' | 'contract', label: string) =>
    canEdit && (
      <Button
        onClick={() => {
          form.resetFields();
          setAdding(kind);
        }}
      >
        {label}
      </Button>
    );

  return (
    <Space direction="vertical" size={24} style={{ width: '100%' }}>
      <Card title="Purchase orders" extra={add('po', 'Add purchase order')}>
        <DataTable<PurchaseOrderRow>
          rows={orders.data}
          loading={orders.loading}
          error={orders.error}
          onRetry={orders.reload}
          emptyText="No purchase order recorded."
          columns={[
            { title: 'PO number', dataIndex: 'poNumber' },
            { title: 'Date', dataIndex: 'poDate', render: formatDate },
            { title: 'Vendor', dataIndex: 'vendor' },
            { title: 'Cost', dataIndex: 'cost', align: 'right', render: formatMoney },
          ]}
        />
      </Card>
      <Card title="Warranty and service contracts" extra={add('contract', 'Add contract')}>
        <DataTable<ServiceContractRow>
          rows={contracts.data}
          loading={contracts.loading}
          error={contracts.error}
          onRetry={contracts.reload}
          emptyText="No contracts recorded."
          columns={[
            { title: 'Type', dataIndex: 'type', render: (t: string) => t.toUpperCase().replace('_', '-') },
            { title: 'Vendor', dataIndex: 'vendor' },
            { title: 'Starts', dataIndex: 'startDate', render: formatDate },
            { title: 'Ends', dataIndex: 'endDate', render: formatDate },
            { title: 'Cost', dataIndex: 'cost', align: 'right', render: (c: number | null) => (c == null ? '—' : formatMoney(c)) },
          ]}
        />
      </Card>
      <Modal
        open={adding !== null}
        title={adding === 'po' ? 'Add purchase order' : 'Add contract'}
        okText="Save"
        confirmLoading={saving}
        onOk={save}
        onCancel={() => setAdding(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark>
          {adding === 'po' ? (
            <>
              <Form.Item label="PO number" name="poNumber" rules={[{ required: true, message: 'Enter the PO number' }]}><Input /></Form.Item>
              <Form.Item label="PO date" name="poDate" rules={[{ required: true, message: 'Pick the PO date' }]}><DatePicker format="DD MMM YYYY" style={{ width: '100%' }} /></Form.Item>
              <Form.Item label="Vendor" name="vendor" rules={[{ required: true, message: 'Enter the vendor' }]}><Input /></Form.Item>
              <Form.Item label="Cost (₹)" name="cost" rules={[{ required: true, message: 'Enter the cost' }]}>
                <InputNumber min={0} prefix="₹" style={{ width: '100%' }} />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item label="Type" name="type" rules={[{ required: true, message: 'Choose a type' }]}>
                <Select options={CONTRACT_TYPES.map((t) => ({ value: t, label: t.toUpperCase().replace('_', '-') }))} />
              </Form.Item>
              <Form.Item label="Vendor" name="vendor" rules={[{ required: true, message: 'Enter the vendor' }]}><Input /></Form.Item>
              <Form.Item label="Starts" name="startDate" rules={[{ required: true, message: 'Pick the start date' }]}><DatePicker format="DD MMM YYYY" style={{ width: '100%' }} /></Form.Item>
              <Form.Item label="Ends" name="endDate" rules={[{ required: true, message: 'Pick the end date' }]}><DatePicker format="DD MMM YYYY" style={{ width: '100%' }} /></Form.Item>
              <Form.Item label="Cost (₹)" name="cost"><InputNumber min={0} prefix="₹" style={{ width: '100%' }} /></Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </Space>
  );
}

// ---------- Documents ----------

function DocumentsTab({ id, canEdit }: { id: string; canEdit: boolean }) {
  const { message } = App.useApp();
  const files = useFetch<AttachmentRow[]>(`/assets/${id}/attachments`);
  const [kind, setKind] = useState<string>('photo');

  async function send(file: File) {
    const body = new FormData();
    body.set('kind', kind);
    body.set('file', file);
    try {
      await api(`/assets/${id}/attachments`, { body });
      message.success(`${file.name} uploaded`);
      files.reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Upload failed');
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {canEdit && (
        <Card>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space wrap>
              <Typography.Text>Document type</Typography.Text>
              <Select
                aria-label="Document type"
                style={{ width: 220 }}
                value={kind}
                onChange={setKind}
                options={ATTACHMENT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
              />
            </Space>
            <Upload.Dragger
              accept=".pdf,.jpg,.jpeg,.png"
              showUploadList={false}
              multiple={false}
              beforeUpload={(file) => {
                if (file.size > MAX_UPLOAD_BYTES) message.error('That file is over 10 MB');
                else void send(file);
                return false; // we upload ourselves
              }}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">Drop a file here or click to choose</p>
              <p className="ant-upload-hint">PDF, JPG or PNG, up to 10 MB</p>
            </Upload.Dragger>
          </Space>
        </Card>
      )}
      <DataTable<AttachmentRow>
        rows={files.data}
        loading={files.loading}
        error={files.error}
        onRetry={files.reload}
        emptyText="No documents yet."
        columns={[
          {
            title: 'File',
            dataIndex: 'fileName',
            render: (name: string, row) => (
              <a href={`/api/v1/attachments/${row.id}/download`} target="_blank" rel="noreferrer">
                {name || 'Download'}
              </a>
            ),
          },
          { title: 'Type', dataIndex: 'kind', render: (k: string) => KIND_LABEL[k] ?? k },
          { title: 'Size', dataIndex: 'size', align: 'right', render: formatSize },
          { title: 'Added', dataIndex: 'createdAt', render: formatDateTime },
        ]}
      />
    </Space>
  );
}

// ---------- Expenses ----------

function ExpensesTab({ id }: { id: string }) {
  const { message } = App.useApp();
  const expenses = useFetch<ExpenseList>(`/assets/${id}/expenses`);
  const complaints = useFetch<Paged<ComplaintRow>>(`/complaints?assetId=${id}&pageSize=100`);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  async function save() {
    const v = form.getFieldsValue();
    const input = parseForm(form, createExpenseSchema, {
      ...v,
      date: v.date ? v.date.format('YYYY-MM-DD') : undefined,
      amount: v.amount ?? undefined,
      complaintId: v.complaintId ?? null,
    });
    if (!input) return;
    setSaving(true);
    try {
      await api(`/assets/${id}/expenses`, { body: input });
      message.success('Expense added');
      setAdding(false);
      expenses.reload();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title={`Service expenses${expenses.data ? ` · total ${formatMoney(expenses.data.total)}` : ''}`}
      extra={
        <Button
          onClick={() => {
            form.resetFields();
            form.setFieldsValue({ type: 'repair', date: dayjs() });
            setAdding(true);
          }}
        >
          Add expense
        </Button>
      }
    >
      <DataTable<ExpenseRow>
        rows={expenses.data?.items ?? null}
        loading={expenses.loading}
        error={expenses.error}
        onRetry={expenses.reload}
        emptyText="No expenses recorded for this equipment."
        columns={[
          { title: 'Date', dataIndex: 'date', render: formatDate },
          { title: 'Type', dataIndex: 'type', render: (t: string) => (t === 'spare_part' ? 'Spare part' : 'Repair') },
          { title: 'Description', dataIndex: 'description' },
          { title: 'Vendor', dataIndex: 'vendor', render: (v: string | null) => v ?? '—' },
          { title: 'Complaint', dataIndex: 'complaintNo', render: (v: string | null) => v ?? '—' },
          { title: 'Amount', dataIndex: 'amount', align: 'right', render: formatMoney },
        ]}
      />
      <Modal open={adding} title="Add expense" okText="Save" confirmLoading={saving} onOk={save} onCancel={() => setAdding(false)} destroyOnHidden>
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="Type" name="type" rules={[{ required: true }]}>
            <Select options={EXPENSE_TYPES.map((t) => ({ value: t, label: t === 'spare_part' ? 'Spare part' : 'Repair' }))} />
          </Form.Item>
          <Form.Item label="What was paid for?" name="description" rules={[{ required: true, message: 'Describe it' }]}>
            <Input maxLength={500} />
          </Form.Item>
          <Form.Item label="Amount (₹)" name="amount" rules={[{ required: true, message: 'Enter the amount' }]}>
            <InputNumber min={0} prefix="₹" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Date" name="date" rules={[{ required: true, message: 'Pick the date' }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
          </Form.Item>
          <Form.Item label="Vendor" name="vendor">
            <Input maxLength={150} />
          </Form.Item>
          <Form.Item label="Linked complaint" name="complaintId" extra="Optional. Link the cost to a breakdown.">
            <Select
              allowClear
              options={(complaints.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.complaintNo} · ${c.description.slice(0, 40)}` }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
