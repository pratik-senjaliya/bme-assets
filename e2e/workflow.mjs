// Gap review, batch 3 (workflow): the ward sends back a complaint that is not fixed; costs are booked while resolving;
// a wrong calibration is corrected; Add asset records its purchase order; the audit log exports to Excel; "forgot
// password" reaches the HOD; Hospital settings shows the backups. Everything it creates is named E2E-….
import { BASE, launch, session, step, expect, summary, pick, fillField, fillDate, today, isoToday } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const nurse = await session(b, 'nursing@demo.local');
const [types, depts, locs] = await Promise.all(['/equipment-types', '/departments', '/locations'].map(async (p) => (await admin.api('GET', p)).body));
const vent = types.find((t) => t.code === 'VENT').id, icu = depts.find((d) => d.code === 'ICU').id, icu1 = locs.find((l) => l.code === 'ICU1').id;
const asset = (await admin.api('POST', '/assets', { equipmentTypeId: vent, name: 'E2E-Workflow vent', departmentId: icu, locationId: icu1 })).body;
const complaint = (await nurse.api('POST', '/complaints', { assetId: asset.id, description: 'E2E-Workflow alarm keeps sounding' })).body;
await biomed.api('POST', `/complaints/${complaint.id}/start`, {});

await step('Resolving books a part and its cost against the complaint', async () => {
  const p = biomed.page;
  await p.goto(`${BASE}/complaints?open=${complaint.id}`); await settle(p);
  await p.locator('.ant-drawer').getByRole('button', { name: 'Resolve' }).click();
  const m = p.locator('.ant-modal:visible');
  await m.locator('textarea').first().fill('Replaced the flow sensor');
  await m.getByRole('button', { name: 'Add a part or cost' }).click();
  await m.getByLabel('Amount (₹)').fill('4200');
  await m.getByLabel('What was paid for').fill('E2E flow sensor');
  await m.getByRole('button', { name: 'Mark resolved' }).click();
  await p.locator('.ant-message-success').first().waitFor(); await settle(p);
  const c = (await biomed.api('GET', `/complaints/${complaint.id}`)).body;
  expect(c.status === 'resolved', `status ${c.status}`);
  expect(c.expenses.length === 1 && c.expenses[0].amount === 4200, `expenses ${JSON.stringify(c.expenses)}`);
}, biomed.page);

await step('The ward says it is still not working: it goes back to the engineer', async () => {
  const p = nurse.page;
  await p.goto(`${BASE}/complaints`); await settle(p);
  const card = p.locator('.ant-card', { hasText: 'Fixed: please check and close' });
  await card.getByRole('button', { name: 'Still not working' }).first().click();
  const m = p.locator('.ant-modal:visible');
  await m.locator('textarea').fill('Alarm still sounds after ten minutes');
  await m.getByRole('button', { name: 'Send back to the engineer' }).click();
  await p.locator('.ant-message-success').first().waitFor();
  const c = (await biomed.api('GET', `/complaints/${complaint.id}`)).body;
  expect(c.status === 'in_progress' && !c.resolvedAt, `status ${c.status}`);
  expect(c.events.some((e) => e.kind === 'reopened') && c.events.some((e) => e.kind === 'resolved'), 'history lost a step');
}, nurse.page);

await step('A wrong calibration is corrected; the original stays, marked', async () => {
  await biomed.api('POST', `/assets/${asset.id}/calibrations`, { doneOn: isoToday(), agency: 'E2E Cal Lab', result: 'fail' });
  const p = biomed.page;
  await p.goto(`${BASE}/assets/${asset.id}?tab=calibration`); await settle(p);
  await p.getByRole('button', { name: 'Correct' }).first().click();
  const m = p.locator('.ant-modal:visible');
  await fillField(p, 'Why is it being corrected', 'Result entered wrongly', m);
  await pick(p, 'Result', 'Pass', m);
  await m.getByRole('button', { name: 'Save' }).click();
  await p.locator('.ant-message-success', { hasText: 'Correction saved' }).waitFor(); await settle(p);
  expect(/Replaced by a correction/.test(await p.locator('main').innerText()), 'the original is not marked');
  expect(!(await biomed.api('GET', `/assets/${asset.id}`)).body.calibrationFailedOn, 'still flagged as failed');
}, biomed.page);

await step('Add asset records its purchase order', async () => {
  const p = biomed.page;
  await p.goto(BASE + '/assets/new'); await settle(p);
  await pick(p, 'Equipment type', 'Ventilator'); await fillField(p, 'Name', 'E2E-Workflow PO');
  await pick(p, 'Department', 'Intensive Care Unit'); await pick(p, 'Location', 'ICU 1');
  await fillField(p, 'PO number', 'E2E/PO/1'); await fillDate(p, 'PO date', today());
  await fillField(p, 'Vendor', 'E2E Medi Supplies'); await fillField(p, 'Cost', '850000');
  await p.getByRole('button', { name: 'Create asset' }).click();
  await p.waitForURL(/\/assets\/[0-9a-f-]{36}$/);
  const id = p.url().split('/').pop();
  const pos = (await biomed.api('GET', `/assets/${id}/purchase-orders`)).body;
  expect(pos.length === 1 && pos[0].poNumber === 'E2E/PO/1' && pos[0].cost === 850000, `POs ${JSON.stringify(pos)}`);
}, biomed.page);

await step('The audit log exports what the filters show to Excel', async () => {
  const p = admin.page;
  await p.goto(BASE + '/admin/audit'); await settle(p);
  const [download] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Export to Excel' }).click()]);
  expect(/^bme-audit-log.*\.xlsx$/.test(download.suggestedFilename()), `file ${download.suggestedFilename()}`);
}, admin.page);

await step('"Forgot password" on the sign-in page tells the HOD', async () => {
  const ctx = await b.newContext(); const p = await ctx.newPage(); p.setDefaultTimeout(20000);
  await p.goto(BASE + '/login');
  await p.getByRole('button', { name: 'Ask your HOD for a new one' }).click();
  const m = p.locator('.ant-modal:visible');
  await m.locator('input').fill('nursing@demo.local');
  await m.getByRole('button', { name: 'Ask the HOD' }).click();
  await m.getByText('The Biomedical HOD has been told').waitFor();
  const bell = (await admin.api('GET', '/notifications')).body.items;
  expect(bell.some((n) => n.type === 'account' && /forgot their password/.test(n.message)), 'the HOD was not told');
  await ctx.close();
});

await step('Hospital settings shows the backups', async () => {
  const p = admin.page;
  await p.goto(BASE + '/admin/settings'); await settle(p);
  expect(/Backups/.test(await p.locator('main').innerText()), 'no Backups section');
}, admin.page);

await b.close();
summary();
