'use client';

import { InboxOutlined } from '@ant-design/icons';
import { App, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Upload } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { MAX_UPLOAD_BYTES, createCalibrationSchema, type AssetDetail, type CalibrationRow } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { DueTag, StatusTag } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { daysFromToday, formatDate } from '@/lib/format';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';
import { COLORS } from '@/theme';

export function AssetCalibrationTab({ asset, onChanged }: { asset: AssetDetail; onChanged: () => void }) {
  const { message } = App.useApp();
  const records = useFetch<CalibrationRow[]>(`/assets/${asset.id}/calibrations`);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [certificate, setCertificate] = useState<File | null>(null);
  const [form] = Form.useForm();
  const active = asset.status === 'active';

  async function uploadCertificate(recordId: string, file: File) {
    const body = new FormData();
    body.set('file', file);
    await api(`/calibration/records/${recordId}/certificate`, { body });
  }

  const single = useSingleFlight();

  async function save() {
    const v = form.getFieldsValue();
    const input = parseForm(form, createCalibrationSchema, {
      doneOn: v.doneOn ? v.doneOn.format('YYYY-MM-DD') : undefined,
      dueOn: v.dueOn ? v.dueOn.format('YYYY-MM-DD') : null,
      agency: v.agency,
      result: v.result,
    });
    if (!input) return;
    setSaving(true);
    try {
      const created = await api<CalibrationRow>(`/assets/${asset.id}/calibrations`, { body: input });
      if (certificate) await uploadCertificate(created.id, certificate).catch(() => message.warning('Saved, but the certificate could not be uploaded. Add it from the list.'));
      message.success('Calibration recorded');
      setOpen(false);
      records.reload();
      onChanged();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function addLater(row: CalibrationRow, file: File) {
    try {
      await uploadCertificate(row.id, file);
      message.success('Certificate uploaded');
      records.reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Upload failed');
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Space size={32} wrap align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
          <div>
            <div style={{ color: COLORS.muted, fontSize: 12, marginBottom: 4 }}>Next calibration due</div>
            {asset.nextCalibrationDue ? (
              <Space>
                <span>{formatDate(asset.nextCalibrationDue)}</span>
                <DueTag daysLeft={daysFromToday(asset.nextCalibrationDue)} />
              </Space>
            ) : (
              '—'
            )}
          </div>
          {active && (
            <Button
              onClick={() => {
                form.resetFields();
                form.setFieldsValue({ doneOn: dayjs(), result: 'pass' });
                setCertificate(null);
                setOpen(true);
              }}
            >
              Record calibration
            </Button>
          )}
        </Space>
      </Card>
      <DataTable<CalibrationRow>
        rows={records.data}
        loading={records.loading}
        error={records.error}
        onRetry={records.reload}
        emptyText="No calibration recorded yet."
        columns={[
          { title: 'Done on', dataIndex: 'doneOn', render: formatDate },
          { title: 'Next due', dataIndex: 'dueOn', render: formatDate },
          { title: 'Agency', dataIndex: 'agency' },
          { title: 'Result', dataIndex: 'result', render: (r: CalibrationRow['result']) => <StatusTag status={r} /> },
          {
            title: 'Certificate',
            key: 'certificate',
            render: (_: unknown, row) =>
              row.certificate ? (
                <a href={`/api/v1/attachments/${row.certificate.id}/download`} target="_blank" rel="noreferrer">
                  {row.certificate.fileName}
                </a>
              ) : (
                <Upload
                  accept=".pdf,.jpg,.jpeg,.png"
                  showUploadList={false}
                  beforeUpload={(f) => {
                    if (f.size > MAX_UPLOAD_BYTES) message.error('That file is over 10 MB');
                    else void addLater(row, f);
                    return false;
                  }}
                >
                  <Button size="small">Upload certificate</Button>
                </Upload>
              ),
          },
        ]}
      />
      <Modal open={open} title="Record calibration" okText="Save" confirmLoading={saving} onOk={() => single(save)} onCancel={() => setOpen(false)} destroyOnHidden>
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="Calibration date" name="doneOn" rules={[{ required: true, message: 'Pick the date' }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
          </Form.Item>
          <Form.Item label="Next due date" name="dueOn" extra="Leave blank to use the equipment type's usual interval.">
            <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Agency or engineer" name="agency" rules={[{ required: true, message: 'Enter who calibrated it' }]}>
            <Input maxLength={150} />
          </Form.Item>
          <Form.Item label="Result" name="result" rules={[{ required: true }]}>
            <Select options={[{ value: 'pass', label: 'Pass' }, { value: 'fail', label: 'Fail' }]} />
          </Form.Item>
          <Form.Item label="Certificate (optional)">
            <Upload.Dragger
              accept=".pdf,.jpg,.jpeg,.png"
              maxCount={1}
              fileList={certificate ? [{ uid: '1', name: certificate.name, status: 'done' }] : []}
              onRemove={() => setCertificate(null)}
              beforeUpload={(f) => {
                if (f.size > MAX_UPLOAD_BYTES) message.error('That file is over 10 MB');
                else setCertificate(f);
                return false;
              }}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">Drop the certificate here or click to choose</p>
              <p className="ant-upload-hint">PDF, JPG or PNG, up to 10 MB</p>
            </Upload.Dragger>
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
