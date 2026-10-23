// Gap review, batch 4b: the management reports open from Reports, users can be imported from Excel, and the asset
// form takes the hospital's tag no and a machine's own calibration interval. Everything it creates is named E2E-….
import { BASE, launch, session, step, expect, summary, pick, fillField } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const ap = admin.page;

for (const [title, heading] of [['Engineer performance', 'Engineers'], ['Supplier performance', 'Suppliers'], ['Replacement and renewals', 'Equipment to consider replacing']]) {
  await step(`Reports: "${title}" opens with its table`, async () => {
    await ap.goto(BASE + '/reports'); await settle(ap);
    await ap.getByRole('link', { name: new RegExp(title) }).click();
    await settle(ap);
    const t = await ap.locator('main').innerText();
    expect(t.includes(title) && t.includes(heading), `page shows: ${t.slice(0, 200).replace(/\s+/g, ' ')}`);
  }, ap);
}

await step('Users: Import from Excel leads to the import page with its template', async () => {
  await ap.goto(BASE + '/admin/users'); await settle(ap);
  await ap.getByRole('link', { name: 'Import from Excel' }).click();
  await ap.waitForURL(/\/admin\/users\/import/); await settle(ap);
  const href = await ap.getByRole('link', { name: /Download template/ }).getAttribute('href');
  expect(href === '/api/v1/users/import/template', `template link ${href}`);
  const res = await admin.api('GET', '/users/import/template');
  expect(res.status === 200, `template ${res.status}`);
}, ap);

await step('Add asset takes the hospital tag no and its own calibration interval', async () => {
  await ap.goto(BASE + '/assets/new'); await settle(ap);
  // The HOD sees both teams' types: search the list rather than scroll it.
  await ap.locator('.ant-form-item', { hasText: 'Equipment type' }).locator('.ant-select').first().click();
  await ap.keyboard.type('Ventil');
  await ap.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'Ventilator' }).first().click();
  await fillField(ap, 'Name', 'E2E-Register vent');
  await pick(ap, 'Department', 'Intensive Care Unit'); await pick(ap, 'Location', 'ICU 1');
  await fillField(ap, 'Hospital tag no', 'E2E/TAG/1');
  await fillField(ap, 'Calibration every', '6');
  await ap.getByRole('button', { name: 'Create asset' }).click();
  await ap.waitForURL(/\/assets\/[0-9a-f-]{36}$/); await settle(ap);
  const t = await ap.locator('main').innerText();
  expect(t.includes('E2E/TAG/1') && /Every 6 months \(this machine\)/.test(t), 'tag no or interval not shown');
}, ap);

await b.close();
summary();
