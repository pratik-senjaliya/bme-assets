'use client';

import { InboxOutlined } from '@ant-design/icons';
import { Alert, Button, Table, type TableProps } from 'antd';
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
  return (
    <Table<T>
      rowKey="id"
      size="small"
      sticky
      loading={loading}
      dataSource={rows ?? []}
      pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
      locale={{
        // Plain text gets the standard empty look; a page may pass its own EmptyState instead.
        emptyText: loading ? ' ' : typeof emptyText === 'object' && emptyText !== null ? emptyText : <EmptyState compact icon={<InboxOutlined />} title={emptyText ?? 'Nothing here yet'} />,
      }}
      scroll={{ x: 'max-content' }}
      {...rest}
    />
  );
}
