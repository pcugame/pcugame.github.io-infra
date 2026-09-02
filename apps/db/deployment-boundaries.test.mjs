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
	'location /${S3_BUCKET_PROTECTED}/',
	'location = /${S3_BUCKET_PROTECTED}',
	'location = /${S3_BUCKET_PROTECTED}/',
	'if ($request_method !~ ^(GET|HEAD)$) { return 405; }',
	'proxy_pass_request_headers on',
	'proxy_set_header Host $http_host',
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
assert.match(protectedDownload, /method=\$request_method uri=\$uri/);
assert.doesNotMatch(protectedDownload, /\$request_uri|\$args|proxy_cache/);
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
	'200 "public, max-age=31536000, immutable"',
	'206 "public, max-age=31536000, immutable"',
	'default "no-store"',
]) assert.ok(publicOrigin.includes(required), `public origin missing: ${required}`);
assert.doesNotMatch(publicOrigin, /proxy_cache/);
assert.doesNotMatch(publicOrigin, /404 "public, max-age=31536000, immutable"/);
assert.doesNotMatch(publicOrigin, /429 "public, max-age=31536000, immutable"/);
assert.doesNotMatch(publicOrigin, /50[0-9] "public, max-age=31536000, immutable"/);
assert.match(compose, /GARAGE_PUBLIC_BUCKET_HOST: \$\{GARAGE_PUBLIC_BUCKET_HOST:-pcu-public\.web\.garage\.localhost\}/);
assert.match(envValidator, /GARAGE_PUBLIC_BUCKET_HOST.*must equal/);
assert.match(envValidator, /UPLOAD_PART_PER_IP_CONNECTIONS.*-ge 50/);
assert.match(liveTest, /Range: bytes=0-8/);
assert.match(liveTest, /createMultipartPartPresigner/);
assert.match(liveTest, /x-amz-checksum-sha256/);
assert.match(liveTest, /complete-multipart-upload/);
assert.match(liveTest, /If-None-Match/);
assert.match(liveTest, /416/);
assert.match(liveTest, /stop garage/);
assert.match(liveTest, /start garage/);
assert.match(liveTest, /Garage did not recover through the proxy/);

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
