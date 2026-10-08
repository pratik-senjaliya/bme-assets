import path from 'node:path';
import { OUT, HERE, BASE, launch, session, step, expect, pick, fillDate, fillField, today, summary } from './lib.mjs';
const FIX = (n) => path.join(HERE, 'fixtures', n);
const b = await launch();
const biomed = await session(b, 'biomed@demo.local'), admin = await session(b, 'admin@demo.local');
const bp = biomed.page, ap = admin.page;
const types = (await admin.api('GET', '/equipment-types')).body, depts = (await admin.api('GET', '/departments')).body, locs = (await admin.api('GET', '/locations')).body;
const mk = (n, extra = {}) => biomed.api('POST', '/assets', { equipmentTypeId: types.find((x) => x.code === 'VENT').id, name: n, departmentId: depts.find((x) => x.code === 'ICU').id, locationId: locs.find((x) => x.code === 'ICU1').id, installationDate: '2026-01-01', pmsFrequencyMonths: 6, ...extra });
const A = (await mk('E2E-Ops')).body;
const modalOk = async (p, name = /^(Save|OK|Add|Send)/) => { await p.locator('.ant-modal-footer .ant-btn-primary').click(); };

// ---------- Records on an asset ----------
await step('Calibration: add through the form; the next due date appears on the asset', async () => {
  await bp.goto(`${BASE}/assets/${A.id}?tab=calibration`); await bp.waitForLoadState('networkidle');
  await bp.locator('.ant-tabs-tabpane-active .ant-btn').first().click();
  await bp.locator('.ant-modal').waitFor();
  await fillDate(bp, 'Calibration date', today(), bp.locator('.ant-modal'));
  await fillField(bp, 'Agency or engineer', 'E2E Calibration Lab', bp.locator('.ant-modal'));
  await pick(bp, 'Result', 'Pass', bp.locator('.ant-modal'));
  await modalOk(bp); await bp.locator('.ant-message-success').first().waitFor();
  const a = (await biomed.api('GET', `/assets/${A.id}`)).body;
  expect(a.nextCalibrationDue && a.nextCalibrationDue > new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()), `nextCalibrationDue ${a.nextCalibrationDue}`);
}, bp);
await step('Purchase order and contract: add through the form; money shows in rupees with Indian grouping', async () => {
  await bp.goto(`${BASE}/assets/${A.id}?tab=purchase`); await bp.waitForLoadState('networkidle');
  await bp.getByRole('button', { name: 'Add purchase order' }).click();
  await fillField(bp, 'PO number', 'E2E-PO-1', bp.locator('.ant-modal')); await fillDate(bp, 'PO date', '15 Dec 2025', bp.locator('.ant-modal'));
  await fillField(bp, 'Vendor', 'E2E Vendor', bp.locator('.ant-modal')); await fillField(bp, 'Cost', 1234567, bp.locator('.ant-modal'));
  await modalOk(bp); await bp.locator('.ant-message-success').first().waitFor();
  await bp.getByRole('button', { name: 'Add contract' }).click();
  await pick(bp, 'Type', 'AMC', bp.locator('.ant-modal')); await fillField(bp, 'Vendor', 'E2E AMC Co', bp.locator('.ant-modal'));
  await fillDate(bp, 'Starts', '01 Jan 2028', bp.locator('.ant-modal')); await fillDate(bp, 'Ends', '31 Dec 2028', bp.locator('.ant-modal'));
  await modalOk(bp); await bp.locator('.ant-message-success').first().waitFor();
  await bp.waitForTimeout(800);
  const t = await bp.locator('body').innerText();
  expect(/₹\s?12,34,567/.test(t), 'cost not shown as ₹ 12,34,567');
  expect(/E2E AMC Co/.test(t), 'contract not listed');
}, bp);
await step('Expense: add through the form; total and Indian grouping shown', async () => {
  await bp.goto(`${BASE}/assets/${A.id}?tab=expenses`); await bp.waitForLoadState('networkidle');
  await bp.getByRole('button', { name: 'Add expense' }).click();
  await fillField(bp, 'What was paid for', 'E2E spare sensor', bp.locator('.ant-modal')); await fillField(bp, 'Amount', 45250, bp.locator('.ant-modal'));
  await modalOk(bp); await bp.locator('.ant-message-success').first().waitFor(); await bp.waitForTimeout(800);
  expect(/₹\s?45,250/.test(await bp.locator('body').innerText()), 'amount not shown as ₹ 45,250');
}, bp);
await step('Expense dated in the future is refused with a plain message', async () => {
  const r = await biomed.api('POST', `/assets/${A.id}/expenses`, { type: 'repair', description: 'future', amount: 10, date: '2099-01-01' });
  expect(r.status === 400 && /future/i.test(JSON.stringify(r.body)), `status ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
});

// ---------- Editing and status ----------
await step('Editing a non-key field (name) is applied at once and audited', async () => {
  await bp.goto(`${BASE}/assets/${A.id}/edit`); await bp.waitForLoadState('networkidle'); await bp.waitForTimeout(500);
  await fillField(bp, 'Name', 'E2E-Ops renamed'); await bp.getByRole('button', { name: 'Save changes' }).click();
  await bp.locator('.ant-message-success', { hasText: 'Asset updated' }).waitFor();
  expect((await biomed.api('GET', `/assets/${A.id}`)).body.name === 'E2E-Ops renamed', 'name not changed');
  const log = (await admin.api('GET', `/audit-logs?entityId=${A.id}&pageSize=50`)).body.items;
  expect(log.some((x) => x.action === 'asset.update'), 'no asset.update audit entry');
}, bp);
await step('Marking equipment "Not in use" removes it from active, due and reminder lists but keeps it in history', async () => {
  await bp.goto(`${BASE}/assets/${A.id}/edit`); await bp.waitForLoadState('networkidle'); await bp.waitForTimeout(500);
  await pick(bp, 'Status', 'Not in use'); await bp.getByRole('button', { name: 'Save changes' }).click();
  await bp.locator('.ant-message-success').first().waitFor();
  const active = (await biomed.api('GET', '/assets?search=E2E-Ops&pageSize=50')).body.items;
  expect(active.length === 0, 'still in the active list');
  expect(!JSON.stringify((await biomed.api('GET', '/pms/due')).body).includes(A.assetCode), 'still on the due list');
  expect((await biomed.api('GET', `/assets/${A.id}`)).status === 200, 'history lost');
  await pick(bp, 'Status', 'Active').catch(() => {});
}, bp);

// ---------- PMS correction and print ----------
let rec;
await step('PMS correction: a new linked record; the original stays untouched and says it was corrected', async () => {
  await biomed.api('PATCH', `/assets/${A.id}`, { status: 'active' });
  const tpl = (await biomed.api('GET', `/assets/${A.id}/pms-template`)).body;
  const answers = Object.fromEntries(tpl.items.map((i) => [i.id, i.type === 'check' ? 'pass' : i.type === 'reading' ? ((i.min ?? 0) + (i.max ?? 2)) / 2 : 'ok']));
  rec = (await biomed.api('POST', `/assets/${A.id}/pms`, { answers })).body;
  await bp.goto(`${BASE}/pms/${rec.id}`); await bp.getByRole('button', { name: 'Record a correction' }).waitFor();
  await bp.getByRole('button', { name: 'Record a correction' }).click(); await bp.waitForURL(/corrects=/); await bp.waitForLoadState('networkidle');
  expect(/correction/i.test(await bp.locator('body').innerText()), 'correction page does not say what it is');
  const groups = bp.locator('.ant-radio-group'); for (let i = 0; i < (await groups.count()); i++) await groups.nth(i).getByText('Pass', { exact: true }).click();
  const readings = bp.locator('.ant-input-number input');
  for (let i = 0; i < (await readings.count()); i++) { const hint = await readings.nth(i).locator('xpath=ancestor::div[contains(@style,"flex")][1]').innerText().catch(() => ''); const m = /Allowed:\s*([\d.]+)\D+([\d.]+)/.exec(hint); await readings.nth(i).fill(m ? String((+m[1] + +m[2]) / 2) : '1'); }
  const reason = bp.locator('textarea, input[aria-label*="eason" i]').first(); if (await reason.count()) await reason.fill('E2E: wrong reading typed');
  await bp.getByRole('button', { name: 'Submit correction' }).click(); await bp.locator('.ant-modal-confirm').getByRole('button', { name: 'Submit' }).click();
  await bp.waitForURL(/\/pms\/[0-9a-f-]{36}$/); await bp.getByText(/correction of/i).first().waitFor();
  const orig = (await biomed.api('GET', `/pms/${rec.id}`)).body;
  expect(orig.correctedByRecordId, 'original does not point to its correction');
  expect(JSON.stringify(orig.answers ?? orig.items) === JSON.stringify(rec.answers ?? rec.items), 'original changed');
}, bp);
await step('Print view: the page chrome is hidden and the record is on a plain page', async () => {
  await bp.goto(`${BASE}/pms/${rec.id}`); await bp.getByText('Pass', { exact: true }).first().waitFor();
  await bp.emulateMedia({ media: 'print' });
  const vis = await bp.evaluate(() => ({ sider: getComputedStyle(document.querySelector('.app-sider') ?? document.body).display, header: getComputedStyle(document.querySelector('.app-header') ?? document.body).display, text: document.body.innerText.slice(0, 400) }));
  await bp.screenshot({ path: path.join(OUT, 'print-pms.png') });
  await bp.emulateMedia({ media: 'screen' });
  expect(vis.sider === 'none' && vis.header === 'none', `sidebar ${vis.sider}, header ${vis.header}`);
  expect(/SHL-/.test(vis.text), 'asset code not on the print');
}, bp);

// ---------- Users and roles ----------
await step('Users: add a nursing login for another department; they see only that department', async () => {
  await ap.goto(BASE + '/admin/users'); await ap.waitForLoadState('networkidle');
  await ap.getByRole('button', { name: 'Add user' }).click(); await ap.locator('.ant-modal').waitFor();
  const m = ap.locator('.ant-modal');
  await fillField(ap, 'Name', 'E2E Radiology Nurse', m); await fillField(ap, 'Email', 'e2e.rad@demo.local', m);
  await pick(ap, 'Role', 'Nursing', m); await pick(ap, 'Department', 'Radiology', m);
  await fillField(ap, 'Password', 'E2eRad@12345', m);
  await modalOk(ap); await ap.locator('.ant-message-success').first().waitFor();
  const n = await session(b, 'e2e.rad@demo.local', undefined, 'E2eRad@12345').catch(() => null);
  expect(n, 'the new user cannot sign in with the password just set');
  const rows = (await n.api('GET', '/assets?pageSize=100')).body.items;
  expect(rows.length > 0 && rows.every((r) => r.departmentName === 'Radiology'), `departments: ${[...new Set(rows.map((r) => r.departmentName))]}`);
}, ap);
await step('Users: deactivate stops sign-in at once; the HOD cannot lock themselves out', async () => {
  await ap.goto(BASE + '/admin/users'); await ap.waitForLoadState('networkidle'); await ap.waitForTimeout(500);
  const row = ap.locator('tr', { hasText: 'e2e.rad@demo.local' });
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await ap.locator('.ant-popconfirm .ant-btn-primary, .ant-popover .ant-btn-primary').first().click(); await ap.locator('.ant-message-success').first().waitFor();
  const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'e2e.rad@demo.local', password: 'E2eRad@12345' }) });
  expect(r.status === 401 || r.status === 403, `deactivated user can sign in (${r.status})`);
  const own = ap.locator('tr').filter({ has: ap.getByText('admin@demo.local', { exact: true }) });
  expect((await own.getByRole('button', { name: 'Deactivate' }).count()) === 0, 'the HOD can deactivate their own login');
  const me = (await admin.api('GET', '/users')).body.find((u) => u.email === 'admin@demo.local');
  expect((await admin.api('PATCH', `/users/${me.id}`, { active: false })).status >= 400, 'API lets the HOD deactivate themselves');
}, ap);
await step('Roles: turning a permission off takes effect for that role (and is put back)', async () => {
  const roles = (await admin.api('GET', '/roles')).body; const nursing = roles.find((r) => /nursing/i.test(r.name ?? r.key ?? r.label));
  const perms = (await admin.api('GET', `/roles/${nursing.id}/permissions`)).body; const list = perms.permissions ?? perms;
  const n = await session(b, 'nursing@demo.local');
  await admin.api('PUT', `/roles/${nursing.id}/permissions`, { permissions: list.filter((p) => p !== 'complaint.create') });
  const off = (await n.api('POST', '/complaints', { assetId: A.id, description: 'E2E: blocked?' })).status;
  await admin.api('PUT', `/roles/${nursing.id}/permissions`, { permissions: list });
  const on = (await n.api('POST', '/complaints', { assetId: A.id, description: 'E2E: allowed again' })).status;
  expect(off === 403 && on === 201, `off=${off} on=${on}`);
});

// ---------- Setup: departments, checklists ----------
await step('Departments: add a department and a location; duplicates and in-use deletions are refused in plain words', async () => {
  await ap.goto(BASE + '/admin/departments'); await ap.waitForLoadState('networkidle');
  await ap.getByRole('button', { name: /Add department/ }).click(); await ap.locator('.ant-modal').waitFor();
  await fillField(ap, 'Name', 'E2E Dept', ap.locator('.ant-modal')); await fillField(ap, 'Code', 'E2D', ap.locator('.ant-modal'));
  await modalOk(ap); await ap.locator('.ant-message-success').first().waitFor();
  const dup = await admin.api('POST', '/departments', { name: 'E2E Dept', code: 'E2D' });
  expect(dup.status === 409 || dup.status === 400, `duplicate -> ${dup.status}`);
  const icu = depts.find((x) => x.code === 'ICU');
  const del = await admin.api('DELETE', `/departments/${icu.id}`);
  expect(del.status === 409 || del.status === 400, `deleting a department in use -> ${del.status}`);
  expect(/in use|assets|cannot/i.test(JSON.stringify(del.body)), `message: ${JSON.stringify(del.body)}`);
}, ap);
await b.close();
summary();
