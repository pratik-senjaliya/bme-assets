// Demo/install seed. Safe to re-run: setup data is upserted, assets are only created on an empty register.
import bcrypt from 'bcryptjs';
import type { Criticality, RoleName } from '@bme/shared';
import { formatAssetCode } from './lib/assetCode';
import { ensureRolesAndPermissions, ensureStarterTrades, ensureStarterTypes } from './lib/baseData';
import { addDaysISO, addMonths, parseDate, todayISO } from './lib/dates';
import { prisma } from './lib/prisma';

const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo@1234';

const departments = [
  { name: 'Biomedical Engineering', code: 'BME' },
  { name: 'Intensive Care Unit', code: 'ICU' },
  { name: 'Radiology', code: 'RAD' },
  { name: 'Engineering Services', code: 'ENG' },
];

const locations = [
  { dept: 'BME', name: 'Workshop', code: 'WKSP' },
  { dept: 'ICU', name: 'ICU 1', code: 'ICU1' },
  { dept: 'ICU', name: 'ICU 2', code: 'ICU2' },
  { dept: 'RAD', name: 'X-ray Room', code: 'XR1' },
  { dept: 'ENG', name: 'DG Room', code: 'DGR' },
  { dept: 'ENG', name: 'Plant Room', code: 'PLNT' },
  { dept: 'ENG', name: 'Main Block', code: 'MAIN' },
];

const users: Array<{ name: string; email: string; role: RoleName; dept?: string }> = [
  { name: 'Vendor Support', email: 'superadmin@demo.local', role: 'super_admin' },
  { name: 'Dr. Meera Shah (HOD)', email: 'admin@demo.local', role: 'admin' },
  { name: 'Ravi Patel', email: 'biomed@demo.local', role: 'biomed' },
  { name: 'Suresh Mehta', email: 'maintenance@demo.local', role: 'maintenance' },
  { name: 'Sister Anita Desai', email: 'nursing@demo.local', role: 'nursing', dept: 'ICU' },
];

// [type, name, make, model, dept, location, criticality]
const assets = [
  ['VENT', 'ICU Ventilator A', 'Drager', 'Evita V300', 'ICU', 'ICU1', 'most_critical'],
  ['VENT', 'ICU Ventilator B', 'Drager', 'Evita V300', 'ICU', 'ICU1', 'most_critical'],
  ['VENT', 'ICU Ventilator C', 'Hamilton', 'C1', 'ICU', 'ICU2', 'most_critical'],
  ['MON', 'Bedside Monitor 1', 'Philips', 'MX450', 'ICU', 'ICU1', 'critical'],
  ['MON', 'Bedside Monitor 2', 'Philips', 'MX450', 'ICU', 'ICU2', 'critical'],
  ['DEFIB', 'Defibrillator ICU', 'Zoll', 'R Series', 'ICU', 'ICU1', 'most_critical'],
  ['INFP', 'Infusion Pump 1', 'B. Braun', 'Infusomat', 'ICU', 'ICU2', 'minor'],
  ['INFP', 'Infusion Pump 2', 'B. Braun', 'Infusomat', 'ICU', 'ICU2', 'minor'],
  ['MON', 'Spare Monitor', 'Mindray', 'BeneVision N12', 'BME', 'WKSP', 'general'],
  ['DEFIB', 'Defibrillator Radiology', 'Philips', 'HeartStart XL+', 'RAD', 'XR1', 'critical'],
] as const;

// Facility equipment for the maintenance add-on (docs/requirements-facility.md), added once and with the add-on on.
const facilityAssets = [
  ['DG', 'DG Set 1 (500 kVA)', 'Cummins', 'C500D5', 'ENG', 'DGR', 'most_critical'],
  ['CHLR', 'Chiller 1', 'Carrier', '30XW', 'ENG', 'PLNT', 'critical'],
  ['AHU', 'AHU ICU', 'Blue Star', 'DSA 15', 'ICU', 'ICU1', 'critical'],
  ['UPS', 'UPS ICU (20 kVA)', 'APC', 'Galaxy VS', 'ICU', 'ICU2', 'most_critical'],
  ['LIFT', 'Bed Lift 1', 'Otis', 'Gen2', 'ENG', 'MAIN', 'critical'],
  ['RO', 'RO Plant (Dialysis)', 'Ion Exchange', 'RO 500', 'ENG', 'PLNT', 'minor'],
] as const;


async function main() {
  const settings =
    (await prisma.hospitalSettings.findFirst()) ??
    (await prisma.hospitalSettings.create({ data: { name: 'Shalby Demo Hospital', shortCode: 'SHL' } }));

  await ensureRolesAndPermissions();

  const deptByCode = new Map<string, { id: string; code: string }>();
  for (const d of departments) {
    deptByCode.set(d.code, await prisma.department.upsert({ where: { code: d.code }, update: {}, create: d }));
  }

  const locByCode = new Map<string, { id: string; code: string }>();
  for (const l of locations) {
    const departmentId = deptByCode.get(l.dept)!.id;
    locByCode.set(
      l.code,
      await prisma.location.upsert({
        where: { departmentId_name: { departmentId, name: l.name } },
        update: {},
        create: { departmentId, name: l.name, code: l.code },
      }),
    );
  }

  await ensureStarterTypes();
  const typeByCode = new Map((await prisma.equipmentType.findMany()).map((t) => [t.code, t]));

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  for (const u of users) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: u.role } });
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        name: u.name,
        email: u.email,
        passwordHash,
        roleId: role.id,
        departmentId: u.dept ? deptByCode.get(u.dept)!.id : null,
      },
    });
  }

  const addAssets = async (rows: ReadonlyArray<readonly [string, string, string, string, string, string, string]>) => {
    const today = new Date();
    for (const [typeCode, name, make, model, deptCode, locCode, criticality] of rows) {
      const type = typeByCode.get(typeCode)!;
      const updated = await prisma.hospitalSettings.update({
        where: { id: settings.id },
        data: { assetSeq: { increment: 1 }, patternLocked: true },
      });
      // Installed 1-11 months ago, so a fresh demo shows a mix of overdue, due-soon and fine PMS/calibration.
      const monthsAgo = 1 + ((updated.assetSeq * 3) % 11);
      const installationDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsAgo, 1));
      await prisma.asset.create({
        data: {
          assetCode: formatAssetCode(updated.assetIdPattern, {
            hosp: updated.shortCode,
            dept: deptCode,
            type: typeCode,
            loc: locCode,
            seq: updated.assetSeq,
          }),
          sequenceNo: updated.assetSeq,
          equipmentTypeId: type.id,
          name,
          make,
          model,
          serialNo: `SN-${typeCode}-${String(updated.assetSeq).padStart(4, '0')}`,
          departmentId: deptByCode.get(deptCode)!.id,
          locationId: locByCode.get(locCode)!.id,
          criticality: criticality as Criticality,
          register: type.register,
          installationDate,
          warrantyMonths: 24,
          warrantyEnd: addMonths(installationDate, 24),
        },
      });
    }
  };
  if ((await prisma.asset.count()) === 0) await addAssets(assets);
  if ((await prisma.asset.count({ where: { register: 'facility' } })) === 0) {
    await addAssets(facilityAssets);
    await prisma.hospitalSettings.update({ where: { id: settings.id }, data: { facilityEnabled: true } });
  }
  await ensureStarterTrades(); // what ward faults without a machine are about (once)

  // A few statutory licences (F3), once: one ending soon, one expired, one site-wide and valid.
  if ((await prisma.licence.count()) === 0) {
    const day = (n: number) => parseDate(addDaysISO(todayISO(), n));
    const lift = await prisma.asset.findFirst({ where: { equipmentType: { code: 'LIFT' } } });
    const dg = await prisma.asset.findFirst({ where: { equipmentType: { code: 'DG' } } });
    await prisma.licence.createMany({
      data: [
        ...(lift ? [{ kind: 'lift', name: `Lift licence, ${lift.name}`, authority: 'Lift Inspector, Ahmedabad', number: 'LIC/LIFT/2025/118', validFrom: day(-345), validTo: day(20), assetId: lift.id, register: lift.register }] : []),
        ...(dg ? [{ kind: 'dg_pollution', name: `Consent to operate, ${dg.name}`, authority: 'Gujarat Pollution Control Board', number: 'GPCB/DG/4471', validFrom: day(-370), validTo: day(-5), assetId: dg.id, register: dg.register }] : []),
        { kind: 'fire_noc', name: 'Fire NOC, main building', authority: 'Chief Fire Officer', number: 'FIRE/NOC/2026/0921', validFrom: day(-60), validTo: day(305), register: 'facility' as const },
      ],
    });
  }

  // Give equipment that has no due dates yet its first ones, counted from installation.
  const needDates = await prisma.asset.findMany({
    where: { installationDate: { not: null }, OR: [{ nextPmsDue: null }, { nextCalibrationDue: null }] },
    include: { equipmentType: true },
  });
  for (const a of needDates) {
    const pmsMonths = a.pmsFrequencyMonths ?? a.equipmentType.defaultPmsMonths;
    const calMonths = a.equipmentType.defaultCalibrationMonths;
    await prisma.asset.update({
      where: { id: a.id },
      data: {
        ...(a.nextPmsDue === null && pmsMonths ? { nextPmsDue: addMonths(a.installationDate!, pmsMonths), pmsFrequencyMonths: pmsMonths } : {}),
        ...(a.nextCalibrationDue === null && calMonths ? { nextCalibrationDue: addMonths(a.installationDate!, calMonths) } : {}),
      },
    });
  }

  console.log(`Seeded. Demo logins (password "${PASSWORD}"): ${users.map((u) => u.email).join(', ')}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
