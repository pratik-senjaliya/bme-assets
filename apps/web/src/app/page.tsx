'use client';

import { useEffect, useState } from 'react';
import type { HealthResponse } from '@bme/shared';

// Phase 0 check page: proves web → API → database works. Replaced by the login page in Phase 1.
export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/v1/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setError(true));
  }, []);

  return (
    <main style={{ maxWidth: 560, margin: '80px auto', padding: 24 }}>
      <h1 style={{ fontSize: 24 }}>BME Asset Management</h1>
      {error && <p>API not reachable. Is <code>npm run dev:api</code> running?</p>}
      {!error && !health && <p>Checking API…</p>}
      {health && (
        <p>
          API: {health.status} · Database: {health.database} · Server time: {health.serverTime}
        </p>
      )}
    </main>
  );
}
