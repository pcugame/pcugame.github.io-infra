import { spawnSync } from 'node:child_process';
import process from 'node:process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const steps = [
	[npm, ['run', 'testenv:up']],
	[npm, ['run', 'test:integration:orphan-renewal-timeout']],
	[npm, ['run', 'test:integration:canonical-processing-fences']],
	[npm, ['run', 'test:integration:import-transaction']],
	[npm, ['run', 'test:integration:idempotency']],
	[npm, ['run', 'test:integration:lease-clock-core']],
	[npm, ['run', 'test:integration:lifecycle-schema']],
	[npm, ['run', 'test:integration:responsive-image-migration']],
	[npm, ['run', 'test:integration:canonical-migration-chain']],
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
	if (exitCode === 0) {
		const smokeUrl = 'http://127.0.0.1:3904/public/images/integration/poster/original.png';
		const smoke = () => spawnSync(
			process.execPath,
			['server/smoke-data-plane.mjs', smokeUrl],
			{ stdio: 'inherit', env: { ...process.env, ALLOW_INSECURE_SMOKE: 'true' } },
		);
		let result = smoke();
		if (result.status !== 0) exitCode = result.status ?? 1;
		if (exitCode === 0) {
			result = spawnSync(docker, ['compose', '-f', 'docker-compose.integration.yml', 'stop', 'api'], { stdio: 'inherit' });
			if (result.status !== 0) exitCode = result.status ?? 1;
		}
		if (exitCode === 0) {
			result = smoke();
			if (result.status !== 0) exitCode = result.status ?? 1;
		}
		const restart = spawnSync(docker, ['compose', '-f', 'docker-compose.integration.yml', 'start', 'api'], { stdio: 'inherit' });
		if (exitCode === 0 && restart.status !== 0) exitCode = restart.status ?? 1;
		if (exitCode === 0) console.log('API-down public byte delivery smoke: OK');
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
