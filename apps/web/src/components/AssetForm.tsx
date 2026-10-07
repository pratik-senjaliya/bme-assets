'use client';

import { Alert, App, Button, Col, DatePicker, Form, Input, InputNumber, Row, Select, Space, Typography } from 'antd';
import dayjs from 'dayjs';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  CRITICALITIES,
  createAssetSchema,
  updateAssetSchema,
  type AssetDetail,
  type AssetStatus,
  type UpdateAssetResponse,
} from '@bme/shared';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { parseForm, showApiFieldErrors } from '@/lib/forms';

type Department = { id: string; name: string };
type Location = { id: string; departmentId: string; name: string };
type EquipmentType = { id: string; name: string; defaultPmsMonths: number | null };

type Values = {
  equipmentTypeId?: string;
  name?: string;
  make?: string;
  model?: string;
  serialNo?: string;
  departmentId?: string;
  locationId?: string;
  criticality?: string;
  status?: AssetStatus;
  installationDate?: dayjs.Dayjs | null;
  warrantyMonths?: number | null;
  pmsFrequencyMonths?: number | null;
};

const toForm = (a: AssetDetail): Values => ({
  equipmentTypeId: a.equipmentTypeId,
  name: a.name,
  make: a.make ?? undefined,
  model: a.model ?? undefined,
  serialNo: a.serialNo ?? undefined,
  departmentId: a.departmentId,
  locationId: a.locationId,
  criticality: a.criticality,
  status: a.status,
  installationDate: a.installationDate ? dayjs(a.installationDate) : null,
  warrantyMonths: a.warrantyMonths,
  pmsFrequencyMonths: a.pmsFrequencyMonths,
});

// Form values → API body (dates as YYYY-MM-DD, empty numbers as null).
const toBody = (v: Values) => ({
  ...v,
  installationDate: v.installationDate ? v.installationDate.format('YYYY-MM-DD') : null,
  warrantyMonths: v.warrantyMonths ?? null,
  pmsFrequencyMonths: v.pmsFrequencyMonths ?? null,
});

export function AssetForm({ asset }: { asset?: AssetDetail }) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const router = useRouter();
  const [form] = Form.useForm<Values>();
  const [saving, setSaving] = useState(false);

  const types = useFetch<EquipmentType[]>('/equipment-types');
  const departments = useFetch<Department[]>('/departments');
  const locations = useFetch<Location[]>('/locations');
  const departmentId = Form.useWatch('departmentId', form);

  const initial = asset ? toForm(asset) : { criticality: 'medium' };
  useEffect(() => {
    form.setFieldsValue(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset]);

  const needsApproval = !!asset && !can('asset.edit_key');

  async function save() {
    const all = toBody(form.getFieldsValue());
    let body: Record<string, unknown> = all;
    if (asset) {
      // Send only what changed, so an untouched form makes no change (and no audit entry).
      const was = toBody(initial);
      body = Object.fromEntries(Object.entries(all).filter(([k, v]) => (v ?? null) !== ((was as Record<string, unknown>)[k] ?? null)));
      if (Object.keys(body).length === 0) {
        router.push(`/assets/${asset.id}`);
        return;
      }
    }
    const input = parseForm(form, asset ? updateAssetSchema : createAssetSchema, body);
    if (!input) return;

    setSaving(true);
    try {
      if (asset) {
        const res = await api<UpdateAssetResponse>(`/assets/${asset.id}`, { method: 'PATCH', body: input });
        message.success(res.pendingApproval ? 'Saved. Changes to key fields were sent to the HOD for approval.' : 'Asset updated');
        router.push(`/assets/${asset.id}`);
      } else {
        const created = await api<AssetDetail>('/assets', { body: input });
        message.success(`Asset ${created.assetCode} created`);
        router.push(`/assets/${created.id}`);
      }
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const section = (title: string) => (
    <Typography.Title level={5} style={{ marginTop: 8 }}>
      {title}
    </Typography.Title>
  );
  const half = { xs: 24, md: 12 } as const;

  return (
    <Form form={form} layout="vertical" requiredMark onFinish={save}>
      {needsApproval && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Serial number, equipment type, department and location need HOD approval. Other changes are saved straight away."
        />
      )}
      {asset && (
        <Typography.Paragraph type="secondary">
          Asset ID <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{asset.assetCode}</strong> never changes, even if the location does.
        </Typography.Paragraph>
      )}

      {section('Identity')}
      <Row gutter={16}>
        <Col {...half}>
          <Form.Item label="Equipment type" name="equipmentTypeId" rules={[{ required: true, message: 'Choose a type' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              loading={types.loading}
              options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
              onChange={(id) => {
                // New assets start from the type's usual PMS interval.
                const t = types.data?.find((x) => x.id === id);
                if (!asset && t?.defaultPmsMonths && !form.getFieldValue('pmsFrequencyMonths')) form.setFieldValue('pmsFrequencyMonths', t.defaultPmsMonths);
              }}
            />
          </Form.Item>
        </Col>
        <Col {...half}>
          <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Enter a name' }]}>
            <Input maxLength={150} />
          </Form.Item>
        </Col>
        <Col {...half}>
          <Form.Item label="Make" name="make">
            <Input maxLength={100} />
          </Form.Item>
        </Col>
        <Col {...half}>
          <Form.Item label="Model" name="model">
            <Input maxLength={100} />
          </Form.Item>
        </Col>
        <Col {...half}>
          <Form.Item label="Serial number" name="serialNo">
            <Input maxLength={100} />
          </Form.Item>
        </Col>
        <Col {...half}>
          <Form.Item label="Criticality" name="criticality" extra="How badly patient care suffers if this equipment is down.">
            <Select options={CRITICALITIES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))} />
          </Form.Item>
        </Col>
      </Row>

      {section('Location')}
      <Row gutter={16}>
        <Col {...half}>
          <Form.Item label="Department" name="departmentId" rules={[{ required: true, message: 'Choose a department' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              loading={departments.loading}
              options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
              onChange={() => form.setFieldValue('locationId', undefined)}
            />
          </Form.Item>
        </Col>
        <Col {...half}>
          <Form.Item label="Location" name="locationId" rules={[{ required: true, message: 'Choose a location' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              disabled={!departmentId}
              placeholder={departmentId ? undefined : 'Choose a department first'}
              options={(locations.data ?? []).filter((l) => l.departmentId === departmentId).map((l) => ({ value: l.id, label: l.name }))}
            />
          </Form.Item>
        </Col>
      </Row>

      {section('Installation & warranty')}
      <Row gutter={16}>
        <Col {...half}>
          <Form.Item label="Installation date" name="installationDate">
            <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs().add(1, 'year'))} />
          </Form.Item>
        </Col>
        <Col {...half}>
          <Form.Item label="Warranty (months)" name="warrantyMonths" extra="The warranty end date is worked out from the installation date.">
            <InputNumber min={0} max={240} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col {...half}>
          <Form.Item label="PMS every (months)" name="pmsFrequencyMonths" extra="Defaults to the equipment type's usual interval.">
            <InputNumber min={1} max={120} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        {asset && asset.status !== 'condemned' && (
          <Col {...half}>
            <Form.Item label="Status" name="status" extra="Condemning an asset is a separate request that the HOD approves.">
              <Select options={[{ value: 'active', label: 'Active' }, { value: 'not_in_use', label: 'Not in use' }]} />
            </Form.Item>
          </Col>
        )}
      </Row>

      <Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Link href={asset ? `/assets/${asset.id}` : '/assets'}>
          <Button>Cancel</Button>
        </Link>
        <Button type="primary" htmlType="submit" loading={saving}>
          {asset ? 'Save changes' : 'Create asset'}
        </Button>
      </Space>
    </Form>
  );
}
