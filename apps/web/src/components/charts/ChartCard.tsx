'use client';

import { Card, Segmented, Table } from 'antd';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ChartSpec } from '@bme/shared';
import { AXIS, GRID, SERIES, SURFACE } from '@/components/charts/palette';
import { formatAxis, formatValue } from '@/lib/format';
import { COLORS } from '@/theme';

type TipProps = { active?: boolean; payload?: ReadonlyArray<{ name?: string | number; value?: unknown; color?: string }>; label?: string | number };

// One chart from a ChartSpec. Marks are thin (bars are capped at 24px, rounded at the data end), grid lines are
// hairlines, text wears text colours (never the series colour), two or more series always get a legend, and every
// chart has a Table view so nothing depends on colour or hover.
export function ChartCard({ spec }: { spec: ChartSpec }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const multi = spec.series.length > 1;
  const empty = spec.data.length === 0 || spec.data.every((d) => spec.series.every((s) => !Number(d[s.key])));
  const colour = (i: number) => SERIES[i % SERIES.length];
  const horizontal = spec.kind === 'bar';
  const height = horizontal ? Math.max(130, spec.data.length * 30 + 20) : 230;
  const longest = Math.max(...spec.data.map((d) => d.label.length), 6);
  const labelWidth = Math.min(232, Math.round(Math.min(longest, 36) * 6.3) + 12);
  const short = (s: string) => (s.length > 36 ? `${s.slice(0, 35)}…` : s);
  // One line per label, cut with an ellipsis (the full name is in the tooltip and the Table view).
  const RowLabel = ({ x = 0, y = 0, payload }: { x?: number; y?: number; payload?: { value: string } }) => (
    <text x={x - 6} y={y} dy={4} textAnchor="end" fill={AXIS} fontSize={12}>
      {short(payload?.value ?? '')}
    </text>
  );

  const Tip = ({ active, payload, label }: TipProps) =>
    active && payload?.length ? (
      <div style={{ background: SURFACE, border: `1px solid ${GRID}`, borderRadius: 8, padding: '8px 12px', boxShadow: '0 4px 14px rgba(15,23,42,0.12)', fontSize: 13 }}>
        <div style={{ fontWeight: 600, color: COLORS.ink, marginBottom: 4 }}>{label}</div>
        {payload.map((p) => (
          <div key={String(p.name)} style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.text }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
            {multi && <span style={{ color: COLORS.muted }}>{p.name}</span>}
            <span style={{ marginLeft: 'auto', fontWeight: 600 }} className="num">
              {formatValue(p.value, spec.fmt)}
            </span>
          </div>
        ))}
      </div>
    ) : null;

  const axis = { tick: { fill: AXIS, fontSize: 12 }, axisLine: false, tickLine: false } as const;
  const chart = (() => {
    if (spec.kind === 'line') {
      return (
        <LineChart data={spec.data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" {...axis} />
          <YAxis {...axis} width={44} tickFormatter={(v: number) => formatAxis(v, spec.fmt)} />
          <Tooltip content={<Tip />} cursor={{ stroke: GRID }} />
          {spec.series.map((s, i) => (
            <Line key={s.key} dataKey={s.key} name={s.label} stroke={colour(i)} strokeWidth={2} dot={{ r: 4, stroke: SURFACE, strokeWidth: 2, fill: colour(i) }} activeDot={{ r: 6, stroke: SURFACE, strokeWidth: 2 }} />
          ))}
        </LineChart>
      );
    }
    if (horizontal) {
      return (
        <BarChart data={spec.data} layout="vertical" margin={{ top: 0, right: 64, bottom: 0, left: 0 }} barCategoryGap={8}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" width={labelWidth} axisLine={false} tickLine={false} tick={<RowLabel />} interval={0} />
          <Tooltip content={<Tip />} cursor={{ fill: '#F1F5F9' }} />
          {spec.series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={colour(i)} maxBarSize={20} radius={[0, 4, 4, 0]}>
              <LabelList dataKey={s.key} position="right" formatter={(v: unknown) => formatValue(v, spec.fmt)} style={{ fill: COLORS.text, fontSize: 12 }} />
            </Bar>
          ))}
        </BarChart>
      );
    }
    const stacked = spec.kind === 'stacked';
    return (
      <BarChart data={spec.data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="label" {...axis} interval={spec.data.length > 8 ? 'preserveStartEnd' : 0} />
        <YAxis {...axis} width={44} allowDecimals={false} tickFormatter={(v: number) => formatAxis(v, spec.fmt)} />
        <Tooltip content={<Tip />} cursor={{ fill: '#F1F5F9' }} />
        {spec.series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={colour(i)}
            maxBarSize={24}
            stackId={stacked ? 'stack' : undefined}
            stroke={stacked ? SURFACE : undefined}
            strokeWidth={stacked ? 2 : 0}
            radius={stacked ? (i === spec.series.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]}
          />
        ))}
      </BarChart>
    );
  })();

  return (
    <Card
      title={
        <div>
          <div style={{ fontSize: 15 }}>{spec.title}</div>
          {spec.subtitle && <div style={{ color: COLORS.muted, fontSize: 12.5, fontWeight: 400 }}>{spec.subtitle}</div>}
        </div>
      }
      extra={!empty && <Segmented size="small" aria-label={`${spec.title} view`} value={view} onChange={(v) => setView(v as 'chart' | 'table')} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />}
      styles={{ header: { minHeight: 56 }, body: { padding: '12px 16px 16px' } }}
      style={{ height: '100%' }}
    >
      {empty ? (
        <div style={{ color: COLORS.muted, textAlign: 'center', padding: '48px 0' }}>Nothing to show for this period.</div>
      ) : view === 'table' ? (
        <Table
          size="small"
          pagination={false}
          rowKey="label"
          dataSource={spec.data}
          scroll={{ y: 260 }}
          columns={[
            { title: horizontal ? 'Item' : 'Period', dataIndex: 'label' },
            ...spec.series.map((s) => ({ title: s.label, dataIndex: s.key, align: 'right' as const, render: (v: unknown) => formatValue(v, spec.fmt) })),
          ]}
        />
      ) : (
        <>
          {multi && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }} aria-label="Legend">
              {spec.series.map((s, i) => (
                <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: COLORS.text, fontSize: 12.5 }}>
                  <span aria-hidden style={{ width: 10, height: 10, borderRadius: 2, background: colour(i) }} />
                  {s.label}
                </span>
              ))}
            </div>
          )}
          <div role="img" aria-label={`${spec.title}. Use the Table view for the numbers.`} style={{ width: '100%', height }}>
            <ResponsiveContainer width="100%" height="100%">
              {chart}
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Card>
  );
}

// Charts in a responsive grid.
export function ChartGrid({ charts }: { charts: ChartSpec[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 16 }}>
      {charts.map((c) => (
        <ChartCard key={c.id} spec={c} />
      ))}
    </div>
  );
}
