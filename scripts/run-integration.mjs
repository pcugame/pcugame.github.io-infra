import { spawnSync } from 'node:child_process';
import process from 'node:process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const steps = [
	// The aggregate owns an isolated Compose environment. Always remove its
	// named volumes before seeding so a previous targeted PG run cannot leak
	// out-of-contract fixtures into the HTTP smoke or E2E phases.
	[npm, ['run', 'testenv:reset']],
	// The smoke intentionally exercises the real processing containers. Stop
	// them before repository-level PostgreSQL tests create claimable fixtures;
	// otherwise the independently polling workers can consume a test row before
	// its explicit lock barrier and make the aggregate nondeterministic.
	[docker, ['compose', '-f', 'docker-compose.integration.yml', 'stop', 'validation-worker', 'export-worker']],
	[npm, ['run', 'test:integration:orphan-durability']],
	[npm, ['run', 'test:integration:orphan-renewal-timeout']],
	[npm, ['run', 'test:integration:asset-concurrency']],
	[npm, ['run', 'test:integration:year-concurrency']],
	[npm, ['run', 'test:integration:import-transaction']],
	[npm, ['run', 'test:integration:game-upload']],
	[npm, ['run', 'test:integration:game-upload-races']],
	[npm, ['run', 'test:integration:idempotency']],
	[npm, ['run', 'test:integration:lease-clock-core']],
	[npm, ['run', 'test:integration:lifecycle-schema']],
	[npm, ['run', 'test:integration:direct-multipart']],
	[npm, ['run', 'test:integration:direct-control-plane']],
	[npm, ['run', 'test:integration:responsive-image-migration']],
	[npm, ['run', 'test:integration:game-upload-cutover-migration']],
	[npm, ['run', 'test:integration:export-worker']],
	[npm, ['run', 'test:integration:storage-recovery']],
	[npm, ['run', 'test:integration:responsive-images']],
	// The internal-network smoke needs the validation worker, but Compose must
	// not traverse Web/API dependencies and rerun the one-shot Garage bootstrap
	// while requests are in flight. Start only the existing worker container,
	// wait for its healthcheck, then run the probe without dependency mutation.
	[docker, ['compose', '-f', 'docker-compose.integration.yml', 'up', '-d', '--no-deps', '--wait', 'validation-worker']],
	[docker, ['compose', '-f', 'docker-compose.integration.yml', '--profile', 'e2e', 'run', '--rm', '--no-deps', 'e2e']],
	[process.execPath, ['apps/api/scripts/check-direct-put-api-down.mjs']],
	[process.execPath, ['scripts/check-public-origin-api-down.mjs']],
];

let exitCode = 0;
try {
	for (const [command, args] of steps) {
		const result = spawnSync(command, args, { stdio: 'inherit' });
		if (result.status !== 0) {
			exitCode = result.status ?? 1;
			break;
		}
	}
} finally {
	const cleanup = spawnSync(
		docker,
		['compose', '-f', 'docker-compose.integration.yml', 'down', '--remove-orphans'],
		{ stdio: 'inherit' },
	);
	if (exitCode === 0 && cleanup.status !== 0) exitCode = cleanup.status ?? 1;
}

process.exitCode = exitCode;
