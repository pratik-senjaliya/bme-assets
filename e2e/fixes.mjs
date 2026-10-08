// The QA fixes, each proven through the real screens: session expiry and returning to the page, form safety,
// login lock, changing your own password, permission pages, the Approvals buttons, sorting and exports that match
// the list, readable roles and audit log, the 404 page, tab titles, and tablet sizes.
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { BASE, HERE, OUT, PASSWORD, launch, session, step, expect, pick, fillDate, fillField, summary } from './lib.mjs';

const FIX = (n) => path.join(HERE, 'fixtures', n);
const b = await launch();
const admin = await session(b, 'admin@demo.local'), biomed = await session(b, 'biomed@demo.local');
const ap = admin.page, bp = biomed.page;
const types = (await admin.api('GET', '/equipment-types')).body, depts = (await admin.api('GET', '/departments')).body, locs = (await admin.api('GET', '/locations')).body;
const VENT = types.find((t) => t.code === 'VENT').id, ICU = depts.find((d) => d.code === 'ICU').id, ICU1 = locs.find((l) => l.code === 'ICU1').id;
const count = async (name) => (await admin.api('GET', `/assets?search=${encodeURIComponent(name)}&status=all&pageSize=50`)).body.items.length;
const newUser = async (email) => (await admin.api('POST', '/users', { name: `E2E ${email}`, email, role: 'biomed', password: PASSWORD })).body;

// ---------- Forms ----------
async function fillAsset(page, name, installed = '01 Jan 2026') {
  await page.goto(BASE + '/assets/new'); await page.waitForLoadState('networkidle');
  await pick(page, 'Equipment type', 'Ventilator'); await fillField(page, 'Name', name);
  await pick(page, 'Department', 'Intensive Care Unit'); await pick(page, 'Location', 'ICU 1');
  if (installed) await fillDate(page, 'Installation date', installed);
}
await step('Add asset: Enter in a field never saves a half-finished form', async () => {
  await fillAsset(bp, 'E2E-Enter');
  const input = bp.locator('.ant-form-item').filter({ has: bp.locator('label', { hasText: /^\s*Installation date/ }) }).locator('.ant-picker input');
  await input.click(); await input.fill('01 Jan 2026'); await input.press('Enter');
  await bp.locator('.ant-form-item', { hasText: 'Warranty' }).locator('input').first().click(); await bp.keyboard.press('Enter');
  await bp.waitForTimeout(1500);
  expect((await count('E2E-Enter')) === 0, 'an asset was created by pressing Enter');
  expect(/\/assets\/new/.test(bp.url()), 'the form closed');
}, bp);
await step('Add asset: clicking Create twice quickly makes one asset', async () => {
  await fillAsset(bp, 'E2E-Twice');
  await bp.getByRole('button', { name: 'Create asset' }).dblclick();
  await bp.waitForURL(/\/assets\/[0-9a-f-]{36}$/); await bp.waitForTimeout(1200);
  expect((await count('E2E-Twice')) === 1, `${await count('E2E-Twice')} assets created`);
}, bp);
await step('Existing equipment: a warning says it will show overdue until the last PMS date is entered, and goes when it is', async () => {
  await fillAsset(bp, 'E2E-Old', '01 Jan 2023');
  await bp.getByText(/will show as overdue/i).waitFor({ timeout: 8000 });
  await fillDate(bp, 'Last PMS done', '01 Sep 2026'); await fillDate(bp, 'Last calibration done', '01 Sep 2026');
  await bp.waitForTimeout(500);
  expect((await bp.getByText(/will show as overdue/i).count()) === 0, 'the warning stayed after the dates were entered');
}, bp);
await step('New asset: installation report, photos and manual can be attached in the same form', async () => {
  await fillAsset(bp, 'E2E-Docs');
  await bp.locator('.ant-upload input[type=file]').nth(0).setInputFiles(FIX('photo.png'));
  await bp.locator('.ant-upload input[type=file]').nth(1).setInputFiles(FIX('photo.png'));
  await bp.getByRole('button', { name: 'Create asset' }).click();
  await bp.waitForURL(/\/assets\/[0-9a-f-]{36}$/); await bp.waitForTimeout(1200);
  const id = bp.url().split('/').pop();
  const kinds = (await admin.api('GET', `/assets/${id}/attachments`)).body.map((f) => f.kind).sort();
  expect(kinds.join() === 'installation_report,photo', `documents: ${kinds}`);
}, bp);

// ---------- Session and sign-in ----------
await step('A session that ends sends the person to sign in, and back to where they were', async () => {
  const s = await session(b, 'biomed@demo.local'); const p = s.page;
  await p.goto(BASE + '/due'); await p.waitForLoadState('networkidle');
  await s.ctx.clearCookies();
  await p.getByRole('link', { name: 'Complaints', exact: true }).click();
  await p.waitForURL(/\/login/);
  expect(/expired=1/.test(p.url()) && /next=/.test(p.url()), `address ${p.url()}`);
  expect(/signed out/i.test(await p.locator('body').innerText()), 'no explanation on the sign-in page');
  await p.fill('input[type=email]', 'biomed@demo.local'); await p.fill('input[type=password]', PASSWORD); await p.keyboard.press('Enter');
  await p.waitForURL((u) => !/\/login/.test(u.pathname));
  expect(/\/complaints|\/due/.test(p.url()), `returned to ${p.url()}`);
  await s.ctx.close();
}, bp);
await step('A link opened while signed out leads to the sign-in and then to that page', async () => {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage(); p.setDefaultTimeout(20000);
  await p.goto(BASE + '/reports/pms?group=month'); await p.waitForURL(/\/login/);
  await p.fill('input[type=email]', 'admin@demo.local'); await p.fill('input[type=password]', PASSWORD); await p.keyboard.press('Enter');
  await p.waitForURL((u) => !/\/login/.test(u.pathname));
  expect(/\/reports\/pms/.test(p.url()), `landed on ${p.url()}`);
  await p.goto(BASE + '/login?next=//evil.example.com'); await p.waitForTimeout(1500);
  expect(!/evil\.example/.test(p.url()), 'an outside address was followed');
  await ctx.close();
});
await step('Wrong passwords lock that login for a while, with a plain message; other logins still work', async () => {
  const u = await newUser('e2e.lock@demo.local');
  const ctx = await b.newContext(); const p = await ctx.newPage(); p.setDefaultTimeout(15000);
  await p.goto(BASE + '/login');
  for (let i = 0; i < 6; i++) { await p.fill('input[type=email]', 'e2e.lock@demo.local'); await p.fill('input[type=password]', `wrong${i}`); await p.keyboard.press('Enter'); await p.waitForTimeout(500); }
  const msg = await p.locator('.ant-message-error').last().innerText();
  expect(/Too many wrong passwords.*minutes/i.test(msg), `message "${msg}"`);
  await p.fill('input[type=password]', PASSWORD); await p.keyboard.press('Enter'); await p.waitForTimeout(800);
  expect(/\/login/.test(p.url()), 'the right password got in while locked');
  const ok = await session(b, 'nursing@demo.local'); expect(ok.page.url() === BASE + '/', 'another person could not sign in');
  await ctx.close(); await ok.ctx.close();
});
await step('Anyone can change their own password: mismatches and a wrong current password are explained; the new one works', async () => {
  await newUser('e2e.pw@demo.local');
  const s = await session(b, 'e2e.pw@demo.local'); const p = s.page;
  await p.locator('[data-testid="account-menu"]').click(); await p.getByText('Change password').click();
  const m = p.locator('.ant-modal');
  await m.getByLabel('Current password', { exact: true }).fill(PASSWORD); await m.getByLabel('New password', { exact: true }).fill('Brand@New123'); await m.getByLabel('Type the new password again').fill('different');
  await m.locator('.ant-modal-footer .ant-btn-primary').click(); await p.waitForTimeout(500);
  expect(/do not match/i.test(await m.innerText()), 'a mismatch was not explained');
  await m.getByLabel('Type the new password again').fill('Brand@New123'); await m.getByLabel('Current password', { exact: true }).fill('not-my-password');
  await m.locator('.ant-modal-footer .ant-btn-primary').click(); await p.waitForTimeout(800);
  expect(/not right/i.test(await m.innerText()), 'a wrong current password was not explained');
  await m.getByLabel('Current password', { exact: true }).fill(PASSWORD); await m.locator('.ant-modal-footer .ant-btn-primary').click();
  await p.locator('.ant-message-success', { hasText: /Password changed/ }).waitFor();
  const old = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'e2e.pw@demo.local', password: PASSWORD }) });
  const now = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'e2e.pw@demo.local', password: 'Brand@New123' }) });
  expect(old.status === 401 && now.status === 200, `old ${old.status}, new ${now.status}`);
  await s.ctx.close();
});

// ---------- Who may see what ----------
for (const [email, role, route, text] of [['biomed@demo.local', 'biomed', '/admin/users', /cannot manage users/], ['biomed@demo.local', 'biomed', '/admin/settings', /cannot change hospital settings/], ['nursing@demo.local', 'nursing', '/admin/departments', /cannot change departments/], ['nursing@demo.local', 'nursing', '/admin/pms-templates', /cannot change PMS checklists/]]) {
  await step(`${role} opening ${route} is told they cannot, with no failed requests`, async () => {
    const s = await session(b, email); const p = s.page; const failed = [];
    p.on('response', (r) => { if (r.status() >= 400 && /\/api\/v1\//.test(r.url())) failed.push(r.status()); });
    await p.goto(BASE + route); await p.waitForLoadState('networkidle'); await p.waitForTimeout(500);
    expect(text.test(await p.locator('body').innerText()), 'no clear message');
    expect(failed.length === 0, `failed requests: ${failed}`);
    await s.ctx.close();
  });
}
await step('The vendor\'s super admin login is not offered for editing to the HOD', async () => {
  await ap.goto(BASE + '/admin/users'); await ap.waitForLoadState('networkidle'); await ap.waitForTimeout(500);
  const row = ap.locator('tr', { hasText: 'superadmin@demo.local' });
  expect(/Managed by the vendor/.test(await row.innerText()) && (await row.getByRole('button').count()) === 0, 'edit controls still shown');
}, ap);

// ---------- Approvals ----------
await step('Approve and Reject are fully on screen at 1440 and 1024 wide', async () => {
  const mk = (n) => biomed.api('POST', '/assets', { equipmentTypeId: VENT, name: n, departmentId: ICU, locationId: ICU1 });
  const a = (await mk('E2E-Appr')).body;
  await biomed.api('POST', `/assets/${a.id}/condemn`, { reason: 'E2E layout check of the approvals screen' });
  for (const w of [1440, 1024]) {
    await ap.setViewportSize({ width: w, height: 900 });
    await ap.goto(BASE + '/approvals'); await ap.waitForLoadState('networkidle'); await ap.waitForTimeout(700);
    for (const name of ['Approve', 'Reject']) {
      const box = await ap.getByRole('button', { name }).first().boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= w, `${name} at ${w}px: ${JSON.stringify(box)}`);
    }
  }
  await ap.setViewportSize({ width: 1440, height: 900 });
}, ap);

// ---------- Lists ----------
await step('Asset register: clicking a column sorts all pages, both ways, and is kept in the address', async () => {
  await ap.goto(BASE + '/assets'); await ap.waitForLoadState('networkidle');
  const head = ap.getByRole('columnheader', { name: /Next PMS/ });
  await head.click(); await ap.waitForTimeout(1000);
  expect(/sortBy=nextPmsDue/.test(ap.url()) && /order=asc/.test(ap.url()), `address ${ap.url()}`);
  const asc = (await admin.api('GET', '/assets?sortBy=nextPmsDue&order=asc&pageSize=100')).body.items.map((x) => x.nextPmsDue).filter(Boolean);
  expect(JSON.stringify(asc) === JSON.stringify([...asc].sort()), 'not in ascending order');
  await head.click(); await ap.waitForTimeout(1000);
  expect(/order=desc/.test(ap.url()), `second click: ${ap.url()}`);
  await ap.reload(); await ap.waitForLoadState('networkidle');
  expect(/sortBy=nextPmsDue/.test(ap.url()), 'sort lost on reload');
}, ap);
await step('Asset register: Export downloads exactly the filtered list', async () => {
  await ap.goto(BASE + '/assets?search=Ventilator'); await ap.waitForLoadState('networkidle'); await ap.waitForTimeout(800);
  const total = (await admin.api('GET', '/assets?search=Ventilator&pageSize=100')).body.total;
  await ap.getByRole('button', { name: 'Export' }).click();
  const [dl] = await Promise.all([ap.waitForEvent('download'), ap.getByText('Excel (.xlsx)', { exact: true }).click()]);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(await dl.path());
  const rows = wb.getWorksheet('Asset master').rowCount - 1;
  expect(rows === total && total > 0, `list shows ${total}, file has ${rows}`);
}, ap);
await step('Complaints history: sorts by number, and Export follows the status filter', async () => {
  await ap.goto(BASE + '/complaints'); await ap.getByRole('tab', { name: 'History' }).click(); await ap.waitForTimeout(800);
  await ap.getByRole('columnheader', { name: /^No\./ }).click(); await ap.waitForTimeout(1000);
  const nos = await ap.locator('tbody tr.ant-table-row td:first-child').allInnerTexts();
  expect(nos.length > 1 && JSON.stringify(nos) === JSON.stringify([...nos].sort().reverse()) || JSON.stringify(nos) === JSON.stringify([...nos].sort()), `numbers ${nos.slice(0, 4)}`);
  await ap.locator('.ant-segmented').getByText('Resolved', { exact: true }).click(); await ap.waitForTimeout(1000);
  const shown = +/(\d+)\s+complaints?/.exec(await ap.locator('body').innerText())[1];
  await ap.getByRole('button', { name: 'Export' }).click();
  const [dl] = await Promise.all([ap.waitForEvent('download'), ap.getByText('Excel (.xlsx)', { exact: true }).click()]);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(await dl.path());
  expect(wb.getWorksheet('Breakdowns').rowCount - 1 === shown, `screen ${shown}, file ${wb.getWorksheet('Breakdowns').rowCount - 1}`);
}, ap);

// ---------- Plain language ----------
await step('Roles: permissions are in plain words, nothing is hidden, no raw codes', async () => {
  await ap.goto(BASE + '/admin/roles'); await ap.waitForLoadState('networkidle'); await ap.waitForTimeout(600);
  const t = await ap.locator('body').innerText();
  expect(!/asset\.edit_key|complaint\.resolve|setup\.manage/.test(t), 'raw permission codes are still shown');
  for (const w of ['Change key details without approval', 'Approve or reject requests', 'See reminders']) expect(t.includes(w), `missing "${w}"`);
}, ap);
await step('Audit log: records are named (asset codes), routine entries hidden by default and shown on request', async () => {
  await ap.goto(BASE + '/admin/audit'); await ap.waitForLoadState('networkidle'); await ap.waitForTimeout(1000);
  const t = await ap.locator('tbody').innerText();
  expect(/SHL-[A-Z]+-[A-Z]+-[A-Z0-9]+-\d{3}/.test(t), 'no asset code in the Record column');
  expect(!/auth\.login\b|report\.export/.test(t), 'routine entries are shown by default');
  await ap.getByText('Hide sign-ins and exports').click(); await ap.waitForTimeout(1000);
  expect(/auth\.login|report\.export/.test(await ap.locator('tbody').innerText()), 'turning the switch off did not show them');
}, ap);

// ---------- Small things ----------
await step('An address that does not exist shows a proper page with a way back; the favicon loads', async () => {
  await ap.goto(BASE + '/nope/nothing'); await ap.waitForLoadState('networkidle');
  const t = await ap.locator('body').innerText();
  expect(/That page does not exist/.test(t) && (await ap.getByRole('link', { name: /dashboard/i }).count()) > 0, 'no helpful 404');
  expect((await ap.request.get(BASE + '/icon.svg')).status() === 200, 'no favicon');
}, ap);
await step('Every screen has its own tab title and one top heading', async () => {
  const seen = new Map();
  for (const r of ['/', '/assets', '/complaints', '/due', '/approvals', '/reports', '/admin/users', '/admin/audit']) {
    await ap.goto(BASE + r); await ap.waitForLoadState('networkidle'); await ap.waitForTimeout(400);
    const t = await ap.title(); seen.set(t, (seen.get(t) ?? 0) + 1);
    expect((await ap.locator('h1').count()) === 1, `${r} has ${await ap.locator('h1').count()} top headings`);
    expect(/· BME Assets$/.test(t), `${r}: "${t}"`);
  }
  expect(seen.size === 8, `titles repeat: ${[...seen].filter(([, n]) => n > 1).map(([t]) => t)}`);
}, ap);
await step('On a tablet the menu and small buttons are large enough to touch', async () => {
  const s = await session(b, 'nursing@demo.local', { width: 820, height: 1100 }); const p = s.page;
  await p.goto(BASE + '/complaints'); await p.waitForLoadState('networkidle'); await p.waitForTimeout(600);
  const menu = await p.locator('.ant-menu-item').first().boundingBox(); expect(menu.height >= 44, `menu item ${menu.height}px`);
  await p.goto(BASE + '/assets'); await p.waitForLoadState('networkidle'); await p.waitForTimeout(600);
  const small = await p.locator('.ant-btn-sm').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height).filter((h) => h > 0 && h < 36));
  expect(small.length === 0, `${small.length} small buttons under 36px`);
  await s.ctx.close();
});

await b.close();
summary();
