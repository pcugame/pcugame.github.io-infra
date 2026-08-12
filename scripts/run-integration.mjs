import { spawnSync } from 'node:child_process';
import process from 'node:process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const steps = [
	[npm, ['run', 'testenv:up']],
	[npm, ['run', 'test:integration:orphan-durability']],
	[npm, ['run', 'test:integration:asset-concurrency']],
	[npm, ['run', 'test:integration:year-concurrency']],
	[npm, ['run', 'test:integration:import-transaction']],
	[npm, ['run', 'test:integration:game-upload']],
	[npm, ['run', 'test:integration:idempotency']],
	[npm, ['run', 'test:integration:lifecycle-schema']],
	[npm, ['run', 'test:integration:storage-recovery']],
	[npm, ['run', 'test:integration:responsive-images']],
	[docker, ['compose', '-f', 'docker-compose.integration.yml', '--profile', 'e2e', 'run', '--rm', 'e2e']],
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
