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

// The text drawn in a PDFKit file: inflate each content stream and decode its hex strings (WinAnsi text).
export function pdfTextOf(buf: Buffer) {
  const raw = buf.toString('latin1');
  let out = '';
  for (let i = raw.indexOf('stream\n'); i >= 0; i = raw.indexOf('stream\n', i + 1)) {
    const end = raw.indexOf('endstream', i);
    try {
      const content = inflateSync(buf.subarray(i + 7, end)).toString('latin1');
      for (const m of content.matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(m[1], 'hex').toString('latin1');
      out += '\n';
    } catch {
      // not a compressed content stream (fonts, images)
    }
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
