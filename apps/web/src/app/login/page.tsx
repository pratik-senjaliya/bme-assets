'use client';

import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { Alert, App, Button, Form, Input, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { safeNext } from '@/lib/nav';
import { loginSchema } from '@bme/shared';
import { useAuth } from '@/lib/auth';
import { parseForm } from '@/lib/forms';
import { useDocumentTitle } from '@/lib/title';
import { COLORS } from '@/theme';

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [expired, setExpired] = useState(false);
  // Five wrong passwords lock a login, and Caps Lock is the usual cause: say when it is on.
  const [caps, setCaps] = useState(false);
  // The page the person was on (or asked for) before being sent here, read from the address.
  const nextPage = () => safeNext(new URLSearchParams(window.location.search).get('next'));

  useDocumentTitle('Sign in · BME Assets');
  useEffect(() => {
    setExpired(new URLSearchParams(window.location.search).get('expired') === '1');
  }, []);
  useEffect(() => {
    if (!loading && user) router.replace(nextPage());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user, router]);

  async function onFinish(values: unknown) {
    const input = parseForm(form, loginSchema, values);
    if (!input) return;
    setSubmitting(true);
    try {
      await login(input);
      router.replace(nextPage());
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not sign in');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <div className="brand-mark">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12h4l2-5 4 10 2-5h6" />
            </svg>
          </div>
          <div style={{ lineHeight: 1.25 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: COLORS.ink }}>BME Assets</div>
            <div style={{ color: COLORS.muted, fontSize: 12.5 }}>Biomedical engineering</div>
          </div>
        </div>
        <Typography.Title level={1} style={{ marginTop: 0, marginBottom: 4, fontWeight: 700, fontSize: 24, lineHeight: 1.3 }}>
          Sign in
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
          Use the login given to you by your Biomedical HOD.
        </Typography.Paragraph>
          {expired && <Alert type="info" showIcon style={{ marginBottom: 20 }} message="You were signed out" description="Your session ended, so please sign in again. You will come back to the page you were on." />}
          <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false}>
            <Form.Item label="Email" name="email" rules={[{ required: true, message: 'Enter your email' }]}>
              <Input type="email" autoComplete="username" autoFocus size="large" prefix={<MailOutlined style={{ color: COLORS.faint }} />} placeholder="you@hospital.org" />
            </Form.Item>
            <Form.Item
              label="Password"
              name="password"
              rules={[{ required: true, message: 'Enter your password' }]}
              extra={caps && <span style={{ color: COLORS.warn.fg, fontWeight: 600 }}>Caps Lock is on</span>}
            >
              <Input.Password
                autoComplete="current-password"
                size="large"
                prefix={<LockOutlined style={{ color: COLORS.faint }} />}
                placeholder="Your password"
                onKeyUp={(e) => setCaps(e.getModifierState('CapsLock'))}
                onKeyDown={(e) => setCaps(e.getModifierState('CapsLock'))}
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={submitting} style={{ marginTop: 4 }}>
              Sign in
            </Button>
          </Form>
          <Typography.Paragraph type="secondary" style={{ margin: '20px 0 0', fontSize: 13 }}>
            Forgot your password? Ask your Biomedical HOD to reset it.
          </Typography.Paragraph>
      </div>
      <div style={{ color: COLORS.muted, fontSize: 12.5 }}>For hospital staff only. Every sign-in is recorded.</div>
    </main>
  );
}
