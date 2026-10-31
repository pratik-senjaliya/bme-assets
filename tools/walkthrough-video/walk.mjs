// walk.mjs: the walkthrough. Run: node walk.mjs [part ...]  (FAST=1 for a dry run without recording). See README.md.
import { open, closeAll, person, sleep, OUT } from './kit.mjs';

const VENT_A = 'SHL-ICU-VENT-ICU1-001'; // ICU Ventilator A
const VENT_B = 'SHL-ICU-VENT-ICU1-002'; // ICU Ventilator B
const CONDEMNED = 'SHL-WARD-MON-W2-018'; // Ward Monitor (condemned in the demo)
const COMPLAINT_ASSET = 'SHL-ICU-MON-ICU1-008'; // Bedside Monitor ICU-2
const only = process.argv.slice(2);
const want = (n) => !only.length || only.includes(n);

await open();
const shot = async (a, n) => a.page.screenshot({ path: `${OUT}/fail-${n}.png` }).catch(() => {});

async function part(name, fn, a) {
  if (!want(name)) return;
  try { await fn(); } catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); if (a?.()) await shot(a(), name); throw e; }
}

let hod, eng, nurse;

// ---------------- Part 1: HOD overview ----------------
await part('p1a', async () => {
  hod = await person('admin@demo.local', { login: false });
  const h = hod;
  await h.go('/login');
  await h.card('Product walkthrough', 'BME Asset Management', 'Equipment, PMS, calibration, complaints, approvals and reports for the hospital’s biomedical engineering department.');
  await sleep(600);
  await h.start('01-intro-login');
  await sleep(1200);
  await h.say('intro1');
  await h.say('intro2');
  await h.cardOff();
  h.chip = 'Getting started';
  await h.say('login1', async () => {
    await h.type('input[autocomplete=username]', 'admin@demo.local');
    await h.type('input[type=password]', 'Demo@1234', 40);
  });
  await h.say('login2', async () => {
    await sleep(5000);
    await h.click('button[type=submit]', { after: 0 });
    await h.page.waitForURL((u) => !/\/login/.test(u.pathname));
    await h.settle();
  });
  h.chip = 'Part 1 · The HOD’s overview';
  await h.say('dash1', async () => {
    await sleep(2500);
    await h.mark(h.page.locator('.ant-card', { hasText: 'Not safe to use' }).first(), 6000);
  });
  await h.say('dash2', async () => { await h.scroll(560, 1800); });
  await h.say('dash3', async () => { await h.scroll(700, 2500); await sleep(2500); await h.scroll(800, 2500); await sleep(2000); await h.scroll(900, 2500); });
  await h.say('dash4', async () => {
    await h.top();
    await h.click(h.page.getByText('Biomedical', { exact: true }).first(), { after: 1800 });
    await h.click(h.page.getByText('Facility', { exact: true }).first(), { after: 1800 });
    await h.click(h.page.getByText('All equipment', { exact: true }).first(), { after: 800 });
  });
  await h.say('search1', async () => {
    await h.type(h.page.getByPlaceholder(/Search equipment/).first(), 'ventilator', 110);
    await sleep(1500);
    await h.click(h.page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'ICU Ventilator A' }).first(), { after: 0 });
    await h.page.waitForURL(/\/assets\/[0-9a-f-]+$/);
    await h.settle();
  });
  await h.stop();
}, () => hod);

await part('p1b', async () => {
  hod ??= await person('admin@demo.local');
  const h = hod; h.chip = 'Part 1 · The machine’s page';
  if (!/\/assets\//.test(h.page.url())) await h.go('/assets/' + await h.idOf(VENT_A));
  await h.start('02-asset');
  await h.say('asset1', async () => { await sleep(1500); await h.mark(h.page.locator('main h1').first(), 3000); await h.mark(h.page.locator('main .code, main code').first(), 4000); });
  await h.say('asset2', async () => { await h.mark(h.page.locator('main .ant-alert').first(), 7000); });
  const tab = (n) => h.click(h.page.getByRole('tab', { name: n, exact: true }), { after: 400 });
  await h.say('asset3', async () => { await sleep(3500); await h.scroll(420, 1500); await sleep(2000); await h.scroll(400, 1500); });
  await h.say('asset4', async () => { await h.top(); await tab('Timeline'); await h.scroll(300, 1500); await sleep(1500); await h.scroll(300, 1500); });
  await h.say('asset5', async () => { await h.top(); await tab('PMS'); await sleep(3500); await tab('Calibration'); });
  await h.say('asset6', async () => { await tab('Service log'); await sleep(2800); await tab('Complaints'); await sleep(3500); await tab('Expenses'); });
  await h.say('asset7', async () => { await tab('Purchase & contracts'); await sleep(4500); await tab('Documents'); });
  await h.say('asset8', async () => {
    await h.top(); await tab('Overview');
    await h.click(h.page.locator('main').getByRole('button', { name: 'More' }).first(), { after: 300 });
    const items = h.page.locator('.ant-dropdown:visible .ant-dropdown-menu-item');
    const n = await items.count();
    for (let i = 0; i < n; i++) await h.move(items.nth(i), { ms: 450 });
    await sleep(1000);
    await h.page.keyboard.press('Escape');
  });
  await h.stop();
}, () => hod);

await part('p1c', async () => {
  hod ??= await person('admin@demo.local');
  const h = hod; h.chip = 'Part 1 · The asset register';
  await h.start('03-register');
  await h.say('list1', async () => {
    await h.nav('Assets');
    await h.click(h.page.getByText('Condemned', { exact: true }).first(), { after: 1600 });
    await h.click(h.page.getByText('Transferred', { exact: true }).first(), { after: 1600 });
    await h.click(h.page.getByText('Active', { exact: true }).first(), { after: 500 });
  });
  await h.say('list2', async () => {
    await h.click(h.page.locator('main .ant-select', { hasText: 'Criticality' }).first(), { after: 1600 });
    await h.page.keyboard.press('Escape');
    await h.click(h.page.locator('main .ant-select', { hasText: 'Condition' }).first(), { after: 1600 });
    await h.page.keyboard.press('Escape');
    await h.mark(h.page.locator('main').getByText('Out of service').first(), 2500);
    await h.mark(h.page.locator('main th', { hasText: 'Next PMS' }).first(), 2500);
  });
  await h.say('list3', async () => {
    await h.move(h.page.getByRole('button', { name: 'Export' }).first());
    await sleep(2500);
    await h.click(h.page.getByRole('button', { name: 'QR labels' }).first(), { after: 300 });
    await h.settle();
  });
  await h.say('labels1', async () => {
    await sleep(2500);
    await h.click(h.page.getByText('PMS stickers', { exact: true }).first(), { after: 2500 });
    await h.click(h.page.getByText('QR labels', { exact: true }).last(), { after: 500 });
    await h.scroll(400, 1500);
  });
  await h.go('/assets');
  await h.say('add1', async () => {
    await h.click(h.page.getByRole('link', { name: 'Add asset' }).or(h.page.getByRole('button', { name: 'Add asset' })).first(), { after: 300 });
    await h.settle();
    await sleep(1500); await h.scroll(450, 1800); await sleep(1500); await h.scroll(450, 1800);
  });
  await h.say('add2', async () => { await h.scroll(500, 1800); await sleep(2500); await h.scroll(600, 1800); });
  await h.go('/assets');
  await h.say('import1', async () => {
    await h.click(h.page.getByRole('link', { name: 'Import from Excel' }).or(h.page.getByRole('button', { name: 'Import from Excel' })).first(), { after: 300 });
    await h.settle();
    await sleep(2000); await h.scroll(400, 1500);
  });
  await h.stop();
}, () => hod);

// ---------------- Part 2: engineer ----------------
await part('p2', async () => {
  eng ??= await person('biomed@demo.local');
  const e = eng; e.chip = 'Part 2 · The engineer’s day';
  await e.go('/my-work');
  await e.card('Part 2', 'The engineer’s day', 'My work, PMS with a locked date, OEM PMS and calibration.');
  await e.start('04-engineer');
  await sleep(800);
  await e.say('part2');
  await e.cardOff();
  await e.say('work1', async () => { await sleep(2500); await e.scroll(500, 2000); await sleep(1500); await e.scroll(600, 2000); });
  await e.say('due1', async () => { await e.nav('Due & overdue'); await sleep(1500); await e.click(e.page.getByRole('tab', { name: /Calibration/ }), { after: 1500 }); await e.click(e.page.getByRole('tab', { name: /PMS/ }), { after: 300 }); });
  await e.say('pms1', async () => {
    const row = e.page.locator('tr', { hasText: 'SHL-ICU-MON-ICU2-009' });
    await e.click(row.getByRole('button', { name: 'Perform PMS' }).or(row.getByRole('link', { name: 'Perform PMS' })).first(), { after: 300 });
    await e.settle();
    await e.mark(e.page.locator('main .ant-alert').first(), 5000);
  });
  await e.say('pms2', async () => {
    const pass = e.page.locator('main').getByText('Pass', { exact: true });
    const n = await pass.count();
    for (let i = 0; i < n; i++) await e.click(pass.nth(i), { after: 250, ms: 500 });
    const nums = e.page.locator('main .ant-input-number input'); const vals = ['98', '120'];
    for (let i = 0; i < await nums.count(); i++) await e.type(nums.nth(i), vals[i] ?? '1', 90);
    const remarks = e.page.locator('main textarea').last();
    await e.type(remarks, 'Checked against the patient simulator, all OK.', 35);
  });
  await e.say('pms3', async () => {
    await e.click(e.page.getByRole('button', { name: 'Submit PMS' }), { after: 300 });
    const ok = e.page.locator('.ant-modal:visible .ant-btn-primary');
    if (await ok.count()) await e.click(ok.first(), { after: 300 });
    await e.page.waitForURL(/\/pms\//); await e.settle();
    await sleep(1500); await e.scroll(400, 1500);
  });
  await e.say('pms4', async () => {
    await e.top();
    const b = e.page.locator('main').getByRole('button', { name: /sticker/i }).or(e.page.locator('main').getByRole('link', { name: /sticker/i })).first();
    if (await b.count()) await e.move(b);
  });
  await e.go('/assets/' + await e.idOf(VENT_B));
  await e.page.getByRole('tab', { name: 'PMS', exact: true }).waitFor({ timeout: 60000 });
  await e.say('oem1', async () => {
    await e.click(e.page.getByRole('tab', { name: 'PMS', exact: true }), { after: 800 });
    await e.click(e.page.getByRole('button', { name: /OEM/ }).or(e.page.getByRole('link', { name: /OEM/ })).first(), { after: 300 });
    await e.settle(); await sleep(1500); await e.scroll(450, 1800); await sleep(1500); await e.scroll(500, 1800);
  });
  await e.go('/assets/' + await e.idOf(VENT_B));
  await e.page.getByRole('tab', { name: 'Calibration', exact: true }).waitFor({ timeout: 60000 });
  await e.say('cal1', async () => {
    await e.click(e.page.getByRole('tab', { name: 'Calibration', exact: true }), { after: 800 });
    await e.scroll(300, 1500);
  });
  await e.stop();
}, () => eng);

// ---------------- Part 3: one complaint ----------------
await part('p3', async () => {
  nurse ??= await person('nursing@demo.local');
  hod ??= await person('admin@demo.local');
  eng ??= await person('biomed@demo.local');
  const n = nurse; n.chip = 'Part 3 · The ward raises a complaint';
  await n.go('/');
  await n.card('Part 3', 'One complaint, start to finish', 'The ward raises it, the HOD assigns it, the engineer fixes it, and the ward closes it.');
  await n.start('05-nurse-raise');
  await sleep(800);
  await n.say('part3');
  await n.cardOff();
  await n.say('nurse1', async () => { await sleep(1500); await n.mark(n.page.locator('.ant-card', { hasText: 'Not safe to use' }).first(), 3500); await n.mark(n.page.locator('main').getByText('Something broken in the ward').first(), 4000); });
  await n.say('nurse2', async () => {
    await n.click(n.page.locator('main').getByRole('link', { name: 'Raise complaint' }).or(n.page.locator('main').getByRole('button', { name: 'Raise complaint' })).first(), { after: 300 });
    await n.settle();
    if (!(await n.page.locator('.ant-modal:visible').count())) await n.click(n.page.locator('main').getByRole('button', { name: 'Raise complaint' }).first(), { after: 600 });
    const m = n.page.locator('.ant-modal:visible');
    await n.click(m.locator('.ant-form-item', { hasText: 'Equipment' }).locator('.ant-select'), { after: 200 });
    await n.page.keyboard.type('Monitor ICU-2', { delay: 70 });
    await sleep(1200);
    await n.click(n.page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: COMPLAINT_ASSET }).first(), { after: 300 });
    await n.type(m.locator('textarea').first(), 'Screen flickers and the SpO2 reading keeps dropping out.', 40);
    await n.move(m.getByText(/^Urgent/).first()); await sleep(1500);
  });
  await n.say('nurse3', async () => {
    const m = n.page.locator('.ant-modal:visible');
    await n.click(m.getByText('Something else in the ward', { exact: true }), { after: 1500 });
    await n.move(m.locator('.ant-form-item', { hasText: 'What kind of problem' }).locator('.ant-select')); await sleep(1500);
    await n.click(m.getByText('A machine', { exact: true }), { after: 800 });
    await n.click(m.locator('.ant-modal-footer .ant-btn-primary'), { after: 300 });
    await n.page.locator('.ant-message-success').first().waitFor();
    await n.settle();
  });
  await n.stop();

  const h = hod; h.chip = 'Part 3 · The HOD assigns it';
  await h.go('/complaints');
  await h.start('06-board');
  const card = () => h.page.locator('.ant-card', { has: h.page.getByText(COMPLAINT_ASSET) }).filter({ hasText: 'SpO2' }).last();
  await h.say('board1', async () => { await sleep(1500); await h.scroll(300, 1500); await sleep(1500); await h.top(); });
  await h.say('board2', async () => {
    await h.mark(card(), 2500);
    await h.click(card().getByRole('button', { name: 'Assign' }), { after: 400 });
    const m = h.page.locator('.ant-modal:visible');
    await h.click(m.locator('.ant-select').first(), { after: 300 });
    await h.click(h.page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'Ravi Patel' }).first(), { after: 500 });
    await h.click(m.locator('.ant-modal-footer .ant-btn-primary'), { after: 300 });
    await h.page.locator('.ant-message-success').first().waitFor(); await h.settle();
  });
  await h.stop();

  const e = eng; e.chip = 'Part 3 · The engineer fixes it';
  await e.go('/my-work');
  const ecard = () => e.page.locator('.ant-card', { has: e.page.getByText(COMPLAINT_ASSET) }).filter({ hasText: 'SpO2' }).last();
  await e.start('07-engineer-fix');
  await e.say('eng1', async () => {
    await e.mark(ecard(), 2000);
    await e.click(ecard().getByRole('button', { name: 'Start work' }), { after: 400 });
    const m = e.page.locator('.ant-modal:visible');
    if (await m.count()) { await e.type(m.locator('textarea').first(), 'Checking the display cable and SpO2 module.', 35); await e.click(m.locator('.ant-modal-footer .ant-btn-primary'), { after: 300 }); }
    await e.page.locator('.ant-message-success').first().waitFor(); await e.settle();
  });
  await e.say('eng2', async () => { await e.move(ecard().getByRole('button', { name: 'Escalate' })); await sleep(2500); await e.move(ecard().getByRole('button', { name: 'Resolve' })); });
  await e.say('eng3', async () => {
    await e.click(ecard().getByRole('button', { name: 'Resolve' }), { after: 400 });
    const m = e.page.locator('.ant-modal:visible');
    await e.type(m.locator('textarea').first(), 'Replaced the SpO2 extension cable, display tested OK for 30 minutes.', 30);
    const add = m.getByRole('button', { name: /cost/i }).first();
    await e.click(add, { after: 400 });
    await e.click(m.getByRole('combobox', { name: 'Type' }).last().locator('xpath=ancestor::div[contains(@class,"ant-select")][1]'), { after: 300 });
    await e.click(e.page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'Spare part' }).first(), { after: 200 });
    await e.type(m.getByLabel('Amount (₹)').last(), '1850', 80);
    await e.type(m.getByLabel('What was paid for').last(), 'SpO2 extension cable', 40);
    await sleep(800);
    await e.click(m.locator('.ant-modal-footer .ant-btn-primary'), { after: 300 });
    await e.page.locator('.ant-message-success').first().waitFor(); await e.settle();
  });
  await e.stop();

  n.chip = 'Part 3 · The ward closes it';
  await n.go('/');
  await n.start('08-nurse-close');
  await n.say('close1', async () => {
    const box = n.page.locator('.ant-card', { hasText: 'Fixed: please check and close' });
    const row = box.locator('.ant-card-body > div', { hasText: 'SpO2 extension' }).last();
    await n.mark(row, 2500);
    await n.move(row.getByRole('button', { name: 'Still not working' })); await sleep(1000);
    await n.click(row.getByRole('button', { name: 'Close complaint' }), { after: 400 });
    const m = n.page.locator('.ant-modal:visible');
    await n.type(m.locator('textarea').first(), 'Working fine on the ward.', 40);
    await n.click(m.locator('.ant-modal-footer .ant-btn-primary'), { after: 300 });
    await n.page.locator('.ant-message-success').first().waitFor(); await n.settle();
  });
  await n.stop();

  h.chip = 'Part 3 · Complaint history';
  await h.go('/complaints');
  await h.start('09-history');
  await h.say('hist1', async () => {
    await h.click(h.page.getByRole('tab', { name: 'History' }), { after: 1200 }); await h.settle();
    const row = h.page.locator('tr', { hasText: COMPLAINT_ASSET }).first();
    await h.click(row.getByRole('button', { name: /Details/ }).or(row.locator('a, .code')).first(), { after: 1200 });
    const d = h.page.locator('.ant-drawer:visible .ant-drawer-body');
    for (let i = 0; i < 3; i++) { await h.move(d, { dy: 100 }); await h.scroll(350, 1500); await sleep(800); }
    await h.page.keyboard.press('Escape');
  });
  await h.stop();
}, () => nurse);

// ---------------- Part 4: HOD control ----------------
await part('p4a', async () => {
  hod ??= await person('admin@demo.local');
  const h = hod; h.chip = 'Part 4 · Approvals';
  await h.go('/approvals');
  await h.card('Part 4', 'Staying in control', 'Approvals, consumables, suppliers, facility, reports, reminders and administration.');
  await h.start('10-approvals');
  await sleep(800);
  await h.say('part4');
  await h.cardOff();
  await h.say('appr1', async () => { await sleep(2000); await h.scroll(300, 1500); await sleep(2000); await h.top(); });
  await h.say('appr2', async () => {
    const row = h.page.locator('tr', { hasText: 'Key-field edit' }).first();
    await h.mark(row, 3000);
    await h.click(row.getByRole('button', { name: 'Approve' }), { after: 600 });
    const m = h.page.locator('.ant-modal:visible, .ant-popconfirm:visible, .ant-popover:visible');
    if (await m.count()) await h.click(m.locator('.ant-btn-primary').last(), { after: 300 });
    await h.page.locator('.ant-message-success').first().waitFor().catch(() => {}); await h.settle();
  });
  await h.say('appr3', async () => {
    await h.mark(h.page.locator('tr', { hasText: 'Condemnation' }).first(), 4000);
    await h.go('/assets/' + await h.idOf(CONDEMNED) + '/condemnation');
    await sleep(1500); await h.scroll(400, 1500);
  });
  await h.stop();
}, () => hod);

await part('p4b', async () => {
  hod ??= await person('admin@demo.local');
  const h = hod; h.chip = 'Part 4 · Consumables and suppliers';
  await h.go('/consumables');
  await h.start('11-consumables');
  await h.say('cons1', async () => { await sleep(1500); await h.click(h.page.getByText(/^Low stock/).first(), { after: 2500 }); await h.click(h.page.getByText('In use', { exact: true }).first(), { after: 300 }); });
  await h.say('cons2', async () => {
    const row = h.page.locator('tr', { hasText: 'ECG electrodes' }).first();
    await h.click(row.getByRole('button', { name: 'Give out' }), { after: 500 });
    const m = h.page.locator('.ant-modal:visible');
    const pickIn = async (label, text, typeIt) => {
      await h.click(m.locator('.ant-form-item', { hasText: label }).locator('.ant-select').first(), { after: 300 });
      if (typeIt) { await h.page.keyboard.type(typeIt, { delay: 70 }); await sleep(900); }
      await h.click(h.page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: text }).first(), { after: 300 });
    };
    await pickIn('Department', 'Intensive Care Unit');
    await h.type(m.locator('.ant-form-item', { hasText: 'Quantity' }).locator('input').first(), '2', 80);
    await pickIn('For a machine', 'Bedside Monitor ICU-2', 'ICU-2');
    await h.type(m.locator('.ant-form-item', { hasText: 'Reason' }).locator('input, textarea').first(), 'Monthly replacement for ICU monitors', 30);
    await h.click(m.locator('.ant-modal-footer .ant-btn-primary'), { after: 300 });
    await h.page.locator('.ant-message-success').first().waitFor(); await h.settle();
  });
  await h.say('cons3', async () => {
    await h.click(h.page.locator('tr', { hasText: 'ECG electrodes' }).first().locator('a').first(), { after: 300 });
    await h.settle(); await sleep(1500); await h.scroll(400, 1500);
  });
  await h.say('vend1', async () => { await h.nav('Suppliers'); await sleep(2000); await h.scroll(400, 1800); });
  await h.stop();
}, () => hod);

await part('p4c', async () => {
  hod ??= await person('admin@demo.local');
  const h = hod; h.chip = 'Part 4 · Facility add-on';
  await h.go('/logbook');
  await h.start('12-facility');
  await h.say('fac1', async () => {
    await sleep(1500);
    const row = h.page.locator('tr', { hasText: 'Diesel level' }).first();
    await h.click(row.getByRole('button', { name: 'Record' }), { after: 500 });
    const m = h.page.locator('.ant-modal:visible');
    await h.type(m.locator('input').first(), '72', 120);
    await h.click(m.locator('.ant-modal-footer .ant-btn-primary'), { after: 300 });
    await h.page.locator('.ant-message-success').first().waitFor(); await h.settle();
  });
  await h.say('fac2', async () => { await h.nav('Licences'); await sleep(2000); await h.mark(h.page.locator('tr', { hasText: 'Expired' }).first(), 3000); });
  await h.stop();
}, () => hod);

await part('p4d', async () => {
  hod ??= await person('admin@demo.local');
  const h = hod; h.chip = 'Part 4 · Reports';
  await h.go('/reports');
  await h.start('13-reports');
  await h.say('rep1', async () => { await sleep(1500); await h.scroll(500, 2000); await sleep(1500); await h.scroll(600, 2000); });
  await h.say('rep2', async () => {
    await h.go('/reports/breakdowns');
    await sleep(1500);
    await h.click(h.page.getByText('By financial year', { exact: true }).first(), { after: 1800 });
    await h.click(h.page.getByText('By month', { exact: true }).first(), { after: 600 });
    await h.scroll(500, 1800); await sleep(1500); await h.top();
    await h.click(h.page.getByRole('button', { name: 'Export' }).first(), { after: 1800 });
    await h.page.keyboard.press('Escape');
  });
  await h.say('rep3', async () => { await h.go('/reports/monthly'); await sleep(1500); await h.scroll(500, 2000); await sleep(1500); await h.scroll(700, 2000); });
  await h.say('rep4', async () => { await h.go('/reports/audit-pack'); await sleep(2000); await h.move(h.page.getByText(/Download audit pack/).first()); });
  await h.stop();
}, () => hod);

await part('p4e', async () => {
  hod ??= await person('admin@demo.local');
  const h = hod; h.chip = 'Part 4 · Reminders and administration';
  await h.go('/');
  await h.start('14-admin');
  await h.say('bell1', async () => {
    await h.click(h.page.locator('header').getByRole('button', { name: /notif|remind|bell/i }).or(h.page.locator('header .ant-badge').first()).first(), { after: 800 });
    await sleep(3000);
    await h.page.keyboard.press('Escape');
    await h.click(h.page.locator('main h1').first(), { after: 200 });
  });
  await h.say('adm1', async () => { await h.nav('Users'); await sleep(2500); await h.nav('Roles & permissions'); await sleep(1000); await h.scroll(500, 2000); });
  await h.say('adm2', async () => { await h.nav('Departments & locations'); await sleep(2000); await h.nav('Equipment types'); await sleep(2000); await h.nav('PMS checklists'); });
  await h.say('adm3', async () => { await h.nav('Audit log'); await sleep(2000); await h.scroll(300, 1500); });
  await h.say('adm4', async () => { await h.nav('Hospital settings'); await sleep(1500); await h.scroll(500, 2000); await sleep(1000); await h.scroll(600, 2000); });
  await h.go('/');
  await h.say('dark1', async () => {
    await h.click(h.page.locator('header').getByText('Dr. Meera Shah').first(), { after: 600 });
    await h.click(h.page.locator('.ant-dropdown:visible').getByText('Dark', { exact: true }).first(), { after: 1500 });
    await h.scroll(400, 1500);
  });
  await h.card('Thank you', 'BME Asset Management', 'Every machine, every PMS, every complaint and every rupee, in one place, on your own server.');
  await sleep(500);
  await h.say('outro1');
  await sleep(1500);
  await h.stop();
  // Back to light for the next run.
  await h.page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/theme/i.test(k)) localStorage.removeItem(k); });
}, () => hod);

await closeAll();
console.log('done');
