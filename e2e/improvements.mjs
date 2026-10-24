// Pending improvements (24 Oct 2026): the machine-or-trade picker on the complaints board, costs booked on a ward
// complaint without a machine, and the warning before the 12-hour sign-in ends. Everything it creates is named E2E-….
import { BASE, PASSWORD, launch, session, step, expect, summary } from './lib.mjs';
const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(700); };

const b = await launch();
const admin = await session(b, 'admin@demo.local');
const maint = await session(b, 'maintenance@demo.local');
const nurse = await session(b, 'nursing@demo.local');
const [trades, locs] = await Promise.all(['/trades', '/locations'].map(async (p) => (await nurse.api('GET', p)).body));
const plumbing = trades.find((t) => t.name === 'Plumbing and water');
const icu1 = locs.find((l) => l.code === 'ICU1');
const ward = (await nurse.api('POST', '/complaints', { tradeId: plumbing.id, locationId: icu1.id, description: 'E2E-Improve basin tap leaking' })).body;

await step('Complaints board: "Machine or trade" shows one trade’s ward faults', async () => {
  const p = admin.page;
  await p.goto(BASE + '/complaints'); await settle(p);
  await p.getByRole('combobox', { name: 'Machine or trade' }).click();
  await p.keyboard.type('Plumb');
  await p.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'Plumbing and water' }).click();
  await settle(p);
  const cards = await p.locator('.ant-card .ant-card').allInnerTexts();
  expect(cards.some((t) => t.includes(ward.complaintNo)), 'the plumbing complaint is not on the board');
  expect(cards.every((t) => /Plumbing and water/.test(t)), 'other complaints are still shown');
}, admin.page);

await step('Maintenance resolves the ward complaint with the cost of a part', async () => {
  await maint.api('POST', `/complaints/${ward.id}/start`, {});
  const p = maint.page;
  await p.goto(`${BASE}/complaints?open=${ward.id}`); await settle(p);
  await p.locator('.ant-drawer').getByRole('button', { name: 'Resolve' }).click();
  const m = p.locator('.ant-modal:visible');
  await m.locator('textarea').first().fill('Changed the tap washer');
  await m.getByRole('button', { name: 'Add a part or cost' }).click();
  await m.getByLabel('Amount (₹)').fill('350');
  await m.getByLabel('What was paid for').fill('E2E tap washer');
  await m.getByRole('button', { name: 'Mark resolved' }).click();
  await p.locator('.ant-message-success').first().waitFor();
  const c = (await maint.api('GET', `/complaints/${ward.id}`)).body;
  expect(c.status === 'resolved' && c.expenses.length === 1 && c.expenses[0].amount === 350, `complaint ${c.status}, expenses ${JSON.stringify(c.expenses)}`);
}, maint.page);

await step('Two minutes before the 12-hour sign-in ends, "Stay signed in" carries on', async () => {
  await admin.api('PUT', '/settings', { idleLogoutMinutes: 0 }); // the clock jumps ahead: no idle sign-out meanwhile
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage(); p.setDefaultTimeout(20000);
  await p.clock.install();
  await p.goto(BASE + '/login');
  await p.fill('input[autocomplete=username]', 'biomed@demo.local'); await p.fill('input[type=password]', PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL((u) => !/\/login/.test(u.pathname)); await settle(p);
  await p.clock.fastForward('11:58:30');
  const m = p.locator('.ant-modal', { hasText: 'Your sign-in is about to end' });
  await m.waitFor();
  const [res] = await Promise.all([p.waitForResponse((r) => r.url().endsWith('/api/v1/auth/refresh')), m.getByRole('button', { name: 'Stay signed in' }).click()]);
  expect(res.status() === 200, `refresh ${res.status()}`);
  await ctx.close();
}, admin.page);
await admin.api('PUT', '/settings', { idleLogoutMinutes: 30 });

await b.close();
summary();
