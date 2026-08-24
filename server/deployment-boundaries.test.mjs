import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const deploy = await readFile(new URL('./deploy.sh', import.meta.url), 'utf8');
const env = await readFile(new URL('./.env.example', import.meta.url), 'utf8');
const integrationCompose = await readFile(new URL('../docker-compose.integration.yml', import.meta.url), 'utf8');
const integrationSmoke = await readFile(new URL('../scripts/smoke-integration.mjs', import.meta.url), 'utf8');

assert.equal(spawnSync('bash', ['-n', new URL('./deploy.sh', import.meta.url).pathname]).status, 0);
for (const value of ['PUBLIC_ASSET_ORIGIN', 'S3_PUBLIC_SIGNING_ENDPOINT', 'S3_ENDPOINT']) {
	assert.match(deploy, new RegExp(`-e "${value}=\\$\\{${value}\\}"`));
	assert.match(env, new RegExp(`^${value}=https://`, 'm'));
}
assert.match(deploy, /S3_PRIVATE_NETWORK_CONFIRMED/);
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
assert.match(integrationCompose, /INTEGRATION_PUBLIC_ASSET_BASE_URL:\s*http:\/\/public-origin:8080/);
assert.match(integrationCompose, /INTEGRATION_UPLOAD_PART_BASE_URL:\s*http:\/\/upload-origin:8080/);
assert.match(integrationSmoke, /function integrationPublicAssetUrl\(url\)/);
assert.match(integrationSmoke, /target\.protocol = internalPublicAssetBase\.protocol/);
assert.match(integrationSmoke, /target\.host = internalPublicAssetBase\.host/);
assert.match(integrationSmoke, /const publicImageFetchUrl = integrationPublicAssetUrl\(publicImageUrl\)/);
assert.match(integrationSmoke, /const hostedWebglUrl = integrationPublicAssetUrl\(webglUrl\)/);
assert.doesNotMatch(integrationSmoke, /integrationApiUrl\(webglUrl\)/);
assert.match(integrationSmoke, /headers: \{ \.\.\.capability\.requiredHeaders, Host: signedHost/);

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
