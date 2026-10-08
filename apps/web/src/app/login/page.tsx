'use client';

import { CheckCircleFilled, LockOutlined, MailOutlined, MedicineBoxFilled } from '@ant-design/icons';
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="brand-mark">
            <MedicineBoxFilled style={{ fontSize: 17 }} />
          </div>
          <span style={{ fontWeight: 650, fontSize: 16 }}>BME Assets</span>
        </div>
        <div>
          <h2 style={{ fontSize: 34, lineHeight: 1.15, fontWeight: 650, letterSpacing: '-0.02em', margin: '0 0 16px', color: '#fff' }}>
            Every device accounted for,
            <br />
            from purchase to condemnation.
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12, color: '#A9B7C9' }}>
            {['Preventive maintenance and calibration, never missed', 'Breakdowns tracked with response time and downtime', 'HOD approvals and a complete audit trail'].map((t) => (
              <li key={t} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <CheckCircleFilled style={{ color: '#2DD4BF' }} />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <span style={{ color: '#9AABC0', fontSize: 12 }}>Biomedical engineering department</span>
      </section>
      <section style={{ display: 'grid', placeItems: 'center', padding: 24, background: '#fff' }}>
        <div style={{ width: 380, maxWidth: '100%' }}>
          <Typography.Title level={1} style={{ marginTop: 0, marginBottom: 4, fontWeight: 650, fontSize: 30, lineHeight: 1.25 }}>
            Sign in
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 28 }}>
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
            <Button type="primary" htmlType="submit" size="large" block loading={submitting} style={{ marginTop: 8 }}>
              Sign in
            </Button>
          </Form>
          <Typography.Paragraph type="secondary" style={{ marginTop: 24, fontSize: 13 }}>
            Forgot your password? Ask your Biomedical HOD to reset it.
          </Typography.Paragraph>
        </div>
      </section>
    </main>
  );
}
