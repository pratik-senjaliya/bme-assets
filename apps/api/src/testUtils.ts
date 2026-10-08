import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';

export const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo@1234';

export function startServer() {
  const server = createApp().listen(0);
  return { server, base: `http://localhost:${(server.address() as AddressInfo).port}/api/v1` };
}

export async function login(base: string, email: string) {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

export const call = (base: string, cookie: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
