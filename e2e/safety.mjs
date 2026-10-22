// Gap review, batch 1 (safety): a failed PMS flags the machine and leads to a complaint; an urgent complaint marks it
// out of service in lists and on the ward's Today page; the biomedical contact reaches the ward; an idle shared PC
// signs itself out. Everything it creates is named E2E-…; settings are put back at the end.
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const nurse = await session(b, 'nursing@demo.local');
const [types, depts, locs] = await Promise.all(['/equipment-types', '/departments', '/locations'].map(async (p) => (await admin.api('GET', p)).body));
const vent = types.find((t) => t.code === 'VENT').id, icu = depts.find((d) => d.code === 'ICU').id, icu1 = locs.find((l) => l.code === 'ICU1').id;
const asset = (await admin.api('POST', '/assets', { equipmentTypeId: vent, name: 'E2E-Safety vent', departmentId: icu, locationId: icu1 })).body;
await admin.api('PUT', '/settings', { biomedContact: 'Biomedical on call: 98250 00000' });

// A PMS with one check failed (the rest pass, readings in range).
const template = (await biomed.api('GET', `/assets/${asset.id}/pms-template`)).body;
const answers = Object.fromEntries(template.items.filter((i) => i.type !== 'text').map((i, k) => [i.id, i.type === 'check' ? (k === 0 ? 'fail' : 'pass') : (i.min + i.max) / 2]));
const failed = await biomed.api('POST', `/assets/${asset.id}/pms`, { answers });

await step('A failed PMS: the machine page says so and offers a complaint with the failed check filled in', async () => {
  expect(failed.status === 201 && failed.body.result === 'fail', `PMS not recorded as failed (${failed.status})`);
  const p = biomed.page;
  await p.goto(`${BASE}/assets/${asset.id}`); await settle(p);
  expect(/The last PMS failed/.test(await p.locator('main').innerText()), 'no failed-PMS banner');
  await p.getByRole('button', { name: 'Raise complaint' }).last().click();
  const dlg = p.locator('.ant-modal:visible');
  expect((await dlg.locator('textarea').inputValue()).startsWith('PMS failed on'), 'problem not filled in');
  await dlg.getByText('Urgent: the machine cannot be used').click();
  await dlg.getByRole('button', { name: 'Raise complaint' }).click();
  await p.locator('.ant-message-success').first().waitFor(); await settle(p);
  const t = await p.locator('main').innerText();
  expect(/Out of service/.test(t), 'no out-of-service banner after the urgent complaint');
}, biomed.page);

await step('The asset list marks it Out of service and PMS failed', async () => {
  const p = biomed.page;
  await p.goto(`${BASE}/assets?search=E2E-Safety`); await settle(p);
  const row = await p.locator('tr', { hasText: asset.assetCode }).innerText();
  expect(/Out of service/.test(row) && /PMS failed/.test(row), `pills missing: ${row.replace(/\s+/g, ' ')}`);
}, biomed.page);

await step('The ward sees it under "Not safe to use", and the number to call', async () => {
  const p = nurse.page;
  await p.goto(BASE + '/'); await settle(p);
  const t = await p.locator('main').innerText();
  expect(/Not safe to use/.test(t) && t.includes('E2E-Safety vent'), 'not listed as not safe to use');
  expect(t.includes('98250 00000'), 'no biomedical contact on Today');
}, nurse.page);

await step('An unused shared PC signs itself out and says why', async () => {
  await admin.api('PUT', '/settings', { idleLogoutMinutes: 1 });
  const p = nurse.page;
  await p.goto(BASE + '/assets'); await settle(p);
  await p.waitForURL(/\/login\?.*idle=1/, { timeout: 100_000 });
  await p.locator('text=This computer was not used for a while').waitFor();
}, nurse.page);

await admin.api('PUT', '/settings', { biomedContact: '', idleLogoutMinutes: 30 });
await b.close();
summary();
