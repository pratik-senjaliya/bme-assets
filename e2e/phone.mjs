// Phones and dark mode. On a 375px phone every list shows its first record near the top (search, filters and sorting
// share one line), nothing scrolls sideways, the bottom bar reaches the everyday pages, and the sort control sorts.
// In dark mode every screen passes the same accessibility check as in light (contrast included). The light/dark
// choice in the account menu is kept after a reload.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
const axeSrc = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(600); };
const wide = (p) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
// Where the list starts (its first record, or the empty message when there is none).
const listTop = (p) => p.evaluate(() => { const r = document.querySelector('.ant-table-wrapper'); return r ? Math.round(r.getBoundingClientRect().top + scrollY) : null; });

const b = await launch();
const PHONE = { width: 375, height: 740 };
// The list pages each role works from, and how far down a 740px phone screen the first record may start.
const LISTS = { biomed: ['/assets', '/due', '/approvals'], nursing: ['/assets', '/complaints'] };
const TOP = 280;

for (const role of ['biomed', 'nursing']) {
  const s = await session(b, `${role}@demo.local`, PHONE); const p = s.page;
  for (const route of LISTS[role]) {
    await step(`${role} phone ${route}: the first record is on the first screen, nothing scrolls sideways`, async () => {
      await p.goto(BASE + route); await settle(p);
      await p.locator('.ant-table-wrapper').first().waitFor({ timeout: 8000 });
      const y = await listTop(p);
      expect(y !== null && y <= TOP, `first record starts at ${y}px (limit ${TOP})`);
      expect(!(await wide(p)), 'sideways scroll at 375');
      await p.setViewportSize({ width: 320, height: 640 }); await p.waitForTimeout(300);
      expect(!(await wide(p)), 'sideways scroll at 320');
      await p.setViewportSize(PHONE);
    }, p);
  }
  await step(`${role} phone: the bottom bar opens the everyday pages and the full menu`, async () => {
    await p.goto(BASE + '/'); await settle(p);
    const bar = p.getByRole('navigation', { name: 'Quick links' });
    await bar.getByRole('link', { name: 'Assets' }).click(); await p.waitForURL(/\/assets$/);
    await bar.getByRole('button', { name: 'Open menu' }).click(); await p.waitForTimeout(400);
    expect(await p.locator('.app-sider .ant-menu-item', { hasText: 'Complaints' }).isVisible(), 'menu did not open');
  }, p);
  await s.ctx.close();
}

await step('Phone sort control sorts the asset list both ways and keeps it in the address', async () => {
  const s = await session(b, 'biomed@demo.local', PHONE); const p = s.page;
  await p.goto(BASE + '/assets'); await settle(p);
  const sort = p.locator('.phone-sort-slot button');
  await sort.click(); await p.locator('.ant-dropdown-menu-item', { hasText: 'Next PMS' }).click(); await settle(p);
  expect(/sortBy=nextPmsDue&order=asc/.test(p.url()), `ascending not in address: ${p.url()}`);
  await sort.click(); await p.locator('.ant-dropdown-menu-item', { hasText: 'Next PMS' }).click(); await settle(p);
  expect(/sortBy=nextPmsDue&order=desc/.test(p.url()), `descending not in address: ${p.url()}`);
  await s.ctx.close();
});

await step('Light / dark choice in the account menu is applied at once and kept after a reload', async () => {
  const s = await session(b, 'biomed@demo.local'); const p = s.page;
  const mode = () => p.evaluate(() => document.documentElement.dataset.theme);
  const choose = async (label) => { await p.getByTestId('account-menu').click(); await p.locator('.ant-dropdown-menu-item', { hasText: label }).click(); await p.waitForTimeout(300); };
  await choose('Dark'); expect((await mode()) === 'dark', 'dark not applied');
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg === 'rgb(13, 20, 19)', `page background in dark mode: ${bg}`);
  await p.reload(); await settle(p); expect((await mode()) === 'dark', 'dark not kept after reload');
  await choose('Light'); expect((await mode()) === 'light', 'light not applied');
  await choose('Same as this device'); expect((await p.evaluate(() => localStorage.getItem('bme-theme'))) === null, 'device choice still stored');
  await s.ctx.close();
});

// Dark mode: the screens each role can open pass the serious/critical accessibility checks, contrast included.
const probe = await session(b, 'admin@demo.local');
const asset = (await probe.api('GET', '/assets?pageSize=1')).body.items[0];
await probe.ctx.close();
const DARK = { admin: ['/', '/assets', `/assets/${asset.id}`, '/assets/new', `/assets/${asset.id}/pms/new`, '/complaints', '/due', '/approvals', '/reports', '/reports/breakdowns', '/admin/users', '/admin/audit', '/admin/settings'], nursing: ['/', '/assets', `/assets/${asset.id}`, '/complaints'] };
for (const [role, routes] of Object.entries(DARK)) {
  const s = await session(b, `${role}@demo.local`); const p = s.page;
  await p.evaluate(() => localStorage.setItem('bme-theme', 'dark'));
  for (const route of routes) {
    await step(`${role} dark ${route.replace(/[0-9a-f-]{36}/g, ':id')}: accessible, contrast included`, async () => {
      await p.goto(BASE + route); await settle(p);
      await p.locator('h1').first().waitFor({ timeout: 8000 }).catch(() => undefined);
      expect((await p.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'not in dark mode');
      await p.addScriptTag({ content: axeSrc });
      const v = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}(${x.nodes.length}: ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' / ')})`));
      expect(v.length === 0, `accessibility: ${v.join(', ')}`);
    }, p);
  }
  await s.ctx.close();
}

await b.close();
summary();
