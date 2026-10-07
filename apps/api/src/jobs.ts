import PgBoss from 'pg-boss';
import { config } from './lib/config';
import { todayISO } from './lib/dates';
import { generateReminders } from './modules/reminders/reminders.service';

const QUEUE = 'daily-reminders';

async function runReminders() {
  const result = await generateReminders(todayISO());
  console.log(`Reminders: ${result.created} created, ${result.emailed} emailed`);
}

// Daily at 06:00 hospital time. pg-boss keeps its own schedule in the database (schema "pgboss"), so
// it works the same on the demo and on-prem. It uses the direct connection: pooled connections in
// transaction mode (Supabase) break its advisory locks.
export async function startJobs() {
  const boss = new PgBoss(process.env.DIRECT_URL || process.env.DATABASE_URL!);
  boss.on('error', (e) => console.error('pg-boss:', e));
  await boss.start();
  await boss.createQueue(QUEUE);
  await boss.schedule(QUEUE, '0 6 * * *', {}, { tz: config.timezone });
  await boss.work(QUEUE, async () => {
    await runReminders();
  });
  // Catch up after downtime (a sleeping demo server, a restart over 06:00). Duplicates are impossible.
  runReminders().catch((e) => console.error('Startup reminders failed:', e));
  return boss;
}
