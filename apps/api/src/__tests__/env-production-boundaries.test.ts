import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { parseEnv } from '../config/env.js';

const productionEnv: NodeJS.ProcessEnv = {
	NODE_ENV: 'production',
	DATABASE_URL: 'postgresql://pcu:pcu@postgres:5432/pcu',
	SESSION_SECRET: 'x'.repeat(48),
	GOOGLE_CLIENT_IDS: 'production-client-id',
	CORS_ALLOWED_ORIGINS: 'https://web.production.test',
	API_PUBLIC_URL: 'https://api.production.test',
	WEB_PUBLIC_URL: 'https://web.production.test',
	PUBLIC_ASSET_ORIGIN: 'https://assets.production.test',
	S3_ENDPOINT: 'https://garage.production.test',
	S3_PUBLIC_SIGNING_ENDPOINT: 'https://upload.production.test',
	S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT: 'https://download.production.test',
	S3_ACCESS_KEY_ID: 'test-access-key',
	S3_SECRET_ACCESS_KEY: 'test-secret-key',
};

describe('production data-plane origins', () => {
	it('accepts four distinct HTTPS origins', () => {
		expect(parseEnv(productionEnv).NODE_ENV).toBe('production');
	});

	it.each([
		'S3_ENDPOINT',
		'S3_PUBLIC_SIGNING_ENDPOINT',
		'S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT',
		'PUBLIC_ASSET_ORIGIN',
	] as const)('rejects HTTP for %s in production', (name) => {
		const input = { ...productionEnv, [name]: productionEnv[name]?.replace('https:', 'http:') };
		try {
			parseEnv(input);
			expect.fail(`${name}=http unexpectedly passed`);
		} catch (error) {
			expect(error).toBeInstanceOf(ZodError);
			expect((error as ZodError).issues).toEqual(expect.arrayContaining([
				expect.objectContaining({ path: [name], message: `${name} must use HTTPS in production` }),
			]));
		}
	});

	it.each(['development', 'test'] as const)('allows HTTP origins in %s', (nodeEnv) => {
		const input = Object.fromEntries(Object.entries(productionEnv).map(([name, value]) => [
			name,
			name === 'NODE_ENV' ? nodeEnv : value?.replace('https:', 'http:'),
		]));
		expect(parseEnv(input).NODE_ENV).toBe(nodeEnv);
	});
});

describe('total shutdown budget', () => {
	it('defaults to 15 seconds', () => {
		expect(parseEnv(productionEnv).SHUTDOWN_DRAIN_MS).toBe(15_000);
	});
	it.each(['1', '15000', '60000'])('accepts supported budget %s', (value) => {
		expect(parseEnv({ ...productionEnv, SHUTDOWN_DRAIN_MS: value }).SHUTDOWN_DRAIN_MS).toBe(Number(value));
	});
	it.each(['0', '-1', '60001', '2147483648', '1.5', 'NaN', 'Infinity', '', 'invalid'])('rejects unsafe budget %s', (value) => {
		expect(() => parseEnv({ ...productionEnv, SHUTDOWN_DRAIN_MS: value })).toThrow(ZodError);
	});
});
