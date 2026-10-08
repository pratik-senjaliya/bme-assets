'use client';

import { SearchOutlined } from '@ant-design/icons';
import { AutoComplete, Input, type InputRef } from 'antd';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { AssetRow, Paged } from '@bme/shared';
import { api } from '@/lib/api';
import { COLORS } from '@/theme';

// Top-bar search: type an asset ID, name, serial or make, pick a result and go straight to the asset.
// Press "/" or Ctrl/⌘+K from anywhere to focus it.
export function GlobalSearch() {
  const router = useRouter();
  const ref = useRef<InputRef>(null);
  const [text, setText] = useState('');
  const [rows, setRows] = useState<AssetRow[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? '') || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setRows([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await api<Paged<AssetRow>>(`/assets?status=all&pageSize=8&search=${encodeURIComponent(q)}`);
        setRows(res.items);
      } catch {
        setRows([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [text]);

  const options = rows.map((a) => ({
    value: a.id,
    label: (
      <div style={{ display: 'flex', flexDirection: 'column', padding: '2px 0' }}>
        <span className="code" style={{ color: COLORS.ink }}>
          {a.assetCode}
        </span>
        <span style={{ color: COLORS.muted, fontSize: 12 }}>
          {a.name} · {a.departmentName}, {a.locationName}
          {a.status !== 'active' && ' · ' + (a.status === 'condemned' ? 'Condemned' : 'Not in use')}
        </span>
      </div>
    ),
  }));

  return (
    <AutoComplete
      style={{ width: 'min(480px, 100%)' }}
      options={options}
      value={text}
      onChange={setText}
      onSelect={(id: string) => {
        setText('');
        setRows([]);
        router.push(`/assets/${id}`);
      }}
      popupMatchSelectWidth={480}
      notFoundContent={text.trim().length < 2 ? null : searching ? 'Searching…' : 'No equipment found'}
    >
      <Input
        ref={ref}
        allowClear
        prefix={<SearchOutlined style={{ color: COLORS.faint }} />}
        suffix={text ? null : <kbd style={{ fontSize: 12, fontFamily: 'inherit', color: COLORS.faint, background: '#fff', border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: '1px 7px' }}>/</kbd>}
        placeholder="Search equipment by ID, name or serial"
        aria-label="Search equipment"
        style={{ background: COLORS.surfaceAlt, borderColor: COLORS.line, height: 44, borderRadius: 12 }}
      />
    </AutoComplete>
  );
}
