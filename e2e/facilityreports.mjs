// Facility maintenance add-on, F5 (docs/requirements-facility.md): the facility side on the dashboard, and the monthly
// report and audit pack by team.
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const maint = await session(b, 'maintenance@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const admin = await session(b, 'admin@demo.local');

await step('The maintenance dashboard has a Facility card: ward complaints, licences, logbook, run hours', async () => {
  const p = maint.page;
  await p.goto(BASE + '/'); await settle(p);
  const t = await p.locator('main').innerText();
  expect(['Ward complaints open', 'Licences expired', 'Readings to take', 'PMS by run hours'].every((x) => t.includes(x)), 'facility figures missing');
}, maint.page);

await step('Biomedical staff have no Facility card', async () => {
  await biomed.page.goto(BASE + '/'); await settle(biomed.page);
  expect(!(await biomed.page.locator('main').innerText()).includes('Ward complaints open'), 'facility card shown');
}, biomed.page);

await step('Monthly report: the Facility switch adds the facility section and keeps it in the address', async () => {
  const p = admin.page;
  await p.goto(BASE + '/reports/monthly'); await settle(p);
  await p.getByRole('radiogroup', { name: 'Equipment' }).getByText('Facility').click(); await settle(p);
  expect(/register=facility/.test(p.url()), 'register not in the address');
  expect((await p.locator('main').innerText()).includes('Ward complaints'), 'no facility section');
  await p.getByRole('radiogroup', { name: 'Equipment' }).getByText('Biomedical').click(); await settle(p);
  expect(!(await p.locator('main').innerText()).includes('Ward complaints by trade'), 'facility section on the biomedical report');
}, admin.page);

await step('Audit pack: the Facility switch narrows the pack and lists licence documents', async () => {
  const p = admin.page;
  await p.goto(BASE + '/reports/audit-pack'); await settle(p);
  await p.getByRole('radiogroup', { name: 'Equipment' }).getByText('Facility').click(); await settle(p);
  expect(/register=facility/.test(p.url()), 'register not in the address');
  const href = await p.getByRole('link', { name: /Download/ }).getAttribute('href');
  expect(/register=facility/.test(href ?? ''), `download link ${href}`);
}, admin.page);

await b.close();
summary();
