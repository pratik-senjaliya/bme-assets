'use client';

import { App, Alert, Button, Card, Checkbox, Select, Skeleton, Space } from 'antd';
import { useEffect, useState } from 'react';
import { PERMISSIONS, type PermissionCode, type RoleRow } from '@bme/shared';
import { PageHeader } from '@/components/PageHeader';
import { api, useFetch } from '@/lib/api';

// Grouped by area so the list is scannable.
const GROUPS: Record<string, string> = {
  asset: 'Assets',
  complaint: 'Complaints',
  expense: 'Expenses',
  pms: 'PMS',
  calibration: 'Calibration',
  approval: 'Approvals',
  user: 'Users',
  role: 'Roles',
  setup: 'Setup',
  settings: 'Settings',
  audit: 'Audit',
  report: 'Reports',
};

export default function RolesPage() {
  const { message } = App.useApp();
  const roles = useFetch<RoleRow[]>('/roles');
  const [roleId, setRoleId] = useState<string>();
  const [selected, setSelected] = useState<PermissionCode[]>([]);
  const [saving, setSaving] = useState(false);

  const role = roles.data?.find((r) => r.id === roleId);
  const locked = role?.name === 'super_admin';

  useEffect(() => {
    if (!roleId && roles.data?.length) setRoleId(roles.data.find((r) => r.name === 'biomed')?.id ?? roles.data[0].id);
  }, [roles.data, roleId]);
  useEffect(() => {
    if (role) setSelected(role.permissions);
  }, [role]);

  async function save() {
    if (!role) return;
    setSaving(true);
    try {
      await api(`/roles/${role.id}/permissions`, { method: 'PUT', body: { permissions: selected } });
      message.success(`${role.label} permissions saved`);
      roles.reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        subtitle="What each role can do in this hospital"
        crumbs={['Admin', 'Roles & permissions']}
        action={
          <Button type="primary" onClick={save} loading={saving} disabled={!role || locked}>
            Save changes
          </Button>
        }
      />
      {roles.error && <Alert type="error" showIcon message="Could not load roles" description={roles.error} />}
      {roles.loading && !roles.data && <Skeleton active />}
      {role && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Select
            aria-label="Role"
            style={{ width: 280 }}
            value={roleId}
            onChange={setRoleId}
            options={roles.data!.map((r) => ({ value: r.id, label: r.label }))}
          />
          {locked && <Alert type="info" showIcon message="Super admin permissions are fixed and cannot be changed." />}
          <Checkbox.Group value={selected} onChange={(v) => setSelected(v as PermissionCode[])} disabled={locked} style={{ width: '100%' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
              {Object.entries(GROUPS).map(([prefix, label]) => (
                <Card key={prefix} size="small" title={label}>
                  <Space direction="vertical">
                    {PERMISSIONS.filter((p) => p.startsWith(`${prefix}.`)).map((p) => (
                      <Checkbox key={p} value={p}>
                        {p}
                      </Checkbox>
                    ))}
                  </Space>
                </Card>
              ))}
            </div>
          </Checkbox.Group>
        </Space>
      )}
    </>
  );
}
