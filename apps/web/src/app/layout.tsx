import type { Metadata } from 'next';
import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from '@/components/Providers';
import { THEME_SCRIPT } from '@/lib/themeMode';
import './globals.css';

// Downloaded at build time and served by the app itself, so hospital installs without internet still get them.
const sans = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'BME Asset Management',
  description: 'Biomedical equipment asset management for hospitals',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The light/dark choice is set on <html> by the script below before the first paint, hence the warning switch.
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
