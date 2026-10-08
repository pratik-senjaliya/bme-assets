// First install on a hospital server. Creates what a new install needs and NO demo data:
// the hospital profile, roles and permissions, the vendor's super admin and the hospital's first admin (HOD).
// Safe to run again: it refuses to touch an install that already has users.
//
//   node dist/bootstrap.js --hospital-name "Shalby Hospital" --code SHL --admin-email hod@hospital.in --admin-name "Dr. A. Shah"
//
// Options: --superadmin-email (default support@bme.local)  --admin-password / --superadmin-password (default: generated)
//          --starter-types  also add four equipment types (ventilator, patient monitor, defibrillator, infusion pump)
//                           with generic PMS checklists
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { ensureRolesAndPermissions, ensureStarterTypes } from './lib/baseData';
import { prisma } from './lib/prisma';

const args = (() => {
  const out: Record<string, string | true> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    out[argv[i].slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
})();

const input = z
  .object({
    'hospital-name': z.string().trim().min(2),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/, 'The hospital code is 2–10 letters or digits, e.g. SHL'),
    'admin-email': z.string().trim().toLowerCase().email(),
    'admin-name': z.string().trim().min(2).default('Biomedical HOD'),
    'superadmin-email': z.string().trim().toLowerCase().email().default('support@bme.local'),
    'admin-password': z.string().min(8).optional(),
    'superadmin-password': z.string().min(8).optional(),
    'starter-types': z.literal(true).optional(),
  })
  .safeParse(args);

if (!input.success) {
  console.error('Could not start: ' + input.error.issues.map((i) => `--${i.path.join('.')}: ${i.message}`).join('; '));
  console.error('Example: node dist/bootstrap.js --hospital-name "Shalby Hospital" --code SHL --admin-email hod@hospital.in --admin-name "Dr. A. Shah"');
  process.exit(2);
}
const o = input.data;
const generated = () => randomBytes(9).toString('base64url'); // 12 characters, no look-alike punctuation

async function main() {
  if ((await prisma.user.count()) > 0) {
    console.error('This install already has users, so nothing was changed. (Bootstrap is for the first install only.)');
    process.exit(1);
  }
  await ensureRolesAndPermissions();

  if (!(await prisma.hospitalSettings.findFirst())) {
    await prisma.hospitalSettings.create({ data: { name: o['hospital-name'], shortCode: o.code } });
  } else {
    await prisma.hospitalSettings.updateMany({ data: { name: o['hospital-name'], shortCode: o.code } });
  }

  const people = [
    { role: 'super_admin' as const, name: 'Vendor Support', email: o['superadmin-email'], password: o['superadmin-password'] },
    { role: 'admin' as const, name: o['admin-name'], email: o['admin-email'], password: o['admin-password'] },
  ].map((p) => ({ ...p, shown: p.password ?? generated() }));

  for (const p of people) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: p.role } });
    await prisma.user.create({ data: { name: p.name, email: p.email, passwordHash: await bcrypt.hash(p.shown, 10), roleId: role.id } });
  }
  if (o['starter-types']) await ensureStarterTypes();

  console.log(`\nInstalled ${o['hospital-name']} (${o.code}).\n`);
  console.log('Sign-in details. Passwords are shown once and are not stored anywhere readable:\n');
  for (const p of people) console.log(`  ${p.role === 'admin' ? 'Admin (HOD)  ' : 'Super admin  '} ${p.email}   ${p.shown}`);
  console.log('\nSign in as the admin and change these passwords (Admin > Users). Then add departments, locations and equipment types.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
