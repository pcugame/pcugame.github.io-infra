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

const quadletTemplate = (name) => readFile(new URL(`./quadlet/templates/${name}.container.in`, import.meta.url), 'utf8');
const apiUnit = await quadletTemplate('gp-api');
assert.doesNotMatch(apiUnit, /NAS_EXPORT|nas_export|\/app\/storage/);
assert.match(apiUnit, /EnvironmentFile=@COMMON_ENV@[\s\S]*EnvironmentFile=@API_ENV@/);
const runtimeParser = await readFile(new URL('./quadlet/runtime-env.py', import.meta.url), 'utf8');
for (const name of ['SESSION_SECRET', 'GOOGLE_CLIENT_IDS']) assert.ok(runtimeParser.includes(name));
const exportUnit = await quadletTemplate('gp-worker-export');
assert.match(exportUnit, /@EXPORT_ENV@/);
assert.match(exportUnit, /Volume=@NAS_VOLUME@/);
assert.match(deploy, /Forward-only Quadlet deploy complete/);
assert.doesNotMatch(deploy, /podman run -d|podman pod (?:create|rm|stop)|podman (?:generate systemd|stop|rm)|--restart/);
assert.doesNotMatch(deploy, /do_rollback|API_IMAGE_PREVIOUS|podman\s+tag[^\n]+previous/i);
assert.doesNotMatch(deploy, /dist\/phase1-release-manifest\.js/);
assert.doesNotMatch(deploy, /PCU_PHASE1_RUNTIME_V1/);
assert.match(deploy, /release-artifact-preflight\) do_release_artifact_preflight/);
assert.match(deploy, /const entries = \[[\s\S]*"dist\/project-publication-worker\.js"[\s\S]*\];/);
assert.doesNotMatch(deploy, /PCU_RELEASE_SCHEMA_PHASE/);
assert.match(deploy, /release_schema_phase" == phase2/);
assert.match(deploy, /START_DEDICATED_WORKERS:-true}" == true[\s\S]*legacy runtime bypass is retired/);
assert.match(deploy, /must use an immutable @sha256 release digest/);
assert.match(deploy, /ghcr\\\.io\/pcugame\/pcu-graduationproject-v2-api@sha256/);
assert.match(deploy, /image source revision label does not match RELEASE_SOURCE_SHA/);
assert.doesNotMatch(deploy, /ROLLBACK_AUTH|ROLLBACK_CONSUMED|assert_phase1_rollback_authorization/);
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
assert.match(integrationSmoke, /const hostedWebglUrl = integrationPublicAssetUrl\(webglGrant.data.url\)/);
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

for (const name of ['gp-worker-game-validation', 'gp-worker-webgl']) {
    const isolatedWorker = await quadletTemplate(name);
    assert.match(isolatedWorker, /Tmpfs=\/tmp:rw,noexec,nosuid,size=6g/);
    assert.doesNotMatch(isolatedWorker, /Volume=[^\n]*:\/tmp/);
}
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
const runtimeCommonKeys = new Set('DATABASE_URL SESSION_SECRET GOOGLE_CLIENT_IDS CORS_ALLOWED_ORIGINS API_PUBLIC_URL WEB_PUBLIC_URL S3_ENDPOINT S3_PUBLIC_SIGNING_ENDPOINT S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT PUBLIC_ASSET_ORIGIN S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY FILE_GATEWAY_SECRET DIRECT_UPLOAD_PART_URL_REFRESH_MAX UPLOAD_USER_GAME_MAX_MB UPLOAD_PRIVILEGED_GAME_MAX_MB DIRECT_UPLOAD_WORKER_TEMP_MAX_MB EXPORT_WORKER_MAX_OBJECT_BYTES EXPORT_WORKER_MAX_JOB_BYTES LOG_LEVEL S3_REGION S3_BUCKET_PUBLIC S3_BUCKET_PROTECTED S3_FORCE_PATH_STYLE WEBGL_EXTERNAL_CONNECTIONS_ENABLED WEBGL_PLAY_ENABLED'.split(' '));
const runtimeApiKeys = new Set('TRUST_PROXY DOWNLOAD_AUTO_IP_BAN_ENABLED SESSION_COOKIE_NAME SESSION_IDLE_MS SESSION_ABSOLUTE_MS SESSION_TOUCH_MIN_INTERVAL_MS SHUTDOWN_DRAIN_MS COOKIE_SECURE COOKIE_SAME_SITE ALLOWED_GOOGLE_HD'.split(' '));
const runtimePgKeys = new Set('POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD'.split(' '));
const writeRuntimeFixture = async (fixture) => {
    await mkdir(join(fixtureDir, 'runtime-env'), { recursive: true });
    const values = fixture.split('\n').filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => {
        const equal = line.indexOf('=');
        let value = line.slice(equal + 1);
        if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
        return [line.slice(0, equal), value];
    });
    for (const [file, keys] of [['common', runtimeCommonKeys], ['api', runtimeApiKeys], ['postgres', runtimePgKeys]]) {
        await writeFile(join(fixtureDir, 'runtime-env', `${file}.env`), values.filter(([key]) => keys.has(key)).map(([key,value]) => `${key}=${value}`).join('\n') + '\n');
    }
};
const fixtureReleaseEnv = { API_IMAGE: 'ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:' + 'a'.repeat(64), RELEASE_SCHEMA_PHASE: 'phase2' };
const runBoundary = async (fixture, command = 'boundary-preflight', extraEnv = {}, commandArgs = []) => {
	await writeFile(join(fixtureDir, '.env'), fixture);
	await writeRuntimeFixture(fixture);
	return spawnSync('bash', [deployPath, command, ...commandArgs], {
		encoding: 'utf8',
		env: { ...process.env, ...fixtureReleaseEnv, DEPLOY_DIR: fixtureDir, ...extraEnv },
	});
};
const acceptedBoundary = await runBoundary(boundaryFixture);
assert.equal(acceptedBoundary.status, 0, acceptedBoundary.stderr || acceptedBoundary.stdout);
for (const value of ['1', '0', '-1', '1.5', '1e2', '0x01', 'Infinity']) {
	// `up` invokes this check before image pulls, volume changes or stopping
	// the current containers. No valid release settings are needed to reject it.
	const rejectedProxy = await runBoundary(boundaryFixture.replace(/^TRUST_PROXY=.*$/m, `TRUST_PROXY=${value}`), 'up');
	assert.notEqual(rejectedProxy.status, 0);
	assert.match(rejectedProxy.stderr, /TRUST_PROXY numeric hop counts are unsupported/);
	assert.doesNotMatch(rejectedProxy.stdout, /Starting|Stopping|Pulling|Down complete/);
}
const acceptedProxy = await runBoundary(boundaryFixture.replace(/^TRUST_PROXY=.*$/m, 'TRUST_PROXY=203.250.133.230'));
assert.equal(acceptedProxy.status, 0, acceptedProxy.stderr || acceptedProxy.stdout);
for (const replacement of ['', 'FILE_GATEWAY_SECRET=short']) {
  const missingGatewaySecret = await runBoundary(boundaryFixture.replace(/^FILE_GATEWAY_SECRET=.*$/m, replacement));
  assert.notEqual(missingGatewaySecret.status, 0);
  assert.match(missingGatewaySecret.stdout, /FILE_GATEWAY_SECRET must contain at least 32 characters/);
}
assert.match(deploy, /-e "FILE_GATEWAY_SECRET=\$\{FILE_GATEWAY_SECRET:-\}"/);
assert.doesNotMatch(deploy, /assert_visibility_rollback_safe|assert_phase1_rollback_authorization/);


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
	upFunction.indexOf('validate_production_boundaries') < upFunction.indexOf('stop_application_units'),
	'do_up must validate production boundaries before its application stop phase',
);
assert.ok(
	upFunction.indexOf('validate_release_artifacts "$release_schema_phase"') < upFunction.indexOf('stop_application_units'),
	'do_up must validate the artifact identity and worker set before replacing the deployment',
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
[ -z "\${PODMAN_MARKER:-}" ] || : > "$PODMAN_MARKER"
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
  case " $* " in *psql*) cat >/dev/null; printf '%s\\n' "\${FAKE_MATERIAL_ROWS:-0}" ;; *wget*) printf '%s\\n' '{"ok":true}' ;; esac
  exit 0
fi
if [ "\${1:-}" = run ]; then exit 0; fi
exit 0
`);
await chmod(fakePodman, 0o755);
const releaseDigest = `sha256:${'1'.repeat(64)}`;
const releaseImage = `ghcr.io/pcugame/pcu-graduationproject-v2-api@${releaseDigest}`;
const releaseSourceSha = '2'.repeat(40);
const releaseEnv = {
	PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
	API_IMAGE: releaseImage,
	MIGRATION_IMAGE: releaseImage,
	RELEASE_SOURCE_SHA: releaseSourceSha,
	RELEASE_SCHEMA_PHASE: 'phase2',
	FAKE_IMAGE_DIGEST: releaseDigest,
	FAKE_IMAGE_REVISION: releaseSourceSha,
};
const quadletDir = join(fixtureDir, 'units');
const renderedFixture = spawnSync('bash', [new URL('./quadlet/render.sh', import.meta.url).pathname, quadletDir], {
    encoding: 'utf8', env: { ...process.env, ...releaseEnv, DEPLOY_DIR: fixtureDir, NAS_EXPORT_HOST_PATH: fixtureDir, NAS_EXPORT_PATH: '/nas-export' },
});
assert.equal(renderedFixture.status, 0, renderedFixture.stderr);
releaseEnv.QUADLET_DIR = quadletDir;
await writeFile(join(fakeBin, 'systemctl'), `#!/bin/sh
case "$2" in
show)
case "$4" in
--property=SourcePath)
if [ "$3" = gp-pg-data-volume.service ]; then echo "$QUADLET_DIR/gp-pg-data.volume"; elif [ "$3" = graduationproject-pod.service ]; then echo "$QUADLET_DIR/graduationproject.pod"; else echo "$QUADLET_DIR/\${3%.service}.container"; fi ;;
--property=NeedDaemonReload) echo no ;;
--property=DropInPaths) : ;;
--property=FragmentPath) echo "/run/user/999/systemd/generator/$3" ;;
esac ;;
esac
`);
await chmod(join(fakeBin, 'systemctl'), 0o755);
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

// Retired transition commands fail before any container or database operation.
for (const command of [
	'authorize-phase1-rollback', 'legacy-audit', 'backfill', 'correction',
	'online-contract-preflight', 'contract-preflight', 'verify-observation-window', 'mark-read-cutover',
]) {
	await rm(podmanMarker, { force: true });
	const removed = await runBoundary(boundaryFixture, command, {
		...releaseEnv, PODMAN_MARKER: podmanMarker,
	});
	assert.notEqual(removed.status, 0, `${command} unexpectedly remained available`);
	assert.match(`${removed.stdout}\n${removed.stderr}`, /Usage:/);
	assert.equal(spawnSync('test', ['!', '-e', podmanMarker]).status, 0, `${command} invoked Podman`);
}
for (const [command, overrides, args, error] of [
	['release-artifact-preflight', {}, ['phase1'], /requires phase2/],
	['release-assert', {}, ['phase1'], /requires phase2/],
	['up', { RELEASE_SCHEMA_PHASE: 'phase1' }, [], /must explicitly be phase2/],
	['restart', { RELEASE_SCHEMA_PHASE: 'phase1' }, [], /must explicitly be phase2/],
	['release-artifact-preflight', { START_DEDICATED_WORKERS: 'false' }, ['phase2'], /must be true/],
	['up', { START_DEDICATED_WORKERS: 'false' }, [], /must be true/],
	['restart', { START_DEDICATED_WORKERS: 'false' }, [], /must be true/],
	['release-migrate', {}, ['apply-expand'], /must be status or apply-contract/],
	['release-migrate', {}, ['apply-contract', '--observation-exception-id=retired'], /does not accept transition/],
	['release-migrate', {}, ['status', '--exception-profile=image-bridge-traffic'], /does not accept transition/],
]) {
	await rm(podmanMarker, { force: true });
	const rejected = await runBoundary(boundaryFixture, command, {
		...releaseEnv, ...overrides, PODMAN_MARKER: podmanMarker,
	}, args);
	assert.notEqual(rejected.status, 0, `${command} ${args.join(' ')} bypass unexpectedly passed`);
	assert.match(`${rejected.stdout}\n${rejected.stderr}`, error);
	assert.equal(spawnSync('test', ['!', '-e', podmanMarker]).status, 0, `${command} invoked Podman before rejecting a retired path`);
}

const runCapacity = async (fixture) => {
	await writeFile(join(fixtureDir, '.env'), fixture);
	await writeRuntimeFixture(fixture);
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
