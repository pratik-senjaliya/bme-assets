import { Breadcrumb, Typography } from 'antd';
import type { ReactNode } from 'react';

// Breadcrumb, title, subtitle; the page's single primary action goes top right.
export function PageHeader({
  title,
  subtitle,
  crumbs = [],
  action,
}: {
  title: string;
  subtitle?: string;
  crumbs?: string[];
  action?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
      <div>
        {crumbs.length > 0 && <Breadcrumb items={crumbs.map((c) => ({ title: c }))} style={{ marginBottom: 8 }} />}
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {subtitle && <Typography.Text type="secondary">{subtitle}</Typography.Text>}
      </div>
      {action}
    </div>
  );
}
