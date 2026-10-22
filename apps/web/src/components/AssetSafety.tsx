'use client';

import { Alert, Button, Space } from 'antd';
import Link from 'next/link';
import { COMPLAINT_STATUS_LABEL, type AssetRow } from '@bme/shared';
import { COLORS } from '@/theme';
import { Pill } from '@/components/StatusTag';
import { daysFromToday, formatDate, formatDateTime } from '@/lib/format';

// Is this machine safe to use? A fault reported and not yet fixed, or a failed latest PMS / calibration, shows
// wherever the machine does: in lists as pills, on its page as banners (gap review #1–#3). The flags come from the API.
type Condition = Pick<AssetRow, 'status' | 'openComplaints' | 'pmsFailedOn' | 'calibrationFailedOn'>;

export function ConditionPills({ asset }: { asset: Condition }) {
  if (asset.status !== 'active') return null;
  const urgent = asset.openComplaints.some((c) => c.urgent);
  return (
    <>
      {asset.openComplaints.length > 0 && <Pill tone={urgent ? 'bad' : 'warn'}>{urgent ? 'Out of service' : 'Under repair'}</Pill>}
      {asset.pmsFailedOn && <Pill tone="bad">PMS failed</Pill>}
      {asset.calibrationFailedOn && <Pill tone="bad">Calibration failed</Pill>}
    </>
  );
}

export function SafetyAlerts({
  asset,
  canRaise,
  canPerformPms,
  onRaise,
}: {
  asset: Condition & Pick<AssetRow, 'id' | 'nextPmsDue'>;
  canRaise: boolean;
  canPerformPms: boolean;
  onRaise: (description: string) => void;
}) {
  if (asset.status !== 'active') return null;
  const open = asset.openComplaints;
  const urgent = open.some((c) => c.urgent);
  const pmsOverdue = asset.nextPmsDue && daysFromToday(asset.nextPmsDue) < 0;
  if (!open.length && !asset.pmsFailedOn && !asset.calibrationFailedOn && !(pmsOverdue && !canPerformPms)) return null;
  const raise = (text: string) => canRaise && open.length === 0 && <Button danger onClick={() => onRaise(text)}>Raise complaint</Button>;
  return (
    <Space direction="vertical" size={12} style={{ width: '100%', marginBottom: 16 }}>
      {open.length > 0 && (
        <Alert
          type={urgent ? 'error' : 'warning'}
          showIcon
          message={urgent ? 'Out of service: reported as unusable' : 'Under repair: a fault has been reported'}
          description={
            <>
              {open.map((c) => (
                <div key={c.id}>
                  {c.complaintNo} · {COMPLAINT_STATUS_LABEL[c.status]}{c.urgent ? ' · urgent' : ''} · raised {formatDateTime(c.raisedAt)}
                </div>
              ))}
              <div style={{ marginTop: 4 }}>Check with the biomedical team before using it.</div>
            </>
          }
          action={<Link href={`/assets/${asset.id}?tab=complaints`}><Button>See complaints</Button></Link>}
        />
      )}
      {asset.pmsFailedOn && (
        <Alert
          type="error"
          showIcon
          message={`The last PMS failed (${formatDate(asset.pmsFailedOn)})`}
          description="Do not use it until it has been repaired and passes a PMS."
          action={
            <Space direction="vertical">
              {raise(`PMS failed on ${formatDate(asset.pmsFailedOn)}: `)}
              {canPerformPms && <Link href={`/assets/${asset.id}/pms/new`}><Button>Perform PMS again</Button></Link>}
            </Space>
          }
        />
      )}
      {asset.calibrationFailedOn && (
        <Alert
          type="error"
          showIcon
          message={`The last calibration failed (${formatDate(asset.calibrationFailedOn)})`}
          description="Its readings cannot be trusted until it is repaired and passes a calibration."
          action={raise(`Calibration failed on ${formatDate(asset.calibrationFailedOn)}: `)}
        />
      )}
      {pmsOverdue && !canPerformPms && !asset.pmsFailedOn && (
        <Alert
          type="warning"
          showIcon
          message={`PMS overdue since ${formatDate(asset.nextPmsDue!)}`}
          description="Ask the biomedical team before using it on a patient."
        />
      )}
    </Space>
  );
}

// Machines not to use, one line each: name and ID linking to the machine, department, and why.
export function UnsafeList({ rows }: { rows: AssetRow[] }) {
  return (
    <>
      {rows.map((a) => (
        <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: `1px solid ${COLORS.lineSoft}`, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <Link href={`/assets/${a.id}`} style={{ fontWeight: 600 }}>
              {a.name}
            </Link>
            <div style={{ color: COLORS.muted, fontSize: 12.5, marginTop: 2 }}>
              <span className="code">{a.assetCode}</span> · {a.departmentName}, {a.locationName}
            </div>
          </div>
          <Space size={4} wrap>
            <ConditionPills asset={a} />
          </Space>
        </div>
      ))}
    </>
  );
}
