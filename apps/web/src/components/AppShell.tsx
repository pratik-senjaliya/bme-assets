'use client';

import {
  ApartmentOutlined,
  BarcodeOutlined,
  ToolOutlined,
  DashboardOutlined,
  LogoutOutlined,
  MedicineBoxOutlined,
  SafetyOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Dropdown, Layout, Menu, Skeleton, Typography, type MenuProps } from 'antd';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { PermissionCode } from '@bme/shared';
import { useAuth } from '@/lib/auth';

type Item = { href: string; label: string; icon: ReactNode; permission?: PermissionCode };

// Menu entries are filtered by the user's permission codes. The API enforces the same codes.
const MAIN: Item[] = [
  { href: '/', label: 'Dashboard', icon: <DashboardOutlined /> },
  { href: '/assets', label: 'Assets', icon: <BarcodeOutlined />, permission: 'asset.view' },
  { href: '/complaints', label: 'Complaints', icon: <ToolOutlined />, permission: 'complaint.view' },
];
const ADMIN: Item[] = [
  { href: '/admin/users', label: 'Users', icon: <TeamOutlined />, permission: 'user.manage' },
  { href: '/admin/roles', label: 'Roles & permissions', icon: <SafetyOutlined />, permission: 'role.manage' },
  { href: '/admin/departments', label: 'Departments & locations', icon: <ApartmentOutlined />, permission: 'setup.manage' },
  { href: '/admin/equipment-types', label: 'Equipment types', icon: <MedicineBoxOutlined />, permission: 'setup.manage' },
  { href: '/admin/settings', label: 'Hospital settings', icon: <SettingOutlined />, permission: 'setup.manage' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, loading, logout, can } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div style={{ padding: 48 }}>
        <Skeleton active />
      </div>
    );
  }

  const toItem = (i: Item) => ({ key: i.href, icon: i.icon, label: <Link href={i.href}>{i.label}</Link> });
  const admin = ADMIN.filter((i) => !i.permission || can(i.permission));
  const items: MenuProps['items'] = [
    ...MAIN.filter((i) => !i.permission || can(i.permission)).map(toItem),
    ...(admin.length ? [{ type: 'group' as const, label: collapsed ? '' : 'Admin', children: admin.map(toItem) }] : []),
  ];
  const selected = [...MAIN, ...ADMIN].filter((i) => (i.href === '/' ? pathname === '/' : pathname.startsWith(i.href))).map((i) => i.href);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        width={240}
        theme="light"
        style={{ borderRight: '1px solid #E5E7EB' }}
      >
        <div style={{ height: 56, display: 'flex', alignItems: 'center', padding: '0 24px' }}>
          <Typography.Text strong style={{ fontSize: 16, whiteSpace: 'nowrap' }}>
            {collapsed ? 'BME' : 'BME Assets'}
          </Typography.Text>
        </div>
        <Menu mode="inline" items={items} selectedKeys={selected} style={{ borderInlineEnd: 0, padding: '0 8px' }} />
      </Layout.Sider>
      <Layout>
        <Layout.Header style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', borderBottom: '1px solid #E5E7EB' }}>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'role', label: user.roleLabel, disabled: true },
                { key: 'logout', icon: <LogoutOutlined />, label: 'Sign out' },
              ],
              onClick: async ({ key }) => {
                if (key === 'logout') {
                  await logout();
                  router.replace('/login');
                }
              },
            }}
          >
            <button
              type="button"
              aria-label="User menu"
              style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 0, cursor: 'pointer', minHeight: 40 }}
            >
              <Avatar size="small" icon={<UserOutlined />} />
              <span>{user.name}</span>
            </button>
          </Dropdown>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          <div style={{ maxWidth: 1440, margin: '0 auto' }}>{children}</div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
