'use client';

import { App, Button, Form, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import type { ApprovalRow, ApprovalType } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag } from '@/components/StatusTag';
import { api, useFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { useSingleFlight } from '@/lib/forms';
import { StatusResult } from '@/components/StatusResult';
import { COLORS } from '@/theme';

const TYPE_LABEL: Record<ApprovalType, string> = { edit_key_field: 'Key-field edit', condemn: 'Condemnation', delete: 'Deletion' };
const STATUSES = [
  { value: 'pending', label: 'Waiting for decision' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];

export default function ApprovalsPage() {
  const single = useSingleFlight(); // before any early return: hooks always run in the same order
  const { can } = useAuth();
  const { message } = App.useApp();
  const [status, setStatus] = useState('pending');
  const list = useFetch<ApprovalRow[]>(can('approval.decide') || can('asset.request_change') ? `/approvals?status=${status}` : null);
  const [deciding, setDeciding] = useState<{ row: ApprovalRow; mode: 'approve' | 'reject' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{ text?: string }>();
  const decider = can('approval.decide');

  if (!decider && !can('asset.request_change')) return <StatusResult status="403" title="You cannot see approvals" />;


  async function submit() {
    if (!deciding) return;
    const { row, mode } = deciding;
    const text = form.getFieldValue('text') as string | undefined;
    if (mode === 'reject') {
      try {
        await form.validateFields();
      } catch {
        return; // the form shows what is missing
      }
    }
    setSaving(true);
    try {
      await api(`/approvals/${row.id}/${mode}`, { body: mode === 'reject' ? { reason: text } : { note: text || null } });
      message.success(mode === 'approve' ? 'Approved and applied' : 'Rejected');
      setDeciding(null);
    } catch (e) {
      // e.g. "The serial number is now used by …": the request stays pending so it can be rejected.
      message.error(e instanceof Error ? e.message : 'Could not save the decision');
    } finally {
      setSaving(false);
      list.reload();
    }
  }

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle={decider ? 'Requests that need the Biomedical HOD’s decision' : 'Your requests to the Biomedical HOD'}
        crumbs={['Approvals']}
      />
      <Space style={{ marginBottom: 20 }} wrap>
        <span style={{ color: COLORS.muted, fontWeight: 600, fontSize: 13 }}>Show</span>
        <Select aria-label="Show" style={{ width: 240 }} value={status} options={STATUSES} onChange={setStatus} />
      </Space>
      <DataTable<ApprovalRow>
        rows={list.data}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        emptyText={status === 'pending' ? 'Nothing is waiting for a decision.' : 'No requests here.'}
        columns={[
          { title: 'Request', dataIndex: 'type', render: (t: ApprovalType) => <Tag>{TYPE_LABEL[t]}</Tag> },
          {
            title: 'Asset',
            key: 'asset',
            render: (_: unknown, r) =>
              r.assetId ? (
                <Link href={`/assets/${r.assetId}`}>
                  <span className="code">{r.assetCode}</span>
                  <div style={{ color: COLORS.muted, fontSize: 12 }}>{r.assetName}</div>
                </Link>
              ) : (
                <Typography.Text type="secondary">{r.assetCode ?? 'Deleted'}</Typography.Text>
              ),
          },
          {
            title: 'What changes',
            key: 'summary',
            render: (_: unknown, r) => (
              <div style={{ maxWidth: 380 }}>
                {r.summary}
                {r.requestReason && <div style={{ color: COLORS.muted, fontSize: 12 }}>Reason: {r.requestReason}</div>}
              </div>
            ),
          },
          {
            title: 'Requested',
            key: 'requested',
            render: (_: unknown, r) => (
              <div>
                {r.requestedByName}
                <div style={{ color: COLORS.muted, fontSize: 12 }}>{formatDateTime(r.createdAt)}</div>
              </div>
            ),
          },
          // While looking at what is waiting, every row is "pending" and undecided: those columns would only take room.
          ...(status === 'all' ? [{ title: 'Status', dataIndex: 'status', render: (s: ApprovalRow['status']) => <StatusTag status={s} /> }] : []),
          ...(status !== 'pending' ? [{
            title: 'Decision',
            key: 'decision',
            render: (_: unknown, r: ApprovalRow) =>
              r.decidedAt ? (
                <div>
                  {r.decidedByName}
                  <div style={{ color: COLORS.muted, fontSize: 12 }}>{formatDateTime(r.decidedAt)}</div>
                  {r.decisionNote && <div style={{ color: COLORS.muted, fontSize: 12 }}>{r.decisionNote}</div>}
                </div>
              ) : (
                '—'
              ),
          }] : []),
          {
            title: <span className="sr-only">Actions</span>,
            key: 'actions',
            align: 'right',
            // Always in view, however narrow the window: this is what the page is for.
            fixed: 'right',
            width: 190,
            render: (_: unknown, r) =>
              decider && r.status === 'pending' ? (
                <Space>
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => {
                      form.resetFields();
                      setDeciding({ row: r, mode: 'approve' });
                    }}
                  >
                    Approve
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => {
                      form.resetFields();
                      setDeciding({ row: r, mode: 'reject' });
                    }}
                  >
                    Reject
                  </Button>
                </Space>
              ) : null,
          },
        ]}
      />
      <Modal
        open={!!deciding}
        title={deciding?.mode === 'approve' ? 'Approve this request?' : 'Reject this request'}
        okText={deciding?.mode === 'approve' ? 'Approve and apply' : 'Reject'}
        okButtonProps={{ danger: deciding?.mode === 'reject' }}
        confirmLoading={saving}
        onOk={() => single(submit)}
        onCancel={() => setDeciding(null)}
        destroyOnHidden
      >
        <Typography.Paragraph>
          <strong>{deciding?.row.assetCode}</strong> · {deciding?.row.summary}
        </Typography.Paragraph>
        {deciding?.mode === 'approve' && <Typography.Paragraph type="secondary">The change is applied immediately and recorded in the audit log.</Typography.Paragraph>}
        <Form form={form} layout="vertical" requiredMark={deciding?.mode === 'reject'}>
          <Form.Item
            label={deciding?.mode === 'approve' ? 'Note (optional)' : 'Why is it rejected?'}
            name="text"
            rules={deciding?.mode === 'reject' ? [{ required: true, message: 'Say why' }] : []}
          >
            <Input.TextArea rows={3} maxLength={500} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
