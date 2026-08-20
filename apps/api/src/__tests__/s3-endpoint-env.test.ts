import { describe, expect, it } from 'vitest';
import { envSchema } from '../config/env.js';
import { createS3Client, createS3PresigningClient } from '../lib/s3.js';

const base = {
	NODE_ENV: 'test',
	DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
	SESSION_SECRET: 'x'.repeat(48),
	GOOGLE_CLIENT_IDS: 'test-client-id',
	CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
	API_PUBLIC_URL: 'http://localhost:4000',
	WEB_PUBLIC_URL: 'http://localhost:5173',
	S3_REGION: 'garage',
	S3_ACCESS_KEY_ID: 'test-access-key',
	S3_SECRET_ACCESS_KEY: 'test-secret-key',
};

describe('S3 endpoint environment contract', () => {
	it('keeps UploadPart capability batches within the operational 8..32 contract', () => {
		expect(envSchema.safeParse({
			...base,
			S3_ENDPOINT: 'https://legacy-s3.example.test',
			UPLOAD_PART_URL_BATCH_MAX: 7,
		}).success).toBe(false);
		expect(envSchema.safeParse({
			...base,
			S3_ENDPOINT: 'https://legacy-s3.example.test',
			UPLOAD_PART_URL_BATCH_MAX: 8,
		}).success).toBe(true);
		expect(envSchema.safeParse({
			...base,
			S3_ENDPOINT: 'https://legacy-s3.example.test',
			UPLOAD_PART_URL_BATCH_MAX: 33,
		}).success).toBe(false);
	});

	it('maps the deprecated S3_ENDPOINT alone to both internal and browser signing endpoints', () => {
		const parsed = envSchema.safeParse({
			...base,
			S3_ENDPOINT: 'https://legacy-s3.example.test',
		});
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.S3_INTERNAL_ENDPOINT).toBe('https://legacy-s3.example.test');
		expect(parsed.data.S3_PUBLIC_SIGNING_ENDPOINT).toBe('https://legacy-s3.example.test');
	});

	it('rejects a new internal endpoint without an explicit public endpoint or legacy alias', () => {
		const parsed = envSchema.safeParse({
			...base,
			S3_INTERNAL_ENDPOINT: 'http://garage.internal:3900',
		});
		expect(parsed.success).toBe(false);
		if (parsed.success) return;
		expect(parsed.error.issues.some((issue) => (
			issue.path.join('.') === 'S3_PUBLIC_SIGNING_ENDPOINT'
		))).toBe(true);
	});

	it('allows an intentional new internal/public split', () => {
		const parsed = envSchema.safeParse({
			...base,
			S3_INTERNAL_ENDPOINT: 'http://garage.internal:3900',
			S3_PUBLIC_SIGNING_ENDPOINT: 'https://uploads.example.test',
		});
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.S3_INTERNAL_ENDPOINT).toBe('http://garage.internal:3900');
		expect(parsed.data.S3_PUBLIC_SIGNING_ENDPOINT).toBe('https://uploads.example.test');
	});

	it('does not let a direct caller create a browser signer from only an internal endpoint', () => {
		const config = {
			S3_INTERNAL_ENDPOINT: 'http://garage.internal:3900',
			S3_REGION: 'garage',
			S3_ACCESS_KEY_ID: 'test-access-key',
			S3_SECRET_ACCESS_KEY: 'test-secret-key',
			S3_FORCE_PATH_STYLE: true,
		};
		const internal = createS3Client(config);
		expect(() => createS3PresigningClient(config)).toThrow(
			'S3_PUBLIC_SIGNING_ENDPOINT is required',
		);
		internal.destroy();
	});
});
