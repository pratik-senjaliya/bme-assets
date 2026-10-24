'use client';

import { Select } from 'antd';
import type { TradeRow } from '@bme/shared';
import { useFetch } from '@/lib/api';

// Narrow complaints to one trade's ward faults (Electrical, Plumbing…) or to complaints about a machine ('none').
// Shown only where there are trades (the facility add-on); `register` limits the trades to one team's.
export function TradeFilter({ value, onChange, register }: { value?: string; onChange: (v: string | undefined) => void; register?: string }) {
  const trades = useFetch<TradeRow[]>('/trades');
  const mine = (trades.data ?? []).filter((t) => t.active && (!register || t.register === register));
  if (!mine.length) return null;
  return (
    <Select
      allowClear
      placeholder="Machine or trade"
      aria-label="Machine or trade"
      style={{ minWidth: 200 }}
      value={value}
      onChange={onChange}
      options={[{ value: 'none', label: 'Machines' }, ...mine.map((t) => ({ value: t.id, label: t.name }))]}
    />
  );
}
