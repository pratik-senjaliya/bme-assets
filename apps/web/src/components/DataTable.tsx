'use client';

import { ArrowDownOutlined, ArrowUpOutlined, InboxOutlined, SwapOutlined } from '@ant-design/icons';
import { Alert, Button, Dropdown, Grid, Table, type TableColumnType, type TableProps } from 'antd';
import type { SortOrder } from 'antd/es/table/interface';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
  // A sort the page does not hold itself (a sorter function and no sortOrder) is held here, so the phone's sort control
  // and the column headers agree.
  const [own, setOwn] = useState<{ key: string; order: SortOrder } | null>(null);
  // The place next to the page's Filters button (see PhoneFilters), if the page has one.
  const [slot, setSlot] = useState<Element | null>(null);
  useEffect(() => setSlot(phone ? document.querySelector('.phone-sort-slot') : null), [phone]);
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
  // Phones: each row is drawn as a compact list row (see .ant-table-wrapper in globals.css). Every cell carries its
  // column title as data-label so the row can name it; the table, its sorting, paging and row clicks are the same ones.
  const keyOf = (c: TableColumnType<T>) => String(c.key ?? c.dataIndex ?? '');
  const columns: TableProps<T>['columns'] = rest.columns?.map((c) => {
    if ('children' in c) return c;
    const label = typeof c.title === 'string' ? c.title : undefined;
    const held = c.sorter && !('sortOrder' in c) ? { sortOrder: own?.key === keyOf(c) ? own.order : null } : {};
    return { ...c, ...held, onCell: (r: T, i?: number) => ({ ...c.onCell?.(r, i), 'data-label': label }) as React.TdHTMLAttributes<HTMLElement> };
  });
  const onChange: NonNullable<TableProps<T>['onChange']> = (pagination, filters, sorter, extra) => {
    const one = Array.isArray(sorter) ? sorter[0] : sorter;
    if (extra.action === 'sort') setOwn(one?.order ? { key: String(one.columnKey ?? one.field), order: one.order } : null);
    rest.onChange?.(pagination, filters, sorter, extra);
  };
  // Phones: the header row is hidden (see globals.css), so sorting is one control: next to Filters, else above the list.
  const sortable = (columns ?? []).filter((c): c is TableColumnType<T> => !('children' in c) && !!c.sorter && typeof c.title === 'string');
  const current = sortable.find((c) => c.sortOrder);
  function sortBy(c: TableColumnType<T>) {
    const order: SortOrder = current === c && c.sortOrder === 'ascend' ? 'descend' : 'ascend';
    onChange({}, {}, { column: c, columnKey: c.key ?? keyOf(c), field: c.dataIndex as string, order }, { action: 'sort', currentDataSource: rows ?? [] });
  }
  const label = current ? `Sorted by ${String(current.title)} ${current.sortOrder === 'descend' ? '↓' : '↑'}` : 'Sort';
  const sortControl = phone && sortable.length > 0 && (rows?.length ?? 0) > 1 && (
    <Dropdown
      trigger={['click']}
      menu={{
        selectable: true,
        selectedKeys: current ? [keyOf(current)] : [],
        items: sortable.map((c) => ({
          key: keyOf(c),
          label: String(c.title),
          icon: current === c ? current.sortOrder === 'descend' ? <ArrowDownOutlined /> : <ArrowUpOutlined /> : undefined,
        })),
        onClick: ({ key }) => sortBy(sortable.find((c) => keyOf(c) === key)!),
      }}
    >
      {slot ? <Button aria-label={label} icon={<SwapOutlined rotate={90} />} /> : <Button type="text" size="small" icon={<SwapOutlined rotate={90} />}>{label}</Button>}
    </Dropdown>
  );
  return (
    <>
      {sortControl && (slot ? createPortal(sortControl, slot) : <div className="phone-sort">{sortControl}</div>)}
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
        onChange={onChange}
        columns={columns}
      />
    </>
  );
}
