'use client';

import { MoreOutlined } from '@ant-design/icons';
import { SearchOutlined } from '@ant-design/icons';
import { Button, Dropdown, Empty, Input, Segmented, Select, Space } from 'antd';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { CRITICALITIES, type AssetRow, type Paged } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { ExportMenu } from '@/components/ExportMenu';
import { PageHeader } from '@/components/PageHeader';
import { CriticalityTag, DueCell, StatusTag, WarrantyTag } from '@/components/StatusTag';
import { RaiseComplaintModal } from '@/components/RaiseComplaintModal';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { daysFromToday } from '@/lib/format';
import { COLORS } from '@/theme';

type Option = { id: string; name: string };

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'not_in_use', label: 'Not in use' },
  { value: 'condemned', label: 'Condemned' },
  { value: 'all', label: 'All' },
];

// Filters live in the URL so a filtered list can be shared as a link.
function AssetList() {
  const { can, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = Object.fromEntries(params.entries());
  const [search, setSearch] = useState(q.search ?? '');
  const [complaintFor, setComplaintFor] = useState<AssetRow | null>(null);

  const departments = useFetch<Option[]>('/departments');
  const types = useFetch<Option[]>('/equipment-types');

  const query = new URLSearchParams({ status: 'active', ...q, pageSize: '20' }).toString();
  const assets = useFetch<Paged<AssetRow>>(`/assets?${query}`);

  function set(next: Record<string, string | undefined>) {
    const merged = { ...q, ...next, ...('page' in next ? {} : { page: undefined }) };
    const clean = Object.entries(merged).filter(([, v]) => v);
    router.replace(clean.length ? `${pathname}?${new URLSearchParams(clean as [string, string][])}` : pathname);
  }

  // Debounce typing in the search box.
  useEffect(() => {
    const t = setTimeout(() => (search !== (q.search ?? '') ? set({ search: search || undefined }) : undefined), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const filtered = Object.keys(q).some((k) => !['page', 'status', 'sortBy', 'order'].includes(k));
  const canAdd = can('asset.create');
  // Sorting is the server's, so it works across every page, and it lives in the address like the filters.
  const sortOf = (key: string) => (q.sortBy === key ? (q.order === 'desc' ? ('descend' as const) : ('ascend' as const)) : null);
  // Export gives what is on screen: the same search and filters, every page of it.
  const exportQuery = new URLSearchParams(
    Object.entries({ search: q.search, departmentId: q.departmentId, equipmentTypeId: q.equipmentTypeId, criticality: q.criticality, assetStatus: q.status ?? 'active' }).filter(([, v]) => v) as [string, string][],
  );
  const select = (key: string, placeholder: string, options: { value: string; label: string }[]) => (
    <Select
      allowClear
      placeholder={placeholder}
      aria-label={placeholder}
      style={{ minWidth: 180 }}
      value={q[key]}
      options={options}
      onChange={(v) => set({ [key]: v })}
    />
  );

  return (
    <>
      <PageHeader
        title="Assets"
        subtitle={user?.role === 'nursing' ? 'Equipment in your department' : 'Every piece of equipment in the hospital'}
        crumbs={['Assets']}
        action={
          (canAdd || can('report.view')) && (
            <Space wrap>
              {can('report.view') && <ExportMenu path={`/reports/asset-master?${exportQuery}`} name="bme-assets" />}
              {canAdd && (
                <>
                  <Link href="/assets/import">
                    <Button>Import from Excel</Button>
                  </Link>
                  <Link href="/assets/new">
                    <Button type="primary">Add asset</Button>
                  </Link>
                </>
              )}
            </Space>
          )
        }
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: COLORS.faint }} />}
          placeholder="Search ID, name, serial, make"
          aria-label="Search assets"
          style={{ width: 300 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {user?.role !== 'nursing' && select('departmentId', 'Department', (departments.data ?? []).map((d) => ({ value: d.id, label: d.name })))}
        {select('equipmentTypeId', 'Equipment type', (types.data ?? []).map((t) => ({ value: t.id, label: t.name })))}
        {select('criticality', 'Criticality', CRITICALITIES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })))}
        {filtered && (
          <Button
            type="link"
            onClick={() => {
              setSearch('');
              router.replace(pathname);
            }}
          >
            Clear filters
          </Button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ color: COLORS.muted }}>{assets.data ? `${assets.data.total.toLocaleString('en-IN')} ${assets.data.total === 1 ? 'asset' : 'assets'}` : ' '}</span>
          <Segmented aria-label="Status" value={q.status ?? 'active'} options={STATUS_OPTIONS} onChange={(v) => set({ status: v === 'active' ? undefined : String(v) })} />
        </div>
      </div>
      <DataTable<AssetRow>
        rows={assets.data?.items ?? null}
        loading={assets.loading}
        error={assets.error}
        onRetry={assets.reload}
        emptyText={
          filtered ? (
            'No assets match these filters.'
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={canAdd ? 'No assets yet. Add the first one or import a list from Excel.' : 'No equipment to show yet.'}
            />
          )
        }
        pagination={{
          current: assets.data?.page ?? 1,
          pageSize: 20,
          total: assets.data?.total ?? 0,
          showSizeChanger: false,
          hideOnSinglePage: true,
          onChange: (page) => set({ page: String(page) }),
        }}
        onChange={(_p, _f, sorter, extra) => {
          if (extra.action !== 'sort') return; // paging has its own handler
          const one = Array.isArray(sorter) ? sorter[0] : sorter;
          set({ sortBy: one?.order ? String(one.columnKey) : undefined, order: one?.order === 'descend' ? 'desc' : one?.order ? 'asc' : undefined });
        }}
        onRow={(row) => ({
          className: 'row-link',
          onClick: (e) => {
            // Clicks on links, buttons and menus keep their own behaviour.
            if (!(e.target as HTMLElement).closest('a,button,.ant-dropdown')) router.push(`/assets/${row.id}`);
          },
        })}
        columns={[
          {
            title: 'Asset ID',
            key: 'assetCode',
            dataIndex: 'assetCode',
            sorter: true,
            sortOrder: sortOf('assetCode'),
            render: (code: string, row) => (
              <Link href={`/assets/${row.id}`} className="code">
                {code}
              </Link>
            ),
          },
          {
            title: 'Equipment',
            key: 'name',
            dataIndex: 'name',
            sorter: true,
            sortOrder: sortOf('name'),
            render: (name: string, row) => (
              <div style={{ lineHeight: 1.35 }}>
                <div style={{ fontWeight: 500, color: COLORS.ink }}>{name}</div>
                <div style={{ color: COLORS.muted, fontSize: 12.5 }}>{[row.equipmentTypeName, row.make, row.model].filter(Boolean).join(' · ')}</div>
              </div>
            ),
          },
          {
            title: 'Location',
            key: 'department',
            sorter: true,
            sortOrder: sortOf('department'),
            render: (_: unknown, row) => (
              <div style={{ lineHeight: 1.35 }}>
                <div>{row.departmentName}</div>
                <div style={{ color: COLORS.muted, fontSize: 12.5 }}>{row.locationName}</div>
              </div>
            ),
          },
          { title: 'Criticality', key: 'criticality', dataIndex: 'criticality', sorter: true, sortOrder: sortOf('criticality'), render: (v: string) => <CriticalityTag value={v} /> },
          {
            title: 'Next PMS',
            key: 'nextPmsDue',
            dataIndex: 'nextPmsDue',
            sorter: true,
            sortOrder: sortOf('nextPmsDue'),
            render: (d: string | null) => <DueCell date={d} daysLeft={d ? daysFromToday(d) : null} />,
          },
          { title: 'Warranty', dataIndex: 'warrantyStatus', render: (v: AssetRow['warrantyStatus']) => <WarrantyTag status={v} /> },
          { title: 'Status', key: 'status', dataIndex: 'status', sorter: true, sortOrder: sortOf('status'), render: (v: AssetRow['status']) => <StatusTag status={v} /> },
          {
            title: <span className="sr-only">Actions</span>,
            key: 'actions',
            align: 'right',
            width: 56,
            render: (_: unknown, row) => (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'view', label: 'View' },
                    ...(can('complaint.create') ? [{ key: 'complaint', label: 'Raise complaint' }] : []),
                    ...(can('asset.edit') ? [{ key: 'edit', label: 'Edit' }] : []),
                  ],
                  onClick: ({ key }) => (key === 'complaint' ? setComplaintFor(row) : router.push(key === 'edit' ? `/assets/${row.id}/edit` : `/assets/${row.id}`)),
                }}
              >
                <Button type="text" aria-label={`Actions for ${row.assetCode}`} icon={<MoreOutlined />} />
              </Dropdown>
            ),
          },
        ]}
      />
      <RaiseComplaintModal open={!!complaintFor} asset={complaintFor ?? undefined} onClose={() => setComplaintFor(null)} />
    </>
  );
}

export default function AssetsPage() {
  // useSearchParams needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={null}>
      <AssetList />
    </Suspense>
  );
}
