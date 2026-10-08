import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLE_LABELS, ROLE_NAMES, type RoleName } from '@bme/shared';
import { prisma } from './prisma';

// Roles and permission codes. Used by the demo seed and by the first-install bootstrap.
export async function ensureRolesAndPermissions() {
  for (const name of ROLE_NAMES) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name, label: ROLE_LABELS[name] } });
  }
  const roleIds = new Map((await prisma.role.findMany()).map((r) => [r.name as RoleName, r.id]));

  // A permission code seen for the first time is created and granted to the roles that have it by
  // default. Codes that already exist are left alone, so a hospital's later changes survive a re-seed
  // and upgrades pick up new codes (e.g. notification.view) without a manual step.
  for (const code of PERMISSIONS) {
    if (await prisma.permission.findUnique({ where: { code } })) continue;
    const permission = await prisma.permission.create({ data: { code } });
    const grants = ROLE_NAMES.filter((n) => DEFAULT_ROLE_PERMISSIONS[n].includes(code)).map((n) => ({ roleId: roleIds.get(n)!, permissionId: permission.id }));
    await prisma.rolePermission.createMany({ data: grants, skipDuplicates: true });
  }
}

// Starter equipment types, each with a generic PMS checklist (replace them with the hospital's own formats).
export const STARTER_TYPES = [
  { name: 'Ventilator', code: 'VENT', defaultPmsMonths: 3, defaultCalibrationMonths: 12 },
  { name: 'Patient Monitor', code: 'MON', defaultPmsMonths: 6, defaultCalibrationMonths: 12 },
  { name: 'Defibrillator', code: 'DEFIB', defaultPmsMonths: 3, defaultCalibrationMonths: 12 },
  { name: 'Infusion Pump', code: 'INFP', defaultPmsMonths: 6, defaultCalibrationMonths: 12 },
];


type Item = { id: string; label: string; type: 'check' | 'reading' | 'text'; unit?: string; min?: number; max?: number; required: boolean };
const check = (id: string, label: string): Item => ({ id, label, type: 'check', required: true });
const reading = (id: string, label: string, unit: string, min: number, max: number): Item => ({ id, label, type: 'reading', unit, min, max, required: true });
const remarks: Item = { id: 'remarks', label: 'Remarks', type: 'text', required: false };

const PMS_TEMPLATES: Record<string, Item[]> = {
  VENT: [
    check('visual', 'Visual inspection: casing, display, cables, no damage'),
    check('power', 'Power cord, plug and mains indicator'),
    check('circuit', 'Breathing circuit, filters and humidifier connections'),
    check('alarms', 'Alarms (high pressure, low pressure, apnoea, power failure) work'),
    check('battery', 'Battery backup works'),
    reading('tidal', 'Delivered tidal volume at 500 ml setting', 'ml', 475, 525),
    reading('oxygen', 'Oxygen concentration at 100% setting', '%', 95, 105),
    remarks,
  ],
  MON: [
    check('visual', 'Visual inspection: casing, display, cables, no damage'),
    check('leads', 'ECG leads and SpO2 / NIBP accessories in good condition'),
    reading('spo2', 'SpO2 reading against simulator (98%)', '%', 96, 100),
    reading('nibp', 'NIBP systolic against simulator (120 mmHg)', 'mmHg', 115, 125),
    check('alarms', 'Alarms work and are audible'),
    check('battery', 'Battery backup works'),
    remarks,
  ],
  DEFIB: [
    check('visual', 'Visual inspection: casing, display, cables, no damage'),
    check('selftest', 'Self-test passes'),
    check('pads', 'Pads / paddles and cables in good condition, not expired'),
    reading('charge', 'Charge time to 200 J', 's', 0, 10),
    reading('energy', 'Delivered energy at 200 J setting', 'J', 180, 220),
    check('battery', 'Battery backup works'),
    remarks,
  ],
  INFP: [
    check('visual', 'Visual inspection: casing, display, door, no damage'),
    check('occlusion', 'Occlusion alarm works'),
    check('air', 'Air-in-line alarm works'),
    reading('flow', 'Flow accuracy at 100 ml/h', 'ml/h', 95, 105),
    check('battery', 'Battery backup works'),
    remarks,
  ],
};


export async function ensureStarterTypes() {
  for (const t of STARTER_TYPES) {
    const type = await prisma.equipmentType.upsert({ where: { code: t.code }, update: {}, create: t });
    if ((await prisma.pmsTemplate.count({ where: { equipmentTypeId: type.id } })) === 0) {
      await prisma.pmsTemplate.create({ data: { equipmentTypeId: type.id, version: 1, schema: { items: PMS_TEMPLATES[t.code] } } });
    }
  }
}
