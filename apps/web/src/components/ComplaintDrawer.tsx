'use client';

import { Alert, Button, Drawer, Timeline, Typography } from 'antd';
import Link from 'next/link';
import { TEAM_LABEL, type ComplaintDetail, type ComplaintEvent } from '@bme/shared';
import { useState } from 'react';
import { StepNote, useComplaintWork } from '@/components/ComplaintWork';
import { DocumentList } from '@/components/DocumentList';
import { RequestDeleteModal, type DeleteTarget } from '@/components/RequestApprovalModals';
import { CriticalityTag, Pill, StatusTag } from '@/components/StatusTag';
import { useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatDuration, formatMoney } from '@/lib/format';
import { COLORS } from '@/theme';
import { FactsSkeleton } from '@/components/Skeletons';

const DOT: Record<ComplaintEvent['kind'], string> = {
  raised: COLORS.bad.dot,
  assigned: COLORS.info.dot,
  started: COLORS.warn.dot,
  escalated: COLORS.warn.dot,
  held: COLORS.info.dot,
  resumed: COLORS.warn.dot,
  resolved: COLORS.good.dot,
  reopened: COLORS.bad.dot,
  closed: COLORS.neutral.dot,
  document: COLORS.neutral.dot,
  expense: COLORS.neutral.dot,
};

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ background: COLORS.surfaceAlt, borderRadius: 8, padding: '12px 14px' }}>
    <div style={{ color: COLORS.muted, fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>{label}</div>
    <div style={{ fontWeight: 700, color: COLORS.ink, fontSize: 15 }} className="num">{children}</div>
  </div>
);

// One complaint, start to finish: who raised it, who started and resolved it, how long each step took, the documents
// and (for those allowed to see costs) the expenses. Documents can be added until the complaint is resolved; after
// that only by the biomedical team (the OEM's report or the invoice often comes later).
export function ComplaintDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged?: () => void }) {
  const { can } = useAuth();
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const complaint = useFetch<ComplaintDetail>(id ? `/complaints/${id}` : null);
  // The next step (take, assign, start, resolve) can be done from here too.
  const { actions, dialogs } = useComplaintWork(() => {
    void complaint.reload();
    onChanged?.();
  });
  const c = complaint.data && complaint.data.id === id ? complaint.data : null;
  const canAttach = !!c && (c.resolvedAt ? can('complaint.resolve') : can('complaint.create') || can('complaint.start') || can('complaint.resolve'));
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
            {c.urgent && <Pill tone="bad">Urgent</Pill>}
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
            <Alert type="error" showIcon message="Critical equipment down beyond the hospital's limit" description={c.resolvedAt ? 'This breakdown ran longer than the limit set in Hospital settings.' : 'This breakdown is still open and has passed the limit set in Hospital settings.'} />
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
            <Fact label="Assigned to">{c.assignedToName ?? <span style={{ color: COLORS.muted, fontWeight: 400 }}>Nobody yet</span>}</Fact>
            <Fact label="Response time">{c.startedAt ? formatDuration(c.responseSeconds) : <span style={{ color: COLORS.muted, fontWeight: 400 }}>Not started</span>}</Fact>
            <Fact label={c.resolvedAt ? 'Downtime' : 'Open for'}>{c.resolvedAt ? formatDuration(c.downtimeSeconds) : openFor}</Fact>
          </div>
          {c.status === 'resolved' && (
            <Alert
              type="success"
              showIcon
              message={`Resolved · waiting for ${c.departmentName} to close it`}
              description={`${c.raisedByName}, or anyone from ${c.departmentName}, closes it once the equipment works again. Downtime ended when it was resolved.`}
            />
          )}
          <StepNote c={c} />
          {actions(c) && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{actions(c)}</div>}
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
            {!canAttach && c.resolvedAt && <div style={{ color: COLORS.muted, fontSize: 12.5, marginTop: 8 }}>This complaint is resolved: only the {TEAM_LABEL[c.register].toLowerCase()} can still add its service report or invoice.</div>}
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
          {/* Raised by mistake (wrong equipment, a duplicate) and not started yet: the HOD can remove it. */}
          {c.status === 'open' && can('asset.request_change') && (
            <div>
              <Button danger onClick={() => setDeleting({ type: 'complaint', id: c.id, label: `complaint ${c.complaintNo}` })}>
                Request deletion (raised by mistake)
              </Button>
            </div>
          )}
        </div>
      )}
      <RequestDeleteModal target={deleting} onClose={() => setDeleting(null)} onRequested={() => setDeleting(null)} />
      {dialogs}
    </Drawer>
  );
}
