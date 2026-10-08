'use client';

import { BellOutlined } from '@ant-design/icons';
import { Badge, Button, Empty, List, Popover, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { NotificationList, NotificationRow } from '@bme/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';

const TAB: Record<Exclude<NotificationRow['type'], 'approval'>, string> = { pms: 'pms', calibration: 'calibration', warranty: 'purchase', contract: 'purchase' };

// In-app reminders (PMS, calibration, warranty, contracts). Checked every minute while the app is open.
export function NotificationBell() {
  const router = useRouter();
  const [data, setData] = useState<NotificationList>({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<NotificationList>('/notifications'));
    } catch {
      // The bell is a convenience: if it cannot load, stay quiet.
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function go(n: NotificationRow) {
    setOpen(false);
    if (!n.readAt) await api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => undefined);
    void load();
    if (n.type === 'approval') router.push('/approvals');
    else if (n.assetId) router.push(`/assets/${n.assetId}?tab=${TAB[n.type]}`);
  }

  async function readAll() {
    await api('/notifications/read-all', { method: 'POST' }).catch(() => undefined);
    void load();
  }

  const content = (
    <div style={{ width: 380, maxWidth: '80vw' }}>
      {data.items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No reminders" />
      ) : (
        <List
          size="small"
          dataSource={data.items}
          style={{ maxHeight: 420, overflowY: 'auto' }}
          renderItem={(n) => (
            <List.Item style={{ cursor: 'pointer', paddingInline: 8 }} onClick={() => void go(n)}>
              <div>
                <Typography.Text strong={!n.readAt}>{n.message}</Typography.Text>
                <div style={{ color: '#526173', fontSize: 12 }}>{formatDate(n.createdAt)}</div>
              </div>
            </List.Item>
          )}
        />
      )}
      {data.unread > 0 && (
        <div style={{ textAlign: 'right', marginTop: 8 }}>
          <Button size="small" type="link" onClick={() => void readAll()}>
            Mark all as read
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      title="Reminders"
      content={content}
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) void load();
      }}
    >
      <Button type="text" aria-label={`Reminders, ${data.unread} unread`} style={{ minHeight: 40, minWidth: 40 }}>
        <Badge count={data.unread} size="small" overflowCount={99}>
          <BellOutlined style={{ fontSize: 18 }} />
        </Badge>
      </Button>
    </Popover>
  );
}
