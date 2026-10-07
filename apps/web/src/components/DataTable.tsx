'use client';

import { Alert, Button, Table, type TableProps } from 'antd';

type Props<T> = Omit<TableProps<T>, 'dataSource' | 'loading' | 'size'> & {
  rows: T[] | null;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyText?: string;
};

// Standard list table: compact, sticky header, 20 rows per page, plain-language error with retry.
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
  return (
    <Table<T>
      rowKey="id"
      size="small"
      sticky
      loading={loading}
      dataSource={rows ?? []}
      pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
      locale={{ emptyText: loading ? ' ' : (emptyText ?? 'Nothing here yet') }}
      scroll={{ x: 'max-content' }}
      {...rest}
    />
  );
}
