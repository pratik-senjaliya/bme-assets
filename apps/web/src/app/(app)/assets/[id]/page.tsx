'use client';

import { FileTextOutlined, InboxOutlined, LockOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, DatePicker, Descriptions, Dropdown, Form, Input, InputNumber, Modal, Select, Skeleton, Space, Tabs, Timeline, Tooltip, Typography, Upload } from 'antd';
import dayjs from 'dayjs';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
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
import { AssetApprovalBanners } from '@/components/AssetApprovalBanners';
import { DataTable } from '@/components/DataTable';
import { DocumentsButton } from '@/components/DocumentList';
import { FilePicker } from '@/components/FilePicker';
import { PageHeader } from '@/components/PageHeader';
import { DetailPageSkeleton, EmptyState } from '@/components/Skeletons';
import type { DeleteTarget } from '@/components/RequestApprovalModals';
import { CriticalityTag, DueTag, StatusTag, WarrantyTag } from '@/components/StatusTag';
import { COLORS } from '@/theme';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { daysFromToday, formatAge, formatDate, formatDateTime, formatMoney, formatSize, moneyInputProps } from '@/lib/format';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';
import { KIND_LABEL, uploadAll } from '@/lib/uploads';
import { StatusResult } from '@/components/StatusResult';

// Tab contents and dialogs load when first opened, so the asset's own page shows sooner.
const AssetCalibrationTab = dynamic(() => import('@/components/AssetCalibrationTab').then((m) => m.AssetCalibrationTab));
const AssetServiceLogTab = dynamic(() => import('@/components/AssetServiceLogTab').then((m) => m.AssetServiceLogTab));
const AssetPmsTab = dynamic(() => import('@/components/AssetPmsTab').then((m) => m.AssetPmsTab));
const ComplaintsHistory = dynamic(() => import('@/components/ComplaintsHistory').then((m) => m.ComplaintsHistory));
const RaiseComplaintModal = dynamic(() => import('@/components/RaiseComplaintModal').then((m) => m.RaiseComplaintModal));
const RequestCondemnModal = dynamic(() => import('@/components/RequestApprovalModals').then((m) => m.RequestCondemnModal));
const RequestDeleteModal = dynamic(() => import('@/components/RequestApprovalModals').then((m) => m.RequestDeleteModal));

// Dot colours from the one status mapping: work done is green, a breakdown is red, registration is blue, paperwork is grey.
const TIMELINE_COLOR: Record<TimelineEvent['kind'], string> = {
  registered: COLORS.info.dot, purchase_order: COLORS.neutral.dot, installation: COLORS.good.dot, warranty: COLORS.neutral.dot, contract: COLORS.neutral.dot, document: COLORS.neutral.dot,
  pms: COLORS.good.dot, calibration: COLORS.good.dot, complaint: COLORS.bad.dot, service: COLORS.good.dot, opening: COLORS.neutral.dot,
};

export default function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const router = useRouter();
  const asset = useFetch<AssetDetail>(`/assets/${id}`);
  const initialTab = useSearchParams().get('tab') ?? 'overview';
  const [raising, setRaising] = useState(false);
  const [complaintsVersion, setComplaintsVersion] = useState(0);
  const [condemning, setCondemning] = useState(false);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [requests, setRequests] = useState(0); // bumps to refresh the "waiting for HOD" banners

  if (asset.error) {
    return <StatusResult status="404" title="Asset not found" subTitle="It may not exist, or it belongs to another department." extra={<Link href="/assets"><Button>Back to assets</Button></Link>} />;
  }
  if (!asset.data) return <DetailPageSkeleton kpis={0} />;
  const a = asset.data;

  return (
    <>
      <PageHeader
        title={<span className="code">{a.assetCode}</span>}
        docTitle={a.assetCode}
        meta={<StatusTag status={a.status} />}
        subtitle={`${a.name}${a.make || a.model ? ` · ${[a.make, a.model].filter(Boolean).join(' ')}` : ''}`}
        crumbs={['Assets', a.assetCode]}
        action={
          <Space>
            {can('complaint.create') && a.status !== 'condemned' && (
              <Button type={can('asset.edit') ? 'default' : 'primary'} onClick={() => setRaising(true)}>
                Raise complaint
              </Button>
            )}
            {can('asset.edit') && a.status !== 'condemned' && (
              <Link href={`/assets/${a.id}/edit`}>
                <Button type="primary">Edit asset</Button>
              </Link>
            )}
            {(can('asset.request_change') || can('report.view')) && (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    ...(can('report.view') ? [{ key: 'history', icon: <FileTextOutlined />, label: 'Full history report' }] : []),
                    ...(can('asset.request_change')
                      ? [
                          ...(a.status !== 'condemned' ? [{ key: 'condemn', label: 'Request condemnation' }] : []),
                          { key: 'delete', label: 'Request deletion (entered by mistake)', danger: true },
                        ]
                      : []),
                  ],
                  onClick: ({ key }) => {
                    if (key === 'history') router.push(`/assets/${a.id}/history`);
                    else if (key === 'condemn') setCondemning(true);
                    else setDeleting({ type: 'asset', id: a.id, label: `${a.assetCode} · ${a.name}` });
                  },
                }}
              >
                <Button>More</Button>
              </Dropdown>
            )}
          </Space>
        }
      />
      <AssetApprovalBanners asset={a} version={requests} />
      {a.status === 'active' && a.nextPmsDue && daysFromToday(a.nextPmsDue) < 0 && can('pms.perform') && (
        <Alert
          style={{ marginBottom: 16 }}
          type="error"
          showIcon
          message={`PMS is overdue by ${-daysFromToday(a.nextPmsDue)} ${-daysFromToday(a.nextPmsDue) === 1 ? 'day' : 'days'}`}
          description={`It was due on ${formatDate(a.nextPmsDue)}.`}
          action={<Link href={`/assets/${a.id}/pms/new`}><Button danger>Perform PMS</Button></Link>}
        />
      )}
      <Card style={{ marginBottom: 24 }} styles={{ body: { padding: 12 } }}>
        <div className="stat-grid">
          <Stat label="Location">{a.departmentName}<Sub>{a.locationName}</Sub></Stat>
          <Stat label="Criticality"><CriticalityTag value={a.criticality} /></Stat>
          <Stat label="Age">{formatAge(a.ageMonths)}<Sub>{a.installationDate ? `Installed ${formatDate(a.installationDate)}` : 'Installation date not set'}</Sub></Stat>
          <Stat label="Warranty">
            <WarrantyTag status={a.warrantyStatus} />
            {a.warrantyEnd && <Sub>until {formatDate(a.warrantyEnd)}</Sub>}
          </Stat>
          <Stat label="Next PMS">{a.nextPmsDue ? <>{formatDate(a.nextPmsDue)}<Sub><DueTag daysLeft={daysFromToday(a.nextPmsDue)} /></Sub></> : '—'}</Stat>
          <Stat label="Next calibration">{a.nextCalibrationDue ? <>{formatDate(a.nextCalibrationDue)}<Sub><DueTag daysLeft={daysFromToday(a.nextCalibrationDue)} /></Sub></> : '—'}</Stat>
        </div>
      </Card>
      <Tabs
        defaultActiveKey={initialTab}
        // Keep the open tab in the address, so a reload or a shared link comes back to it.
        onChange={(k) => {
          const url = new URL(window.location.href);
          url.searchParams.set('tab', k);
          window.history.replaceState(null, '', url);
        }}
        items={[
          { key: 'overview', label: 'Overview', children: <Overview a={a} /> },
          { key: 'timeline', label: 'Timeline', children: <TimelineTab id={a.id} /> },
          ...(can('pms.perform') ? [{ key: 'pms', label: 'PMS', children: <AssetPmsTab asset={a} /> }] : []),
          ...(can('calibration.manage') ? [{ key: 'calibration', label: 'Calibration', children: <AssetCalibrationTab asset={a} onChanged={asset.reload} /> }] : []),
          ...(can('asset.edit') ? [{ key: 'service', label: 'Service log', children: <AssetServiceLogTab assetId={a.id} canEdit={a.status !== 'condemned'} canRequest={can('asset.request_change')} requestDelete={setDeleting} /> }] : []),
          ...(can('complaint.view') ? [{ key: 'complaints', label: 'Complaints', children: <ComplaintsHistory assetId={a.id} reloadKey={complaintsVersion} /> }] : []),
          ...(can('expense.manage') ? [{ key: 'expenses', label: 'Expenses', children: <ExpensesTab id={a.id} canRequest={can('asset.request_change')} requestDelete={setDeleting} /> }] : []),
          { key: 'purchase', label: 'Purchase & contracts', children: <PurchaseTab id={a.id} canEdit={can('asset.edit') && a.status !== 'condemned'} showCosts={can('expense.manage')} canRequest={can('asset.request_change')} requestDelete={setDeleting} /> },
          { key: 'documents', label: 'Documents', children: <DocumentsTab id={a.id} canEdit={can('asset.edit')} /> },
        ]}
      />
      <RequestCondemnModal open={condemning} asset={a} onClose={() => setCondemning(false)} onRequested={() => setRequests((v) => v + 1)} />
      <RequestDeleteModal target={deleting} onClose={() => setDeleting(null)} onRequested={() => setRequests((v) => v + 1)} />
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
    <div style={{ background: COLORS.surfaceAlt, borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ color: COLORS.faint, fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>{label}</div>
      <div style={{ fontWeight: 700, color: COLORS.ink, fontSize: 15 }}>{children}</div>
    </div>
  );
}

const Sub = ({ children }: { children: React.ReactNode }) => <div style={{ fontWeight: 500, color: COLORS.muted, fontSize: 13, marginTop: 4 }}>{children}</div>;

function Overview({ a }: { a: AssetDetail }) {
  return (
    <Card>
      <Descriptions
        column={{ xs: 1, md: 3 }}
        layout="vertical"
        colon={false}
        styles={{ label: { color: COLORS.faint, fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }, content: { color: COLORS.ink, fontWeight: 600, fontSize: 15, paddingBottom: 16 } }}
      >
        <Descriptions.Item label={<span>Asset ID <Tooltip title="Generated by the system and never changes"><LockOutlined aria-label="Locked" /></Tooltip></span>}>
          <span className="code">{a.assetCode}</span>
        </Descriptions.Item>
        <Descriptions.Item label="Equipment type">{a.equipmentTypeName}</Descriptions.Item>
        <Descriptions.Item label="Serial number">{a.serialNo ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Installed">{formatDate(a.installationDate)}</Descriptions.Item>
        <Descriptions.Item label="Warranty">{a.warrantyMonths != null ? `${a.warrantyMonths} months` : '—'}</Descriptions.Item>
        <Descriptions.Item label="PMS interval">{a.pmsFrequencyMonths ? `Every ${a.pmsFrequencyMonths} months` : '—'}</Descriptions.Item>
        {a.openingPmsOn && <Descriptions.Item label="Last PMS before this system">{formatDate(a.openingPmsOn)}</Descriptions.Item>}
        {a.openingCalibrationOn && <Descriptions.Item label="Last calibration before this system">{formatDate(a.openingCalibrationOn)}</Descriptions.Item>}
        <Descriptions.Item label="Registered">{formatDateTime(a.createdAt)}</Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function TimelineTab({ id }: { id: string }) {
  const events = useFetch<TimelineEvent[]>(`/assets/${id}/timeline`);
  if (events.error) return <Alert type="error" showIcon message="Could not load the timeline" action={<Button onClick={events.reload}>Retry</Button>} />;
  if (!events.data) return <Card><Skeleton.Input active block style={{ height: 160 }} /></Card>;
  const today = new Date().toISOString();
  if (events.data.length === 0) return <Card><EmptyState compact title="Nothing recorded yet" /></Card>;
  return (
    <Card styles={{ body: { padding: '24px 24px 4px' } }}>
      <Timeline
        items={events.data.map((e) => ({
          color: TIMELINE_COLOR[e.kind],
          children: (
            <div>
              <div style={{ fontWeight: 700, color: COLORS.ink }}>{e.title}</div>
              {e.detail && <div style={{ color: COLORS.muted, marginTop: 2 }}>{e.detail}</div>}
              <div style={{ color: COLORS.faint, fontSize: 12, marginTop: 4 }} className="num">
                {e.date.length > 10 ? formatDateTime(e.date) : formatDate(e.date)}
                {e.date > today && ' · upcoming'}
              </div>
            </div>
          ),
        }))}
      />
    </Card>
  );
}

// ---------- Purchase orders and contracts ----------

type RowAction = { canRequest: boolean; requestDelete: (t: DeleteTarget) => void };

// A "Request delete" button for each row, for people who can ask the HOD to remove a wrong entry.
const deleteColumn = <T extends { id: string }>({ canRequest, requestDelete }: RowAction, type: DeleteTarget['type'], labelOf: (r: T) => string) =>
  canRequest
    ? [{ title: <span className="sr-only">Actions</span>, key: 'request-delete', align: 'right' as const, render: (_: unknown, r: T) => <Button size="small" type="text" danger onClick={() => requestDelete({ type, id: r.id, label: labelOf(r) })}>Request delete</Button> }]
    : [];

// A "Documents" link for each row: the contract copy, the bill, ... attached to that record.
const docsColumn = <T extends { id: string }>(ownerType: 'purchase_order' | 'service_contract' | 'service_expense', kinds: string[], canUpload: boolean, titleOf: (r: T) => string) => ({
  title: <span className="sr-only">Actions</span>,
  key: 'documents',
  align: 'right' as const,
  render: (_: unknown, r: T) => <DocumentsButton ownerType={ownerType} ownerId={r.id} title={titleOf(r)} kinds={kinds} canUpload={canUpload} />,
});

// Without expense.manage (nursing) the costs, and the PO and contract copies that show them, are left out.
function PurchaseTab({ id, canEdit, showCosts, canRequest, requestDelete }: { id: string; canEdit: boolean; showCosts: boolean } & RowAction) {
  const { message } = App.useApp();
  const orders = useFetch<PurchaseOrderRow[]>(`/assets/${id}/purchase-orders`);
  const contracts = useFetch<ServiceContractRow[]>(`/assets/${id}/contracts`);
  const [adding, setAdding] = useState<'po' | 'contract' | null>(null);
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [form] = Form.useForm();

  const single = useSingleFlight();

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
      const row = await api<{ id: string }>(`/assets/${id}/${po ? 'purchase-orders' : 'contracts'}`, { body: input });
      const failed = await uploadAll(files, { ownerType: po ? 'purchase_order' : 'service_contract', ownerId: row.id }, () => (po ? 'po' : 'contract'));
      if (failed.length) message.warning(`${po ? 'Purchase order' : 'Contract'} added, but ${failed.join(', ')} could not be uploaded. Use Documents on the row to add it again.`, 8);
      else message.success(po ? 'Purchase order added' : 'Contract added');
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
          setFiles([]);
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
            ...(showCosts
              ? [
                  { title: 'Cost', dataIndex: 'cost', align: 'right' as const, render: formatMoney },
                  docsColumn<PurchaseOrderRow>('purchase_order', ['po', 'other'], canEdit, (r) => `PO ${r.poNumber}`),
                ]
              : []),
            ...deleteColumn<PurchaseOrderRow>({ canRequest, requestDelete }, 'purchase_order', (r) => `Purchase order ${r.poNumber} (${[r.vendor, r.cost != null && formatMoney(r.cost)].filter(Boolean).join(', ')})`),
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
            ...(showCosts
              ? [
                  { title: 'Cost', dataIndex: 'cost', align: 'right' as const, render: (c: number | null) => (c == null ? '—' : formatMoney(c)) },
                  docsColumn<ServiceContractRow>('service_contract', ['contract', 'other'], canEdit, (r) => `${r.type.toUpperCase().replace('_', '-')} contract`),
                ]
              : []),
            ...deleteColumn<ServiceContractRow>({ canRequest, requestDelete }, 'service_contract', (r) => `${r.type.toUpperCase().replace('_', '-')} contract with ${r.vendor}`),
          ]}
        />
      </Card>
      <Modal
        open={adding !== null}
        title={adding === 'po' ? 'Add purchase order' : 'Add contract'}
        okText="Save"
        confirmLoading={saving}
        onOk={() => single(save)}
        onCancel={() => setAdding(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark>
          {adding === 'po' ? (
            <>
              <Form.Item label="PO number" name="poNumber" rules={[{ required: true, message: 'Enter the PO number' }]}><Input placeholder="As on the purchase order" /></Form.Item>
              <Form.Item label="PO date" name="poDate" rules={[{ required: true, message: 'Pick the PO date' }]}><DatePicker format="DD MMM YYYY" style={{ width: '100%' }} /></Form.Item>
              <Form.Item label="Vendor" name="vendor" rules={[{ required: true, message: 'Enter the vendor' }]}><Input placeholder="Company name" /></Form.Item>
              <Form.Item label="Cost (₹)" name="cost" rules={[{ required: true, message: 'Enter the cost' }]}>
                <InputNumber min={0} {...moneyInputProps} placeholder="0" style={{ width: '100%' }} />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item label="Type" name="type" rules={[{ required: true, message: 'Choose a type' }]}>
                <Select options={CONTRACT_TYPES.map((t) => ({ value: t, label: t.toUpperCase().replace('_', '-') }))} />
              </Form.Item>
              <Form.Item label="Vendor" name="vendor" rules={[{ required: true, message: 'Enter the vendor' }]}><Input placeholder="Company name" /></Form.Item>
              <Form.Item label="Starts" name="startDate" rules={[{ required: true, message: 'Pick the start date' }]}><DatePicker format="DD MMM YYYY" style={{ width: '100%' }} /></Form.Item>
              <Form.Item label="Ends" name="endDate" rules={[{ required: true, message: 'Pick the end date' }]}><DatePicker format="DD MMM YYYY" style={{ width: '100%' }} /></Form.Item>
              <Form.Item label="Cost (₹)" name="cost"><InputNumber min={0} {...moneyInputProps} placeholder="0" style={{ width: '100%' }} /></Form.Item>
            </>
          )}
          <Form.Item label={adding === 'po' ? 'Purchase order copy' : 'Contract copy'} extra="Optional. PDF, JPG or PNG, up to 10 MB.">
            <FilePicker files={files} onChange={setFiles} label={adding === 'po' ? 'Attach the PO' : 'Attach the contract'} max={3} />
          </Form.Item>
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

function ExpensesTab({ id, canRequest, requestDelete }: { id: string } & RowAction) {
  const { message } = App.useApp();
  const expenses = useFetch<ExpenseList>(`/assets/${id}/expenses`);
  const complaints = useFetch<Paged<ComplaintRow>>(`/complaints?assetId=${id}&pageSize=100`);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [form] = Form.useForm();

  const single = useSingleFlight();

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
      const row = await api<{ id: string }>(`/assets/${id}/expenses`, { body: input });
      const failed = await uploadAll(files, { ownerType: 'service_expense', ownerId: row.id }, () => 'invoice');
      if (failed.length) message.warning(`Expense added, but ${failed.join(', ')} could not be uploaded. Use Documents on the row to add it again.`, 8);
      else message.success('Expense added');
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
            setFiles([]);
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
          docsColumn<ExpenseRow>('service_expense', ['invoice', 'other'], true, (r) => `expense ${r.description}`),
          ...deleteColumn<ExpenseRow>({ canRequest, requestDelete }, 'service_expense', (r) => `Expense "${r.description}" (${formatMoney(r.amount)})`),
        ]}
      />
      <Modal open={adding} title="Add expense" okText="Save" confirmLoading={saving} onOk={() => single(save)} onCancel={() => setAdding(false)} destroyOnHidden>
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="Type" name="type" rules={[{ required: true }]}>
            <Select options={EXPENSE_TYPES.map((t) => ({ value: t, label: t === 'spare_part' ? 'Spare part' : 'Repair' }))} />
          </Form.Item>
          <Form.Item label="What was paid for?" name="description" rules={[{ required: true, message: 'Describe it' }]}>
            <Input maxLength={500} placeholder="e.g. Replaced flow sensor" />
          </Form.Item>
          <Form.Item label="Amount (₹)" name="amount" rules={[{ required: true, message: 'Enter the amount' }]}>
            <InputNumber min={0} {...moneyInputProps} placeholder="0" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Date" name="date" rules={[{ required: true, message: 'Pick the date' }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
          </Form.Item>
          <Form.Item label="Vendor" name="vendor">
            <Input maxLength={150} placeholder="Optional" />
          </Form.Item>
          <Form.Item label="Linked complaint" name="complaintId" extra="Optional. Link the cost to a breakdown.">
            <Select
              allowClear
              options={(complaints.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.complaintNo} · ${c.description.slice(0, 40)}` }))}
            />
          </Form.Item>
          <Form.Item label="Invoice or bill" extra="Optional. PDF, JPG or PNG, up to 10 MB.">
            <FilePicker files={files} onChange={setFiles} label="Attach the bill" max={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
