// A PMS done by the OEM engineer (decision A): entered from the asset's PMS tab with the visit date and their report,
// shown on the record with who did it and who entered it. Everything it creates is named E2E-…
import path from 'node:path';
import { BASE, HERE, launch, session, step, expect, summary } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };
const FIX = (f) => path.join(HERE, 'fixtures', f);

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const [types, depts, locs] = await Promise.all(['/equipment-types', '/departments', '/locations'].map(async (p) => (await admin.api('GET', p)).body));
const vent = types.find((t) => t.code === 'VENT').id, icu = depts.find((d) => d.code === 'ICU').id, icu1 = locs.find((l) => l.code === 'ICU1').id;
const installed = new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10);
const asset = (await admin.api('POST', '/assets', { equipmentTypeId: vent, name: 'E2E-OEM vent', departmentId: icu, locationId: icu1, installationDate: installed, pmsFrequencyMonths: 6 })).body;

await step('PMS tab: Record OEM PMS takes the visit date, engineer, result and report', async () => {
  const p = biomed.page;
  await p.goto(`${BASE}/assets/${asset.id}?tab=pms`); await settle(p);
  await p.getByRole('link', { name: 'Record OEM PMS' }).click(); await settle(p);
  expect(/OEM PMS/.test(await p.locator('h1').innerText()), 'not on the OEM PMS page');
  // The picker offers today (the default) and refuses days in the future.
  await p.getByLabel('Engineer and company').fill('Mr. A. Shah, Philips Healthcare');
  await p.locator('.ant-upload input[type=file]').setInputFiles(FIX('photo.png'));
  await p.getByText('Pass', { exact: true }).click();
  await p.getByRole('button', { name: 'Record OEM PMS' }).click();
  await p.locator('.ant-modal-confirm').getByRole('button', { name: 'Submit' }).click();
  await p.waitForURL(/\/pms\/[0-9a-f-]{36}/); await settle(p);
  const t = await p.locator('main').innerText();
  expect(/done by the OEM engineer/.test(t) && /Mr\. A\. Shah, Philips Healthcare/.test(t), 'record does not say who did it');
  expect(/Entered by/.test(t) && (await p.getByRole('link', { name: 'photo.png' }).count()) === 1, 'no Entered by or no report link');
}, biomed.page);

await step('The PMS tab lists it as done by the OEM; a visit before it is refused', async () => {
  const p = biomed.page;
  await p.goto(`${BASE}/assets/${asset.id}?tab=pms`); await settle(p);
  expect(/OEM: Mr\. A\. Shah/.test(await p.locator('main').innerText()), 'not listed as OEM');
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const r = await biomed.ctx.request.fetch(`${BASE}/api/v1/assets/${asset.id}/pms/oem`, { method: 'POST', multipart: { data: JSON.stringify({ performedOn: yesterday, serviceBy: 'Mr. A. Shah, Philips', result: 'pass' }), file: { name: 'r.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') } } });
  expect(r.status() === 400, `a visit before the last PMS -> ${r.status()}`);
}, biomed.page);

await b.close();
summary();
