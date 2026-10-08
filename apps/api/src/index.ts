import { createApp } from './app';
import { ensureRolesAndPermissions } from './lib/baseData';
import { startJobs } from './jobs';

const port = Number(process.env.PORT ?? 4000);
createApp().listen(port, () => console.log(`API listening on port ${port}`));

// An upgrade can introduce new permission codes. This adds any that are missing and grants them to the roles that
// have them by default; codes that already exist (and any changes the hospital made to roles) are left alone.
ensureRolesAndPermissions().catch((e) => console.error('Could not update roles and permissions:', e));

// A job failure must never take the API down. DISABLE_JOBS=true turns the scheduler off (e.g. a second instance).
if (process.env.DISABLE_JOBS !== 'true') {
  startJobs().catch((e) => console.error('Could not start the reminder job:', e));
}
