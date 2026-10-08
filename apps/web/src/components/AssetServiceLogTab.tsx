'use client';

import { App, Button, Card, DatePicker, Form, Input, Modal, Select } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { SERVICE_KINDS, createServiceLogSchema, type ServiceKind, type ServiceLogRow } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { DocumentsButton } from '@/components/DocumentList';
import { FilePicker } from '@/components/FilePicker';
import type { DeleteTarget } from '@/components/RequestApprovalModals';
import { api, useFetch } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { parseForm, showApiFieldErrors } from '@/lib/forms';
import { uploadAll } from '@/lib/uploads';
import { COLORS } from '@/theme';

export const SERVICE_LABEL: Record<ServiceKind, string> = { amc_visit: 'AMC visit', cmc_visit: 'CMC visit', repair: 'Repair', inspection: 'Inspection', other: 'Other' };

// Service that is not a breakdown: a vendor visit under an AMC/CMC, an in-house repair, an inspection. Entered by
// hand with the date it happened (not in the future); the service report can be attached. Wrong entries are removed
// only through the HOD (Request delete), like every other record.
export function AssetServiceLogTab({ assetId, canEdit, canRequest, requestDelete }: { assetId: string; canEdit: boolean; canRequest: boolean; requestDelete: (t: DeleteTarget) => void }) {
  const { message } = App.useApp();
  const logs = useFetch<ServiceLogRow[]>(`/assets/${assetId}/service-logs`);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [form] = Form.useForm();

  async function save() {
    const v = form.getFieldsValue();
    const input = parseForm(form, createServiceLogSchema, { ...v, serviceDate: v.serviceDate ? v.serviceDate.format('YYYY-MM-DD') : undefined });
    if (!input) return;
    setSaving(true);
    try {
      const row = await api<ServiceLogRow>(`/assets/${assetId}/service-logs`, { body: input });
      const failed = await uploadAll(files, { ownerType: 'service_log', ownerId: row.id }, () => 'service_report');
      if (failed.length) message.warning(`Service logged, but ${failed.join(', ')} could not be uploaded. Use Documents on the entry to add it again.`, 8);
      else message.success('Service logged');
      setAdding(false);
      logs.reload();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="Service log"
      extra={
        canEdit && (
          <Button
            onClick={() => {
              form.resetFields();
              form.setFieldsValue({ kind: 'amc_visit', serviceDate: dayjs() });
              setFiles([]);
              setAdding(true);
            }}
          >
            Log service
          </Button>
        )
      }
    >
      <div style={{ color: COLORS.muted, marginBottom: 12 }}>Vendor visits, in-house repairs and inspections that were not a complaint. PMS, calibration and breakdowns have their own tabs.</div>
      <DataTable<ServiceLogRow>
        rows={logs.data}
        loading={logs.loading}
        error={logs.error}
        onRetry={logs.reload}
        emptyText={canEdit ? 'No service logged yet. Use Log service to add a vendor visit or repair.' : 'No service logged yet.'}
        columns={[
          { title: 'Date', dataIndex: 'serviceDate', render: formatDate },
          { title: 'Kind', dataIndex: 'kind', render: (k: ServiceKind) => SERVICE_LABEL[k] },
          { title: 'Vendor', dataIndex: 'vendor', render: (v: string | null) => v ?? '—' },
          { title: 'What was done', dataIndex: 'description' },
          {
            title: '',
            key: 'docs',
            align: 'right',
            render: (_: unknown, r: ServiceLogRow) => (
              <DocumentsButton ownerType="service_log" ownerId={r.id} title={`${SERVICE_LABEL[r.kind]} ${formatDate(r.serviceDate)}`} kinds={['service_report', 'invoice', 'other']} canUpload={canEdit} count={r.attachmentCount} onChanged={logs.reload} />
            ),
          },
          ...(canRequest
            ? [
                {
                  title: '',
                  key: 'request-delete',
                  align: 'right' as const,
                  render: (_: unknown, r: ServiceLogRow) => (
                    <Button size="small" type="text" danger onClick={() => requestDelete({ type: 'service_log', id: r.id, label: `Service entry of ${formatDate(r.serviceDate)}: ${r.description.slice(0, 60)}` })}>
                      Request delete
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      <Modal open={adding} title="Log service" okText="Save" confirmLoading={saving} onOk={save} onCancel={() => setAdding(false)} destroyOnHidden>
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="Date of service" name="serviceDate" rules={[{ required: true, message: 'Choose the date' }]} extra="The day it happened. It cannot be in the future.">
            <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
          </Form.Item>
          <Form.Item label="Kind" name="kind" rules={[{ required: true }]}>
            <Select options={SERVICE_KINDS.map((k) => ({ value: k, label: SERVICE_LABEL[k] }))} />
          </Form.Item>
          <Form.Item label="Vendor or engineer" name="vendor">
            <Input maxLength={150} />
          </Form.Item>
          <Form.Item label="What was done?" name="description" rules={[{ required: true, message: 'Say what was done' }]}>
            <Input.TextArea rows={3} maxLength={1000} showCount />
          </Form.Item>
          <Form.Item label="Service report" extra="Optional. PDF, JPG or PNG, up to 10 MB.">
            <FilePicker files={files} onChange={setFiles} label="Attach the report" max={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
