'use client';

import { Button } from 'antd';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { PermissionCode } from '@bme/shared';
import { useAuth } from '@/lib/auth';
import { StatusResult } from '@/components/StatusResult';

// A screen for people who have the permission; everyone else gets a plain answer and no failed requests. The same
// permission codes decide the sidebar and are checked again by the server.
export function RequirePermission({ code, what, children }: { code: PermissionCode; what: string; children: ReactNode }) {
  const { can } = useAuth();
  if (can(code)) return <>{children}</>;
  return (
    <StatusResult
      status="403"
      title={`You cannot ${what}`}
      subTitle="This is for the Biomedical HOD. Ask them if you need it."
      extra={
        <Link href="/">
          <Button type="primary">Back to the dashboard</Button>
        </Link>
      }
    />
  );
}
