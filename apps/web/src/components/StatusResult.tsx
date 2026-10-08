'use client';

import { Result, type ResultProps } from 'antd';
import { useEffect } from 'react';

// "You cannot…", "not found" and similar full-page answers. Same as Ant Design's Result, but the title is the page's
// heading (so screen readers and the tab title know where they are), and it names the tab.
export function StatusResult({ title, ...rest }: ResultProps) {
  const text = typeof title === 'string' ? title : '';
  useEffect(() => {
    if (text) document.title = `${text} · BME Assets`;
  }, [text]);
  return <Result {...rest} title={<h1 style={{ margin: 0, font: 'inherit', color: 'inherit' }}>{title}</h1>} />;
}
