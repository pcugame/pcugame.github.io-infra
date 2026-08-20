import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url).pathname;
const script = join(repositoryRoot, 'apps/db/garage-configure-cors.sh');
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function runCorsInit(origins: string) {
	const directory = mkdtempSync(join(tmpdir(), 'pcu-garage-cors-'));
	temporaryDirectories.push(directory);
	const capture = join(directory, 'cors.json');
	const fakeAws = join(directory, 'aws');
	writeFileSync(fakeAws, [
		'#!/bin/sh',
		'set -eu',
		'for argument in "$@"; do',
		'  case "$argument" in',
		'    file://*) cp "${argument#file://}" "$CORS_CAPTURE" ;;',
		'  esac',
		'done',
	].join('\n'));
	chmodSync(fakeAws, 0o755);
	const result = spawnSync('/bin/sh', [script, 'pcu-staging'], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${directory}:${process.env['PATH'] ?? ''}`,
			CORS_CAPTURE: capture,
			S3_INTERNAL_ENDPOINT: 'http://garage.test:3900',
			S3_ACCESS_KEY_ID: 'test-access-key',
			S3_SECRET_ACCESS_KEY: 'test-secret-key',
			S3_CORS_ALLOWED_ORIGINS: origins,
		},
	});
	return { result, capture };
}

describe('Garage direct-upload CORS initialization', () => {
	it('normalizes exact browser origins and emits one S3 CORS rule per origin', () => {
		const { result, capture } = runCorsInit(
			'HTTPS://Example.TEST:443/,http://[::1]:80',
		);
		expect(result.status).toBe(0);
		const config = JSON.parse(readFileSync(capture, 'utf8')) as {
			CORSRules: Array<{ AllowedOrigins: string[]; AllowedMethods: string[]; ExposeHeaders: string[] }>;
		};
		expect(config.CORSRules).toEqual([
			expect.objectContaining({
				AllowedOrigins: ['https://example.test'],
				AllowedMethods: ['PUT', 'HEAD'],
				ExposeHeaders: ['ETag'],
			}),
			expect.objectContaining({ AllowedOrigins: ['http://[::1]'] }),
		]);
	});

	it.each([
		'https://*.example.test',
		'https://user:password@example.test',
		'ftp://example.test',
		'https://example.test/not-an-origin',
		'https://example.test?query=1',
		'https://example.test#fragment',
	])('rejects a non-exact CORS origin: %s', (origin) => {
		const { result } = runCorsInit(origin);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('S3_CORS_ALLOWED_ORIGINS contains an invalid origin');
	});
});
