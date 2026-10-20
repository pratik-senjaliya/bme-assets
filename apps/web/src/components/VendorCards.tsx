'use client';

import { Card, Col, Row, Space, Typography } from 'antd';
import type { AssetDetail, VendorContactRow } from '@bme/shared';
import { COLORS } from '@/theme';

// One contact as a short line: name, role, phone and email, the last two as links a phone can call or mail.
export function ContactLine({ c }: { c: Omit<VendorContactRow, 'id'> }) {
  return (
    <span>
      {c.name}
      {c.role && <Typography.Text type="secondary"> ({c.role})</Typography.Text>}
      {c.phone && <> · <a href={`tel:${c.phone}`} style={{ whiteSpace: 'nowrap' }}>{c.phone}</a></>}
      {c.email && <> · <a href={`mailto:${c.email}`}>{c.email}</a></>}
    </span>
  );
}

// Who sold the equipment and who services it, with the people to call, on the asset page. Nothing when neither is set.
export function VendorCards({ a }: { a: AssetDetail }) {
  const cards = [
    { label: 'Supplier', v: a.supplier },
    { label: 'Service vendor', v: a.serviceVendor },
  ].filter((x) => x.v);
  if (!cards.length) return null;
  return (
    <Row gutter={[16, 16]}>
      {cards.map(({ label, v }) => (
        <Col xs={24} md={12} key={label}>
          <Card size="small" title={<span><span style={{ color: COLORS.muted, fontWeight: 500 }}>{label}:</span> {v!.name}</span>}>
            <Space direction="vertical" size={4}>
              {(v!.phone || v!.email) && <ContactLine c={{ name: 'Office', role: null, phone: v!.phone, email: v!.email }} />}
              {v!.contacts.map((c) => <ContactLine key={c.id} c={c} />)}
              {!v!.phone && !v!.email && v!.contacts.length === 0 && <Typography.Text type="secondary">No contacts recorded.</Typography.Text>}
            </Space>
          </Card>
        </Col>
      ))}
    </Row>
  );
}
