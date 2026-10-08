'use client';

import { Button } from 'antd';
import Link from 'next/link';
import { StatusResult } from '@/components/StatusResult';

// Any address that does not exist: say so, and give a way back.
export default function NotFound() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <StatusResult
        status="404"
        title="That page does not exist"
        subTitle="The address may be mistyped, or the page may have moved."
        extra={
          <Link href="/">
            <Button type="primary">Go to the dashboard</Button>
          </Link>
        }
      />
    </main>
  );
}
