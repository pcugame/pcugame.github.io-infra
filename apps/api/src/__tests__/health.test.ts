import type { S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger, ObjectStorage, SettingsStore } from '../application/ports.js';
import { buildApp } from '../app.js';
import { createProductionBackendContext } from '../backend-context.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createScriptedBackendPersistence } from './helpers/backend-persistence.js';
import { createTestUploadLifecycleRuntime } from './helpers/upload-lifecycle.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const headObject = vi.fn(async () => null as { size: number; contentType: string } | null);
const databaseCheck = vi.fn(async () => true);

const logger: AppLogger = {
	child: () => logger,
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	fatal: vi.fn(),
};

const settings: SettingsStore = {
	get: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
	update: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
	invalidate: () => {},
};

function storage(): ObjectStorage {
	return {
		upload: async () => {},
		presign: async () => 'https://storage.test/object',
		delete: async () => {},
		head: headObject,
		readRange: async () => Buffer.alloc(0),
		stream: async () => null,
		listKeys: async () => [],
		listKeyPage: async () => ({ keys: [], isTruncated: false }),
		deleteKeys: async (_bucket, keys) => ({ deleted: [...keys], failures: [] }),
		createMultipart: async () => 'upload-id',
		uploadPart: async () => 'etag',
		completeMultipart: async () => {},
		abortMultipart: async () => {},
		listParts: async () => [],
		listMultipartUploads: async () => [],
	};
}

describe('health endpoints', () => {
	let app: FastifyInstance;

	beforeAll(async () => {
		const context = await createProductionBackendContext({
			...defaultTestEnv,
			LOG_LEVEL: 'info',
			GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
			CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
		}, {
			persistence: createScriptedBackendPersistence({
				databaseHealth: { check: databaseCheck },
			}),
			routes: {
				auth: emptyRoute,
				devAuth: emptyRoute,
				public: emptyRoute,
				admin: emptyRoute,
				me: emptyRoute,
				assets: emptyRoute,
			},
			resources: {
				uploadLifecycle: {
					value: createTestUploadLifecycleRuntime(),
					ownership: 'borrowed',
				},
				logger: { value: logger, ownership: 'borrowed' },
				s3: {
					value: { destroy: vi.fn() } as unknown as S3Client,
					ownership: 'borrowed',
				},
				storage: { value: storage(), ownership: 'borrowed' },
				settings: { value: settings, ownership: 'borrowed' },
			},
		});
		app = await buildApp({ context });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(() => {
		headObject.mockReset().mockResolvedValue(null);
		databaseCheck.mockReset().mockResolvedValue(true);
	});

	it('/api/health does not probe S3 even when S3 is down', async () => {
		headObject.mockRejectedValue(new Error('S3 down'));
		const res = await app.inject({ method: 'GET', url: '/api/health' });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ ok: true, checks: { db: 'ok' } });
		expect(res.json().checks.s3).toBeUndefined();
		expect(headObject).not.toHaveBeenCalled();
	});

	it('/api/health returns 503 when DB fails', async () => {
		databaseCheck.mockResolvedValue(false);
		const res = await app.inject({ method: 'GET', url: '/api/health' });
		expect(res.statusCode).toBe(503);
		expect(res.json()).toMatchObject({ ok: false, checks: { db: 'fail' } });
	});

	it('/api/health/deep reports storage failure when the S3 probe fails', async () => {
		headObject.mockRejectedValue(new Error('S3 down'));
		const res = await app.inject({ method: 'GET', url: '/api/health/deep' });
		expect(res.statusCode).toBe(503);
		expect(res.json()).toMatchObject({
			ok: false,
			checks: { db: 'ok', s3: 'fail' },
		});
	});

	it('/api/health/deep returns 200 with the complete healthy envelope', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/health/deep' });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({
			ok: true,
			state: 'starting',
			checks: { db: 'ok', s3: 'ok' },
		});
		expect(res.json().timestamp).toEqual(expect.any(String));
	});
});
