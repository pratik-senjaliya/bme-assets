'use client';

import { DownloadOutlined } from '@ant-design/icons';
import { App, Button, Card, Dropdown, Table, Tabs } from 'antd';
import { useState } from 'react';
import type { ReportData, ReportSheetData } from '@bme/shared';
import { ChartGrid } from '@/components/charts/ChartCard';
import { KpiGrid } from '@/components/KpiTile';
import { downloadFile } from '@/lib/download';
import { formatDate, formatDateTime, formatValue } from '@/lib/format';
import { COLORS } from '@/theme';

const NUMERIC = new Set(['int', 'hours', 'money', 'pct', 'years']);

// Excel and PDF of what is on screen. `path` is the report URL without the format.
export function ExportMenu({ path, name }: { path: string; name: string }) {
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
      <Button icon={<DownloadOutlined />} loading={busy}>
        Export
      </Button>
    </Dropdown>
  );
}

function SheetTable({ sheet }: { sheet: ReportSheetData }) {
  const totals = sheet.totals?.length && sheet.rows.length ? sheet.totals : null;
  return (
    <Table
      size="small"
      rowKey="__row"
      dataSource={sheet.rows.map((r, i) => ({ ...r, __row: i }))}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: 'Nothing in this table for the period.' }}
      pagination={{ pageSize: 25, showSizeChanger: false, hideOnSinglePage: true, showTotal: (t) => `${t.toLocaleString('en-IN')} rows` }}
      columns={sheet.columns.map((c) => ({
        title: c.header,
        dataIndex: c.key,
        align: c.fmt && NUMERIC.has(c.fmt) ? ('right' as const) : ('left' as const),
        render: (v: unknown) => (c.fmt === 'date' || c.fmt === 'text' || !c.fmt ? (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(v) : (v ?? '—')) : formatValue(v, c.fmt)) as string,
      }))}
      summary={
        totals
          ? () => (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  {sheet.columns.map((c, i) => (
                    <Table.Summary.Cell key={c.key} index={i} align={c.fmt && NUMERIC.has(c.fmt) ? 'right' : 'left'}>
                      <strong>{i === 0 ? 'Total' : totals.includes(c.key) ? formatValue(sheet.rows.reduce((t, r) => t + (Number(r[c.key]) || 0), 0), c.fmt) : ''}</strong>
                    </Table.Summary.Cell>
                  ))}
                </Table.Summary.Row>
              </Table.Summary>
            )
          : undefined
      }
    />
  );
}

// A report on screen: headline figures, charts, then the tables (one tab each). The same data becomes Excel and PDF.
export function ReportView({ data }: { data: ReportData }) {
  return (
    <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div style={{ color: COLORS.muted, fontSize: 13 }}>
        {data.hospital} · {data.from && data.to ? `${formatDate(data.from)} to ${formatDate(data.to)}` : 'As at today'} · Generated {formatDateTime(data.generatedAt)} by {data.generatedBy}
      </div>
      {data.kpis.length > 0 && <KpiGrid kpis={data.kpis} />}
      {data.charts.length > 0 && <ChartGrid charts={data.charts} />}
      {data.sheets.length > 0 && (
        <Card styles={{ body: { padding: '0 16px 16px' } }}>
          <Tabs
            items={data.sheets.map((s) => ({ key: s.name, label: `${s.name}${s.rows.length ? ` (${s.rows.length.toLocaleString('en-IN')})` : ''}`, children: <SheetTable sheet={s} /> }))}
          />
        </Card>
      )}
      {data.note && <div style={{ color: COLORS.muted, fontSize: 12.5 }}>{data.note}</div>}
    </div>
  );
}
