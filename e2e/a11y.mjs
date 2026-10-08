// Every screen, as every role: no console errors, no failed requests (other than refusals for things a role may
// not do), a heading and a distinct tab title, no sideways scrolling at desktop / 1024 / tablet width, and no
// serious or critical accessibility violations (axe-core).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
const axeSrc = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const b = await launch();
const probe = await session(b, 'admin@demo.local');
const asset = (await probe.api('GET', '/assets?pageSize=1')).body.items[0];
const pms = (await probe.api('GET', `/assets/${asset.id}/pms`)).body[0];
const ROUTES = ['/', '/assets', '/assets/new', '/assets/import', `/assets/${asset.id}`, `/assets/${asset.id}/edit`, `/assets/${asset.id}/history`, `/assets/${asset.id}/pms/new`, pms ? `/pms/${pms.id}` : null,
  '/complaints', '/due', '/approvals', '/reports', '/reports/pms', '/reports/warranty-contracts', '/admin/users', '/admin/roles', '/admin/departments', '/admin/equipment-types', '/admin/pms-templates', '/admin/audit', '/admin/settings', '/nope'].filter(Boolean);
await probe.ctx.close();

// What each role is expected to be refused: those pages must say so plainly rather than fail to load.
const FORBIDDEN = { biomed: ['/admin/users', '/admin/roles', '/admin/settings', '/admin/audit', '/admin/departments', '/admin/equipment-types', '/admin/pms-templates'], nursing: ['/assets/new', '/assets/import', '/due', '/approvals', '/reports', '/reports/pms', '/reports/warranty-contracts', '/admin/users', '/admin/roles', '/admin/settings', '/admin/audit', '/admin/departments', '/admin/equipment-types', '/admin/pms-templates', `/assets/${asset.id}/history`, `/assets/${asset.id}/edit`, `/assets/${asset.id}/pms/new`, pms ? `/pms/${pms.id}` : ''] };
const titles = new Map();

for (const role of ['superadmin', 'admin', 'biomed', 'nursing']) {
  const s = await session(b, `${role}@demo.local`);
  const p = s.page;
  let errs = [], bad = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/element\.ref|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 140)); });
  p.on('pageerror', (e) => errs.push(`pageerror ${e.message.slice(0, 140)}`));
  p.on('response', (r) => { if (r.status() >= 400 && /\/api\/v1\//.test(r.url())) bad.push(`${r.status()} ${r.url().replace(BASE, '')}`); });
  for (const route of ROUTES) {
    await step(`${role} ${route.replace(/[0-9a-f-]{36}/g, ':id')}`, async () => {
      errs = []; bad = [];
      await p.setViewportSize({ width: 1440, height: 900 });
      await p.goto(BASE + route); await p.waitForLoadState('networkidle');
      await p.locator('h1').first().waitFor({ timeout: 8000 }).catch(() => undefined); // a screen that is still loading has no heading yet
      await p.waitForTimeout(400);
      const info = await p.evaluate(() => ({ title: document.title, h1: document.querySelectorAll('h1').length, main: document.querySelectorAll('main').length, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, result: document.querySelector('.ant-result-title')?.textContent ?? '' }));
      const refused = (FORBIDDEN[role] ?? []).includes(route);
      const missing = route === '/nope';
      expect(info.h1 === 1 || missing, `${info.h1} top-level headings`);
      expect(info.main >= 1, 'no main landmark');
      if (!missing) { expect(/·|Sign in/.test(info.title) || info.title === 'BME Assets', `tab title "${info.title}"`); }
      if (refused) expect(/You cannot|not found/i.test(info.result), `a refused page should say so, shows "${info.result}"`);
      if (!refused && !missing) expect(bad.filter((x) => !/^40[34] /.test(x)).length === 0, `failed requests: ${bad.join(', ')}`);
      if (refused) expect(bad.length === 0, `a refused page still made requests that failed: ${bad.join(', ')}`);
      expect(errs.length === 0, `console: ${errs.join(' | ')}`);
      expect(!info.wide, 'sideways scroll at 1440');
      await p.addScriptTag({ content: axeSrc });
      const v = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}(${x.nodes.length})`));
      expect(v.length === 0, `accessibility: ${v.join(', ')}`);
      for (const w of [1024, 820]) { await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(250); expect(!(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)), `sideways scroll at ${w}`); }
      if (role === 'admin' && !missing) titles.set(route.replace(/[0-9a-f-]{36}/g, ':id'), info.title);
    }, p);
  }
  await s.ctx.close();
}
await step('Every screen has its own tab title', async () => {
  const seen = new Map();
  for (const [route, t] of titles) seen.set(t, [...(seen.get(t) ?? []), route]);
  const dupes = [...seen].filter(([, r]) => r.length > 1).map(([t, r]) => `"${t}": ${r.join(', ')}`);
  expect(dupes.length === 0, dupes.join(' | '));
});
await b.close();
summary();
