'use client';

import { InboxOutlined } from '@ant-design/icons';
import { Card, Table, Tabs } from 'antd';
import type { ReportData, ReportSheetData } from '@bme/shared';
import { ChartGrid } from '@/components/charts/LazyCharts';
import { KpiGrid } from '@/components/KpiTile';
import { EmptyState } from '@/components/Skeletons';
import { formatDate, formatDateTime, formatValue } from '@/lib/format';
import { COLORS } from '@/theme';

const NUMERIC = new Set(['int', 'hours', 'money', 'pct', 'years']);

function SheetTable({ sheet }: { sheet: ReportSheetData }) {
  const totals = sheet.totals?.length && sheet.rows.length ? sheet.totals : null;
  return (
    <Table
      size="small"
      rowKey="__row"
      dataSource={sheet.rows.map((r, i) => ({ ...r, __row: i }))}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: <EmptyState compact icon={<InboxOutlined />} title="Nothing in this table for the period." /> }}
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
      <div style={{ color: COLORS.muted, fontSize: 13, background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 12, padding: '10px 14px', justifySelf: 'start' }}>
        <strong style={{ color: COLORS.ink }}>{data.hospital}</strong> · {data.from && data.to ? `${formatDate(data.from)} to ${formatDate(data.to)}` : 'As at today'} · Generated {formatDateTime(data.generatedAt)} by {data.generatedBy}
      </div>
      {data.kpis.length > 0 && <KpiGrid kpis={data.kpis} />}
      {data.charts.length > 0 && <ChartGrid charts={data.charts} />}
      {data.sheets.length > 0 && (
        <Card styles={{ body: { padding: '4px 20px 20px' } }}>
          <Tabs
            items={data.sheets.map((s, i) => ({ key: `sheet-${i}`, label: `${s.name}${s.rows.length ? ` (${s.rows.length.toLocaleString('en-IN')})` : ''}`, children: <SheetTable sheet={s} /> }))}
          />
        </Card>
      )}
      {data.note && <div style={{ color: COLORS.muted, fontSize: 12.5 }}>{data.note}</div>}
    </div>
  );
}
