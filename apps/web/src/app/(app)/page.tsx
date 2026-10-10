'use client';

import { ArrowRightOutlined, BarcodeOutlined, CalendarOutlined, CheckCircleOutlined, ExclamationCircleOutlined, SafetyCertificateOutlined, ToolOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Grid, Row } from 'antd';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { DashboardResponse } from '@bme/shared';
import { ChartGrid } from '@/components/charts/LazyCharts';
import { ComplaintsMiniList } from '@/components/ComplaintsMiniList';
import { KpiGrid } from '@/components/KpiTile';
import { PageHeader } from '@/components/PageHeader';
import { DashboardSkeleton, EmptyState } from '@/components/Skeletons';
import { DueText, Pill } from '@/components/StatusTag';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { firstName, formatDate } from '@/lib/format';
import { COLORS } from '@/theme';

type Tone = 'primary' | 'good' | 'warn' | 'bad';
const TONE = {
  primary: { fg: COLORS.primary, bg: COLORS.primarySoft },
  good: { fg: COLORS.good.fg, bg: COLORS.good.bg },
  warn: { fg: COLORS.warn.fg, bg: COLORS.warn.bg },
  bad: { fg: COLORS.bad.fg, bg: COLORS.bad.bg },
};

// A KPI tile: icon, label, one number, a hint. The whole tile is a link to the list behind it.
function Stat({ label, value, href, icon, tone, hint }: { label: string; value: number | null; href: string; icon: ReactNode; tone: Tone; hint: string }) {
  if (value === null) return null;
  const t = TONE[tone];
  return (
    <Col xs={12} lg={6}>
      <Link href={href} style={{ display: 'block' }}>
        <Card hoverable styles={{ body: { padding: 20 } }} style={{ height: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ color: COLORS.muted, fontWeight: 600 }}>{label}</div>
            <span aria-hidden style={{ width: 40, height: 40, borderRadius: 12, background: t.bg, color: t.fg, display: 'grid', placeItems: 'center', fontSize: 18, flex: 'none' }}>
              {icon}
            </span>
          </div>
          <div className="num" style={{ fontSize: 36, fontWeight: 800, lineHeight: 1.1, margin: '6px 0 8px', color: COLORS.ink, letterSpacing: '-0.03em' }}>{value.toLocaleString('en-IN')}</div>
          <div style={{ color: value > 0 && tone !== 'primary' ? t.fg : COLORS.muted, fontSize: 13, fontWeight: value > 0 && tone !== 'primary' ? 700 : 500 }}>{hint}</div>
        </Card>
      </Link>
    </Col>
  );
}

const Section = ({ title, link, children }: { title: string; link?: ReactNode; children: ReactNode }) => (
  <Card title={title} extra={link} style={{ height: '100%' }} styles={{ body: { padding: '4px 20px 12px' } }}>
    {children}
  </Card>
);

const ViewAll = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link href={href} style={{ fontSize: 13, fontWeight: 700 }}>
    {children} <ArrowRightOutlined style={{ fontSize: 11 }} />
  </Link>
);

// A list row: the main line and a quiet second line on the left, a status on the right.
const Row2 = ({ children, right }: { children: ReactNode; right: ReactNode }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 0', borderBottom: `1px solid ${COLORS.lineSoft}` }}>
    <div style={{ minWidth: 0 }}>{children}</div>
    {right}
  </div>
);
const Sub = ({ children }: { children: ReactNode }) => <div style={{ color: COLORS.muted, fontSize: 13, marginTop: 3 }}>{children}</div>;

// An empty list that is good news.
const Quiet = ({ children, icon = <CheckCircleOutlined /> }: { children: ReactNode; icon?: ReactNode }) => <EmptyState compact icon={icon} title={children} />;

// "Good morning, Meera": first name only, greeting by the hospital's local time.
function greeting(name: string | undefined) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  const first = name ? firstName(name) : '';
  return `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}${first ? `, ${first}` : ''}`;
}

export default function Home() {
  const { user, can } = useAuth();
  const dash = useFetch<DashboardResponse>('/dashboard');
  const d = dash.data;
  const phone = Grid.useBreakpoint().md === false;
  const [showCharts, setShowCharts] = useState(false);

  const figures = d && (
    <>
      {d.kpis.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <KpiGrid kpis={d.kpis} />
        </div>
      )}
      {d.charts.length > 0 && (!phone || showCharts) && (
        <div style={{ marginBottom: 16 }}>
          <ChartGrid charts={d.charts} />
        </div>
      )}
      {phone && d.charts.length > 0 && !showCharts && (
        <Button block style={{ marginBottom: 16 }} onClick={() => setShowCharts(true)}>
          Show charts ({d.charts.length})
        </Button>
      )}
    </>
  );

  const lists = d && (
    <div style={{ marginBottom: phone ? 16 : 0 }}>
      <Row gutter={[16, 16]}>
        {d.dueSoon && (
          <Col xs={24} xl={12}>
            <Section title="Due soon" link={<ViewAll href="/due">All due items</ViewAll>}>
              {d.dueSoon.length === 0 ? (
                <Quiet>Nothing is due or overdue this month.</Quiet>
              ) : (
                d.dueSoon.map((i) => (
                  <Row2 key={`${i.kind}-${i.assetId}`} right={<DueText daysLeft={i.daysLeft} />}>
                    <Link href={`/assets/${i.assetId}?tab=${i.kind}`} className="code">
                      {i.assetCode}
                    </Link>
                    <Sub>
                      {i.kind === 'pms' ? 'PMS' : 'Calibration'} · {i.assetName} · {formatDate(i.dueDate)}
                    </Sub>
                  </Row2>
                ))
              )}
            </Section>
          </Col>
        )}
        <Col xs={24} xl={d.dueSoon ? 12 : 24}>
          <Section title="Open complaints" link={<ViewAll href="/complaints">All complaints</ViewAll>}>
            <ComplaintsMiniList rows={d.openList} />
          </Section>
        </Col>
        {d.topBreakdowns && (
          <Col xs={24} xl={12}>
            <Section title="Most breakdown-prone equipment" link={<ViewAll href="/complaints">Complaint history</ViewAll>}>
              {d.topBreakdowns.length === 0 ? (
                <Quiet>No breakdowns in the last 12 months.</Quiet>
              ) : (
                d.topBreakdowns.map((t) => (
                  <Row2 key={t.assetId} right={<span className="num" style={{ fontWeight: 600 }}>{t.breakdowns} {t.breakdowns === 1 ? 'breakdown' : 'breakdowns'}</span>}>
                    <Link href={`/assets/${t.assetId}?tab=complaints`} className="code">
                      {t.assetCode}
                    </Link>
                    <Sub>
                      {t.assetName} · {t.downtimeHours} h downtime
                    </Sub>
                  </Row2>
                ))
              )}
              <div style={{ color: COLORS.muted, fontSize: 12, padding: '8px 0 4px' }}>Last 12 months</div>
            </Section>
          </Col>
        )}
        {d.expiring && (
          <Col xs={24} xl={12}>
            <Section title="Warranty and contracts ending soon" link={<ViewAll href="/reports/warranty-contracts">Cover report</ViewAll>}>
              {d.expiring.length === 0 ? (
                <Quiet icon={<SafetyCertificateOutlined />}>Nothing ends in the next 60 days.</Quiet>
              ) : (
                d.expiring.map((x) => (
                  <Row2 key={`${x.kind}-${x.assetId}-${x.date}-${x.label}`} right={<Pill tone={x.daysLeft <= 30 ? 'warn' : 'neutral'}>In {x.daysLeft} {x.daysLeft === 1 ? 'day' : 'days'}</Pill>}>
                    <Link href={`/assets/${x.assetId}?tab=purchase`} className="code">
                      {x.assetCode}
                    </Link>
                    <Sub>
                      {x.label} · {x.assetName} · {formatDate(x.date)}
                    </Sub>
                  </Row2>
                ))
              )}
            </Section>
          </Col>
        )}
      </Row>
    </div>
  );

  return (
    <>
      <PageHeader
        title={greeting(user?.name)}
        docTitle="Dashboard"
        subtitle={`${d?.scope === 'department' ? `${user?.roleLabel} · ${d.departmentName}` : user?.roleLabel} · ${formatDate(new Date())}`}
        action={can('complaint.create') && <Link href="/complaints"><Button type="primary">Raise complaint</Button></Link>}
      />
      {dash.error && <Alert type="error" showIcon message="Could not load the dashboard" description={dash.error} action={<Button onClick={dash.reload}>Retry</Button>} />}
      {dash.loading && !d && <DashboardSkeleton header={false} />}
      {d && (
        <>
          {d.pendingApprovals !== null && d.pendingApprovals > 0 && (
            <Alert
              style={{ marginBottom: 20, alignItems: 'center' }}
              type="info"
              showIcon
              message={`${d.pendingApprovals} ${d.pendingApprovals === 1 ? 'request is' : 'requests are'} waiting for your decision`}
              action={<Link href="/approvals"><Button size="small">Review</Button></Link>}
            />
          )}
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Stat label={d.scope === 'department' ? 'Your equipment' : 'Active assets'} value={d.activeAssets} href="/assets" icon={<BarcodeOutlined />} tone="primary" hint="In active use" />
            <Stat label="Open complaints" value={d.openComplaints} href="/complaints" icon={<ToolOutlined />} tone="warn" hint={d.openComplaints ? 'Waiting for a fix' : 'All clear'} />
            <Stat label="Due this month" value={d.dueThisMonth} href="/due?range=month" icon={<CalendarOutlined />} tone="warn" hint={d.dueThisMonth ? 'PMS and calibration' : 'Nothing due'} />
            <Stat label="Overdue" value={d.overdue} href="/due?range=overdue" icon={<ExclamationCircleOutlined />} tone="bad" hint={d.overdue ? 'Needs action now' : 'Nothing overdue'} />
          </Row>

          {/* Phones: what needs doing (due items, open complaints) comes before the figures and charts. */}
          {phone ? (
            <>
              {lists}
              {figures}
            </>
          ) : (
            <>
              {figures}
              {lists}
            </>
          )}
        </>
      )}
    </>
  );
}
