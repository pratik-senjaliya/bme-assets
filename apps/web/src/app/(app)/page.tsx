'use client';

import { Alert, Button, Card, Col, Row, Skeleton, Typography } from 'antd';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { DashboardResponse } from '@bme/shared';
import { BarChart } from '@/components/BarChart';
import { ComplaintsMiniList } from '@/components/ComplaintsMiniList';
import { PageHeader } from '@/components/PageHeader';
import { DueTag } from '@/components/StatusTag';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';

// A KPI tile: label, one number, the whole tile is a link to the list behind it.
function Stat({ label, value, href, tone }: { label: string; value: number | null; href: string; tone?: 'problem' }) {
  if (value === null) return null;
  return (
    <Col xs={12} lg={6}>
      <Link href={href} aria-label={`${label}: ${value}`} style={{ display: 'block' }}>
        <Card hoverable size="small" styles={{ body: { padding: 16 } }}>
          <div style={{ color: '#6B7280', fontSize: 13 }}>{label}</div>
          <div style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.3, color: tone === 'problem' && value > 0 ? '#DC2626' : '#111827' }}>{value.toLocaleString('en-IN')}</div>
        </Card>
      </Link>
    </Col>
  );
}

const Section = ({ title, link, children }: { title: string; link?: ReactNode; children: ReactNode }) => (
  <Card size="small" title={title} extra={link} style={{ height: '100%' }}>
    {children}
  </Card>
);

export default function Home() {
  const { user, can } = useAuth();
  const dash = useFetch<DashboardResponse>('/dashboard');
  const d = dash.data;

  return (
    <>
      <PageHeader
        title={`Welcome, ${user?.name}`}
        subtitle={d?.scope === 'department' ? `${user?.roleLabel} · ${d.departmentName}` : user?.roleLabel}
        action={can('complaint.create') && <Link href="/complaints"><Button type="primary">Raise complaint</Button></Link>}
      />
      {dash.error && <Alert type="error" showIcon message="Could not load the dashboard" description={dash.error} action={<Button onClick={dash.reload}>Retry</Button>} />}
      {dash.loading && !d && <Skeleton active />}
      {d && (
        <>
          {d.pendingApprovals !== null && d.pendingApprovals > 0 && (
            <Alert
              style={{ marginBottom: 16 }}
              type="info"
              showIcon
              message={`${d.pendingApprovals} ${d.pendingApprovals === 1 ? 'request is' : 'requests are'} waiting for your decision`}
              action={<Link href="/approvals"><Button size="small">Review</Button></Link>}
            />
          )}
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Stat label={d.scope === 'department' ? 'Equipment in your department' : 'Active assets'} value={d.activeAssets} href="/assets" />
            <Stat label="Open complaints" value={d.openComplaints} href="/complaints" />
            <Stat label="Due this month" value={d.dueThisMonth} href="/due?range=month" />
            <Stat label="Overdue" value={d.overdue} href="/due?range=overdue" tone="problem" />
          </Row>

          <Row gutter={[16, 16]}>
            {d.dueSoon && (
              <Col xs={24} xl={12}>
                <Section title="Due soon" link={<Link href="/due">All due items</Link>}>
                  {d.dueSoon.length === 0 ? (
                    <Typography.Text type="secondary">Nothing is due or overdue this month.</Typography.Text>
                  ) : (
                    d.dueSoon.map((i) => (
                      <div key={`${i.kind}-${i.assetId}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid #F3F4F6' }}>
                        <div>
                          <Link href={`/assets/${i.assetId}?tab=${i.kind}`} style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                            {i.assetCode}
                          </Link>
                          <div style={{ color: '#6B7280', fontSize: 12 }}>
                            {i.kind === 'pms' ? 'PMS' : 'Calibration'} · {i.assetName} · {formatDate(i.dueDate)}
                          </div>
                        </div>
                        <DueTag daysLeft={i.daysLeft} />
                      </div>
                    ))
                  )}
                </Section>
              </Col>
            )}
            <Col xs={24} xl={d.dueSoon ? 12 : 24}>
              <Section title="Open complaints" link={<Link href="/complaints">All complaints</Link>}>
                <ComplaintsMiniList rows={d.openList} />
              </Section>
            </Col>
            {can('complaint.view') && (
              <Col xs={24}>
                <Card size="small">
                  <BarChart
                    title={d.scope === 'department' ? 'Breakdowns per month, your department' : 'Breakdowns per month'}
                    unit="Breakdowns"
                    data={d.months.map((m) => ({ label: m.label, value: m.breakdowns, extra: { downtime: `${m.downtimeHours} h` } }))}
                    tableColumns={[{ key: 'downtime', title: 'Downtime (resolved)' }]}
                  />
                </Card>
              </Col>
            )}
          </Row>
        </>
      )}
    </>
  );
}
