import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const serverTests = readdirSync(new URL('../server/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => `server/${name}`);
if (serverTests.length === 0) throw new Error('No release control tests found');

// Only repository policy tests and temporary shell doubles run here. The live
// Quadlet lifecycle test and database/service integration belong to other gates.
const checks = [
  [process.execPath, ['--test', 'scripts/check-migration-policy.test.mjs', ...serverTests]],
  ['python3', ['server/quadlet/wait-network-ready.test.py']],
  ['python3', ['server/quadlet/check-installed.test.py']],
  ['python3', ['server/quadlet/parity.test.py']],
  ['python3', ['server/quadlet/deploy.test.py']],
  ['python3', ['server/quadlet/runtime-env-check.test.py']],
];

for (const [command, args] of checks) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.signal) console.error(`${command} terminated by ${result.signal}`);
    process.exit(result.status ?? 1);
  }
}
