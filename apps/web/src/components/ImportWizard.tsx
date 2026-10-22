'use client';

import { DownloadOutlined, InboxOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Space, Steps, Typography, Upload } from 'antd';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { ImportError, ImportResult, PermissionCode } from '@bme/shared';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { StatusResult } from '@/components/StatusResult';
import { useAuth } from '@/lib/auth';
import { notifySignedOut } from '@/lib/nav';

type Row = ImportError & { id: string };

// POSTs the file. 422 is an expected answer (it carries the per-row problems), not a failure.
async function sendFile(path: string, file: File, dryRun: boolean): Promise<ImportResult> {
  const body = new FormData();
  body.set('file', file);
  const res = await fetch(`/api/v1${path}${dryRun ? '?dryRun=true' : ''}`, { method: 'POST', body });
  if (res.status === 401) notifySignedOut();
  const json = await res.json().catch(() => null);
  if (res.ok || res.status === 422) return json as ImportResult;
  throw new Error(json?.error?.message ?? 'Could not read that file');
}

// Excel import in three steps (template, upload and check, done), shared by assets and users. The file is checked
// first (dry run) and imported only on confirmation, all rows or none.
export function ImportWizard(p: {
  permission: PermissionCode;
  forbidden: string;
  title: string;
  subtitle: string;
  crumbs: string[];
  intro: ReactNode;
  templateHref: string;
  postPath: string;
  noun: [string, string]; // asset, assets
  done: { subTitle: string; href: string; label: string };
}) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  if (!can(p.permission)) return <StatusResult status="403" title={p.forbidden} />;

  async function choose(f: File) {
    setFile(f);
    setCheck(null);
    setBusy(true);
    try {
      setCheck(await sendFile(p.postPath, f, true));
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not check the file');
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!file) return;
    setBusy(true);
    try {
      const result = await sendFile(p.postPath, file, false);
      if (result.ok) setDone(result);
      else setCheck(result); // something changed since the check, e.g. a serial number was taken
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  const step = done ? 2 : 1;
  const problems: Row[] = (check?.errors ?? []).map((e, i) => ({ ...e, id: String(i) }));
  const many = (n: number) => `${n} ${n === 1 ? p.noun[0] : p.noun[1]}`;

  return (
    <>
      <PageHeader title={p.title} subtitle={p.subtitle} crumbs={p.crumbs} />
      <Steps
        current={step}
        style={{ maxWidth: 720, marginBottom: 24 }}
        items={[{ title: 'Get the template' }, { title: 'Upload and check' }, { title: 'Done' }]}
      />

      {done ? (
        <StatusResult
          status="success"
          title={`${many(done.created)} imported`}
          subTitle={p.done.subTitle}
          extra={<Link href={p.done.href}><Button type="primary">{p.done.label}</Button></Link>}
        />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 960 }}>
          <Card title="1. Download the template">
            {p.intro}
            <a href={p.templateHref}>
              <Button icon={<DownloadOutlined />}>Download template (.xlsx)</Button>
            </a>
          </Card>

          <Card title="2. Upload your file">
            <Upload.Dragger
              accept=".xlsx"
              showUploadList={false}
              disabled={busy}
              beforeUpload={(f) => {
                void choose(f);
                return false;
              }}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">{file ? file.name : 'Drop the .xlsx file here or click to choose'}</p>
              <p className="ant-upload-hint">Up to 1,000 rows. Nothing is saved until you confirm.</p>
            </Upload.Dragger>

            {busy && !check && <Typography.Paragraph style={{ marginTop: 16 }}>Checking the file…</Typography.Paragraph>}

            {check?.ok && (
              <Alert
                style={{ marginTop: 16 }}
                type="success"
                showIcon
                message={`All ${check.total} rows look good`}
                action={<Button type="primary" loading={busy} onClick={runImport}>Import {many(check.total)}</Button>}
              />
            )}

            {check && !check.ok && (
              <>
                <Alert
                  style={{ margin: '16px 0' }}
                  type="error"
                  showIcon
                  message={`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} found. Nothing was imported.`}
                  description="Fix these rows in your file and upload it again. All rows are imported together or not at all."
                />
                <DataTable<Row>
                  rows={problems}
                  loading={false}
                  columns={[
                    { title: 'Row', dataIndex: 'row', width: 80 },
                    { title: 'Column', dataIndex: 'field', render: (f?: string) => f ?? '—' },
                    { title: 'Problem', dataIndex: 'message' },
                  ]}
                />
              </>
            )}
          </Card>
        </Space>
      )}
    </>
  );
}
