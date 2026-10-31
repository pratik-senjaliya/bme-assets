// kit.mjs: browser, overlay (caption, cursor, cards), screencast recording, and narration timing.
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { LINES } from './lines.mjs';

export const HERE = path.dirname(new URL(import.meta.url).pathname);
export const OUT = process.env.VIDEO_OUT ?? path.join(HERE, 'out');
export const BASE = process.env.VIDEO_BASE ?? 'http://localhost:3100';
const DURFILE = path.join(OUT, 'audio', 'durations.json');
const DUR = fs.existsSync(DURFILE) ? JSON.parse(fs.readFileSync(DURFILE, 'utf8')) : {};
export const FAST = process.env.FAST === '1'; // quick dry run: short waits, no recording
export const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? Math.min(ms, 150) : ms));
const secondsOf = (id) => DUR[id] ?? LINES[id][1].split(/\s+/).length / 2.5;

const OVERLAY = `(() => {
  if (window.__v) return;
  const S = (k, v) => { try { if (v === undefined) return JSON.parse(sessionStorage.getItem('__v_' + k) || 'null'); sessionStorage.setItem('__v_' + k, JSON.stringify(v)); } catch { return null; } };
  const css = \`
  #__vroot{position:fixed;inset:0;pointer-events:none;z-index:2147483646;font-family:var(--v-font, 'Plus Jakarta Sans', system-ui, sans-serif)}
  #__vcap{position:absolute;left:50%;bottom:22px;transform:translate(-50%,12px);width:min(1040px,calc(100% - 340px));margin-left:124px;
    background:rgba(9,46,44,.95);color:#fff;border-radius:14px;padding:16px 24px 18px;box-shadow:0 18px 50px rgba(0,0,0,.28);
    opacity:0;transition:opacity .35s, transform .35s;border-left:6px solid #5eead4}
  #__vcap.on{opacity:1;transform:translate(-50%,0)}
  #__vcap .k{font-size:13px;font-weight:700;letter-spacing:.06em;color:#5eead4;text-transform:uppercase;margin-bottom:4px}
  #__vcap .t{font-size:22px;font-weight:800;margin-bottom:4px}
  #__vcap .x{font-size:17px;line-height:1.5;opacity:.93}
  #__vcard{position:absolute;inset:0;background:radial-gradient(1200px 700px at 30% 30%,#14746c 0%,#0b3d3a 55%,#062624 100%);color:#fff;
    display:flex;flex-direction:column;justify-content:center;padding:0 140px;opacity:0;transition:opacity .6s}
  #__vcard.on{opacity:1}
  #__vcard .k{font-size:22px;font-weight:700;color:#5eead4;letter-spacing:.08em;text-transform:uppercase;margin-bottom:18px}
  #__vcard .t{font-size:68px;font-weight:800;line-height:1.1;max-width:1200px}
  #__vcard .s{font-size:26px;line-height:1.5;margin-top:26px;opacity:.85;max-width:1100px}
  #__vcard .bar{width:90px;height:6px;border-radius:3px;background:#5eead4;margin-top:34px}
  #__vcur{position:absolute;left:0;top:0;width:26px;height:26px;transition:transform .7s cubic-bezier(.4,0,.2,1);will-change:transform}
  #__vring{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #14b8a6;opacity:0;transform:scale(.3)}
  #__vring.go{animation:__vr .55s ease-out}
  @keyframes __vr{0%{opacity:.9;transform:scale(.3)}100%{opacity:0;transform:scale(1.4)}}
  #__vmark{position:absolute;border:3px solid #f59e0b;border-radius:10px;box-shadow:0 0 0 4000px rgba(0,0,0,.12),0 0 24px rgba(245,158,11,.6);opacity:0;transition:opacity .4s}
  #__vmark.on{opacity:1}\`;
  function build() {
    if (document.getElementById('__vroot')) return;
    const st = document.createElement('style'); st.textContent = css;
    const root = document.createElement('div'); root.id = '__vroot';
    root.innerHTML = '<div id="__vmark"></div><div id="__vcard"><div class="k"></div><div class="t"></div><div class="s"></div><div class="bar"></div></div>'
      + '<div id="__vcap"><div class="k"></div><div class="t"></div><div class="x"></div></div><div id="__vring"></div>'
      + '<svg id="__vcur" viewBox="0 0 26 26"><path d="M4 2 L4 21 L9 16.5 L12.5 24 L16 22.5 L12.6 15.2 L19.5 15.2 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(st); document.documentElement.appendChild(root);
    try { root.style.setProperty('--v-font', getComputedStyle(document.body).fontFamily); } catch {}
    const c = S('cur') || [800, 450]; const cur = document.getElementById('__vcur');
    cur.style.transition = 'none'; cur.style.transform = 'translate(' + c[0] + 'px,' + c[1] + 'px)'; cur.getBoundingClientRect(); cur.style.transition = '';
    const cap = S('cap'); if (cap) { window.__v.cap(cap[0], cap[1], cap[2], true); }
    const card = S('card'); if (card) { window.__v.card(card[0], card[1], card[2], true); }
  }
  const $ = (q) => document.querySelector(q);
  window.__v = {
    cap(k, t, x, instant) { const e = $('#__vcap'); if (!e) return; e.querySelector('.k').textContent = k; e.querySelector('.t').textContent = t; e.querySelector('.x').textContent = x;
      if (instant) { e.style.transition = 'none'; e.classList.add('on'); e.getBoundingClientRect(); e.style.transition = ''; } else e.classList.add('on'); S('cap', [k, t, x]); },
    capOff() { const e = $('#__vcap'); if (e) e.classList.remove('on'); S('cap', null); },
    card(k, t, s, instant) { const e = $('#__vcard'); if (!e) return; e.querySelector('.k').textContent = k; e.querySelector('.t').textContent = t; e.querySelector('.s').textContent = s;
      if (instant) { e.style.transition = 'none'; e.classList.add('on'); e.getBoundingClientRect(); e.style.transition = ''; } else e.classList.add('on'); S('card', [k, t, s]); },
    cardOff() { const e = $('#__vcard'); if (e) e.classList.remove('on'); S('card', null); },
    cur(x, y, ms) { const e = $('#__vcur'); if (!e) return; e.style.transitionDuration = ms + 'ms'; e.style.transform = 'translate(' + x + 'px,' + y + 'px)'; S('cur', [x, y]); },
    ring(x, y) { const r = $('#__vring'); if (!r) return; r.style.left = x + 'px'; r.style.top = y + 'px'; r.classList.remove('go'); r.getBoundingClientRect(); r.classList.add('go'); },
    mark(x, y, w, h) { const m = $('#__vmark'); if (!m) return; Object.assign(m.style, { left: x - 6 + 'px', top: y - 6 + 'px', width: w + 12 + 'px', height: h + 12 + 'px' }); m.classList.add('on'); },
    unmark() { const m = $('#__vmark'); if (m) m.classList.remove('on'); },
  };
  if (document.documentElement && document.body) build(); else document.addEventListener('DOMContentLoaded', build);
  new MutationObserver(() => { if (document.body && !document.getElementById('__vroot')) build(); }).observe(document, { childList: true, subtree: true });
})();`;

let browser;
// A Chrome to drive: CHROME_PATH, else one Playwright downloaded, else the installed Chrome (same rule as e2e/lib.mjs).
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      const p = path.join(cache, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}
export async function open() {
  const exe = chromePath();
  browser = await chromium.launch({ ...(exe ? { executablePath: exe } : { channel: 'chrome' }), args: ['--hide-scrollbars'] });
}
export const closeAll = () => browser.close();

// One person in their own browser context. Off camera unless recording.
export async function person(email, { login = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on('dialog', (d) => d.accept().catch(() => {}));
  if (login) {
    await page.goto(BASE + '/login');
    await page.fill('input[autocomplete=username]', email);
    await page.fill('input[type=password]', 'Demo@1234');
    await page.click('button[type=submit]');
    await page.waitForURL((u) => !/\/login/.test(u.pathname));
    await page.waitForLoadState('networkidle');
  }
  return new Actor(page, email);
}

export class Actor {
  constructor(page, email) { this.page = page; this.email = email; this.chip = ''; this.rec = null; }

  // ---------- recording ----------
  async start(name) {
    if (FAST) { this.rec = { name, marks: [], fake: true }; return; }
    const dir = path.join(OUT, 'seg', name); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const cdp = await this.page.context().newCDPSession(this.page);
    const rec = { name, dir, cdp, frames: [], marks: [], t0: Date.now() / 1000 };
    cdp.on('Page.screencastFrame', (f) => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      const file = path.join(dir, String(rec.frames.length).padStart(6, '0') + '.jpg');
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
      rec.frames.push([path.basename(file), f.metadata.timestamp]);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    this.rec = rec;
    await this.page.evaluate(() => window.scrollBy(0, 1)).catch(() => {}); // force a first frame
    await this.page.evaluate(() => window.scrollBy(0, -1)).catch(() => {});
  }
  async stop() {
    const rec = this.rec; this.rec = null;
    if (rec.fake) { console.log('segment', rec.name, 'ok'); return; }
    await sleep(300);
    await rec.cdp.send('Page.stopScreencast').catch(() => {});
    rec.t1 = Date.now() / 1000;
    fs.writeFileSync(path.join(rec.dir, 'meta.json'), JSON.stringify({ t0: rec.t0, t1: rec.t1, frames: rec.frames, marks: rec.marks }));
    await rec.cdp.detach().catch(() => {});
    console.log('segment', rec.name, (rec.t1 - rec.t0).toFixed(1) + 's', rec.frames.length, 'frames');
  }

  // ---------- narration ----------
  // Shows the caption, notes when the line starts, runs `fn` alongside, and waits for whichever is longer.
  async say(id, fn) {
    const [title, text] = LINES[id];
    await this.page.evaluate(([k, t, x]) => window.__v?.cap(k, t, x), [this.chip, title, text]).catch(() => {});
    const t = Date.now() / 1000;
    if (this.rec) this.rec.marks.push([id, t]);
    const minMs = (secondsOf(id) + 0.6) * 1000;
    await Promise.all([sleep(minMs), fn ? fn() : null]);
  }
  async capOff() { await this.page.evaluate(() => window.__v?.capOff()).catch(() => {}); }
  async card(kicker, title, sub) { await this.page.evaluate(([k, t, s]) => window.__v?.card(k, t, s), [kicker, title, sub]); }
  async cardOff() { await this.page.evaluate(() => window.__v?.cardOff()); await sleep(700); }

  // ---------- pointer ----------
  async move(loc, { ms = 700, dx = 0, dy = 0 } = {}) {
    loc = typeof loc === 'string' ? this.page.locator(loc).first() : loc;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const b = await loc.boundingBox();
    if (!b) throw new Error('no box for ' + loc);
    const x = Math.round(b.x + Math.min(b.width / 2, 60) + dx), y = Math.round(b.y + b.height / 2 + dy);
    await this.page.evaluate(([x, y, ms]) => window.__v?.cur(x, y, ms), [x, y, ms]);
    await this.page.mouse.move(x, y, { steps: 8 });
    await sleep(ms + 80);
    return { x, y };
  }
  async click(loc, opts = {}) {
    loc = typeof loc === 'string' ? this.page.locator(loc).first() : loc;
    const { x, y } = await this.move(loc, opts);
    await this.page.evaluate(([x, y]) => window.__v?.ring(x, y), [x, y]);
    await sleep(180);
    await loc.click();
    await sleep(opts.after ?? 600);
  }
  async type(loc, text, delay = 55) {
    loc = typeof loc === 'string' ? this.page.locator(loc).first() : loc;
    await this.click(loc, { after: 200 });
    await loc.pressSequentially(text, { delay: FAST ? 0 : delay });
    await sleep(300);
  }
  async mark(loc, ms = 0) {
    loc = typeof loc === 'string' ? this.page.locator(loc).first() : loc;
    const b = await loc.boundingBox(); if (!b) return;
    await this.page.evaluate(([x, y, w, h]) => window.__v?.mark(x, y, w, h), [b.x, b.y, b.width, b.height]);
    if (ms) { await sleep(ms); await this.unmark(); }
  }
  async unmark() { await this.page.evaluate(() => window.__v?.unmark()).catch(() => {}); await sleep(300); }
  // Smooth scroll by `px` (positive is down) over `ms`.
  async scroll(px, ms = 1200) {
    const steps = Math.max(1, Math.round(ms / 40));
    for (let i = 0; i < steps; i++) { await this.page.mouse.wheel(0, px / steps); await new Promise((r) => setTimeout(r, FAST ? 0 : 40)); }
    await sleep(300);
  }
  async top() { await this.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await sleep(700); }
  // The database id of an asset, from its asset ID (ids change whenever the demo is rebuilt).
  async idOf(code) {
    const r = await this.page.context().request.get(`${BASE}/api/v1/assets/by-code/${encodeURIComponent(code)}`);
    if (!r.ok()) throw new Error(`asset ${code}: ${r.status()}`);
    return (await r.json()).id;
  }
  async go(p) { await this.page.goto(BASE + p); await this.settle(); }
  async settle() { await this.page.waitForLoadState('networkidle').catch(() => {}); await sleep(500); }
  async nav(text) { await this.click(this.page.locator('aside').getByRole('link', { name: text, exact: true }).first(), { after: 300 }); await this.settle(); }
}
