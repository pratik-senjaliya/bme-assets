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
type Entry = { href: string; title: string; description: string };
const entry = (t: ReportType): Entry => {
  const r = REPORTS.find((x) => x.type === t)!;
  return { href: `/reports/${t}`, title: r.title, description: r.description };
};
const GROUPS: { title: string; entries: Entry[] }[] = [
  {
    title: 'For management and audits',
    entries: [
      { href: '/reports/monthly', title: 'Monthly report', description: 'The month in one page: uptime, breakdowns, PMS and calibration on schedule, spend, and equipment to consider replacing. Saved and sent to the HOD on the 1st.' },
      { href: '/reports/audit-pack', title: 'Audit pack', description: 'One ZIP for an auditor: inventory, PMS checklists, calibration certificates, breakdowns, downtime, cover and condemnation letters for a period.' },
    ],
  },
  { title: 'Equipment', entries: (['asset-master', 'equipment-age', 'warranty-contracts', 'condemnation'] as ReportType[]).map(entry) },
  { title: 'Maintenance', entries: (['pms', 'calibration'] as ReportType[]).map(entry) },
  { title: 'Breakdowns and uptime', entries: (['breakdowns', 'uptime', 'critical-downtime'] as ReportType[]).map(entry) },
  { title: 'Cost', entries: (['expenses'] as ReportType[]).map(entry) },
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
            <h2 style={{ fontSize: 15, fontWeight: 700, color: COLORS.ink, margin: '0 0 12px' }}>{g.title}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: 16 }}>
              {g.entries.map((r) => {
                return (
                  <Link key={r.href} href={r.href} style={{ display: 'block' }}>
                    <Card hoverable styles={{ body: { padding: '16px 18px', display: 'flex', flexDirection: 'column', height: '100%' } }} style={{ height: '100%' }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: COLORS.ink, marginBottom: 4 }}>{r.title}</div>
                      <div style={{ color: COLORS.muted, flex: 1 }}>{r.description}</div>
                      <div style={{ color: COLORS.primary, fontWeight: 600, marginTop: 12 }}>
                        Open <ArrowRightOutlined style={{ fontSize: 12 }} />
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
