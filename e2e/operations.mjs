// Gap review, batch 4a (operations): the version is shown, Hospital settings shows how the server is doing, QR labels
// follow the address set there, and the HOD can make a biomedical engineer deputy HOD. Settings are put back at the end.
import { BASE, launch, session, step, expect, summary, fillField } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const ap = admin.page;

await step('The version shows in the account menu and on the sign-in page', async () => {
  await ap.goto(BASE + '/'); await settle(ap);
  await ap.locator('[data-testid="account-menu"]').click();
  await ap.getByText(/^Version \d+\.\d+\.\d+$/).waitFor();
  await ap.keyboard.press('Escape');
  const ctx = await b.newContext(); const p = await ctx.newPage();
  await p.goto(BASE + '/login');
  expect(/Version \d+\.\d+\.\d+/.test(await p.locator('body').innerText()), 'no version on the sign-in page');
  await ctx.close();
}, ap);

await step('Hospital settings shows the version, the daily check and free space', async () => {
  await ap.goto(BASE + '/admin/settings'); await settle(ap);
  const card = await ap.locator('.ant-card', { hasText: 'Daily check last ran' }).innerText();
  expect(/Version/.test(card) && /Free space for documents/.test(card), `System card: ${card.replace(/\s+/g, ' ')}`);
}, ap);

await step('QR labels point at the address set in Hospital settings', async () => {
  await ap.goto(BASE + '/admin/settings'); await settle(ap);
  await fillField(ap, 'Address on QR labels', 'http://bme.e2e.local');
  await ap.getByRole('button', { name: /^Save/ }).first().click();
  await ap.locator('.ant-message-success').first().waitFor();
  await ap.goto(BASE + '/assets/labels?pageSize=3'); await settle(ap);
  const url = await ap.locator('.qr-label').first().getAttribute('data-url');
  expect(url?.startsWith('http://bme.e2e.local/q/'), `label links to ${url}`);
  expect(/bme\.e2e\.local \(set in Hospital settings\)/.test(await ap.locator('main').innerText()), 'the page does not say where labels point');
}, ap);
await admin.api('PUT', '/settings', { labelBaseUrl: '' });

await step('The HOD makes a biomedical engineer deputy HOD; it shows in the list', async () => {
  await ap.goto(BASE + '/admin/users'); await settle(ap);
  const row = ap.locator('tr', { hasText: 'biomed@demo.local' });
  await row.getByRole('button', { name: 'Edit' }).click();
  const m = ap.locator('.ant-modal:visible');
  await m.getByRole('switch', { name: 'Deputy HOD' }).click();
  await m.getByRole('button', { name: 'Save' }).click();
  await ap.locator('.ant-message-success').first().waitFor(); await settle(ap);
  expect(/Deputy HOD/.test(await ap.locator('tr', { hasText: 'biomed@demo.local' }).innerText()), 'no Deputy HOD mark');
}, ap);
// Put the demo engineer back as they were.
const biomed = (await admin.api('GET', '/users')).body.find((u) => u.email === 'biomed@demo.local');
await admin.api('PATCH', `/users/${biomed.id}`, { name: biomed.name, email: biomed.email, role: 'biomed', deputy: false });

await b.close();
summary();
