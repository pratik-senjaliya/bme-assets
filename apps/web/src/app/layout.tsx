import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'BME Asset Management',
  description: 'Biomedical equipment asset management for hospitals',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#F7F8FA' }}>{children}</body>
    </html>
  );
}
