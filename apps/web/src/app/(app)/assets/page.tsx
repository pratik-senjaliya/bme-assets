'use client';

import { MoreOutlined } from '@ant-design/icons';
import { Button, Dropdown, Empty, Input, Select, Space } from 'antd';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ASSET_STATUSES, CRITICALITIES, type AssetRow, type Paged } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { CriticalityTag, StatusTag, WarrantyTag } from '@/components/StatusTag';
import { RaiseComplaintModal } from '@/components/RaiseComplaintModal';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';

type Option = { id: string; name: string };

const STATUS_OPTIONS = [
  ...ASSET_STATUSES.map((s) => ({ value: s, label: { active: 'Active', not_in_use: 'Not in use', condemned: 'Condemned' }[s] })),
  { value: 'all', label: 'All statuses' },
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

  const filtered = Object.keys(q).some((k) => k !== 'page');
  const canAdd = can('asset.create');
  const select = (key: string, placeholder: string, options: { value: string; label: string }[]) => (
    <Select
      allowClear
      placeholder={placeholder}
      aria-label={placeholder}
      style={{ minWidth: 170 }}
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
          canAdd && (
            <Space>
              <Link href="/assets/import">
                <Button>Import from Excel</Button>
              </Link>
              <Link href="/assets/new">
                <Button type="primary">Add asset</Button>
              </Link>
            </Space>
          )
        }
      />
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search
          allowClear
          placeholder="Search ID, name, serial, make"
          aria-label="Search assets"
          style={{ width: 280 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {user?.role !== 'nursing' && select('departmentId', 'Department', (departments.data ?? []).map((d) => ({ value: d.id, label: d.name })))}
        {select('equipmentTypeId', 'Equipment type', (types.data ?? []).map((t) => ({ value: t.id, label: t.name })))}
        {select('criticality', 'Criticality', CRITICALITIES.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })))}
        <Select
          aria-label="Status"
          style={{ minWidth: 150 }}
          value={q.status ?? 'active'}
          options={STATUS_OPTIONS}
          onChange={(v) => set({ status: v === 'active' ? undefined : v })}
        />
        {filtered && (
          <Button
            type="link"
            onClick={() => {
              setSearch('');
              router.replace(pathname);
            }}
          >
            Clear
          </Button>
        )}
      </Space>
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
        columns={[
          {
            title: 'Asset ID',
            dataIndex: 'assetCode',
            render: (code: string, row) => (
              <Link href={`/assets/${row.id}`} style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                {code}
              </Link>
            ),
          },
          {
            title: 'Name',
            dataIndex: 'name',
            render: (name: string, row) => (
              <div>
                <div>{name}</div>
                {(row.make || row.model) && <div style={{ color: '#6B7280', fontSize: 12 }}>{[row.make, row.model].filter(Boolean).join(' ')}</div>}
              </div>
            ),
          },
          { title: 'Type', dataIndex: 'equipmentTypeName' },
          {
            title: 'Location',
            key: 'location',
            render: (_: unknown, row) => `${row.departmentName} · ${row.locationName}`,
          },
          { title: 'Criticality', dataIndex: 'criticality', render: (v: string) => <CriticalityTag value={v} /> },
          { title: 'Warranty', dataIndex: 'warrantyStatus', render: (v: AssetRow['warrantyStatus']) => <WarrantyTag status={v} /> },
          { title: 'Status', dataIndex: 'status', render: (v: AssetRow['status']) => <StatusTag status={v} /> },
          {
            title: '',
            key: 'actions',
            align: 'right',
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
