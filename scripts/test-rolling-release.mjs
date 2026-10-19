import { spawnSync } from 'node:child_process';
const project = `pcu-rolling-test-${process.pid}`;
const compose = ['compose', '-p', project, '-f', 'server/rolling-services.compose.yml'];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  return result.stdout?.trim();
}
// The integration CI job may have built contracts only inside its API container.
run('npm', ['run', 'build', '-w', '@pcu/contracts']);
try {
  run('docker', [...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '120']);
  const port = (service, internal) => run('docker', [...compose, 'port', service, internal], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).split(':').at(-1);
  run('npm', ['exec', '-w', 'apps/api', '--', 'vitest', 'run', 'src/__tests__/rolling-release.garage.postgres.test.ts'], {
    env: { ...process.env, RUN_ROLLING_INTEGRATION: 'true',
      ROLLING_DATABASE_URL: `postgresql://rolling_test:rolling_test@127.0.0.1:${port('postgres', '5432')}/rolling_test`,
      ROLLING_S3_ENDPOINT: `http://127.0.0.1:${port('garage', '3900')}`,
      ROLLING_S3_WEB: `http://127.0.0.1:${port('garage', '3902')}`,
    },
  });
} finally {
  run('docker', [...compose, 'down', '-v', '--remove-orphans']);
}
