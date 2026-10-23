// Facility maintenance add-on, F1 (docs/requirements-facility.md): each team sees its own register, the ward's complaint
// reaches the right team, the HOD can look at one team at a time, and only the super admin switches the add-on.
// Needs the add-on on (the demo seed turns it on). Everything it creates is named E2E-…
import { BASE, launch, session, step, expect, summary } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const maint = await session(b, 'maintenance@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const nurse = await session(b, 'nursing@demo.local');
const sup = await session(b, 'superadmin@demo.local');
const [types, depts, locs] = await Promise.all(['/equipment-types', '/departments', '/locations'].map(async (p) => (await admin.api('GET', p)).body));
const id = (list, code) => list.find((x) => x.code === code).id;
const ahu = (await maint.api('POST', '/assets', { equipmentTypeId: id(types, 'AHU'), name: 'E2E-AHU ward', departmentId: id(depts, 'ICU'), locationId: id(locs, 'ICU1') })).body;
const vent = (await biomed.api('POST', '/assets', { equipmentTypeId: id(types, 'VENT'), name: 'E2E-Vent ward', departmentId: id(depts, 'ICU'), locationId: id(locs, 'ICU1') })).body;
const complaint = (await nurse.api('POST', '/complaints', { assetId: ahu.id, description: 'E2E AC not cooling' })).body;
const card = (scope, no, page = scope) => scope.locator('.ant-card', { has: page.locator('.code', { hasText: no }) }).last();
const listText = async (p, q) => { await p.goto(`${BASE}/assets?search=${encodeURIComponent(q)}`); await settle(p); return p.locator('main').innerText(); };
// Whether each of the two machines shows in someone's list (searched by name: other suites leave E2E- machines too).
const sees = async (p) => [(await listText(p, 'E2E-AHU ward')).includes(ahu.assetCode), (await listText(p, 'E2E-Vent ward')).includes(vent.assetCode)];

await step('Maintenance staff see facility equipment only, and add it from facility types', async () => {
  const p = maint.page;
  expect(String(await sees(p)) === 'true,false', 'the list mixes the teams');
  expect(!(await p.getByRole('combobox', { name: 'Equipment', exact: true }).count()), 'one team: no Equipment filter');
  await p.goto(BASE + '/assets/new'); await settle(p);
  await p.locator('.ant-form-item', { hasText: 'Equipment type' }).locator('.ant-select').first().click();
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'DG Set' }).waitFor();
  const options = await p.locator('.ant-select-dropdown .ant-select-item-option').allTextContents(); // the list stays in the page once opened
  expect(options.includes('DG Set') && !options.includes('Ventilator'), `types offered: ${options.join(', ')}`);
}, maint.page);

await step('Biomedical staff never see facility equipment or its complaints', async () => {
  const p = biomed.page;
  expect(String(await sees(p)) === 'false,true', 'the list mixes the teams');
  await p.goto(BASE + '/complaints'); await settle(p);
  expect(!(await card(p, complaint.complaintNo).count()), 'the facility complaint is on the biomedical board');
}, biomed.page);

await step('The ward sees both in its department', async () => {
  expect(String(await sees(nurse.page)) === 'true,true', 'the ward misses one team’s equipment');
}, nurse.page);

await step('The ward’s complaint reaches the maintenance board; the HOD offers it to maintenance staff only', async () => {
  const p = maint.page;
  await p.goto(BASE + '/complaints'); await settle(p);
  await card(p, complaint.complaintNo).waitFor();
  const a = admin.page;
  await a.goto(BASE + '/complaints'); await settle(a);
  await card(a, complaint.complaintNo).getByRole('button', { name: 'Assign' }).click();
  const dlg = a.locator('.ant-modal', { hasText: `Assign ${complaint.complaintNo}` });
  await dlg.locator('.ant-select').click();
  await a.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'Suresh Mehta' }).waitFor();
  const people = await a.locator('.ant-select-dropdown .ant-select-item-option').allTextContents();
  expect(people.some((x) => x.startsWith('Suresh Mehta')) && !people.some((x) => x.startsWith('Ravi Patel')), `offered: ${people.join(', ')}`);
  await a.keyboard.press('Escape'); await dlg.getByRole('button', { name: 'Cancel' }).click();
}, admin.page);

await step('The HOD looks at one team: list, board and dashboard', async () => {
  const p = admin.page;
  await p.goto(`${BASE}/assets?search=E2E-AHU ward&register=facility`); await settle(p);
  expect((await p.locator('main').innerText()).includes(ahu.assetCode), 'the Facility filter hides facility equipment');
  await p.goto(`${BASE}/assets?search=E2E-Vent ward&register=facility`); await settle(p);
  expect(!(await p.locator('main').innerText()).includes(vent.assetCode), 'the Facility filter does not filter');
  await p.goto(BASE + '/complaints'); await settle(p);
  await p.getByRole('radiogroup', { name: 'Equipment' }).getByText('Biomedical').click(); await settle(p);
  expect(!(await card(p, complaint.complaintNo).count()), 'the facility complaint stays on the biomedical board');
  await p.goto(BASE + '/'); await settle(p);
  await p.getByRole('radiogroup', { name: 'Equipment' }).getByText('Facility').click(); await settle(p);
  await p.goto(`${BASE}/assets/${ahu.id}`); await settle(p);
  const overview = await p.locator('.ant-descriptions').first().innerText();
  expect(overview.includes('Looked after by') && overview.includes('Maintenance team'), 'the asset does not say whose it is');
  expect(/Check with the maintenance team/.test(await p.locator('main').innerText()), 'the repair banner names the wrong team');
}, admin.page);

await step('Equipment types say which team looks after them', async () => {
  const p = admin.page;
  await p.goto(BASE + '/admin/equipment-types'); await settle(p);
  expect(/Maintenance team/.test(await p.locator('tr', { hasText: 'DG Set' }).innerText()), 'no team on the DG Set row');
}, admin.page);

await step('Only the super admin can switch the add-on', async () => {
  await admin.page.goto(BASE + '/admin/settings'); await settle(admin.page);
  expect(await admin.page.getByRole('switch', { name: 'Facility maintenance add-on' }).isDisabled(), 'the HOD can switch it');
  await sup.page.goto(BASE + '/admin/settings'); await settle(sup.page);
  expect(await sup.page.getByRole('switch', { name: 'Facility maintenance add-on' }).isEnabled(), 'the super admin cannot switch it');
}, sup.page);

await step('Phone: the maintenance list fits a 375 px screen', async () => {
  const ctx = await b.newContext({ viewport: { width: 375, height: 760 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/login');
  await p.fill('input[autocomplete=username]', 'maintenance@demo.local');
  await p.fill('input[type=password]', process.env.SEED_PASSWORD ?? 'Demo@1234');
  await p.click('button[type=submit]'); await p.waitForURL((u) => !/\/login/.test(u.pathname));
  await p.goto(BASE + '/assets'); await settle(p);
  const sideways = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways <= 0, `scrolls sideways by ${sideways}px`);
  await ctx.close();
});

await b.close();
summary();
