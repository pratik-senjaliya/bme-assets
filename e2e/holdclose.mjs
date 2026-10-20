// The complaint workflow from the October meeting: the engineer escalates (needs OEM support), the HOD puts it on
// hold with a note, the engineer resolves it straight from on hold, and the nurse who raised it closes it from
// Today. Everything it creates is named E2E-…
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const nurse = await session(b, 'nursing@demo.local');
const [types, depts, locs] = await Promise.all(['/equipment-types', '/departments', '/locations'].map(async (p) => (await admin.api('GET', p)).body));
const vent = types.find((t) => t.code === 'VENT').id, icu = depts.find((d) => d.code === 'ICU').id, icu1 = locs.find((l) => l.code === 'ICU1').id;
const asset = (await admin.api('POST', '/assets', { equipmentTypeId: vent, name: 'E2E-Hold vent', departmentId: icu, locationId: icu1 })).body;
const c = (await nurse.api('POST', '/complaints', { assetId: asset.id, description: 'E2E pressure alarm keeps sounding' })).body;
await biomed.api('POST', `/complaints/${c.id}/start`);
const card = (scope, page = scope) => scope.locator('.ant-card', { has: page.locator('.code', { hasText: c.complaintNo }) }).last();
const dialog = (p) => p.locator('.ant-modal:visible');

await step('Engineer escalates from My work with a reason', async () => {
  const p = biomed.page;
  await p.goto(BASE + '/my-work'); await settle(p);
  await card(p).getByRole('button', { name: 'Escalate' }).click();
  expect((await dialog(p).locator('textarea').inputValue()) === 'Needs OEM support', 'no suggested reason');
  await dialog(p).locator('.ant-modal-footer .ant-btn-primary').click();
  await p.locator('.ant-message-success').first().waitFor(); await settle(p);
  expect(/Escalated to the HOD/.test(await card(p).innerText()), 'card does not say it is escalated');
  expect((await card(p).getByRole('button', { name: 'Escalate' }).count()) === 0, 'Escalate still offered');
}, biomed.page);

await step('HOD finds it under "Escalated to you" and puts it on hold with a note', async () => {
  const p = admin.page;
  await p.goto(BASE + '/my-work'); await settle(p);
  const sec = p.locator('section', { has: p.getByRole('heading', { name: 'Escalated to you' }) });
  await card(sec, p).getByRole('button', { name: 'Put on hold' }).click();
  await dialog(p).locator('textarea').fill('Company engineer will attend in two days with the spare part');
  await dialog(p).locator('.ant-modal-footer .ant-btn-primary').click();
  await p.locator('.ant-message-success').first().waitFor();
  await p.goto(BASE + '/complaints'); await settle(p);
  const held = p.locator('.ant-card', { has: p.getByText('On hold', { exact: true }) }).first();
  expect(/two days with the spare part/.test(await card(held, p).innerText()), 'On hold column does not show it with its note');
}, admin.page);

await step('Engineer resolves it straight from on hold', async () => {
  const p = biomed.page;
  await p.goto(BASE + '/complaints'); await settle(p);
  await card(p).getByRole('button', { name: 'Resolve' }).click();
  await dialog(p).locator('textarea').fill('OEM engineer replaced the flow sensor');
  await p.getByRole('button', { name: 'Mark resolved' }).click();
  await p.locator('.ant-message-success').first().waitFor(); await settle(p);
  expect(/Waiting for .* to close/.test(await card(p).innerText()), 'resolved card does not say it waits for the raiser');
}, biomed.page);

await step('Nurse closes it from Today; the history shows every step', async () => {
  const p = nurse.page;
  await p.goto(BASE + '/'); await settle(p);
  const box = p.locator('.ant-card', { hasText: 'Fixed: please check and close' });
  const row = box.locator('.ant-card-body > div', { hasText: c.complaintNo });
  await row.getByRole('button', { name: 'Close complaint' }).click();
  await dialog(p).locator('textarea').fill('Working fine');
  await dialog(p).locator('.ant-modal-footer .ant-btn-primary').click();
  await p.locator('.ant-message-success').first().waitFor(); await settle(p);
  expect((await p.locator('.code', { hasText: c.complaintNo }).count()) === 0, 'still listed as waiting to close');
  const d = (await nurse.api('GET', `/complaints/${c.id}`)).body;
  expect(d.status === 'closed', `status ${d.status}`);
  const kinds = d.events.map((e) => e.kind).filter((k) => !['document', 'expense', 'assigned'].includes(k)).join(',');
  expect(kinds === 'raised,started,escalated,held,resolved,closed', `history ${kinds}`);
}, nurse.page);

await b.close();
summary();
