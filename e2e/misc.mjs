import fs from 'node:fs';
import ExcelJS from 'exceljs';
import path from 'node:path';
import { OUT, HERE, BASE, launch, session, step, expect, summary } from './lib.mjs';
const FIX = (n) => path.join(HERE, 'fixtures', n);
import { REPORTS } from '@bme/shared';
const b = await launch();

// ---------- Who sees what ----------
const menus = {};
for (const role of ['superadmin', 'admin', 'biomed', 'nursing']) {
  const s = await session(b, `${role}@demo.local`);
  await s.page.waitForTimeout(800);
  menus[role] = await s.page.locator('.ant-menu-item').allInnerTexts();
  await s.ctx.close();
}
await step('Menus match the role table: nursing = Dashboard, Assets, Complaints only', async () => {
  expect(JSON.stringify(menus.nursing) === JSON.stringify(['Dashboard', 'Assets', 'Complaints']), `nursing: ${menus.nursing}`);
  return `biomed: ${menus.biomed.join(', ')} | admin: ${menus.admin.length} items`;
});
await step('Biomedical staff get no user / role / settings / audit menu; the HOD gets all of them', async () => {
  const admin = ['Users', 'Roles & permissions', 'Hospital settings', 'Audit log'];
  expect(admin.every((m) => !menus.biomed.includes(m)), `biomed sees ${menus.biomed}`);
  expect(admin.every((m) => menus.admin.includes(m)), `admin sees ${menus.admin}`);
});

// ---------- Login, logout, session ----------
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage(); p.setDefaultTimeout(15000);
  await step('Login: wrong password says so in plain words and stays on the page', async () => {
    await p.goto(BASE + '/login'); await p.fill('input[type=email]', 'admin@demo.local'); await p.fill('input[type=password]', 'nope'); await p.keyboard.press('Enter');
    const m = await p.locator('.ant-message-error').first().innerText();
    expect(!/stack|undefined|500|TypeError/i.test(m) && m.length > 5, `message "${m}"`);
    expect(/\/login/.test(p.url()), 'left the login page');
    return m;
  }, p);
  await step('Login: empty fields are caught before sending', async () => {
    await p.reload(); await p.waitForLoadState('networkidle'); await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForTimeout(800);
    expect((await p.locator('.ant-form-item-explain-error').count()) >= 2, 'no inline errors');
  }, p);
  await step('Deep link while signed out goes to login, then returns to the page asked for', async () => {
    await p.goto(BASE + '/complaints'); await p.waitForURL(/\/login/);
    await p.fill('input[type=email]', 'nursing@demo.local'); await p.fill('input[type=password]', 'Demo@1234'); await p.keyboard.press('Enter');
    await p.waitForURL((u) => !/\/login/.test(u.pathname));
    expect(/\/complaints/.test(p.url()), `landed on ${p.url()} instead of /complaints`);
  }, p);
  await step('Sign out clears the session: protected pages and the back button show the login', async () => {
    await p.goto(BASE + '/'); await p.waitForLoadState('networkidle');
    await p.locator('[data-testid="account-menu"]').click(); await p.getByText('Sign out').click(); await p.waitForURL(/\/login/);
    await p.goBack(); await p.waitForTimeout(1200);
    expect(/\/login/.test(p.url()) || /Sign in/.test(await p.locator('body').innerText()), 'data still visible after sign out');
    const r = await ctx.request.get(BASE + '/api/v1/assets'); expect(r.status() === 401, `API status ${r.status()}`);
  }, p);
  await step('Session that expires mid-use sends the person to login instead of showing broken pages', async () => {
    await p.goto(BASE + '/login'); await p.fill('input[type=email]', 'biomed@demo.local'); await p.fill('input[type=password]', 'Demo@1234'); await p.keyboard.press('Enter'); await p.waitForURL(BASE + '/');
    await ctx.clearCookies();
    // The app may already have noticed (the bell checks every minute); either way the person must end up at sign-in.
    await p.getByRole('link', { name: 'Complaints', exact: true }).click({ timeout: 4000 }).catch(() => undefined);
    await p.waitForURL(/\/login/, { timeout: 15000 }).catch(() => undefined);
    await p.waitForTimeout(500);
    const t = await p.locator('body').innerText();
    expect(/\/login/.test(p.url()) || /sign in|session/i.test(t), `still on ${p.url()} showing: ${t.slice(0, 120).replace(/\n/g, ' ')}`);
  }, p);
  await ctx.close();
}

// ---------- Notifications (rule 8) ----------
const admin = await session(b, 'admin@demo.local'); const ap = admin.page;
await step('Settings: "Run reminders now" works and says what it did', async () => {
  await ap.goto(BASE + '/admin/settings'); await ap.waitForLoadState('networkidle');
  await ap.getByRole('button', { name: 'Run reminders now' }).click();
  const m = await ap.locator('.ant-message').first().innerText(); return m;
}, ap);
await step('Bell: shows reminders, opening one goes to the asset and marks it read; Mark all as read clears the count', async () => {
  await ap.goto(BASE + '/'); await ap.waitForLoadState('networkidle'); await ap.waitForTimeout(800);
  const bell = ap.locator('button[aria-label^="Reminders"]');
  const before = +(/(\d+) unread/.exec(await bell.getAttribute('aria-label'))?.[1] ?? 0);
  await bell.click(); await ap.locator('.ant-popover .ant-list-item').first().waitFor();
  const first = ap.locator('.ant-popover .ant-list-item').first(); await first.click();
  await ap.waitForURL(/\/(assets|approvals)/, { timeout: 25000 }).catch(() => undefined); // the first visit to a page compiles it in dev
  expect(/\/(assets|approvals)/.test(ap.url()), `went to ${ap.url()}`);
  // The count refreshes a moment after the page changes.
  let mid = before;
  for (let i = 0; i < 20 && mid >= before && before > 0; i++) { await ap.waitForTimeout(300); mid = +(/(\d+) unread/.exec(await ap.locator('button[aria-label^="Reminders"]').getAttribute('aria-label'))?.[1] ?? 0); }
  expect(before === 0 || mid < before, `unread ${before} -> ${mid}`);
  await ap.locator('button[aria-label^="Reminders"]').click(); const all = ap.getByRole('button', { name: 'Mark all as read' });
  if (await all.count()) { await all.click(); await ap.waitForTimeout(800); }
  const after = (await admin.api('GET', '/notifications')).body.unread;
  expect(after === 0, `unread after mark all = ${after}`);
  return `unread ${before} → ${mid} → ${after}`;
}, ap);

// ---------- Excel import ----------
const biomed = await session(b, 'biomed@demo.local'); const bp = biomed.page;
async function xlsx(rows, file) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Assets');
  ws.addRow(['Equipment type code', 'Name', 'Make', 'Model', 'Serial no', 'Department code', 'Location code', 'Criticality', 'Installation date', 'Warranty months', 'PMS frequency months', 'Last PMS done', 'Last calibration done']);
  rows.forEach((r) => ws.addRow(r)); await wb.xlsx.writeFile(file); return file;
}
await step('Import: a bad row is reported by row and column and nothing is imported', async () => {
  const f = await xlsx([['VENT', 'E2E-Imp-1', 'Drager', 'X', '', 'ICU', 'ICU1', 'high', '2019-03-01', 24, 6, '15/09/2026', ''], ['VENT', 'E2E-Imp-2', '', '', '', 'ICU', 'NOPE', 'high', '2019-03-01', 24, 6, '', '']], path.join(OUT, 'imp-bad.xlsx'));
  await bp.goto(BASE + '/assets/import'); await bp.waitForLoadState('networkidle');
  await bp.setInputFiles('input[type=file]', f); await bp.waitForTimeout(2500);
  const t = await bp.locator('body').innerText();
  expect(/Row 3|3/.test(t) && /Location/i.test(t) && /NOPE/.test(t), 'row 3 / location error not explained');
  expect(!(await bp.getByRole('button', { name: /^Import \d/ }).count()), 'import offered despite an error');
  expect((await biomed.api('GET', '/assets?search=E2E-Imp&status=all')).body.items.length === 0, 'rows imported anyway');
}, bp);
await step('Import: a clean file imports, and "Last PMS done" sets the first due date', async () => {
  const f = await xlsx([['VENT', 'E2E-Imp-1', 'Drager', 'X', '', 'ICU', 'ICU1', 'high', '2019-03-01', 24, 6, '15/09/2026', '']], path.join(OUT, 'imp-ok.xlsx'));
  await bp.goto(BASE + '/assets/import'); await bp.waitForLoadState('networkidle');
  await bp.setInputFiles('input[type=file]', f); await bp.getByRole('button', { name: /^Import 1/ }).click();
  await bp.getByText(/imported|View assets/i).first().waitFor();
  const a = (await biomed.api('GET', '/assets?search=E2E-Imp-1&status=all')).body.items[0];
  expect(a.nextPmsDue === '2027-03-15', `next PMS ${a.nextPmsDue}`);
}, bp);

// ---------- Reports from the screen ----------
for (const { type, title } of REPORTS) {
  await step(`Report "${title}": opens on screen with figures, and exports to Excel and PDF`, async () => {
    await ap.goto(`${BASE}/reports/${type}`); await ap.locator('.kpi-grid').waitFor({ timeout: 25000 });
    expect(!(await ap.locator('.ant-alert-error').count()), 'error banner');
    const got = {};
    for (const [fmt, label] of [['xlsx', 'Excel (.xlsx)'], ['pdf', 'PDF']]) {
      await ap.getByRole('button', { name: 'Export' }).click();
      const [dl] = await Promise.all([ap.waitForEvent('download'), ap.getByText(label, { exact: true }).click()]);
      const path = await dl.path(); const head = fs.readFileSync(path).subarray(0, 4).toString('latin1');
      expect(fmt === 'pdf' ? head === '%PDF' : head.startsWith('PK'), `${fmt} file starts with "${head}"`);
      got[fmt] = fs.statSync(path).size;
    }
    return `xlsx ${got.xlsx}B pdf ${got.pdf}B`;
  }, ap);
}
await step('Report filters: changing the period reloads the figures and is kept in the address', async () => {
  await ap.goto(`${BASE}/reports/breakdowns`); await ap.locator('.kpi-grid').waitFor();
  const before = await ap.locator('.kpi-grid').innerText();
  await ap.locator('.ant-picker').click(); await ap.getByText('This month', { exact: true }).click(); await ap.waitForTimeout(2000);
  expect(/from=/.test(ap.url()), 'period not in the URL');
  const after = await ap.locator('.kpi-grid').innerText();
  expect(before !== after, 'figures did not change for a different period');
  await ap.reload(); await ap.locator('.kpi-grid').waitFor(); expect(/from=/.test(ap.url()), 'period lost on reload');
}, ap);

// ---------- Documents ----------
const nurse = await session(b, 'nursing@demo.local');
await step('Documents: upload on an asset, nursing of that department can open it, other files are refused', async () => {
  const a = (await biomed.api('GET', '/assets?search=E2E-Imp-1&status=all')).body.items[0];
  await bp.goto(`${BASE}/assets/${a.id}?tab=documents`); await bp.waitForLoadState('networkidle');
  await bp.setInputFiles('.ant-upload input[type=file]', FIX('photo.png')); await bp.getByText('uploaded').first().waitFor();
  await bp.waitForTimeout(800);
  const link = bp.locator('a[href*="/attachments/"]').first(); const href = await link.getAttribute('href');
  const r = await nurse.ctx.request.get(BASE + href); expect(r.status() === 200 && /image\/png/.test(r.headers()['content-type']), `nursing download ${r.status()}`);
  fs.writeFileSync(path.join(OUT, 'bad.pdf'), 'MZ this is not a pdf');
  await bp.setInputFiles('.ant-upload input[type=file]', path.join(OUT, 'bad.pdf')); await bp.locator('.ant-message-error').first().waitFor();
}, bp);

// ---------- Keyboard and dialogs ----------
await step('Dialogs close with Escape and focus is visible when tabbing', async () => {
  await bp.goto(BASE + '/complaints'); await bp.waitForLoadState('networkidle');
  await bp.getByRole('button', { name: 'Raise complaint' }).first().click(); await bp.locator('.ant-modal').waitFor();
  await bp.waitForTimeout(700); // the dialog takes focus as it opens
  await bp.keyboard.press('Escape'); await bp.waitForTimeout(1000);
  expect(!(await bp.locator('.ant-modal-wrap:visible').count()), 'Escape did not close the dialog');
  await bp.keyboard.press('Tab');
  const outline = await bp.evaluate(() => { const e = document.activeElement; const s = e ? getComputedStyle(e) : null; return s ? `${s.outlineStyle} ${s.outlineWidth} ${s.boxShadow}` : ''; });
  expect(!/^none 0px none$/.test(outline.trim()) , `no visible focus: ${outline}`);
}, bp);

await b.close();
summary();
