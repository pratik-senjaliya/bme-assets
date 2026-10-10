'use client';

import { Skeleton } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import { COLORS } from '@/theme';

// Loading placeholders shaped like the page that is coming, so nothing jumps when the data arrives.
// Each page picks the one that matches its layout; they are decorative, so screen readers get one "Loading" label.

const card: CSSProperties = { background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 16, padding: 20 };

export function Bar({ w, h = 14, r = 8, style }: { w: number | string; h?: number; r?: number; style?: CSSProperties }) {
  return <Skeleton.Node active style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

function Loading({ children, label = 'Loading' }: { children: ReactNode; label?: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {children}
    </div>
  );
}

// Title, subtitle and an action button, as PageHeader draws them.
export function HeaderSkeleton({ action = true }: { action?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Bar w={240} h={28} />
        <Bar w={320} h={14} />
      </div>
      {action && <Bar w={150} h={40} r={10} />}
    </div>
  );
}

// Rows of a table inside its card: a header strip, then lines with a leading two-line cell.
export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  const widths = ['70%', '55%', '40%', '60%', '45%', '50%'];
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }} aria-hidden>
      <div style={{ display: 'flex', gap: 24, padding: '16px 20px', background: '#FAFBFC', borderBottom: `1px solid ${COLORS.line}` }}>
        {Array.from({ length: cols }, (_, i) => (
          <div key={i} style={{ flex: i === 0 ? 2 : 1 }}>
            <Bar w={i === 0 ? 90 : 64} h={10} />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: 'flex', gap: 24, alignItems: 'center', padding: '16px 20px', borderBottom: r < rows - 1 ? `1px solid ${COLORS.lineSoft}` : 0 }}>
          {Array.from({ length: cols }, (_, i) => (
            <div key={i} style={{ flex: i === 0 ? 2 : 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Bar w={widths[(r + i) % widths.length]} h={12} />
              {i === 0 && <Bar w="40%" h={10} />}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Figure tiles in a row (matches KpiGrid).
export function KpiSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="kpi-grid" style={{ ['--cols' as string]: count }} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Bar w="55%" h={12} />
          <Bar w="40%" h={28} />
          <Bar w="70%" h={10} />
        </div>
      ))}
    </div>
  );
}

// A card with a title and a chart-shaped block.
export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 16 }} aria-hidden>
      <Bar w={180} h={14} />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height }}>
        {[45, 70, 55, 85, 60, 40, 75, 50, 65, 80, 55, 70].map((h, i) => (
          <Bar key={i} w="100%" h={(height * h) / 100} r={6} style={{ flex: 1, minWidth: 0 }} />
        ))}
      </div>
    </div>
  );
}

// A card of label / value pairs (a Descriptions block).
export function FactsSkeleton({ items = 6, title = true }: { items?: number; title?: boolean }) {
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 18 }} aria-hidden>
      {title && <Bar w={140} h={14} />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '18px 24px' }}>
        {Array.from({ length: items }, (_, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Bar w={80} h={10} />
            <Bar w={i % 2 ? '60%' : '80%'} h={14} />
          </div>
        ))}
      </div>
    </div>
  );
}

// A list page: header, a filter bar, the table.
export function ListPageSkeleton({ filters = 3, rows = 8, cols = 5, action = true }: { filters?: number; rows?: number; cols?: number; action?: boolean }) {
  return (
    <Loading>
      <HeaderSkeleton action={action} />
      {filters > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} aria-hidden>
          {Array.from({ length: filters }, (_, i) => (
            <Bar key={i} w={i === 0 ? 260 : 150} h={40} r={10} />
          ))}
        </div>
      )}
      <TableSkeleton rows={rows} cols={cols} />
    </Loading>
  );
}

// A record page: a header card, figure tiles, tabs, then facts beside a side card.
export function DetailPageSkeleton({ kpis = 4 }: { kpis?: number }) {
  return (
    <Loading>
      <div style={{ ...card, display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }} aria-hidden>
        <Bar w={64} h={64} r={16} />
        <div style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Bar w={120} h={20} r={10} />
          <Bar w="50%" h={24} />
          <Bar w="35%" h={12} />
        </div>
        <Bar w={140} h={40} r={10} />
      </div>
      {kpis > 0 && <KpiSkeleton count={kpis} />}
      <div style={{ display: 'flex', gap: 24, borderBottom: `1px solid ${COLORS.line}`, paddingBottom: 12 }} aria-hidden>
        {[80, 60, 90, 90, 70].map((w, i) => (
          <Bar key={i} w={w} h={14} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: 16 }}>
        <FactsSkeleton />
        <FactsSkeleton items={4} />
      </div>
    </Loading>
  );
}

// A form page: header, then sections of label + field pairs.
export function FormPageSkeleton({ sections = 3, fields = 4 }: { sections?: number; fields?: number }) {
  return (
    <Loading>
      <HeaderSkeleton action={false} />
      {Array.from({ length: sections }, (_, s) => (
        <div key={s} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 20 }} aria-hidden>
          <Bar w={160} h={16} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20 }}>
            {Array.from({ length: fields }, (_, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Bar w={110} h={12} />
                <Bar w="100%" h={40} r={10} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </Loading>
  );
}

// A dashboard or report: header, figure tiles, two charts, a table.
export function DashboardSkeleton({ kpis = 4, header = true }: { kpis?: number; header?: boolean }) {
  return (
    <Loading>
      {header && <HeaderSkeleton />}
      <KpiSkeleton count={kpis} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))', gap: 16 }}>
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
      <TableSkeleton rows={5} cols={4} />
    </Loading>
  );
}

// The whole app while the session is checked: sidebar, top bar and a generic page.
export function ShellSkeleton() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: COLORS.page }}>
      <div className="shell-skeleton-side" style={{ width: 248, flex: 'none', background: '#fff', borderRight: `1px solid ${COLORS.line}`, padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }} aria-hidden>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
          <Bar w={36} h={36} r={10} />
          <Bar w={110} h={14} />
        </div>
        {Array.from({ length: 8 }, (_, i) => (
          <Bar key={i} w={i % 3 === 0 ? '70%' : '85%'} h={16} />
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ height: 68, background: '#fff', borderBottom: `1px solid ${COLORS.line}`, display: 'flex', alignItems: 'center', gap: 12, padding: '0 28px' }} aria-hidden>
          <Bar w={360} h={44} r={12} />
          <div style={{ flex: 1 }} />
          <Bar w={44} h={44} r={12} />
          <Bar w={140} h={36} r={18} />
        </div>
        <div style={{ padding: 28, maxWidth: 1440 }}>
          <ListPageSkeleton />
        </div>
      </div>
    </div>
  );
}

// "Nothing here" with a reason and, where it helps, the one next step.
export function EmptyState({ icon, title, hint, action, compact }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8, padding: compact ? '28px 16px' : '56px 16px' }}>
      {icon && (
        <div aria-hidden style={{ width: 52, height: 52, borderRadius: 16, background: COLORS.primarySoft, color: COLORS.primary, display: 'grid', placeItems: 'center', fontSize: 22, marginBottom: 6 }}>
          {icon}
        </div>
      )}
      <div style={{ fontWeight: 700, fontSize: 15, color: COLORS.ink }}>{title}</div>
      {hint && <div style={{ color: COLORS.muted, fontSize: 13.5, maxWidth: 420 }}>{hint}</div>}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  );
}
