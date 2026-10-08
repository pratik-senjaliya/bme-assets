'use client';

import '@ant-design/v5-patch-for-react-19';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { App, ConfigProvider } from 'antd';
import { useEffect, type ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { appTheme } from '@/theme';

// Ant Design puts aria-required on the outer <div> of a required Select, which is not a form control, so assistive
// technology (and accessibility checkers) report it as invalid. The real combobox inside still carries the state.
function useCleanSelectAria() {
  useEffect(() => {
    const clean = (root: ParentNode) => root.querySelectorAll('.ant-select[aria-required]').forEach((e) => e.removeAttribute('aria-required'));
    clean(document);
    const watch = new MutationObserver((changes) => changes.forEach((c) => (c.target instanceof Element ? clean(c.target.parentNode ?? c.target) : undefined)));
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-required'] });
    return () => watch.disconnect();
  }, []);
}

export function Providers({ children }: { children: ReactNode }) {
  useCleanSelectAria();
  return (
    <AntdRegistry>
      <ConfigProvider theme={appTheme}>
        <App>
          <AuthProvider>{children}</AuthProvider>
        </App>
      </ConfigProvider>
    </AntdRegistry>
  );
}
