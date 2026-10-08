'use client';

import { FileImageOutlined, FilePdfOutlined, PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { App, Badge, Button, Empty, List, Modal, Select, Skeleton, Space, Upload } from 'antd';
import { useState } from 'react';
import type { AttachmentOwnerType, AttachmentRow } from '@bme/shared';
import { useFetch } from '@/lib/api';
import { formatDateTime, formatSize } from '@/lib/format';
import { ACCEPT, KIND_LABEL, fileProblem, uploadFile } from '@/lib/uploads';
import { COLORS } from '@/theme';

// The documents on one record (a complaint, a service entry, an expense, a contract, ...), with an upload control for
// people allowed to add. Files are served through the API, so the same permissions and department scope apply.
export function DocumentList({
  ownerType,
  ownerId,
  kinds,
  canUpload,
  onChanged,
  emptyText = 'No documents yet.',
}: {
  ownerType: AttachmentOwnerType;
  ownerId: string;
  kinds: string[];
  canUpload: boolean;
  onChanged?: () => void;
  emptyText?: string;
}) {
  const { message } = App.useApp();
  const files = useFetch<AttachmentRow[]>(`/attachments?ownerType=${ownerType}&ownerId=${ownerId}`);
  const [kind, setKind] = useState(kinds[0]);
  const [busy, setBusy] = useState(false);

  async function send(file: File) {
    const problem = fileProblem(file);
    if (problem) return message.error(problem);
    setBusy(true);
    try {
      await uploadFile(file, { ownerType, ownerId }, kind);
      message.success(`${file.name} uploaded`);
      files.reload();
      onChanged?.();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {canUpload && (
        <Space wrap style={{ marginBottom: 12 }}>
          {kinds.length > 1 && <Select aria-label="Document type" style={{ width: 190 }} value={kind} onChange={setKind} options={kinds.map((k) => ({ value: k, label: KIND_LABEL[k] ?? k }))} />}
          <Upload accept={ACCEPT} showUploadList={false} multiple={false} beforeUpload={(f) => (void send(f), false)}>
            <Button icon={<UploadOutlined />} loading={busy}>
              Add document
            </Button>
          </Upload>
          <span style={{ color: COLORS.muted, fontSize: 12.5 }}>PDF, JPG or PNG, up to 10 MB</span>
        </Space>
      )}
      {files.loading && !files.data ? (
        <Skeleton active paragraph={{ rows: 2 }} />
      ) : files.error ? (
        <span style={{ color: COLORS.bad.fg }}>
          Could not load the documents. <a onClick={files.reload}>Retry</a>
        </span>
      ) : !files.data?.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
      ) : (
        <List
          size="small"
          dataSource={files.data}
          renderItem={(f) => (
            <List.Item>
              <List.Item.Meta
                avatar={f.mime === 'application/pdf' ? <FilePdfOutlined style={{ fontSize: 20, color: COLORS.bad.fg }} /> : <FileImageOutlined style={{ fontSize: 20, color: COLORS.primary }} />}
                title={
                  <a href={`/api/v1/attachments/${f.id}/download`} target="_blank" rel="noreferrer">
                    {f.fileName || 'Download'}
                  </a>
                }
                description={`${KIND_LABEL[f.kind] ?? f.kind} · ${formatSize(f.size)} · ${formatDateTime(f.createdAt)}`}
              />
            </List.Item>
          )}
        />
      )}
    </div>
  );
}

// A "Documents" link for a table row; opens the record's documents in a dialog.
export function DocumentsButton({
  ownerType,
  ownerId,
  title,
  kinds,
  canUpload,
  count,
  onChanged,
}: {
  ownerType: AttachmentOwnerType;
  ownerId: string;
  title: string;
  kinds: string[];
  canUpload: boolean;
  count?: number;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" type="text" aria-label={`Documents for ${title}`} onClick={() => setOpen(true)}>
        <Badge count={count ?? 0} size="small" color={COLORS.primary} offset={[4, -2]}>
          <PaperClipOutlined />
        </Badge>
        <span style={{ marginLeft: 6 }}>Documents</span>
      </Button>
      <Modal open={open} title={`Documents · ${title}`} footer={null} onCancel={() => setOpen(false)} destroyOnHidden>
        <DocumentList ownerType={ownerType} ownerId={ownerId} kinds={kinds} canUpload={canUpload} onChanged={onChanged} />
      </Modal>
    </>
  );
}
