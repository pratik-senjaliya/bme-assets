// Facility maintenance add-on, F4 (docs/requirements-facility.md): the logbook. On a machine the team sets up what is
// read, takes a reading (the system's time), corrects a wrong one, sets PMS by run hours; the Logbook page lists what
// is owed now and My work shows what needs attention. Everything it creates is named E2E…
import { BASE, launch, session, step, expect, summary, fillField } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const maint = await session(b, 'maintenance@demo.local');
const p = maint.page;
const [types, depts, locs] = await Promise.all(['/equipment-types', '/departments', '/locations'].map(async (x) => (await maint.api('GET', x)).body));
const id = (list, code) => list.find((x) => x.code === code).id;
const eng = depts.find((d) => d.code === 'ENG') ?? depts[0];
const dg = (await maint.api('POST', '/assets', { equipmentTypeId: id(types, 'DG'), name: 'E2E-DG logbook', departmentId: eng.id, locationId: locs.find((l) => l.departmentId === eng.id).id })).body;
const dialog = (title) => p.locator('.ant-modal', { hasText: title });

await step('A machine’s Logbook tab: add a run-hours meter and a diesel level with its normal range', async () => {
  await p.goto(`${BASE}/assets/${dg.id}?tab=logbook`); await settle(p);
  await p.getByRole('button', { name: 'Add reading' }).click();
  let d = dialog('Add reading');
  await fillField(p, 'Name', 'Run hours', d); await fillField(p, 'Unit', 'h', d);
  await d.locator('.ant-form-item', { hasText: 'Kind' }).locator('.ant-select').click();
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'A meter' }).click();
  await d.getByText('This meter counts the machine').click();
  await d.getByRole('button', { name: 'Save' }).click();
  await p.locator('.ant-message-success', { hasText: 'Run hours added' }).waitFor();
  await p.getByRole('button', { name: 'Add reading' }).click();
  d = dialog('Add reading');
  await fillField(p, 'Name', 'Diesel level', d); await fillField(p, 'Unit', '%', d);
  await fillField(p, 'Normal from', '30', d); await fillField(p, 'Normal to', '100', d);
  await d.getByRole('button', { name: 'Save' }).click();
  await p.locator('.ant-message-success', { hasText: 'Diesel level added' }).waitFor();
  await settle(p);
  const t = await p.locator('main').innerText();
  expect(t.includes('Run hours') && t.includes('normal 30–100 %'), 'readings not listed');
}, p);

await step('Record readings: one out of range is flagged; the time is the system’s', async () => {
  const row = (name) => p.locator('div', { has: p.getByText(name, { exact: true }) }).filter({ has: p.getByRole('button', { name: 'Record' }) }).last();
  await row('Run hours').getByRole('button', { name: 'Record' }).click();
  await fillField(p, 'Reading', '1200', dialog('Run hours'));
  await dialog('Run hours').getByRole('button', { name: 'Record reading' }).click();
  await p.locator('.ant-message-success', { hasText: 'Run hours recorded' }).waitFor();
  await row('Diesel level').getByRole('button', { name: 'Record' }).click();
  await fillField(p, 'Reading', '12', dialog('Diesel level'));
  await dialog('Diesel level').getByRole('button', { name: 'Record reading' }).click();
  await p.locator('.ant-message-warning', { hasText: 'outside the normal range' }).waitFor();
  await settle(p);
  expect(/Out of range/.test(await p.locator('main').innerText()), 'no Out of range mark');
}, p);

await step('Correct the wrong reading: the original stays, struck through, with the correction', async () => {
  await p.locator('tr', { hasText: '12 %' }).getByRole('button', { name: 'Correct' }).click();
  const d = dialog('Correct a reading');
  await fillField(p, 'Right value', '72', d); await fillField(p, 'What was wrong', 'Misread the gauge', d);
  await d.getByRole('button', { name: 'Save correction' }).click();
  await p.locator('.ant-message-success', { hasText: 'Reading corrected' }).waitFor();
  await settle(p);
  expect((await p.locator('tr', { hasText: '72 %' }).innerText()).includes('Correction'), 'no correction row');
}, p);

await step('PMS every 250 run hours: next PMS at 1450', async () => {
  await fillField(p, 'PMS every', '250');
  await p.getByRole('button', { name: 'Save', exact: true }).click();
  await p.locator('.ant-message-success', { hasText: 'PMS every 250 run hours' }).waitFor();
  await settle(p);
  expect(/Next PMS at:\s*1450/.test(await p.locator('main').innerText()), 'next PMS not at 1450');
}, p);

await step('The Logbook page lists what is owed now and takes a reading from there', async () => {
  await p.goto(BASE + '/logbook'); await settle(p);
  await p.getByText('All readings').click(); await settle(p);
  const row = p.locator('tr', { hasText: dg.assetCode }).filter({ hasText: 'Diesel level' });
  await row.getByRole('button', { name: /^Record/ }).click();
  await fillField(p, 'Reading', '70', dialog('Diesel level'));
  await dialog('Diesel level').getByRole('button', { name: 'Record reading' }).click();
  await p.locator('.ant-message-success', { hasText: 'Diesel level recorded' }).waitFor();
}, p);

await step('My work shows the logbook section', async () => {
  await p.goto(BASE + '/my-work'); await settle(p);
  expect(/Logbook/.test(await p.locator('main').innerText()), 'no Logbook on My work');
}, p);

await b.close();
summary();
