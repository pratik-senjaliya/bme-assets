import archiver from 'archiver';
import type { Response } from 'express';
import type { AuditPackQuery, AuditPackSummary, PmsAnswer, ReportData, ReportQuery, ReportType } from '@bme/shared';
import { isoDate, parseDate, prettyDate, todayISO, zonedDayStart, addDaysISO } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { getStorage } from '../../lib/storage';
import { templateItems } from '../pms/pms.service';
import { toPdf, toWorkbook } from './reports.export';
import { buildReportAs, kpi, addSheet, type Collector, type Ctx } from './reports.service';

// The audit pack: everything an inspector (NABH and similar) asks to see about medical equipment, for one period and
// optionally one department, in one ZIP file:
//
//   00 Index.pdf                       what is inside, the headline compliance figures, condemnations, files missing
//   01 Equipment inventory.xlsx ... 07 the standing reports for the period (the same files as Reports > Excel)
//   03 PMS checklists.pdf              every PMS done in the period with each answer, as recorded (read-only records)
//   Calibration certificates/...       the certificate of every calibration done in the period
//   Condemnation/...                   end-of-life letters and condemnation forms for equipment condemned in the period
//
// Everything that can fail on the database is gathered before the download starts, so a problem gives a plain error
// instead of a broken file. Files are then read from storage one at a time; one that cannot be read is listed in the
// index under "Files that could not be added" rather than spoiling the whole pack.

export type PackViewer = { name: string; scope: Ctx['scope'] };

// Report files in the pack, in order. Costs are left out: the pack is about compliance, not spend.
const REPORT_FILES: { file: string; type: ReportType; what: string; extra?: Partial<ReportQuery> }[] = [
  { file: '01 Equipment inventory.xlsx', type: 'asset-master', what: 'Every piece of equipment, including condemned and not in use (labelled), with next PMS and calibration dates', extra: { assetStatus: 'all' } },
  { file: '02 PMS records.xlsx', type: 'pms', what: 'Every PMS done in the period, with result and who did it' },
  { file: '04 Calibration.xlsx', type: 'calibration', what: 'Calibrations done in the period, and the next due date of all active equipment' },
  { file: '05 Breakdowns.xlsx', type: 'breakdowns', what: 'Complaints raised in the period with response time and downtime' },
  { file: '06 Critical equipment downtime.xlsx', type: 'critical-downtime', what: 'Uptime of critical equipment and every downtime event' },
  { file: '07 Warranty and contracts.xlsx', type: 'warranty-contracts', what: 'Warranties and AMC / CMC contracts: running, ending, ended' },
  { file: '08 Equipment age.xlsx', type: 'equipment-age', what: 'Age of every piece of equipment' },
  { file: '09 Condemnation register.xlsx', type: 'condemnation', what: 'Equipment condemned in the period by committee date: reason, purchase cost, estimated value and approval' },
  { file: '10 Consumables register.xlsx', type: 'consumables', what: 'Consumables given out in the period (department, machine, complaint, reason), received, and stock today' },
];

const DOC_KIND: Record<string, string> = { eol_letter: 'End-of-life letter', condemnation_form: 'Condemnation form' };
// Names inside the ZIP: no path separators or characters Windows refuses, nothing empty.
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';

async function gather(q: AuditPackQuery, scope: Ctx['scope']) {
  const from = parseDate(q.from);
  const to = parseDate(q.to);
  const fromAt = zonedDayStart(q.from);
  const toAt = zonedDayStart(addDaysISO(q.to, 1));
  const [assets, pms, calibrations, complaints, condemned] = await Promise.all([
    prisma.asset.count({ where: { ...scope } }),
    prisma.pmsRecord.findMany({
      where: { performedOn: { gte: from, lte: to }, asset: { ...scope } },
      include: { asset: { include: { equipmentType: true, department: true } }, template: true },
      orderBy: [{ performedOn: 'asc' }, { submittedAt: 'asc' }],
    }),
    prisma.calibrationRecord.findMany({ where: { doneOn: { gte: from, lte: to }, asset: { ...scope } }, include: { asset: true }, orderBy: { doneOn: 'asc' } }),
    prisma.complaint.count({ where: { raisedAt: { gte: fromAt, lt: toAt }, assetId: { not: null }, ...scope } }), // breakdowns: about a machine
    // Equipment condemned in the period: the approved request is the record of it.
    prisma.approvalRequest.findMany({ where: { type: 'condemn', status: 'approved', decidedAt: { gte: fromAt, lt: toAt } }, orderBy: { decidedAt: 'asc' } }),
  ]);
  const condemnedAssets = await prisma.asset.findMany({ where: { id: { in: condemned.map((r) => r.targetId) }, ...scope }, include: { department: true } });
  const condemnations = condemned.flatMap((r) => {
    const asset = condemnedAssets.find((a) => a.id === r.targetId);
    return asset ? [{ request: r, asset }] : [];
  });
  const [certificates, letters, oemReports] = await Promise.all([
    prisma.attachment.findMany({ where: { ownerType: 'calibration_record', ownerId: { in: calibrations.map((c) => c.id) }, kind: 'certificate' }, orderBy: { createdAt: 'asc' } }),
    prisma.attachment.findMany({
      where: {
        OR: [
          { id: { in: condemnations.map((c) => (c.request.payload as { attachmentId?: string | null }).attachmentId).filter((x): x is string => !!x) } },
          { ownerType: 'asset', ownerId: { in: condemnations.map((c) => c.asset.id) }, kind: { in: ['eol_letter', 'condemnation_form'] } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    }),
    // The OEM engineer's report for each PMS they did in the period.
    prisma.attachment.findMany({ where: { ownerType: 'pms_record', ownerId: { in: pms.filter((r) => r.kind === 'oem').map((r) => r.id) }, kind: 'service_report' }, orderBy: { createdAt: 'asc' } }),
  ]);
  return { assets, pms, calibrations, complaints, condemnations, certificates, letters, oemReports };
}

export async function auditPackSummary(q: AuditPackQuery, scope: Ctx['scope']): Promise<AuditPackSummary> {
  const g = await gather(q, scope);
  return {
    assets: g.assets,
    pmsRecords: g.pms.length,
    calibrations: g.calibrations.length,
    certificates: g.certificates.length,
    oemReports: g.oemReports.length,
    complaints: g.complaints,
    condemnations: g.condemnations.length,
    documents: g.letters.length,
  };
}

// Each PMS done in the period with every answer exactly as recorded, one table per record.
function checklistsPdf(g: Awaited<ReturnType<typeof gather>>, names: Map<string, string>, base: Pick<ReportData, 'hospital' | 'from' | 'to' | 'generatedAt' | 'generatedBy'>): Promise<Buffer> {
  const out: Collector = { sheets: [], kpis: [], charts: [] };
  const passed = g.pms.filter((r) => r.result === 'pass').length;
  kpi(out, 'PMS records', g.pms.length, 'int', 'Corrections included, each marked');
  kpi(out, 'Passed', passed, 'int');
  kpi(out, 'Failed', g.pms.length - passed, 'int', undefined, g.pms.length - passed ? 'bad' : 'good');
  const show = (v: PmsAnswer | undefined, unit?: string | null) => (v === undefined || v === '' ? '' : v === 'pass' ? 'Pass' : v === 'fail' ? 'Fail' : typeof v === 'number' ? `${v}${unit ? ` ${unit}` : ''}` : String(v));
  for (const r of g.pms) {
    const answers = r.answers as Record<string, PmsAnswer>;
    const by = r.kind === 'oem' ? `OEM: ${r.serviceBy ?? ''} (entered by ${names.get(r.performedBy) ?? 'unknown'})` : `by ${names.get(r.performedBy) ?? 'unknown'}`;
    const title = `${r.asset.assetCode} ${r.asset.name} | ${prettyDate(r.performedOn)} | ${r.result.toUpperCase()} | ${by}${r.template ? ` | checklist v${r.template.version}` : ''}${r.correctsRecordId ? ' | CORRECTION' : ''}`;
    addSheet(out, title, [
      { header: 'Check', key: 'label', width: 50 }, { header: 'Recorded', key: 'value', width: 20 }, { header: 'Allowed', key: 'allowed', width: 18 }, { header: 'Within limits', key: 'ok', width: 14 },
    ], Object.keys(answers).length === 0 || !r.template ? [{ label: r.kind === 'oem' ? 'Done by the OEM engineer: their report is in the folder "PMS reports (OEM)".' : 'No answers were stored with this PMS (it was entered as past history).', value: '', allowed: '', ok: '' }] : [
      ...templateItems(r.template.schema).map((item) => {
        const v = answers[item.id];
        const ranged = item.type === 'reading' && (item.min != null || item.max != null);
        const inRange = typeof v === 'number' && (item.min == null || v >= item.min) && (item.max != null ? v <= item.max : true);
        return {
          label: item.label,
          value: show(v, item.unit),
          allowed: ranged ? `${item.min ?? ''} – ${item.max ?? ''}${item.unit ? ` ${item.unit}` : ''}` : '',
          ok: item.type === 'check' ? (v === 'pass' ? 'Yes' : v === 'fail' ? 'NO' : '') : ranged && typeof v === 'number' ? (inRange ? 'Yes' : 'NO') : '',
        };
      }),
      ...(r.correctionReason ? [{ label: 'Reason for the correction', value: r.correctionReason, allowed: '', ok: '' }] : []),
    ]);
  }
  return toPdf({
    ...base,
    type: 'pms-checklists',
    title: 'PMS checklists',
    group: null,
    note: 'An in-house PMS is dated by the system on the day it was submitted. A PMS done by the OEM engineer carries the visit date from their report (checked by the system: not in the future, not before the previous PMS) and the report itself. No record can be changed afterwards; a mistake is put right by a correction, a new record that points to the original. Both are shown.',
    ...out,
  });
}

// Write the pack to `res` as a ZIP download. Database work happens first (an error there is a normal error reply);
// once the download has started, a file that cannot be read is listed in the index instead of stopping it.
export async function sendAuditPack(res: Response, q: AuditPackQuery, viewer: PackViewer, departmentName: string | null) {
  const scope = viewer.scope;
  const g = await gather(q, scope);
  const settings = await prisma.hospitalSettings.findFirstOrThrow({ select: { name: true } });
  const generatedAt = new Date().toISOString();
  const base = { hospital: settings.name, from: q.from, to: q.to, generatedAt, generatedBy: viewer.name, filters: departmentName ? [`Department: ${departmentName}`] : [] };

  const reportQ = (extra?: Partial<ReportQuery>) => ({ from: q.from, to: q.to, group: 'month', format: 'xlsx', ...(q.departmentId && { departmentId: q.departmentId }), ...extra }) as ReportQuery;
  const reports = await Promise.all(
    REPORT_FILES.map(async (f) => {
      const { data } = await buildReportAs(f.type, reportQ(f.extra), viewer.name, scope);
      return { ...f, data, buffer: Buffer.from(await toWorkbook(data).xlsx.writeBuffer()) };
    }),
  );
  const names = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set([...g.pms.map((r) => r.performedBy), ...g.condemnations.flatMap((c) => [c.request.requestedBy, c.request.decidedBy ?? ''])])] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const checklists = await checklistsPdf(g, names, base);

  const filename = `bme-audit-pack-${q.from}_to_${q.to}${departmentName ? `-${safeName(departmentName).replace(/\s+/g, '-')}` : ''}.zip`;
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('warning', (e) => console.error('Audit pack warning:', e));
  zip.on('error', (e) => {
    console.error('Audit pack failed:', e);
    res.destroy(e);
  });
  zip.pipe(res);

  for (const r of reports) zip.append(r.buffer, { name: r.file });
  zip.append(checklists, { name: '03 PMS checklists.pdf' });

  // Stored files, one at a time. Names carry the asset ID and date so a folder listing reads in order.
  const missing: { file: string; why: string }[] = [];
  const storage = getStorage();
  const calById = new Map(g.calibrations.map((c) => [c.id, c]));
  const used = new Set<string>();
  const unique = (name: string) => {
    let n = name;
    for (let i = 2; used.has(n); i++) n = name.replace(/(\.[^.]*)?$/, ` (${i})$1`);
    used.add(n);
    return n;
  };
  const addFile = async (folder: string, label: string, key: string) => {
    if (res.destroyed) return; // the download was cancelled: stop reading files
    const name = unique(`${folder}/${safeName(label)}`);
    try {
      zip.append(await storage.get(key), { name });
    } catch (e) {
      missing.push({ file: name, why: e instanceof Error ? e.message.slice(0, 160) : 'Could not be read' });
    }
  };
  for (const a of g.certificates) {
    const cal = calById.get(a.ownerId)!;
    await addFile('Calibration certificates', `${cal.asset.assetCode} ${isoDate(cal.doneOn)} ${a.fileName || `certificate${extension(a.mime)}`}`, a.filePath);
  }
  const pmsById = new Map(g.pms.map((r) => [r.id, r]));
  for (const a of g.oemReports) {
    const r = pmsById.get(a.ownerId)!;
    await addFile('PMS reports (OEM)', `${r.asset.assetCode} ${isoDate(r.performedOn)} ${a.fileName || `report${extension(a.mime)}`}`, a.filePath);
  }
  const assetOf = (id: string) => g.condemnations.find((c) => c.asset.id === id || (c.request.payload as { attachmentId?: string | null }).attachmentId === id)?.asset;
  for (const a of g.letters) {
    const asset = assetOf(a.ownerId) ?? assetOf(a.id);
    await addFile('Condemnation', `${asset?.assetCode ?? 'asset'} ${DOC_KIND[a.kind] ?? 'Document'} ${a.fileName || `document${extension(a.mime)}`}`, a.filePath);
  }

  // The index last (it lists what could not be added), named so it sorts first.
  const index: Collector = { sheets: [], kpis: [], charts: [] };
  const pmsPassed = g.pms.filter((r) => r.result === 'pass').length;
  const active = await prisma.asset.findMany({ where: { status: 'active', ...scope }, select: { nextPmsDue: true, nextCalibrationDue: true } });
  const today = todayISO();
  const onSchedule = (key: 'nextPmsDue' | 'nextCalibrationDue') => {
    const due = active.filter((a) => a[key]);
    return due.length ? 1 - due.filter((a) => isoDate(a[key]!) < today).length / due.length : null;
  };
  kpi(index, 'Equipment', g.assets, 'int', 'All, including condemned');
  kpi(index, 'PMS done', g.pms.length, 'int', g.pms.length ? `${g.pms.length - pmsPassed} failed` : 'None in the period');
  kpi(index, 'PMS on schedule', onSchedule('nextPmsDue'), 'pct', `As at ${prettyDate(parseDate(today))}`);
  kpi(index, 'Calibrations done', g.calibrations.length, 'int', `${g.certificates.length} certificates included`);
  kpi(index, 'Calibration on schedule', onSchedule('nextCalibrationDue'), 'pct', `As at ${prettyDate(parseDate(today))}`);
  kpi(index, 'Breakdowns', g.complaints, 'int', 'Complaints raised in the period');
  kpi(index, 'Condemned', g.condemnations.length, 'int', 'In the period, with HOD approval');
  kpi(index, 'Files missing', missing.length, 'int', missing.length ? 'Listed below' : 'None', missing.length ? 'bad' : 'good');
  addSheet(index, 'What is in this pack', [{ header: 'File or folder', key: 'file', width: 40 }, { header: 'What it shows', key: 'what', width: 90 }], [
    ...reports.slice(0, 2).map((r) => ({ file: r.file, what: r.what })),
    { file: '03 PMS checklists.pdf', what: 'Every PMS in the period with each answer as recorded (records are read-only once submitted)' },
    ...reports.slice(2).map((r) => ({ file: r.file, what: r.what })),
    { file: 'PMS reports (OEM)/', what: `${g.oemReports.length - missing.filter((m) => m.file.startsWith('PMS reports')).length} service reports of PMS done by the OEM engineer` },
    { file: 'Calibration certificates/', what: `${g.certificates.length - missing.filter((m) => m.file.startsWith('Calibration')).length} certificates of calibrations done in the period` },
    { file: 'Condemnation/', what: `${g.letters.length - missing.filter((m) => m.file.startsWith('Condemnation')).length} end-of-life letters and condemnation forms` },
  ]);
  addSheet(index, 'Equipment condemned in the period', [
    { header: 'Asset ID', key: 'code', width: 26 }, { header: 'Asset', key: 'name', width: 26 }, { header: 'Department', key: 'dept', width: 22 }, { header: 'Reason', key: 'reason', width: 40 },
    { header: 'Asked by', key: 'by', width: 20 }, { header: 'Approved by', key: 'approver', width: 20 }, { header: 'Approved on', key: 'on', fmt: 'date' },
  ], g.condemnations.map(({ request, asset }) => ({
    code: asset.assetCode, name: asset.name, dept: asset.department.name, reason: (request.payload as { reason?: string }).reason ?? '', by: names.get(request.requestedBy) ?? '', approver: request.decidedBy ? (names.get(request.decidedBy) ?? '') : '', on: request.decidedAt,
  })));
  if (missing.length) addSheet(index, 'Files that could not be added', [{ header: 'File', key: 'file', width: 60 }, { header: 'Why', key: 'why', width: 70 }], missing);
  zip.append(
    await toPdf({
      ...base,
      type: 'audit-pack',
      title: `Audit pack${departmentName ? `: ${departmentName}` : ''}`,
      group: null,
      note: 'Made from the records in the BME Asset Management system. PMS dates are set by the system on submission and records cannot be edited; every change to equipment, approvals and sign-ins is in the audit log.',
      ...index,
    }),
    { name: '00 Index.pdf' },
  );
  await zip.finalize();
  return { filename, missing: missing.length, certificates: g.certificates.length };
}

const extension = (mime: string) => (mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : mime === 'image/jpeg' ? '.jpg' : '');
