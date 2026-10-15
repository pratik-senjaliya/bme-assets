// Assigning complaints and "My work": the HOD assigns from the board, the engineer finds it under "Assigned to me",
// takes an unassigned one, and the nurse who raised it sees who has it. Everything it creates is named E2E-…
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const nurse = await session(b, 'nursing@demo.local');
const [types, depts, locs] = await Promise.all(['/equipment-types', '/departments', '/locations'].map(async (p) => (await admin.api('GET', p)).body));
const vent = types.find((t) => t.code === 'VENT').id, icu = depts.find((d) => d.code === 'ICU').id, icu1 = locs.find((l) => l.code === 'ICU1').id;
const asset = (await admin.api('POST', '/assets', { equipmentTypeId: vent, name: 'E2E-Assign vent', departmentId: icu, locationId: icu1 })).body;
const raise = async (text) => (await nurse.api('POST', '/complaints', { assetId: asset.id, description: `E2E ${text}` })).body;
const first = await raise('display flickers');
const second = await raise('alarm does not stop');
const me = (await biomed.api('GET', '/auth/me')).body;
// The card of one complaint inside `scope` (the page, or one section of it).
const card = (scope, no, page = scope) => scope.locator('.ant-card', { has: page.locator('.code', { hasText: no }) }).last();

await step('HOD assigns a complaint from the board; the engineer is told', async () => {
  const p = admin.page;
  await p.goto(BASE + '/complaints'); await settle(p);
  await card(p, first.complaintNo).getByRole('button', { name: 'Assign' }).click();
  const dlg = p.locator('.ant-modal', { hasText: `Assign ${first.complaintNo}` });
  await dlg.locator('.ant-select').click(); await p.locator('.ant-select-item-option', { hasText: me.name }).first().click();
  await dlg.locator('.ant-modal-footer .ant-btn-primary').click(); await p.locator('.ant-message-success').first().waitFor();
  await settle(p);
  expect(/Assigned to/.test(await card(p, first.complaintNo).innerText()), 'card does not show the assignee');
  const bell = (await biomed.api('GET', '/notifications')).body;
  const items = Array.isArray(bell) ? bell : bell.items ?? [];
  expect(items.some((n) => n.message.includes(`${first.complaintNo} assigned to you`)), 'engineer was not told');
}, admin.page);

await step('Engineer: My work lists it under "Assigned to me"; "Take it" moves another one there', async () => {
  const p = biomed.page;
  await p.goto(BASE + '/my-work'); await settle(p);
  const mineSec = p.locator('section', { has: p.getByRole('heading', { name: 'Assigned to me' }) });
  const freeSec = p.locator('section', { has: p.getByRole('heading', { name: 'Waiting for someone' }) });
  expect(await card(mineSec, first.complaintNo, p).isVisible(), 'assigned complaint not under "Assigned to me"');
  await card(freeSec, second.complaintNo, p).getByRole('button', { name: 'Take it' }).click();
  await p.locator('.ant-message-success').first().waitFor(); await settle(p);
  expect(await card(mineSec, second.complaintNo, p).isVisible(), 'taken complaint not under "Assigned to me"');
  expect((await card(freeSec, second.complaintNo, p).count()) === 0, 'taken complaint still waiting');
}, biomed.page);

await step('Nurse who raised it sees who has it', async () => {
  const p = nurse.page;
  await p.goto(BASE + '/complaints'); await settle(p);
  await p.getByRole('button', { name: first.complaintNo }).first().click(); await settle(p);
  const drawer = p.locator('.ant-drawer');
  expect(new RegExp(`Assigned to\\s*${me.name}`).test(await drawer.innerText()), 'assignee not shown to the nurse');
  expect((await drawer.getByRole('button', { name: /Assign|Take it|Start work/ }).count()) === 0, 'work buttons shown to a nurse');
}, nurse.page);

await step('Menus: My work for the people who fix things, not for nursing', async () => {
  expect(await biomed.page.locator('.ant-menu-item', { hasText: 'My work' }).count() === 1, 'no My work for the engineer');
  await nurse.page.goto(BASE + '/'); await settle(nurse.page);
  expect((await nurse.page.locator('.ant-menu-item', { hasText: 'My work' }).count()) === 0, 'My work shown to nursing');
});

await b.close();
summary();
