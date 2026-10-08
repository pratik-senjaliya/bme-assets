import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(HERE, '.out');
fs.mkdirSync(OUT, { recursive: true });
export const BASE = process.env.E2E_BASE ?? 'http://localhost:3000';
export const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo@1234';
export const results = [];
let shotN = 0;

// A Chrome/Chromium to drive: CHROME_PATH, else one Playwright downloaded, else the system Chrome.
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      const p = path.join(cache, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined; // falls back to the installed Chrome channel
}
export const launch = () => (chromePath() ? chromium.launch({ executablePath: chromePath() }) : chromium.launch({ channel: 'chrome' }));

export async function session(browser, email, viewport = { width: 1440, height: 900 }, password = PASSWORD) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  // A form with unsaved input asks before the page is left; the tests move on like a person choosing "Leave".
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(BASE + '/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !/\/login/.test(u.pathname));
  return { ctx, page, api: async (method, p, data) => { const r = await ctx.request.fetch(`${BASE}/api/v1${p}`, { method, data }); let body = null; try { body = await r.json(); } catch {} return { status: r.status(), body }; } };
}

// One named check. A thrown error is a FAIL with the reason and a screenshot, so one broken step never hides the rest.
export async function step(name, fn, page) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } catch (e) {
    const msg = String(e.message ?? e).split('\n')[0].slice(0, 240);
    results.push({ name, ok: false, detail: msg });
    console.log(`FAIL  ${name}  — ${msg}`);
    if (page) await page.screenshot({ path: path.join(OUT, `fail-${path.basename(process.argv[1], '.mjs')}-${String(++shotN).padStart(2, '0')}.png`) }).catch(() => {});
  }
}
export const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

const labelled = (page, label, scope = page) => scope.locator('.ant-form-item').filter({ has: page.locator('label', { hasText: new RegExp(`^\\s*${label}`) }) }).first();
export async function pick(page, label, text, scope = page) {
  await labelled(page, label, scope).locator('.ant-select').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: text }).first().click();
}
export async function fillDate(page, label, text, scope = page) {
  const input = labelled(page, label, scope).locator('.ant-picker input');
  await input.click(); await input.fill(text); await input.press('Tab'); // Tab, not Enter (Enter is tested on its own)
}
export const fillField = (page, label, value, scope = page) => labelled(page, label, scope).locator('input:not([type=search]), textarea').first().fill(String(value));
export const today = () => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date());
export const isoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export function summary() {
  const f = results.filter((r) => !r.ok);
  console.log(`\n${results.length - f.length}/${results.length} passed${f.length ? ` — ${f.length} FAILED` : ''}`);
  fs.writeFileSync(path.join(OUT, `results-${path.basename(process.argv[1], '.mjs')}.json`), JSON.stringify(results, null, 1));
  process.exitCode = f.length ? 1 : 0;
}
