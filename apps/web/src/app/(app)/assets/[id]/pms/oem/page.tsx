'use client';

import { InboxOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, DatePicker, Form, Input, Radio, Space, Switch, Typography, Upload } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { MAX_UPLOAD_BYTES, OEM_PMS_MAX_DAYS_BACK, oemPmsSchema, type AssetDetail, type PmsAnswer, type PmsRecordRow, type PmsTemplateRow } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { outOfRange, PmsChecklist } from '@/components/PmsChecklist';
import { FormPageSkeleton } from '@/components/Skeletons';
import { StatusResult } from '@/components/StatusResult';
import { api, ApiError, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate, hospitalToday } from '@/lib/format';
import { useLeaveGuard, useSingleFlight } from '@/lib/forms';

// Pass / Fail as on the report. The form passes value, onChange, id and aria-required to its child; the aria ones
// belong on an element with the radiogroup role, which Radio.Group does not take.
function ResultChoice({ value, onChange, id, 'aria-required': required }: { value?: string; onChange?: (v: string) => void; id?: string; 'aria-required'?: boolean | 'true' | 'false' }) {
  return (
    <div role="radiogroup" id={id} aria-label="Result on the report" aria-required={required}>
      <Radio.Group
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        optionType="button"
        buttonStyle="solid"
        options={[
          { label: 'Pass', value: 'pass', className: 'pf-pass' },
          { label: 'Fail', value: 'fail', className: 'pf-fail' },
        ]}
      />
    </div>
  );
}

// A PMS done by the manufacturer's (OEM) engineer, entered from their report (decision A). The date is the visit date
// on the report: not after today, at most OEM_PMS_MAX_DAYS_BACK days back, not before the last PMS. The report is
// required; our checklist is optional. ?corrects=<id> replaces an earlier OEM entry and keeps its date.
function OemPmsPage() {
  const { id } = useParams<{ id: string }>();
  const corrects = useSearchParams().get('corrects');
  const router = useRouter();
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const allowed = can('pms.perform');
  const asset = useFetch<AssetDetail>(allowed ? `/assets/${id}` : null, { fresh: true });
  const records = useFetch<PmsRecordRow[]>(allowed ? `/assets/${id}/pms` : null, { fresh: true });
  const template = useFetch<PmsTemplateRow>(allowed ? `/assets/${id}/pms-template` : null, { fresh: true });
  const original = useFetch<PmsRecordRow>(allowed && corrects ? `/pms/${corrects}` : null, { fresh: true });

  const [form] = Form.useForm();
  const [report, setReport] = useState<File | null>(null);
  const [withChecklist, setWithChecklist] = useState(false);
  const [answers, setAnswers] = useState<Record<string, PmsAnswer>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const single = useSingleFlight();
  useLeaveGuard(!!report && !saving);

  if (!allowed) return <StatusResult status="403" title="You cannot record PMS" />;
  if (asset.error) return <StatusResult status="404" title="Asset not found" extra={<Link href="/assets"><Button>Back to assets</Button></Link>} />;
  if (!asset.data || !records.data || (corrects && !original.data)) return <FormPageSkeleton sections={2} fields={4} />;
  const a = asset.data;
  const today = hospitalToday();
  // The last PMS done (corrections are about the same PMS): a visit cannot be entered before it.
  const last = records.data.filter((r) => !r.correctsRecordId).map((r) => r.performedOn).sort().at(-1);
  const earliest = [today.subtract(OEM_PMS_MAX_DAYS_BACK, 'day'), ...(last ? [dayjs(last)] : []), ...(a.installationDate ? [dayjs(a.installationDate)] : [])].reduce((x, y) => (y.isAfter(x) ? y : x));
  const items = template.data?.items ?? [];
  const checklist = withChecklist && items.length > 0;
  const willFail = checklist && items.some((i) => (i.type === 'check' && answers[i.id] === 'fail') || outOfRange(i, answers[i.id]));

  const set = (itemId: string, value: PmsAnswer | undefined) => {
    setAnswers((prev) => {
      const next = { ...prev };
      if (value === undefined || value === '') delete next[itemId];
      else next[itemId] = value;
      return next;
    });
    setErrors((prev) => ({ ...prev, [itemId]: '' }));
  };

  async function submit(input: unknown) {
    setSaving(true);
    try {
      const body = new FormData();
      body.set('data', JSON.stringify(input));
      body.set('file', report!);
      const record = await api<PmsRecordRow>(`/assets/${id}/pms/oem`, { body });
      message.success(corrects ? 'Correction recorded' : `OEM PMS recorded for ${a.assetCode}`);
      router.push(`/pms/${record.id}`);
    } catch (e) {
      const fields = e instanceof ApiError ? e.details?.fieldErrors : undefined;
      if (fields) {
        form.setFields(Object.entries(fields).filter(([k]) => ['performedOn', 'serviceBy', 'result', 'correctionReason'].includes(k)).map(([name, v]) => ({ name, errors: v ?? [] })));
        setErrors(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v?.[0] ?? ''])));
      }
      message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function confirm() {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    if (!report) {
      setErrors((prev) => ({ ...prev, file: 'Attach the report (PDF, JPG or PNG)' }));
      return;
    }
    const open = checklist ? items.filter((i) => i.required && answers[i.id] === undefined) : [];
    if (open.length) {
      setErrors(Object.fromEntries(open.map((i) => [i.id, 'Answer this, or switch the checklist off'])));
      document.getElementById(`pms-item-${open[0].id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const input = {
      performedOn: corrects && original.data ? original.data.performedOn : (v.performedOn as Dayjs).format('YYYY-MM-DD'),
      serviceBy: v.serviceBy,
      ...(checklist ? { answers } : { result: v.result }),
      ...(corrects ? { correctsRecordId: corrects, correctionReason: v.correctionReason } : {}),
    };
    const parsed = oemPmsSchema.safeParse(input);
    if (!parsed.success) {
      message.error(parsed.error.issues[0].message);
      return;
    }
    modal.confirm({
      title: corrects ? 'Submit this correction?' : 'Record this OEM PMS?',
      content: `It is recorded as done on ${formatDate(parsed.data.performedOn)} by ${parsed.data.serviceBy}, entered by you, with the report attached. Neither can be changed afterwards.`,
      okText: 'Submit',
      onOk: () => single(() => submit(parsed.data)),
    });
  }

  return (
    <>
      <PageHeader
        title={corrects ? `Correct OEM PMS · ${a.assetCode}` : `OEM PMS · ${a.assetCode}`}
        subtitle={`${a.name} · ${a.equipmentTypeName}`}
        crumbs={['Assets', a.assetCode, 'OEM PMS']}
      />
      <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 840 }}>
        <Alert
          type="info"
          showIcon
          message="For a PMS done by the manufacturer's engineer"
          description={`Enter it from their service report, within ${OEM_PMS_MAX_DAYS_BACK} days of the visit. The report is attached to the record. For a PMS you do yourselves, use Perform PMS instead: it is dated today by the system.`}
        />
        <Card>
          <Form form={form} layout="vertical" requiredMark initialValues={{ performedOn: corrects ? undefined : today, serviceBy: original.data?.serviceBy ?? '' }}>
            {corrects && original.data ? (
              <>
                <Form.Item label="Date of the visit">{formatDate(original.data.performedOn)} (kept from the record being corrected)</Form.Item>
                <Form.Item label="What was wrong with the earlier entry?" name="correctionReason" rules={[{ required: true, min: 5, message: 'Say why this correction is needed' }]}>
                  <Input.TextArea rows={2} maxLength={500} showCount />
                </Form.Item>
              </>
            ) : (
              <Form.Item
                label="Date of the visit (as on the report)"
                name="performedOn"
                rules={[{ required: true, message: 'Pick the date of the visit' }]}
                extra={last ? `The last PMS on this equipment was on ${formatDate(last)}.` : undefined}
              >
                <DatePicker format="DD MMM YYYY" style={{ width: 220 }} disabledDate={(d) => d.isAfter(today, 'day') || d.isBefore(earliest, 'day')} />
              </Form.Item>
            )}
            <Form.Item label="Engineer and company" name="serviceBy" rules={[{ required: true, min: 3, message: 'Enter the engineer and company, as on the report' }]}>
              <Input maxLength={150} placeholder="e.g. Mr. A. Shah, Philips Healthcare" />
            </Form.Item>
            <Form.Item label="Service report" required validateStatus={errors.file ? 'error' : undefined} help={errors.file || 'PDF, JPG or PNG, up to 10 MB. A photo of the paper report is fine.'}>
              <Upload.Dragger
                accept=".pdf,.jpg,.jpeg,.png"
                maxCount={1}
                fileList={report ? [{ uid: '1', name: report.name, status: 'done' }] : []}
                onRemove={() => setReport(null)}
                beforeUpload={(f) => {
                  if (f.size > MAX_UPLOAD_BYTES) message.error('That file is over 10 MB');
                  else {
                    setReport(f);
                    setErrors((prev) => ({ ...prev, file: '' }));
                  }
                  return false;
                }}
              >
                <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                <p className="ant-upload-text">Drop the report here or click to choose</p>
              </Upload.Dragger>
            </Form.Item>
            {items.length > 0 && (
              <Form.Item label="Our checklist">
                <Space>
                  <Switch checked={withChecklist} onChange={setWithChecklist} aria-label="Also fill our checklist" />
                  <Typography.Text type="secondary">Also fill our checklist (optional). The result is then worked out from it.</Typography.Text>
                </Space>
              </Form.Item>
            )}
            {!checklist && (
              <Form.Item label="Result on the report" name="result" rules={[{ required: true, message: 'Choose the result on the report' }]}>
                <ResultChoice />
              </Form.Item>
            )}
          </Form>
        </Card>
        {checklist && <PmsChecklist items={items} version={template.data?.version} answers={answers} errors={errors} onChange={set} />}
        {willFail && <Alert type="warning" showIcon message="This PMS will be recorded as FAIL" description="At least one check failed or a reading is outside its allowed range." />}
        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Link href={`/assets/${id}?tab=pms`}>
            <Button>Cancel</Button>
          </Link>
          <Button type="primary" loading={saving} onClick={() => void confirm()}>
            {corrects ? 'Submit correction' : 'Record OEM PMS'}
          </Button>
        </Space>
      </Space>
    </>
  );
}

export default function OemPmsRoute() {
  return (
    <Suspense fallback={null}>
      <OemPmsPage />
    </Suspense>
  );
}
