'use client';

import { Card, Typography } from 'antd';
import type { HealthResponse } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { useAuth } from '@/lib/auth';
import { useFetch } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

// Placeholder until the dashboard lands (Phase 5). Keeps the web → API → database check from Phase 0.
export default function Home() {
  const { user } = useAuth();
  const { data: health, error } = useFetch<HealthResponse>('/health');

  return (
    <>
      <PageHeader title={`Welcome, ${user?.name}`} subtitle={user?.roleLabel} />
      <Card title="System status" size="small" style={{ maxWidth: 480 }}>
        {error && <Typography.Text type="danger">API not reachable.</Typography.Text>}
        {health && (
          <Typography.Text>
            API {health.status} · Database {health.database} · {formatDateTime(health.serverTime)}
          </Typography.Text>
        )}
      </Card>
    </>
  );
}
