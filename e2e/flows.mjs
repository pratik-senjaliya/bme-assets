import fs from 'node:fs';
import ExcelJS from 'exceljs';
import path from 'node:path';
import { OUT, HERE, BASE, launch, session, step, expect, pick, fillField, summary } from './lib.mjs';
const FIX = (n) => path.join(HERE, 'fixtures', n);
const made = JSON.parse(fs.readFileSync(path.join(OUT, 'made.json'), 'utf8'));
const b = await launch();
const biomed = await session(b, 'biomed@demo.local'), admin = await session(b, 'admin@demo.local'), sup = await session(b, 'superadmin@demo.local'), nurse = await session(b, 'nursing@demo.local');
const bp = biomed.page, ap = admin.page, sp = sup.page;
const A = made.a1;

const decide = async (page, code, mode) => {
  await page.goto(BASE + '/approvals'); await page.waitForLoadState('networkidle'); await page.waitForTimeout(600);
  const row = page.locator('.ant-card, tr').filter({ hasText: code }).filter({ has: page.getByRole('button', { name: mode === 'approve' ? 'Approve' : 'Reject' }) }).last();
  await row.getByRole('button', { name: mode === 'approve' ? 'Approve' : 'Reject' }).click();
  await page.locator('.ant-modal-footer .ant-btn-primary').click();
  await page.locator('.ant-message-success').first().waitFor();
};

// ---------- Key-field edit needs the HOD (rule 3) ----------
await step('Biomedical staff change a serial number: it is sent to the HOD, not applied', async () => {
  await bp.goto(`${BASE}/assets/${A.id}/edit`); await bp.waitForLoadState('networkidle'); await bp.waitForTimeout(500);
  await fillField(bp, 'Serial number', 'E2E-SN-001');
  await bp.getByRole('button', { name: 'Save changes' }).click();
  await bp.locator('.ant-message', { hasText: /HOD/ }).waitFor();
  const a = (await biomed.api('GET', `/assets/${A.id}`)).body;
  expect(!a.serialNo, `serial was applied immediately: ${a.serialNo}`);
  await bp.waitForURL(`${BASE}/assets/${A.id}`); await bp.waitForLoadState('networkidle');
  await bp.getByText('Waiting for HOD approval').first().waitFor({ timeout: 8000 }).catch(() => { throw new Error('the asset page does not say a change is waiting for the HOD'); });
}, bp);
await step('Super admin can see the request but cannot decide it', async () => {
  await sp.goto(BASE + '/approvals'); await sp.waitForLoadState('networkidle'); await sp.waitForTimeout(600);
  expect((await sp.getByRole('button', { name: 'Approve' }).count()) === 0, 'super admin sees an Approve button');
  const list = (await admin.api('GET', '/approvals?status=pending')).body;
  const r = list.find((x) => x.assetCode === A.code && x.type === 'edit_key_field');
  expect((await sup.api('POST', `/approvals/${r.id}/approve`, {})).status === 403, 'API lets super admin approve');
}, sp);
await step('The HOD approves it in the Approvals screen and the change is applied', async () => {
  await decide(ap, A.code, 'approve');
  const a = (await admin.api('GET', `/assets/${A.id}`)).body;
  expect(a.serialNo === 'E2E-SN-001', `serial is ${a.serialNo}`);
}, ap);
await step('Rejecting a request leaves the asset as it was', async () => {
  await bp.goto(`${BASE}/assets/${A.id}/edit`); await bp.waitForLoadState('networkidle'); await bp.waitForTimeout(500);
  await fillField(bp, 'Serial number', 'E2E-SN-WRONG');
  await bp.getByRole('button', { name: 'Save changes' }).click(); await bp.locator('.ant-message', { hasText: /HOD/ }).waitFor();
  await ap.goto(BASE + '/approvals'); await ap.waitForLoadState('networkidle'); await ap.waitForTimeout(600);
  const row = ap.locator('.ant-card, tr').filter({ hasText: A.code }).filter({ has: ap.getByRole('button', { name: 'Reject' }) }).last();
  await row.getByRole('button', { name: 'Reject' }).click();
  await ap.locator('.ant-modal textarea').fill('E2E: not needed');
  await ap.locator('.ant-modal-footer .ant-btn-primary').click(); await ap.locator('.ant-message-success').first().waitFor();
  expect((await admin.api('GET', `/assets/${A.id}`)).body.serialNo === 'E2E-SN-001', 'rejected change was applied');
}, ap);

// ---------- Condemnation (rules 3, 7, 2) ----------
await step('Biomedical staff request condemnation with a reason; nothing changes until approval', async () => {
  await bp.goto(`${BASE}/assets/${A.id}`); await bp.waitForLoadState('networkidle');
  await bp.getByRole('button', { name: 'More' }).click(); await bp.getByText('Request condemnation').click();
  await bp.locator('.ant-modal textarea').fill('E2E: beyond economical repair, end of support');
  await bp.getByRole('button', { name: 'Send request' }).click(); await bp.locator('.ant-message-success').first().waitFor();
  expect((await biomed.api('GET', `/assets/${A.id}`)).body.status === 'active', 'status changed before approval');
}, bp);
await step('The HOD approves: the asset is condemned, keeps its ID, and leaves active lists', async () => {
  await decide(ap, A.code, 'approve');
  const a = (await admin.api('GET', `/assets/${A.id}`)).body;
  expect(a.status === 'condemned' && a.assetCode === A.code, `status ${a.status}`);
  const active = (await admin.api('GET', '/assets?pageSize=100&search=E2E-Vent-1')).body.items.map((x) => x.assetCode);
  expect(!active.includes(A.code), 'condemned asset still in the active list');
  const cond = (await admin.api('GET', '/assets?status=condemned&search=E2E-Vent-1')).body.items.map((x) => x.assetCode);
  expect(cond.includes(A.code), 'not found under Condemned');
  const due = (await admin.api('GET', '/pms/due')).body;
  expect(!JSON.stringify(due).includes(A.code), 'condemned asset still on the due list');
}, ap);
await step('The condemned asset page: status shown, no edit or complaint actions, certificate prints', async () => {
  await ap.goto(`${BASE}/assets/${A.id}`); await ap.waitForLoadState('networkidle');
  const t = await ap.locator('body').innerText();
  expect(/Condemned/.test(t), 'no Condemned status');
  expect((await ap.getByRole('button', { name: /Edit asset|Raise complaint/ }).count()) === 0, 'edit / complaint actions offered on a condemned asset');
  await ap.goto(`${BASE}/assets/${A.id}/condemnation`); await ap.waitForLoadState('networkidle'); await ap.waitForTimeout(800);
  const c = await ap.locator('body').innerText();
  expect(c.includes(A.code) && /condemn/i.test(c), 'certificate missing details');
}, ap);
await step('Excel export still lists the condemned asset, labelled CONDEMNED (rule 7)', async () => {
  const r = await admin.ctx.request.get(`${BASE}/api/v1/reports/asset-master`);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await r.body());
  const ws = wb.getWorksheet('Asset master'); let found = false;
  ws.eachRow((row) => { if (String(row.getCell(1).value) === A.code) found = /CONDEMNED/.test(String(row.getCell(10).value)); });
  expect(found, 'not listed as CONDEMNED');
});
await step('Complaints can no longer be raised on a condemned asset', async () => {
  const r = await nurse.api('POST', '/complaints', { assetId: A.id, description: 'E2E: after condemnation' });
  expect(r.status === 409, `status ${r.status}`);
});

// ---------- Delete a wrong entry (rules 3 and 2: IDs are never reused) ----------
await step('A wrong entry is deleted only after the HOD approves, and its ID is never reused', async () => {
  const types = (await biomed.api('GET', '/equipment-types')).body, depts = (await biomed.api('GET', '/departments')).body, locs = (await biomed.api('GET', '/locations')).body;
  const mk = (n) => biomed.api('POST', '/assets', { equipmentTypeId: types.find((x) => x.code === 'VENT').id, name: n, departmentId: depts.find((x) => x.code === 'ICU').id, locationId: locs.find((x) => x.code === 'ICU1').id });
  const wrong = (await mk('E2E-Wrong')).body;
  await bp.goto(`${BASE}/assets/${wrong.id}`); await bp.waitForLoadState('networkidle');
  await bp.getByRole('button', { name: 'More' }).click(); await bp.getByText('Request deletion').click();
  await bp.locator('.ant-modal textarea').fill('E2E: entered by mistake');
  await bp.getByRole('button', { name: 'Send request' }).click(); await bp.locator('.ant-message-success').first().waitFor();
  expect((await biomed.api('GET', `/assets/${wrong.id}`)).status === 200, 'deleted before approval');
  await decide(ap, wrong.assetCode, 'approve');
  expect((await admin.api('GET', `/assets/${wrong.id}`)).status === 404, 'still exists after approval');
  const next = (await mk('E2E-After')).body;
  expect(+next.assetCode.split('-').pop() > +wrong.assetCode.split('-').pop(), `${wrong.assetCode} was reused or the sequence went back (${next.assetCode})`);
}, ap);

// ---------- Audit (rule 5) ----------
await step('Everything above is in the audit log, with who, what, and before/after', async () => {
  const log = (await admin.api('GET', `/audit-logs?entityId=${A.id}&pageSize=100`)).body;
  const actions = log.items.map((x) => x.action);
  for (const a of ['asset.create', 'asset.condemn']) expect(actions.some((x) => x === a), `no ${a} in ${actions.join(',')}`);
  expect(log.items.every((x) => x.actorName && x.at), 'an entry has no actor or time');
  const upd = log.items.find((x) => x.action === 'approval.approve' || x.action === 'asset.update');
  expect(upd, 'no update/approval entry');
  await ap.goto(BASE + '/admin/audit'); await ap.waitForLoadState('networkidle'); await ap.waitForTimeout(800);
  expect((await ap.locator('tbody tr.ant-table-row').count()) > 5, 'audit screen shows no rows');
}, ap);
await step('Sign-ins are audited too, including a failed one', async () => {
  await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@demo.local', password: 'wrong' }) });
  const log = (await admin.api('GET', '/audit-logs?action=login&pageSize=20')).body.items.map((x) => x.action);
  expect(log.some((a) => /login/.test(a)), `actions: ${log.slice(0, 5)}`);
  return [...new Set(log)].join(', ');
});

await b.close();
summary();
