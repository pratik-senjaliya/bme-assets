// Facility maintenance add-on, F2 (docs/requirements-facility.md): the ward reports something that is not a machine,
// it reaches the maintenance board as "trade · place", trades and medical gases are set up by the HOD, and the trades
// report lists it. Needs the add-on on (the demo seed turns it on). Everything it creates is named E2E…
import { BASE, launch, session, step, expect, summary, pick } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const maint = await session(b, 'maintenance@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const nurse = await session(b, 'nursing@demo.local');
const card = (p, no) => p.locator('.ant-card', { has: p.locator('.code', { hasText: no }) }).last();
let cmp = null;

await step('The ward raises "Something else in the ward": a trade and a place, no machine', async () => {
  const p = nurse.page;
  await p.goto(BASE + '/complaints'); await settle(p);
  await p.getByRole('button', { name: 'Raise complaint' }).first().click();
  const dlg = p.locator('.ant-modal');
  await dlg.getByText('Something else in the ward').click();
  await dlg.locator('.ant-form-item', { hasText: 'What kind of problem' }).locator('.ant-select').click();
  await p.keyboard.type('Plumb'); // the list is longer than the dropdown: search it
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'Plumbing and water' }).click();
  await pick(p, 'Where', 'ICU 1', dlg);
  await dlg.locator('textarea').fill('E2E tap leaking next to bed 4');
  await dlg.locator('.ant-modal-footer .ant-btn-primary').click();
  await p.locator('.ant-message-success', { hasText: /Complaint CMP-\d+ raised/ }).waitFor();
  cmp = (await admin.api('GET', '/complaints?search=E2E%20tap%20leaking&pageSize=5')).body.items[0];
  expect(cmp && cmp.assetId === null && cmp.register === 'facility', `saved as ${JSON.stringify(cmp && { asset: cmp.assetId, register: cmp.register })}`);
}, nurse.page);

await step('It is on the maintenance board as trade and place, not on the biomedical one', async () => {
  const p = maint.page;
  await p.goto(BASE + '/complaints'); await settle(p);
  const t = await card(p, cmp.complaintNo).innerText();
  expect(t.includes('Plumbing and water') && t.includes('ICU 1') && t.includes('No machine'), `card reads: ${t.replace(/\s+/g, ' ').slice(0, 160)}`);
  await biomed.page.goto(BASE + '/complaints'); await settle(biomed.page);
  expect(!(await card(biomed.page, cmp.complaintNo).count()), 'on the biomedical board');
}, maint.page);

await step('Maintenance starts and resolves it; the card shows how long it took, not downtime', async () => {
  const p = maint.page;
  await card(p, cmp.complaintNo).getByRole('button', { name: 'Start work' }).click();
  await p.locator('.ant-modal', { hasText: `Start work · ${cmp.complaintNo}` }).getByRole('button', { name: 'Start work' }).click();
  await card(p, cmp.complaintNo).getByRole('button', { name: 'Resolve' }).waitFor();
  await card(p, cmp.complaintNo).getByRole('button', { name: 'Resolve' }).click();
  const dlg = p.locator('.ant-modal', { hasText: `Resolve ${cmp.complaintNo}` });
  expect(/resolution clock/.test(await dlg.innerText()), 'resolve dialog talks about downtime');
  // Parts and bills can be booked on a ward fault too (they go on the complaint, which has no machine).
  expect((await dlg.getByRole('button', { name: /Add a part or cost/ }).count()) === 1, 'no way to book a cost on a ward fault');
  await dlg.locator('textarea').fill('Washer replaced');
  await dlg.getByRole('button', { name: 'Mark resolved' }).click();
  await dlg.waitFor({ state: 'hidden' }); // closes once saved (the start's toast may still be showing)
  const done = (await maint.api('GET', `/complaints/${cmp.id}`)).body;
  expect(done.status === 'resolved' && done.downtimeSeconds === null && done.resolutionSeconds != null, `status ${done.status}, downtime ${done.downtimeSeconds}`);
}, maint.page);

await step('Admin > Trades lists the trades with their team; Medical gas goes to biomedical', async () => {
  const p = admin.page;
  await p.goto(BASE + '/admin/trades'); await settle(p);
  expect(/Biomedical team/.test(await p.locator('tr', { hasText: 'Medical gas' }).first().innerText()), 'Medical gas row');
  expect(/Maintenance team/.test(await p.locator('tr', { hasText: 'Electrical' }).innerText()), 'Electrical row');
}, admin.page);

await step('Hospital settings: who looks after medical gases, and the maintenance contact', async () => {
  const p = admin.page;
  await p.goto(BASE + '/admin/settings'); await settle(p);
  const t = await p.locator('main').innerText();
  expect(t.includes('Medical gases are looked after by') && t.includes('Maintenance contact for the wards'), 'fields missing');
}, admin.page);

await step('Equipment types mark medical gas equipment', async () => {
  const p = admin.page;
  await p.goto(BASE + '/admin/equipment-types'); await settle(p);
  expect(/Medical gas/.test(await p.locator('tr', { hasText: 'Oxygen Plant' }).innerText()), 'no Medical gas mark on Oxygen Plant');
}, admin.page);

await step('Reports: "Ward complaints by trade" lists it', async () => {
  const p = admin.page;
  await p.goto(BASE + '/reports'); await settle(p);
  await p.getByRole('link', { name: /Ward complaints by trade/ }).click();
  await settle(p);
  expect((await p.locator('main').innerText()).includes('Plumbing and water'), 'no Plumbing and water row');
  await p.getByRole('tab', { name: /^Complaints/ }).click();
  expect((await p.locator('main').innerText()).includes(cmp.complaintNo), 'report does not list the complaint');
}, admin.page);

await step('The ward’s Today page shows the maintenance number next to the biomedical one', async () => {
  const before = (await admin.api('GET', '/settings')).body.facilityContact;
  await admin.api('PUT', '/settings', { facilityContact: 'E2E maintenance 300' });
  try {
    await nurse.page.goto(BASE + '/'); await settle(nurse.page);
    expect((await nurse.page.locator('main').innerText()).includes('maintenance: E2E maintenance 300'), 'no maintenance contact');
  } finally {
    await admin.api('PUT', '/settings', { facilityContact: before });
  }
}, nurse.page);

await b.close();
summary();
