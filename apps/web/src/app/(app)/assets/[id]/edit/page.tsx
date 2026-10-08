'use client';

import { Alert, Result, Skeleton } from 'antd';
import { useParams } from 'next/navigation';
import type { AssetDetail } from '@bme/shared';
import { AssetForm } from '@/components/AssetForm';
import { PageHeader } from '@/components/PageHeader';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function EditAssetPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const asset = useFetch<AssetDetail>(`/assets/${id}`);

  if (!can('asset.edit')) return <Result status="403" title="You cannot edit assets" />;
  return (
    <>
      <PageHeader title={asset.data ? `Edit ${asset.data.assetCode}` : 'Edit asset'} crumbs={['Assets', 'Edit']} />
      <div style={{ maxWidth: 960 }}>
        {asset.error && <Alert type="error" showIcon message="Could not load this asset" description={asset.error} />}
        {asset.loading && !asset.data && <Skeleton active />}
        {asset.data && <AssetForm asset={asset.data} />}
      </div>
    </>
  );
}
