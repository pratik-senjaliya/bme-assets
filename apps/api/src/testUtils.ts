import assert from 'node:assert/strict';
import net, { type AddressInfo } from 'node:net';
import { inflateSync } from 'node:zlib';
import { createApp } from './app';
import { todayISO } from './lib/dates';

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

// The text drawn in a PDFKit file. Its embedded font (Noto Sans, for ₹) writes glyph codes, so each hex string is read
// through the ToUnicode map of the font selected by the last `/Fn size Tf`; a built-in font's hex is WinAnsi text.
export function pdfTextOf(buf: Buffer) {
  const raw = buf.toString('latin1');
  const objects = new Map<string, { dict: string; data: Buffer | null }>();
  for (const m of raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)endobj/g)) {
    const at = m[0].indexOf('stream\n');
    const data = at < 0 ? null : buf.subarray(m.index + at + 7, m.index + m[0].lastIndexOf('endstream'));
    objects.set(m[1], { dict: at < 0 ? m[2] : m[0].slice(0, at), data });
  }
  const inflate = (data: Buffer | null) => {
    try {
      return data ? inflateSync(data).toString('latin1') : '';
    } catch {
      return ''; // not a compressed stream
    }
  };
  const utf16 = (hex: string) => String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)));
  // Glyph code → text, per font object.
  const maps = new Map<string, Map<number, string>>();
  for (const [id, o] of objects) {
    const ref = /\/ToUnicode (\d+) 0 R/.exec(o.dict);
    if (!ref) continue;
    const cmap = inflate(objects.get(ref[1])?.data ?? null);
    const map = new Map<number, string>();
    for (const r of cmap.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const lo = parseInt(r[1], 16);
      const hi = parseInt(r[2], 16);
      // A ligature maps to several characters, written with spaces: <0066 0069> is "fi".
      if (r[3].startsWith('[')) [...r[3].matchAll(/<([0-9a-fA-F\s]+)>/g)].forEach((d, k) => map.set(lo + k, utf16(d[1].replace(/\s/g, ''))));
      else for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(parseInt(r[3].slice(1, -1), 16) + (c - lo)));
    }
    for (const c of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of c[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) map.set(parseInt(p[1], 16), utf16(p[2].replace(/\s/g, '')));
    maps.set(id, map);
  }
  const fontByName = new Map<string, string>();
  for (const o of objects.values()) for (const f of o.dict.matchAll(/\/(F\d+) (\d+) 0 R/g)) fontByName.set(f[1], f[2]);

  let out = '';
  for (const o of objects.values()) {
    const content = inflate(o.data);
    if (!content.includes('BT') || content.includes('begincmap')) continue;
    let map: Map<number, string> | undefined;
    for (const t of content.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]+)>/g)) {
      if (t[1]) map = maps.get(fontByName.get(t[1]) ?? '');
      else if (map) out += (t[2].match(/.{4}/g) ?? []).map((h) => map!.get(parseInt(h, 16)) ?? '').join('');
      else out += Buffer.from(t[2], 'hex').toString('latin1');
    }
    out += '\n';
  }
  return out;
}

// A minimal SMTP server that keeps every message it receives (raw, as sent), for email tests.
export function fakeSmtp() {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol).toUpperCase();
        buffer = buffer.slice(eol + 2);
        if (line.startsWith('EHLO') || line.startsWith('HELO')) socket.write('250 fake\r\n');
        else if (line === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n');
          return;
        } else socket.write('250 OK\r\n');
      }
    });
  });
  return { messages, server };
}

// A 1 × 1 PNG: the smallest file the upload checks accept.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// A condemnation request as the committee's form sends it (multipart), with `reason` as the details.
export function condemnForm(reason: string) {
  const form = new FormData();
  form.set('reasonCategory', 'damaged');
  form.set('reason', reason);
  form.set('estimatedValue', '5000');
  form.set('committeeDate', todayISO());
  return form;
}
