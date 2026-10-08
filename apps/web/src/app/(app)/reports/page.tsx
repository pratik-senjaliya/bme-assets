'use client';

import { ArrowRightOutlined, BarcodeOutlined, ScheduleOutlined, ToolOutlined, WalletOutlined } from '@ant-design/icons';
import { Card } from 'antd';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { REPORTS, type ReportType } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { useAuth } from '@/lib/auth';
import { COLORS } from '@/theme';
import { StatusResult } from '@/components/StatusResult';

// Reports are read on screen first; each has Export to Excel and PDF.
const GROUPS: { title: string; icon: ReactNode; types: ReportType[] }[] = [
  { title: 'Equipment', icon: <BarcodeOutlined />, types: ['asset-master', 'equipment-age', 'warranty-contracts'] },
  { title: 'Maintenance', icon: <ScheduleOutlined />, types: ['pms', 'calibration'] },
  { title: 'Breakdowns and uptime', icon: <ToolOutlined />, types: ['breakdowns', 'uptime', 'critical-downtime'] },
  { title: 'Cost', icon: <WalletOutlined />, types: ['expenses'] },
];

export default function ReportsPage() {
  const { can } = useAuth();
  if (!can('report.view')) return <StatusResult status="403" title="You cannot see reports" />;
  return (
    <>
      <PageHeader title="Reports" subtitle="Open a report to read it here. Export to Excel or PDF from the report if you need a file." />
      <div style={{ display: 'grid', gap: 28 }}>
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: COLORS.faint, margin: '0 0 12px' }}>{g.title}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: 16 }}>
              {g.types.map((t) => {
                const r = REPORTS.find((x) => x.type === t)!;
                return (
                  <Link key={t} href={`/reports/${t}`} style={{ display: 'block' }}>
                    <Card hoverable styles={{ body: { padding: 20, display: 'flex', flexDirection: 'column', height: '100%' } }} style={{ height: '100%' }}>
                      <span aria-hidden style={{ width: 40, height: 40, borderRadius: 12, background: COLORS.primarySoft, color: COLORS.primary, display: 'grid', placeItems: 'center', fontSize: 18, marginBottom: 14 }}>
                        {g.icon}
                      </span>
                      <div style={{ fontWeight: 800, fontSize: 16, color: COLORS.ink, marginBottom: 6 }}>{r.title}</div>
                      <div style={{ color: COLORS.muted, flex: 1 }}>{r.description}</div>
                      <div style={{ color: COLORS.primary, fontWeight: 700, marginTop: 16 }}>
                        Open report <ArrowRightOutlined style={{ fontSize: 12 }} />
                      </div>
                    </Card>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
