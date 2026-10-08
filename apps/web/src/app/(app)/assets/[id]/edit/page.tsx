'use client';

import { Alert, Skeleton } from 'antd';
import { useParams } from 'next/navigation';
import type { AssetDetail } from '@bme/shared';
import { AssetForm } from '@/components/AssetForm';
import { PageHeader } from '@/components/PageHeader';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { StatusResult } from '@/components/StatusResult';

export default function EditAssetPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const asset = useFetch<AssetDetail>(can('asset.edit') ? `/assets/${id}` : null); // ask only if the answer will be used

  if (!can('asset.edit')) return <StatusResult status="403" title="You cannot edit assets" />;
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
