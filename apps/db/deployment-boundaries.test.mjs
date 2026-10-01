import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = (file) => readFile(new URL(file, import.meta.url), 'utf8');
const here = new URL('.', import.meta.url);
const [compose, garage, upload, protectedDownload, publicOrigin, corsScript, initScript, integrationInitScript, initDockerfile, envValidator, liveTest] = await Promise.all([
	read('./docker-compose.yml'),
	read('./garage.toml'),
	read('./upload-part.nginx.conf.template'),
	read('./protected-download.nginx.conf.template'),
	read('./public-origin.nginx.conf.template'),
	read('./garage-configure-cors.sh'),
	read('./garage-init.sh'),
	read('./garage-init-integration.sh'),
	read('./Dockerfile.garage-init'),
	read('./validate-data-plane-env.sh'),
	read('./live-data-plane.test.sh'),
]);

assert.match(compose, /profiles: \["nas-data-plane"\]/);
assert.match(compose, /127\.0\.0\.1:\$\{GARAGE_S3_LOCAL_PORT:-3900\}:3900/);
assert.match(compose, /127\.0\.0\.1:\$\{POSTGRES_LOCAL_PORT:-5432\}:5432/);
assert.doesNotMatch(compose, /- "5432:5432"/);
assert.match(compose, /\$\{NAS_UPLOAD_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{NAS_UPLOAD_PORT:-3901\}:8080/);
assert.match(compose, /\$\{NAS_PUBLIC_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{NAS_PUBLIC_PORT:-3904\}:8080/);
assert.match(compose, /\$\{NAS_PROTECTED_DOWNLOAD_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{NAS_PROTECTED_DOWNLOAD_PORT:-3906\}:8080/);
assert.doesNotMatch(compose, /"3902:3902"|"3903:3903"/);
assert.match(compose, /garage_private:\n\s+internal: true/);
assert.match(compose, /data_plane_edge:\n\s+driver: bridge/);
const garageService = compose.slice(compose.indexOf('\n  garage:\n'), compose.indexOf('\n  garage-init:\n'));
const initService = compose.slice(compose.indexOf('\n  garage-init:\n'), compose.indexOf('\n  upload-part-origin:\n'));
const uploadService = compose.slice(compose.indexOf('\n  upload-part-origin:\n'), compose.indexOf('\n  protected-download-origin:\n'));
const protectedDownloadService = compose.slice(compose.indexOf('\n  protected-download-origin:\n'), compose.indexOf('\n  public-origin:\n'));
const publicService = compose.slice(compose.indexOf('\n  public-origin:\n'), compose.indexOf('\nvolumes:\n'));
assert.doesNotMatch(garageService, /data_plane_edge/);
assert.doesNotMatch(initService, /data_plane_edge/);
assert.match(uploadService, /networks: \[garage_private, data_plane_edge\]/);
assert.match(protectedDownloadService, /networks: \[garage_private, data_plane_edge\]/);
assert.match(publicService, /networks: \[garage_private, data_plane_edge\]/);
assert.match(compose, /UPLOAD_PART_GLOBAL_CONNECTIONS: \$\{UPLOAD_PART_GLOBAL_CONNECTIONS:-512\}/);
assert.match(compose, /UPLOAD_PART_PER_IP_CONNECTIONS: \$\{UPLOAD_PART_PER_IP_CONNECTIONS:-128\}/);
assert.doesNotMatch(compose, /size=512m/);
assert.doesNotMatch(compose, /export[^\n]*:\/[^\n]*/i);
assert.match(compose, /S3_CORS_ALLOWED_ORIGINS: \$\{S3_CORS_ALLOWED_ORIGINS:-http:\/\/localhost:5173\}/);
assert.doesNotMatch(compose, /S3_CORS_ALLOWED_ORIGINS:[^\n]*\*/);
assert.match(garage, /api_bind_addr = "\[::\]:3900"/);
assert.match(garage, /bind_addr = "\[::\]:3902"/);
assert.match(garage, /api_bind_addr = "\[::\]:3903"/);

for (const required of [
	'client_max_body_size ${UPLOAD_PART_MAX_BYTES}',
	'client_body_temp_path /var/cache/nginx/client_temp',
	'limit_conn pcu_upload_global ${UPLOAD_PART_GLOBAL_CONNECTIONS}',
	'limit_conn pcu_upload_per_ip ${UPLOAD_PART_PER_IP_CONNECTIONS}',
	'limit_conn_status 429',
	'proxy_request_buffering off',
	'proxy_connect_timeout 5s',
	'proxy_send_timeout 60s',
	'proxy_read_timeout 60s',
	'if ($request_method !~ ^(PUT|OPTIONS)$) { return 405; }',
	'proxy_next_upstream off',
]) assert.ok(upload.includes(required), `upload boundary missing: ${required}`);
assert.doesNotMatch(upload, /request_method = OPTIONS\) \{ return 204/);
assert.doesNotMatch(upload, /proxy_cache/);
assert.match(upload, /\$uri status=\$status/);
assert.doesNotMatch(upload, /\$request_uri/);

for (const required of [
	'location ~ "^/(?:${S3_BUCKET_PROTECTED}/.+|file/[a-f0-9]{64}|play/[a-f0-9]{64}/.+)$"',
	'location = /${S3_BUCKET_PROTECTED}',
	'location = /${S3_BUCKET_PROTECTED}/',
	'if ($request_method !~ ^(GET|HEAD)$) { return 405; }',
	'proxy_pass_request_headers on',
	'proxy_set_header Host $pcu_validated_upstream_host',
	'proxy_set_header Content-Length ""',
	'proxy_set_header Transfer-Encoding ""',
	'proxy_pass_request_body off',
	'proxy_request_buffering off',
	'proxy_buffering off',
	'proxy_hide_header Cache-Control',
	'Cache-Control "private, no-store" always',
	'proxy_connect_timeout 5s',
	'proxy_read_timeout 120s',
	'proxy_next_upstream off',
]) assert.ok(protectedDownload.includes(required), `protected download boundary missing: ${required}`);
assert.match(protectedDownload, /error_log \/dev\/null crit/);
assert.match(protectedDownload, /client_max_body_size 1k/);
assert.match(protectedDownload, /\$http_content_length ~ \^\[1-9\]\[0-9\]\*\$.*return 413/);
assert.match(protectedDownload, /\$http_transfer_encoding != "".*return 400/);
assert.match(protectedDownload, /method=\$request_method surface=file/);
assert.doesNotMatch(protectedDownload, /\$args|proxy_cache/);
assert.doesNotMatch(protectedDownload.match(/log_format[^;]+;/s)?.[0] ?? '', /\$uri|\$request_uri/);
assert.match(protectedDownload, /location \/ \{ return 404; \}/);
assert.doesNotMatch(protectedDownload, /\^\(GET\|HEAD\|PUT|OPTIONS/);
assert.match(envValidator, /S3_BUCKET_PROTECTED.*DNS-compatible/);
assert.match(envValidator, /PROTECTED_DOWNLOAD_PER_IP_CONNECTIONS.*-ge 50/);

for (const required of [
	'if ($request_method !~ ^(GET|HEAD)$) { return 405; }',
	'proxy_pass_request_headers on',
	'proxy_buffering off',
	'proxy_hide_header Cache-Control',
	'proxy_set_header Host ${GARAGE_PUBLIC_BUCKET_HOST}',
	'proxy_hide_header Access-Control-Allow-Origin',
	'proxy_hide_header Access-Control-Expose-Headers',
	'Access-Control-Expose-Headers "ETag, Last-Modified, Content-Length, Content-Range, Content-Encoding"',
	'Cross-Origin-Resource-Policy "cross-origin"',
	'Content-Security-Policy',
	'Cache-Control "private, no-store" always',
]) assert.ok(publicOrigin.includes(required), `public origin missing: ${required}`);
assert.doesNotMatch(publicOrigin, /proxy_cache/);
assert.doesNotMatch(publicOrigin, /add_header Cache-Control[^;]*(?:immutable|public, max-age)/);
const publicCsp = publicOrigin.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
assert.ok(publicCsp, 'public origin must send an enforced CSP');
const publicScriptSources = publicCsp.split(';').map((directive) => directive.trim().split(/\s+/))
	.find(([name]) => name === 'script-src')?.slice(1);
assert.deepEqual(new Set(publicScriptSources), new Set([
	"'self'", 'blob:', "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'",
]), 'Unity framework blob scripts must be allowed without allowing external script origins');
for (const proxy of [publicOrigin, protectedDownload]) {
 const runtime = proxy.match(/location ~ "\^\/runtime\/\[a-f0-9\]\{64\}\/\.\+\$" \{([\s\S]*?)\n  \}/)?.[1];
 assert.ok(runtime, 'runtime capabilities require a dedicated location');
 assert.ok(runtime.includes('if ($request_method !~ ^(GET|HEAD)$) { return 405; }'));
 assert.doesNotMatch(runtime, /OPTIONS|return 204/);
 for (const required of [
  'auth_request /__pcu_file_auth;',
  'auth_request_set $pcu_runtime_csp $upstream_http_x_pcu_runtime_csp;',
  'Content-Security-Policy $pcu_runtime_effective_csp always;',
  'proxy_hide_header Content-Security-Policy;',
  'proxy_hide_header Service-Worker-Allowed;',
  'proxy_pass_request_body off;',
  'Cross-Origin-Resource-Policy "cross-origin" always;',
  'Cross-Origin-Embedder-Policy "require-corp" always;',
  'Referrer-Policy "no-referrer" always;',
  'Cache-Control "private, no-store" always;',
 ]) assert.ok(runtime.includes(required), `runtime boundary missing: ${required}`);
 assert.match(proxy, /map \$pcu_runtime_csp \$pcu_runtime_effective_csp \{\s*"" "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";/);
 assert.doesNotMatch(runtime, /if\s*\([^)]*\$pcu_runtime_csp/, 'auth_request headers do not exist during rewrite');
 assert.ok(proxy.includes('if ($http_service_worker != "") { return 403; }'));
 assert.ok(proxy.includes('if ($http_sec_fetch_dest = "serviceworker") { return 403; }'));
 assert.ok(proxy.includes('X-PCU-Service-Worker $http_service_worker;'));
 assert.ok(proxy.includes('X-PCU-Fetch-Dest $http_sec_fetch_dest;'));
 assert.ok(proxy.includes('auth_request /__pcu_file_auth;'));
 assert.ok(proxy.includes('location = /__pcu_file_auth {\n    internal;'));
 assert.ok(proxy.includes('X-PCU-Gateway-Secret "${FILE_GATEWAY_SECRET}"'));
 const authLocation = proxy.match(/location = \/__pcu_file_auth \{([\s\S]*?)\n  \}/)?.[1] ?? '';
 assert.ok(authLocation.includes('proxy_ssl_server_name on;'));
 assert.ok(authLocation.includes('proxy_ssl_verify on;'));
 assert.ok(authLocation.includes('proxy_ssl_verify_depth 4;'));
 assert.ok(authLocation.includes('proxy_ssl_name $pcu_gate_tls_name;'));
 assert.ok(proxy.includes('map "${FILE_GATEWAY_TLS_SERVER_NAME}" $pcu_gate_tls_name'));
 assert.ok(authLocation.includes('proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;'));
 assert.ok(proxy.includes('X-PCU-File-Uri $request_uri'));
 assert.ok(proxy.includes('proxy_set_header Cookie ""'));
 assert.ok(proxy.includes('proxy_set_header Authorization ""'));
 assert.ok(proxy.includes('resolver 127.0.0.11'));
 assert.doesNotMatch(proxy.match(/log_format[^;]+;/s)?.[0] ?? '', /\$uri|\$request_uri|\$args/);
}
assert.match(compose, /FILE_GATEWAY_SECRET: \$\{FILE_GATEWAY_SECRET:-\}/);
assert.match(envValidator, /FILE_GATEWAY_SECRET must contain at least 32/);
const gateEnvironment = {
 ...process.env,
 PROTECTED_DOWNLOAD_GLOBAL_CONNECTIONS:'512', PROTECTED_DOWNLOAD_PER_IP_CONNECTIONS:'128',
 S3_BUCKET_PROTECTED:'pcu-protected', FILE_GATEWAY_API_UPSTREAM:'http://api:4000',
 FILE_GATEWAY_SECRET:'test-file-gateway-secret-at-least-32chars',
};
const validateGate = overrides => spawnSync('sh', [new URL('./validate-data-plane-env.sh', import.meta.url).pathname], {env:{...gateEnvironment,...overrides},encoding:'utf8'});
assert.equal(validateGate({}).status,0);
for(const secret of ['', 'short', 'validlength-but-invalid-gateway-secret;injection']) {
 assert.notEqual(validateGate({FILE_GATEWAY_SECRET:secret}).status,0,'invalid gateway secret was accepted');
}
assert.equal(validateGate({FILE_GATEWAY_TLS_SERVER_NAME:'pcu-file-auth.internal'}).status,0);
for (const name of ['bad;name', '$proxy_host', 'name/path', 'name\nother']) {
 assert.notEqual(validateGate({FILE_GATEWAY_TLS_SERVER_NAME:name}).status,0,'unsafe TLS name was accepted');
}
for(const upstream of ['ftp://api:4000','http://api:4000/path','http://api:4000;injection']) {
 assert.notEqual(validateGate({FILE_GATEWAY_API_UPSTREAM:upstream}).status,0,'invalid gateway origin was accepted');
}
assert.match(compose, /GARAGE_PUBLIC_BUCKET_HOST: \$\{GARAGE_PUBLIC_BUCKET_HOST:-pcu-public\.web\.garage\.localhost\}/);
assert.match(envValidator, /GARAGE_PUBLIC_BUCKET_HOST.*must equal/);
assert.match(envValidator, /UPLOAD_PART_PER_IP_CONNECTIONS.*-ge 50/);
assert.match(liveTest, /npm run test:integration/);
assert.match(liveTest, /COMPOSE_PROJECT_NAME/);
assert.match(liveTest, /down .*--volumes/);
assert.doesNotMatch(liveTest, /put-object|immutable-fixture/);

// Garage v1.1 intentionally exposes this through standard S3 Put/GetBucketCors
// rather than an admin CLI. Test policy generation with a fake aws client so
// exact origin normalization and the read-back invariant stay executable.
assert.match(initDockerfile, /FROM dxflrs\/garage:v1\.1\.0 AS garage/);
assert.match(initDockerfile, /apk add --no-cache aws-cli python3/);
assert.match(corsScript, /s3api put-bucket-cors/);
assert.match(corsScript, /s3api get-bucket-cors/);
assert.match(corsScript, /actual != expected/);
assert.match(corsScript, /wildcards are not allowed/);
assert.doesNotMatch(corsScript, /AllowedOrigins[^\n]*\*/);

function runCorsPolicy(kind, origins) {
	const directory = mkdtempSync(join(tmpdir(), 'pcu-garage-cors-boundary-'));
	const capture = join(directory, 'cors.json');
	const fakeAws = join(directory, 'aws');
	writeFileSync(fakeAws, [
		'#!/bin/sh',
		'set -eu',
		'operation=""',
		'policy=""',
		'for argument in "$@"; do',
		'  case "$argument" in',
		'    put-bucket-cors|get-bucket-cors) operation="$argument" ;;',
		'    file://*) policy="${argument#file://}" ;;',
		'  esac',
		'done',
		'if [ "$operation" = put-bucket-cors ]; then cp "$policy" "$CORS_CAPTURE"; else cat "$CORS_CAPTURE"; fi',
	].join('\n'));
	chmodSync(fakeAws, 0o755);
	try {
		const result = spawnSync('/bin/sh', [new URL('./garage-configure-cors.sh', here).pathname, kind, 'fixture-bucket'], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${directory}:${process.env.PATH ?? ''}`,
				CORS_CAPTURE: capture,
				S3_INTERNAL_ENDPOINT: 'http://garage.test:3900',
				S3_ACCESS_KEY_ID: 'fixture-access-key',
				S3_SECRET_ACCESS_KEY: 'fixture-secret-key',
				S3_CORS_ALLOWED_ORIGINS: origins,
			},
		});
		return { result, config: result.status === 0 ? JSON.parse(readFileSync(capture, 'utf8')) : undefined };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const protectedPolicy = runCorsPolicy('protected', 'HTTPS://Example.TEST:443/,https://admin.example.test');
assert.equal(protectedPolicy.result.status, 0, protectedPolicy.result.stderr);
assert.deepEqual(protectedPolicy.config.CORSRules, [
	{
		AllowedMethods: ['PUT', 'HEAD'],
		AllowedHeaders: ['content-type', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token', 'x-amz-user-agent', 'x-amz-checksum-crc32', 'x-amz-checksum-crc32c', 'x-amz-checksum-sha1', 'x-amz-checksum-sha256'],
		ExposeHeaders: ['ETag'],
		MaxAgeSeconds: 300,
		AllowedOrigins: ['https://example.test'],
	},
	{
		AllowedMethods: ['PUT', 'HEAD'],
		AllowedHeaders: ['content-type', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token', 'x-amz-user-agent', 'x-amz-checksum-crc32', 'x-amz-checksum-crc32c', 'x-amz-checksum-sha1', 'x-amz-checksum-sha256'],
		ExposeHeaders: ['ETag'],
		MaxAgeSeconds: 300,
		AllowedOrigins: ['https://admin.example.test'],
	},
]);

const publicPolicy = runCorsPolicy('public', 'http://[::1]:80');
assert.equal(publicPolicy.result.status, 0, publicPolicy.result.stderr);
assert.deepEqual(publicPolicy.config.CORSRules, [
	{
		AllowedMethods: ['GET', 'HEAD'],
		AllowedHeaders: ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since'],
		ExposeHeaders: ['ETag', 'Last-Modified', 'Content-Length', 'Content-Range', 'Content-Encoding'],
		MaxAgeSeconds: 300,
		AllowedOrigins: ['http://[::1]'],
	},
]);
for (const malformed of ['https://*.example.test', 'https://user:password@example.test', 'ftp://example.test', 'https://example.test/path', 'https://example.test,']) {
	const rejected = runCorsPolicy('protected', malformed);
	assert.notEqual(rejected.result.status, 0, `${malformed} unexpectedly accepted`);
	assert.match(rejected.result.stderr, /S3_CORS_ALLOWED_ORIGINS contains an invalid origin/);
}

// Keep existing layout/bucket/key setup guarded while CORS evolves. Neither
// init script may echo a generated key or its secret into Compose logs.
for (const script of [initScript, integrationInitScript]) {
	assert.match(script, /layout assign/);
	assert.match(script, /layout apply/);
	assert.match(script, /bucket create/);
	assert.match(script, /garage-configure-cors protected/);
	assert.match(script, /garage-configure-cors public/);
}
assert.doesNotMatch(initScript, /echo "\$KEY_OUTPUT"/);

console.log('NAS Garage data-plane boundaries: OK');
