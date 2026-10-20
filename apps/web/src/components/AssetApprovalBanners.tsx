'use client';

import { Alert, Button, Space } from 'antd';
import Link from 'next/link';
import type { ApprovalRow, AssetDetail, CondemnationInfo, TransferInfo } from '@bme/shared';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { COLORS } from '@/theme';

// Shown above an asset: what is waiting for the HOD, and, for a condemned or transferred asset, why and by whom.
export function AssetApprovalBanners({ asset, version }: { asset: AssetDetail; version: number }) {
  const { can } = useAuth();
  const sees = can('asset.request_change') || can('approval.decide');
  const pending = useFetch<ApprovalRow[]>(sees ? `/approvals?status=pending&assetId=${asset.id}&v=${version}` : null);
  const condemnation = useFetch<CondemnationInfo>(asset.status === 'condemned' ? `/assets/${asset.id}/condemnation` : null);
  const transfer = useFetch<TransferInfo>(asset.status === 'transferred' ? `/assets/${asset.id}/transfer` : null);

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
      {asset.status === 'transferred' && (
        <Alert
          type="warning"
          showIcon
          message={transfer.data ? `Transferred to ${transfer.data.toUnit}` : 'This asset has been transferred to another unit'}
          description={
            transfer.data ? (
              <div>
                {transfer.data.reason}
                <div style={{ color: COLORS.muted, fontSize: 12, marginTop: 4 }}>
                  Requested by {transfer.data.requestedByName}, approved by {transfer.data.approvedByName} on {formatDate(transfer.data.approvedAt)}. Its record up to then stays here, in history and exports.
                </div>
              </div>
            ) : (
              'It is read-only here and stays in history and exports.'
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
