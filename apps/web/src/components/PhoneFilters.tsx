'use client';

import { FilterOutlined } from '@ant-design/icons';
import { Button, Grid } from 'antd';
import { useState, type ReactNode } from 'react';

// List filters. On a wide screen they sit in the toolbar as they are. On a phone they hide behind one "Filters"
// button that says how many are in use, so the list itself is on the first screen; opened, they stack full width.
export function PhoneFilters({ active, children }: { active: number; children: ReactNode }) {
  const phone = Grid.useBreakpoint().md === false;
  const [open, setOpen] = useState(false);
  if (!phone) return <>{children}</>;
  return (
    <>
      <Button icon={<FilterOutlined />} aria-expanded={open} onClick={() => setOpen((o) => !o)} type={active ? 'primary' : 'default'} ghost={!!active}>
        {active ? `Filters · ${active}` : 'Filters'}
      </Button>
      {open && <div className="phone-filters">{children}</div>}
    </>
  );
}
