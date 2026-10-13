'use client';

import { DownloadOutlined } from '@ant-design/icons';
import { App, Button, Dropdown } from 'antd';
import { useState } from 'react';
import { downloadFile } from '@/lib/download';

// Excel and PDF of what is on screen. `path` is the report URL without the format.
// `compact` (phones): the icon alone, still named Export for screen readers.
export function ExportMenu({ path, name, compact }: { path: string; name: string; compact?: boolean }) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  async function run(format: 'xlsx' | 'pdf') {
    setBusy(true);
    try {
      await downloadFile(`${path}${path.includes('?') ? '&' : '?'}format=${format}`, `${name}.${format}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not export');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dropdown
      trigger={['click']}
      menu={{ items: [{ key: 'xlsx', label: 'Excel (.xlsx)' }, { key: 'pdf', label: 'PDF' }], onClick: ({ key }) => void run(key as 'xlsx' | 'pdf') }}
    >
      <Button icon={<DownloadOutlined />} loading={busy} aria-label={compact ? 'Export' : undefined}>
        {compact ? null : 'Export'}
      </Button>
    </Dropdown>
  );
}
