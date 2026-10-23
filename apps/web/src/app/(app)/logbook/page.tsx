'use client';

import { Alert, Button, Segmented, Space } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import { READING_EVERY_LABEL, type HospitalInfo, type ReadingTypeRow } from '@bme/shared';
import { RecordReadingModal, rangeText } from '@/components/AssetLogbookTab';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { RequirePermission } from '@/components/RequirePermission';
import { Pill } from '@/components/StatusTag';
import { useFetch } from '@/lib/api';
import { REGISTER_OPTIONS, useTwoTeams } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { COLORS } from '@/theme';

// The plant-room logbook on screen (facility add-on, F4): every reading the team takes, those owed now first. Readings
// are set up per machine (its Logbook tab); here they are taken on the round.
function LogbookScreen() {
  const twoTeams = useTwoTeams();
  const [register, setRegister] = useState('');
  const [show, setShow] = useState<'due' | 'all'>('due');
  const list = useFetch<ReadingTypeRow[]>(`/readings/logbook${register ? `?register=${register}` : ''}`, { fresh: true });
  const [recording, setRecording] = useState<ReadingTypeRow | null>(null);
  const rows = (list.data ?? []).filter((t) => show === 'all' || t.dueNow);
  return (
    <>
      <PageHeader title="Logbook" subtitle="Readings on the round: run hours, diesel, temperatures, meters. The time is the system's." crumbs={['Equipment', 'Logbook']} />
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented aria-label="Show" value={show} onChange={(v) => setShow(v as 'due' | 'all')} options={[{ value: 'due', label: `Due now${list.data ? ` (${list.data.filter((t) => t.dueNow).length})` : ''}` }, { value: 'all', label: 'All readings' }]} />
        {twoTeams && <Segmented aria-label="Team" value={register} onChange={(v) => setRegister(String(v))} options={[{ value: '', label: 'All' }, ...REGISTER_OPTIONS]} />}
      </Space>
      <DataTable<ReadingTypeRow>
        rows={list.data ? rows : null}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        emptyText={show === 'due' ? 'Every reading is taken for now.' : 'No readings set up yet. Add them on a machine’s Logbook tab.'}
        columns={[
          {
            title: 'Item',
            key: 'item',
            className: 'm-title',
            render: (_: unknown, t) => (
              <div style={{ lineHeight: 1.35 }}>
                <div style={{ color: COLORS.ink, fontWeight: 600 }}>{t.name}</div>
                <div style={{ color: COLORS.muted, fontSize: 12.5 }}>
                  <Link href={`/assets/${t.assetId}?tab=logbook`} className="code">{t.assetCode}</Link> · {t.assetName} · {t.locationName}
                </div>
              </div>
            ),
          },
          { title: 'How often', dataIndex: 'every', className: 'm-hide', render: (e: ReadingTypeRow['every']) => READING_EVERY_LABEL[e] },
          { title: 'Normal', key: 'normal', className: 'm-hide', render: (_: unknown, t) => rangeText(t) || '—' },
          {
            title: 'Last',
            key: 'last',
            render: (_: unknown, t) =>
              t.last ? (
                <Space direction="vertical" size={2}>
                  <span className="num" style={{ fontWeight: 600, color: t.last.outOfRange ? COLORS.bad.fg : COLORS.ink }}>{t.last.value} {t.unit}</span>
                  <span style={{ color: COLORS.muted, fontSize: 12.5 }}>{formatDateTime(t.last.takenAt)}</span>
                </Space>
              ) : (
                <span style={{ color: COLORS.muted }}>None yet</span>
              ),
          },
          {
            title: <span className="sr-only">Actions</span>,
            key: 'actions',
            align: 'right',
            render: (_: unknown, t) => (
              <Space size={6} wrap style={{ justifyContent: 'flex-end' }}>
                {t.dueNow && <Pill tone="warn">Due</Pill>}
                {t.last?.outOfRange && <Pill tone="bad">Out of range</Pill>}
                <Button size="small" type="primary" onClick={() => setRecording(t)} aria-label={`Record ${t.name} on ${t.assetCode}`}>Record</Button>
              </Space>
            ),
          },
        ]}
      />
      <RecordReadingModal type={recording} onClose={() => setRecording(null)} onDone={list.reload} />
    </>
  );
}

export default function LogbookPage() {
  const hospital = useFetch<HospitalInfo>('/hospital');
  if (hospital.data && !hospital.data.facilityEnabled) return <Alert type="info" showIcon message="The logbook is part of the facility maintenance add-on, which is off." />;
  return (
    <RequirePermission code="reading.record" what="take logbook readings">
      <LogbookScreen />
    </RequirePermission>
  );
}
