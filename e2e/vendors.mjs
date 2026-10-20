// The suppliers list (step 5): an engineer adds a company with the people to call, picks it as the machine's supplier
// on the asset form, and the asset page shows who to call. Everything it creates is named E2E-…
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const [types, depts, locs] = await Promise.all(['/equipment-types', '/departments', '/locations'].map(async (p) => (await admin.api('GET', p)).body));
const vent = types.find((t) => t.code === 'VENT').id, icu = depts.find((d) => d.code === 'ICU').id, icu1 = locs.find((l) => l.code === 'ICU1').id;
const asset = (await admin.api('POST', '/assets', { equipmentTypeId: vent, name: 'E2E-Supplier vent', departmentId: icu, locationId: icu1 })).body;
const company = `E2E-Supplier ${Date.now().toString(36)}`;

await step('Suppliers: add a company with a contact', async () => {
  const p = biomed.page;
  await p.goto(BASE + '/vendors'); await settle(p);
  await p.getByRole('button', { name: 'Add company' }).click();
  const dlg = p.locator('.ant-modal:visible');
  await dlg.getByLabel('Company name').fill(company);
  await dlg.getByLabel('Phone', { exact: true }).fill('1800 100 200');
  await dlg.getByRole('button', { name: 'Add a contact' }).click();
  await dlg.getByLabel('Contact name').fill('Mr. A. Shah');
  await dlg.getByLabel('Contact role').fill('Service engineer');
  await dlg.getByLabel('Contact phone').fill('98250 12345');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await p.locator('.ant-message-success').first().waitFor(); await settle(p);
  await p.getByLabel('Search company or contact').fill('A. Shah');
  const t = await p.locator('main').innerText();
  expect(t.includes(company) && /Mr\. A\. Shah/.test(t), 'company or contact not listed');
}, biomed.page);

await step('Asset form: choose it as the supplier; the asset page shows who to call', async () => {
  const p = biomed.page;
  await p.goto(`${BASE}/assets/${asset.id}/edit`); await settle(p);
  await p.getByLabel('Supplier', { exact: true }).click();
  await p.keyboard.type(company.slice(0, 16));
  await p.locator('.ant-select-item-option', { hasText: company }).click();
  await p.getByRole('button', { name: /^Save/ }).click();
  await p.waitForURL(new RegExp(`/assets/${asset.id}$`)); await settle(p);
  const t = await p.locator('main').innerText();
  expect(t.includes(`Supplier: ${company}`) || (t.includes('Supplier') && t.includes(company)), 'no supplier card');
  expect((await p.locator('a[href="tel:98250 12345"]').count()) === 1, 'contact phone is not a call link');
}, biomed.page);

await b.close();
summary();
