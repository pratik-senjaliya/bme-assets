import { Breadcrumb, Typography } from 'antd';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { COLORS } from '@/theme';
import { useDocumentTitle } from '@/lib/title';

// Only the first crumb has a list page to go back to; the rest describe where you are.
const PARENT: Record<string, string> = { Assets: '/assets', Complaints: '/complaints', Approvals: '/approvals', Consumables: '/consumables' };

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
  useDocumentTitle(name ? `${name} · BME Assets` : 'BME Assets');
  return (
    <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        {crumbs.length > 1 && (
          <Breadcrumb
            style={{ marginBottom: 6, fontSize: 13, fontWeight: 500 }}
            items={crumbs.map((c, i) => ({ title: i === 0 && PARENT[c] ? <Link href={PARENT[c]}>{c}</Link> : c }))}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Typography.Title level={1} style={{ margin: 0, fontWeight: 700, letterSpacing: '-0.015em', fontSize: 24, lineHeight: 1.3 }}>
            {title}
          </Typography.Title>
          {meta}
        </div>
        {subtitle && (
          <div className="page-subtitle" style={{ color: COLORS.muted, marginTop: 4, fontSize: 14 }}>
            {subtitle}
          </div>
        )}
      </div>
      {action && (
        <div className="page-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {action}
        </div>
      )}
    </div>
  );
}
