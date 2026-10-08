'use client';

import { Button } from 'antd';
import { useEffect } from 'react';
import { StatusResult } from '@/components/StatusResult';

// Something broke while drawing a page. Say so in plain words and let the person try again; the details go to the
// browser console for whoever supports the install.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <StatusResult
        status="error"
        title="Something went wrong on this page"
        subTitle="Nothing has been lost. Try again, and if it keeps happening tell your Biomedical HOD."
        extra={
          <Button type="primary" onClick={reset}>
            Try again
          </Button>
        }
      />
    </main>
  );
}
