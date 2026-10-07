import { theme, type ThemeConfig } from 'antd';

// One calm blue-teal primary, neutral greys, 8px radius. Tables use the compact algorithm via <Table size="small">.
export const appTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: '#0E7490',
    colorBgLayout: '#F7F8FA',
    colorBorder: '#E5E7EB',
    colorText: '#111827',
    colorTextSecondary: '#6B7280',
    borderRadius: 8,
    borderRadiusSM: 6,
    fontSize: 14,
    lineHeight: 1.5,
    fontFamily: 'var(--font-inter), system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  components: {
    Layout: { siderBg: '#FFFFFF', headerBg: '#FFFFFF', headerHeight: 56, headerPadding: '0 24px' },
    Menu: { itemBorderRadius: 8 },
    Table: { headerBg: '#F9FAFB' },
  },
};
