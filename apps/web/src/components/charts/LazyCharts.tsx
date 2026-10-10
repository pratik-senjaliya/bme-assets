'use client';

import dynamic from 'next/dynamic';
import { ChartSkeleton } from '@/components/Skeletons';

// The chart library is the largest in the app, so it is a file of its own. Its download starts as soon as a page
// that draws charts loads, alongside the page's data, instead of after it; the figures and lists don't wait for it.
const load = () => import('./ChartCard');
if (typeof window !== 'undefined') void load();

export const ChartGrid = dynamic(() => load().then((m) => m.ChartGrid), { ssr: false, loading: () => <ChartSkeleton /> });
