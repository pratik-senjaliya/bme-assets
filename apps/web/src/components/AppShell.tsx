'use client';

import {
  ApartmentOutlined,
  AuditOutlined,
  BarChartOutlined,
  BarcodeOutlined,
  CalendarOutlined,
  DashboardOutlined,
  DownOutlined,
  HistoryOutlined,
  KeyOutlined,
  LogoutOutlined,
  MedicineBoxFilled,
  MedicineBoxOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SafetyOutlined,
  ScheduleOutlined,
  SettingOutlined,
  TeamOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Layout, Menu, Skeleton, type MenuProps } from 'antd';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { PermissionCode } from '@bme/shared';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { GlobalSearch } from '@/components/GlobalSearch';
import { NotificationBell } from '@/components/NotificationBell';
import { useAuth } from '@/lib/auth';
import { initials, shortName } from '@/lib/format';
import { loginHref } from '@/lib/nav';
import { COLORS } from '@/theme';

type Item = { href: string; label: string; icon: ReactNode; permission?: PermissionCode; anyOf?: PermissionCode[] };
type Group = { title?: string; items: Item[] };

// Menu entries are filtered by the user's permission codes. The API enforces the same codes.
const GROUPS: Group[] = [
  { items: [{ href: '/', label: 'Dashboard', icon: <DashboardOutlined /> }] },
  {
    title: 'Equipment',
    items: [
      { href: '/assets', label: 'Assets', icon: <BarcodeOutlined />, permission: 'asset.view' },
      { href: '/due', label: 'Due & overdue', icon: <CalendarOutlined />, permission: 'pms.perform' },
    ],
  },
  {
    title: 'Service',
    items: [
      { href: '/complaints', label: 'Complaints', icon: <ToolOutlined />, permission: 'complaint.view' },
      { href: '/approvals', label: 'Approvals', icon: <AuditOutlined />, anyOf: ['approval.decide', 'asset.request_change'] },
      { href: '/reports', label: 'Reports', icon: <BarChartOutlined />, permission: 'report.view' },
    ],
  },
  {
    title: 'Admin',
    items: [
      { href: '/admin/users', label: 'Users', icon: <TeamOutlined />, permission: 'user.manage' },
      { href: '/admin/roles', label: 'Roles & permissions', icon: <SafetyOutlined />, permission: 'role.manage' },
      { href: '/admin/departments', label: 'Departments & locations', icon: <ApartmentOutlined />, permission: 'setup.manage' },
      { href: '/admin/equipment-types', label: 'Equipment types', icon: <MedicineBoxOutlined />, permission: 'setup.manage' },
      { href: '/admin/pms-templates', label: 'PMS checklists', icon: <ScheduleOutlined />, permission: 'setup.manage' },
      { href: '/admin/audit', label: 'Audit log', icon: <HistoryOutlined />, permission: 'audit.view' },
      { href: '/admin/settings', label: 'Hospital settings', icon: <SettingOutlined />, permission: 'setup.manage' },
    ],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, loading, logout, can, sessionExpired } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    // Not signed in (or the session ended): go to sign in, and come back to this page afterwards.
    if (!loading && !user) router.replace(loginHref(sessionExpired()));
  }, [loading, user, router, sessionExpired]);

  if (loading || !user) {
    return (
      <div style={{ padding: 48, maxWidth: 960 }}>
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  const allowed = (i: Item) => (!i.permission || can(i.permission)) && (!i.anyOf || i.anyOf.some(can));
  const toItem = (i: Item) => ({ key: i.href, icon: i.icon, label: <Link href={i.href}>{i.label}</Link> });
  const items: MenuProps['items'] = GROUPS.map((g) => ({ ...g, items: g.items.filter(allowed) }))
    .filter((g) => g.items.length)
    .map((g, idx) => (g.title ? { type: 'group' as const, key: `g${idx}`, label: collapsed ? null : g.title, children: g.items.map(toItem) } : g.items.map(toItem)))
    .flat();
  const all = GROUPS.flatMap((g) => g.items);
  const selected = all.filter((i) => (i.href === '/' ? pathname === '/' : pathname.startsWith(i.href))).map((i) => i.href);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider
        className="no-print app-sider"
        collapsible
        trigger={null}
        collapsed={collapsed}
        onCollapse={setCollapsed}
        breakpoint="lg"
        collapsedWidth={68}
        width={248}
        theme="dark"
      >
        <div style={{ height: 60, display: 'flex', alignItems: 'center', gap: 10, padding: collapsed ? '0 18px' : '0 20px' }}>
          <div className="brand-mark">
            <MedicineBoxFilled style={{ fontSize: 17 }} />
          </div>
          {!collapsed && (
            <div style={{ lineHeight: 1.2, whiteSpace: 'nowrap' }}>
              <div style={{ color: '#fff', fontWeight: 650, fontSize: 15 }}>BME Assets</div>
              <div style={{ color: '#9AABC0', fontSize: 11 }}>Biomedical engineering</div>
            </div>
          )}
        </div>
        <Menu theme="dark" mode="inline" items={items} selectedKeys={selected} style={{ borderInlineEnd: 0, padding: '8px 12px' }} />
      </Layout.Sider>
      <Layout style={{ minWidth: 0 }}>
        <Layout.Header className="no-print app-header" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button
            type="text"
            aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed((c) => !c)}
            style={{ color: COLORS.muted }}
          />
          <div style={{ flex: 1, display: 'flex' }}>{can('asset.view') && <GlobalSearch />}</div>
          {can('notification.view') && <NotificationBell />}
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            menu={{
              items: [
                { key: 'role', label: `${user.roleLabel}`, disabled: true },
                { key: 'password', icon: <KeyOutlined />, label: 'Change password' },
                { type: 'divider' },
                { key: 'logout', icon: <LogoutOutlined />, label: 'Sign out' },
              ],
              onClick: async ({ key }) => {
                if (key === 'password') setChangingPassword(true);
                if (key === 'logout') {
                  await logout();
                  router.replace('/login');
                }
              },
            }}
          >
            <button
              type="button"
              data-testid="account-menu"
              style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 0, cursor: 'pointer', minHeight: 44, padding: '0 4px', font: 'inherit', lineHeight: 1 }}
            >
              <span
                aria-hidden
                style={{ width: 34, height: 34, borderRadius: '50%', background: COLORS.primarySoft, color: COLORS.primary, display: 'grid', placeItems: 'center', fontWeight: 650, fontSize: 13, flex: 'none' }}
              >
                {initials(user.name)}
              </span>
              <span style={{ textAlign: 'left', lineHeight: 1.25 }} className="user-label">
                <span style={{ display: 'block', fontWeight: 600, color: COLORS.ink, fontSize: 13 }}>{shortName(user.name)}</span>
                <span style={{ display: 'block', color: COLORS.muted, fontSize: 12 }}>{user.roleLabel}</span>
              </span>
              <DownOutlined style={{ fontSize: 10, color: COLORS.faint }} />
            </button>
          </Dropdown>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          <div style={{ maxWidth: 1440, margin: '0 auto' }}>{children}</div>
        </Layout.Content>
        <ChangePasswordModal open={changingPassword} onClose={() => setChangingPassword(false)} />
      </Layout>
    </Layout>
  );
}
