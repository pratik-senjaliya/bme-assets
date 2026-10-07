import { createApp } from './app';
import { startJobs } from './jobs';

const port = Number(process.env.PORT ?? 4000);
createApp().listen(port, () => console.log(`API listening on port ${port}`));

// A job failure must never take the API down. DISABLE_JOBS=true turns the scheduler off (e.g. a second instance).
if (process.env.DISABLE_JOBS !== 'true') {
  startJobs().catch((e) => console.error('Could not start the reminder job:', e));
}
