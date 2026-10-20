// Monthly report and audit pack: the HOD opens last month's report from the reports page (and from the bell when
// it was saved), picks another month, and downloads an audit pack whose ZIP holds the index and the reports.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
// jszip is an API dev dependency; resolve it from there.
const JSZip = createRequire(new URL('../apps/api/package.json', import.meta.url))('jszip');
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const nurse = await session(b, 'nursing@demo.local');

await step('Reports page leads to the monthly report; it shows the month with its figures and tables', async () => {
  const p = admin.page;
  await p.goto(BASE + '/reports'); await settle(p);
  await p.getByRole('link', { name: /Monthly report/ }).click(); await settle(p);
  expect(p.url().includes('/reports/monthly'), 'did not open the monthly report');
  const text = await p.locator('main').innerText();
  for (const t of ['Equipment uptime', 'Breakdowns', 'PMS on schedule', 'Service spend']) expect(text.includes(t), `no "${t}" figure`);
  expect((await p.getByRole('tab', { name: /Departments/ }).count()) === 1, 'no Departments table');
}, admin.page);

await step('Picking another month changes the report and the address', async () => {
  const p = admin.page;
  await p.goto(BASE + '/reports/monthly?month=2026-01'); await settle(p);
  expect(/January 2026/.test(await p.getByRole('textbox', { name: 'Month' }).inputValue()), 'month picker does not show January 2026');
  expect(/01 Jan 2026 to 31 Jan 2026/.test(await p.locator('main').innerText()), 'report is not for January 2026');
  await p.goto(BASE + '/reports/monthly?month=2999-01'); await settle(p);
  expect(!/2999/.test(await p.locator('main').innerText()), 'a future month was shown');
}, admin.page);

await step('A saved month: the bell notice opens it, marked as sent', async () => {
  const p = admin.page;
  const list = (await admin.api('GET', '/notifications')).body;
  const items = Array.isArray(list) ? list : list.items ?? [];
  const notice = items.find((n) => n.type === 'report');
  if (!notice) return; // Saved on start-up only when last month was not saved yet; nothing to follow otherwise.
  await p.goto(BASE + '/'); await settle(p);
  await p.getByRole('button', { name: /Reminders|Notifications/ }).first().click();
  await p.getByText(notice.message).first().click(); await settle(p);
  expect(p.url().includes(`month=${notice.dueDate.slice(0, 7)}`), 'bell did not open the saved month');
  expect(/Saved on/.test(await p.locator('main').innerText()), 'saved report not marked as sent');
}, admin.page);

await step('Audit pack: shows what it will hold, then downloads a ZIP with the index and the reports', async () => {
  const p = admin.page;
  await p.goto(BASE + '/reports'); await settle(p);
  await p.getByRole('link', { name: /Audit pack/ }).click(); await settle(p);
  expect(/Equipment in the inventory/.test(await p.locator('main').innerText()), 'no summary of the pack');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('link', { name: /Download audit pack/ }).click()]);
  expect(/^bme-audit-pack-.*\.zip$/.test(dl.suggestedFilename()), `odd file name ${dl.suggestedFilename()}`);
  const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
  const names = Object.keys(zip.files);
  for (const f of ['00 Index.pdf', '01 Equipment inventory.xlsx', '03 PMS checklists.pdf']) expect(names.includes(f), `${f} missing from the ZIP`);
}, admin.page);

await step('Audit pack: an inverted period says so instead of downloading', async () => {
  const p = admin.page;
  await p.goto(BASE + '/reports/audit-pack?from=2026-05-01&to=2026-04-01'); await settle(p);
  expect(/start date is after the end date/.test(await p.locator('main').innerText()), 'no message for an inverted period');
  expect((await p.getByRole('link', { name: /Download audit pack/ }).count()) === 0, 'download offered for an inverted period');
}, admin.page);

await step('Nursing cannot open either', async () => {
  for (const r of ['/reports/monthly', '/reports/audit-pack']) {
    await nurse.page.goto(BASE + r); await settle(nurse.page);
    expect(/You cannot see reports/.test(await nurse.page.locator('main').innerText()), `${r} not refused for nursing`);
  }
}, nurse.page);

await b.close();
summary();
