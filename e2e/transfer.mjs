// Transferring equipment to another unit (decision E): the HOD turns transfers on in Hospital settings, an engineer
// asks from the asset's More menu, the HOD approves, and the asset page says where it went. Turns transfers off again
// at the end. Everything it creates is named E2E-…
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const [types, depts, locs] = await Promise.all(['/equipment-types', '/departments', '/locations'].map(async (p) => (await admin.api('GET', p)).body));
const vent = types.find((t) => t.code === 'VENT').id, icu = depts.find((d) => d.code === 'ICU').id, icu1 = locs.find((l) => l.code === 'ICU1').id;
const asset = (await admin.api('POST', '/assets', { equipmentTypeId: vent, name: 'E2E-Transfer vent', departmentId: icu, locationId: icu1 })).body;
const switchOn = (p) => p.getByRole('switch', { name: 'Allow transfers to other units' });

await step('Hospital settings: the HOD turns transfers on', async () => {
  const p = admin.page;
  await p.goto(BASE + '/admin/settings'); await settle(p);
  if ((await switchOn(p).getAttribute('aria-checked')) !== 'true') await switchOn(p).click();
  await p.getByRole('button', { name: /^Save/ }).first().click();
  await p.locator('.ant-message-success').first().waitFor();
  expect((await admin.api('GET', '/hospital')).body.transfersEnabled === true, 'transfers not on');
}, admin.page);

await step('Engineer asks to transfer it from the More menu; nothing changes until approval', async () => {
  const p = biomed.page;
  await p.goto(`${BASE}/assets/${asset.id}`); await settle(p);
  await p.getByRole('button', { name: 'More' }).click();
  await p.locator('.ant-dropdown-menu-item', { hasText: 'Request transfer to another unit' }).click();
  const dlg = p.locator('.ant-modal:visible');
  await dlg.getByLabel('Transfer to').fill('Indore unit');
  await dlg.locator('textarea').fill('E2E: second ventilator needed at Indore');
  await dlg.getByRole('button', { name: 'Send request' }).click();
  await p.locator('.ant-message-success').first().waitFor(); await settle(p);
  expect(/Transfer this asset to Indore unit/.test(await p.locator('main').innerText()), 'no "waiting for HOD" banner');
  expect((await biomed.api('GET', `/assets/${asset.id}`)).body.status === 'active', 'changed before approval');
}, biomed.page);

await step('HOD approves; the asset says where it went and is read-only', async () => {
  const p = admin.page;
  await p.goto(BASE + '/approvals'); await settle(p);
  const row = p.locator('tr, .ant-card').filter({ hasText: asset.assetCode }).filter({ has: p.getByRole('button', { name: 'Approve' }) }).last();
  await row.getByRole('button', { name: 'Approve' }).click();
  await p.locator('.ant-modal-footer .ant-btn-primary').click();
  await p.locator('.ant-message-success').first().waitFor();
  await p.goto(`${BASE}/assets/${asset.id}`); await settle(p);
  const t = await p.locator('main').innerText();
  expect(/Transferred to Indore unit/.test(t), 'no transferred banner');
  expect((await p.getByRole('button', { name: /Edit asset|Raise complaint/ }).count()) === 0, 'edit / complaint offered on a transferred asset');
}, admin.page);

// Leave the demo as it was.
const off = await admin.api('PUT', '/settings', { transfersEnabled: false });
if (off.status !== 200) console.log('Could not turn transfers off again:', off.status);
await b.close();
summary();
