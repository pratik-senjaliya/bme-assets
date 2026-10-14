// QR labels: the sheet lists the equipment on screen, every printed code decodes to that machine's /q/ link, and
// scanning a link opens the machine (after signing in when needed); a label from another department is refused.
import { createRequire } from 'node:module';
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
const require = createRequire(import.meta.url);
const jsQR = require('jsqr');
const { PNG } = require('pngjs');
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(600); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const ap = admin.page;
const all = (await admin.api('GET', '/assets?pageSize=100&status=all')).body.items;
const icu = all.find((a) => a.departmentName === 'Intensive Care Unit' && a.status === 'active');
const other = all.find((a) => a.departmentName !== 'Intensive Care Unit');

await step('Asset list: QR labels follows the search, and every printed code scans to its machine', async () => {
  await ap.goto(BASE + '/assets?search=Ventilator'); await settle(ap);
  await ap.getByRole('link', { name: 'QR labels' }).click(); await ap.waitForURL(/\/assets\/labels\?search=Ventilator/); await settle(ap);
  const labels = await ap.locator('.qr-label').all();
  const listed = (await admin.api('GET', '/assets?search=Ventilator')).body.total;
  expect(labels.length === listed && listed > 0, `${labels.length} labels for ${listed} listed`);
  for (const el of labels) {
    const code = await el.locator('.qr-label-id').innerText();
    const png = PNG.sync.read(await el.locator('.qr-label-code').screenshot());
    const read = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
    expect(read === `${BASE}/q/${code}`, `${code} decodes to ${read}`);
  }
  return `${labels.length} labels decoded`;
}, ap);

await step('Asset page: More → Print QR label gives one label for that machine', async () => {
  await ap.goto(`${BASE}/assets/${icu.id}`); await settle(ap);
  await ap.getByRole('button', { name: 'More' }).click(); await ap.locator('.ant-dropdown-menu-item', { hasText: 'Print QR label' }).click();
  await ap.waitForURL(/\/assets\/labels\?ids=/); await settle(ap);
  expect((await ap.locator('.qr-label').count()) === 1, 'not exactly one label');
  expect((await ap.locator('.qr-label-id').innerText()) === icu.assetCode, 'wrong machine on the label');
  expect(await ap.getByRole('button', { name: 'Print' }).isEnabled(), 'Print is not available');
}, ap);

await step('Scanning a label opens the machine; an unknown label says so', async () => {
  await ap.goto(`${BASE}/q/${icu.assetCode}`); await ap.waitForURL(`${BASE}/assets/${icu.id}`);
  await ap.goto(`${BASE}/q/NOPE-0000`); await settle(ap);
  expect(/No equipment with this label/.test(await ap.locator('h1').innerText()), 'no plain answer for an unknown label');
}, ap);

await step('Scanning while signed out: sign in, then straight to the machine', async () => {
  const ctx = await b.newContext(); const p = await ctx.newPage();
  await p.goto(`${BASE}/q/${icu.assetCode}`); await p.waitForURL(/\/login\?next=%2Fq%2F/);
  await p.fill('input[type=email]', 'nursing@demo.local'); await p.fill('input[type=password]', 'Demo@1234'); await p.click('button[type=submit]');
  await p.waitForURL(`${BASE}/assets/${icu.id}`);
  await ctx.close();
});

await step('Nursing staff: a label from another department is refused, and labels cannot be printed', async () => {
  const s = await session(b, 'nursing@demo.local'); const p = s.page;
  await p.goto(`${BASE}/q/${other.assetCode}`); await settle(p);
  expect(/No equipment with this label/.test(await p.locator('h1').innerText()), 'another department’s machine opened');
  await p.goto(`${BASE}/assets/labels?ids=${icu.id}`); await settle(p);
  expect(/You cannot print equipment labels/.test(await p.locator('h1').innerText()), 'label sheet shown to nursing');
  await p.goto(BASE + '/assets'); await settle(p);
  expect((await p.getByRole('link', { name: 'QR labels' }).count()) === 0, 'QR labels offered to nursing');
  await s.ctx.close();
}, ap);

await b.close();
summary();
