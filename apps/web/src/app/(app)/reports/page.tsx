'use client';

import { ArrowRightOutlined } from '@ant-design/icons';
import { Card } from 'antd';
import Link from 'next/link';
import { REPORTS, type ReportType } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { useAuth } from '@/lib/auth';
import { COLORS } from '@/theme';
import { StatusResult } from '@/components/StatusResult';

// Reports are read on screen first; each has Export to Excel and PDF.
const GROUPS: { title: string; types: ReportType[] }[] = [
  { title: 'Equipment', types: ['asset-master', 'equipment-age', 'warranty-contracts'] },
  { title: 'Maintenance', types: ['pms', 'calibration'] },
  { title: 'Breakdowns and uptime', types: ['breakdowns', 'uptime', 'critical-downtime'] },
  { title: 'Cost', types: ['expenses'] },
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
            <h2 style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: COLORS.muted, margin: '0 0 12px' }}>{g.title}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: 16 }}>
              {g.types.map((t) => {
                const r = REPORTS.find((x) => x.type === t)!;
                return (
                  <Link key={t} href={`/reports/${t}`} style={{ display: 'block' }}>
                    <Card hoverable styles={{ body: { padding: 20 } }} style={{ height: '100%' }}>
                      <div style={{ fontWeight: 600, fontSize: 16, color: COLORS.ink, marginBottom: 6 }}>{r.title}</div>
                      <div style={{ color: COLORS.muted, minHeight: 66 }}>{r.description}</div>
                      <div style={{ color: COLORS.primary, fontWeight: 500, marginTop: 12 }}>
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
