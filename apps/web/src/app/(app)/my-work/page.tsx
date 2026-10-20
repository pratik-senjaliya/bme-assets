'use client';

import { CheckCircleOutlined } from '@ant-design/icons';
import { Card, Col, Row, Typography } from 'antd';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { Assignee, ComplaintRow, DueRow, Paged } from '@bme/shared';
import { CardSkeleton, ComplaintCard, useComplaintWork } from '@/components/ComplaintWork';
import { PageHeader } from '@/components/PageHeader';
import { RequirePermission } from '@/components/RequirePermission';
import { EmptyState } from '@/components/Skeletons';
import { DueText } from '@/components/StatusTag';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addDaysISO, formatDate, todayIST } from '@/lib/format';
import { COLORS } from '@/theme';

const ComplaintDrawer = dynamic(() => import('@/components/ComplaintDrawer').then((m) => m.ComplaintDrawer));

// A heading with a count, then its list.
function Section({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <Typography.Title level={2} style={{ margin: 0, fontSize: 17 }}>
          {title}
        </Typography.Title>
        {count !== undefined && (
          <span className="num" style={{ color: COLORS.muted, fontWeight: 600, fontSize: 13, border: `1px solid ${COLORS.line}`, borderRadius: 4, padding: '0 7px' }}>
            {count}
          </span>
        )}
        {hint && <span style={{ color: COLORS.muted, fontSize: 13 }}>{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: 12, alignItems: 'start' } as const;

// One engineer's day: the complaints assigned to them, the ones nobody has taken yet, and the PMS and calibration
// due this week or overdue. The HOD also sees how much each engineer has.
function MyWork() {
  const { can } = useAuth();
  const [version, setVersion] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const changed = () => setVersion((v) => v + 1);
  const { actions, dialogs } = useComplaintWork(changed);
  const until = addDaysISO(todayIST(), 7);

  const escalated = useFetch<Paged<ComplaintRow>>(can('complaint.hold') ? `/complaints?escalated=true&pageSize=100&k=${version}` : null, { fresh: true });
  const mine = useFetch<Paged<ComplaintRow>>(`/complaints?assignedTo=me&status=unresolved&pageSize=100&k=${version}`, { fresh: true });
  const free = useFetch<Paged<ComplaintRow>>(`/complaints?assignedTo=none&status=unresolved&pageSize=100&k=${version}`, { fresh: true });
  const pms = useFetch<DueRow[]>(can('pms.perform') ? `/pms/due?until=${until}` : null);
  const calibration = useFetch<DueRow[]>(can('calibration.manage') ? `/calibration/due?until=${until}` : null);
  const team = useFetch<Assignee[]>(can('complaint.assign') ? `/complaints/assignees?k=${version}` : null, { fresh: true });

  const cards = (list: typeof mine, empty: string) =>
    list.loading && !list.data ? (
      <div style={grid}>
        <CardSkeleton />
        <CardSkeleton />
      </div>
    ) : list.data?.items.length ? (
      <div style={grid}>
        {list.data.items.map((c) => (
          <ComplaintCard key={c.id} c={c} actions={actions(c)} onOpen={() => setOpenId(c.id)} />
        ))}
      </div>
    ) : (
      <Card>
        <EmptyState compact icon={<CheckCircleOutlined />} title={empty} />
      </Card>
    );

  const due = [...(pms.data ?? []).map((d) => ({ ...d, kind: 'pms' as const })), ...(calibration.data ?? []).map((d) => ({ ...d, kind: 'calibration' as const }))].sort((a, b) => a.daysLeft - b.daysLeft);
  const dueLoading = (pms.loading && !pms.data) || (calibration.loading && !calibration.data);

  return (
    <>
      <PageHeader title="My work" subtitle={`${formatDate(todayIST())} · your complaints first, then what is waiting and what is due`} />
      {can('complaint.hold') && (escalated.data?.total ?? 0) > 0 && (
        <Section title="Escalated to you" count={escalated.data?.total} hint="Put on hold for the OEM, or send back to work">
          {cards(escalated, '')}
        </Section>
      )}
      <Section title="Assigned to me" count={mine.data?.total} hint="Longest waiting first">
        {cards(mine, 'Nothing assigned to you right now.')}
      </Section>
      <Section title="Waiting for someone" count={free.data?.total} hint={can('complaint.assign') ? 'Assign them, or start one yourself' : 'Take one, or start work on it'}>
        {cards(free, 'Every complaint has someone on it.')}
      </Section>
      {(can('pms.perform') || can('calibration.manage')) && (
        <Section title="PMS and calibration" count={dueLoading ? undefined : due.length} hint="Overdue, and due in the next 7 days">
          <Card styles={{ body: { padding: '4px 20px' } }}>
            {dueLoading && <div style={{ padding: 16 }}><CardSkeleton /></div>}
            {!dueLoading && due.length === 0 && <EmptyState compact icon={<CheckCircleOutlined />} title="Nothing due this week." />}
            {due.map((d) => (
              <div key={`${d.kind}-${d.assetId}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `1px solid ${COLORS.lineSoft}` }}>
                <div style={{ minWidth: 0 }}>
                  <Link href={d.kind === 'pms' ? `/assets/${d.assetId}/pms/new` : `/assets/${d.assetId}?tab=calibration`} style={{ fontWeight: 600 }}>
                    {d.kind === 'pms' ? 'PMS' : 'Calibration'} · {d.assetName}
                  </Link>
                  <div style={{ color: COLORS.muted, fontSize: 12.5, marginTop: 2 }}>
                    <span className="code">{d.assetCode}</span> · {d.departmentName}, {d.locationName} · {formatDate(d.dueDate)}
                  </div>
                </div>
                <DueText daysLeft={d.daysLeft} />
              </div>
            ))}
          </Card>
        </Section>
      )}
      {team.data && (
        <Section title="Team" hint="Unresolved complaints each person has">
          <Row gutter={[12, 12]}>
            {team.data.map((a) => (
              <Col key={a.id} xs={12} md={8} xl={6}>
                <Card size="small" styles={{ body: { padding: '12px 14px' } }}>
                  <div style={{ fontWeight: 600, color: COLORS.ink }}>{a.name}</div>
                  <div className="num" style={{ fontSize: 22, fontWeight: 700, color: a.openCount ? COLORS.ink : COLORS.muted }}>
                    {a.openCount}
                  </div>
                </Card>
              </Col>
            ))}
          </Row>
        </Section>
      )}
      {dialogs}
      <ComplaintDrawer id={openId} onClose={() => setOpenId(null)} onChanged={changed} />
    </>
  );
}

export default function MyWorkPage() {
  return (
    <RequirePermission code="complaint.start" what="see a work list">
      <MyWork />
    </RequirePermission>
  );
}
