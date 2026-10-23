'use client';

import { Alert, App, Button, DatePicker, Form, Input, Modal, Popconfirm, Segmented, Select, Space } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import Link from 'next/link';
import { useState } from 'react';
import { LICENCE_KIND_LABEL, LICENCE_KINDS, licenceSchema, renewLicenceSchema, TEAM_LABEL, type AssetRow, type HospitalInfo, type LicenceRow, type LicenceStatus, type Paged } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { DocumentsButton } from '@/components/DocumentList';
import { FilePicker } from '@/components/FilePicker';
import { PageHeader } from '@/components/PageHeader';
import { RequirePermission } from '@/components/RequirePermission';
import { Pill } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { REGISTER_OPTIONS, useAuth, useTwoTeams } from '@/lib/auth';
import { parseForm, showApiFieldErrors, useSingleFlight } from '@/lib/forms';
import { formatDate } from '@/lib/format';
import { uploadAll } from '@/lib/uploads';
import { COLORS } from '@/theme';

const STATUS: Record<LicenceStatus, { tone: 'good' | 'warn' | 'bad' | 'neutral'; label: string }> = {
  valid: { tone: 'good', label: 'Valid' },
  ending: { tone: 'warn', label: 'Ending soon' },
  expired: { tone: 'bad', label: 'Expired' },
  renewed: { tone: 'neutral', label: 'Renewed' },
};
const VIEWS = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'current', label: 'All current' },
  { value: 'renewed', label: 'Renewal history' },
];
const iso = (d?: Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null);

// Statutory licences and inspections (facility add-on, F3): what the law requires, who issued it, until when. Reminders
// come at the hospital's lead days; renewing records the new one and keeps the old one as history.
function LicencesScreen() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const twoTeams = useTwoTeams();
  const [view, setView] = useState('attention');
  const [register, setRegister] = useState<string>('');
  const licences = useFetch<LicenceRow[]>(`/licences?status=${view}${register ? `&register=${register}` : ''}`);
  const [form] = Form.useForm();
  const [renewForm] = Form.useForm();
  const [editing, setEditing] = useState<LicenceRow | 'new' | null>(null);
  const [renewing, setRenewing] = useState<LicenceRow | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [machines, setMachines] = useState<{ value: string; label: string }[]>([]);
  const covers = Form.useWatch('covers', form);
  const single = useSingleFlight();

  async function findMachines(text: string) {
    const res = await api<Paged<AssetRow>>(`/assets?pageSize=20&search=${encodeURIComponent(text)}`).catch(() => null);
    setMachines((res?.items ?? []).map((a) => ({ value: a.id, label: `${a.assetCode} · ${a.name}` })));
  }

  function open(row: LicenceRow | 'new') {
    form.resetFields();
    setFiles([]);
    if (row === 'new') form.setFieldsValue({ kind: 'lift', covers: 'item', register: 'facility' });
    else {
      form.setFieldsValue({ ...row, covers: row.assetId ? 'item' : 'site', validFrom: row.validFrom ? dayjs(row.validFrom) : null, validTo: dayjs(row.validTo) });
      if (row.assetId) setMachines([{ value: row.assetId, label: `${row.assetCode} · ${row.assetName}` }]);
    }
    if (row === 'new' || !row.assetId) void findMachines('');
    setEditing(row);
  }

  async function save() {
    const v = form.getFieldsValue();
    const input = parseForm(form, licenceSchema, {
      kind: v.kind, name: v.name, authority: v.authority, number: v.number ?? null, notes: v.notes ?? null,
      validFrom: iso(v.validFrom), validTo: iso(v.validTo) ?? '',
      assetId: v.covers === 'item' ? (v.assetId ?? '') : null, register: v.covers === 'site' ? v.register : undefined,
    });
    if (!input) return;
    setSaving(true);
    try {
      const row = editing === 'new' ? await api<LicenceRow>('/licences', { body: input }) : await api<LicenceRow>(`/licences/${(editing as LicenceRow).id}`, { method: 'PATCH', body: input });
      const failed = files.length ? await uploadAll(files, { ownerType: 'licence', ownerId: row.id }, () => 'certificate') : [];
      if (failed.length) message.warning(`Saved, but ${failed.join(', ')} could not be uploaded. Add ${failed.length === 1 ? 'it' : 'them'} from Documents.`, 8);
      else message.success(editing === 'new' ? `${row.name} added` : 'Licence updated');
      setEditing(null);
      licences.reload();
    } catch (e) {
      if (!showApiFieldErrors(form, e)) message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function renew() {
    const v = renewForm.getFieldsValue();
    const input = parseForm(renewForm, renewLicenceSchema, { number: v.number ?? null, notes: v.notes ?? null, validFrom: iso(v.validFrom), validTo: iso(v.validTo) ?? '' });
    if (!input || !renewing) return;
    setSaving(true);
    try {
      const row = await api<LicenceRow>(`/licences/${renewing.id}/renew`, { body: input });
      const failed = files.length ? await uploadAll(files, { ownerType: 'licence', ownerId: row.id }, () => 'certificate') : [];
      if (failed.length) message.warning(`Renewed, but ${failed.join(', ')} could not be uploaded. Add ${failed.length === 1 ? 'it' : 'them'} from Documents.`, 8);
      else message.success(`${row.name} renewed until ${formatDate(row.validTo)}`);
      setRenewing(null);
      licences.reload();
    } catch (e) {
      if (!showApiFieldErrors(renewForm, e)) message.error(e instanceof Error ? e.message : 'Could not renew');
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: LicenceRow) {
    try {
      await api(`/licences/${row.id}`, { method: 'DELETE' });
      message.success(`${row.name} removed`);
      licences.reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not remove');
    }
  }

  return (
    <>
      <PageHeader
        title="Licences"
        subtitle="Statutory licences and inspections: lift, fire NOC, DG pollution, electrical, PESO, pressure vessels, water tests"
        crumbs={['Equipment', 'Licences']}
        action={
          <Space wrap>
            <Link href="/reports/compliance"><Button>Compliance register</Button></Link>
            <Button type="primary" onClick={() => open('new')}>Add licence</Button>
          </Space>
        }
      />
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented aria-label="Show" value={view} onChange={(v) => setView(String(v))} options={VIEWS} />
        {twoTeams && <Segmented aria-label="Team" value={register} onChange={(v) => setRegister(String(v))} options={[{ value: '', label: 'All' }, ...REGISTER_OPTIONS]} />}
      </Space>
      <DataTable<LicenceRow>
        rows={licences.data}
        loading={licences.loading}
        error={licences.error}
        onRetry={licences.reload}
        emptyText={view === 'attention' ? 'Nothing ending or expired. All licences are in date.' : 'No licences here yet.'}
        columns={[
          {
            title: 'Licence',
            dataIndex: 'name',
            className: 'm-title',
            render: (v: string, l) => (
              <div style={{ lineHeight: 1.35 }}>
                <div style={{ color: COLORS.ink, fontWeight: 600 }}>{v}</div>
                <div style={{ color: COLORS.muted, fontSize: 12.5 }}>{LICENCE_KIND_LABEL[l.kind]}{l.number && ` · ${l.number}`}</div>
              </div>
            ),
          },
          {
            title: 'Covers',
            key: 'covers',
            render: (_: unknown, l) => (l.assetId ? <Link href={`/assets/${l.assetId}`} className="code">{l.assetCode}</Link> : 'Whole site'),
          },
          { title: 'Authority', dataIndex: 'authority', className: 'm-hide' },
          ...(twoTeams ? [{ title: 'Team', dataIndex: 'register', className: 'm-hide', render: (r: LicenceRow['register']) => TEAM_LABEL[r] }] : []),
          {
            title: 'Valid to',
            dataIndex: 'validTo',
            render: (v: string, l) => (
              <Space direction="vertical" size={2}>
                <span className="num">{formatDate(v)}</span>
                <Pill tone={STATUS[l.status].tone}>
                  {l.status === 'expired' ? `Expired ${-l.daysLeft} d ago` : l.status === 'ending' ? `${l.daysLeft} d left` : STATUS[l.status].label}
                </Pill>
              </Space>
            ),
          },
          {
            title: <span className="sr-only">Actions</span>,
            key: 'actions',
            align: 'right',
            render: (_: unknown, l) => (
              <Space wrap size={4} style={{ justifyContent: 'flex-end' }}>
                <DocumentsButton ownerType="licence" ownerId={l.id} title={l.name} kinds={['certificate', 'other']} canUpload count={l.attachmentCount} onChanged={licences.reload} />
                {l.status !== 'renewed' && (
                  <>
                    <Button size="small" onClick={() => { renewForm.resetFields(); setFiles([]); renewForm.setFieldsValue({ number: l.number, validFrom: dayjs(l.validTo).add(1, 'day') }); setRenewing(l); }}>
                      Renew
                    </Button>
                    <Button size="small" type="text" onClick={() => open(l)}>Edit</Button>
                  </>
                )}
                {can('approval.decide') && l.status !== 'renewed' && !l.renewsId && !l.attachmentCount && (
                  <Popconfirm title={`Remove ${l.name}?`} description="Only for a licence entered by mistake." okText="Remove" okButtonProps={{ danger: true }} onConfirm={() => remove(l)}>
                    <Button size="small" type="text" danger>Remove</Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal open={editing !== null} title={editing === 'new' ? 'Add licence' : 'Correct licence'} okText="Save" confirmLoading={saving} onOk={() => single(save)} onCancel={() => setEditing(null)} destroyOnHidden>
        <Form form={form} layout="vertical" requiredMark>
          <Form.Item label="Kind" name="kind" rules={[{ required: true }]}>
            <Select options={LICENCE_KINDS.map((k) => ({ value: k, label: LICENCE_KIND_LABEL[k] }))} />
          </Form.Item>
          <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Name it' }]} extra='e.g. "Lift licence, Bed Lift 1" or "Fire NOC, main building".'>
            <Input maxLength={150} />
          </Form.Item>
          <Form.Item label="Issued by" name="authority" rules={[{ required: true, message: 'Who issued it' }]}>
            <Input maxLength={150} placeholder="e.g. Chief Fire Officer" />
          </Form.Item>
          <Form.Item label="Licence or certificate number" name="number">
            <Input maxLength={100} />
          </Form.Item>
          <Space.Compact block>
            <Form.Item label="Valid from" name="validFrom" style={{ flex: 1 }}>
              <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="Valid to" name="validTo" rules={[{ required: true, message: 'Until when' }]} style={{ flex: 1 }}>
              <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} />
            </Form.Item>
          </Space.Compact>
          <Form.Item label="Covers" name="covers">
            <Segmented options={[{ value: 'item', label: 'One item' }, { value: 'site', label: 'The whole site' }]} />
          </Form.Item>
          {covers === 'site' ? (
            twoTeams && (
              <Form.Item label="Kept by" name="register">
                <Select options={REGISTER_OPTIONS.map((o) => ({ ...o, label: TEAM_LABEL[o.value] }))} />
              </Form.Item>
            )
          ) : (
            <Form.Item label="Equipment" name="assetId" rules={[{ required: true, message: 'Choose the equipment' }]}>
              <Select showSearch filterOption={false} placeholder="Search by ID or name" onSearch={(t) => void findMachines(t)} options={machines} />
            </Form.Item>
          )}
          <Form.Item label="Notes" name="notes">
            <Input.TextArea rows={2} maxLength={1000} />
          </Form.Item>
          <Form.Item label="The licence (scan or PDF)" extra="Optional; can also be added later from Documents.">
            <FilePicker files={files} onChange={setFiles} label="Add the licence" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal open={!!renewing} title={`Renew ${renewing?.name ?? ''}`} okText="Save renewal" confirmLoading={saving} onOk={() => single(renew)} onCancel={() => setRenewing(null)} destroyOnHidden>
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message="The current licence stays as history, marked renewed; its reminders stop." />
        <Form form={renewForm} layout="vertical" requiredMark>
          <Form.Item label="New number" name="number">
            <Input maxLength={100} />
          </Form.Item>
          <Space.Compact block>
            <Form.Item label="Valid from" name="validFrom" style={{ flex: 1 }}>
              <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="Valid to" name="validTo" rules={[{ required: true, message: 'Until when' }]} style={{ flex: 1 }}>
              <DatePicker format="DD MMM YYYY" style={{ width: '100%' }} />
            </Form.Item>
          </Space.Compact>
          <Form.Item label="Notes" name="notes">
            <Input.TextArea rows={2} maxLength={1000} />
          </Form.Item>
          <Form.Item label="The new licence (scan or PDF)">
            <FilePicker files={files} onChange={setFiles} label="Add the licence" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export default function LicencesPage() {
  const hospital = useFetch<HospitalInfo>('/hospital');
  if (hospital.data && !hospital.data.facilityEnabled) return <Alert type="info" showIcon message="Licences are part of the facility maintenance add-on, which is off." />;
  return (
    <RequirePermission code="licence.manage" what="keep licences">
      <LicencesScreen />
    </RequirePermission>
  );
}
