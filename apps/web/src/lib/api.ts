'use client';

import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: { fieldErrors?: Record<string, string[] | undefined> },
  ) {
    super(message);
  }
}

// Same-origin call to /api/v1 (a Next route handler proxies it to the API at API_URL). The auth cookie is httpOnly.
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    // FormData sets its own multipart content-type.
    headers: init.body === undefined || init.body instanceof FormData ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : init.body instanceof FormData ? init.body : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error?.message ?? 'Something went wrong', json?.error?.details);
  return json as T;
}

export function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);

  const load = useCallback(async () => {
    if (path === null) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, reload: load };
}
