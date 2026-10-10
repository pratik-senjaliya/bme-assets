'use client';

import { InboxOutlined } from '@ant-design/icons';
import { Alert, Button, Grid, Table, type TableProps } from 'antd';
import type { ReactNode } from 'react';
import { EmptyState, TableSkeleton } from '@/components/Skeletons';

type Props<T> = Omit<TableProps<T>, 'dataSource' | 'loading' | 'size'> & {
  rows: T[] | null;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyText?: ReactNode;
};

// Standard list table: compact, sticky header, 20 rows per page, plain-language error with retry.
// First load shows table-shaped placeholders; a reload (new filter, sort, page) keeps the rows under a spinner.
export function DataTable<T extends { id: string }>({ rows, loading, error, onRetry, emptyText, ...rest }: Props<T>) {
  // A sticky header lives in its own table, which a card layout cannot use; phones get the plain header instead.
  const phone = Grid.useBreakpoint().md === false;
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="Could not load this list"
        description={error}
        action={onRetry && <Button onClick={onRetry}>Retry</Button>}
      />
    );
  }
  if (loading && rows === null) {
    return (
      <div role="status" aria-label="Loading" aria-busy="true">
        <TableSkeleton cols={Math.min(Math.max(rest.columns?.length ?? 5, 3), 6)} />
      </div>
    );
  }
  // Phones: each row is drawn as a card (see .ant-table-wrapper in globals.css). Every cell carries its column title
  // as data-label so the card can name it; the table, its sorting, paging and row clicks are the same ones.
  const columns = rest.columns?.map((c) => {
    if ('children' in c) return c;
    const label = typeof c.title === 'string' ? c.title : undefined;
    return { ...c, onCell: (r: T, i?: number) => ({ ...c.onCell?.(r, i), 'data-label': label }) as React.TdHTMLAttributes<HTMLElement> };
  });
  return (
    <Table<T>
      rowKey="id"
      size="small"
      sticky={!phone}
      loading={loading}
      dataSource={rows ?? []}
      pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
      locale={{
        // Plain text gets the standard empty look; a page may pass its own EmptyState instead.
        emptyText: loading ? ' ' : typeof emptyText === 'object' && emptyText !== null ? emptyText : <EmptyState compact icon={<InboxOutlined />} title={emptyText ?? 'Nothing here yet'} />,
      }}
      scroll={{ x: 'max-content' }}
      {...rest}
      columns={columns}
    />
  );
}
