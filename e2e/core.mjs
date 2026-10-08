import path from 'node:path';
import { OUT, HERE, BASE, launch, session, step, expect, pick, fillDate, fillField, today, summary } from './lib.mjs';
const FIX = (n) => path.join(HERE, 'fixtures', n);
const b = await launch();
const biomed = await session(b, 'biomed@demo.local');
const admin = await session(b, 'admin@demo.local');
const nurse = await session(b, 'nursing@demo.local');
const bp = biomed.page, ap = admin.page, np = nurse.page;
const made = {};

// ---------- Asset ID (rule 2) and form validation ----------
await step('Pressing Enter in the date field must not submit the half-filled form', async () => {
  await bp.goto(BASE + '/assets/new'); await bp.waitForLoadState('networkidle');
  await pick(bp, 'Equipment type', 'Ventilator'); await fillField(bp, 'Name', 'E2E-Enter');
  await pick(bp, 'Department', 'Intensive Care Unit'); await pick(bp, 'Location', 'ICU 1');
  const input = bp.locator('.ant-form-item').filter({ has: bp.locator('label', { hasText: /^\s*Installation date/ }) }).locator('.ant-picker input');
  await input.click(); await input.fill('01 Jan 2025'); await input.press('Enter');
  await bp.waitForTimeout(1500);
  const n = (await biomed.api('GET', '/assets?search=E2E-Enter&status=all')).body.items.length;
  expect(n === 0, `Enter in the date field created ${n} asset(s) before the form was finished`);
}, bp);

await step('Add asset: empty form shows plain required-field messages and saves nothing', async () => {
  await bp.goto(BASE + '/assets/new'); await bp.waitForLoadState('networkidle');
  await bp.getByRole('button', { name: 'Create asset' }).click();
  await bp.waitForTimeout(500);
  const txt = await bp.locator('.ant-form-item-explain-error').allTextContents();
  expect(txt.some((t) => /Choose a type/.test(t)) && txt.some((t) => /Enter a name/.test(t)) && txt.some((t) => /department/i.test(t)), `messages: ${txt.join(' | ')}`);
  expect(/\/assets\/new/.test(bp.url()), 'should stay on the form');
}, bp);

async function createAsset(name, extra = {}) {
  await bp.goto(BASE + '/assets/new'); await bp.waitForLoadState('networkidle');
  await pick(bp, 'Equipment type', 'Ventilator');
  await fillField(bp, 'Name', name);
  await pick(bp, 'Department', 'Intensive Care Unit');
  await pick(bp, 'Location', 'ICU 1');
  await fillDate(bp, 'Installation date', '01 Jan 2025');
  await fillField(bp, 'Warranty \\(months\\)', 24);
  await fillField(bp, 'PMS every', 6);
  if (extra.serial) await fillField(bp, 'Serial number', extra.serial);
  await bp.getByRole('button', { name: 'Create asset' }).click();
  await bp.waitForURL(/\/assets\/[0-9a-f-]{36}$/);
  await bp.waitForLoadState('networkidle');
  const code = (await bp.locator('.code').first().textContent()).trim();
  return { id: bp.url().split('/').pop(), code };
}
await step('Add asset through the form: ID is generated from the pattern and shown on the asset', async () => {
  made.a1 = await createAsset('E2E-Vent-1');
  expect(/^SHL-ICU-VENT-ICU1-\d{3,}$/.test(made.a1.code), `code was ${made.a1.code}`);
  return made.a1.code;
}, bp);
await step('Second asset gets the next number; two parallel creates never share an ID', async () => {
  made.a2 = await createAsset('E2E-Vent-2');
  const num = (c) => +c.split('-').pop(); const n1 = num(made.a1.code), n2 = num(made.a2.code);
  expect(n2 === n1 + 1, `${made.a1.code} then ${made.a2.code}`);
  // 6 parallel creates through the API
  const body = (i) => ({ equipmentTypeId: null, name: `E2E-Par-${i}` });
  const types = (await biomed.api('GET', '/equipment-types')).body, depts = (await biomed.api('GET', '/departments')).body, locs = (await biomed.api('GET', '/locations')).body;
  const t = types.find((x) => x.code === 'VENT').id, d = depts.find((x) => x.code === 'ICU').id, l = locs.find((x) => x.code === 'ICU1').id;
  const res = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => biomed.api('POST', '/assets', { equipmentTypeId: t, name: `E2E-Par-${i}`, departmentId: d, locationId: l })));
  const codes = res.map((r) => r.body.assetCode);
  expect(res.every((r) => r.status === 201) && new Set(codes).size === 6, `codes ${codes.join(',')}`);
}, bp);
await step('The detail page shows the new asset with age, warranty, next PMS from the entered dates', async () => {
  await bp.goto(`${BASE}/assets/${made.a1.id}`); await bp.waitForLoadState('networkidle');
  const t = await bp.locator('body').innerText();
  expect(/E2E-Vent-1/.test(t) && /Intensive Care Unit/.test(t) && /01 Jul 2025/.test(t) && /01 Jan 2027/.test(t), 'expected install/next PMS/warranty dates not all present');
}, bp);

// ---------- PMS date lock (rule 1) ----------
await step('PMS form has no date field and says the system stamps the date', async () => {
  await bp.goto(`${BASE}/assets/${made.a1.id}/pms/new`); await bp.waitForLoadState('networkidle');
  expect((await bp.locator('.ant-picker').count()) === 0, 'a date picker exists on the PMS form');
  expect(/recorded by the system|set by the system/i.test(await bp.locator('body').innerText()), 'no explanation of the date lock');
}, bp);
await step('Submitting PMS asks for confirmation, then records it with today\'s date, read-only', async () => {
  const groups = bp.locator('.ant-radio-group');
  const n = await groups.count();
  for (let i = 0; i < n; i++) await groups.nth(i).getByText('Pass', { exact: true }).click();
  const readings = bp.locator('.ant-input-number input');
  for (let i = 0; i < (await readings.count()); i++) {
    const hint = await readings.nth(i).locator('xpath=ancestor::div[contains(@style,"flex")][1]').innerText().catch(() => '');
    const m = /Allowed:\s*([\d.]+)\D+([\d.]+)/.exec(hint);
    await readings.nth(i).fill(m ? String(((+m[1] + +m[2]) / 2).toFixed(1)) : '1');
  }
  await bp.getByRole('button', { name: 'Submit PMS' }).click();
  await bp.locator('.ant-modal-confirm').waitFor();
  expect(/Submit this PMS\?/.test(await bp.locator('.ant-modal-confirm').innerText()), 'no confirmation');
  await bp.locator('.ant-modal-confirm').getByRole('button', { name: 'Submit' }).click();
  await bp.waitForURL(/\/pms\/[0-9a-f-]{36}/); await bp.getByText('Pass', { exact: true }).first().waitFor();
  made.pmsId = bp.url().split('/').pop();
  const t = await bp.locator('body').innerText();
  expect(t.includes(today()), `record does not show today (${today()})`);
  expect((await bp.getByRole('button', { name: /^Edit|Save|Delete/ }).count()) === 0, 'record has edit/delete controls');
}, bp);
await step('A submitted PMS record cannot be changed or deleted through the API', async () => {
  for (const m of ['PUT', 'PATCH', 'DELETE']) { const r = await biomed.api(m, `/pms/${made.pmsId}`, {}); expect(r.status >= 400, `${m} -> ${r.status}`); }
});
await step('Next PMS due moves on to today + frequency', async () => {
  const a = (await biomed.api('GET', `/assets/${made.a1.id}`)).body;
  const d = new Date(); d.setMonth(d.getMonth() + 6);
  expect(a.nextPmsDue === new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d), `nextPmsDue ${a.nextPmsDue}`);
});
await step('A client-supplied date is ignored by the server', async () => {
  const tpl = (await biomed.api('GET', `/assets/${made.a2.id}/pms-template`)).body;
  const answers = Object.fromEntries((tpl.items ?? []).map((i) => [i.id, i.type === 'check' ? 'pass' : i.type === 'reading' ? ((i.min ?? 0) + (i.max ?? 2)) / 2 : 'ok']));
  const r = await biomed.api('POST', `/assets/${made.a2.id}/pms`, { answers, performedOn: '2001-01-01' });
  expect(r.status === 201 && r.body.performedOn === new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()), `status ${r.status} performedOn ${r.body?.performedOn}`);
});

// ---------- Complaints (rule 6) and department scope (rule 4) ----------
await step('Nursing raises a complaint from the Complaints page; a number is generated and a toast confirms', async () => {
  await np.goto(BASE + '/complaints'); await np.waitForLoadState('networkidle');
  await np.getByRole('button', { name: 'Raise complaint' }).first().click();
  await np.locator('.ant-modal .ant-select').first().click();
  await np.keyboard.type('E2E-Vent-1');
  await np.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'E2E-Vent-1' }).first().click();
  await np.locator('.ant-modal textarea').fill('E2E: alarm does not stop');
  await np.locator('.ant-modal-footer .ant-btn-primary').dblclick(); // a double click must not make two
  await np.locator('.ant-message-success', { hasText: /Complaint CMP-\d+ raised/ }).waitFor();
  await np.waitForTimeout(800);
  const list = (await biomed.api('GET', '/complaints?search=E2E:%20alarm&pageSize=50')).body;
  expect(list.items.length === 1, `${list.items.length} complaints created by a double click`);
  made.cmp = list.items[0];
}, np);
await step('Biomedical staff see it Open on the board; there is no Resolve until it is started', async () => {
  await bp.goto(BASE + '/complaints'); await bp.waitForLoadState('networkidle');
  const card = bp.locator('.ant-card', { hasText: made.cmp.complaintNo }).last();
  expect((await card.getByRole('button', { name: 'Start work' }).count()) === 1, 'no Start work');
  expect((await card.getByRole('button', { name: 'Resolve' }).count()) === 0, 'Resolve offered on an open complaint');
  const r = await biomed.api('POST', `/complaints/${made.cmp.id}/resolve`, { resolutionNotes: 'skip' });
  expect(r.status === 409, `resolve on open -> ${r.status}`);
}, bp);
await step('Start work, then Resolve with notes: statuses move one step at a time with server times', async () => {
  const card = () => bp.locator('.ant-card', { hasText: made.cmp.complaintNo }).last();
  await card().getByRole('button', { name: 'Start work' }).click();
  await bp.locator('.ant-message-success', { hasText: /started/ }).waitFor();
  await bp.waitForTimeout(1500);
  await card().getByRole('button', { name: 'Resolve' }).click();
  await bp.locator('.ant-modal textarea').fill('E2E: replaced the sensor');
  await bp.getByRole('button', { name: 'Mark resolved' }).click();
  await bp.locator('.ant-message-success', { hasText: /resolved/ }).waitFor();
  const c = (await biomed.api('GET', `/complaints/${made.cmp.id}`)).body;
  const t = (k) => new Date(c[k]).getTime();
  expect(c.status === 'resolved' && t('startedAt') > t('raisedAt') && t('resolvedAt') > t('startedAt'), 'timestamps not in order');
  expect(c.responseSeconds === Math.round((t('startedAt') - t('raisedAt')) / 1000) && c.downtimeSeconds === Math.round((t('resolvedAt') - t('raisedAt')) / 1000), 'metrics are not started-raised / resolved-raised');
  expect((await biomed.api('POST', `/complaints/${made.cmp.id}/start`)).status === 409, 'a resolved complaint can be started again');
  return `response ${c.responseSeconds}s downtime ${c.downtimeSeconds}s`;
}, bp);
await step('The complaint drawer tells the whole story in order', async () => {
  await bp.getByRole('tab', { name: 'History' }).click(); await bp.waitForTimeout(800);
  await bp.locator('tbody tr', { hasText: made.cmp.complaintNo }).first().click();
  const d = bp.locator('.ant-drawer-body'); await d.waitFor(); await bp.waitForTimeout(800);
  const t = await d.innerText();
  const i = ['Complaint raised', 'Work started', 'Resolved'].map((s) => t.indexOf(s));
  expect(i.every((x) => x >= 0) && i[0] < i[1] && i[1] < i[2], `order ${i}`);
  expect(/Response time/i.test(t) && /Downtime/i.test(t), 'metrics missing');
  await bp.keyboard.press('Escape');
}, bp);
await step('Nursing cannot start or resolve, and sees only its own department', async () => {
  await np.goto(BASE + '/complaints'); await np.waitForLoadState('networkidle');
  expect((await np.getByRole('tab', { name: 'Board' }).count()) === 0 && (await np.getByRole('button', { name: /Start work|Resolve/ }).count()) === 0, 'nursing sees work buttons');
  expect((await nurse.api('POST', `/complaints/${made.cmp.id}/start`)).status === 403, 'API allows nursing to start');
  const all = (await nurse.api('GET', '/complaints?pageSize=100')).body.items;
  expect(all.every((c) => c.departmentName === 'Intensive Care Unit'), 'a foreign department complaint leaked');
}, np);
await step('Nursing asset list, search and direct URL only reach the own department', async () => {
  await np.goto(BASE + '/assets'); await np.waitForLoadState('networkidle'); await np.waitForTimeout(600);
  const rows = await np.locator('tbody tr.ant-table-row').allInnerTexts();
  expect(rows.length > 0 && rows.every((r) => /Intensive Care Unit/.test(r)), `rows: ${rows.length}`);
  await np.keyboard.press('/'); await np.keyboard.type('Spare Monitor'); await np.waitForTimeout(1200);
  expect(/No equipment found/.test(await np.locator('.ant-select-dropdown:visible').innerText().catch(() => '')), 'global search found a BME asset');
  const other = (await admin.api('GET', '/assets?search=Spare%20Monitor')).body.items[0];
  await np.goto(`${BASE}/assets/${other.id}`); await np.waitForLoadState('networkidle');
  expect(/Asset not found/.test(await np.locator('body').innerText()), 'foreign asset page opened');
}, np);

await b.close();
import fs from 'node:fs'; fs.writeFileSync(path.join(OUT, 'made.json'), JSON.stringify(made));
summary();
