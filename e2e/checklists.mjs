import path from 'node:path';
import { OUT, HERE, BASE, launch, session, step, expect, summary } from './lib.mjs';
const FIX = (n) => path.join(HERE, 'fixtures', n);
const b = await launch(); const admin = await session(b, 'admin@demo.local'), biomed = await session(b, 'biomed@demo.local'); const ap = admin.page;
let t = (await admin.api('GET', '/equipment-types')).body.find((x) => x.code === 'E2ET');
if (!t) t = (await admin.api('POST', '/equipment-types', { name: 'E2E Type', code: 'E2ET', defaultPmsMonths: 3, defaultCalibrationMonths: 12 })).body;
const depts = (await admin.api('GET', '/departments')).body, locs = (await admin.api('GET', '/locations')).body;
const asset = (await biomed.api('POST', '/assets', { equipmentTypeId: t.id, name: 'E2E-Tpl', departmentId: depts.find((d) => d.code === 'ICU').id, locationId: locs.find((l) => l.code === 'ICU1').id, installationDate: '2026-01-01' })).body;
const pick = async () => { await ap.goto(BASE + '/admin/pms-templates'); await ap.waitForLoadState('networkidle'); await ap.locator('.ant-layout-content .ant-select').first().click(); await ap.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'E2E Type' }).click(); await ap.waitForTimeout(500); };
await step('Checklist builder: create version 1 for a type through the screen', async () => {
  await pick(); await ap.getByRole('button', { name: /Create|Edit|New/i }).first().click();
  await ap.locator('input[aria-label="Item 1 text"]').fill('E2E visual check');
  await ap.getByRole('button', { name: /^Save/ }).click(); await ap.locator('.ant-message-success').first().waitFor();
  const tpl = (await admin.api('GET', `/pms-templates?equipmentTypeId=${t.id}`)).body; expect((tpl.version ?? tpl[0]?.version) === 1, `template ${JSON.stringify(tpl).slice(0, 120)}`);
}, ap);
let oldRec;
await step('PMS recorded now is stamped with checklist v1', async () => {
  const tpl = (await biomed.api('GET', `/assets/${asset.id}/pms-template`)).body;
  oldRec = (await biomed.api('POST', `/assets/${asset.id}/pms`, { answers: Object.fromEntries(tpl.items.map((i) => [i.id, 'pass'])) })).body;
  expect(oldRec.templateVersion === 1, `version ${oldRec.templateVersion}`);
});
await step('Editing the checklist saves version 2; the old record keeps v1, the next PMS uses v2', async () => {
  await pick(); await ap.getByRole('button', { name: /Edit/i }).first().click();
  await ap.getByRole('button', { name: /Add (a )?(check|item)/i }).click();
  await ap.locator('input[aria-label="Item 2 text"]').fill('E2E second check');
  await ap.getByRole('button', { name: /^Save/ }).click(); await ap.locator('.ant-message-success').first().waitFor();
  const old = (await biomed.api('GET', `/pms/${oldRec.id}`)).body; expect(old.templateVersion === 1 && old.items.length === 1, `old record now v${old.templateVersion} with ${old.items.length} items`);
  const next = (await biomed.api('GET', `/assets/${asset.id}/pms-template`)).body; expect(next.version === 2 && next.items.length === 2, `next template v${next.version}, ${next.items.length} items`);
}, ap);
await b.close(); summary();
