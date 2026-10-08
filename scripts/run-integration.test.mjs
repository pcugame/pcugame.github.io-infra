import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runIntegration } from './run-integration.mjs';

// File selections and parallelism captured from the previous root commands.
const expectedSuites = {
 voting: ['src/__tests__/voting.postgres.test.ts'],
	'orphan-renewal-timeout': [
		'src/__tests__/orphan-renewal-timeout.postgres.test.ts'
	],
	'canonical-processing-fences': [
		'src/__tests__/image-pointer-fence.postgres.test.ts'
	],
	'import-transaction': [
		'src/__tests__/import-transaction.postgres.test.ts'
	],
	'idempotency': [
		'src/__tests__/idempotency.postgres.test.ts'
	],
	'lease-clock-core': [
		'src/__tests__/lease-clock.postgres.test.ts'
	],
	'lease-clock': [
		'--no-file-parallelism',
		'src/__tests__/lease-clock.postgres.test.ts',
		'src/__tests__/orphan-renewal-timeout.postgres.test.ts'
	],
	'lifecycle-schema': [
		'src/__tests__/upload-lifecycle-schema.postgres.test.ts'
	],
	'responsive-image-migration': [
		'src/__tests__/responsive-image-migration.postgres.test.ts'
	],
	'project-video-order-migration': [
		'src/__tests__/project-video-order-expand.postgres.test.ts'
	],
	'canonical-migration-chain': [
		'src/__tests__/canonical-migration-chain.garage.postgres.test.ts',
		'src/__tests__/webgl-deletion-lifecycle.garage.postgres.test.ts'
	],
	'project-assets': [
		'src/__tests__/project-materials.postgres.test.ts',
		'src/modules/migration/canonical-correction.postgres.test.ts',
		'src/__tests__/project-video-order-expand.postgres.test.ts',
		'src/__tests__/project-video-order.postgres.test.ts',
		'src/__tests__/project-video-upload.postgres.test.ts'
	],
	'admin-project-search': [
		'src/__tests__/admin-project-search.postgres.test.ts'
	],
	'banned-ips': [
		'src/__tests__/banned-ip.integration.test.ts'
	],
	'phase2-transition': [
		'--no-file-parallelism',
		'src/__tests__/canonical-asset-contract-schema.postgres.test.ts',
		'src/__tests__/project-submission.postgres.test.ts',
		'src/__tests__/faculty-management-http.postgres.test.ts',
		'src/__tests__/phase2-project-http.postgres.test.ts',
		'src/__tests__/contract-age-exception.postgres.test.ts',
		'src/__tests__/contract-image-bridge36.postgres.test.ts',
		'src/__tests__/contract-image-bridge-traffic.postgres.test.ts'
	],
	'year-change-approval': [
		'--no-file-parallelism',
		'src/modules/project-change/repository.postgres.test.ts',
		'src/modules/project-change/transfer-review.postgres.test.ts',
		'src/__tests__/project-year-policy.postgres.test.ts',
		'src/__tests__/project-year-http.postgres.test.ts'
	],
	'visibility': [
		'src/__tests__/visibility-http.postgres.test.ts',
		'src/__tests__/visibility-rollback.postgres.test.ts',
		'src/__tests__/file-access.postgres.test.ts',
		'src/__tests__/webgl-play.postgres.test.ts',
		'src/__tests__/webgl-network.postgres.test.ts'
	],
	'visibility-gateway': [
		'src/__tests__/visibility-gateway.garage.postgres.test.ts'
	],
	'webgl-display': [
		'src/__tests__/webgl-display-http.postgres.test.ts'
	]
};


const postgresEnv = {
	RUN_POSTGRES_INTEGRATION: 'true',
	DATABASE_URL: 'postgresql://pcu_admin:integration@127.0.0.1:15432/pcu_graduationproject_v2?schema=public',
};
const garageEnv = {
	RUN_GARAGE_INTEGRATION: 'true',
	S3_ENDPOINT: 'http://127.0.0.1:3900',
	S3_REGION: 'garage',
	S3_ACCESS_KEY_ID: 'GK000000000000000000000001',
	S3_SECRET_ACCESS_KEY: '0000000000000000000000000000000000000000000000000000000000000001',
	S3_BUCKET_PUBLIC: 'pcu-public',
	S3_BUCKET_PROTECTED: 'pcu-protected',
};
const inheritedEnv = {
	KEEP_INHERITED: 'yes',
	RUN_POSTGRES_INTEGRATION: 'false',
	DATABASE_URL: 'postgresql://other/database',
	RUN_GARAGE_INTEGRATION: 'false',
	RUN_GATEWAY_INTEGRATION: 'false',
	...Object.fromEntries(Object.keys(garageEnv).filter(key => key.startsWith('S3_')).map(key => [key, 'inherited'])),
};
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const fullOrder = [
	'voting', 'orphan-renewal-timeout', 'canonical-processing-fences', 'import-transaction',
	'idempotency', 'lease-clock-core', 'lifecycle-schema', 'responsive-image-migration',
	'canonical-migration-chain', 'project-assets', 'admin-project-search', 'banned-ips',
	'phase2-transition', 'year-change-approval', 'webgl-display', 'visibility', 'visibility-gateway',
];
const e2eArgs = ['compose', '-f', 'docker-compose.integration.yml', '--profile', 'e2e', 'run', '--rm', 'e2e'];
const cleanupArgs = ['compose', '-f', 'docker-compose.integration.yml', 'down', '--remove-orphans'];
const suiteArgs = name => ['exec', '-w', 'apps/api', '--', 'vitest', 'run', ...expectedSuites[name]];

for (const [name] of Object.entries(expectedSuites)) {
	test(`suite ${name} preserves files, parallelism, and environment without managing services`, async () => {
		const calls = [];
		const status = await runIntegration(['--suite', name], {
			env: inheritedEnv,
			spawn: (...args) => { calls.push(args); return { status: 0 }; },
		});
		assert.equal(status, 0);
		assert.equal(calls.length, 1);
		const expectedEnv = { ...inheritedEnv, ...postgresEnv };
		if (name === 'canonical-migration-chain') Object.assign(expectedEnv, garageEnv);
		if (name === 'visibility-gateway') Object.assign(expectedEnv, { RUN_GARAGE_INTEGRATION: 'true', RUN_GATEWAY_INTEGRATION: 'true' });
		assert.deepEqual(calls[0], [npm, suiteArgs(name), { stdio: 'inherit', env: expectedEnv }]);
		assert.deepEqual(inheritedEnv.DATABASE_URL, 'postgresql://other/database');
	});
}

test('invalid arguments reject before subprocesses or cleanup', async () => {
	for (const args of [
		['--suite'], ['--suite', 'unknown'], ['--suite', 'toString'],
		['--suite', 'visibility', 'lease-clock'], ['--list', 'extra'],
		['--help', 'extra'], ['visibility'], ['--unknown'],
	]) {
		let effects = 0;
		await assert.rejects(runIntegration(args, { spawn: () => { effects++; return { status: 0 }; } }), /Expected|Unknown|Unexpected/);
		assert.equal(effects, 0);
	}
});

test('list and help are read-only and expose all suites and entry points', async () => {
	for (const flag of ['--list', '--help', '-h']) {
		const output = [];
		assert.equal(await runIntegration([flag], {
			log: text => output.push(text),
			spawn: () => assert.fail('read-only command spawned a process'),
		}), 0);
		if (flag === '--list') assert.deepEqual(output[0].split('\n'), Object.keys(expectedSuites));
		else {
			assert.match(output[0], /npm run test:integration:suite -- <name>/);
			assert.match(output[0], /npm run test:integration:list/);
		}
	}
});

test('full run preserves startup, all 17 ordered suites, E2E, smokes, and cleanup', async () => {
	const calls = [];
	const spawn = (...args) => { calls.push(args); return { status: 0 }; };
	const status = await runIntegration([], {
		spawn,
		gatewaySmokes: async passedSpawn => { assert.equal(passedSpawn, spawn); calls.push(['smokes']); return 0; },
	});
	assert.equal(status, 0);
	assert.deepEqual(calls.map(([command, args]) => [command, args]), [
		[npm, ['run', 'testenv:up']],
		...fullOrder.map(name => [npm, suiteArgs(name)]),
		[docker, e2eArgs], ['smokes', undefined], [docker, cleanupArgs],
	]);
});

for (const failedStep of [0, 1, 9, 17]) {
	test(`full subprocess failure at step ${failedStep} stops execution and always cleans up`, async () => {
		const calls = [];
		const status = await runIntegration([], {
			spawn: (command, args) => { calls.push([command, args]); return { status: calls.length === failedStep + 1 ? 7 : 0 }; },
			gatewaySmokes: () => assert.fail('smokes should not run after failure'),
		});
		assert.equal(status, 7);
		assert.equal(calls.length, failedStep + 2);
		assert.deepEqual(calls.at(-1), [docker, cleanupArgs]);
	});
}

test('suite propagates failure and treats spawn errors or signals as failure without cleanup', async () => {
	for (const result of [{ status: 8 }, { status: null, signal: 'SIGTERM' }, { status: null, error: new Error('ENOENT') }]) {
		let calls = 0;
		const status = await runIntegration(['--suite', 'lease-clock'], {
			spawn: () => { calls++; return result; },
		});
		assert.equal(status, result.status ?? 1);
		assert.equal(calls, 1);
	}
});

test('full run cleans up after thrown subprocess or smoke errors', async () => {
	for (const source of ['spawn', 'smokes']) {
		const calls = [];
		await assert.rejects(runIntegration([], {
			spawn: (command, args) => {
				calls.push([command, args]);
				if (source === 'spawn' && calls.length === 2) throw new Error('spawn failure');
				return { status: 0 };
			},
			gatewaySmokes: async () => { throw new Error('smoke failure'); },
		}), /failure/);
		assert.deepEqual(calls.at(-1), [docker, cleanupArgs]);
	}
});

test('cleanup failure fails success but preserves an earlier failure', async () => {
	for (const smokeStatus of [0, 5]) {
		assert.equal(await runIntegration([], {
			spawn: (_command, args) => ({ status: args.includes('down') ? 9 : 0 }),
			gatewaySmokes: async () => smokeStatus,
		}), smokeStatus || 9);
	}
});

test('root entry points and real CLI reject missing suite without starting services', () => {
	const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.deepEqual(Object.keys(scripts).filter(name => name.startsWith('test:integration')), [
		'test:integration', 'test:integration:suite', 'test:integration:list',
	]);
	assert.equal(scripts['test:integration'], 'node scripts/run-integration.mjs');
	assert.equal(scripts['test:integration:suite'], 'node scripts/run-integration.mjs --suite');
	assert.equal(scripts['test:integration:list'], 'node scripts/run-integration.mjs --list');
	const runner = new URL('./run-integration.mjs', import.meta.url);
	const result = spawnSync(process.execPath, [runner.pathname, '--suite'], { encoding: 'utf8' });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Expected exactly one suite name/);
	assert.match(result.stderr, /Usage:/);
	const list = spawnSync(process.execPath, [runner.pathname, '--list'], { encoding: 'utf8' });
	assert.equal(list.status, 0);
	assert.deepEqual(list.stdout.trim().split('\n'), Object.keys(expectedSuites));
});
