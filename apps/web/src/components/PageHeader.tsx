import { Breadcrumb, Typography } from 'antd';
import Link from 'next/link';
import { useEffect, type ReactNode } from 'react';
import { COLORS } from '@/theme';

// Only the first crumb has a list page to go back to; the rest describe where you are.
const PARENT: Record<string, string> = { Assets: '/assets', Complaints: '/complaints', Approvals: '/approvals' };

// Breadcrumb (only when it adds a level), title, subtitle; the page's single primary action goes top right.
export function PageHeader({
  title,
  subtitle,
  crumbs = [],
  action,
  meta,
  docTitle,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  crumbs?: string[];
  action?: ReactNode;
  meta?: ReactNode;
  // The browser tab / history name when `title` is not plain text (an asset code in a styled span).
  docTitle?: string;
}) {
  const name = docTitle ?? (typeof title === 'string' ? title : '');
  useEffect(() => {
    document.title = name ? `${name} · BME Assets` : 'BME Assets';
  }, [name]);
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        {crumbs.length > 1 && (
          <Breadcrumb
            style={{ marginBottom: 6, fontSize: 13 }}
            items={crumbs.map((c, i) => ({ title: i === 0 && PARENT[c] ? <Link href={PARENT[c]}>{c}</Link> : c }))}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Typography.Title level={1} style={{ margin: 0, fontWeight: 650, letterSpacing: '-0.01em', fontSize: 24, lineHeight: 1.3 }}>
            {title}
          </Typography.Title>
          {meta}
        </div>
        {subtitle && <div style={{ color: COLORS.muted, marginTop: 2 }}>{subtitle}</div>}
      </div>
      {action && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{action}</div>}
    </div>
  );
}
