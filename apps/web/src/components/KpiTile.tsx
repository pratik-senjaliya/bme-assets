import { Card } from 'antd';
import type { Kpi } from '@bme/shared';
import { formatValue } from '@/lib/format';
import { COLORS } from '@/theme';

// One headline figure: a label, the number, and a hint in words (coloured only to say how worried to be).
export function KpiTile({ k }: { k: Kpi }) {
  const hint = k.tone === 'bad' ? COLORS.bad.fg : k.tone === 'warn' ? COLORS.warn.fg : k.tone === 'good' ? COLORS.good.fg : COLORS.muted;
  return (
    <Card styles={{ body: { padding: 16 } }} style={{ height: '100%' }}>
      <div style={{ color: COLORS.muted, fontWeight: 500, fontSize: 13 }}>{k.label}</div>
      <div style={{ fontSize: 26, fontWeight: 650, lineHeight: 1.25, margin: '6px 0 2px', color: COLORS.ink, letterSpacing: '-0.01em' }} className="num">
        {formatValue(k.value, k.fmt)}
      </div>
      {k.hint && <div style={{ color: hint, fontSize: 12.5 }}>{k.hint}</div>}
    </Card>
  );
}

// Tiles in even rows: up to five across, otherwise rows of three or four (never one tile alone on a line).
export function KpiGrid({ kpis }: { kpis: Kpi[] }) {
  const cols = kpis.length <= 5 ? kpis.length : kpis.length % 3 === 0 ? 3 : 4;
  return (
    <div className="kpi-grid" style={{ ['--cols' as string]: cols }}>
      {kpis.map((k) => (
        <KpiTile key={k.label} k={k} />
      ))}
    </div>
  );
}
