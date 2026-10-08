'use client';

import { Card, Result } from 'antd';
import { AssetForm } from '@/components/AssetForm';
import { PageHeader } from '@/components/PageHeader';
import { useAuth } from '@/lib/auth';

export default function NewAssetPage() {
  const { can } = useAuth();
  if (!can('asset.create')) return <Result status="403" title="You cannot add assets" />;
  return (
    <>
      <PageHeader title="Add asset" subtitle="The asset ID is generated when you save" crumbs={['Assets', 'Add asset']} />
      <Card style={{ maxWidth: 960 }}>
        <AssetForm />
      </Card>
    </>
  );
}
