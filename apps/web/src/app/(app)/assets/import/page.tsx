'use client';

import { Typography } from 'antd';
import { ImportWizard } from '@/components/ImportWizard';

export default function ImportPage() {
  return (
    <ImportWizard
      permission="asset.create"
      forbidden="You cannot import assets"
      title="Import assets from Excel"
      subtitle="Add many assets at once"
      crumbs={['Assets', 'Import']}
      templateHref="/api/v1/import/template"
      postPath="/import/assets"
      noun={['asset', 'assets']}
      done={{ subTitle: 'Each one has its own generated asset ID.', href: '/assets', label: 'View assets' }}
      intro={
        <>
          <Typography.Paragraph type="secondary">
            Fill one row per asset. Equipment type, department and location are picked by code; the Lists sheet shows the valid codes. Leave the asset ID out, it is generated.
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            Loading equipment that is already in use? Fill <strong>Last PMS done</strong> and <strong>Last calibration done</strong> (for example 15/03/2026), so the first due dates count from then and not from the installation date. Leave them blank for new equipment.
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            Optional columns bring the rest of what the old register held: the hospital&apos;s own <strong>Tag no</strong>, <strong>Status</strong> (Active or Not in use), a <strong>Calibration interval</strong> different from the equipment type&apos;s, the <strong>purchase order</strong> (number, date and cost; the vendor is the Supplier) and one <strong>warranty or AMC / CMC contract</strong>.
          </Typography.Paragraph>
        </>
      }
    />
  );
}
