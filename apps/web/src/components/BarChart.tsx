'use client';

import { Segmented, Table, Typography } from 'antd';
import { useEffect, useId, useRef, useState } from 'react';

export type BarDatum = { label: string; value: number; extra?: Record<string, string | number> };

// One-series column chart. Marks follow the chart rules: columns at most 24px wide with a 4px rounded top and a
// square base on one baseline, hairline solid grid, one axis, the latest value labelled, the rest in the tooltip
// and the table view. A single series needs no legend: the title says what is plotted.
const H = 240;
const M = { top: 20, right: 8, bottom: 28, left: 34 };
const ACCENT = '#0E7490';

const niceMax = (max: number) => {
  if (max <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(max / 4));
  const m = max / 4 / step;
  return Math.ceil(m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * step * 4;
};

const roundedColumn = (x: number, y: number, w: number, base: number) => {
  const r = Math.min(4, base - y);
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${base} Z`;
};

export function BarChart({ title, unit, data, tableColumns }: { title: string; unit: string; data: BarDatum[]; tableColumns?: { key: string; title: string }[] }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(600); // drawn at the real width, so text stays the size it is set at
  const [active, setActive] = useState<number | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setW(Math.max(320, Math.floor(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const top = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const band = innerW / data.length;
  const barW = Math.min(24, band * 0.5);
  const y = (v: number) => M.top + innerH - (v / top) * innerH;
  const ticks = [0, 1, 2, 3, 4].map((i) => (top / 4) * i);
  const last = data.length - 1;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <Typography.Text strong id={id}>
          {title}
        </Typography.Text>
        <Segmented size="small" value={view} onChange={(v) => setView(v as 'chart' | 'table')} options={[{ label: 'Chart', value: 'chart' }, { label: 'Table', value: 'table' }]} aria-label="Chart or table view" />
      </div>

      {view === 'table' ? (
        <Table
          size="small"
          pagination={false}
          rowKey="label"
          dataSource={data}
          columns={[
            { title: 'Month', dataIndex: 'label' },
            { title: unit, dataIndex: 'value', align: 'right' as const },
            ...(tableColumns ?? []).map((c) => ({ title: c.title, key: c.key, align: 'right' as const, render: (_: unknown, d: BarDatum) => d.extra?.[c.key] })),
          ]}
        />
      ) : (
        <div ref={box} style={{ position: 'relative' }}>
          <svg width={W} height={H} role="img" aria-labelledby={id} style={{ display: 'block', maxWidth: '100%' }}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke="#E5E7EB" strokeWidth={1} />
                <text x={M.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="#6B7280">
                  {Number.isInteger(t) ? t.toLocaleString('en-IN') : t.toFixed(1)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = M.left + band * i + band / 2;
              const x = cx - barW / 2;
              return (
                <g key={d.label}>
                  {active === i && <rect x={M.left + band * i} y={M.top} width={band} height={innerH} fill={ACCENT} opacity={0.06} />}
                  {d.value > 0 && <path d={roundedColumn(x, y(d.value), barW, y(0))} fill={ACCENT} opacity={active === null || active === i ? 1 : 0.55} />}
                  {i === last && d.value > 0 && (
                    <text x={cx} y={y(d.value) - 6} textAnchor="middle" fontSize={12} fontWeight={600} fill="#111827">
                      {d.value}
                    </text>
                  )}
                  <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="#6B7280">
                    {d.label.split(' ')[0]}
                  </text>
                  {/* The hit area is the whole column band, much larger than the painted bar. */}
                  <rect
                    x={M.left + band * i}
                    y={M.top}
                    width={band}
                    height={innerH + M.bottom}
                    fill="transparent"
                    tabIndex={0}
                    style={{ outline: 'none' }} // the highlighted column shows focus, not a ring around a hit area
                    role="img"
                    aria-label={`${d.label}: ${d.value} ${unit.toLowerCase()}`}
                    onPointerEnter={() => setActive(i)}
                    onPointerLeave={() => setActive(null)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                  />
                </g>
              );
            })}
          </svg>
          {active !== null && (
            <div
              role="status"
              style={{
                position: 'absolute',
                left: Math.min(Math.max(M.left + band * active + band / 2, 70), W - 70),
                top: 0,
                transform: 'translate(-50%, 0)',
                background: '#fff',
                border: '1px solid #E5E7EB',
                borderRadius: 8,
                padding: '6px 10px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
                fontSize: 12,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
                {data[active].value} <span style={{ fontWeight: 400, color: '#6B7280' }}>{unit.toLowerCase()}</span>
              </div>
              <div style={{ color: '#6B7280' }}>{data[active].label}</div>
              {Object.entries(data[active].extra ?? {}).map(([k, v]) => (
                <div key={k} style={{ color: '#6B7280' }}>
                  {tableColumns?.find((c) => c.key === k)?.title ?? k}: {v}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
