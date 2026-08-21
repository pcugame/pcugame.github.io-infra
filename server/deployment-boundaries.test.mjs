import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const deploy = await readFile(new URL('./deploy.sh', import.meta.url), 'utf8');
const env = await readFile(new URL('./.env.example', import.meta.url), 'utf8');

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
	'dist/image-worker.js', 'dist/export-worker.js',
]) assert.ok(deploy.includes(entry), `missing dedicated process: ${entry}`);

const apiRun = deploy.slice(deploy.indexOf('echo "Starting API..."'), deploy.indexOf('# Verify API container'));
assert.doesNotMatch(apiRun, /NAS_EXPORT|nas_export|\/app\/storage/);
const exportStart = deploy.slice(deploy.indexOf('start_worker "$EXPORT_WORKER_CONTAINER"'));
assert.match(exportStart, /NAS_EXPORT_ROOT/);
assert.match(exportStart, /nas_export_host_path/);
assert.match(deploy, /Forward-only deploy complete/);
assert.doesNotMatch(deploy, /do_rollback|API_IMAGE_PREVIOUS|podman\s+tag[^\n]+previous/i);

console.log('Production API/worker deployment boundaries: OK');
