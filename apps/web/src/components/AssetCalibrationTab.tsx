'use client';

import { InboxOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Upload } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { MAX_UPLOAD_BYTES, createCalibrationSchema, type AssetDetail, type CalibrationRow } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { DueTag, Pill, StatusTag } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { daysFromToday, formatDate, hospitalToday } from '@/lib/format';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';
import { COLORS } from '@/theme';

export function AssetCalibrationTab({ asset, onChanged }: { asset: AssetDetail; onChanged: () => void }) {
  const { message } = App.useApp();
  const records = useFetch<CalibrationRow[]>(`/assets/${asset.id}/calibrations`);
  const [open, setOpen] = useState(false);
  // A record entered wrongly is replaced by a correction (a new record); the original stays in the list, marked.
  const [correcting, setCorrecting] = useState<CalibrationRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [certificates, setCertificates] = useState<File[]>([]);
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
      ...(correcting && { correctsRecordId: correcting.id, correctionReason: v.correctionReason }),
    });
    if (!input) return;
    setSaving(true);
    try {
      const created = await api<CalibrationRow>(`/assets/${asset.id}/calibrations`, { body: input });
      const failed: string[] = [];
      for (const f of certificates) await uploadCertificate(created.id, f).catch(() => failed.push(f.name));
      if (failed.length) message.warning(`Saved, but ${failed.join(', ')} could not be uploaded. Add ${failed.length === 1 ? 'it' : 'them'} from the list.`);
      message.success(correcting ? 'Correction saved' : 'Calibration recorded');
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
                setCorrecting(null);
                form.setFieldsValue({ doneOn: hospitalToday(), result: 'pass' });
                setCertificates([]);
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
          {
            title: 'Done on',
            dataIndex: 'doneOn',
            render: (d: string, row) => (
              <Space direction="vertical" size={2}>
                <span>{formatDate(d)}</span>
                {row.correctedById && <Pill tone="neutral">Replaced by a correction</Pill>}
                {row.correctsRecordId && <span style={{ color: COLORS.muted, fontSize: 12.5 }}>Correction: {row.correctionReason}</span>}
              </Space>
            ),
          },
          { title: 'Next due', dataIndex: 'dueOn', render: formatDate },
          { title: 'Agency', dataIndex: 'agency' },
          { title: 'Result', dataIndex: 'result', render: (r: CalibrationRow['result']) => <StatusTag status={r} /> },
          {
            title: 'Certificate',
            key: 'certificate',
            render: (_: unknown, row) =>
              <Space direction="vertical" size={4}>
                {row.certificates.map((c) => (
                  <a key={c.id} href={`/api/v1/attachments/${c.id}/download`} target="_blank" rel="noreferrer">
                    {c.fileName}
                  </a>
                ))}
                <Upload
                  accept=".pdf,.jpg,.jpeg,.png"
                  showUploadList={false}
                  beforeUpload={(f) => {
                    if (f.size > MAX_UPLOAD_BYTES) message.error('That file is over 10 MB');
                    else void addLater(row, f);
                    return false;
                  }}
                >
                  <Button size="small">{row.certificates.length ? 'Add another' : 'Upload certificate'}</Button>
                </Upload>
              </Space>,
          },
          ...(active
            ? [
                {
                  title: '',
                  key: 'correct',
                  render: (_: unknown, row: CalibrationRow) =>
                    !row.correctedById && (
                      <Button
                        size="small"
                        type="link"
                        onClick={() => {
                          form.resetFields();
                          form.setFieldsValue({ doneOn: dayjs(row.doneOn), dueOn: dayjs(row.dueOn), agency: row.agency, result: row.result });
                          setCertificates([]);
                          setCorrecting(row);
                          setOpen(true);
                        }}
                      >
                        Correct
                      </Button>
                    ),
                },
              ]
            : []),
        ]}
      />
      <Modal open={open} title={correcting ? `Correct the calibration of ${formatDate(correcting.doneOn)}` : 'Record calibration'} okText="Save" confirmLoading={saving} onOk={() => single(save)} onCancel={() => setOpen(false)} destroyOnHidden>
        <Form form={form} layout="vertical" requiredMark>
          {correcting && (
            <>
              <Alert type="info" showIcon style={{ marginBottom: 16 }} message="The correction replaces this record. The original stays in the list, marked, and the change is recorded." />
              <Form.Item label="Why is it being corrected?" name="correctionReason" rules={[{ required: true, message: 'Say why' }]}>
                <Input maxLength={500} placeholder="e.g. Wrong date entered: the certificate says 12 Oct" />
              </Form.Item>
            </>
          )}
          <Form.Item label="Calibration date" name="doneOn" rules={[{ required: true, message: 'Pick the date' }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} disabledDate={(d) => d.isAfter(hospitalToday(), 'day')} />
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
          <Form.Item label="Certificates (optional)">
            <Upload.Dragger
              accept=".pdf,.jpg,.jpeg,.png"
              multiple
              maxCount={5}
              fileList={certificates.map((f, i) => ({ uid: String(i), name: f.name, status: 'done' as const }))}
              onRemove={(f) => setCertificates((all) => all.filter((_, i) => String(i) !== f.uid))}
              beforeUpload={(f) => {
                if (f.size > MAX_UPLOAD_BYTES) message.error(`${f.name} is over 10 MB`);
                else setCertificates((all) => (all.length < 5 ? [...all, f] : all));
                return false;
              }}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">Drop the certificates here or click to choose</p>
              <p className="ant-upload-hint">PDF, JPG or PNG, up to 10 MB</p>
            </Upload.Dragger>
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
