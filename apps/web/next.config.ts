import path from 'node:path';
import type { NextConfig } from 'next';

// No API address here on purpose: next.config is evaluated at build time, and the API address is a
// runtime binding. /api/v1/* is proxied by src/app/api/v1/[...path]/route.ts, which reads API_URL per request.
//
// NEXT_OUTPUT=standalone is set only by the Docker build (apps/web/Dockerfile): it produces a small self-contained
// server for the hospital install. Vercel and `next dev` are unaffected.
const standalone = process.env.NEXT_OUTPUT === 'standalone';

const nextConfig: NextConfig = {
  ...(standalone && {
    output: 'standalone',
    // The app lives in a monorepo: trace dependencies from the repo root so packages/shared is included.
    outputFileTracingRoot: path.join(process.cwd(), '../..'),
  }),
};

export default nextConfig;
