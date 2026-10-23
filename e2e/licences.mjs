// Facility maintenance add-on, F3 (docs/requirements-facility.md): statutory licences. The maintenance team sees what
// needs attention, adds a site-wide licence, renews it (the old one stays as history), and the compliance register
// opens; the biomedical team sees only its own (AERB and the like). Everything it creates is named E2E…
import { BASE, launch, session, step, expect, summary, fillField } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };
const day = (n) => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86_400_000));

const b = await launch();
const maint = await session(b, 'maintenance@demo.local');
const biomed = await session(b, 'biomed@demo.local');
const p = maint.page;
const name = `E2E Fire NOC ${Date.now() % 100000}`;

await step('Licences opens on what needs attention: ending soon and expired', async () => {
  await p.goto(BASE + '/licences'); await settle(p);
  const t = await p.locator('main').innerText();
  expect(/Needs attention/.test(t), 'no Needs attention view');
  const rows = await maint.api('GET', '/licences?status=attention');
  expect(rows.body.every((l) => t.includes(l.name)), 'a licence needing attention is not listed');
}, p);

await step('Add a site-wide licence with its dates', async () => {
  await p.getByRole('button', { name: 'Add licence' }).click();
  const dlg = p.locator('.ant-modal', { hasText: 'Add licence' });
  await dlg.locator('.ant-form-item', { hasText: 'Kind' }).locator('.ant-select').click();
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'Fire NOC' }).click();
  await fillField(p, 'Name', name, dlg);
  await fillField(p, 'Issued by', 'Chief Fire Officer', dlg);
  await dlg.getByText('The whole site').click();
  const to = dlg.locator('.ant-form-item', { hasText: 'Valid to' }).locator('input');
  await to.click(); await to.fill(day(15)); await to.press('Tab');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await p.locator('.ant-message-success', { hasText: `${name} added` }).waitFor();
  await settle(p);
  expect((await p.locator('tr', { hasText: name }).innerText()).includes('Whole site'), 'not listed as needing attention');
}, p);

await step('Renew it: the new one is valid, the old one is in the renewal history', async () => {
  await p.locator('tr', { hasText: name }).getByRole('button', { name: 'Renew' }).click();
  const dlg = p.locator('.ant-modal', { hasText: `Renew ${name}` });
  const to = dlg.locator('.ant-form-item', { hasText: 'Valid to' }).locator('input');
  await to.click(); await to.fill(day(380)); await to.press('Tab');
  await dlg.getByRole('button', { name: 'Save renewal' }).click();
  await p.locator('.ant-message-success', { hasText: 'renewed until' }).waitFor();
  await p.getByText('Renewal history').click(); await settle(p);
  expect(/Renewed/.test(await p.locator('tr', { hasText: name }).innerText()), 'old one not in the history');
  await p.getByText('All current').click(); await settle(p);
  expect(/Valid/.test(await p.locator('tr', { hasText: name }).innerText()), 'renewal not valid');
}, p);

await step('The compliance register opens with its tables', async () => {
  await p.goto(BASE + '/licences'); await settle(p);
  await p.getByRole('link', { name: 'Compliance register' }).click(); await settle(p);
  const t = await p.locator('main').innerText();
  expect(t.includes('Compliance register') && t.includes('Expired or ending'), `page shows: ${t.slice(0, 160).replace(/\s+/g, ' ')}`);
}, p);

await step('Biomedical staff see only their own team’s licences', async () => {
  const bp = biomed.page;
  await bp.goto(BASE + '/licences'); await settle(bp);
  await bp.getByText('All current').click(); await settle(bp);
  expect(!(await bp.locator('main').innerText()).includes(name), 'a facility licence is shown to biomedical staff');
}, biomed.page);

await b.close();
summary();
