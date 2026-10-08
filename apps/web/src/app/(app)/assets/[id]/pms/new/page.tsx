'use client';

import { LockOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Input, InputNumber, Radio, Space, Tooltip, Typography } from 'antd';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { submitPmsSchema, type AssetDetail, type PmsAnswer, type PmsItem, type PmsRecordRow, type PmsTemplateRow } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { api, ApiError, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { StatusResult } from '@/components/StatusResult';
import { COLORS } from '@/theme';
import { FormPageSkeleton } from '@/components/Skeletons';

const rangeText = (i: PmsItem) =>
  i.min != null && i.max != null ? `${i.min}–${i.max}` : i.min != null ? `at least ${i.min}` : i.max != null ? `at most ${i.max}` : '';
const outOfRange = (i: PmsItem, v: PmsAnswer | undefined) =>
  i.type === 'reading' && typeof v === 'number' && ((i.min != null && v < i.min) || (i.max != null && v > i.max));

export default function PerformPmsPage() {
  const { id } = useParams<{ id: string }>();
  const corrects = useSearchParams().get('corrects');
  const router = useRouter();
  const { can } = useAuth();
  const { message, modal } = App.useApp();

  const allowed = can('pms.perform'); // ask only if the answer will be used
  const asset = useFetch<AssetDetail>(allowed ? `/assets/${id}` : null);
  const template = useFetch<PmsTemplateRow>(allowed ? `/assets/${id}/pms-template` : null);
  const original = useFetch<PmsRecordRow>(allowed && corrects ? `/pms/${corrects}` : null);

  const [answers, setAnswers] = useState<Record<string, PmsAnswer>>({});
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // A correction starts from the original answers.
  useEffect(() => {
    if (original.data) setAnswers(original.data.answers);
  }, [original.data]);

  if (!can('pms.perform')) return <StatusResult status="403" title="You cannot record PMS" />;
  if (asset.error) return <StatusResult status="404" title="Asset not found" extra={<Link href="/assets"><Button>Back to assets</Button></Link>} />;
  if (!asset.data || (template.loading && !template.data)) return <FormPageSkeleton sections={2} fields={4} />;
  const a = asset.data;
  const items = template.data?.items ?? [];

  const willFail = items.some((i) => (i.type === 'check' && answers[i.id] === 'fail') || outOfRange(i, answers[i.id]));
  const set = (itemId: string, value: PmsAnswer | undefined) => {
    setAnswers((prev) => {
      const next = { ...prev };
      if (value === undefined || value === '') delete next[itemId];
      else next[itemId] = value;
      return next;
    });
    setErrors((prev) => ({ ...prev, [itemId]: '' }));
  };

  async function submit() {
    const body = { answers, ...(corrects ? { correctsRecordId: corrects, correctionReason: reason } : {}) };
    const parsed = submitPmsSchema.safeParse(body);
    if (!parsed.success) {
      setErrors({ _reason: parsed.error.issues[0].message });
      return;
    }
    setSaving(true);
    try {
      const record = await api<PmsRecordRow>(`/assets/${id}/pms`, { body: parsed.data });
      message.success(corrects ? 'Correction recorded' : `PMS recorded for ${a.assetCode}`);
      router.push(`/pms/${record.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.details?.fieldErrors) {
        setErrors(Object.fromEntries(Object.entries(e.details.fieldErrors).map(([k, v]) => [k, v?.[0] ?? ''])));
        message.error('Some checklist items need attention');
      } else {
        message.error(e instanceof Error ? e.message : 'Could not save');
      }
    } finally {
      setSaving(false);
    }
  }

  function confirm() {
    // Ask for the correction reason before the confirmation, so the person is not told "submit?" then "invalid".
    if (corrects && reason.trim().length < 5) {
      setErrors({ _reason: 'Say why this correction is needed' });
      return;
    }
    modal.confirm({
      title: corrects ? 'Submit this correction?' : 'Submit this PMS?',
      content: corrects
        ? 'It is saved as a new record linked to the original. The original stays as it is, and neither can be edited afterwards.'
        : 'It is recorded with today’s date and your name, and cannot be edited afterwards. If something is wrong, you can add a correction.',
      okText: 'Submit',
      onOk: submit,
    });
  }

  return (
    <>
      <PageHeader
        title={corrects ? `Correct PMS · ${a.assetCode}` : `Perform PMS · ${a.assetCode}`}
        subtitle={`${a.name} · ${a.equipmentTypeName}`}
        crumbs={['Assets', a.assetCode, corrects ? 'Correction' : 'PMS']}
      />
      {template.error ? (
        <Alert type="warning" showIcon message="No checklist yet" description={template.error + '. Ask the Biomedical HOD to set one up under Admin > PMS checklists.'} />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 840 }}>
          <Alert type="info" showIcon icon={<LockOutlined />} message="The date and time are recorded by the system when you submit. They cannot be changed." />
          {corrects && (
            <Alert
              type="warning"
              showIcon
              message="You are correcting an earlier record"
              description={
                <div style={{ maxWidth: 520 }}>
                  <Typography.Paragraph style={{ marginBottom: 8 }}>The original stays unchanged. Say what was wrong:</Typography.Paragraph>
                  <Input.TextArea
                    aria-label="Reason for the correction"
                    rows={2}
                    maxLength={500}
                    showCount
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                      setErrors((prev) => ({ ...prev, _reason: '' }));
                    }}
                    status={errors._reason ? 'error' : undefined}
                  />
                  {errors._reason && <Typography.Text type="danger">{errors._reason}</Typography.Text>}
                </div>
              }
            />
          )}
          <Card title={`Checklist · version ${template.data?.version ?? ''}`}>
            {items.map((item) => {
              const value = answers[item.id];
              const bad = outOfRange(item, value);
              return (
                <div key={item.id} style={{ padding: '12px 0', borderBottom: `1px solid ${COLORS.lineSoft}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                    <div style={{ flex: '1 1 320px' }}>
                      {item.label}
                      {!item.required && <Typography.Text type="secondary"> (optional)</Typography.Text>}
                      {item.type === 'reading' && (
                        <div style={{ color: COLORS.muted, fontSize: 12 }}>
                          {rangeText(item) ? `Allowed: ${rangeText(item)}` : ''} {item.unit ?? ''}
                        </div>
                      )}
                    </div>
                    {item.type === 'check' && (
                      // Nothing is pre-selected: an unanswered item must look unanswered.
                      <Radio.Group
                        aria-label={item.label}
                        optionType="button"
                        buttonStyle="solid"
                        size="large"
                        value={typeof value === 'string' ? value : null}
                        options={[
                          { label: 'Pass', value: 'pass', className: 'pf-pass' },
                          { label: 'Fail', value: 'fail', className: 'pf-fail' },
                        ]}
                        onChange={(e) => set(item.id, e.target.value as PmsAnswer)}
                      />
                    )}
                    {item.type === 'reading' && (
                      <InputNumber
                        aria-label={item.label}
                        size="large"
                        style={{ width: 180 }}
                        suffix={item.unit}
                        status={bad || errors[item.id] ? 'error' : undefined}
                        value={typeof value === 'number' ? value : null}
                        onChange={(v) => set(item.id, v ?? undefined)}
                      />
                    )}
                  </div>
                  {item.type === 'text' && (
                    <Input.TextArea aria-label={item.label} rows={2} maxLength={1000} style={{ marginTop: 8 }} value={typeof value === 'string' ? value : ''} onChange={(e) => set(item.id, e.target.value)} />
                  )}
                  {bad && <Typography.Text type="danger">Outside the allowed range ({rangeText(item)} {item.unit}). This will be recorded as a fail.</Typography.Text>}
                  {errors[item.id] && (
                    <div>
                      <Typography.Text type="danger">{errors[item.id]}</Typography.Text>
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
          {willFail && <Alert type="warning" showIcon message="This PMS will be recorded as FAIL" description="At least one check failed or a reading is outside its allowed range." />}
          <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Link href={`/assets/${id}?tab=pms`}>
              <Button>Cancel</Button>
            </Link>
            <Tooltip title="Recorded with today's date, set by the system">
              <Button type="primary" loading={saving} onClick={confirm} disabled={items.length === 0}>
                {corrects ? 'Submit correction' : 'Submit PMS'}
              </Button>
            </Tooltip>
          </Space>
        </Space>
      )}
    </>
  );
}
