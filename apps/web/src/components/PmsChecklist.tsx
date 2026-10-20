'use client';

import { Card, Input, InputNumber, Radio, Typography } from 'antd';
import type { PmsAnswer, PmsItem } from '@bme/shared';
import { COLORS } from '@/theme';

const rangeText = (i: PmsItem) =>
  i.min != null && i.max != null ? `${i.min}–${i.max}` : i.min != null ? `at least ${i.min}` : i.max != null ? `at most ${i.max}` : '';
export const outOfRange = (i: PmsItem, v: PmsAnswer | undefined) =>
  i.type === 'reading' && typeof v === 'number' && ((i.min != null && v < i.min) || (i.max != null && v > i.max));

// The hospital's PMS checklist to fill in: Pass / Fail checks, readings against their allowed range, text. Used for an
// in-house PMS and, when the engineer wants to, alongside a PMS done by the OEM engineer.
export function PmsChecklist({
  items,
  version,
  answers,
  errors,
  onChange,
}: {
  items: PmsItem[];
  version: number | null | undefined;
  answers: Record<string, PmsAnswer>;
  errors: Record<string, string>;
  onChange: (itemId: string, value: PmsAnswer | undefined) => void;
}) {
  const answered = items.filter((i) => answers[i.id] !== undefined).length;
  return (
    <Card
      title={`Checklist · version ${version ?? ''}`}
      extra={
        <span className="num" style={{ color: answered === items.length ? COLORS.good.fg : COLORS.muted, fontWeight: 700, fontSize: 13 }}>
          {answered} of {items.length} answered
        </span>
      }
    >
      {items.map((item) => {
        const value = answers[item.id];
        const bad = outOfRange(item, value);
        return (
          <div key={item.id} id={`pms-item-${item.id}`} style={{ padding: '14px 0', borderBottom: `1px solid ${COLORS.lineSoft}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ flex: '1 1 320px', fontWeight: 600, color: COLORS.ink }}>
                {item.label}
                {!item.required && <Typography.Text type="secondary"> (optional)</Typography.Text>}
                {item.type === 'reading' && (
                  <div style={{ color: COLORS.muted, fontSize: 12 }}>
                    {rangeText(item) ? `Allowed: ${rangeText(item)}` : ''} {item.unit ?? ''}
                  </div>
                )}
              </div>
              {item.type === 'check' && (
                // Nothing is pre-selected: an unanswered item must look unanswered.
                <Radio.Group
                  aria-label={item.label}
                  optionType="button"
                  buttonStyle="solid"
                  size="large"
                  value={typeof value === 'string' ? value : null}
                  options={[
                    { label: 'Pass', value: 'pass', className: 'pf-pass' },
                    { label: 'Fail', value: 'fail', className: 'pf-fail' },
                  ]}
                  onChange={(e) => onChange(item.id, e.target.value as PmsAnswer)}
                />
              )}
              {item.type === 'reading' && (
                <InputNumber
                  aria-label={item.label}
                  size="large"
                  style={{ width: 180 }}
                  suffix={item.unit}
                  status={bad || errors[item.id] ? 'error' : undefined}
                  value={typeof value === 'number' ? value : null}
                  onChange={(v) => onChange(item.id, v ?? undefined)}
                />
              )}
            </div>
            {item.type === 'text' && (
              <Input.TextArea aria-label={item.label} rows={2} maxLength={1000} style={{ marginTop: 8 }} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(item.id, e.target.value)} />
            )}
            {bad && <div className="field-error">Outside the allowed range ({rangeText(item)} {item.unit}). This will be recorded as a fail.</div>}
            {errors[item.id] && <div className="field-error">{errors[item.id]}</div>}
          </div>
        );
      })}
    </Card>
  );
}
