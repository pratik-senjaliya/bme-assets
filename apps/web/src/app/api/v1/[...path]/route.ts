import type { NextRequest } from 'next/server';

// The browser only ever calls /api/v1/* on its own origin (first-party cookie, no CORS). This handler
// forwards those calls to the API service.
//
// The API's address is a binding: it is read from process.env.API_URL here, inside the function, on every
// request. Nothing reads it at build time or in middleware, so one build runs against any API address
// (a Vercel service binding, the Render URL, or http://api:4000 in Docker Compose).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Headers that describe one hop only, or that fetch() recomputes.
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'host', 'expect'];
const NOT_FORWARDED_BACK = [...HOP_BY_HOP, 'content-encoding', 'content-length'];

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const binding = process.env.API_URL;
  if (!binding) {
    return Response.json({ error: { message: 'The API address (API_URL) is not configured for this deployment' } }, { status: 502 });
  }

  // `new URL(relative, base)` needs the base to end in "/" or its last segment is replaced.
  const base = binding.endsWith('/') ? binding : `${binding}/`;
  const { path } = await ctx.params;
  const target = new URL(`api/v1/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`, base);

  const headers = new Headers(req.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // Stream uploads (PDF/JPG/PNG up to 10 MB, Excel imports) instead of buffering them.
      ...(hasBody ? { duplex: 'half' } : {}),
      redirect: 'manual',
      cache: 'no-store',
    } as RequestInit);
  } catch (e) {
    console.error('API proxy failed:', e instanceof Error ? `${e.message} (${(e.cause as Error | undefined)?.message ?? 'no cause'})` : e);
    return Response.json({ error: { message: 'The API could not be reached' } }, { status: 502 });
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!NOT_FORWARDED_BACK.includes(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie') out.append(name, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
