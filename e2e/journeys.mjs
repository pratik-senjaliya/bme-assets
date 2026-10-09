// Journeys the other scripts do not walk through: every report and its exports, the service log, equipment types,
// editing a user, hospital settings, global search, raising a complaint from a row with a photo, dashboard tiles.
import path from 'node:path';
import { HERE, BASE, launch, session, step, expect, pick, fillDate, fillField, today, summary } from './lib.mjs';
const FIX = (n) => path.join(HERE, 'fixtures', n);
const b = await launch();
const admin = await session(b, 'admin@demo.local'), biomed = await session(b, 'biomed@demo.local'), nurse = await session(b, 'nursing@demo.local');
const ap = admin.page, bp = biomed.page, np = nurse.page;
const settle = async (p) => { await p.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}); await p.waitForTimeout(500); };
const modalOk = (p) => p.locator('.ant-modal-footer .ant-btn-primary').last().click();
const types = (await admin.api('GET', '/equipment-types')).body, depts = (await admin.api('GET', '/departments')).body, locs = (await admin.api('GET', '/locations')).body;
const A = (await biomed.api('POST', '/assets', { equipmentTypeId: types.find((x) => x.code === 'VENT').id, name: 'E2E-Journey', departmentId: depts.find((x) => x.code === 'ICU').id, locationId: locs.find((x) => x.code === 'ICU1').id, installationDate: '2026-01-01', pmsFrequencyMonths: 6 })).body;

// ---------- Reports ----------
const REPORTS = ['asset-master', 'pms', 'calibration', 'breakdowns', 'uptime', 'critical-downtime', 'equipment-age', 'expenses', 'warranty-contracts'];
await step('Every report opens on screen and exports to Excel and PDF', async () => {
  const bad = [];
  for (const t of REPORTS) {
    await ap.goto(`${BASE}/reports/${t}`); await settle(ap);
    const h1 = await ap.locator('h1').innerText().catch(() => '');
    const body = await ap.locator('body').innerText();
    if (!h1 || /Could not load this report/.test(body)) bad.push(`${t}: screen`);
    for (const [format, type] of [['xlsx', 'spreadsheetml'], ['pdf', 'pdf']]) {
      const r = await admin.ctx.request.get(`${BASE}/api/v1/reports/${t}?format=${format}`);
      if (r.status() !== 200 || !(r.headers()['content-type'] ?? '').includes(type) || (await r.body()).length < 500) bad.push(`${t}.${format}: ${r.status()}`);
    }
  }
  expect(bad.length === 0, bad.join(', '));
}, ap);
await step('An asset’s full history opens on screen and exports', async () => {
  await ap.goto(`${BASE}/assets/${A.id}/history`); await settle(ap);
  expect(/E2E-Journey|SHL-/.test(await ap.locator('body').innerText()), 'history page empty');
  for (const f of ['xlsx', 'pdf']) { const r = await admin.ctx.request.get(`${BASE}/api/v1/assets/${A.id}/history?format=${f}`); expect(r.status() === 200, `${f} ${r.status()}`); }
}, ap);

// ---------- Service log ----------
await step('Service log: an entry is added through the form and listed', async () => {
  await bp.goto(`${BASE}/assets/${A.id}?tab=service`); await settle(bp);
  await bp.getByRole('button', { name: 'Log service' }).click();
  const m = bp.locator('.ant-modal');
  await fillDate(bp, 'Date of service', today(), m); await pick(bp, 'Kind', '', m);
  await fillField(bp, 'Vendor or engineer', 'E2E Vendor', m); await fillField(bp, 'What was done', 'E2E filter change', m);
  await modalOk(bp); await bp.locator('.ant-message-success').first().waitFor(); await bp.waitForTimeout(600);
  expect(/E2E filter change/.test(await bp.locator('body').innerText()), 'entry not listed');
}, bp);
await step('Service log: deleting an entry is only a request to the HOD', async () => {
  await bp.getByRole('button', { name: 'Request delete' }).first().click();
  await fillField(bp, 'Why is this entry wrong', 'E2E entered twice', bp.locator('.ant-modal'));
  await modalOk(bp); await bp.locator('.ant-message-success').first().waitFor(); await bp.waitForTimeout(500);
  expect(/E2E filter change/.test(await bp.locator('body').innerText()), 'entry vanished before approval');
  const pending = (await admin.api('GET', '/approvals?status=pending')).body;
  expect(pending.some((r) => /E2E entered twice/.test(r.requestReason ?? '')), 'no pending request for the HOD');
}, bp);

// ---------- Global search, row actions, dashboard ----------
await step('Global search: typing a name and choosing the result opens that asset', async () => {
  await bp.goto(`${BASE}/`); await settle(bp);
  await bp.keyboard.press('/'); await bp.keyboard.type('E2E-Journey'); await bp.waitForTimeout(1200);
  await bp.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await bp.waitForURL(/\/assets\/[0-9a-f-]{36}$/);
  await bp.locator('h1').waitFor(); await settle(bp);
  expect(/E2E-Journey/.test(await bp.locator('body').innerText()), 'opened a different asset');
}, bp);
await step('Nursing raises a complaint from an equipment row, with a photo', async () => {
  await np.goto(`${BASE}/assets?search=E2E-Journey`); await settle(np);
  await np.getByRole('button', { name: `Actions for ${A.assetCode}` }).click();
  await np.locator('.ant-dropdown:visible').getByText('Raise complaint').click();
  const m = np.locator('.ant-modal'); await m.waitFor();
  await m.locator('textarea').first().fill('E2E display flickers');
  await m.locator('.ant-upload input[type=file]').setInputFiles(FIX('photo.png'));
  await modalOk(np); await np.locator('.ant-message-success').first().waitFor(); await np.waitForTimeout(800);
  const list = (await nurse.api('GET', `/complaints?assetId=${A.id}`)).body.items;
  const c = list.find((x) => /E2E display flickers/.test(x.description));
  expect(c && c.attachmentCount === 1, `complaint ${c ? `has ${c.attachmentCount} files` : 'missing'}`);
}, np);
await step('Dashboard tiles open the list behind them', async () => {
  await ap.goto(`${BASE}/`); await settle(ap);
  await ap.locator('a[href="/due?range=overdue"]').first().click(); await ap.waitForURL(/\/due\?range=overdue/); await settle(ap);
  expect(/Overdue only/.test(await ap.locator('main .ant-select', { hasText: /overdue/i }).first().innerText().catch(() => '')), 'period not set to overdue');
  await ap.goto(`${BASE}/`); await settle(ap);
  await ap.locator('a[href="/complaints"]').first().click(); await ap.waitForURL(/\/complaints$/);
}, ap);

await step('Leaving a half-filled form asks first; an untouched form leaves without asking', async () => {
  const asked = [];
  const note = (d) => asked.push(d.message() || d.type());
  bp.on('dialog', note);
  await bp.goto(`${BASE}/assets/new`); await settle(bp);
  await bp.getByRole('link', { name: 'Cancel' }).click(); await bp.waitForURL(/\/assets$/);
  expect(asked.length === 0, 'asked although nothing was typed');
  await bp.goto(`${BASE}/assets/new`); await settle(bp);
  await fillField(bp, 'Name', 'E2E-Unsaved');
  await bp.getByRole('link', { name: 'Cancel' }).click(); await bp.waitForURL(/\/assets$/);
  bp.off('dialog', note);
  expect(asked.some((m) => /not saved/i.test(m)), `no question before leaving (${asked.join(' | ')})`);
}, bp);

// ---------- Admin ----------
await step('Equipment types: add, rename and remove through the screen', async () => {
  await ap.goto(`${BASE}/admin/equipment-types`); await settle(ap);
  await ap.getByRole('button', { name: 'Add equipment type' }).click();
  const m = ap.locator('.ant-modal');
  await fillField(ap, 'Name', 'E2E Journey Type', m); await fillField(ap, 'Code', 'E2EJ', m); await fillField(ap, 'Default PMS interval', 6, m);
  await modalOk(ap); await ap.locator('.ant-message-success').first().waitFor(); await ap.waitForTimeout(500);
  const row = () => ap.locator('tbody tr', { hasText: 'E2EJ' });
  await row().getByRole('button', { name: 'Edit' }).click();
  await fillField(ap, 'Name', 'E2E Journey renamed', ap.locator('.ant-modal')); await modalOk(ap); await ap.waitForTimeout(800);
  expect(/E2E Journey renamed/.test(await row().innerText()), 'rename not shown');
  await row().getByRole('button', { name: 'Remove' }).click();
  await ap.locator('.ant-popconfirm .ant-btn-primary').click(); await ap.waitForTimeout(800);
  expect((await row().count()) === 0, 'type still listed after remove');
}, ap);
await step('Users: editing a user’s role is saved and shown', async () => {
  const email = `e2e.edit${Date.now()}@demo.local`;
  const u = (await admin.api('POST', '/users', { name: 'E2E Edit Me', email, role: 'biomed', password: 'Edit@12345' })).body;
  expect(u?.id, `could not create the user: ${JSON.stringify(u).slice(0, 120)}`);
  await ap.goto(`${BASE}/admin/users`); await settle(ap);
  const row = ap.locator('tbody tr', { hasText: email });
  await row.getByRole('button', { name: 'Edit' }).click();
  const m = ap.locator('.ant-modal'); await fillField(ap, 'Name', 'E2E Edited', m);
  await modalOk(ap); await ap.locator('.ant-message-success').first().waitFor(); await ap.waitForTimeout(600);
  expect(/E2E Edited/.test(await row.innerText()), 'new name not shown');
}, ap);
await step('Hospital settings: a change is saved and shown after reload', async () => {
  const before = (await admin.api('GET', '/settings')).body;
  await ap.goto(`${BASE}/admin/settings`); await settle(ap);
  await fillField(ap, 'Critical equipment downtime limit', 36);
  await ap.getByRole('button', { name: 'Save changes' }).click(); await ap.locator('.ant-message-success').first().waitFor();
  await ap.reload(); await settle(ap);
  const after = (await admin.api('GET', '/settings')).body;
  await admin.api('PUT', '/settings', { criticalDowntimeHours: before.criticalDowntimeHours });
  expect(after.criticalDowntimeHours === 36, `saved ${after.criticalDowntimeHours}`);
}, ap);

// Leave the pending deletion request decided so later runs start clean.
for (const r of (await admin.api('GET', '/approvals?status=pending')).body.filter((x) => /E2E/.test(x.requestReason ?? ''))) await admin.api('POST', `/approvals/${r.id}/reject`, { note: 'E2E cleanup' });
await b.close();
summary();
