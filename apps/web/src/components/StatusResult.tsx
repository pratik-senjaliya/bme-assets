'use client';

import { FileSearchOutlined, LockOutlined, WarningOutlined } from '@ant-design/icons';
import { Button, Result, type ResultProps } from 'antd';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useDocumentTitle } from '@/lib/title';

// "You cannot…", "not found" and similar full-page answers. Same as Ant Design's Result, but the title is the page's
// heading (so screen readers and the tab title know where they are), it names the tab, and a refusal or a missing
// page always offers a way back. A plain icon stands in for Ant Design's cartoon pictures, which suit neither the calm
// look nor dark mode.
const ICON: Record<string, ReactNode> = { '403': <LockOutlined />, '404': <FileSearchOutlined />, '500': <WarningOutlined /> };

export function StatusResult({ title, extra, status, ...rest }: ResultProps) {
  const text = typeof title === 'string' ? title : '';
  useDocumentTitle(text ? `${text} · BME Assets` : '');
  const back =
    extra ??
    ((status === '403' || status === '404') && (
      <Link href="/">
        <Button type="primary">Back to the dashboard</Button>
      </Link>
    ));
  const icon = status && ICON[String(status)];
  return (
    <Result
      {...rest}
      status={icon ? undefined : status}
      icon={icon ? <span style={{ color: 'var(--faint)', fontSize: 44 }}>{icon}</span> : rest.icon}
      extra={back || undefined}
      title={<h1 style={{ margin: 0, font: 'inherit', color: 'inherit' }}>{title}</h1>}
    />
  );
}
