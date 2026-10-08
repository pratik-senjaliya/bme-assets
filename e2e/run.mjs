// Runs the whole browser suite against a running install (web on :3000, API on :4000, seeded database).
//   npm run e2e            everything
//   npm run e2e -- fixes   one script (core, flows, ops, checklists, misc, fixes, journeys, a11y)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Order matters: flows continues with the equipment that core creates.
const all = ['core', 'flows', 'ops', 'checklists', 'misc', 'fixes', 'journeys', 'a11y'];
const only = process.argv.slice(2).filter((a) => all.includes(a));
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', cwd: path.join(here, '..') }).status ?? 1;
const cleanup = () => run('npx', ['tsx', '--env-file=apps/api/.env', 'e2e/cleanup.mts']);

cleanup();
let failed = [];
for (const name of only.length ? only : all) {
  console.log(`\n===== ${name} =====`);
  if (run('node', [`e2e/${name}.mjs`]) !== 0) failed.push(name);
}
cleanup();
console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : '\nAll browser checks passed.');
process.exit(failed.length ? 1 : 0);
