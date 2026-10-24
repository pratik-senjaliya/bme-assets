// The full demo hospital: every module filled with about 18 months of believable history, so each screen, dashboard
// and report has something real to show. For a demo or training database only, never an install:
//   npm run db:demo -w apps/api      (resets the database first: everything in it is replaced)
// Dates are worked out from today, so the demo always looks current. A fixed random seed keeps it the same each time.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import PDFDocument from 'pdfkit';
import type { Prisma } from '@prisma/client';
import { isCritical, UNRESOLVED_STATUSES, type Criticality, type PmsAnswer, type PmsItem, type Register, type RoleName } from '@bme/shared';
import { formatAssetCode } from './lib/assetCode';
import { ensureRolesAndPermissions, ensureStarterTrades, ensureStarterTypes } from './lib/baseData';
import { addDaysISO, addMonths, isoDate, monthInTz, parseDate, todayISO, zonedDayStart } from './lib/dates';
import { hospitalScope } from './lib/people';
import { prisma } from './lib/prisma';
import { getStorage } from './lib/storage';
import { complaintNo } from './modules/complaints/complaints.service';
import { evaluateAnswers, templateItems } from './modules/pms/pms.service';
import { generateReminders } from './modules/reminders/reminders.service';
import { buildMonthlyReport } from './modules/reports/monthly.service';

const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo@1234';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const HISTORY_DAYS = 540; // the system went live about 18 months ago

// ---------- Small helpers ----------

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261023);
const between = (a: number, b: number) => a + rand() * (b - a);
const int = (a: number, b: number) => Math.floor(between(a, b + 1));
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;
const round = (n: number, step = 1) => Math.round(n / step) * step;

const TODAY = todayISO();
const day = (n: number) => parseDate(addDaysISO(TODAY, n)); // a calendar date, n days from today
const at = (n: number, hour: number) => new Date(zonedDayStart(addDaysISO(TODAY, n)).getTime() + hour * HOUR); // hospital time
const daysAgo = (d: Date) => Math.round((Date.now() - d.getTime()) / DAY);
const NOW = new Date();

// Audit trail, written in bulk at the end (the log is append-only; these are the entries the actions would have made).
const audits: Prisma.AuditLogCreateManyInput[] = [];
const log = (actorId: string | null, action: string, entityType: string, entityId: string | null, when: Date, after?: object) =>
  audits.push({ actorId, action, entityType, entityId, at: when, after: after as Prisma.InputJsonValue, ip: actorId ? `192.168.1.${int(20, 90)}` : null });

// A real one-page PDF in storage, recorded as a document on its owner (certificates, letters, reports, licences).
const storage = getStorage();
async function pdf(title: string, lines: string[]) {
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', r));
  doc.fontSize(18).text(title).moveDown();
  doc.fontSize(11);
  for (const l of lines) doc.text(l).moveDown(0.4);
  doc.moveDown(2).fontSize(9).fillColor('#666').text('Demo document generated for the BME Asset Management demo.');
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
async function attach(owner: { type: string; id: string; assetId: string | null }, kind: Prisma.AttachmentCreateInput['kind'], fileName: string, title: string, lines: string[], when: Date, by: string) {
  const buf = await pdf(title, lines);
  const key = `${owner.assetId ? `assets/${owner.assetId}` : `${owner.type}s/${owner.id}`}/${randomUUID()}.pdf`;
  await storage.put(key, buf, 'application/pdf');
  return prisma.attachment.create({ data: { ownerType: owner.type, ownerId: owner.id, kind, fileName, filePath: key, mime: 'application/pdf', size: buf.length, createdAt: when, createdBy: by } });
}

// A filled-in checklist like an engineer's: readings near the middle of the range, now and then one item failing.
function answersFor(items: PmsItem[], fail: boolean): Record<string, PmsAnswer> {
  const out: Record<string, PmsAnswer> = {};
  const scored = items.filter((i) => i.type !== 'text');
  const failing = fail ? scored[Math.floor(rand() * scored.length)]?.id : undefined;
  for (const item of items) {
    if (item.type === 'check') out[item.id] = item.id === failing ? 'fail' : 'pass';
    else if (item.type === 'reading') {
      const lo = item.min ?? 0;
      const hi = item.max ?? lo + 10;
      const v = item.id === failing ? hi + (hi - lo) * 0.25 : (lo + hi) / 2 + (rand() - 0.5) * (hi - lo) * 0.6;
      out[item.id] = Math.round(v * 10) / 10;
    } else out[item.id] = failing ? 'Reported to the HOD; part ordered.' : pick(['', '', 'All OK', 'Cleaned and checked']);
  }
  return out;
}

// ---------- The hospital ----------

const DEPARTMENTS = [
  { code: 'BME', name: 'Biomedical Engineering', locations: [['WKSP', 'Workshop']] },
  { code: 'ICU', name: 'Intensive Care Unit', locations: [['ICU1', 'ICU 1'], ['ICU2', 'ICU 2'], ['ICUT', 'ICU toilets'], ['ICUN', 'ICU nursing station']] },
  { code: 'NICU', name: 'Neonatal ICU', locations: [['NIC1', 'NICU bay 1'], ['NIC2', 'NICU bay 2']] },
  { code: 'OT', name: 'Operation Theatre', locations: [['OT1', 'OT 1'], ['OT2', 'OT 2'], ['RECV', 'Recovery'], ['CSSD', 'CSSD']] },
  { code: 'ER', name: 'Emergency', locations: [['TRI', 'Triage'], ['RES', 'Resuscitation bay'], ['ERW', 'Emergency ward']] },
  { code: 'RAD', name: 'Radiology', locations: [['XR1', 'X-ray room'], ['USG', 'Ultrasound room']] },
  { code: 'WARD', name: 'General Ward', locations: [['W2', '2nd floor ward'], ['W3', '3rd floor ward'], ['W2T', '2nd floor toilets'], ['PANT', 'Pantry']] },
  { code: 'ENG', name: 'Engineering Services', locations: [['DGR', 'DG room'], ['PLNT', 'Plant room'], ['MAIN', 'Main block'], ['GAS', 'Medical gas manifold room'], ['TERR', 'Terrace']] },
] as const;

const USERS: { key: string; name: string; email: string; role: RoleName; dept?: string; username?: string; deputy?: boolean }[] = [
  { key: 'super', name: 'Vendor Support', email: 'superadmin@demo.local', role: 'super_admin' },
  { key: 'hod', name: 'Dr. Meera Shah (HOD)', email: 'admin@demo.local', role: 'admin' },
  { key: 'ravi', name: 'Ravi Patel', email: 'biomed@demo.local', role: 'biomed' },
  { key: 'kiran', name: 'Kiran Joshi', email: 'kiran@demo.local', role: 'biomed', deputy: true },
  { key: 'neha', name: 'Neha Trivedi', email: 'neha@demo.local', role: 'biomed' },
  { key: 'suresh', name: 'Suresh Mehta', email: 'maintenance@demo.local', role: 'maintenance' },
  { key: 'imran', name: 'Imran Shaikh', email: 'imran@demo.local', role: 'maintenance' },
  { key: 'anita', name: 'Sister Anita Desai', email: 'nursing@demo.local', role: 'nursing', dept: 'ICU' },
  { key: 'nicu', name: 'Sister Priya Nair', email: 'nicu@demo.local', role: 'nursing', dept: 'NICU', username: 'nicu.sister' },
  { key: 'ot', name: 'Sister Farida Khan', email: 'ot@demo.local', role: 'nursing', dept: 'OT', username: 'ot.sister' },
  { key: 'er', name: 'Brother Joseph Dsouza', email: 'er@demo.local', role: 'nursing', dept: 'ER', username: 'er.staff' },
  { key: 'rad', name: 'Rekha Soni (Radiographer)', email: 'rad@demo.local', role: 'nursing', dept: 'RAD' },
  { key: 'ward', name: 'Sister Kavita Rao', email: 'ward@demo.local', role: 'nursing', dept: 'WARD', username: 'ward.sister' },
];
const NURSE_OF: Record<string, string> = { ICU: 'anita', NICU: 'nicu', OT: 'ot', ER: 'er', RAD: 'rad', WARD: 'ward', BME: 'ravi', ENG: 'suresh' };

const VENDORS = [
  { name: 'Drager Medical India', phone: '079 4000 1100', email: 'service.in@draeger.com', address: 'Ahmedabad', contacts: [['Amit Verma', 'Service engineer', '98250 11001'], ['Sneha Iyer', 'Sales', '98250 11002']] },
  { name: 'Philips Healthcare', phone: '1800 102 2929', email: 'care.india@philips.com', address: 'Gurugram', contacts: [['Rahul Menon', 'Field engineer', '98980 22001']] },
  { name: 'GE Healthcare', phone: '1800 102 7766', email: 'service@ge.com', address: 'Bengaluru', contacts: [['Vikram Rao', 'Service engineer', '99090 33001']] },
  { name: 'Mindray Medical India', phone: '022 6600 9000', email: 'service@mindray.in', address: 'Mumbai', contacts: [['Pooja Shah', 'Service engineer', '97250 44001']] },
  { name: 'B. Braun Medical', phone: '022 6668 2222', email: 'service@bbraun.in', address: 'Mumbai', contacts: [['Nilesh Patil', 'Field engineer', '98330 55001']] },
  { name: 'Zoll Medical India', phone: '011 4170 0000', email: 'support@zoll.in', address: 'New Delhi', contacts: [['Arjun Singh', 'Service engineer', '98100 66001']] },
  { name: 'Allied Medical Systems', phone: '079 2656 7788', email: 'sales@alliedmed.in', address: 'Ahmedabad', contacts: [['Hardik Desai', 'Sales', '98252 77001'], ['Manoj Pillai', 'Service', '98252 77002']] },
  { name: 'Cummins Sales and Service', phone: '079 2583 0000', email: 'service.ahd@cummins.com', address: 'Ahmedabad', contacts: [['Rajesh Gohil', 'DG service engineer', '98240 88001']] },
  { name: 'Carrier Airconditioning', phone: '1800 209 9220', email: 'service@carrier.in', address: 'Gurugram', contacts: [['Deepak Jain', 'HVAC engineer', '98240 99001']] },
  { name: 'Otis Elevator Company', phone: '1800 233 6847', email: 'service@otis.in', address: 'Mumbai', contacts: [['Sameer Kulkarni', 'Lift technician', '98200 10001']] },
  { name: 'APC by Schneider', phone: '1800 419 4272', email: 'support.in@se.com', address: 'Bengaluru', contacts: [['Kunal Shah', 'UPS engineer', '98200 20001']] },
  { name: 'Inox Air Products', phone: '079 2970 3000', email: 'medgas@inoxap.com', address: 'Vadodara', contacts: [['Tushar Bhatt', 'Medical gas engineer', '98250 30001']] },
] as const;

// Extra equipment types beyond the starter ones, each with a short generic checklist.
const EXTRA_TYPES: { code: string; name: string; pms: number; cal: number | null; register?: Register; medicalGas?: boolean; checks: string[] }[] = [
  { code: 'ECG', name: 'ECG Machine', pms: 6, cal: 12, checks: ['Leads and cables intact', 'Printer and paper feed', 'Simulator trace correct'] },
  { code: 'SYR', name: 'Syringe Pump', pms: 6, cal: 12, checks: ['Syringe clamp and plunger sensor', 'Occlusion alarm', 'Flow accuracy within 5%'] },
  { code: 'ANES', name: 'Anaesthesia Workstation', pms: 3, cal: 12, checks: ['Leak test passed', 'Vaporiser seated and sealed', 'O2 failure alarm', 'Ventilator self-test'] },
  { code: 'OTL', name: 'OT Light', pms: 6, cal: null, checks: ['All LED modules light', 'Arm balance and brakes', 'Focus and intensity control'] },
  { code: 'ESU', name: 'Electrosurgical Unit', pms: 6, cal: 12, checks: ['Return electrode alarm', 'Output power within limits', 'Footswitch works'] },
  { code: 'XRAY', name: 'X-ray Unit', pms: 6, cal: 12, checks: ['Collimator light aligned', 'Exposure switch and interlocks', 'kV and mAs output checked'] },
  { code: 'USG', name: 'Ultrasound', pms: 6, cal: null, checks: ['Probes free of cracks', 'Image quality on phantom', 'Printer works'] },
  { code: 'WARM', name: 'Infant Warmer', pms: 6, cal: 12, checks: ['Skin probe reading correct', 'Heater and alarms', 'Mattress and tray intact'] },
  { code: 'PHOT', name: 'Phototherapy Unit', pms: 6, cal: 12, checks: ['Irradiance within range', 'Lamp hours noted', 'Fan works'] },
  { code: 'SUCT', name: 'Suction Apparatus', pms: 6, cal: null, checks: ['Vacuum reaches -500 mmHg', 'Jar and tubing intact', 'Overflow valve works'] },
  { code: 'AUTO', name: 'Autoclave', pms: 3, cal: 12, checks: ['Door gasket and lock', 'Bowie-Dick test passed', 'Safety valve works'] },
  { code: 'FIRE', name: 'Fire Pump', pms: 1, cal: null, register: 'facility', checks: ['Weekly run test done', 'Jockey pump auto start', 'Pressure at header normal'] },
  { code: 'PANL', name: 'LT Electrical Panel', pms: 6, cal: null, register: 'facility', checks: ['Thermography: no hot spots', 'Busbar tightness', 'Earth resistance within limits'] },
  { code: 'PUMP', name: 'Water Pump', pms: 3, cal: null, register: 'facility', checks: ['No leakage at gland', 'Motor current normal', 'Foot valve and float switch'] },
  { code: 'COMP', name: 'Medical Air Compressor', pms: 3, cal: 12, medicalGas: true, checks: ['Dryer and filters changed as due', 'Dew point within limits', 'Changeover works'] },
  { code: 'VAC', name: 'Medical Vacuum Pump', pms: 3, cal: null, medicalGas: true, checks: ['Vacuum at plant normal', 'Bacterial filter changed', 'Duplex changeover'] },
];

// [type, name, make, model, dept, location, criticality, age in years, cost (Rs), supplier index, service vendor index]
type Spec = [string, string, string, string, string, string, Criticality, number, number, number, number | null];
const ASSETS: Spec[] = [
  ['VENT', 'ICU Ventilator A', 'Drager', 'Evita V300', 'ICU', 'ICU1', 'most_critical', 4.2, 1850000, 0, 0],
  ['VENT', 'ICU Ventilator B', 'Drager', 'Evita V300', 'ICU', 'ICU1', 'most_critical', 4.2, 1850000, 0, 0],
  ['VENT', 'ICU Ventilator C', 'Hamilton', 'C1', 'ICU', 'ICU2', 'most_critical', 2.1, 1450000, 6, 6],
  ['VENT', 'ICU Ventilator D', 'Mindray', 'SV300', 'ICU', 'ICU2', 'most_critical', 0.8, 1250000, 3, 3],
  ['VENT', 'Transport Ventilator', 'Drager', 'Oxylog 3000', 'ER', 'RES', 'most_critical', 6.5, 980000, 0, 0],
  ['VENT', 'NICU Ventilator', 'Drager', 'Babylog VN500', 'NICU', 'NIC1', 'most_critical', 3.3, 2100000, 0, 0],
  ['MON', 'Bedside Monitor ICU-1', 'Philips', 'MX450', 'ICU', 'ICU1', 'critical', 4.2, 320000, 1, 1],
  ['MON', 'Bedside Monitor ICU-2', 'Philips', 'MX450', 'ICU', 'ICU1', 'critical', 4.2, 320000, 1, 1],
  ['MON', 'Bedside Monitor ICU-3', 'Philips', 'MX450', 'ICU', 'ICU2', 'critical', 4.2, 320000, 1, 1],
  ['MON', 'Bedside Monitor ICU-4', 'Mindray', 'ePM 12M', 'ICU', 'ICU2', 'critical', 1.4, 240000, 3, 3],
  ['MON', 'Multipara Monitor OT-1', 'GE', 'Carescape B450', 'OT', 'OT1', 'critical', 5.1, 410000, 2, 2],
  ['MON', 'Multipara Monitor OT-2', 'GE', 'Carescape B450', 'OT', 'OT2', 'critical', 5.1, 410000, 2, 2],
  ['MON', 'Recovery Monitor', 'Mindray', 'iMEC 10', 'OT', 'RECV', 'minor', 3.7, 120000, 3, 3],
  ['MON', 'ER Monitor 1', 'Mindray', 'ePM 10', 'ER', 'RES', 'critical', 2.6, 210000, 3, 3],
  ['MON', 'ER Monitor 2', 'Mindray', 'ePM 10', 'ER', 'TRI', 'minor', 2.6, 210000, 3, 3],
  ['MON', 'NICU Monitor 1', 'Philips', 'MX400', 'NICU', 'NIC1', 'critical', 3.3, 290000, 1, 1],
  ['MON', 'NICU Monitor 2', 'Philips', 'MX400', 'NICU', 'NIC2', 'critical', 3.3, 290000, 1, 1],
  ['MON', 'Ward Monitor', 'BPL', 'Excello', 'WARD', 'W2', 'general', 11.5, 85000, 6, null],
  ['DEFIB', 'Defibrillator ICU', 'Zoll', 'R Series', 'ICU', 'ICUN', 'most_critical', 5.8, 520000, 5, 5],
  ['DEFIB', 'Defibrillator ER', 'Philips', 'HeartStart XL+', 'ER', 'RES', 'most_critical', 2.9, 480000, 1, 1],
  ['DEFIB', 'Defibrillator OT', 'Zoll', 'M Series', 'OT', 'OT1', 'most_critical', 10.4, 390000, 5, 5],
  ['DEFIB', 'Defibrillator Ward', 'BPL', 'DF 2617', 'WARD', 'W3', 'critical', 7.2, 260000, 6, null],
  ['INFP', 'Infusion Pump ICU-1', 'B. Braun', 'Infusomat Space', 'ICU', 'ICU1', 'minor', 3.9, 95000, 4, 4],
  ['INFP', 'Infusion Pump ICU-2', 'B. Braun', 'Infusomat Space', 'ICU', 'ICU1', 'minor', 3.9, 95000, 4, 4],
  ['INFP', 'Infusion Pump ICU-3', 'B. Braun', 'Infusomat Space', 'ICU', 'ICU2', 'minor', 3.9, 95000, 4, 4],
  ['INFP', 'Infusion Pump ICU-4', 'B. Braun', 'Infusomat Space', 'ICU', 'ICU2', 'minor', 1.2, 99000, 4, 4],
  ['INFP', 'Infusion Pump ER', 'Mindray', 'BeneFusion VP3', 'ER', 'ERW', 'minor', 2.4, 78000, 3, 3],
  ['INFP', 'Infusion Pump Ward', 'Mindray', 'BeneFusion VP3', 'WARD', 'W2', 'general', 2.4, 78000, 3, 3],
  ['SYR', 'Syringe Pump NICU-1', 'B. Braun', 'Perfusor Space', 'NICU', 'NIC1', 'critical', 3.3, 88000, 4, 4],
  ['SYR', 'Syringe Pump NICU-2', 'B. Braun', 'Perfusor Space', 'NICU', 'NIC2', 'critical', 3.3, 88000, 4, 4],
  ['SYR', 'Syringe Pump ICU', 'Mindray', 'BeneFusion SP3', 'ICU', 'ICU2', 'minor', 1.9, 65000, 3, 3],
  ['ECG', 'ECG Machine ICU', 'Philips', 'PageWriter TC20', 'ICU', 'ICUN', 'minor', 6.2, 180000, 1, 1],
  ['ECG', 'ECG Machine ER', 'BPL', 'Cardiart 9108', 'ER', 'TRI', 'minor', 4.5, 75000, 6, null],
  ['ECG', 'ECG Machine Ward', 'BPL', 'Cardiart 6208', 'WARD', 'W3', 'general', 8.9, 45000, 6, null],
  ['ANES', 'Anaesthesia Workstation OT-1', 'Drager', 'Fabius Plus', 'OT', 'OT1', 'most_critical', 5.6, 2400000, 0, 0],
  ['ANES', 'Anaesthesia Workstation OT-2', 'GE', 'Carestation 620', 'OT', 'OT2', 'most_critical', 1.7, 2850000, 2, 2],
  ['OTL', 'OT Light OT-1', 'Drager', 'Polaris 600', 'OT', 'OT1', 'critical', 5.6, 650000, 0, 0],
  ['OTL', 'OT Light OT-2', 'Allied', 'Surgilux LED', 'OT', 'OT2', 'critical', 1.7, 380000, 6, 6],
  ['ESU', 'Electrosurgical Unit OT-1', 'Valleylab', 'Force FX', 'OT', 'OT1', 'critical', 7.8, 560000, 6, 6],
  ['ESU', 'Electrosurgical Unit OT-2', 'Erbe', 'VIO 300D', 'OT', 'OT2', 'critical', 2.3, 920000, 6, 6],
  ['XRAY', 'X-ray Unit 500 mA', 'Siemens', 'Multix Select DR', 'RAD', 'XR1', 'critical', 4.8, 3800000, 2, 2],
  ['XRAY', 'Portable X-ray', 'Allengers', 'Mars 3.5', 'ICU', 'ICU2', 'critical', 3.0, 680000, 6, 6],
  ['USG', 'Ultrasound Radiology', 'GE', 'Voluson E8', 'RAD', 'USG', 'critical', 3.9, 4200000, 2, 2],
  ['USG', 'Ultrasound ER', 'Mindray', 'M7', 'ER', 'RES', 'minor', 2.2, 1450000, 3, 3],
  ['WARM', 'Infant Warmer 1', 'Phoenix', 'NWS 101', 'NICU', 'NIC1', 'critical', 4.4, 145000, 6, 6],
  ['WARM', 'Infant Warmer 2', 'Phoenix', 'NWS 101', 'NICU', 'NIC2', 'critical', 4.4, 145000, 6, 6],
  ['PHOT', 'Phototherapy Unit 1', 'Phoenix', 'Twin LED', 'NICU', 'NIC1', 'minor', 4.4, 85000, 6, 6],
  ['PHOT', 'Phototherapy Unit 2', 'Phoenix', 'Twin LED', 'NICU', 'NIC2', 'minor', 1.1, 92000, 6, 6],
  ['SUCT', 'Suction Apparatus ICU', 'Hospivac', '400', 'ICU', 'ICU1', 'minor', 5.0, 42000, 6, null],
  ['SUCT', 'Suction Apparatus OT', 'Hospivac', '400', 'OT', 'OT1', 'minor', 5.0, 42000, 6, null],
  ['SUCT', 'Suction Apparatus ER', 'Hospivac', '400', 'ER', 'RES', 'minor', 3.4, 45000, 6, null],
  ['AUTO', 'Autoclave CSSD', 'Getinge', 'HS 6610', 'OT', 'CSSD', 'critical', 6.9, 2600000, 6, 6],
  ['MON', 'Spare Monitor', 'Mindray', 'BeneVision N12', 'BME', 'WKSP', 'general', 2.0, 260000, 3, 3],
  ['INFP', 'Spare Infusion Pump', 'B. Braun', 'Infusomat Space', 'BME', 'WKSP', 'general', 3.9, 95000, 4, 4],
  // Medical gases: biomedical until the hospital says otherwise (Hospital settings).
  ['O2P', 'Oxygen PSA Plant 500 LPM', 'Inox', 'PSA-500', 'ENG', 'GAS', 'most_critical', 3.1, 6500000, 11, 11],
  ['MGM', 'O2 Manifold Main', 'Inox', 'Auto 2x10', 'ENG', 'GAS', 'most_critical', 6.0, 450000, 11, 11],
  ['COMP', 'Medical Air Compressor', 'Atlas Copco', 'GA 11', 'ENG', 'GAS', 'critical', 6.0, 950000, 11, 11],
  ['VAC', 'Medical Vacuum Plant', 'Busch', 'R5 RA 0100', 'ENG', 'GAS', 'critical', 6.0, 780000, 11, 11],
  // Facility equipment (the maintenance team).
  ['DG', 'DG Set 1 (500 kVA)', 'Cummins', 'C500D5', 'ENG', 'DGR', 'most_critical', 6.0, 4200000, 7, 7],
  ['DG', 'DG Set 2 (320 kVA)', 'Cummins', 'C320D5', 'ENG', 'DGR', 'most_critical', 3.0, 2900000, 7, 7],
  ['CHLR', 'Chiller 1 (150 TR)', 'Carrier', '30XW', 'ENG', 'PLNT', 'critical', 6.0, 5800000, 8, 8],
  ['CHLR', 'Chiller 2 (150 TR)', 'Carrier', '30XW', 'ENG', 'PLNT', 'critical', 6.0, 5800000, 8, 8],
  ['AHU', 'AHU ICU', 'Blue Star', 'DSA 15', 'ICU', 'ICU1', 'critical', 6.0, 850000, 8, 8],
  ['AHU', 'AHU OT-1', 'Blue Star', 'DSA 12 HEPA', 'OT', 'OT1', 'most_critical', 6.0, 1200000, 8, 8],
  ['AHU', 'AHU OT-2', 'Blue Star', 'DSA 12 HEPA', 'OT', 'OT2', 'most_critical', 1.7, 1350000, 8, 8],
  ['UPS', 'UPS ICU (20 kVA)', 'APC', 'Galaxy VS', 'ICU', 'ICU2', 'most_critical', 4.1, 640000, 10, 10],
  ['UPS', 'UPS OT (30 kVA)', 'APC', 'Galaxy VS', 'OT', 'OT2', 'most_critical', 4.1, 820000, 10, 10],
  ['LIFT', 'Bed Lift 1', 'Otis', 'Gen2', 'ENG', 'MAIN', 'critical', 6.0, 3200000, 9, 9],
  ['LIFT', 'Bed Lift 2', 'Otis', 'Gen2', 'ENG', 'MAIN', 'critical', 6.0, 3200000, 9, 9],
  ['LIFT', 'Passenger Lift', 'Otis', 'Gen2 Life', 'ENG', 'MAIN', 'minor', 6.0, 2400000, 9, 9],
  ['RO', 'RO Plant (Dialysis)', 'Ion Exchange', 'RO 500', 'ENG', 'PLNT', 'critical', 4.5, 1150000, 6, null],
  ['FIRE', 'Fire Hydrant Pump', 'Kirloskar', 'DB 125/26', 'ENG', 'PLNT', 'most_critical', 6.0, 680000, 6, null],
  ['PANL', 'Main LT Panel', 'Schneider', 'Okken', 'ENG', 'MAIN', 'most_critical', 6.0, 2200000, 10, null],
  ['PUMP', 'Domestic Water Pump', 'Kirloskar', 'KDS 538', 'ENG', 'TERR', 'minor', 6.0, 95000, 6, null],
];

const PROBLEMS: Record<string, string[]> = {
  VENT: ['High pressure alarm keeps sounding', 'Turbine noise during ventilation', 'Flow sensor error on the display', 'Battery not charging', 'O2 cell calibration failed'],
  MON: ['SpO2 reading not stable', 'ECG trace shows noise', 'Screen frozen, needs restart', 'NIBP cuff not inflating', 'No sound from alarms'],
  DEFIB: ['Charge time too long', 'Daily self-test failed', 'Paddle cable damaged', 'Battery low warning stays on'],
  INFP: ['Occlusion alarm without cause', 'Door sensor error', 'Keypad not responding', 'Air-in-line alarm all the time'],
  SYR: ['Plunger sensor error', 'Syringe size not detected', 'Rate drifts during infusion'],
  ECG: ['Paper not feeding', 'Lead off message on all leads', 'Printout faint'],
  ANES: ['Leak test failing', 'Vaporiser not locking', 'Ventilator stops with error 12'],
  OTL: ['Two LED modules not lighting', 'Arm drifts down during surgery'],
  ESU: ['Return electrode alarm during surgery', 'Cutting power weak'],
  XRAY: ['Exposure error, no image', 'Collimator lamp not working', 'Detector not detected'],
  USG: ['Probe image has dark lines', 'System hangs on boot'],
  WARM: ['Heater not warming', 'Skin probe reading wrong'],
  PHOT: ['Lamps not lighting', 'Fan noise'],
  SUCT: ['Weak suction', 'Motor not starting'],
  AUTO: ['Door not locking', 'Cycle aborts at sterilisation stage', 'Steam leak at gasket'],
  O2P: ['Purity low alarm', 'Compressor tripping'],
  MGM: ['Changeover not automatic', 'Pressure dropping in night'],
  COMP: ['Dew point high', 'Compressor overheating'],
  VAC: ['Vacuum low in ICU outlets', 'Pump noisy'],
  DG: ['Not starting on mains failure', 'Black smoke on load', 'Battery weak, slow cranking'],
  CHLR: ['High head pressure trip', 'Chilled water temperature high', 'Compressor not loading'],
  AHU: ['No cooling in the area', 'Belt noise', 'Water leaking from drain tray'],
  UPS: ['On battery alarm though mains is on', 'Fan fault alarm', 'Backup time very short'],
  LIFT: ['Stuck between floors', 'Door not closing fully', 'Jerk while stopping'],
  RO: ['TDS high in product water', 'Low pressure, pump tripping'],
  FIRE: ['Jockey pump starting too often', 'Pressure drop at header'],
  PANL: ['MCCB tripping on load', 'Hot smell from panel'],
  PUMP: ['Overhead tank not filling', 'Gland leakage'],
};
const FIXES: Record<Register, string[]> = {
  biomedical: ['Replaced the faulty part and tested on simulator', 'Cleaned, recalibrated and tested OK', 'Updated settings and ran the self-test', 'Replaced cable and checked readings', 'Reseated connector, working normally', 'OEM engineer replaced the board'],
  facility: ['Replaced the faulty part and tested on load', 'Cleaned and adjusted, working normally', 'Tightened connections and reset', 'Replaced belt and aligned', 'Vendor technician repaired, tested OK'],
};
const WARD_FAULTS: Record<string, string[]> = {
  Electrical: ['Tube light not working', 'Switch board sparking', 'Socket at bed 4 not working', 'Fan not running', 'Night lamp fused'],
  'Plumbing and water': ['Tap leaking', 'Wash basin blocked', 'Flush not working', 'No hot water in the shower', 'Water leaking under sink'],
  'AC and ventilation': ['AC not cooling', 'AC dripping water', 'Exhaust fan not working', 'Bad smell from AC vent'],
  'Civil (seepage, tiles, doors, windows)': ['Seepage on the wall', 'Broken floor tile near bed 6', 'Door lock broken', 'Window glass cracked'],
  'Carpentry and furniture': ['Bedside locker drawer broken', 'Chair leg broken', 'Cupboard hinge loose'],
  Lift: ['Lift button not working on 2nd floor', 'Lift light not working'],
  'Fire safety': ['Smoke detector beeping', 'Fire extinguisher pressure low'],
  'Medical gas': ['Oxygen outlet at bed 3 leaking', 'Vacuum outlet not working', 'Flowmeter not fitting outlet'],
  Other: ['Notice board loose', 'Curtain rail broken'],
};

const BIO_ITEMS = [
  ['ECG electrodes (pack of 50)', 'pack', 40, 20, 180],
  ['SpO2 probe, adult reusable', 'pcs', 12, 4, 2400],
  ['NIBP cuff, adult', 'pcs', 15, 5, 950],
  ['Ventilator breathing circuit', 'pcs', 30, 10, 650],
  ['Flow sensor, Evita', 'pcs', 6, 2, 8500],
  ['ECG paper roll 80 mm', 'roll', 50, 20, 120],
  ['Defib pads, adult', 'pair', 10, 4, 3200],
  ['Infusion pump battery', 'pcs', 4, 2, 5600],
  ['Fuse 2A glass', 'pcs', 60, 20, 8],
  ['O2 cell, ventilator', 'pcs', 4, 2, 7800],
] as const;
const FAC_ITEMS = [
  ['LED tube light 20 W', 'pcs', 80, 25, 220],
  ['MCB 16 A', 'pcs', 30, 10, 310],
  ['Tap washer set', 'pack', 25, 10, 60],
  ['AHU pre-filter', 'pcs', 24, 8, 1450],
  ['V-belt B-52', 'pcs', 10, 4, 680],
  ['Engine oil 15W40 (litre)', 'bottle', 60, 20, 380],
  ['Diesel filter', 'pcs', 8, 3, 950],
  ['Ceiling fan capacitor', 'pcs', 30, 10, 90],
  ['Flush valve kit', 'pcs', 10, 4, 540],
  ['Door closer', 'pcs', 6, 2, 1650],
] as const;

async function main() {
  if ((await prisma.asset.count()) > 0) {
    console.log('This database already has equipment. The full demo starts from an empty database: run  npm run db:demo -w apps/api  (it resets the database first).');
    process.exitCode = 1;
    return;
  }
  const t0 = Date.now();

  // ---------- Setup ----------
  const settings = await prisma.hospitalSettings.create({
    data: {
      name: 'Shalby Demo Hospital',
      shortCode: 'SHL',
      facilityEnabled: true,
      transfersEnabled: true,
      biomedContact: 'Biomedical on call: 98250 00214, ext. 214',
      facilityContact: 'Maintenance on call: 98250 00300, ext. 300',
      labelBaseUrl: null,
      backupLastAt: at(0, 2),
      dailyJobLastRunAt: at(0, 6),
      createdAt: at(-HISTORY_DAYS - 10, 10),
    },
  });
  await ensureRolesAndPermissions();
  await ensureStarterTypes();
  await ensureStarterTrades();
  for (const t of EXTRA_TYPES) {
    const type = await prisma.equipmentType.create({ data: { code: t.code, name: t.name, defaultPmsMonths: t.pms, defaultCalibrationMonths: t.cal, register: t.register ?? 'biomedical', medicalGas: !!t.medicalGas } });
    await prisma.pmsTemplate.create({
      data: { equipmentTypeId: type.id, version: 1, schema: { items: [{ id: 'visual', label: 'Visual inspection: casing, cables, no damage', type: 'check', required: true }, ...t.checks.map((label, i) => ({ id: `c${i}`, label, type: 'check', required: true })), { id: 'remarks', label: 'Remarks', type: 'text', required: false }] } },
    });
  }
  const types = new Map((await prisma.equipmentType.findMany()).map((t) => [t.code, t]));
  const templates = new Map((await prisma.pmsTemplate.findMany({ orderBy: { version: 'asc' } })).map((t) => [t.equipmentTypeId, t]));

  const dept = new Map<string, { id: string; code: string; name: string }>();
  const loc = new Map<string, { id: string; code: string; name: string; departmentId: string }>();
  for (const d of DEPARTMENTS) {
    const row = await prisma.department.create({ data: { code: d.code, name: d.name, createdAt: at(-HISTORY_DAYS - 9, 11) } });
    dept.set(d.code, row);
    for (const [code, name] of d.locations) loc.set(code, await prisma.location.create({ data: { departmentId: row.id, code, name, createdAt: at(-HISTORY_DAYS - 9, 11) } }));
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = new Map<string, { id: string; name: string; departmentId: string | null }>();
  for (const u of USERS) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: u.role } });
    const row = await prisma.user.create({
      data: { name: u.name, email: u.email, username: u.username ?? null, passwordHash, roleId: role.id, departmentId: u.dept ? dept.get(u.dept)!.id : null, deputy: !!u.deputy, createdAt: at(-HISTORY_DAYS - 8, 12) },
    });
    user.set(u.key, row);
    log(user.get('super')?.id ?? null, 'user.create', 'user', row.id, at(-HISTORY_DAYS - 8, 12), { name: u.name, role: u.role });
  }
  const U = (k: string) => user.get(k)!;
  const BIO_ENG = ['ravi', 'kiran', 'neha'];
  const FAC_ENG = ['suresh', 'imran'];
  const engineer = (r: Register) => U(pick(r === 'facility' ? FAC_ENG : BIO_ENG));

  const vendors = [];
  for (const v of VENDORS) {
    const row = await prisma.vendor.create({ data: { name: v.name, phone: v.phone, email: v.email, address: v.address, createdAt: at(-HISTORY_DAYS - 5, 12), createdBy: U('ravi').id } });
    await prisma.vendorContact.createMany({ data: v.contacts.map(([name, role, phone]) => ({ vendorId: row.id, name, role, phone })) });
    vendors.push(row);
  }

  // ---------- Equipment, purchase orders, warranties ----------
  const live = new Date(day(-HISTORY_DAYS).getTime());
  let seq = 0;
  type A = Prisma.AssetGetPayload<{ include: { equipmentType: true } }> & { cost: number; spec: Spec };
  const assets: A[] = [];
  for (const spec of ASSETS) {
    const [code, name, make, model, d, l, criticality, age, cost, sup, svc] = spec;
    const type = types.get(code)!;
    seq++;
    const installed = parseDate(isoDate(new Date(Date.now() - age * 365.25 * DAY)));
    // Equipment older than the system was entered when it went live; newer equipment the day it arrived.
    const createdAt = installed < live ? new Date(live.getTime() + int(0, 20) * DAY + 11 * HOUR) : new Date(installed.getTime() + 13 * HOUR);
    const warrantyMonths = cost > 1_000_000 ? 36 : code === 'DG' || code === 'LIFT' ? 24 : pick([12, 24, 24, 36]);
    const a = await prisma.asset.create({
      data: {
        assetCode: formatAssetCode(settings.assetIdPattern, { hosp: settings.shortCode, dept: d, type: code, loc: l, seq }),
        sequenceNo: seq,
        equipmentTypeId: type.id,
        name,
        make,
        model,
        serialNo: `${make.slice(0, 3).toUpperCase()}${int(10, 99)}${String(int(10000, 99999))}`,
        tagNo: `SHL/INV/${String(1000 + seq)}`,
        departmentId: dept.get(d)!.id,
        locationId: loc.get(l)!.id,
        criticality,
        register: type.register,
        installationDate: installed,
        warrantyMonths,
        warrantyEnd: addMonths(installed, warrantyMonths),
        pmsFrequencyMonths: type.defaultPmsMonths,
        supplierId: vendors[sup].id,
        serviceVendorId: svc == null ? null : vendors[svc].id,
        createdAt,
        createdBy: U(type.register === 'facility' ? 'suresh' : 'ravi').id,
      },
      include: { equipmentType: true },
    });
    assets.push({ ...a, cost, spec });
    log(a.createdBy, 'asset.create', 'asset', a.id, createdAt, { assetCode: a.assetCode, name });
    const po = await prisma.purchaseOrder.create({ data: { assetId: a.id, poNumber: `PO/${installed.getUTCFullYear()}/${String(300 + seq)}`, poDate: new Date(installed.getTime() - int(15, 45) * DAY), vendor: vendors[sup].name, cost, createdAt, createdBy: a.createdBy } });
    if (seq % 3 === 0) await attach({ type: 'purchase_order', id: po.id, assetId: a.id }, 'po', `${po.poNumber.replace(/\//g, '-')}.pdf`, `Purchase order ${po.poNumber}`, [`Supplier: ${vendors[sup].name}`, `Item: ${name} (${make} ${model})`, `Amount: Rs. ${cost.toLocaleString('en-IN')}`], createdAt, a.createdBy!);
  }
  const byName = (n: string) => assets.find((a) => a.name === n)!;
  const register = (a: A) => a.register;

  // ---------- Contracts and service visits ----------
  let contracts = 0;
  let serviceLogs = 0;
  for (const a of assets) {
    const svc = a.spec[10];
    if (svc == null || a.cost < 300000) continue;
    const warrantyEnd = a.warrantyEnd!;
    if (warrantyEnd > day(0)) continue; // still under warranty
    // AMC/CMC since the warranty ended, renewed yearly; the current one ends at different points (some soon).
    let start = warrantyEnd;
    const type = a.cost > 1_500_000 ? 'cmc' : 'amc';
    while (start < day(0)) {
      const end = new Date(addMonths(start, 12).getTime() - DAY);
      const ends = end > day(0) && chance(0.15) ? day(int(10, 50)) : end; // a few end soon
      await prisma.serviceContract.create({ data: { assetId: a.id, type, vendor: vendors[svc].name, startDate: start, endDate: ends, cost: round(a.cost * (type === 'cmc' ? 0.09 : 0.06), 500), createdAt: new Date(start.getTime() + 12 * HOUR), createdBy: U(a.register === 'facility' ? 'suresh' : 'ravi').id } });
      contracts++;
      if (ends < end) break;
      start = new Date(end.getTime() + DAY);
      if (chance(0.08)) break; // one or two lapsed, not renewed
    }
    for (let q = 1; q * 91 < Math.min(HISTORY_DAYS, daysAgo(warrantyEnd)); q++) {
      await prisma.serviceLog.create({ data: { assetId: a.id, serviceDate: day(-q * 91 + int(-5, 5)), kind: type === 'cmc' ? 'cmc_visit' : 'amc_visit', vendor: vendors[svc].name, description: pick(['Quarterly visit: filters changed, safety checks done', 'Preventive visit: cleaned, tested, no faults', 'Visit: software updated and performance checked']), createdBy: U(a.register === 'facility' ? 'suresh' : 'ravi').id } });
      serviceLogs++;
    }
  }

  // ---------- PMS (in-house, and by the OEM for equipment under contract) ----------
  let pmsCount = 0;
  const lagging = new Set(['Bedside Monitor ICU-3', 'ECG Machine Ward', 'Suction Apparatus ER', 'AHU ICU', 'Passenger Lift']);
  const failedNow = new Set(['Infusion Pump ICU-2']); // its last PMS failed: flagged, with a complaint
  for (const a of assets) {
    const months = a.equipmentType.defaultPmsMonths;
    const template = templates.get(a.equipmentTypeId);
    if (!months || !template) continue;
    const items = templateItems(template.schema);
    const first = new Date(Math.max(a.createdAt.getTime(), live.getTime()) + int(5, 25) * DAY);
    const dates: Date[] = [];
    for (let d = first; d < day(lagging.has(a.name) ? -int(months * 30 + 10, months * 30 + 40) : -2); d = new Date(addMonths(d, months).getTime() + int(-4, 6) * DAY)) dates.push(parseDate(isoDate(d)));
    const oem = a.spec[10] != null && a.cost > 1_000_000 && a.register === 'biomedical';
    for (const [i, done] of dates.entries()) {
      const last = i === dates.length - 1;
      const fail = last ? failedNow.has(a.name) : chance(0.04);
      const by = engineer(register(a));
      const answers = answersFor(items, fail);
      const useOem = oem && i % 2 === 1;
      const rec = await prisma.pmsRecord.create({
        data: {
          assetId: a.id, kind: useOem ? 'oem' : 'in_house', serviceBy: useOem ? `${a.spec[2]} service engineer, ${vendors[a.spec[10]!].name}` : null,
          templateId: template.id, performedOn: done, performedBy: by.id, answers, result: evaluateAnswers(items, answers).result,
          submittedAt: new Date(done.getTime() + int(10, 16) * HOUR), createdAt: new Date(done.getTime() + int(10, 16) * HOUR), createdBy: by.id,
        },
      });
      pmsCount++;
      log(by.id, 'pms.submit', 'pms_record', rec.id, rec.submittedAt, { assetCode: a.assetCode, result: rec.result });
      if (useOem) await attach({ type: 'pms_record', id: rec.id, assetId: a.id }, 'service_report', `OEM-PMS-${a.assetCode}-${isoDate(done)}.pdf`, 'Preventive maintenance service report', [`Equipment: ${a.name}, S/N ${a.serialNo}`, `Visit date: ${isoDate(done)}`, `Engineer: ${VENDORS[a.spec[10]!].contacts[0][0]}`, 'All checks done as per OEM procedure. Equipment handed over in working condition.'], rec.submittedAt, by.id);
      // A failed PMS (not the current one) is followed by a passing re-check a few days later.
      if (fail && !last) {
        const again = new Date(done.getTime() + int(2, 6) * DAY);
        const pass = answersFor(items, false);
        await prisma.pmsRecord.create({ data: { assetId: a.id, kind: 'in_house', templateId: template.id, performedOn: again, performedBy: by.id, answers: pass, result: 'pass', submittedAt: new Date(again.getTime() + 12 * HOUR), createdAt: new Date(again.getTime() + 12 * HOUR), createdBy: by.id } });
        pmsCount++;
      }
    }
    const lastDone = dates[dates.length - 1];
    if (lastDone) await prisma.asset.update({ where: { id: a.id }, data: { nextPmsDue: addMonths(lastDone, months), ...(failedNow.has(a.name) && { pmsFailedOn: lastDone }) } });
    else await prisma.asset.update({ where: { id: a.id }, data: { nextPmsDue: addMonths(new Date(Math.max(a.installationDate!.getTime(), live.getTime())), months) } });
  }

  // ---------- Calibration, with certificates ----------
  let calCount = 0;
  const calFailed = 'Syringe Pump NICU-2';
  for (const a of assets) {
    const months = a.equipmentType.defaultCalibrationMonths;
    if (!months) continue;
    let done = new Date(Math.max(a.createdAt.getTime(), live.getTime()) + int(10, 60) * DAY);
    let last: { doneOn: Date; result: string } | null = null;
    while (done < day(-5)) {
      const doneOn = parseDate(isoDate(done));
      const isLast = addMonths(done, months) >= day(-5);
      const result = isLast && a.name === calFailed ? 'fail' : 'pass';
      const agency = a.register === 'facility' ? 'NABL lab, Ahmedabad' : pick(['Philips Calibration Lab', 'Fluke Biomedical Services', 'Medcal Labs (NABL)', 'Zoll Service Centre']);
      const rec = await prisma.calibrationRecord.create({ data: { assetId: a.id, doneOn, dueOn: addMonths(doneOn, months), agency, result, createdAt: new Date(doneOn.getTime() + 15 * HOUR), createdBy: engineer(register(a)).id } });
      await attach({ type: 'calibration_record', id: rec.id, assetId: a.id }, 'certificate', `CAL-${a.assetCode}-${isoDate(doneOn)}.pdf`, 'Calibration certificate', [`Equipment: ${a.name} (${a.spec[2]} ${a.spec[3]}), S/N ${a.serialNo}`, `Calibrated on: ${isoDate(doneOn)}  Due: ${isoDate(addMonths(doneOn, months))}`, `Agency: ${agency}`, `Result: ${result === 'pass' ? 'Within tolerance' : 'OUT OF TOLERANCE: adjustment required'}`], rec.createdAt, rec.createdBy!);
      log(rec.createdBy, 'calibration.create', 'calibration_record', rec.id, rec.createdAt, { assetCode: a.assetCode, result });
      calCount++;
      last = { doneOn, result };
      done = new Date(addMonths(done, months).getTime() + int(-10, 10) * DAY);
    }
    await prisma.asset.update({
      where: { id: a.id },
      data: { nextCalibrationDue: last ? addMonths(last.doneOn, months) : addMonths(a.installationDate!, months), ...(last?.result === 'fail' && { calibrationFailedOn: last.doneOn }) },
    });
  }

  // ---------- Approvals: condemned, transferred, not in use, and requests waiting ----------
  const hod = U('hod');
  const condemned = byName('Ward Monitor');
  const condemnAt = at(-62, 15);
  const letter = await attach({ type: 'asset', id: condemned.id, assetId: condemned.id }, 'eol_letter', 'BPL-end-of-support-letter.pdf', 'End of support notice', ['BPL Medical Technologies regrets that the Excello monitor series is no longer supported.', 'Spare parts are not available after March of this year.'], at(-70, 11), U('ravi').id);
  await prisma.approvalRequest.create({
    data: { type: 'condemn', targetType: 'asset', targetId: condemned.id, payload: { reason: 'Display failed; OEM has ended support and parts are not available.', reasonCategory: 'end_of_support', estimatedValue: 3000, committeeDate: isoDate(day(-64)), attachmentId: letter.id }, requestedBy: U('ravi').id, status: 'approved', decidedBy: hod.id, decidedAt: condemnAt, reason: 'Approved by the condemnation committee.', createdAt: at(-68, 12), createdBy: U('ravi').id },
  });
  await prisma.asset.update({ where: { id: condemned.id }, data: { status: 'condemned', nextPmsDue: null, nextCalibrationDue: null } });
  log(hod.id, 'approval.decide', 'asset', condemned.id, condemnAt, { type: 'condemn', status: 'approved' });

  const transferred = byName('ECG Machine Ward');
  await prisma.approvalRequest.create({ data: { type: 'transfer', targetType: 'asset', targetId: transferred.id, payload: { toUnit: 'Shalby Hospital, Vapi unit', reason: 'Vapi unit opened its cardiology OPD; a newer ECG machine replaced this one here.' }, requestedBy: U('kiran').id, status: 'approved', decidedBy: hod.id, decidedAt: at(-25, 16), reason: null, createdAt: at(-27, 10), createdBy: U('kiran').id } });
  await prisma.asset.update({ where: { id: transferred.id }, data: { status: 'transferred', nextPmsDue: null, nextCalibrationDue: null } });
  await prisma.asset.update({ where: { id: byName('Spare Infusion Pump').id }, data: { status: 'not_in_use' } });

  const oldDefib = byName('Defibrillator OT');
  await prisma.approvalRequest.create({ data: { type: 'condemn', targetType: 'asset', targetId: oldDefib.id, payload: { reason: 'Over 10 years old, three breakdowns this year, battery and paddles both due for replacement.', reasonCategory: 'repair_cost', estimatedValue: 15000, committeeDate: isoDate(day(-3)) }, requestedBy: U('ravi').id, createdAt: at(-2, 11), createdBy: U('ravi').id } });
  const mon3 = byName('Bedside Monitor ICU-3');
  await prisma.approvalRequest.create({ data: { type: 'edit_key_field', targetType: 'asset', targetId: mon3.id, payload: { changes: { serialNo: `PHI${mon3.serialNo!.slice(3, 5)}88${mon3.serialNo!.slice(-3)}` }, previous: { serialNo: mon3.serialNo }, reason: 'Serial number typed wrong at entry; corrected from the label.' } as Prisma.InputJsonValue, requestedBy: U('neha').id, createdAt: at(-1, 15), createdBy: U('neha').id } });
  await prisma.approvalRequest.create({ data: { type: 'edit_key_field', targetType: 'asset', targetId: byName('Recovery Monitor').id, payload: { changes: { locationId: loc.get('OT2')!.id }, previous: { locationId: loc.get('RECV')!.id }, reason: 'Moved to OT 2 permanently.' } as Prisma.InputJsonValue, requestedBy: U('kiran').id, status: 'rejected', decidedBy: hod.id, decidedAt: at(-40, 12), reason: 'Keep it in Recovery; OT 2 has its own monitor.', createdAt: at(-41, 10), createdBy: U('kiran').id } });

  // ---------- Complaints: machine breakdowns and ward faults ----------
  const trades = await prisma.trade.findMany();
  const tradeBy = (n: string) => trades.find((t) => t.name === n)!;
  const usable = assets.filter((a) => a.status === 'active' || a.id === condemned.id || a.id === transferred.id);
  // A few machines break down far more than others (the "breakdown-prone" list), the rest now and then.
  const prone = new Map([['Defibrillator OT', 6], ['Ward Monitor', 5], ['ICU Ventilator A', 5], ['Autoclave CSSD', 5], ['Chiller 2 (150 TR)', 4], ['Bed Lift 1', 5], ['Infusion Pump ICU-2', 4], ['AHU OT-1', 4]]);
  const bag = usable.flatMap((a) => Array(prone.get(a.name) ?? (isCritical(a.criticality) ? 2 : 1)).fill(a) as A[]);
  type Plan = { raisedAt: Date; asset?: A; trade?: (typeof trades)[number]; locationId?: string; deptCode: string; description: string; urgent: boolean };
  const plans: Plan[] = [];
  for (let k = 0; k < 190; k++) {
    let a = pick(bag);
    const raisedAt = at(-int(3, HISTORY_DAYS - 5), between(7, 22));
    if (raisedAt < a.createdAt) continue;
    if ((a.id === condemned.id && raisedAt > at(-62, 0)) || (a.id === transferred.id && raisedAt > at(-25, 0))) a = byName('ICU Ventilator B');
    const deptCode = DEPARTMENTS.find((d) => dept.get(d.code)!.id === a.departmentId)!.code;
    plans.push({ raisedAt, asset: a, deptCode, description: pick(PROBLEMS[a.equipmentType.code] ?? ['Not working properly']), urgent: isCritical(a.criticality) && chance(0.25) });
  }
  const wardLocations = [...loc.values()].filter((l) => !['ENG', 'BME'].includes(DEPARTMENTS.find((d) => dept.get(d.code)!.id === l.departmentId)!.code));
  for (let k = 0; k < 110; k++) {
    const trade = pick(trades.filter((t) => t.name !== 'Other' || chance(0.3)));
    const l = pick(wardLocations);
    plans.push({ raisedAt: at(-int(2, 300), between(7, 22)), trade, locationId: l.id, deptCode: DEPARTMENTS.find((d) => dept.get(d.code)!.id === l.departmentId)!.code, description: `${pick(WARD_FAULTS[trade.name] ?? ['Needs attention'])}${chance(0.4) ? ` near bed ${int(1, 12)}` : ''}`, urgent: (trade.name === 'Medical gas' || trade.name === 'Lift') && chance(0.4) });
  }
  // The current picture: some waiting, some being worked on, one on hold, one escalated, some fixed and waiting to close.
  const current: Plan[] = [
    { raisedAt: at(0, between(6, 9)), asset: byName('ICU Ventilator A'), deptCode: 'ICU', description: 'High pressure alarm keeps sounding even at low settings', urgent: true },
    { raisedAt: at(-1, 21), asset: byName('Infusion Pump ICU-2'), deptCode: 'ICU', description: 'Failed PMS items: occlusion alarm does not trigger', urgent: false },
    { raisedAt: at(0, 8.5), trade: tradeBy('Plumbing and water'), locationId: loc.get('ICUT')!.id, deptCode: 'ICU', description: 'Tap leaking in ICU toilet, water on the floor', urgent: false },
    { raisedAt: at(-2, 10), asset: byName('Chiller 2 (150 TR)'), deptCode: 'ENG', description: 'High head pressure trip, chiller off', urgent: true },
    { raisedAt: at(-1, 14), asset: byName('Autoclave CSSD'), deptCode: 'OT', description: 'Cycle aborts at sterilisation stage', urgent: true },
    { raisedAt: at(-3, 11), asset: byName('X-ray Unit 500 mA'), deptCode: 'RAD', description: 'Detector not detected, OEM visit needed', urgent: false },
    { raisedAt: at(-6, 12), asset: byName('Ultrasound Radiology'), deptCode: 'RAD', description: 'Probe image has dark lines, probe replacement quoted', urgent: false },
    { raisedAt: at(-1, 9), trade: tradeBy('Electrical'), locationId: loc.get('W2')!.id, deptCode: 'WARD', description: 'Tube lights not working in bay 2', urgent: false },
    { raisedAt: at(-1, 16), trade: tradeBy('Medical gas'), locationId: loc.get('ICU1')!.id, deptCode: 'ICU', description: 'Oxygen outlet at bed 3 leaking', urgent: true },
    { raisedAt: at(-2, 15), asset: byName('Bedside Monitor ICU-1'), deptCode: 'ICU', description: 'NIBP cuff not inflating', urgent: false },
    { raisedAt: at(-1, 11), trade: tradeBy('AC and ventilation'), locationId: loc.get('OT2')!.id, deptCode: 'OT', description: 'OT 2 temperature 26 °C, AC not cooling', urgent: true },
    { raisedAt: at(0, 7), asset: byName('Bed Lift 1'), deptCode: 'ENG', description: 'Door not closing fully on 3rd floor', urgent: false },
  ];
  const currentState = ['open', 'open', 'open', 'in_progress', 'in_progress', 'on_hold', 'escalated', 'in_progress_late', 'in_progress', 'resolved', 'resolved', 'open'] as const;
  const all = [...plans.map((p) => ({ p, state: 'history' as const })), ...current.map((p, i) => ({ p, state: currentState[i] }))].sort((x, y) => x.p.raisedAt.getTime() - y.p.raisedAt.getTime());

  let seqC = 0;
  let expenses = 0;
  const complaintIds: { id: string; assetId: string | null; register: Register; departmentId: string; resolvedAt: Date | null }[] = [];
  for (const { p, state } of all) {
    const reg: Register = p.asset ? p.asset.register : p.trade!.register;
    const raiserKey = NURSE_OF[p.deptCode] ?? 'anita';
    const raiser = U(raiserKey);
    const eng = engineer(reg);
    const target = p.trade?.responseHours ?? null;
    const critical = p.asset ? isCritical(p.asset.criticality) : false;
    const respH = state === 'history' ? (target && chance(0.2) ? target * between(1.2, 3) : between(0.15, target ? target * 0.8 : critical ? 2 : 5)) : between(0.2, 1.5);
    const repairH = p.asset ? (critical && chance(0.18) ? between(20, 60) : between(1, 16)) : between(0.5, 8);
    const startedAt = state === 'open' ? null : new Date(p.raisedAt.getTime() + respH * HOUR);
    let resolvedAt = state === 'history' || state === 'resolved' ? new Date(startedAt!.getTime() + repairH * HOUR) : null;
    if (resolvedAt && resolvedAt > NOW) resolvedAt = new Date(NOW.getTime() - 0.5 * HOUR);
    const old = resolvedAt && NOW.getTime() - resolvedAt.getTime() > 3 * DAY;
    const byItself = old && chance(0.1);
    const closedAt = state === 'history' && resolvedAt && old ? new Date(resolvedAt.getTime() + (byItself ? 3 * 24 : between(1, 20)) * HOUR) : null;
    const status = state === 'open' ? 'open' : state === 'on_hold' ? 'on_hold' : state.startsWith('in_progress') || state === 'escalated' ? 'in_progress' : closedAt ? 'closed' : 'resolved';
    const assigned = state === 'open' && chance(0.5) ? null : state === 'open' ? eng : eng;
    const no = complaintNo(++seqC);
    const c = await prisma.complaint.create({
      data: {
        complaintNo: no,
        assetId: p.asset?.id ?? null,
        tradeId: p.trade?.id ?? null,
        locationId: p.locationId ?? null,
        raisedById: raiser.id,
        departmentId: p.asset ? p.asset.departmentId : dept.get(p.deptCode)!.id,
        register: reg,
        description: p.description,
        urgent: p.urgent,
        status,
        raisedAt: p.raisedAt,
        startedAt,
        startedBy: startedAt ? eng.id : null,
        resolvedAt,
        resolvedBy: resolvedAt ? eng.id : null,
        resolutionNotes: resolvedAt ? pick(FIXES[reg]) : null,
        assignedToId: state === 'open' && !assigned ? null : eng.id,
        assignedAt: state === 'open' && !assigned ? null : new Date(p.raisedAt.getTime() + Math.min(respH, 0.3) * HOUR),
        assignedBy: state === 'open' && !assigned ? null : chance(0.5) ? hod.id : eng.id,
        escalatedAt: state === 'escalated' ? new Date(startedAt!.getTime() + 2 * HOUR) : null,
        escalatedBy: state === 'escalated' ? eng.id : null,
        holdNote: state === 'on_hold' ? 'Waiting for the OEM engineer with the probe; visit on Monday' : null,
        closedAt,
        closedBy: closedAt && !byItself ? raiser.id : null,
        closeNote: byItself ? 'Closed automatically: not closed within 3 days of being resolved.' : null,
        createdAt: p.raisedAt,
        createdBy: raiser.id,
      },
    });
    complaintIds.push({ id: c.id, assetId: c.assetId, register: reg, departmentId: c.departmentId, resolvedAt });
    log(raiser.id, 'complaint.create', 'complaint', c.id, p.raisedAt, { complaintNo: no });
    const steps: Prisma.ComplaintStepCreateManyInput[] = [];
    if (startedAt) {
      if (chance(0.3)) steps.push({ complaintId: c.id, kind: 'started', note: pick(['Checking now, back in 30 minutes', 'Taking it to the workshop', 'Part needed, checking stock']), at: startedAt, by: eng.id });
      log(eng.id, 'complaint.start', 'complaint', c.id, startedAt);
    }
    if (state === 'escalated') steps.push({ complaintId: c.id, kind: 'escalated', note: 'Needs the OEM engineer: detector board fault', at: c.escalatedAt!, by: eng.id });
    if (state === 'on_hold') {
      steps.push({ complaintId: c.id, kind: 'escalated', note: 'Probe needs replacement, quote from GE', at: new Date(startedAt!.getTime() + 3 * HOUR), by: eng.id });
      steps.push({ complaintId: c.id, kind: 'held', note: c.holdNote, at: new Date(startedAt!.getTime() + 20 * HOUR), by: hod.id });
    }
    // Now and then a fix that did not hold: sent back once, then fixed again.
    if (state === 'history' && resolvedAt && chance(0.06)) {
      const first = new Date(startedAt!.getTime() + repairH * 0.4 * HOUR);
      steps.push({ complaintId: c.id, kind: 'resolved', note: 'Reset and tested', at: first, by: eng.id });
      steps.push({ complaintId: c.id, kind: 'reopened', note: 'Same problem again after an hour', at: new Date(first.getTime() + 0.3 * repairH * HOUR), by: raiser.id });
    }
    if (state === 'history' && resolvedAt && repairH > 20 && chance(0.5)) {
      steps.push({ complaintId: c.id, kind: 'escalated', note: 'Needs OEM support', at: new Date(startedAt!.getTime() + 2 * HOUR), by: eng.id });
      steps.push({ complaintId: c.id, kind: 'held', note: 'OEM engineer visit booked', at: new Date(startedAt!.getTime() + 4 * HOUR), by: hod.id });
      steps.push({ complaintId: c.id, kind: 'resumed', note: 'OEM engineer here', at: new Date(resolvedAt.getTime() - 3 * HOUR), by: hod.id });
    }
    if (resolvedAt) log(eng.id, 'complaint.resolve', 'complaint', c.id, resolvedAt);
    if (closedAt) {
      steps.push({ complaintId: c.id, kind: 'closed', note: byItself ? c.closeNote : null, at: closedAt, by: byItself ? null : raiser.id });
      log(byItself ? null : raiser.id, byItself ? 'complaint.autoclose' : 'complaint.close', 'complaint', c.id, closedAt);
    }
    if (steps.length) await prisma.complaintStep.createMany({ data: steps });
    if (p.asset && resolvedAt && chance(0.45)) {
      const spare = chance(0.55);
      await prisma.serviceExpense.create({
        data: { assetId: p.asset.id, complaintId: c.id, type: spare ? 'spare_part' : 'repair', description: spare ? pick(['Flow sensor', 'Battery pack', 'Power supply board', 'Cable assembly', 'Keypad membrane', 'Cooling fan', 'Contactor', 'Bearing set', 'Pressure switch']) : `Repair visit: ${pick(['fault tracing', 'board repair', 'recalibration', 'motor rewinding'])}`, amount: round(between(spare ? 600 : 1500, Math.min(p.asset.cost * 0.08, spare ? 45000 : 60000)), 50), date: parseDate(isoDate(resolvedAt)), vendor: p.asset.spec[10] != null ? vendors[p.asset.spec[10]].name : 'Local vendor', createdAt: resolvedAt, createdBy: eng.id },
      });
      expenses++;
    }
    if (chance(0.15)) await attach({ type: 'complaint', id: c.id, assetId: p.asset?.id ?? null }, 'photo', 'photo.pdf', `Photo for ${no}`, [p.description], new Date(p.raisedAt.getTime() + 60_000), raiser.id);
  }
  // The duplicate the ICU raised by mistake, waiting for the HOD to delete it.
  const dup = complaintIds.find((x) => x.assetId === byName('Bed Lift 1').id && !x.resolvedAt);
  if (dup) await prisma.approvalRequest.create({ data: { type: 'delete', targetType: 'complaint', targetId: dup.id, payload: { reason: 'Raised twice for the same fault' }, requestedBy: U('suresh').id, createdAt: at(0, 9), createdBy: U('suresh').id } });
  await prisma.complaint.updateMany({ where: { assetId: condemned.id, status: { in: UNRESOLVED_STATUSES } }, data: { status: 'closed', closedAt: condemnAt, closeNote: 'Closed: the equipment was condemned.' } });
  await prisma.hospitalSettings.update({ where: { id: settings.id }, data: { complaintSeq: seqC, assetSeq: seq, patternLocked: true } });

  // ---------- Consumables (one store per team) ----------
  let movements = 0;
  for (const [items, reg] of [[BIO_ITEMS, 'biomedical'], [FAC_ITEMS, 'facility']] as const) {
    const keeper = reg === 'facility' ? U('suresh') : U('ravi');
    for (const [name, unit, opening, reorder, cost] of items) {
      const item = await prisma.consumableItem.create({ data: { name, unit, stock: 0, reorderLevel: reorder, unitCost: cost, register: reg, createdAt: at(-HISTORY_DAYS + 2, 11), createdBy: keeper.id } });
      let stock = 0;
      const rows: Prisma.ConsumableMovementCreateManyInput[] = [];
      const add = (r: Omit<Prisma.ConsumableMovementCreateManyInput, 'itemId' | 'stockAfter' | 'createdBy'>, by = keeper.id) => {
        stock += r.quantity;
        rows.push({ ...r, itemId: item.id, stockAfter: stock, createdBy: by });
        movements++;
      };
      add({ kind: 'adjust', quantity: opening, date: day(-HISTORY_DAYS + 2), reason: 'Opening stock', createdAt: at(-HISTORY_DAYS + 2, 11) });
      const machines = assets.filter((a) => a.register === reg && a.status === 'active');
      for (let d = -HISTORY_DAYS + 9; d < 0; d += int(4, 12)) {
        if (stock <= reorder && chance(0.85)) {
          const q = round(opening * between(0.6, 1), 1);
          add({ kind: 'in', quantity: q, date: day(d), unitCost: round(cost * between(0.95, 1.1), 1), supplierId: pick(vendors).id, reference: `INV/${int(1000, 9999)}`, createdAt: at(d, 12) });
        }
        const q = Math.min(stock, int(1, Math.max(1, Math.round(opening / 8))));
        if (q <= 0) continue;
        const m = chance(0.4) ? pick(machines) : null;
        add({ kind: 'out', quantity: -q, date: day(d), unitCost: cost, departmentId: m ? m.departmentId : pick([...dept.values()]).id, assetId: m?.id ?? null, reason: m ? pick(['Replaced during PMS', 'Replaced during repair', 'Worn out']) : 'Ward use', createdAt: at(d, 15) }, engineer(reg).id);
      }
      // A count once a year that found two missing.
      if (stock > 2) add({ kind: 'adjust', quantity: -2, date: day(-int(30, 90)), reason: 'Stock count: two short', createdAt: at(-40, 17) });
      await prisma.consumableMovement.createMany({ data: rows });
      await prisma.consumableItem.update({ where: { id: item.id }, data: { stock } });
    }
  }

  // ---------- Statutory licences (with renewal history and documents) ----------
  let licences = 0;
  const licence = async (kind: string, name: string, authority: string, prefix: string, years: number, validToDays: number, asset: A | null, reg: Register, chain = 2) => {
    let prev: string | null = null;
    for (let i = chain - 1; i >= 0; i--) {
      const validTo = day(validToDays - i * years * 365);
      const validFrom = new Date(addMonths(validTo, -12 * years).getTime() + DAY);
      if (validTo < day(-HISTORY_DAYS) && i > 0) continue;
      const by = reg === 'facility' ? U('suresh') : U('ravi');
      const row: { id: string } = await prisma.licence.create({ data: { kind, name, authority, number: `${prefix}/${validFrom.getUTCFullYear()}/${int(100, 999)}`, validFrom, validTo, assetId: asset?.id ?? null, register: reg, renewsId: prev, createdAt: new Date(validFrom.getTime() + 2 * DAY), createdBy: by.id } });
      if (chance(0.85)) await attach({ type: 'licence', id: row.id, assetId: asset?.id ?? null }, 'certificate', `${prefix}-${isoDate(validFrom)}.pdf`, name, [`Issued by: ${authority}`, `Valid from ${isoDate(validFrom)} to ${isoDate(validTo)}`], new Date(validFrom.getTime() + 2 * DAY), by.id);
      prev = row.id;
      licences++;
    }
  };
  await licence('lift', 'Lift licence, Bed Lift 1', 'Lift Inspector, Ahmedabad', 'LIFT-1', 1, 18, byName('Bed Lift 1'), 'facility');
  await licence('lift', 'Lift licence, Bed Lift 2', 'Lift Inspector, Ahmedabad', 'LIFT-2', 1, 140, byName('Bed Lift 2'), 'facility');
  await licence('lift', 'Lift licence, Passenger Lift', 'Lift Inspector, Ahmedabad', 'LIFT-3', 1, 220, byName('Passenger Lift'), 'facility');
  await licence('fire_noc', 'Fire NOC, main building', 'Chief Fire Officer, AMC', 'FIRE', 1, 245, null, 'facility');
  await licence('dg_pollution', 'Consent to operate, DG sets', 'Gujarat Pollution Control Board', 'GPCB', 5, -6, byName('DG Set 1 (500 kVA)'), 'facility', 1);
  await licence('electrical', 'Electrical installation approval', 'Chief Electrical Inspector, Gujarat', 'CEI', 2, 410, byName('Main LT Panel'), 'facility', 1);
  await licence('peso', 'PESO licence, liquid oxygen tank', 'PESO, Vadodara', 'PESO', 3, 27, byName('Oxygen PSA Plant 500 LPM'), 'biomedical', 1);
  await licence('pressure_vessel', 'Pressure vessel inspection, autoclave', 'Inspector of Boilers', 'PV', 1, 75, byName('Autoclave CSSD'), 'biomedical');
  await licence('pressure_vessel', 'Pressure vessel inspection, air receiver', 'Inspector of Boilers', 'PVA', 1, 160, byName('Medical Air Compressor'), 'biomedical');
  await licence('water_test', 'Water test report, dialysis RO', 'NABL water lab', 'WTR', 0.25, 34, byName('RO Plant (Dialysis)'), 'facility', 5);
  await licence('aerb', 'AERB licence, X-ray 500 mA', 'AERB (eLORA)', 'AERB', 5, 1300, byName('X-ray Unit 500 mA'), 'biomedical', 1);
  await licence('aerb', 'AERB licence, portable X-ray', 'AERB (eLORA)', 'AERBP', 5, 900, byName('Portable X-ray'), 'biomedical', 1);

  // ---------- The logbook: six months of daily readings ----------
  let readings = 0;
  const READ_DAYS = 180;
  const logbook: { asset: string; name: string; unit: string; kind: 'level' | 'meter'; min?: number; max?: number; runHours?: boolean; every?: string; start: number; step: () => number }[] = [
    { asset: 'DG Set 1 (500 kVA)', name: 'Run hours', unit: 'h', kind: 'meter', runHours: true, start: 6120, step: () => round(between(1.5, 4.5), 0.1) },
    { asset: 'DG Set 1 (500 kVA)', name: 'Diesel level', unit: '%', kind: 'level', min: 30, max: 100, start: 85, step: () => -between(1, 3) },
    { asset: 'DG Set 1 (500 kVA)', name: 'Battery voltage', unit: 'V', kind: 'level', min: 24, max: 28.5, start: 26.8, step: () => between(-0.2, 0.2) },
    { asset: 'DG Set 2 (320 kVA)', name: 'Run hours', unit: 'h', kind: 'meter', runHours: true, start: 2410, step: () => round(between(0.5, 2.5), 0.1) },
    { asset: 'DG Set 2 (320 kVA)', name: 'Diesel level', unit: '%', kind: 'level', min: 30, max: 100, start: 90, step: () => -between(0.5, 2) },
    { asset: 'Chiller 1 (150 TR)', name: 'Chilled water supply', unit: '°C', kind: 'level', min: 5, max: 9, start: 7, step: () => between(-0.3, 0.3) },
    { asset: 'Chiller 1 (150 TR)', name: 'Chilled water return', unit: '°C', kind: 'level', min: 10, max: 15, start: 12, step: () => between(-0.3, 0.3) },
    { asset: 'Chiller 2 (150 TR)', name: 'Chilled water supply', unit: '°C', kind: 'level', min: 5, max: 9, start: 7.2, step: () => between(-0.3, 0.3) },
    { asset: 'RO Plant (Dialysis)', name: 'Product water TDS', unit: 'ppm', kind: 'level', min: 0, max: 50, start: 24, step: () => between(-3, 3) },
    { asset: 'RO Plant (Dialysis)', name: 'Feed pressure', unit: 'bar', kind: 'level', min: 1, max: 4, start: 2.5, step: () => between(-0.15, 0.15) },
    { asset: 'Main LT Panel', name: 'Energy meter', unit: 'kWh', kind: 'meter', start: 1_284_000, step: () => round(between(5200, 7400)) },
    { asset: 'Domestic Water Pump', name: 'Water meter', unit: 'm³', kind: 'meter', start: 38_400, step: () => round(between(55, 85)) },
    { asset: 'O2 Manifold Main', name: 'Line pressure', unit: 'bar', kind: 'level', min: 4, max: 5, start: 4.5, step: () => between(-0.08, 0.08) },
    { asset: 'Oxygen PSA Plant 500 LPM', name: 'Oxygen purity', unit: '%', kind: 'level', min: 93, max: 100, start: 95.5, step: () => between(-0.4, 0.4) },
    { asset: 'Fire Hydrant Pump', name: 'Header pressure', unit: 'bar', kind: 'level', min: 7, max: 9, every: 'week', start: 8, step: () => between(-0.2, 0.2) },
  ];
  const runAtPms = new Map<string, number>();
  for (const t of logbook) {
    const a = byName(t.asset);
    const type = await prisma.readingType.create({ data: { assetId: a.id, name: t.name, unit: t.unit, kind: t.kind, min: t.min ?? null, max: t.max ?? null, runHours: !!t.runHours, every: t.every ?? 'day', createdAt: at(-READ_DAYS - 1, 10), createdBy: U('suresh').id } });
    const rows: Prisma.ReadingCreateManyInput[] = [];
    let v = t.start;
    for (let d = -READ_DAYS; d <= -1; d++) {
      if (t.every === 'week' && d % 7 !== 0) continue;
      if (chance(0.03)) continue; // a missed day now and then
      if (t.kind === 'meter') v += t.step();
      else {
        v += t.step();
        if (t.name === 'Diesel level' && v < 40) v = between(88, 96); // topped up
        if (t.min != null && t.max != null) v = Math.min(t.max + (t.max - t.min) * 0.05, Math.max(t.min - (t.max - t.min) * 0.05, v));
        v = (v - (t.start)) * 0.9 + t.start; // drift back towards normal
      }
      let value = Math.round(v * 10) / 10;
      if (t.kind === 'level' && chance(0.025) && t.max != null) value = Math.round((t.max + (t.max - (t.min ?? 0)) * 0.2) * 10) / 10; // an out-of-range day
      const out = (t.min != null && value < t.min) || (t.max != null && value > t.max);
      rows.push({ id: randomUUID(), readingTypeId: type.id, assetId: a.id, value, takenAt: at(d, between(7.5, 9.5)), takenBy: U(pick(FAC_ENG)).id, outOfRange: out, note: out ? pick(['Informed the supervisor', 'Rechecked, same value', null]) : t.name === 'Diesel level' && value > 85 ? 'Topped up' : null });
    }
    // Yesterday's TDS was high: the plant needs attention (shows on My work and the dashboard).
    if (t.name === 'Product water TDS') rows[rows.length - 1] = { ...rows[rows.length - 1], value: 61, outOfRange: true, note: 'Membrane check requested' };
    await prisma.reading.createMany({ data: rows });
    readings += rows.length;
    // One misread corrected.
    if (t.name === 'Diesel level' && t.asset.startsWith('DG Set 1')) {
      const wrong = rows[rows.length - 10];
      await prisma.reading.create({ data: { readingTypeId: type.id, assetId: a.id, value: Number(wrong.value) + 20, takenAt: new Date((wrong.takenAt as Date).getTime() + 2 * HOUR), takenBy: U('suresh').id, outOfRange: false, correctsId: wrong.id as string, correctionReason: 'Misread the gauge' } });
      readings++;
    }
    if (t.runHours) {
      // PMS every 250 run hours, counted from the meter at its last PMS: DG 1 is nearly due, DG 2 has time.
      const last = rows[rows.length - 1].value as number;
      runAtPms.set(a.id, last - (a.name.startsWith('DG Set 1') ? 232 : 110));
    }
  }
  for (const [id, hours] of runAtPms) await prisma.asset.update({ where: { id }, data: { pmsEveryHours: 250, lastPmsHours: Math.round(hours * 10) / 10 } });

  // ---------- Saved monthly reports (as sent on the 1st) and today's reminders ----------
  const scope = await hospitalScope();
  for (let m = 6; m >= 1; m--) {
    const month = monthInTz(addMonths(parseDate(`${TODAY.slice(0, 7)}-01`), -m));
    const sentAt = new Date(zonedDayStart(isoDate(addMonths(parseDate(`${month}-01`), 1))).getTime() + 6.5 * HOUR);
    const data = await buildMonthlyReport(month, { name: 'BME Assets (automatic)', scope }, sentAt);
    await prisma.monthlyReport.create({ data: { month, data: data as unknown as Prisma.InputJsonValue, createdAt: sentAt } });
    if (m === 1) await prisma.notification.create({ data: { userId: hod.id, type: 'report', dueDate: parseDate(`${month}-01`), message: `The monthly report for ${month} is ready.`, createdAt: sentAt } });
  }
  await generateReminders(TODAY);
  // Fresh notices: new complaints for the teams, approvals for the HOD, fixed ones for the wards to close.
  const recent = await prisma.complaint.findMany({ where: { raisedAt: { gte: at(-2, 0) } }, include: { asset: true, trade: true, location: true } });
  for (const c of recent) {
    const team = c.register === 'facility' ? FAC_ENG : BIO_ENG;
    await prisma.notification.createMany({ data: [...team, 'hod'].map((k) => ({ userId: U(k).id, type: 'complaint', complaintId: c.id, assetId: c.assetId, message: `${c.urgent ? 'URGENT. ' : ''}New complaint ${c.complaintNo}: ${c.asset ? `${c.asset.assetCode} ${c.asset.name}` : `${c.trade?.name} · ${c.location?.name}`}: "${c.description.slice(0, 80)}"`, createdAt: c.raisedAt })) });
  }
  for (const c of await prisma.complaint.findMany({ where: { status: 'resolved' } })) {
    await prisma.notification.create({ data: { userId: c.raisedById, type: 'complaint', complaintId: c.id, assetId: c.assetId, message: `Complaint ${c.complaintNo} resolved: check it works, then close the complaint.`, createdAt: c.resolvedAt ?? NOW } });
  }
  await prisma.notification.createMany({ data: (await prisma.approvalRequest.findMany({ where: { status: 'pending' } })).map((r) => ({ userId: hod.id, type: 'approval', assetId: r.targetType === 'asset' ? r.targetId : null, message: `A ${r.type.replace(/_/g, ' ')} request is waiting for you`, createdAt: r.createdAt })) });
  // Older notices read, so the bell shows what is new.
  await prisma.notification.updateMany({ where: { createdAt: { lt: at(-3, 0) } }, data: { readAt: NOW } });

  // ---------- Sign-ins and settings changes for the audit log ----------
  for (let d = -45; d <= 0; d++) {
    for (const k of ['hod', 'ravi', 'kiran', 'neha', 'suresh', 'imran', 'anita', 'nicu', 'ot', 'er', 'ward']) {
      if (chance(k === 'hod' ? 0.85 : 0.65)) log(U(k).id, 'auth.login', 'user', U(k).id, at(d, between(7, 10)));
    }
  }
  log(U('super').id, 'settings.update', 'hospital_settings', settings.id, at(-HISTORY_DAYS - 10, 12), { facilityEnabled: true });
  log(hod.id, 'settings.update', 'hospital_settings', settings.id, at(-200, 16), { complaintCloseDays: 3, criticalDowntimeHours: 24 });
  for (let i = 0; i < audits.length; i += 2000) await prisma.auditLog.createMany({ data: audits.slice(i, i + 2000) });

  const counts = await Promise.all([prisma.asset.count(), prisma.pmsRecord.count(), prisma.complaint.count(), prisma.attachment.count()]);
  console.log(
    `Demo hospital ready in ${Math.round((Date.now() - t0) / 1000)} s: ${counts[0]} machines, ${pmsCount} PMS (${counts[1]} records), ${calCount} calibrations, ${counts[2]} complaints, ${expenses} expenses, ${contracts} contracts, ${serviceLogs} service visits, ${movements} stock movements, ${licences} licences, ${readings} readings, ${counts[3]} documents, ${audits.length} audit entries.`,
  );
  console.log(`Logins (password "${PASSWORD}"): ${USERS.map((u) => u.email).join(', ')}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
