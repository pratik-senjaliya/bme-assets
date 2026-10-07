import type { NextConfig } from 'next';

// No API address here on purpose: next.config is evaluated at build time, and the API address is a
// runtime binding. /api/v1/* is proxied by src/app/api/v1/[...path]/route.ts, which reads API_URL per request.
const nextConfig: NextConfig = {};

export default nextConfig;
