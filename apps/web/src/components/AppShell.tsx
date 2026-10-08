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
  MedicineBoxOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SafetyOutlined,
  ScheduleOutlined,
  SettingOutlined,
  TeamOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Grid, Layout, Menu, type MenuProps } from 'antd';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { PermissionCode } from '@bme/shared';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { GlobalSearch } from '@/components/GlobalSearch';
import { NotificationBell } from '@/components/NotificationBell';
import { ShellSkeleton } from '@/components/Skeletons';
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
  // Phones: the menu hides completely and slides over the page when opened (see .app-sider in globals.css).
  const phone = Grid.useBreakpoint().md === false;
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    // Not signed in (or the session ended): go to sign in, and come back to this page afterwards.
    if (!loading && !user) router.replace(loginHref(sessionExpired()));
  }, [loading, user, router, sessionExpired]);

  if (loading || !user) return <ShellSkeleton />;

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
        collapsedWidth={phone ? 0 : 76}
        width={256}
        theme="light"
      >
        <div style={{ height: 68, display: 'flex', alignItems: 'center', gap: 12, padding: collapsed ? '0 20px' : '0 22px', flex: 'none' }}>
          <div className="brand-mark">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12h4l2-5 4 10 2-5h6" />
            </svg>
          </div>
          {!collapsed && (
            <div style={{ lineHeight: 1.25, whiteSpace: 'nowrap' }}>
              <div style={{ color: COLORS.ink, fontWeight: 800, fontSize: 15.5, letterSpacing: '-0.01em' }}>BME Assets</div>
              <div style={{ color: COLORS.faint, fontSize: 12, fontWeight: 500 }}>Biomedical engineering</div>
            </div>
          )}
        </div>
        <Menu theme="light" mode="inline" items={items} selectedKeys={selected} onClick={() => phone && setCollapsed(true)} style={{ borderInlineEnd: 0, padding: '4px 14px 20px', background: 'transparent' }} />
      </Layout.Sider>
      <Layout style={{ minWidth: 0 }}>
        <Layout.Header className="no-print app-header" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button
            className="icon-btn"
            aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed((c) => !c)}
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
              style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: `1px solid ${COLORS.line}`, borderRadius: 999, cursor: 'pointer', minHeight: 44, padding: '0 14px 0 4px', font: 'inherit', lineHeight: 1 }}
            >
              <span
                aria-hidden
                style={{ width: 34, height: 34, borderRadius: '50%', background: COLORS.primary, color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, flex: 'none' }}
              >
                {initials(user.name)}
              </span>
              <span style={{ textAlign: 'left', lineHeight: 1.25 }} className="user-label">
                <span style={{ display: 'block', fontWeight: 700, color: COLORS.ink, fontSize: 13 }}>{shortName(user.name)}</span>
                <span style={{ display: 'block', color: COLORS.muted, fontSize: 12 }}>{user.roleLabel}</span>
              </span>
              <DownOutlined style={{ fontSize: 10, color: COLORS.faint }} />
            </button>
          </Dropdown>
        </Layout.Header>
        <Layout.Content style={{ padding: '28px 32px 48px' }} className="app-content">
          <div style={{ maxWidth: 1440, margin: '0 auto' }}>{children}</div>
        </Layout.Content>
        <ChangePasswordModal open={changingPassword} onClose={() => setChangingPassword(false)} />
      </Layout>
    </Layout>
  );
}
