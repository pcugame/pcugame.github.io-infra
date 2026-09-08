import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const deploy = await readFile(new URL('./deploy.sh', import.meta.url), 'utf8');
const env = await readFile(new URL('./.env.example', import.meta.url), 'utf8');
const integrationCompose = await readFile(new URL('../docker-compose.integration.yml', import.meta.url), 'utf8');
const integrationSmoke = await readFile(new URL('../scripts/smoke-integration.mjs', import.meta.url), 'utf8');
const integrationRunner = await readFile(new URL('../scripts/run-integration.mjs', import.meta.url), 'utf8');

assert.equal(spawnSync('bash', ['-n', new URL('./deploy.sh', import.meta.url).pathname]).status, 0);
for (const value of [
	'PUBLIC_ASSET_ORIGIN',
	'S3_PUBLIC_SIGNING_ENDPOINT',
	'S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT',
	'S3_ENDPOINT',
]) {
	assert.match(deploy, new RegExp(`-e "${value}=\\$\\{${value}\\}"`));
	assert.match(env, new RegExp(`^${value}=https://`, 'm'));
}
assert.match(deploy, /S3_PRIVATE_NETWORK_CONFIRMED/);
assert.match(deploy, /new URL\(value\)/);
assert.match(deploy, /exact HTTPS origin without credentials, path, query, fragment, or trailing slash/);
assert.match(deploy, /normalized origin collides with/);
assert.match(env, /never route Garage admin\/management listeners/);
assert.doesNotMatch(deploy, /STORAGE_HOST_PATH/);
assert.doesNotMatch(deploy, /UPLOAD_ROOT_PROTECTED=|UPLOAD_ROOT_PUBLIC=/);

for (const entry of [
	'dist/game-validation-worker.js', 'dist/webgl-worker.js', 'dist/video-worker.js',
	'dist/image-worker.js', 'dist/export-worker.js', 'dist/project-publication-worker.js',
]) assert.ok(deploy.includes(entry), `missing dedicated process: ${entry}`);

const apiRun = deploy.slice(deploy.indexOf('echo "Starting API..."'), deploy.indexOf('# Verify API container'));
assert.doesNotMatch(apiRun, /NAS_EXPORT|nas_export|\/app\/storage/);
const commonRuntimeEnv = deploy.slice(
	deploy.indexOf('local common_env=('),
	deploy.indexOf('local ca_args=()'),
);
for (const name of ['SESSION_SECRET', 'GOOGLE_CLIENT_IDS']) {
	assert.ok(
		commonRuntimeEnv.includes(`-e "${name}=\${${name}}"`),
		`dedicated workers must receive ${name} required by loadEnv`,
	);
}
const exportStart = deploy.slice(deploy.indexOf('start_worker "$EXPORT_WORKER_CONTAINER"'));
assert.match(exportStart, /NAS_EXPORT_ROOT/);
assert.match(exportStart, /nas_export_host_path/);
assert.match(deploy, /Forward-only deploy complete/);
assert.doesNotMatch(deploy, /do_rollback|API_IMAGE_PREVIOUS|podman\s+tag[^\n]+previous/i);
assert.match(deploy, /dist\/phase1-release-manifest\.js/);
assert.match(deploy, /PCU_PHASE1_RUNTIME_V1/);
assert.match(deploy, /release-artifact-preflight\) do_release_artifact_preflight/);
assert.match(deploy, /PCU_RELEASE_SCHEMA_PHASE === "phase2"[\s\S]*project-publication-worker\.js/);
assert.match(deploy, /release_schema_phase" == phase2[\s\S]*PROJECT_PUBLICATION_WORKER_CONTAINER/);
assert.match(deploy, /START_DEDICATED_WORKERS:-true}" == false[\s\S]*assert_phase1_rollback_authorization/);
assert.match(deploy, /must use an immutable @sha256 release digest/);
assert.match(deploy, /ghcr\\\.io\/pcugame\/pcu-graduationproject-v2-api@sha256/);
assert.match(deploy, /image source revision label does not match RELEASE_SOURCE_SHA/);
assert.match(deploy, /rollback image tag no longer resolves to the authorized image ID/);
assert.doesNotMatch(deploy, /\*:\s*sha-|localhost\/\*:rollback-/);

for (const [name, value] of [
	['DIRECT_UPLOAD_PART_URL_REFRESH_MAX', '64'],
	['DIRECT_UPLOAD_WORKER_TEMP_MAX_MB', '6144'],
	['EXPORT_WORKER_MAX_OBJECT_BYTES', '5368709120'],
	['EXPORT_WORKER_MAX_JOB_BYTES', '34359738368'],
]) {
	assert.match(env, new RegExp(`^${name}=${value}$`, 'm'));
	assert.match(deploy, new RegExp(`require_exact_capacity_value ${name} ${value}`));
}
assert.doesNotMatch(env, /^DIRECT_UPLOAD_PART_URL_(?:WINDOW_MS|MAX)=/m);
assert.doesNotMatch(integrationCompose, /DIRECT_UPLOAD_PART_URL_(?:WINDOW_MS|MAX):/);
assert.doesNotMatch(deploy, /--tmpfs \/tmp:rw,noexec,nosuid,size=4g/);
assert.match(integrationCompose, /PUBLIC_ASSET_ORIGIN:\s*http:\/\/localhost:3904/);
assert.match(integrationCompose, /S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT:\s*http:\/\/localhost:3906/);
assert.match(integrationCompose, /INTEGRATION_PUBLIC_ASSET_BASE_URL:\s*http:\/\/public-origin:8080/);
assert.match(integrationCompose, /INTEGRATION_UPLOAD_PART_BASE_URL:\s*http:\/\/upload-origin:8080/);
assert.match(integrationCompose, /INTEGRATION_PROTECTED_DOWNLOAD_BASE_URL:\s*http:\/\/protected-download-origin:8080/);
assert.match(integrationSmoke, /function integrationPublicAssetUrl\(url\)/);
assert.match(integrationSmoke, /target\.protocol = internalPublicAssetBase\.protocol/);
assert.match(integrationSmoke, /target\.host = internalPublicAssetBase\.host/);
assert.match(integrationSmoke, /const publicImageFetchUrl = integrationPublicAssetUrl\(publicImageUrl\)/);
assert.match(integrationSmoke, /const hostedWebglUrl = integrationPublicAssetUrl\(webglUrl\)/);
assert.doesNotMatch(integrationSmoke, /integrationApiUrl\(webglUrl\)/);
assert.match(integrationSmoke, /headers: \{ \.\.\.capability\.requiredHeaders, Host: signedHost/);
assert.match(integrationSmoke, /new URL\(gameLocation\)\.origin !== 'http:\/\/localhost:3906'/);
assert.match(integrationSmoke, /internalBase: internalProtectedDownloadBase/);
assert.match(integrationSmoke, /protected proxy accepted PUT/);
assert.match(integrationSmoke, /UploadPart proxy accepted protected GET/);
assert.match(integrationSmoke, /legacy\/서울 space\/literal % \+ plus: @ amp& equals=\.bin/);
assert.match(integrationSmoke, /escaped UTF-8\/space\/percent\/reserved legacy key/);
assert.match(integrationSmoke, /accepted fixed-length GET body/);
assert.match(integrationSmoke, /accepted chunked GET body/);
assert.match(integrationRunner, /PCU_SIGV4_QUERY_SENTINEL_260824/);
assert.match(integrationRunner, /proxy_pass http:\/\/127\.0\.0\.1:9/);
assert.match(integrationRunner, /--force-recreate', '--no-deps', 'protected-download-origin/);
assert.match(integrationRunner, /SigV4 sentinel query leaked to protected proxy docker logs/);
assert.match(integrationRunner, /SigV4 sentinel query leaked to protected proxy files/);
assert.match(integrationRunner, /fixed GET body reached unavailable upstream/);
assert.match(integrationRunner, /chunked GET body reached unavailable upstream/);

const gameStart = deploy.slice(
	deploy.indexOf('start_worker "$GAME_WORKER_CONTAINER"'),
	deploy.indexOf('start_worker "$WEBGL_WORKER_CONTAINER"'),
);
const webglStart = deploy.slice(
	deploy.indexOf('start_worker "$WEBGL_WORKER_CONTAINER"'),
	deploy.indexOf('start_worker "$VIDEO_WORKER_CONTAINER"'),
);
for (const isolatedWorker of [gameStart, webglStart]) {
	assert.match(isolatedWorker, /--tmpfs \/tmp:rw,noexec,nosuid,size=6g/);
	assert.doesNotMatch(isolatedWorker, /-v [^\n]*:\/tmp/);
}
assert.match(deploy, /independent, container-owned tmpfs mounts/);
assert.match(deploy, /EXPORT_WORKER_MAX_JOB_BYTES \+ NAS_EXPORT_STAGING_HEADROOM_BYTES/);
assert.match(deploy, /15 \* gib \+ GARAGE_DEPLOYMENT_HEADROOM_BYTES/);

// Exercise the fail-closed preflight without Podman. It proves the deployed
// limits cannot silently drift from the worker tmpfs/object/job boundaries.
const fixtureDir = await mkdtemp(join(tmpdir(), 'pcu-deploy-capacity-'));
const deployPath = new URL('./deploy.sh', import.meta.url).pathname;
const exactFixture = env
	.replace(/^NAS_EXPORT_HOST_PATH=.*$/m, `NAS_EXPORT_HOST_PATH=${fixtureDir}`)
	.replace(/^GARAGE_CAPACITY_ATTESTED_AVAILABLE_BYTES=.*$/m, 'GARAGE_CAPACITY_ATTESTED_AVAILABLE_BYTES=17179869184');

const boundaryFixture = exactFixture.replace(
	/^S3_PRIVATE_NETWORK_CONFIRMED=.*$/m,
	'S3_PRIVATE_NETWORK_CONFIRMED=true',
);
const runBoundary = async (fixture, command = 'boundary-preflight', extraEnv = {}, commandArgs = []) => {
	await writeFile(join(fixtureDir, '.env'), fixture);
	return spawnSync('bash', [deployPath, command, ...commandArgs], {
		encoding: 'utf8',
		env: { ...process.env, DEPLOY_DIR: fixtureDir, ...extraEnv },
	});
};
const acceptedBoundary = await runBoundary(boundaryFixture);
assert.equal(acceptedBoundary.status, 0, acceptedBoundary.stderr || acceptedBoundary.stdout);

// Exercise the exact final-web marker contract over HTTPS. The verifier must
// accept only SHA + one LF and must not follow a redirect to a matching body.
const webKey = join(fixtureDir, 'web-marker.key');
const webCert = join(fixtureDir, 'web-marker.crt');
const certificate = spawnSync('openssl', [
	'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
	'-subj', '/CN=127.0.0.1', '-keyout', webKey, '-out', webCert,
], { encoding: 'utf8' });
assert.equal(certificate.status, 0, certificate.stderr);
const webServer = join(fixtureDir, 'web-marker-server.mjs');
await writeFile(webServer, `
import https from 'node:https';
import { readFileSync } from 'node:fs';
const [keyPath, certPath, mode, sha] = process.argv.slice(2);
const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_request, response) => {
  if (mode === 'redirect') {
    response.writeHead(302, { Location: '/release-sha.txt' });
    response.end();
    return;
  }
  const body = mode === 'exact' || mode === 'html' ? sha + '\\n' : sha + ' \\n';
  response.writeHead(200, { 'Content-Type': mode === 'html' ? 'text/html' : 'text/plain', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`);
const expectedWebSha = 'a'.repeat(40);
const verifyWebMarker = async (mode) => {
	const child = spawn(process.execPath, [webServer, webKey, webCert, mode, expectedWebSha], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const port = await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('HTTPS fixture did not start')), 3_000);
		child.once('error', reject);
		child.stdout.once('data', (chunk) => {
			clearTimeout(timeout);
			resolve(Number(String(chunk).trim()));
		});
	});
	try {
		const fixture = boundaryFixture.replace(/^WEB_PUBLIC_URL=.*$/m, `WEB_PUBLIC_URL=https://127.0.0.1:${port}`);
		return await runBoundary(fixture, 'verify-final-web', {
			NODE_TLS_REJECT_UNAUTHORIZED: '0',
		}, [expectedWebSha]);
	} finally {
		child.kill('SIGTERM');
	}
};
const exactWeb = await verifyWebMarker('exact');
assert.equal(exactWeb.status, 0, exactWeb.stderr || exactWeb.stdout);
for (const mode of ['whitespace', 'html', 'redirect']) {
	const rejectedWeb = await verifyWebMarker(mode);
	assert.notEqual(rejectedWeb.status, 0, `${mode} final-web marker unexpectedly passed`);
}
for (const [name, replacement, expectedError] of [
	['S3_ENDPOINT', 'S3_ENDPOINT=https://operator@garage-s3.private.example', /without credentials/],
	['S3_PUBLIC_SIGNING_ENDPOINT', 'S3_PUBLIC_SIGNING_ENDPOINT=https://replace-with-upload-host/s3', /without credentials, path/],
	['S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT', 'S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT=https://replace-with-protected-download-host?capability=1', /without credentials, path, query/],
	['PUBLIC_ASSET_ORIGIN', "PUBLIC_ASSET_ORIGIN='https://replace-with-public-object-host#fragment'", /without credentials, path, query, fragment/],
	['S3_ENDPOINT', 'S3_ENDPOINT=not-a-url', /must be an exact HTTPS origin/],
]) {
	const rejected = await runBoundary(boundaryFixture.replace(new RegExp(`^${name}=.*$`, 'm'), replacement));
	assert.notEqual(rejected.status, 0, `${replacement} unexpectedly passed`);
	assert.match(`${rejected.stdout}\n${rejected.stderr}`, expectedError);
}
const normalizedCollision = boundaryFixture
	.replace(/^S3_PUBLIC_SIGNING_ENDPOINT=.*$/m, 'S3_PUBLIC_SIGNING_ENDPOINT=HTTPS://REPLACE-WITH-PROTECTED-DOWNLOAD-HOST:443')
	.replace(/^S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT=.*$/m, 'S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT=https://replace-with-protected-download-host');
const collision = await runBoundary(normalizedCollision);
assert.notEqual(collision.status, 0, 'case/default-port collision unexpectedly passed');
assert.match(`${collision.stdout}\n${collision.stderr}`, /normalized origin collides with/);

for (const name of [
	'S3_ENDPOINT',
	'S3_PUBLIC_SIGNING_ENDPOINT',
	'S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT',
	'PUBLIC_ASSET_ORIGIN',
]) {
	const httpFixture = boundaryFixture.replace(
		new RegExp(`^${name}=https://`, 'm'),
		`${name}=http://`,
	);
	const rejected = await runBoundary(httpFixture);
	assert.notEqual(rejected.status, 0, `${name}=http unexpectedly passed production preflight`);
	assert.match(`${rejected.stdout}\n${rejected.stderr}`, /must be an exact HTTPS origin/);
}

// The real `up` path invokes this preflight before `do_down` or any Podman
// operation. A fake Podman marker must remain absent for a malformed origin.
const fakeBin = join(fixtureDir, 'fake-bin');
const podmanMarker = join(fixtureDir, 'podman-invoked');
await mkdir(fakeBin);
const fakePodman = join(fakeBin, 'podman');
await writeFile(fakePodman, '#!/bin/sh\n: > "$PODMAN_MARKER"\nexit 99\n');
await chmod(fakePodman, 0o755);
const destructiveGuard = await runBoundary(
	boundaryFixture.replace(
		/^S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT=.*$/m,
		'S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT=https://download.example/path',
	),
	'up',
	{
		PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
		PODMAN_MARKER: podmanMarker,
	},
);
assert.notEqual(destructiveGuard.status, 0);
assert.equal(spawnSync('test', ['!', '-e', podmanMarker]).status, 0, 'Podman ran before origin preflight failed');

assert.match(deploy, /restart\) do_up ;;/);
const upFunction = deploy.slice(deploy.indexOf('do_up() {'), deploy.indexOf('# ── Logs'));
assert.ok(
	upFunction.indexOf('validate_production_boundaries') < upFunction.indexOf('do_down'),
	'do_up must validate production boundaries before its down/up replacement phase',
);
assert.ok(
	upFunction.indexOf('validate_release_artifacts "$release_schema_phase"') < upFunction.indexOf('do_down'),
	'do_up must validate the phase marker and worker set before replacing the deployment',
);
assert.match(deploy, /redirect: 'manual'/);
assert.match(deploy, /AbortSignal\.timeout\(5000\)/);
assert.match(deploy, /response\.status !== 200/);
assert.match(deploy, /unexpected Content-Type/);
assert.match(deploy, /'Accept-Encoding': 'identity'/);
assert.match(deploy, /Buffer\.from\(`\$\{expectedSha\}\\n`/);
assert.match(deploy, /actual\.equals\(expected\)/);
for (const [label, fixture] of [
	['malformed', boundaryFixture.replace(
		/^S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT=.*$/m,
		'S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT=https://download.example/path',
	)],
	['default-port collision', normalizedCollision],
	['HTTP', boundaryFixture.replace(/^S3_ENDPOINT=https:/m, 'S3_ENDPOINT=http:')],
]) {
	await rm(podmanMarker, { force: true });
	const rejectedRestart = await runBoundary(fixture, 'restart', {
		PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
		PODMAN_MARKER: podmanMarker,
	});
	assert.notEqual(rejectedRestart.status, 0, `${label} restart unexpectedly passed`);
	assert.equal(
		spawnSync('test', ['!', '-e', podmanMarker]).status,
		0,
		`Podman ran before ${label} restart preflight failed`,
	);
}

// Production release artifacts are authorized by registry digest plus the OCI
// source-revision label. Mutable sha-* tags, digest disagreement, and a label
// from another commit all fail before the current deployment is stopped.
await writeFile(fakePodman, `#!/bin/sh
set -eu
if [ "\${1:-}" = pull ]; then exit 0; fi
if [ "\${1:-}" = image ] && [ "\${2:-}" = inspect ]; then
  case " $* " in
    *"{{.Digest}}"*) printf '%s\\n' "\${FAKE_IMAGE_DIGEST:-}" ;;
    *"{{.Id}}"*) printf '%s\\n' "\${FAKE_IMAGE_ID:-${'3'.repeat(64)}}" ;;
    *"org.opencontainers.image.revision"*) printf '%s\\n' "\${FAKE_IMAGE_REVISION:-}" ;;
    *) : ;;
  esac
  exit 0
fi
if [ "\${1:-}" = inspect ]; then
  case " $* " in
    *"{{.Image}}"*) printf '%s\\n' "\${FAKE_CONTAINER_IMAGE_ID:-${'3'.repeat(64)}}" ;;
    *"{{.State.Status}}"*) printf '%s\\n' running ;;
    *) : ;;
  esac
  exit 0
fi
if [ "\${1:-}" = exec ]; then
  case " $* " in *wget*) printf '%s\\n' '{"ok":true}' ;; esac
  exit 0
fi
if [ "\${1:-}" = run ]; then exit 0; fi
exit 0
`);
await chmod(fakePodman, 0o755);
const releaseDigest = `sha256:${'1'.repeat(64)}`;
const releaseImage = `ghcr.io/pcugame/pcu-graduationproject-v2-api@${releaseDigest}`;
const releaseSourceSha = '2'.repeat(40);
const releaseImageId = '3'.repeat(64);
const releaseEnv = {
	PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
	API_IMAGE: releaseImage,
	MIGRATION_IMAGE: releaseImage,
	RELEASE_SOURCE_SHA: releaseSourceSha,
	FAKE_IMAGE_DIGEST: releaseDigest,
	FAKE_IMAGE_REVISION: releaseSourceSha,
};
const exactRelease = await runBoundary(boundaryFixture, 'release-artifact-preflight', releaseEnv, ['phase2']);
assert.equal(exactRelease.status, 0, exactRelease.stderr || exactRelease.stdout);

const mutableTagRelease = await runBoundary(boundaryFixture, 'release-artifact-preflight', {
	...releaseEnv,
	API_IMAGE: 'ghcr.io/pcugame/api:sha-deadbeef',
	MIGRATION_IMAGE: 'ghcr.io/pcugame/api:sha-deadbeef',
}, ['phase2']);
assert.notEqual(mutableTagRelease.status, 0, 'mutable sha-* release tag unexpectedly passed');
assert.match(`${mutableTagRelease.stdout}\n${mutableTagRelease.stderr}`, /must use an immutable @sha256/);

for (const unauthorizedImage of [
	`registry.example/pcugame/pcu-graduationproject-v2-api@${releaseDigest}`,
	`ghcr.io/other/pcu-graduationproject-v2-api@${releaseDigest}`,
	`ghcr.io/pcugame/other-api@${releaseDigest}`,
]) {
	const unauthorizedRelease = await runBoundary(boundaryFixture, 'release-artifact-preflight', {
		...releaseEnv,
		API_IMAGE: unauthorizedImage,
		MIGRATION_IMAGE: unauthorizedImage,
	}, ['phase2']);
	assert.notEqual(unauthorizedRelease.status, 0, `${unauthorizedImage} unexpectedly passed`);
	assert.match(`${unauthorizedRelease.stdout}\n${unauthorizedRelease.stderr}`, /exact authorized repository/);
}

const digestMismatch = await runBoundary(boundaryFixture, 'release-artifact-preflight', {
	...releaseEnv,
	FAKE_IMAGE_DIGEST: `sha256:${'4'.repeat(64)}`,
}, ['phase2']);
assert.notEqual(digestMismatch.status, 0, 'retargeted/mismatched digest unexpectedly passed');
assert.match(`${digestMismatch.stdout}\n${digestMismatch.stderr}`, /digest does not match/);

const labelMismatch = await runBoundary(boundaryFixture, 'release-artifact-preflight', {
	...releaseEnv,
	FAKE_IMAGE_REVISION: '5'.repeat(40),
}, ['phase2']);
assert.notEqual(labelMismatch.status, 0, 'wrong OCI source revision unexpectedly passed');
assert.match(`${labelMismatch.stdout}\n${labelMismatch.stderr}`, /source revision label does not match/);

// A local rollback tag is never authority. The server records the exact
// current image ID plus a nonce, and a later tag retarget is rejected.
const rollbackNonce = '6'.repeat(64);
const rollbackImage = 'localhost/pcu-api:rollback-test';
const authorizeRollback = await runBoundary(boundaryFixture, 'authorize-phase1-rollback', {
	...releaseEnv,
}, [rollbackNonce]);
assert.equal(authorizeRollback.status, 0, authorizeRollback.stderr || authorizeRollback.stdout);
assert.equal(spawnSync('stat', ['-c', '%a', join(fixtureDir, 'cutover-state', 'phase1-rollback.authorization')], { encoding: 'utf8' }).stdout.trim(), '600');
assert.match(
	await readFile(join(fixtureDir, 'cutover-state', 'phase1-rollback.authorization'), 'utf8'),
	new RegExp(`^${releaseImageId} ${rollbackNonce}\\n$`),
	'bare Podman image ID was not persisted canonically',
);
const prefixedAuthorizeRollback = await runBoundary(boundaryFixture, 'authorize-phase1-rollback', {
	...releaseEnv,
	FAKE_CONTAINER_IMAGE_ID: `sha256:${releaseImageId}`,
}, [rollbackNonce]);
assert.equal(prefixedAuthorizeRollback.status, 0, prefixedAuthorizeRollback.stderr || prefixedAuthorizeRollback.stdout);
assert.match(
	await readFile(join(fixtureDir, 'cutover-state', 'phase1-rollback.authorization'), 'utf8'),
	new RegExp(`^${releaseImageId} ${rollbackNonce}\\n$`),
	'prefixed Podman image ID was not normalized to the canonical bare ID',
);

const rollbackEnv = {
	PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
	API_IMAGE: rollbackImage,
	MIGRATION_IMAGE: rollbackImage,
	RELEASE_SCHEMA_PHASE: 'phase1',
	START_DEDICATED_WORKERS: 'false',
	PULL_API_IMAGE: 'false',
	ROLLBACK_AUTH_NONCE: rollbackNonce,
};
const retargetedRollback = await runBoundary(boundaryFixture, 'release-artifact-preflight', {
	...rollbackEnv,
	FAKE_IMAGE_ID: `sha256:${'7'.repeat(64)}`,
}, ['phase1']);
assert.notEqual(retargetedRollback.status, 0, 'forged rollback tag unexpectedly passed');
assert.match(`${retargetedRollback.stdout}\n${retargetedRollback.stderr}`, /no longer resolves to the authorized image ID/);
const exactRollback = await runBoundary(boundaryFixture, 'release-artifact-preflight', {
	...rollbackEnv,
	FAKE_IMAGE_ID: `sha256:${releaseImageId}`,
}, ['phase1']);
assert.equal(exactRollback.status, 0, exactRollback.stderr || exactRollback.stdout);
const malformedRollback = await runBoundary(boundaryFixture, 'release-artifact-preflight', {
	...rollbackEnv,
	FAKE_IMAGE_ID: `sha512:${releaseImageId}`,
}, ['phase1']);
assert.notEqual(malformedRollback.status, 0, 'malformed local image ID unexpectedly passed');
assert.match(`${malformedRollback.stdout}\n${malformedRollback.stderr}`, /malformed local image ID/);
const fakeSystemctl = join(fakeBin, 'systemctl');
const systemctlMarker = join(fixtureDir, 'systemctl-invoked');
await writeFile(fakeSystemctl, `#!/bin/sh
set -eu
printf 'XDG_RUNTIME_DIR=%s DBUS_SESSION_BUS_ADDRESS=%s args=%s\\n' \\
  "\${XDG_RUNTIME_DIR:-}" "\${DBUS_SESSION_BUS_ADDRESS:-}" "$*" >> "\$SYSTEMCTL_MARKER"
`);
await chmod(fakeSystemctl, 0o755);
const consumedRollback = await runBoundary(boundaryFixture, 'up', {
	...rollbackEnv,
	// sudo normally strips these variables. deploy.sh must reconnect to the
	// systemd user manager of the account actually running it.
	XDG_RUNTIME_DIR: '',
	DBUS_SESSION_BUS_ADDRESS: '',
	SYSTEMCTL_MARKER: systemctlMarker,
});
assert.equal(consumedRollback.status, 0, consumedRollback.stderr || consumedRollback.stdout);
const systemctlInvocations = await readFile(systemctlMarker, 'utf8');
const systemdRuntimeDir = `/run/user/${process.getuid()}`;
assert.match(
	systemctlInvocations,
	new RegExp(`XDG_RUNTIME_DIR=${systemdRuntimeDir} DBUS_SESSION_BUS_ADDRESS=unix:path=${systemdRuntimeDir}/bus args=--user daemon-reload`),
);
assert.match(
	systemctlInvocations,
	new RegExp(`XDG_RUNTIME_DIR=${systemdRuntimeDir} DBUS_SESSION_BUS_ADDRESS=unix:path=${systemdRuntimeDir}/bus args=--user enable pod-graduationproject.service`),
);
assert.equal(spawnSync('test', ['!', '-e', join(fixtureDir, 'cutover-state', 'phase1-rollback.authorization')]).status, 0);
assert.equal(spawnSync('test', ['!', '-e', join(fixtureDir, 'cutover-state', 'phase1-rollback.consumed')]).status, 0);
const replayedRollback = await runBoundary(boundaryFixture, 'release-artifact-preflight', {
	...rollbackEnv,
	FAKE_IMAGE_ID: releaseImageId,
}, ['phase1']);
assert.notEqual(replayedRollback.status, 0, 'consumed rollback authorization unexpectedly replayed');
assert.match(`${replayedRollback.stdout}\n${replayedRollback.stderr}`, /authorization is absent or already consumed/);

// A browser-side authorization check can become stale while an environment
// approval waits. The production server re-reads its own observation record
// and evaluates the 24-hour/31-day window immediately before drain.
const observationDir = join(fixtureDir, 'cutover-state');
await mkdir(observationDir, { recursive: true });
const canonicalUtc = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const runObservationWindow = async (ageMs, expectedOverride) => {
	const startedAt = canonicalUtc(new Date(Date.now() - ageMs));
	await writeFile(join(observationDir, 'phase1-observation'), [
		`read_cutover_at=${startedAt}`,
		`phase1_api_image=${releaseImage}`,
		'',
	].join('\n'));
	const result = await runBoundary(
		boundaryFixture,
		'verify-observation-window',
		{},
		[expectedOverride ?? startedAt],
	);
	return { result, startedAt };
};
const currentObservation = await runObservationWindow(25 * 60 * 60 * 1000);
assert.equal(currentObservation.result.status, 0, currentObservation.result.stderr || currentObservation.result.stdout);
const delayedTooLittle = await runObservationWindow(23 * 60 * 60 * 1000);
assert.notEqual(delayedTooLittle.result.status, 0, 'observation younger than 24h unexpectedly passed');
assert.match(`${delayedTooLittle.result.stdout}\n${delayedTooLittle.result.stderr}`, /only 23h old/);
const delayedTooLong = await runObservationWindow(32 * 24 * 60 * 60 * 1000);
assert.notEqual(delayedTooLong.result.status, 0, 'approval-delayed observation older than 31d unexpectedly passed');
assert.match(`${delayedTooLong.result.stdout}\n${delayedTooLong.result.stderr}`, /older than 31 days/);
const mismatchedObservation = await runObservationWindow(
	25 * 60 * 60 * 1000,
	canonicalUtc(new Date(Date.now() - 26 * 60 * 60 * 1000)),
);
assert.notEqual(mismatchedObservation.result.status, 0, 'mismatched observation attestation unexpectedly passed');
assert.match(`${mismatchedObservation.result.stdout}\n${mismatchedObservation.result.stderr}`, /does not match the server-side record/);

const runCapacity = async (fixture) => {
	await writeFile(join(fixtureDir, '.env'), fixture);
	return spawnSync('bash', [deployPath, 'capacity-preflight'], {
		encoding: 'utf8',
		env: { ...process.env, DEPLOY_DIR: fixtureDir },
	});
};
try {
	const accepted = await runCapacity(exactFixture);
	assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
	for (const [line, expectedError] of [
		['DIRECT_UPLOAD_PART_URL_REFRESH_MAX=65', /must equal 64/],
		['DIRECT_UPLOAD_WORKER_TEMP_MAX_MB=5120', /must equal 6144/],
		['UPLOAD_USER_GAME_MAX_MB=6145', /exceeds the 6 GiB worker tmpfs/],
		['EXPORT_WORKER_MAX_OBJECT_BYTES=5368709119', /must equal 5368709120/],
		['EXPORT_WORKER_MAX_JOB_BYTES=34359738367', /must equal 34359738368/],
		['GARAGE_CAPACITY_ATTESTED_AVAILABLE_BYTES=17179869183', /Garage requires 15 GiB/],
		['NAS_EXPORT_STAGING_HEADROOM_BYTES=999999999999999', /NAS staging requires/],
	]) {
		const name = line.slice(0, line.indexOf('='));
		const rejected = await runCapacity(exactFixture.replace(new RegExp(`^${name}=.*$`, 'm'), line));
		assert.notEqual(rejected.status, 0, `${line} unexpectedly passed`);
		assert.match(`${rejected.stdout}\n${rejected.stderr}`, expectedError);
	}
	const obsolete = await runCapacity(`${exactFixture}\nDIRECT_UPLOAD_PART_URL_WINDOW_MS=60000\n`);
	assert.notEqual(obsolete.status, 0);
	assert.match(`${obsolete.stdout}\n${obsolete.stderr}`, /obsolete DIRECT_UPLOAD_PART_URL_WINDOW_MS/);
} finally {
	await rm(fixtureDir, { recursive: true, force: true });
}

console.log('Production API/worker deployment boundaries: OK');
