// Demo/install seed. Safe to re-run: setup data is upserted, assets are only created on an empty register.
import bcrypt from 'bcryptjs';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLE_LABELS, ROLE_NAMES, type RoleName } from '@bme/shared';
import { formatAssetCode } from './lib/assetCode';
import { addMonths } from './lib/dates';
import { prisma } from './lib/prisma';

const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo@1234';

const departments = [
  { name: 'Biomedical Engineering', code: 'BME' },
  { name: 'Intensive Care Unit', code: 'ICU' },
  { name: 'Radiology', code: 'RAD' },
];

const locations = [
  { dept: 'BME', name: 'Workshop', code: 'WKSP' },
  { dept: 'ICU', name: 'ICU 1', code: 'ICU1' },
  { dept: 'ICU', name: 'ICU 2', code: 'ICU2' },
  { dept: 'RAD', name: 'X-ray Room', code: 'XR1' },
];

const equipmentTypes = [
  { name: 'Ventilator', code: 'VENT', defaultPmsMonths: 3, defaultCalibrationMonths: 12 },
  { name: 'Patient Monitor', code: 'MON', defaultPmsMonths: 6, defaultCalibrationMonths: 12 },
  { name: 'Defibrillator', code: 'DEFIB', defaultPmsMonths: 3, defaultCalibrationMonths: 12 },
  { name: 'Infusion Pump', code: 'INFP', defaultPmsMonths: 6, defaultCalibrationMonths: 12 },
];

const users: Array<{ name: string; email: string; role: RoleName; dept?: string }> = [
  { name: 'Vendor Support', email: 'superadmin@demo.local', role: 'super_admin' },
  { name: 'Dr. Meera Shah (HOD)', email: 'admin@demo.local', role: 'admin' },
  { name: 'Ravi Patel', email: 'biomed@demo.local', role: 'biomed' },
  { name: 'Sister Anita Desai', email: 'nursing@demo.local', role: 'nursing', dept: 'ICU' },
];

// [type, name, make, model, dept, location, criticality]
const assets = [
  ['VENT', 'ICU Ventilator A', 'Drager', 'Evita V300', 'ICU', 'ICU1', 'critical'],
  ['VENT', 'ICU Ventilator B', 'Drager', 'Evita V300', 'ICU', 'ICU1', 'critical'],
  ['VENT', 'ICU Ventilator C', 'Hamilton', 'C1', 'ICU', 'ICU2', 'critical'],
  ['MON', 'Bedside Monitor 1', 'Philips', 'MX450', 'ICU', 'ICU1', 'high'],
  ['MON', 'Bedside Monitor 2', 'Philips', 'MX450', 'ICU', 'ICU2', 'high'],
  ['DEFIB', 'Defibrillator ICU', 'Zoll', 'R Series', 'ICU', 'ICU1', 'critical'],
  ['INFP', 'Infusion Pump 1', 'B. Braun', 'Infusomat', 'ICU', 'ICU2', 'medium'],
  ['INFP', 'Infusion Pump 2', 'B. Braun', 'Infusomat', 'ICU', 'ICU2', 'medium'],
  ['MON', 'Spare Monitor', 'Mindray', 'BeneVision N12', 'BME', 'WKSP', 'low'],
  ['DEFIB', 'Defibrillator Radiology', 'Philips', 'HeartStart XL+', 'RAD', 'XR1', 'high'],
] as const;

async function main() {
  const settings =
    (await prisma.hospitalSettings.findFirst()) ??
    (await prisma.hospitalSettings.create({ data: { name: 'Shalby Demo Hospital', shortCode: 'SHL' } }));

  for (const code of PERMISSIONS) {
    await prisma.permission.upsert({ where: { code }, update: {}, create: { code } });
  }

  for (const name of ROLE_NAMES) {
    const role = await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name, label: ROLE_LABELS[name] },
    });
    // Only seed a role's permissions the first time, so later per-hospital changes survive a re-seed.
    if ((await prisma.rolePermission.count({ where: { roleId: role.id } })) === 0) {
      const perms = await prisma.permission.findMany({ where: { code: { in: [...DEFAULT_ROLE_PERMISSIONS[name]] } } });
      await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    }
  }

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

  const typeByCode = new Map<string, { id: string; code: string }>();
  for (const t of equipmentTypes) {
    typeByCode.set(t.code, await prisma.equipmentType.upsert({ where: { code: t.code }, update: {}, create: t }));
  }

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

  if ((await prisma.asset.count()) === 0) {
    const today = new Date();
    for (const [typeCode, name, make, model, deptCode, locCode, criticality] of assets) {
      const type = typeByCode.get(typeCode)!;
      const updated = await prisma.hospitalSettings.update({
        where: { id: settings.id },
        data: { assetSeq: { increment: 1 }, patternLocked: true },
      });
      const monthsAgo = 6 + updated.assetSeq * 2;
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
          criticality,
          installationDate,
          warrantyMonths: 24,
          warrantyEnd: addMonths(installationDate, 24),
        },
      });
    }
  }

  console.log(`Seeded. Demo logins (password "${PASSWORD}"): ${users.map((u) => u.email).join(', ')}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
