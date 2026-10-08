'use client';

import { Alert, App, Button, Card, Col, DatePicker, Form, Input, InputNumber, Row, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  CRITICALITIES,
  createAssetSchema,
  updateAssetSchema,
  type AssetDetail,
  type AssetStatus,
  type UpdateAssetResponse,
} from '@bme/shared';
import { FilePicker } from '@/components/FilePicker';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';
import { uploadAll } from '@/lib/uploads';

type Department = { id: string; name: string };
type Location = { id: string; departmentId: string; name: string };
type EquipmentType = { id: string; name: string; defaultPmsMonths: number | null; defaultCalibrationMonths?: number | null };

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
  openingPmsOn?: dayjs.Dayjs | null;
  openingCalibrationOn?: dayjs.Dayjs | null;
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
  openingPmsOn: a.openingPmsOn ? dayjs(a.openingPmsOn) : null,
  openingCalibrationOn: a.openingCalibrationOn ? dayjs(a.openingCalibrationOn) : null,
});

// Form values → API body (dates as YYYY-MM-DD, empty numbers as null).
const toBody = (v: Values) => ({
  ...v,
  installationDate: v.installationDate ? v.installationDate.format('YYYY-MM-DD') : null,
  warrantyMonths: v.warrantyMonths ?? null,
  pmsFrequencyMonths: v.pmsFrequencyMonths ?? null,
  openingPmsOn: v.openingPmsOn ? v.openingPmsOn.format('YYYY-MM-DD') : null,
  openingCalibrationOn: v.openingCalibrationOn ? v.openingCalibrationOn.format('YYYY-MM-DD') : null,
});

// A titled card for one group of fields, so a long form reads as a few clear steps.
function FormSection({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 24 } }}>
      <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--line-soft)' }}>
        <Typography.Title level={2} style={{ margin: 0, fontSize: 17, fontWeight: 800, lineHeight: 1.4 }}>
          {title}
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 13.5 }}>{hint}</Typography.Text>
      </div>
      {children}
    </Card>
  );
}

export function AssetForm({ asset }: { asset?: AssetDetail }) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const router = useRouter();
  const [form] = Form.useForm<Values>();
  const [saving, setSaving] = useState(false);
  // Documents to attach once the asset exists (new assets only): the installation report, photos, the manual.
  const [docs, setDocs] = useState<{ report: File[]; photos: File[]; manual: File[] }>({ report: [], photos: [], manual: [] });

  const types = useFetch<EquipmentType[]>('/equipment-types');
  const departments = useFetch<Department[]>('/departments');
  const locations = useFetch<Location[]>('/locations');
  const departmentId = Form.useWatch('departmentId', form);
  const typeId = Form.useWatch('equipmentTypeId', form);
  const installed = Form.useWatch('installationDate', form);
  const pmsEvery = Form.useWatch('pmsFrequencyMonths', form);
  const lastPms = Form.useWatch('openingPmsOn', form);
  const lastCal = Form.useWatch('openingCalibrationOn', form);

  const initial = asset ? toForm(asset) : { criticality: 'medium' };
  useEffect(() => {
    form.setFieldsValue(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset]);

  const needsApproval = !!asset && !can('asset.edit_key');

  const single = useSingleFlight();

  async function save() {
    if (saving) return; // a second click or key press while the first is still saving
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
    let leaving = false;
    try {
      if (asset) {
        const res = await api<UpdateAssetResponse>(`/assets/${asset.id}`, { method: 'PATCH', body: input });
        message.success(res.pendingApproval ? 'Saved. Changes to key fields were sent to the HOD for approval.' : 'Asset updated');
        leaving = true;
        router.push(`/assets/${asset.id}`);
      } else {
        const created = await api<AssetDetail>('/assets', { body: input });
        leaving = true; // the asset exists now: never allow a second create from this form
        const owner = { ownerType: 'asset' as const, ownerId: created.id };
        const failed = [
          ...(await uploadAll(docs.report, owner, () => 'installation_report')),
          ...(await uploadAll(docs.photos, owner, () => 'photo')),
          ...(await uploadAll(docs.manual, owner, () => 'manual')),
        ];
        if (failed.length) message.warning(`Asset ${created.assetCode} created, but ${failed.join(', ')} could not be uploaded. Add ${failed.length === 1 ? 'it' : 'them'} again from the Documents tab.`, 8);
        else message.success(`Asset ${created.assetCode} created`);
        router.push(`/assets/${created.id}`);
      }
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      if (!leaving) setSaving(false); // after a successful save the button stays busy until the next page opens
    }
  }

  // Existing equipment registered with no "last done" date shows as overdue at once. Say so before it happens.
  const monthsAgo = installed ? dayjs().diff(installed, 'month') : 0;
  const type = types.data?.find((t) => t.id === typeId);
  const pmsLate = !asset && !lastPms && installed && monthsAgo > (pmsEvery ?? type?.defaultPmsMonths ?? 12);
  const calLate = !asset && !lastCal && installed && !!type?.defaultCalibrationMonths && monthsAgo > type.defaultCalibrationMonths;

  const half = { xs: 24, md: 12 } as const;

  return (
    <Form
      form={form}
      layout="vertical"
      requiredMark
      onFinish={() => single(save)}
      // Enter in a field must not save a half-finished form (typing a date and pressing Enter is natural). Only the
      // Save button saves. Dropdowns keep Enter for choosing an option.
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (e.key === 'Enter' && t.tagName === 'INPUT' && !t.closest('.ant-select')) e.preventDefault();
      }}
    >
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
          Asset ID <strong className="code">{asset.assetCode}</strong> never changes, even if the location does.
        </Typography.Paragraph>
      )}

      <FormSection title="Identity" hint="What the equipment is.">
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
      </FormSection>

      <FormSection title="Location" hint="Where it is installed. Part of the asset ID.">
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
      </FormSection>

      <FormSection title="Installation & warranty" hint="Dates and the maintenance schedule.">
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
      </FormSection>

      <FormSection title="Already in use?" hint="Only for equipment that was working before this system. Leave blank for new equipment.">
        <Row gutter={16}>
        <Col {...half}>
          <Form.Item
            label="Last PMS done"
            name="openingPmsOn"
            extra="When PMS was last done before this system. The next PMS is due from this date, not from the installation date."
          >
            <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
          </Form.Item>
        </Col>
        <Col {...half}>
          <Form.Item label="Last calibration done" name="openingCalibrationOn" extra="When calibration was last done. Once a PMS or calibration is recorded in this system, these dates can no longer be changed.">
            <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
          </Form.Item>
        </Col>
        </Row>
      </FormSection>

      {(pmsLate || calLate) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`Installed ${monthsAgo >= 24 ? `${Math.floor(monthsAgo / 12)} years` : `${monthsAgo} months`} ago`}
          description={`Without the date ${pmsLate && calLate ? 'PMS and calibration were' : pmsLate ? 'PMS was' : 'calibration was'} last done, this equipment will show as overdue as soon as it is saved. If it has been maintained, enter the date${pmsLate && calLate ? 's' : ''} under "Already in use?" above.`}
        />
      )}

      {!asset && (
        <FormSection title="Documents" hint="Optional. Attach now, or add them later from the asset's Documents tab. PDF, JPG or PNG, up to 10 MB each.">
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            <FilePicker files={docs.report} onChange={(f) => setDocs((d) => ({ ...d, report: f }))} label="Installation report" max={3} />
            <FilePicker files={docs.photos} onChange={(f) => setDocs((d) => ({ ...d, photos: f }))} label="Photos (with the serial number)" max={5} />
            <FilePicker files={docs.manual} onChange={(f) => setDocs((d) => ({ ...d, manual: f }))} label="Manual" max={3} />
          </div>
        </FormSection>
      )}

      <div className="form-actions">
        <Link href={asset ? `/assets/${asset.id}` : '/assets'}>
          <Button>Cancel</Button>
        </Link>
        <Button type="primary" htmlType="submit" loading={saving}>
          {asset ? 'Save changes' : 'Create asset'}
        </Button>
      </div>
    </Form>
  );
}
