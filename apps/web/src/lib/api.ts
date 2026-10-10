'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { notifySignedOut } from '@/lib/nav';

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
  // 401 anywhere except signing in and the first "who am I" check means the session ended.
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') notifySignedOut();
  if (!res.ok) throw new ApiError(res.status, json?.error?.message ?? 'Something went wrong', json?.error?.details);
  return json as T;
}

// The last answer for each path, so a page visited again shows at once and then refreshes quietly. Requests for
// the same path at the same moment (the shell and a page, or a page mounted twice) share one call.
// Cleared on sign in and sign out, so one person never sees another's data.
const cache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();
const CACHE_LIMIT = 100;

export function clearFetchCache() {
  cache.clear();
  inflight.clear();
}

// `fresh` starts a new call even if one is under way (a reload after a save must not get an older answer).
function fetchShared<T>(path: string, fresh: boolean): Promise<T> {
  const running = fresh ? undefined : inflight.get(path);
  if (running) return running as Promise<T>;
  const call = api<T>(path).then((value) => {
    if (inflight.get(path) === call) {
      cache.delete(path);
      cache.set(path, value);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    }
    return value;
  });
  inflight.set(path, call);
  const done = () => void (inflight.get(path) === call && inflight.delete(path));
  call.then(done, done);
  return call;
}

// `fresh`: never show a remembered answer, only one asked for now. For screens that copy the data into a form to be
// edited and saved (an older copy, or a newer one arriving after typing has started, must never end up in the form).
export function useFetch<T>(path: string | null, { fresh = false }: { fresh?: boolean } = {}) {
  const useCache = !fresh;
  const [data, setData] = useState<T | null>(() => (useCache && path !== null && cache.has(path) ? (cache.get(path) as T) : null));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null && !(useCache && cache.has(path)));
  const current = useRef(path);
  current.current = path;

  const run = useCallback(
    async (reload: boolean) => {
      if (path === null) return;
      const cached = useCache && cache.has(path);
      if (cached) setData(cache.get(path) as T);
      // With something to show, the first refresh is quiet; a reload (after a save) shows that it is working.
      if (reload || !cached) setLoading(true);
      try {
        const value = await fetchShared<T>(path, reload);
        if (current.current !== path) return; // the page moved on (new filter); a late answer must not replace it
        // The same answer again keeps the same object, so nothing on screen redraws or resets.
        setData((prev) => (prev !== null && JSON.stringify(prev) === JSON.stringify(value) ? prev : value));
        setError(null);
      } catch (e) {
        if (current.current !== path) return;
        setError(e instanceof Error ? e.message : 'Something went wrong');
      } finally {
        if (current.current === path) setLoading(false);
      }
    },
    [path, useCache],
  );

  useEffect(() => {
    void run(false);
  }, [run]);

  const reload = useCallback(() => run(true), [run]);
  return { data, error, loading, reload };
}
