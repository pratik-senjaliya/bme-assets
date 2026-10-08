'use client';

import { Button, Result, type ResultProps } from 'antd';
import Link from 'next/link';
import { useDocumentTitle } from '@/lib/title';

// "You cannot…", "not found" and similar full-page answers. Same as Ant Design's Result, but the title is the page's
// heading (so screen readers and the tab title know where they are), it names the tab, and a refusal or a missing
// page always offers a way back.
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
  return <Result {...rest} status={status} extra={back || undefined} title={<h1 style={{ margin: 0, font: 'inherit', color: 'inherit' }}>{title}</h1>} />;
}
