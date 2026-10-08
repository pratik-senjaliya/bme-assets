'use client';


import { AssetForm } from '@/components/AssetForm';
import { PageHeader } from '@/components/PageHeader';
import { useAuth } from '@/lib/auth';
import { StatusResult } from '@/components/StatusResult';

export default function NewAssetPage() {
  const { can } = useAuth();
  if (!can('asset.create')) return <StatusResult status="403" title="You cannot add assets" />;
  return (
    <>
      <PageHeader title="Add asset" subtitle="The asset ID is generated when you save" crumbs={['Assets', 'Add asset']} />
      <div style={{ maxWidth: 960 }}>
        <AssetForm />
      </div>
    </>
  );
}
