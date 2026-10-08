'use client';

import { Alert, Button, Space } from 'antd';
import Link from 'next/link';
import type { ApprovalRow, AssetDetail, CondemnationInfo } from '@bme/shared';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { COLORS } from '@/theme';

// Shown above an asset: what is waiting for the HOD, and, for a condemned asset, why and by whom.
export function AssetApprovalBanners({ asset, version }: { asset: AssetDetail; version: number }) {
  const { can } = useAuth();
  const sees = can('asset.request_change') || can('approval.decide');
  const pending = useFetch<ApprovalRow[]>(sees ? `/approvals?status=pending&assetId=${asset.id}&v=${version}` : null);
  const condemnation = useFetch<CondemnationInfo>(asset.status === 'condemned' ? `/assets/${asset.id}/condemnation` : null);

  return (
    <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
      {asset.status === 'condemned' && (
        <Alert
          type="warning"
          showIcon
          message="This asset is condemned"
          description={
            condemnation.data ? (
              <div>
                {condemnation.data.reason}
                <div style={{ color: COLORS.muted, fontSize: 12, marginTop: 4 }}>
                  Requested by {condemnation.data.requestedByName}, approved by {condemnation.data.approvedByName} on {formatDate(condemnation.data.approvedAt)}. It stays in history and exports.
                </div>
              </div>
            ) : (
              'It is read-only and stays in history and exports.'
            )
          }
          action={
            condemnation.data && (
              <Space>
                {condemnation.data.eolLetter && (
                  <a href={`/api/v1/attachments/${condemnation.data.eolLetter.id}/download`} target="_blank" rel="noreferrer">
                    <Button size="small">End-of-life letter</Button>
                  </a>
                )}
                <Link href={`/assets/${asset.id}/condemnation`}>
                  <Button size="small">Certificate</Button>
                </Link>
              </Space>
            )
          }
        />
      )}
      {(pending.data ?? []).map((r) => (
        <Alert
          key={r.id}
          type="info"
          showIcon
          message="Waiting for HOD approval"
          description={`${r.summary} · requested by ${r.requestedByName} on ${formatDate(r.createdAt)}`}
          action={can('approval.decide') && <Link href="/approvals"><Button size="small">Review</Button></Link>}
        />
      ))}
    </Space>
  );
}
