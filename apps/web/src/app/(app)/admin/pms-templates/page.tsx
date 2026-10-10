'use client';

import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Collapse, Input, InputNumber, Select, Space, Switch, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { PMS_ITEM_TYPES, pmsTemplateBodySchema, type PmsItem, type PmsItemType, type PmsTemplateRow } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { api, ApiError, useFetch } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { RequirePermission } from '@/components/RequirePermission';
import { TableSkeleton } from '@/components/Skeletons';

type EquipmentType = { id: string; name: string };

const TYPE_LABEL: Record<PmsItemType, string> = { check: 'Pass / Fail', reading: 'Reading (number)', text: 'Remarks (text)' };
const newId = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const blankItem = (): PmsItem => ({ id: newId(), label: '', type: 'check', required: true });

const rangeText = (i: PmsItem) => (i.type === 'reading' && (i.min != null || i.max != null) ? `${i.min ?? '…'} – ${i.max ?? '…'} ${i.unit ?? ''}` : '');

const ItemsTable = ({ items }: { items: PmsItem[] }) => (
  <Table<PmsItem>
    size="small"
    rowKey="id"
    pagination={false}
    dataSource={items}
    columns={[
      { title: '#', width: 48, render: (_: unknown, __: PmsItem, i: number) => i + 1 },
      { title: 'Check', dataIndex: 'label' },
      { title: 'Type', dataIndex: 'type', render: (t: PmsItemType) => TYPE_LABEL[t] },
      { title: 'Allowed', key: 'range', render: (_: unknown, i) => rangeText(i) },
      { title: 'Required', dataIndex: 'required', render: (r: boolean) => (r ? 'Yes' : 'No') },
    ]}
  />
);

function PmsTemplatesPageScreen() {
  const { message } = App.useApp();
  const types = useFetch<EquipmentType[]>('/equipment-types');
  const [typeId, setTypeId] = useState<string>();
  const versions = useFetch<PmsTemplateRow[]>(typeId ? `/pms-templates?equipmentTypeId=${typeId}` : null);
  const [draft, setDraft] = useState<PmsItem[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!typeId && types.data?.length) setTypeId(types.data[0].id);
  }, [types.data, typeId]);
  useEffect(() => setDraft(null), [typeId]);

  const latest = versions.data?.[0];
  const patch = (index: number, change: Partial<PmsItem>) => setDraft((d) => d!.map((it, i) => (i === index ? { ...it, ...change } : it)));
  const move = (index: number, by: -1 | 1) =>
    setDraft((d) => {
      const next = [...d!];
      const to = index + by;
      if (to < 0 || to >= next.length) return d;
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });

  async function save() {
    if (!typeId || !draft) return;
    const parsed = pmsTemplateBodySchema.safeParse({ equipmentTypeId: typeId, items: draft });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const at = typeof issue.path[1] === 'number' ? `Item ${issue.path[1] + 1}: ` : '';
      setProblem(`${at}${issue.message}`);
      return;
    }
    setProblem(null);
    setSaving(true);
    try {
      const created = await api<PmsTemplateRow>('/pms-templates', { body: parsed.data });
      message.success(`Checklist saved as version ${created.version}`);
      setDraft(null);
      versions.reload();
    } catch (e) {
      message.error(e instanceof ApiError || e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="PMS checklists"
        subtitle="What the engineer checks at each preventive maintenance, per equipment type"
        crumbs={['Admin', 'PMS checklists']}
        action={
          !draft && (
            <Button type="primary" disabled={!typeId} onClick={() => setDraft(latest ? latest.items.map((i) => ({ ...i })) : [blankItem()])}>
              {latest ? 'Edit checklist' : 'Create checklist'}
            </Button>
          )
        }
      />
      <Space wrap style={{ marginBottom: 16 }}>
        <Typography.Text>Equipment type</Typography.Text>
        <Select
          aria-label="Equipment type"
          style={{ width: 280 }}
          value={typeId}
          loading={types.loading}
          onChange={setTypeId}
          options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
        />
      </Space>

      {versions.loading && !versions.data && <TableSkeleton rows={8} cols={3} />}
      {versions.error && <Alert type="error" showIcon message="Could not load the checklist" description={versions.error} />}

      {!draft && versions.data && (
        <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 960 }}>
          {latest ? (
            <Card title={`Current checklist · version ${latest.version}`} extra={<Typography.Text type="secondary">Saved {formatDate(latest.createdAt)}</Typography.Text>}>
              <ItemsTable items={latest.items} />
            </Card>
          ) : (
            <Alert type="info" showIcon message="No checklist for this equipment type yet" description="Until one exists, PMS cannot be recorded for it." />
          )}
          {versions.data.length > 1 && (
            <Collapse
              items={versions.data.slice(1).map((v) => ({
                key: v.id,
                label: `Version ${v.version} · saved ${formatDate(v.createdAt)}`,
                children: <ItemsTable items={v.items} />,
              }))}
            />
          )}
        </Space>
      )}

      {draft && (
        <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 960 }}>
          <Alert
            type="info"
            showIcon
            message={`Saving creates version ${(latest?.version ?? 0) + 1}`}
            description="PMS records already done keep the version they were done with. Only new PMS uses the new checklist."
          />
          {draft.map((item, index) => (
            <Card key={item.id} size="small">
              <Space direction="vertical" style={{ width: '100%' }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Typography.Text strong style={{ width: 24 }}>{index + 1}</Typography.Text>
                  <Input
                    aria-label={`Item ${index + 1} text`}
                    placeholder="What to check, e.g. Alarms work"
                    style={{ flex: '1 1 320px' }}
                    maxLength={200}
                    value={item.label}
                    onChange={(e) => patch(index, { label: e.target.value })}
                  />
                  <Select
                    aria-label={`Item ${index + 1} type`}
                    style={{ width: 180 }}
                    value={item.type}
                    options={PMS_ITEM_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
                    onChange={(type) => patch(index, { type, ...(type !== 'reading' ? { unit: null, min: null, max: null } : {}) })}
                  />
                  <Space>
                    <Switch aria-label={`Item ${index + 1} required`} checked={item.required} onChange={(required) => patch(index, { required })} />
                    <span>Required</span>
                  </Space>
                  <Space size={0}>
                    <Button aria-label="Move up" type="text" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => move(index, -1)} />
                    <Button aria-label="Move down" type="text" icon={<ArrowDownOutlined />} disabled={index === draft.length - 1} onClick={() => move(index, 1)} />
                    <Button aria-label="Remove item" type="text" danger icon={<DeleteOutlined />} onClick={() => setDraft((d) => d!.filter((_, i) => i !== index))} />
                  </Space>
                </div>
                {item.type === 'reading' && (
                  <Space wrap>
                    <Input aria-label="Unit" placeholder="Unit (ml, %, s)" style={{ width: 140 }} maxLength={20} value={item.unit ?? ''} onChange={(e) => patch(index, { unit: e.target.value })} />
                    <InputNumber aria-label="Minimum" placeholder="Minimum" value={item.min ?? null} onChange={(v) => patch(index, { min: v })} />
                    <InputNumber aria-label="Maximum" placeholder="Maximum" value={item.max ?? null} onChange={(v) => patch(index, { max: v })} />
                    <Typography.Text type="secondary">A reading outside this range is recorded as a fail.</Typography.Text>
                  </Space>
                )}
              </Space>
            </Card>
          ))}
          <Button icon={<PlusOutlined />} onClick={() => setDraft((d) => [...d!, blankItem()])}>
            Add item
          </Button>
          {problem && <Alert type="error" showIcon message={problem} />}
          <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Button onClick={() => { setDraft(null); setProblem(null); }}>Cancel</Button>
            <Button type="primary" loading={saving} onClick={save}>
              Save as version {(latest?.version ?? 0) + 1}
            </Button>
          </Space>
        </Space>
      )}
    </>
  );
}


export default function PmsTemplatesPage() {
  return (
    <RequirePermission code="setup.manage" what="change PMS checklists">
      <PmsTemplatesPageScreen />
    </RequirePermission>
  );
}
