// Server-side password reset, for when nobody can sign in (e.g. the only admin forgot theirs):
//   docker compose run --rm api node dist/resetPassword.js --email hod@hospital.in --password "a new password"
// Without --password a random one is generated and printed.
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from './lib/prisma';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  if (!email) {
    console.error('Usage: node dist/resetPassword.js --email someone@hospital.in [--password "new password"]');
    process.exit(2);
  }
  const password = arg('password') ?? randomBytes(9).toString('base64url');
  if (password.length < 8) {
    console.error('The password must be at least 8 characters.');
    process.exit(2);
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No user with the email ${email}.`);
    process.exit(1);
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 10), active: true } });
  // Recorded like everything else: an action done on the server itself, so no signed-in actor and no client address.
  await prisma.auditLog.create({ data: { actorId: null, action: 'user.password_reset_on_server', entityType: 'user', entityId: user.id } });
  console.log(`Password for ${user.name} <${email}> is now: ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
