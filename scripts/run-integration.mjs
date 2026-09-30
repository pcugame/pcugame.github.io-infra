import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import process from 'node:process';

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
	[npm, ['run', 'test:integration:project-assets']],
	[npm, ['run', 'test:integration:admin-project-search']],
	[npm, ['run', 'test:integration:banned-ips']],
	[npm, ['run', 'test:integration:phase2-transition']],
	[npm, ['run', 'test:integration:year-change-approval']],
	[npm, ['run', 'test:integration:visibility']],
	[npm, ['run', 'test:integration:visibility-gateway']],
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
		const restart = spawnSync(docker, ['compose', '-f', 'docker-compose.integration.yml', 'start', 'api'], { stdio: 'inherit' });
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
				const injected = spawnSync(
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
				const containerLogs = spawnSync(
					docker,
					['compose', '-f', 'docker-compose.integration.yml', 'logs', '--no-color', 'protected-download-origin'],
					{ encoding: 'utf8' },
				);
				if (containerLogs.status !== 0) throw new Error('could not read protected proxy docker logs');
				if (`${containerLogs.stdout}\n${containerLogs.stderr}`.includes(sentinel)) {
					throw new Error('SigV4 sentinel query leaked to protected proxy docker logs');
				}
				const fileLeak = spawnSync(docker, [
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
					const restored = spawnSync(
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
