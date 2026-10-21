// Consumables (step 6): an engineer adds an item with what is on the shelf, records a stock in, gives some out for a
// machine from the asset page, sees it run low, and finds it in the register. Everything it creates is named E2E-…
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const [types, depts, locs] = await Promise.all(['/equipment-types', '/departments', '/locations'].map(async (p) => (await admin.api('GET', p)).body));
const vent = types.find((t) => t.code === 'VENT').id, icu = depts.find((d) => d.code === 'ICU').id, icu1 = locs.find((l) => l.code === 'ICU1').id;
const asset = (await admin.api('POST', '/assets', { equipmentTypeId: vent, name: 'E2E-Consumable vent', departmentId: icu, locationId: icu1 })).body;
const item = `E2E-SpO2 probe ${Date.now().toString(36)}`;
const dlg = (p) => p.locator('.ant-modal:visible');

await step('Consumables: add an item with what is on the shelf', async () => {
  const p = biomed.page;
  await p.goto(BASE + '/consumables'); await settle(p);
  await p.getByRole('button', { name: 'Add item' }).click();
  await dlg(p).getByLabel('Item').fill(item);
  await dlg(p).getByLabel('Reorder at').fill('2');
  await dlg(p).getByLabel('Unit cost (optional)').fill('450');
  await dlg(p).getByLabel('In stock today').fill('3');
  await dlg(p).getByRole('button', { name: 'Save' }).click();
  await p.waitForURL(/\/consumables\/[0-9a-f-]{36}/); await settle(p);
  const t = await p.locator('main').innerText();
  expect(t.includes(item) && /3 pcs/.test(t) && /Opening stock/.test(t), 'item page does not show the opening stock');
}, biomed.page);

await step('Stock in adds to it', async () => {
  const p = biomed.page;
  await p.getByRole('button', { name: 'Stock in' }).click();
  await dlg(p).getByLabel(/^Quantity/).fill('2');
  await dlg(p).getByLabel('Invoice / PO no.').fill('E2E-INV-1');
  await dlg(p).getByRole('button', { name: 'Add to stock' }).click();
  await p.locator('.ant-message-success').first().waitFor(); await settle(p);
  expect(/5 pcs/.test(await p.locator('main').innerText()), 'stock is not 5 after stock in');
}, biomed.page);

await step('Asset page: give one out for this machine; it runs low and the timeline shows it', async () => {
  const p = biomed.page;
  await p.goto(`${BASE}/assets/${asset.id}`); await settle(p);
  await p.getByRole('button', { name: 'More' }).click();
  await p.locator('.ant-dropdown-menu-item', { hasText: 'Give out a consumable' }).click();
  await dlg(p).getByLabel('Item').click();
  await p.keyboard.type(item.slice(0, 18));
  await p.locator('.ant-select-item-option', { hasText: item }).click();
  await dlg(p).getByLabel(/^Quantity/).fill('3');
  await dlg(p).getByLabel('Reason').fill('E2E: replaced the broken probe');
  await dlg(p).getByRole('button', { name: 'Give out' }).click();
  await p.locator('.ant-message-success').first().waitFor();
  await p.goto(`${BASE}/assets/${asset.id}?tab=timeline`); await settle(p);
  expect(/Given: 3 pcs E2E-SpO2 probe/.test(await p.locator('main').innerText()), 'not on the machine timeline');
  const row = (await biomed.api('GET', '/consumables?low=true')).body.find((r) => r.name === item);
  expect(row && row.stock === 2, 'not low at 2');
}, biomed.page);

await step('My work lists it under Low stock; the register shows what was given', async () => {
  const p = biomed.page;
  await p.goto(BASE + '/my-work'); await settle(p);
  expect((await p.locator('main').innerText()).includes(item), 'not under Low stock on My work');
  await p.goto(BASE + '/reports/consumables'); await settle(p);
  const t = await p.locator('main').innerText();
  expect(t.includes(item) && /replaced the broken probe/.test(t), 'not in the register');
}, biomed.page);

await b.close();
summary();
