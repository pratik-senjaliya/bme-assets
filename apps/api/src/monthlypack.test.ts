// The monthly management report and the audit pack. The figures are checked against a department of our own with
// known breakdowns, PMS, spend and dates; the saving job against duplicates, races and email; the pack against what a
// ZIP must hold, missing files, scope and refusals. Needs a migrated + seeded database.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { AuditPackSummary, ReportData, SavedMonthlyReport } from '@bme/shared';
import { addDaysISO, todayISO, zonedDayStart } from './lib/dates';
import { prisma } from './lib/prisma';
import { getStorage } from './lib/storage';
import { buildMonthlyReport, lastMonth, monthEnd, monthStart, previousMonth, saveMonthlyReport } from './modules/reports/monthly.service';
import { call, condemnForm, fakeSmtp, login, pdfTextOf, startServer } from './testUtils';

process.env.STORAGE_DRIVER = 'local';

const PREFIX = 'MTEST-';
// Months long gone, so the saved-report tests never meet a month the running app saves for real.
const SAVE_MONTHS = ['2024-01', '2024-02', '2024-03', '2024-04'];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let base = '';
let server: ReturnType<typeof startServer>['server'];
let admin = '';
let biomed = '';
let nurse = '';
const ids = { dept: '', loc: '', type: '', template: '', biomed: '' };
const A: Record<'crit' | 'mid' | 'old', { id: string; assetCode: string }> = { crit: { id: '', assetCode: '' }, mid: { id: '', assetCode: '' }, old: { id: '', assetCode: '' } };

// The month the figures are for (last month), and the one before it.
const M = lastMonth(todayISO());
const P = previousMonth(M);
const at = (day: string, hhmm: string) => new Date(zonedDayStart(day).getTime() + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * 60_000);
const H = 3_600_000;
const daysIn = (month: string) => Number(monthEnd(month).slice(8));

async function cleanUp() {
  const assets = await prisma.asset.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  const cal = await prisma.calibrationRecord.findMany({ where: { assetId: { in: assetIds } }, select: { id: true } });
  await prisma.attachment.deleteMany({ where: { OR: [{ ownerId: { in: [...assetIds, ...cal.map((c) => c.id)] } }, { fileName: { startsWith: PREFIX } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { type: 'report', dueDate: { in: SAVE_MONTHS.map((m) => new Date(`${m}-01T00:00:00Z`)) } }] } });
  await prisma.calibrationRecord.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.serviceExpense.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.complaint.deleteMany({ where: { assetId: { in: assetIds } } });
  await prisma.$transaction([prisma.$queryRaw`select set_config('bme.allow_pms_cleanup', 'on', true)`, prisma.pmsRecord.deleteMany({ where: { assetId: { in: assetIds } } })]);
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: assetIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  await prisma.pmsTemplate.deleteMany({ where: { equipmentType: { code: 'MTT' } } });
  await prisma.equipmentType.deleteMany({ where: { code: 'MTT' } });
  await prisma.location.deleteMany({ where: { code: 'MTL' } });
  await prisma.department.deleteMany({ where: { code: 'MTD' } });
  await prisma.monthlyReport.deleteMany({ where: { month: { in: SAVE_MONTHS } } });
}

before(async () => {
  process.env.STORAGE_PATH = await mkdtemp(path.join(os.tmpdir(), 'bme-mtest-'));
  await cleanUp();
  ({ server, base } = startServer());
  [admin, biomed, nurse] = await Promise.all(['admin', 'biomed', 'nursing'].map((r) => login(base, `${r}@demo.local`)));
  ids.biomed = (await prisma.user.findUniqueOrThrow({ where: { email: 'biomed@demo.local' } })).id;
  const dept = await prisma.department.create({ data: { name: `${PREFIX}Ward`, code: 'MTD' } });
  const loc = await prisma.location.create({ data: { name: `${PREFIX}Bay`, code: 'MTL', departmentId: dept.id } });
  const type = await (await call(base, admin, 'POST', '/equipment-types', { name: `${PREFIX}type`, code: 'MTT', defaultPmsMonths: 6, defaultCalibrationMonths: 12 })).json();
  const template = await (await call(base, admin, 'POST', '/pms-templates', {
    equipmentTypeId: type.id,
    items: [
      { id: 'visual', label: 'Visual inspection', type: 'check', required: true },
      { id: 'flow', label: 'Flow at 5 L/min', type: 'reading', unit: 'L/min', min: 4.5, max: 5.5, required: true },
    ],
  })).json();
  Object.assign(ids, { dept: dept.id, loc: loc.id, type: type.id, template: template.id });
  const make = async (name: string, criticality: string) => {
    const res = await call(base, admin, 'POST', '/assets', { equipmentTypeId: type.id, name: `${PREFIX}${name}`, departmentId: dept.id, locationId: loc.id, criticality });
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()) as { id: string; assetCode: string };
  };
  A.crit = await make('critical', 'most_critical');
  A.mid = await make('middle', 'minor');
  A.old = await make('often broken', 'minor');
  // Registered long before the months measured, so each counts every hour of them.
  await prisma.asset.updateMany({ where: { id: { in: [A.crit.id, A.mid.id, A.old.id] } }, data: { createdAt: new Date(`${previousMonth(P)}-01T00:00:00Z`) } });
});
after(async () => {
  await cleanUp();
  await prisma.hospitalSettings.updateMany({ data: { smtpHost: null, smtpPort: null, smtpFrom: null, smtpUser: null, smtpPassword: null } });
  await rm(process.env.STORAGE_PATH!, { recursive: true, force: true });
  server.close();
  await prisma.$disconnect();
});

const complaint = async (assetId: string, raised: Date, startedAfterH: number | null, resolvedAfterH: number | null, no: string) =>
  prisma.complaint.create({
    data: {
      complaintNo: `${PREFIX}${no}`, assetId, departmentId: ids.dept, raisedById: ids.biomed, description: `${PREFIX}${no}`, raisedAt: raised,
      status: resolvedAfterH != null ? 'resolved' : startedAfterH != null ? 'in_progress' : 'open',
      startedAt: startedAfterH != null ? new Date(raised.getTime() + startedAfterH * H) : null,
      resolvedAt: resolvedAfterH != null ? new Date(raised.getTime() + resolvedAfterH * H) : null,
    },
  });
const kpiOf = (d: ReportData, label: string) => d.kpis.find((k) => k.label === label);
const sheetOf = (d: ReportData, name: string) => d.sheets.find((s) => s.name.startsWith(name));

describe('Monthly report figures', () => {
  let d: ReportData;
  before(async () => {
    // Last month: a medium breakdown of 12 h (response 2 h) and a critical one of 30 h (response 4 h, over the 24 h limit).
    await complaint(A.mid.id, at(`${M}-10`, '10:00'), 2, 12, 'm1');
    await complaint(A.crit.id, at(`${M}-15`, '08:00'), 4, 30, 'm2');
    // The month before: one breakdown of 6 h.
    await complaint(A.mid.id, at(`${P}-05`, '09:00'), 1, 6, 'p1');
    // Four breakdowns of the often-broken one earlier in the year: a replacement candidate.
    for (let i = 2; i <= 5; i++) await complaint(A.old.id, at(`${previousMonth(previousMonth(P))}-0${i}`, '09:00'), 1, 1, `o${i}`);
    // A PMS last month, and a correction of it (counts once, with the corrected result).
    const first = await prisma.pmsRecord.create({ data: { assetId: A.mid.id, templateId: ids.template, performedOn: new Date(`${M}-12T00:00:00Z`), performedBy: ids.biomed, answers: { visual: 'pass', flow: 5 }, result: 'pass' } });
    await prisma.pmsRecord.create({ data: { assetId: A.mid.id, templateId: ids.template, performedOn: new Date(`${M}-13T00:00:00Z`), performedBy: ids.biomed, answers: { visual: 'fail', flow: 5 }, result: 'fail', correctsRecordId: first.id, correctionReason: 'Casing crack missed' } });
    // One PMS overdue, one not; calibration all in date.
    const today = todayISO();
    await prisma.asset.update({ where: { id: A.crit.id }, data: { nextPmsDue: new Date(`${addDaysISO(today, -3)}T00:00:00Z`), nextCalibrationDue: new Date(`${addDaysISO(today, 10)}T00:00:00Z`) } });
    await prisma.asset.update({ where: { id: A.mid.id }, data: { nextPmsDue: new Date(`${addDaysISO(today, 30)}T00:00:00Z`) } });
    // Spend last month.
    await prisma.serviceExpense.createMany({ data: [
      { assetId: A.mid.id, type: 'repair', description: `${PREFIX}valve`, amount: 1000, date: new Date(`${M}-11T00:00:00Z`) },
      { assetId: A.old.id, type: 'spare_part', description: `${PREFIX}sensor`, amount: 500, date: new Date(`${M}-20T00:00:00Z`) },
    ] });
    d = await buildMonthlyReport(M, { name: 'Test', scope: { departmentId: ids.dept } });
  });

  it('counts breakdowns, response and downtime for the month, against the month before', () => {
    assert.equal(kpiOf(d, 'Breakdowns')!.value, 2);
    assert.equal(kpiOf(d, 'Breakdowns')!.hint, 'Last month 1');
    assert.equal(kpiOf(d, 'Average response')!.value, 3); // (2 + 4) / 2
    assert.equal(kpiOf(d, 'Average downtime')!.value, 21); // (12 + 30) / 2
    assert.equal(kpiOf(d, 'Critical down over 24 h')!.value, 1);
    assert.equal(sheetOf(d, 'Critical equipment down')!.rows.length, 1);
  });

  it('works out uptime 24 hours a day, for all equipment and for critical equipment', () => {
    const hoursInMonth = daysIn(M) * 24;
    assert.ok(Math.abs((kpiOf(d, 'Equipment uptime')!.value as number) - (1 - 42 / (3 * hoursInMonth))) < 1e-9);
    assert.ok(Math.abs((kpiOf(d, 'Critical equipment uptime')!.value as number) - (1 - 30 / hoursInMonth)) < 1e-9);
  });

  it('counts a corrected PMS once, with its corrected result, and PMS on schedule as at today', () => {
    assert.equal(kpiOf(d, 'PMS done')!.value, 1);
    assert.equal(kpiOf(d, 'PMS done')!.hint, '1 failed');
    assert.equal(kpiOf(d, 'PMS on schedule')!.value, 0.5); // one of two scheduled is overdue
    assert.equal(kpiOf(d, 'Calibration on schedule')!.value, 1);
    const late = sheetOf(d, 'Overdue PMS and calibration')!;
    assert.deepEqual(late.rows.map((r) => r.code), [A.crit.assetCode]);
  });

  it('adds up the month’s spend and names equipment to consider replacing, with the reason', () => {
    assert.equal(kpiOf(d, 'Service spend')!.value, 1500);
    const replace = sheetOf(d, 'Equipment to consider replacing')!;
    assert.deepEqual(replace.rows.map((r) => r.code), [A.old.assetCode]);
    assert.match(String(replace.rows[0].why), /4 breakdowns in 12 months/);
  });

  it('refuses a month that has not started, and a malformed month', async () => {
    const next = addDaysISO(monthEnd(todayISO().slice(0, 7)), 1).slice(0, 7);
    assert.equal((await call(base, admin, 'GET', `/reports/monthly?month=${next}`)).status, 400);
    assert.equal((await call(base, admin, 'GET', '/reports/monthly?month=2026-13')).status, 400);
    assert.equal((await call(base, nurse, 'GET', `/reports/monthly?month=${M}`)).status, 403);
  });
});

describe('Saving the monthly report on the 1st', () => {
  it('saves once, tells the HOD in the bell, and a second run does nothing', async () => {
    const [month] = SAVE_MONTHS;
    const first = await saveMonthlyReport(month);
    assert.equal(first.saved, true);
    assert.ok(first.notified >= 1);
    const hod = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
    const notices = () => prisma.notification.count({ where: { userId: hod.id, type: 'report', dueDate: new Date(`${month}-01T00:00:00Z`) } });
    assert.equal(await notices(), 1);
    const nurseUser = await prisma.user.findUniqueOrThrow({ where: { email: 'nursing@demo.local' } });
    assert.equal(await prisma.notification.count({ where: { userId: nurseUser.id, type: 'report' } }), 0, 'nursing was told');
    assert.equal((await saveMonthlyReport(month)).saved, false);
    assert.equal(await notices(), 1, 'told twice');
  });

  it('lets exactly one of two servers save the same month at the same moment', async () => {
    const month = SAVE_MONTHS[1];
    const results = await Promise.all([saveMonthlyReport(month), saveMonthlyReport(month)]);
    assert.equal(results.filter((r) => r.saved).length, 1);
    assert.equal(await prisma.monthlyReport.count({ where: { month } }), 1);
  });

  it('emails the PDF to the HOD when email is set up', async () => {
    const smtp = fakeSmtp();
    await new Promise<void>((resolve) => smtp.server.listen(0, resolve));
    try {
      const port = (smtp.server.address() as net.AddressInfo).port;
      await prisma.hospitalSettings.updateMany({ data: { smtpHost: '127.0.0.1', smtpPort: port, smtpFrom: 'bme@hospital.test' } });
      const r = await saveMonthlyReport(SAVE_MONTHS[2]);
      assert.ok(r.emailed >= 1);
      const mail = smtp.messages.find((m) => m.includes(`bme-monthly-report-${SAVE_MONTHS[2]}.pdf`));
      assert.ok(mail, 'no email with the PDF');
      assert.match(mail!, /application\/pdf/);
    } finally {
      smtp.server.close();
      await prisma.hospitalSettings.updateMany({ data: { smtpHost: null, smtpPort: null, smtpFrom: null } });
    }
  });

  it('shows a saved month as sent, lists it, and makes any other month from the records now', async () => {
    const saved = (await (await call(base, admin, 'GET', `/reports/monthly?month=${SAVE_MONTHS[0]}`)).json()) as ReportData;
    assert.match(saved.note ?? '', /^Saved on .*as it was sent/);
    const stored = (await prisma.monthlyReport.findUniqueOrThrow({ where: { month: SAVE_MONTHS[0] } })).data as unknown as ReportData;
    assert.deepEqual(saved.kpis, stored.kpis);
    const list = (await (await call(base, admin, 'GET', '/reports/monthly/saved')).json()) as SavedMonthlyReport[];
    assert.ok(list.some((s) => s.month === SAVE_MONTHS[0]));
    // The saved copy covers both registers, so a biomedical engineer gets their own register made from the records.
    assert.deepEqual(await (await call(base, biomed, 'GET', '/reports/monthly/saved')).json(), []);
    const live = (await (await call(base, admin, 'GET', `/reports/monthly?month=${SAVE_MONTHS[3]}`)).json()) as ReportData;
    assert.match(live.note ?? '', /^Made from the records now/);
    const running = (await (await call(base, admin, 'GET', `/reports/monthly?month=${todayISO().slice(0, 7)}`)).json()) as ReportData;
    assert.match(running.note ?? '', /so far/);
    const pdf = await call(base, admin, 'GET', `/reports/monthly?month=${SAVE_MONTHS[0]}&format=pdf`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdfTextOf(Buffer.from(await pdf.arrayBuffer())), /Monthly report: January 2024/);
  });
});

describe('Audit pack', () => {
  const from = monthStart(P);
  const to = todayISO();
  let certKey = '';
  before(async () => {
    // A calibration with its certificate, and one whose certificate file has gone missing from storage.
    const cal = await (await call(base, biomed, 'POST', `/assets/${A.crit.id}/calibrations`, { doneOn: addDaysISO(to, -2), agency: 'NABL Lab', result: 'pass' })).json();
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(PNG)]), `${PREFIX}certificate.png`);
    const up = await fetch(`${base}/calibration/records/${cal.id}/certificate`, { method: 'POST', headers: { cookie: biomed }, body: form });
    assert.equal(up.status, 201);
    certKey = (await prisma.attachment.findFirstOrThrow({ where: { ownerId: cal.id } })).filePath;
    const lost = await (await call(base, biomed, 'POST', `/assets/${A.mid.id}/calibrations`, { doneOn: addDaysISO(to, -1), agency: 'NABL Lab', result: 'pass' })).json();
    await prisma.attachment.create({ data: { ownerType: 'calibration_record', ownerId: lost.id, kind: 'certificate', fileName: `${PREFIX}lost.pdf`, filePath: 'gone/never-stored.pdf', mime: 'application/pdf', size: 10 } });
    // The often-broken one is condemned with an end-of-life letter.
    const letter = condemnForm('Beyond economical repair');
    letter.set('file', new Blob([new Uint8Array(PNG)]), `${PREFIX}eol.png`);
    const req = await fetch(`${base}/assets/${A.old.id}/condemn`, { method: 'POST', headers: { cookie: biomed }, body: letter });
    assert.equal(req.status, 201, await req.clone().text());
    const approved = await call(base, admin, 'POST', `/approvals/${(await req.json()).id}/approve`, {});
    assert.equal(approved.status, 200, await approved.clone().text());
  });

  const download = async (q: string, cookie = admin) => {
    const res = await call(base, cookie, 'GET', `/reports/audit-pack?${q}`);
    return { res, zip: res.status === 200 ? await JSZip.loadAsync(Buffer.from(await res.arrayBuffer())) : null };
  };

  it('holds the index, the reports, the PMS checklists, the certificates and the condemnation letter', async () => {
    const { res, zip } = await download(`from=${from}&to=${to}&departmentId=${ids.dept}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const names = Object.keys(zip!.files);
    for (const f of ['00 Index.pdf', '01 Equipment inventory.xlsx', '02 PMS records.xlsx', '03 PMS checklists.pdf', '04 Calibration.xlsx', '05 Breakdowns.xlsx', '06 Critical equipment downtime.xlsx', '07 Warranty and contracts.xlsx', '08 Equipment age.xlsx']) {
      assert.ok(names.includes(f), `missing ${f}`);
    }
    const cert = names.find((n) => n.startsWith('Calibration certificates/') && n.includes(A.crit.assetCode))!;
    assert.ok(cert, 'certificate not in the pack');
    assert.deepEqual(await zip!.file(cert)!.async('nodebuffer'), await getStorage().get(certKey));
    assert.ok(names.some((n) => n.startsWith('Condemnation/') && n.includes(A.old.assetCode) && n.includes('End-of-life letter')), 'letter not in the pack');

    const checklists = pdfTextOf(await zip!.file('03 PMS checklists.pdf')!.async('nodebuffer'));
    assert.match(checklists, new RegExp(`${A.mid.assetCode}.*FAIL.*CORRECTION`));
    assert.match(checklists, /5 L\/min/);
    assert.match(checklists, /Casing crack missed/);

    const index = pdfTextOf(await zip!.file('00 Index.pdf')!.async('nodebuffer'));
    assert.match(index, /Files that could not be added/);
    assert.match(index, /lost\.pdf/);
    assert.match(index, new RegExp(A.old.assetCode)); // condemned in the period
  });

  it('keeps to the department: the inventory lists its equipment only, condemned labelled', async () => {
    const { zip } = await download(`from=${from}&to=${to}&departmentId=${ids.dept}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await zip!.file('01 Equipment inventory.xlsx')!.async('nodebuffer')) as unknown as ArrayBuffer);
    const codes: string[] = [];
    const statuses: string[] = [];
    wb.getWorksheet('Asset master')!.eachRow((row, i) => {
      if (i <= 4) return; // title block and header
      const code = String(row.getCell(1).value ?? '');
      if (code.startsWith('SHL-')) {
        codes.push(code);
        statuses.push(row.values!.toString());
      }
    });
    assert.deepEqual(codes.sort(), [A.crit.assetCode, A.mid.assetCode, A.old.assetCode].sort());
    assert.ok(statuses.some((s) => s.includes('CONDEMNED')));
  });

  it('says what it will hold before downloading, and records the download in the audit log', async () => {
    const summary = (await (await call(base, admin, 'GET', `/reports/audit-pack/summary?from=${from}&to=${to}&departmentId=${ids.dept}`)).json()) as AuditPackSummary;
    assert.deepEqual({ assets: summary.assets, pms: summary.pmsRecords, cal: summary.calibrations, certs: summary.certificates, condemned: summary.condemnations, docs: summary.documents }, { assets: 3, pms: 2, cal: 2, certs: 2, condemned: 1, docs: 1 });
    const logged = await prisma.auditLog.findFirst({ where: { action: 'report.export' }, orderBy: { at: 'desc' } });
    assert.equal((logged!.after as { type: string }).type, 'audit-pack');
  });

  it('refuses nursing, an inverted or over-long period, and an unknown department', async () => {
    assert.equal((await call(base, nurse, 'GET', `/reports/audit-pack?from=${from}&to=${to}`)).status, 403);
    assert.equal((await call(base, admin, 'GET', `/reports/audit-pack?from=${to}&to=${from}`)).status, 400);
    assert.equal((await call(base, admin, 'GET', '/reports/audit-pack?from=2015-01-01&to=2026-01-01')).status, 400);
    assert.equal((await call(base, admin, 'GET', `/reports/audit-pack?from=${from}&to=${to}&departmentId=00000000-0000-4000-8000-000000000000`)).status, 400);
  });
});
