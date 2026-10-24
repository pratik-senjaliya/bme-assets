'use client';

import { App, Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const WARN_MS = 2 * 60_000;

// A sign-in lasts 12 hours. Two minutes before it ends this asks whether to carry on, so a long PMS or form is not cut
// off at submit; "Stay signed in" starts a fresh session. Ignored, the session ends and the next page asks to sign in.
export function SessionEndWarning({ endsAt, onExtended, onSignOut }: { endsAt?: string; onExtended: () => Promise<void>; onSignOut: () => void }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const end = endsAt ? new Date(endsAt).getTime() : null;

  useEffect(() => {
    if (!end) return;
    setOpen(false);
    const t = setTimeout(() => setOpen(true), Math.max(0, end - WARN_MS - Date.now()));
    return () => clearTimeout(t);
  }, [end]);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  if (!end) return null;
  const left = Math.max(0, Math.round((end - now) / 1000));
  return (
    <Modal
      open={open}
      title="Your sign-in is about to end"
      okText="Stay signed in"
      cancelText="Sign out"
      confirmLoading={busy}
      closable={false}
      maskClosable={false}
      onCancel={onSignOut}
      onOk={async () => {
        setBusy(true);
        try {
          await api('/auth/refresh', { method: 'POST' });
          await onExtended();
          setOpen(false);
        } catch (e) {
          message.error(e instanceof Error ? e.message : 'Could not keep you signed in');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Typography.Paragraph>
        It ends in <strong className="num">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</strong>. Anything not yet saved is lost when it does.
      </Typography.Paragraph>
    </Modal>
  );
}
