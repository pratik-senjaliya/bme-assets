'use client';

import { Button } from 'antd';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { DetailPageSkeleton } from '@/components/Skeletons';
import { StatusResult } from '@/components/StatusResult';
import { useFetch } from '@/lib/api';

// Where a scanned QR label lands: /q/<asset ID>. The sign-in comes first when needed (the app shell sends the person
// to sign in and back here), then the label's asset ID is looked up within the person's department and they go
// straight to that equipment's page, where complaints, PMS and its history are.
export default function ScannedLabelPage() {
  const raw = useParams<{ code: string }>().code;
  const code = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  const router = useRouter();
  const found = useFetch<{ id: string }>(`/assets/by-code/${encodeURIComponent(code)}`, { fresh: true });

  useEffect(() => {
    if (found.data) router.replace(`/assets/${found.data.id}`);
  }, [found.data, router]);

  if (found.error) {
    return (
      <StatusResult
        status="404"
        title="No equipment with this label"
        subTitle={`Nothing matches ${code} that you can see. The label may belong to another department, or the record was removed.`}
        extra={
          <Link href="/assets">
            <Button type="primary">Go to the asset list</Button>
          </Link>
        }
      />
    );
  }
  return <DetailPageSkeleton kpis={0} />;
}
