import type { Metadata } from 'next';
import { Manrope } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from '@/components/Providers';
import './globals.css';

// Downloaded at build time and served by the app itself, so hospital installs without internet still get it.
const sans = Manrope({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: 'BME Asset Management',
  description: 'Biomedical equipment asset management for hospitals',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
