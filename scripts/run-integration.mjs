import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

async function acquireProtectedCapability() {
	const projectResponse = await fetch(
		'http://127.0.0.1:4000/api/public/projects/integration-public-asset',
	);
	if (!projectResponse.ok) throw new Error(`protected smoke project returned ${projectResponse.status}`);
	const project = await projectResponse.json();
	const route = project?.data?.gameDownloadUrl;
	if (typeof route !== 'string') throw new Error('protected smoke project has no game download route');
	const routeUrl = new URL(route);
	routeUrl.hostname = '127.0.0.1';
	const redirect = await fetch(routeUrl, { redirect: 'manual' });
	const capability = redirect.headers.get('location');
	if (redirect.status !== 302 || !capability) {
		throw new Error(`protected capability issuance returned ${redirect.status}`);
	}
	const signed = new URL(capability);
	if (signed.origin !== 'http://localhost:3906') {
		throw new Error(`protected capability used unexpected origin ${signed.origin}`);
	}
	if (!/^\/file\/[a-f0-9]{64}$/.test(signed.pathname)) throw new Error('protected grant is not an opaque stable file URL');
	return capability;
}

async function smokeProtectedCapability(capability) {
	const response = await requestMappedProtected(capability, {
		headers: { Range: 'bytes=0-7' },
	});
	if (response.status !== 206 || response.body.byteLength !== 8) {
		throw new Error(`mapped protected Range GET returned ${response.status}/${response.body.byteLength}`);
	}
	if (response.headers['cache-control'] !== 'private, no-store') {
		throw new Error('mapped protected capability response was cacheable');
	}
}

async function requestMappedProtected(capability, options = {}) {
	const signed = new URL(capability);
	const target = new URL(capability);
	target.hostname = '127.0.0.1';
	return new Promise((resolve, reject) => {
		let timeout;
		let responseStream;
		const rejectAndClear = (error) => {
			clearTimeout(timeout);
			reject(error);
		};
		const request = httpRequest(target, {
			method: options.method || 'GET',
			headers: { ...options.headers, Host: signed.host },
		}, (response) => {
			responseStream = response;
			const chunks = [];
			response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
			response.once('error', rejectAndClear);
			response.once('aborted', () => rejectAndClear(new Error('protected response aborted')));
			response.once('end', () => {
				clearTimeout(timeout);
				const body = Buffer.concat(chunks);
				resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
			});
		});
		request.once('error', rejectAndClear);
		timeout = setTimeout(() => {
			const error = new Error('protected capability request exceeded its wall timeout');
			responseStream?.destroy(error);
			request.destroy(error);
		}, options.timeoutMs ?? 5_000);
		request.end(options.body);
	});
}

async function waitForMappedProtectedResponse(capability, attempts = 10, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		try {
			return await requestMappedProtected(capability, { timeoutMs: remainingMs });
		} catch (error) {
			lastError = error;
			const retryDelayMs = Math.min(200, deadline - Date.now());
			if (retryDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
			}
		}
	}
	throw lastError ?? new Error('protected capability retry deadline expired');
}

async function waitForApiHealth(timeoutMs = 30_000) {
 const deadline = Date.now() + timeoutMs;
 while (Date.now() < deadline) {
  try {
   const response = await fetch('http://127.0.0.1:4000/api/health', {signal: AbortSignal.timeout(Math.min(2_000, deadline-Date.now()))});
   if (response.ok && (await response.json()).ok === true) return;
  } catch { /* API may still be establishing its database/startup gates. */ }
  await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0,deadline-Date.now()))));
 }
 throw new Error('API did not become healthy after restart');
}

const injectProtectedUpstreamFailure = [
 'set -eu',
 'conf=/etc/nginx/conf.d/default.conf',
 "grep -Fq 'proxy_pass http://garage:3900$pcu_validated_object_path;' \"$conf\" || { echo 'expected protected locator upstream missing' >&2; exit 1; }",
 "sed -i 's#proxy_pass http://garage:3900#proxy_pass http://127.0.0.1:9#' \"$conf\"",
 "grep -Fq 'proxy_pass http://127.0.0.1:9$pcu_validated_object_path;' \"$conf\" || { echo 'protected locator failure injection did not apply' >&2; exit 1; }",
 'nginx -t',
 'nginx -s reload',
 'sleep 1',
].join('\n');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
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

const suites = {
	voting: { files: ['src/__tests__/voting.postgres.test.ts'], env: { RUN_POSTGRES_INTEGRATION: 'true' } },
	'orphan-renewal-timeout': {
		files: ['src/__tests__/orphan-renewal-timeout.postgres.test.ts'],
	},
	'canonical-processing-fences': {
		files: ['src/__tests__/image-pointer-fence.postgres.test.ts'],
	},
	'import-transaction': {
		files: ['src/__tests__/import-transaction.postgres.test.ts'],
	},
	'idempotency': {
		files: ['src/__tests__/idempotency.postgres.test.ts'],
	},
	'lease-clock-core': {
		files: ['src/__tests__/lease-clock.postgres.test.ts'],
	},
	'lease-clock': {
		files: [
			'src/__tests__/lease-clock.postgres.test.ts',
			'src/__tests__/orphan-renewal-timeout.postgres.test.ts',
		],
		serial: true,
	},
	'lifecycle-schema': {
		files: ['src/__tests__/upload-lifecycle-schema.postgres.test.ts'],
	},
	'responsive-image-migration': {
		files: ['src/__tests__/responsive-image-migration.postgres.test.ts'],
	},
	'project-video-order-migration': {
		files: ['src/__tests__/project-video-order-expand.postgres.test.ts'],
	},
	'canonical-migration-chain': {
		files: [
			'src/__tests__/canonical-migration-chain.garage.postgres.test.ts',
			'src/__tests__/webgl-deletion-lifecycle.garage.postgres.test.ts',
		],
		env: garageEnv,
	},
	'project-assets': {
		files: [
			'src/__tests__/project-materials.postgres.test.ts',
			'src/modules/migration/canonical-correction.postgres.test.ts',
			'src/__tests__/project-video-order-expand.postgres.test.ts',
			'src/__tests__/project-video-order.postgres.test.ts',
			'src/__tests__/project-video-upload.postgres.test.ts',
		],
	},
	'admin-project-search': {
		files: ['src/__tests__/admin-project-search.postgres.test.ts'],
	},
	'banned-ips': {
		files: ['src/__tests__/banned-ip.integration.test.ts'],
	},
	'phase2-transition': {
		files: [
			'src/__tests__/canonical-asset-contract-schema.postgres.test.ts',
			'src/__tests__/project-submission.postgres.test.ts',
			'src/__tests__/faculty-management-http.postgres.test.ts',
			'src/__tests__/phase2-project-http.postgres.test.ts',
			'src/__tests__/contract-age-exception.postgres.test.ts',
			'src/__tests__/contract-image-bridge36.postgres.test.ts',
			'src/__tests__/contract-image-bridge-traffic.postgres.test.ts',
		],
		serial: true,
	},
	'year-change-approval': {
		files: [
			'src/modules/project-change/repository.postgres.test.ts',
			'src/modules/project-change/transfer-review.postgres.test.ts',
			'src/__tests__/project-year-policy.postgres.test.ts',
			'src/__tests__/project-year-http.postgres.test.ts',
		],
		serial: true,
	},
	'visibility': {
		files: [
			'src/__tests__/visibility-http.postgres.test.ts',
			'src/__tests__/visibility-rollback.postgres.test.ts',
			'src/__tests__/file-access.postgres.test.ts',
			'src/__tests__/webgl-play.postgres.test.ts',
			'src/__tests__/webgl-network.postgres.test.ts',
		],
	},
	'visibility-gateway': {
		files: ['src/__tests__/visibility-gateway.garage.postgres.test.ts'],
		// Preserve the old gateway command's inherited S3 configuration.
		env: { RUN_GATEWAY_INTEGRATION: 'true', RUN_GARAGE_INTEGRATION: 'true' },
	},
	'webgl-display': {
		files: ['src/__tests__/webgl-display-http.postgres.test.ts'],
	},
};

const fullSuiteOrder = [
	'voting',
	'orphan-renewal-timeout',
	'canonical-processing-fences',
	'import-transaction',
	'idempotency',
	'lease-clock-core',
	'lifecycle-schema',
	'responsive-image-migration',
	'canonical-migration-chain',
	'project-assets',
	'admin-project-search',
	'banned-ips',
	'phase2-transition',
	'year-change-approval',
	'webgl-display',
	'visibility',
	'visibility-gateway',
];

const help = `Usage:
  npm run test:integration                         Start services, run full integration and smokes, then clean up
  npm run test:integration:suite -- <name>          Run one suite against existing services
  npm run test:integration:list                    List available suites
  node scripts/run-integration.mjs --help          Show this help
`;

function parseArgs(args) {
	if (args.length === 0) return { mode: 'full' };
	if (args.length === 1 && args[0] === '--list') return { mode: 'list' };
	if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { mode: 'help' };
	if (args[0] === '--suite') {
		if (args.length !== 2) throw new Error('Expected exactly one suite name after --suite.');
		if (!Object.hasOwn(suites, args[1])) throw new Error(`Unknown integration suite: ${args[1]}. Use npm run test:integration:list.`);
		return { mode: 'suite', name: args[1] };
	}
	throw new Error(`Unexpected integration arguments: ${args.join(' ')}.`);
}

function runSuite(name, spawn, env) {
	const suite = suites[name];
	const result = spawn(npm, [
		'exec', '-w', 'apps/api', '--', 'vitest', 'run',
		...(suite.serial ? ['--no-file-parallelism'] : []), ...suite.files,
	], { stdio: 'inherit', env: { ...env, ...postgresEnv, ...suite.env } });
	return result.status ?? 1;
}

export async function runIntegration(args, {
	spawn = spawnSync,
	env = process.env,
	log = console.log,
	gatewaySmokes = runGatewaySmokes,
} = {}) {
	// Validate before any subprocess, service startup, or cleanup.
	const selection = parseArgs(args);
	if (selection.mode === 'help') { log(help); return 0; }
	if (selection.mode === 'list') { log(Object.keys(suites).join('\n')); return 0; }
	if (selection.mode === 'suite') return runSuite(selection.name, spawn, env);

	let exitCode = 0;
	try {
		const startup = spawn(npm, ['run', 'testenv:up'], { stdio: 'inherit' });
		exitCode = startup.status ?? 1;
		for (const name of fullSuiteOrder) {
			if (exitCode !== 0) break;
			exitCode = runSuite(name, spawn, env);
		}
		if (exitCode === 0) {
			const e2e = spawn(docker, ['compose', '-f', 'docker-compose.integration.yml', '--profile', 'e2e', 'run', '--rm', 'e2e'], { stdio: 'inherit' });
			exitCode = e2e.status ?? 1;
		}
		if (exitCode === 0) exitCode = await gatewaySmokes(spawn);
	} finally {
		const cleanup = spawn(docker, ['compose', '-f', 'docker-compose.integration.yml', 'down', '--remove-orphans'], { stdio: 'inherit' });
		if (exitCode === 0 && cleanup.status !== 0) exitCode = cleanup.status ?? 1;
	}
	return exitCode;
}

async function runGatewaySmokes(spawn) {
	let exitCode = 0;
	let protectedCapability;
	try {
		protectedCapability = await acquireProtectedCapability();
		await smokeProtectedCapability(protectedCapability);
		console.log('Mapped :3906 protected capability smoke: OK');
	} catch (error) {
		console.error(error);
		exitCode = 1;
	}
	const smokeUrl = 'http://127.0.0.1:3904/public/images/integration/poster/original.png';
	const smoke = () => spawn(
		process.execPath,
		['server/smoke-data-plane.mjs', smokeUrl],
		{ stdio: 'inherit', env: { ...process.env, ALLOW_INSECURE_SMOKE: 'true' } },
	);
	let result = smoke();
	if (result.status !== 0) exitCode = result.status ?? 1;
	if (exitCode === 0) {
		result = spawn(docker, ['compose', '-f', 'docker-compose.integration.yml', 'stop', 'api'], { stdio: 'inherit' });
		if (result.status !== 0) exitCode = result.status ?? 1;
	}
	if (exitCode === 0) {
		const denied = await fetch(smokeUrl);
		if (denied.ok) { console.error('API-down public gate served bytes'); exitCode = 1; }
	}
	if (exitCode === 0) {
		try {
			const denied = await requestMappedProtected(protectedCapability);
			if (denied.status < 400) throw new Error('API-down protected gate served bytes');
		} catch (error) {
			console.error(error);
			exitCode = 1;
		}
	}
	const restart = spawn(docker, ['compose', '-f', 'docker-compose.integration.yml', 'start', 'api'], { stdio: 'inherit' });
	if (exitCode === 0 && restart.status !== 0) exitCode = restart.status ?? 1;
	if (exitCode === 0) {
		const sentinel = 'PCU_SIGV4_QUERY_SENTINEL_260824';
		let sentinelCapability;
		let failureInjected = false;
		try {
			await waitForApiHealth();
			// The pre-outage capability is deliberately retained for the API-down
			// check above. Reissue after restart so this independent Garage failure
			// test cannot be rejected merely because the 60-second grant expired.
			protectedCapability = await acquireProtectedCapability();
			sentinelCapability = new URL(protectedCapability);
			sentinelCapability.searchParams.set('pcu-sentinel', sentinel);
			await smokeProtectedCapability(sentinelCapability.toString());
			const injected = spawn(
				docker,
				[
					'compose', '-f', 'docker-compose.integration.yml', 'exec', '-T',
					'protected-download-origin', 'sh', '-c',
					injectProtectedUpstreamFailure,
				],
				{ stdio: 'inherit' },
			);
			if (injected.status !== 0) throw new Error('could not inject protected upstream failure');
			failureInjected = true;
			// An nginx reload may reset the one connection accepted by an exiting worker.
			// Retry transport establishment only; the first HTTP response is still asserted below.
			const upstreamFailure = await waitForMappedProtectedResponse(sentinelCapability.toString());
			if (upstreamFailure.status !== 502 && upstreamFailure.status !== 504) {
				throw new Error(`protected upstream failure returned ${upstreamFailure.status}`);
			}
			const fixedBody = Buffer.from('must stop before unavailable Garage');
			const fixedRejected = await requestMappedProtected(protectedCapability, {
				headers: { 'Content-Length': String(fixedBody.byteLength) },
				body: fixedBody,
			});
			if (fixedRejected.status !== 413) {
				throw new Error(`fixed GET body reached unavailable upstream (${fixedRejected.status})`);
			}
			const chunkedRejected = await requestMappedProtected(protectedCapability, {
				headers: { 'Transfer-Encoding': 'chunked' },
				body: Buffer.from('chunked body must stop before unavailable Garage'),
			});
			if (chunkedRejected.status !== 400) {
				throw new Error(`chunked GET body reached unavailable upstream (${chunkedRejected.status})`);
			}
			const containerLogs = spawn(
				docker,
				['compose', '-f', 'docker-compose.integration.yml', 'logs', '--no-color', 'protected-download-origin'],
				{ encoding: 'utf8' },
			);
			if (containerLogs.status !== 0) throw new Error('could not read protected proxy docker logs');
			if (`${containerLogs.stdout}\n${containerLogs.stderr}`.includes(sentinel)) {
				throw new Error('SigV4 sentinel query leaked to protected proxy docker logs');
			}
			const fileLeak = spawn(docker, [
				'compose', '-f', 'docker-compose.integration.yml', 'exec', '-T',
				// Only inspect regular files: nginx's access/error log symlinks point
				// to live stdout/stderr streams, which are audited above.
				'protected-download-origin', 'find',
				'/var/log/nginx', '/var/cache/nginx', '/tmp', '-type', 'f',
				'-exec', 'grep', '-l', '-F', sentinel, '{}', '+',
			], { encoding: 'utf8' });
			if (fileLeak.status !== 0) {
				throw new Error(`protected proxy file sentinel audit failed (${fileLeak.status})`);
			}
			if (fileLeak.stdout.trim() !== '') {
				throw new Error('SigV4 sentinel query leaked to protected proxy files');
			}
			if (!containerLogs.stdout.includes(`status=${upstreamFailure.status}`)) {
				throw new Error('query-free protected upstream failure status was not observable');
			}
			console.log('Unavailable-upstream protected query redaction and request-body rejection smoke: OK');
		} catch (error) {
			console.error(error);
			exitCode = 1;
		} finally {
			if (failureInjected) {
				const restored = spawn(
					docker,
					[
						'compose', '-f', 'docker-compose.integration.yml', 'up', '-d',
						'--force-recreate', '--no-deps', 'protected-download-origin',
					],
					{ stdio: 'inherit' },
				);
				if (exitCode === 0 && restored.status !== 0) exitCode = restored.status ?? 1;
			}
		}
	}
	if (exitCode === 0) console.log('API-down public and pre-issued protected capabilities denied: OK');
	return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = await runIntegration(process.argv.slice(2));
	} catch (error) {
		console.error(error.message);
		console.error(help);
		process.exitCode = 1;
	}
}
