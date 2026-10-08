'use client';

import { Alert, Button, Drawer, Timeline, Typography } from 'antd';
import Link from 'next/link';
import type { ComplaintDetail, ComplaintEvent } from '@bme/shared';
import { DocumentList } from '@/components/DocumentList';
import { CriticalityTag, StatusTag } from '@/components/StatusTag';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatDuration, formatMoney } from '@/lib/format';
import { COLORS } from '@/theme';
import { FactsSkeleton } from '@/components/Skeletons';

const DOT: Record<ComplaintEvent['kind'], string> = { raised: COLORS.bad.dot, started: COLORS.warn.dot, resolved: COLORS.good.dot, document: COLORS.neutral.dot, expense: COLORS.neutral.dot };

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ background: COLORS.surfaceAlt, borderRadius: 12, padding: '12px 14px' }}>
    <div style={{ color: COLORS.faint, fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
    <div style={{ fontWeight: 700, color: COLORS.ink, fontSize: 15 }} className="num">{children}</div>
  </div>
);

// One complaint, start to finish: who raised it, who started and resolved it, how long each step took, the documents
// and (for those allowed to see costs) the expenses. Documents can be added until the complaint is resolved.
export function ComplaintDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged?: () => void }) {
  const { can } = useAuth();
  const complaint = useFetch<ComplaintDetail>(id ? `/complaints/${id}` : null);
  const c = complaint.data && complaint.data.id === id ? complaint.data : null;
  const canAttach = !!c && c.status !== 'resolved' && (can('complaint.create') || can('complaint.start') || can('complaint.resolve'));
  // Running time for a complaint that is still open (display only; stored times are the server's).
  const openFor = c && !c.resolvedAt ? formatDuration((Date.now() - new Date(c.raisedAt).getTime()) / 1000) : null;

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width={560}
      destroyOnHidden
      title={
        c ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
            <span className="code">{c.complaintNo}</span>
            <StatusTag status={c.status} />
          </span>
        ) : (
          'Complaint'
        )
      }
    >
      {complaint.error && <Alert type="error" showIcon message="Could not load this complaint" description={complaint.error} action={<Button onClick={complaint.reload}>Retry</Button>} />}
      {!c && !complaint.error && <FactsSkeleton items={8} />}
      {c && (
        <div style={{ display: 'grid', gap: 24 }}>
          {c.overDowntimeLimit && (
            <Alert type="error" showIcon message="Critical equipment down beyond the hospital's limit" description={c.status === 'resolved' ? 'This breakdown ran longer than the limit set in Hospital settings.' : 'This breakdown is still open and has passed the limit set in Hospital settings.'} />
          )}
          <div>
            <Link href={`/assets/${c.assetId}`} className="code">
              {c.assetCode}
            </Link>
            <span style={{ color: COLORS.muted }}> · {c.assetName}</span>
            <div style={{ color: COLORS.muted, fontSize: 13, marginTop: 2 }}>{c.departmentName}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            <Fact label="Criticality">
              <CriticalityTag value={c.criticality} />
            </Fact>
            <Fact label="Response time">{c.startedAt ? formatDuration(c.responseSeconds) : <span style={{ color: COLORS.muted, fontWeight: 400 }}>Not started</span>}</Fact>
            <Fact label={c.resolvedAt ? 'Downtime' : 'Open for'}>{c.resolvedAt ? formatDuration(c.downtimeSeconds) : openFor}</Fact>
          </div>
          <div>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              Problem
            </Typography.Title>
            <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{c.description}</Typography.Paragraph>
          </div>
          {c.resolutionNotes && (
            <div>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                What was done
              </Typography.Title>
              <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{c.resolutionNotes}</Typography.Paragraph>
            </div>
          )}
          <div>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              History
            </Typography.Title>
            <Timeline
              items={c.events.map((e) => ({
                color: DOT[e.kind],
                children: (
                  <div>
                    <div style={{ fontWeight: 500 }}>{e.title}</div>
                    <div style={{ color: COLORS.muted, fontSize: 12.5 }}>
                      {formatDateTime(e.at)}
                      {e.by && ` · ${e.by}`}
                    </div>
                    {e.detail && e.kind !== 'raised' && <div style={{ marginTop: 2 }}>{e.detail}</div>}
                  </div>
                ),
              }))}
            />
          </div>
          <div>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              Documents
            </Typography.Title>
            <DocumentList
              ownerType="complaint"
              ownerId={c.id}
              kinds={['photo', 'other']}
              canUpload={canAttach}
              onChanged={() => {
                complaint.reload();
                onChanged?.();
              }}
              emptyText={canAttach ? 'No documents yet. Add a photo of the fault if it helps.' : 'No documents.'}
            />
            {!canAttach && c.status === 'resolved' && <div style={{ color: COLORS.muted, fontSize: 12.5, marginTop: 8 }}>A resolved complaint is closed, so documents can no longer be added.</div>}
          </div>
          {c.expenses.length > 0 && (
            <div>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                Expenses
              </Typography.Title>
              {c.expenses.map((e) => (
                <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: `1px solid ${COLORS.lineSoft}` }}>
                  <span>
                    {e.description}
                    <span style={{ color: COLORS.muted }}> · {e.type === 'spare_part' ? 'Spare part' : 'Repair'}</span>
                  </span>
                  <span className="num">{formatMoney(e.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
