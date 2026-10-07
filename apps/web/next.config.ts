import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Same-origin API calls: the browser calls /api/v1/*, Next forwards to the Express API.
  // Keeps the auth cookie first-party in the demo (Vercel) and on-prem.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${process.env.API_URL ?? 'http://localhost:4000'}/api/v1/:path*` }];
  },
};

export default nextConfig;
