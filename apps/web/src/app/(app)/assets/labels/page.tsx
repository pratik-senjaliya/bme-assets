'use client';

import { PrinterOutlined } from '@ant-design/icons';
import { Alert, Button, Segmented } from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import QRCode from 'qrcode';
import { Suspense, useEffect, useState } from 'react';
import type { AssetLabelsResponse } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { RequirePermission } from '@/components/RequirePermission';
import { EmptyState, ListPageSkeleton } from '@/components/Skeletons';
import { useFetch } from '@/lib/api';
import { formatDate } from '@/lib/format';

// The address a label opens: this site's /q/<asset ID>. Printed from the address staff use, so a phone on the same
// network opens it.
const labelUrl = (code: string) => `${window.location.origin}/q/${encodeURIComponent(code)}`;

// A sheet of labels for the equipment asked for (?ids=…) or matching the asset list's filters. Laid out for A4
// sticker sheets of 3 × 7 labels (63.5 × 38.1 mm); on plain paper the faint borders are the cutting lines.
// Two kinds: the QR label that stays on the machine, and (?kind=pms) the PMS sticker put on after each PMS, with
// the date it was done and the date the next one is due.
function LabelSheet() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const pms = params.get('kind') === 'pms';
  const labels = useFetch<AssetLabelsResponse>(`/assets/labels?${params.toString()}`, { fresh: true });
  const [svgs, setSvgs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!labels.data || pms) return;
    let live = true;
    void Promise.all(labels.data.items.map(async (a) => [a.id, await QRCode.toString(labelUrl(a.assetCode), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })] as const)).then(
      (pairs) => live && setSvgs(Object.fromEntries(pairs)),
    );
    return () => {
      live = false;
    };
  }, [labels.data, pms]);

  const d = labels.data;
  const noun = pms ? ['sticker', 'stickers'] : ['label', 'labels'];
  const count = d ? `${d.items.length} ${d.items.length === 1 ? noun[0] : noun[1]}` : undefined;
  const undated = pms && d ? d.items.filter((a) => !a.lastPmsOn).length : 0;
  return (
    <>
      <div className="no-print">
        <PageHeader
          title={pms ? 'PMS stickers' : 'QR labels'}
          subtitle={d ? `${count} · ${d.hospitalName}` : undefined}
          crumbs={['Assets', pms ? 'PMS stickers' : 'QR labels']}
          action={
            <Button type="primary" icon={<PrinterOutlined />} disabled={!d?.items.length} onClick={() => window.print()}>
              Print
            </Button>
          }
        />
        <div style={{ marginBottom: 16 }}>
          <Segmented
            aria-label="What to print"
            value={pms ? 'pms' : 'qr'}
            options={[{ value: 'qr', label: 'QR labels' }, { value: 'pms', label: 'PMS stickers' }]}
            onChange={(v) => {
              const next = new URLSearchParams(params);
              if (v === 'pms') next.set('kind', 'pms');
              else next.delete('kind');
              router.replace(`${pathname}?${next}`);
            }}
          />
        </div>
        {labels.error && <Alert type="error" showIcon message="Could not load the labels" description={labels.error} action={<Button onClick={labels.reload}>Retry</Button>} />}
        {pms && d && d.items.length > 0 && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Stick one on each machine after its PMS, over the old one."
            description="Print at 100% (actual size) on A4 sheets of 21 labels, or on plain paper and cut along the faint lines."
          />
        )}
        {undated > 0 && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={`${undated} of these ${undated === 1 ? 'has' : 'have'} no PMS recorded yet, so the done date is left blank to fill in by hand.`} />
        )}
        {!pms && d && d.items.length > 0 && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Stick a label on each machine. Scanning it with a phone camera opens that machine's page."
            description={`The labels link to ${window.location.origin}, so print them from the address staff use on the hospital network. Print at 100% (actual size) on A4 sheets of 21 labels.`}
          />
        )}
        {d && d.total > d.items.length && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={`Showing the first ${d.items.length} of ${d.total}. Narrow the list's filters to print the rest.`} />
        )}
      </div>
      {labels.loading && !d && <ListPageSkeleton />}
      {d && d.items.length === 0 && <EmptyState title={`No equipment to print ${noun[1]} for`} hint="Go back to the asset list and change the filters." />}
      {d && d.items.length > 0 && (
        <div className="label-scroll">
          <div className="label-sheet" aria-label={`${count} to print`}>
            {pms && d.items.map((a) => (
              <div key={a.id} className="qr-label pms-sticker">
                <div className="qr-label-text">
                  <div className="pms-sticker-title">
                    <span>PMS</span>
                    <span>{d.hospitalName}</span>
                  </div>
                  <div className="qr-label-name">{a.name}</div>
                  <div className="qr-label-id">{a.assetCode}</div>
                  <dl className="pms-sticker-dates">
                    <dt>Done on</dt>
                    <dd>{a.lastPmsOn ? formatDate(a.lastPmsOn) : ''}</dd>
                    <dt>Next due</dt>
                    <dd>{a.nextPmsDue ? formatDate(a.nextPmsDue) : ''}</dd>
                  </dl>
                </div>
              </div>
            ))}
            {!pms && d.items.map((a) => (
              <div key={a.id} className="qr-label" data-url={labelUrl(a.assetCode)}>
                <div className="qr-label-code" role="img" aria-label={`QR code for ${a.assetCode}`} dangerouslySetInnerHTML={{ __html: svgs[a.id] ?? '' }} />
                <div className="qr-label-text">
                  <div className="qr-label-hospital">{d.hospitalName}</div>
                  <div className="qr-label-id">{a.assetCode}</div>
                  <div className="qr-label-name">{a.name}</div>
                  <div className="qr-label-where">
                    {a.departmentName} · {a.locationName}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default function LabelsPage() {
  // useSearchParams needs a Suspense boundary for static rendering.
  return (
    <RequirePermission code="asset.edit" what="print equipment labels">
      <Suspense fallback={null}>
        <LabelSheet />
      </Suspense>
    </RequirePermission>
  );
}
