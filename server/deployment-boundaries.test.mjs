import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
const exportStart = deploy.slice(deploy.indexOf('start_worker "$EXPORT_WORKER_CONTAINER"'));
assert.match(exportStart, /NAS_EXPORT_ROOT/);
assert.match(exportStart, /nas_export_host_path/);
assert.match(deploy, /Forward-only deploy complete/);
assert.doesNotMatch(deploy, /do_rollback|API_IMAGE_PREVIOUS|podman\s+tag[^\n]+previous/i);

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
const runBoundary = async (fixture, command = 'boundary-preflight', extraEnv = {}) => {
	await writeFile(join(fixtureDir, '.env'), fixture);
	return spawnSync('bash', [deployPath, command], {
		encoding: 'utf8',
		env: { ...process.env, DEPLOY_DIR: fixtureDir, ...extraEnv },
	});
};
const acceptedBoundary = await runBoundary(boundaryFixture);
assert.equal(acceptedBoundary.status, 0, acceptedBoundary.stderr || acceptedBoundary.stdout);
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
