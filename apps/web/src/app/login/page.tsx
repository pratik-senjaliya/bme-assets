'use client';

import { AuditOutlined, LockOutlined, MailOutlined, ScheduleOutlined, ToolOutlined } from '@ant-design/icons';
import { Alert, App, Button, Form, Input, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { safeNext } from '@/lib/nav';
import { loginSchema } from '@bme/shared';
import { useAuth } from '@/lib/auth';
import { parseForm } from '@/lib/forms';
import { COLORS } from '@/theme';

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [expired, setExpired] = useState(false);
  // The page the person was on (or asked for) before being sent here, read from the address.
  const nextPage = () => safeNext(new URLSearchParams(window.location.search).get('next'));

  useEffect(() => {
    document.title = 'Sign in · BME Assets';
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
    <main className="login-grid">
      <section className="login-hero">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="brand-mark" style={{ width: 40, height: 40, borderRadius: 12, background: '#13A3AD' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12h4l2-5 4 10 2-5h6" />
            </svg>
          </div>
          <div style={{ lineHeight: 1.3 }}>
            <div style={{ fontWeight: 800, fontSize: 17 }}>BME Assets</div>
            <div style={{ color: '#9FC3C7', fontSize: 13 }}>Biomedical engineering department</div>
          </div>
        </div>
        <div style={{ maxWidth: 520 }}>
          <h2 style={{ fontSize: 40, lineHeight: 1.15, fontWeight: 800, letterSpacing: '-0.025em', margin: '0 0 32px', color: '#fff' }}>
            Every device accounted for, from purchase to condemnation.
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 20 }}>
            {[
              { icon: <ScheduleOutlined />, title: 'PMS and calibration, never missed', text: 'Reminders before every due date.' },
              { icon: <ToolOutlined />, title: 'Breakdowns tracked to the minute', text: 'Response time and downtime for every complaint.' },
              { icon: <AuditOutlined />, title: 'HOD approvals and a complete audit trail', text: 'Key changes wait for a decision; every action is recorded.' },
            ].map((f) => (
              <li key={f.title} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                <span aria-hidden style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(255,255,255,0.1)', color: '#9FDCE0', display: 'grid', placeItems: 'center', fontSize: 18, flex: 'none' }}>
                  {f.icon}
                </span>
                <span>
                  <span style={{ display: 'block', fontWeight: 700, fontSize: 15, color: '#fff' }}>{f.title}</span>
                  <span style={{ display: 'block', fontSize: 14, color: '#B5D3D6', marginTop: 2 }}>{f.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <span style={{ color: '#9FC3C7', fontSize: 13 }}>Runs on your hospital&apos;s own server.</span>
      </section>
      <section style={{ display: 'grid', placeItems: 'center', padding: 24, background: '#fff' }}>
        <div style={{ width: 380, maxWidth: '100%' }}>
          <Typography.Title level={1} style={{ marginTop: 0, marginBottom: 6, fontWeight: 800, fontSize: 32, lineHeight: 1.2, letterSpacing: '-0.02em' }}>
            Sign in
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 32, fontSize: 15 }}>
            Use the login given to you by your Biomedical HOD.
          </Typography.Paragraph>
          {expired && <Alert type="info" showIcon style={{ marginBottom: 20 }} message="You were signed out" description="Your session ended, so please sign in again. You will come back to the page you were on." />}
          <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false}>
            <Form.Item label="Email" name="email" rules={[{ required: true, message: 'Enter your email' }]}>
              <Input type="email" autoComplete="username" autoFocus size="large" prefix={<MailOutlined style={{ color: COLORS.faint }} />} placeholder="you@hospital.org" />
            </Form.Item>
            <Form.Item label="Password" name="password" rules={[{ required: true, message: 'Enter your password' }]}>
              <Input.Password autoComplete="current-password" size="large" prefix={<LockOutlined style={{ color: COLORS.faint }} />} placeholder="Your password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={submitting} style={{ marginTop: 8, height: 50, fontWeight: 700 }}>
              Sign in
            </Button>
          </Form>
          <Typography.Paragraph type="secondary" style={{ marginTop: 28, fontSize: 13, textAlign: 'center' }}>
            Forgot your password? Ask your Biomedical HOD to reset it.
          </Typography.Paragraph>
        </div>
      </section>
    </main>
  );
}
