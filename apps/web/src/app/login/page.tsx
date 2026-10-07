'use client';

import { App, Button, Card, Form, Input, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { loginSchema } from '@bme/shared';
import { useAuth } from '@/lib/auth';
import { parseForm } from '@/lib/forms';

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace('/');
  }, [loading, user, router]);

  async function onFinish(values: unknown) {
    const input = parseForm(form, loginSchema, values);
    if (!input) return;
    setSubmitting(true);
    try {
      await login(input);
      router.replace('/');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not sign in');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Card style={{ width: 400, maxWidth: '100%' }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          BME Asset Management
        </Typography.Title>
        <Typography.Paragraph type="secondary">Sign in with the login given by your Biomedical HOD.</Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item label="Email" name="email" rules={[{ required: true, message: 'Enter your email' }]}>
            <Input type="email" autoComplete="username" autoFocus size="large" />
          </Form.Item>
          <Form.Item label="Password" name="password" rules={[{ required: true, message: 'Enter your password' }]}>
            <Input.Password autoComplete="current-password" size="large" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
            Sign in
          </Button>
        </Form>
      </Card>
    </main>
  );
}
