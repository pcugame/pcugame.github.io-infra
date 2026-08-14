import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import {
	isResponseSerializationError,
	serializerCompiler,
	validatorCompiler,
} from '@fastify/type-provider-zod';
import type { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppLogger, ObjectStorage, SettingsStore } from '../application/ports.js';
import { buildApp } from '../app.js';
import { createProductionBackendContext, type ResourceLease } from '../backend-context.js';
import {
	ROUTE_RUNTIME_CONTRACTS,
	registerRouteSchemas,
	routeRuntimeContractsFor,
} from '../shared/http-route-schemas.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createScriptedBackendPersistence } from './helpers/backend-persistence.js';
import { createTestUploadLifecycleRuntime } from './helpers/upload-lifecycle.js';

function borrowed<T>(value: T): ResourceLease<T> {
	return { value, ownership: 'borrowed' };
}

function createLogger(): AppLogger {
	const logger: AppLogger = {
		child: () => logger,
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		fatal: () => {},
	};
	return logger;
}

function createStorageStub(): ObjectStorage {
	return {
		upload: async () => {},
		presign: async () => 'https://storage.test/object',
		delete: async () => {},
		head: async () => ({ size: 0, contentType: 'application/octet-stream' }),
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

async function createContractApp(
	nodeEnv: 'test' | 'production',
	devAuthEnabled: boolean,
): Promise<FastifyInstance> {
	const logger = createLogger();
	const settings: SettingsStore = {
		get: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
		update: async (patch) => ({
			maxGameFileMb: patch.maxGameFileMb ?? 5120,
			maxChunkSizeMb: patch.maxChunkSizeMb ?? 10,
		}),
		invalidate: () => {},
	};
	const basePersistence = createScriptedBackendPersistence();
	const persistence = createScriptedBackendPersistence({
		authRepository: {
			...basePersistence.authRepository,
			find: async (id) => id === 'route-contract-session'
				? {
					id,
					expiresAt: new Date('2100-01-01T00:00:00.000Z'),
					lastSeenAt: new Date(),
					user: {
						id: 1,
						googleSub: 'route-contract-admin',
						email: 'admin@example.test',
						name: 'Admin',
						role: 'ADMIN',
						studentId: null,
					},
				}
				: null,
		},
	});
	const context = await createProductionBackendContext({
		...defaultTestEnv,
		NODE_ENV: nodeEnv,
		DEV_AUTH_ENABLED: devAuthEnabled,
		LOG_LEVEL: 'info',
		NAS_EXPORT_PATH: '/tmp/pcu-route-contract-export',
		GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
		CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
	}, {
		persistence,
		resources: {
			uploadLifecycle: borrowed(createTestUploadLifecycleRuntime()),
			logger: borrowed(logger),
			s3: borrowed({} as S3Client),
			storage: borrowed(createStorageStub()),
			settings: borrowed(settings),
		},
	});
	return buildApp({ context });
}

describe('production HTTP runtime contracts', () => {
	let app: FastifyInstance;
	let productionApp: FastifyInstance;

	beforeAll(async () => {
		[app, productionApp] = await Promise.all([
			createContractApp('test', true),
			createContractApp('production', true),
		]);
	});

	afterAll(async () => {
		await Promise.all([app.close(), productionApp.close()]);
	});

	it('maps the complete registry into development and production without duplicate route keys', () => {
		const keys = ROUTE_RUNTIME_CONTRACTS.map(({ method, url }) => `${method} ${url}`);
		expect(new Set(keys).size).toBe(keys.length);

		const developmentRoutes = routeRuntimeContractsFor({ includeDevAuth: true });
		const productionRoutes = routeRuntimeContractsFor({ includeDevAuth: false });
		expect(developmentRoutes).toEqual(ROUTE_RUNTIME_CONTRACTS);
		expect(productionRoutes).toEqual(
			ROUTE_RUNTIME_CONTRACTS.filter(({ family }) => family !== 'dev-auth'),
		);

		for (const route of developmentRoutes) {
			const routerUrl = route.url === '*' ? '/*' : route.url;
			expect(
				app.hasRoute({ method: route.method, url: routerUrl }),
				`${route.method} ${route.url}`,
			).toBe(true);
		}
		for (const route of productionRoutes) {
			const routerUrl = route.url === '*' ? '/*' : route.url;
			expect(
				productionApp.hasRoute({ method: route.method, url: routerUrl }),
				`${route.method} ${route.url}`,
			).toBe(true);
		}
		for (const route of ROUTE_RUNTIME_CONTRACTS.filter(({ family }) => family === 'dev-auth')) {
			expect(productionApp.hasRoute({ method: route.method, url: route.url })).toBe(false);
		}
		const productionGets = productionRoutes.filter(({ method }) => method === 'GET');
		for (const route of productionGets) {
			expect(productionApp.hasRoute({ method: 'HEAD', url: route.url })).toBe(true);
		}
	});

	it('classifies every input/output boundary without an unknown fallback', () => {
		for (const route of ROUTE_RUNTIME_CONTRACTS) {
			expect(route.params).toBeDefined();
			expect(route.querystring).toBeDefined();
			expect(route.response).toBeDefined();
			expect(route.bodyBoundary).toMatch(
				/^(none|json|multipart|octet-stream|cors-plugin)$/,
			);
			expect(route.responseBoundary).toMatch(
				/^(json|no-content|redirect|stream|errors-only|cors-plugin)$/,
			);
			if (route.bodyBoundary === 'multipart') {
				expect(route.body).toBeUndefined();
			}
			if (route.bodyBoundary === 'json' || route.bodyBoundary === 'octet-stream') {
				expect(route.body).toBeDefined();
			}
		}
	});

	it('rejects malformed numeric params/query before production handlers', async () => {
		const malformed = [
			'/api/public/years/2026x/projects',
			'/api/public/years/+2026/projects',
			'/api/public/years/2026.5/projects',
			'/api/public/years/999999999999999999999/projects',
			'/api/public/exhibitions/1x/projects',
			'/api/public/exhibitions/-1/projects',
			'/api/public/exhibitions/1.5/projects',
			'/api/public/exhibitions/999999999999999999999/projects',
			'/api/public/projects/example?year=2026x',
			'/api/admin/projects/1x',
			'/api/admin/projects?limit=9007199254740992',
		];
		for (const url of malformed) {
			const response = await app.inject({ method: 'GET', url });
			expect(response.statusCode, `${url}: ${response.body}`).toBe(400);
		}

		const empty = await app.inject({
			method: 'GET',
			url: '/api/public/years//projects',
		});
		expect(empty.statusCode).toBe(400);
	});

	it('leaves non-canonical numeric-looking project identifiers available as slugs', async () => {
		for (const slug of ['0001', '1e3', '+1', '1.0', '0x10', '9007199254740992']) {
			const response = await app.inject({
				method: 'GET',
				url: `/api/public/projects/${encodeURIComponent(slug)}`,
			});
			expect(response.statusCode, `${slug}: ${response.body}`).toBe(404);
		}
	});

	it('rejects malformed JSON, chunk index, and wrong octet-stream bodies', async () => {
		const malformedJson = await app.inject({
			method: 'POST',
			url: '/api/auth/google',
			headers: {
				origin: 'http://localhost:5173',
				'content-type': 'application/json',
			},
			payload: '{"credential":',
		});
		expect(malformedJson.statusCode, malformedJson.body).toBe(400);
		expect(malformedJson.json()).toMatchObject({
			ok: false,
			error: { code: 'VALIDATION_ERROR' },
		});

		const login = await app.inject({
			method: 'POST',
			url: '/api/auth/google',
			headers: { origin: 'http://localhost:5173' },
			payload: {},
		});
		expect(login.statusCode).toBe(400);

		const settings = await app.inject({
			method: 'PATCH',
			url: '/api/admin/settings',
			headers: { origin: 'http://localhost:5173' },
			payload: {},
		});
		expect(settings.statusCode).toBe(400);

		for (const index of ['1x', '-1', '+1', '1.5', '999999999999999999999']) {
			const response = await app.inject({
				method: 'PUT',
				url: `/api/admin/game-upload-sessions/session/chunks/${index}`,
				headers: {
					origin: 'http://localhost:5173',
					'content-type': 'application/octet-stream',
				},
				payload: Buffer.from([1]),
			});
			expect(response.statusCode, `${index}: ${response.body}`).toBe(400);
		}

		const wrongTransport = await app.inject({
			method: 'PUT',
			url: '/api/admin/game-upload-sessions/session/chunks/0',
			headers: {
				origin: 'http://localhost:5173',
				'content-type': 'application/json',
			},
			payload: {},
		});
		expect(wrongTransport.statusCode).toBe(400);

		const unsupportedTransport = await app.inject({
			method: 'PUT',
			url: '/api/admin/game-upload-sessions/session/chunks/0',
			headers: {
				origin: 'http://localhost:5173',
				'content-type': 'application/x-www-form-urlencoded',
			},
			payload: 'chunk=1',
		});
		expect(unsupportedTransport.statusCode, unsupportedTransport.body).toBe(415);
		expect(unsupportedTransport.json()).toMatchObject({
			ok: false,
			error: { code: 'UNSUPPORTED_MEDIA_TYPE' },
		});

		const nonMultipartTransport = await app.inject({
			method: 'POST',
			url: '/api/admin/import/preview',
			headers: {
				origin: 'http://localhost:5173',
				cookie: 'sid=route-contract-session',
				'content-type': 'application/json',
			},
			payload: {},
		});
		expect(nonMultipartTransport.statusCode, nonMultipartTransport.body).toBe(415);
		expect(nonMultipartTransport.json()).toMatchObject({
			ok: false,
			error: { code: 'UNSUPPORTED_MEDIA_TYPE' },
		});

		const boundary = 'route-contract-invalid-json-field';
		const invalidMultipartJson = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			headers: {
				origin: 'http://localhost:5173',
				cookie: 'sid=route-contract-session',
				'content-type': `multipart/form-data; boundary=${boundary}`,
				'idempotency-key': 'invalid-multipart-json',
			},
			payload: Buffer.from(
				`--${boundary}\r\n`
				+ 'Content-Disposition: form-data; name="payload"\r\n'
				+ 'Content-Type: application/json\r\n\r\n'
				+ '{"title":\r\n'
				+ `--${boundary}--\r\n`,
			),
		});
		expect(invalidMultipartJson.statusCode, invalidMultipartJson.body).toBe(400);
		expect(invalidMultipartJson.json()).toMatchObject({
			ok: false,
			error: { code: 'VALIDATION_ERROR' },
		});
	});

	it('rejects non-canonical numeric JSON fields before auth or service code', async () => {
		const malformed = [
			{
				method: 'PATCH' as const,
				url: '/api/admin/projects/1/poster',
				payload: { assetId: '1e2' },
			},
			{
				method: 'PATCH' as const,
				url: '/api/admin/projects/1/members/swap',
				payload: { memberIdA: '+1', memberIdB: '2' },
			},
			{
				method: 'POST' as const,
				url: '/api/admin/projects/1/game-upload-sessions',
				payload: { originalName: 'game.zip', totalBytes: 1.5 },
			},
			{
				method: 'POST' as const,
				url: '/api/admin/export',
				payload: { year: '2e3' },
			},
			{
				method: 'POST' as const,
				url: '/api/admin/projects/bulk/delete',
				payload: { ids: [Number.MAX_SAFE_INTEGER + 1] },
			},
			{
				method: 'POST' as const,
				url: '/api/dev/auth/login',
				payload: { role: 'ROOT' },
			},
		];
		for (const request of malformed) {
			const response = await app.inject({
				...request,
				headers: { origin: 'http://localhost:5173' },
			});
			expect(response.statusCode, `${request.url}: ${response.body}`).toBe(400);
		}
	});

	it('executes an input rejection through every production route family', async () => {
		const cases = [
			{ family: 'health', method: 'GET', url: '/api/health?unexpected=1' },
			{ family: 'auth', method: 'POST', url: '/api/auth/google', payload: {} },
			{
				family: 'dev-auth',
				method: 'POST',
				url: '/api/dev/auth/login',
				payload: { role: 'ROOT' },
			},
			{ family: 'public', method: 'GET', url: '/api/public/years?unexpected=1' },
			{ family: 'public-webgl', method: 'GET', url: '/api/public/webgl/1x' },
			{ family: 'assets', method: 'DELETE', url: '/api/admin/assets/1x' },
			{
				family: 'me-project',
				method: 'POST',
				url: '/api/me/projects/submit?unexpected=1',
			},
			{
				family: 'admin-exhibitions',
				method: 'POST',
				url: '/api/admin/exhibitions',
				payload: { year: '2026' },
			},
			{
				family: 'admin-projects',
				method: 'GET',
				url: '/api/admin/projects?year=2026x',
			},
			{
				family: 'admin-members',
				method: 'POST',
				url: '/api/admin/projects/1x/members',
				payload: { name: 'Student', studentId: '20260001' },
			},
			{
				family: 'game-upload',
				method: 'POST',
				url: '/api/admin/projects/1/game-upload-sessions',
				payload: { originalName: 'game.zip', totalBytes: 1.5 },
			},
			{
				family: 'admin-banned-ips',
				method: 'DELETE',
				url: '/api/admin/banned-ips/1x',
			},
			{
				family: 'admin-settings',
				method: 'PATCH',
				url: '/api/admin/settings',
				payload: {},
			},
			{
				family: 'admin-import',
				method: 'POST',
				url: '/api/admin/import/preview?unexpected=1',
			},
			{
				family: 'admin-export',
				method: 'POST',
				url: '/api/admin/export',
				payload: { year: '2e3' },
			},
		] as const;

		for (const testCase of cases) {
			const response = await app.inject({
				method: testCase.method,
				url: testCase.url,
				headers: { origin: 'http://localhost:5173' },
				...('payload' in testCase ? { payload: testCase.payload } : {}),
			});
			expect(
				response.statusCode,
				`${testCase.family}: ${response.body}`,
			).toBe(400);
		}
	});

	it('enforces no-body contracts while keeping an absent body valid', async () => {
		const withoutBody = await app.inject({
			method: 'POST',
			url: '/api/auth/logout',
			headers: { origin: 'http://localhost:5173' },
		});
		expect(withoutBody.statusCode, withoutBody.body).toBe(200);

		const withGarbage = await app.inject({
			method: 'POST',
			url: '/api/auth/logout',
			headers: { origin: 'http://localhost:5173' },
			payload: { garbage: true },
		});
		expect(withGarbage.statusCode, withGarbage.body).toBe(400);
	});

	it('keeps the documented export body optional at the Fastify boundary', async () => {
		const exportApp = Fastify();
		exportApp.setValidatorCompiler(validatorCompiler);
		exportApp.setSerializerCompiler(serializerCompiler);
		registerRouteSchemas(exportApp);
		exportApp.post<{ Body: { year?: number; dryRun?: boolean } }>(
			'/api/admin/export',
			async (request) => ({
				ok: true,
				data: {
					projects: 0,
					totalFiles: 0,
					downloaded: 0,
					skipped: 0,
					failed: 0,
					aborted: request.body.dryRun ?? false,
					paths: [],
				},
			}),
		);
		await exportApp.ready();
		try {
			const response = await exportApp.inject({
				method: 'POST',
				url: '/api/admin/export',
			});
			expect(response.statusCode, response.body).toBe(200);
			expect(response.json()).toMatchObject({
				ok: true,
				data: { aborted: false },
			});
		} finally {
			await exportApp.close();
		}
	});

	it('rejects an un-inventoried route even when it supplies broad schema slots', async () => {
		const guardApp = Fastify();
		registerRouteSchemas(guardApp);
		try {
			expect(() => guardApp.post('/outside-inventory', {
				schema: {
					params: z.unknown(),
					querystring: z.unknown(),
					body: z.unknown(),
					response: { 200: z.unknown() },
				},
			}, async () => ({ accepted: true }))).toThrow(/has no runtime contract/);
			expect(() => guardApp.route({
				method: ['GET', 'POST'],
				url: '/api/public/years',
				handler: async () => ({ ok: true, data: { items: [] } }),
			})).toThrow(/POST .* has no runtime contract/);
		} finally {
			await guardApp.close();
		}
	});

	it('keeps CORS, health, stream, and response serialization boundaries executable', async () => {
		const preflight = await app.inject({
			method: 'OPTIONS',
			url: '/api/arbitrary-preflight-target',
			headers: {
				origin: 'http://localhost:5173',
				'access-control-request-method': 'GET',
			},
		});
		expect(preflight.statusCode).toBe(204);

		const malformedPreflight = await app.inject({
			method: 'OPTIONS',
			url: '/api/arbitrary-preflight-target',
			headers: { origin: 'http://localhost:5173' },
		});
		expect(malformedPreflight.statusCode).toBe(400);

		const pluginOwnedQueryPreflight = await app.inject({
			method: 'OPTIONS',
			url: '/api/arbitrary-preflight-target?unexpected=1',
			headers: {
				origin: 'http://localhost:5173',
				'access-control-request-method': 'GET',
			},
		});
		expect(
			pluginOwnedQueryPreflight.statusCode,
			pluginOwnedQueryPreflight.body,
		).toBe(204);

		const health = await app.inject({ method: 'GET', url: '/api/health' });
		expect(health.statusCode, health.body).toBe(200);

		const streamApp = Fastify();
		streamApp.setValidatorCompiler(validatorCompiler);
		streamApp.setSerializerCompiler(serializerCompiler);
		registerRouteSchemas(streamApp);
		streamApp.setErrorHandler((error, _request, reply) => {
			const validationFailure = (
				typeof error === 'object'
				&& error !== null
				&& 'validation' in error
				&& Boolean(error.validation)
			);
			reply.status(validationFailure ? 400 : 500).send({
				ok: false,
				error: {
					code: validationFailure ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
					message: validationFailure ? 'Validation failed' : 'Internal server error',
				},
			});
		});
		streamApp.get('/api/public/webgl/:projectId', async (_request, reply) => (
			reply.type('application/octet-stream').send(Readable.from(['streamed']))
		));
		await streamApp.ready();
		try {
			const streamed = await streamApp.inject({
				method: 'GET',
				url: '/api/public/webgl/7',
			});
			expect(streamed.statusCode).toBe(200);
			expect(streamed.body).toBe('streamed');
			const malformed = await streamApp.inject({
				method: 'GET',
				url: '/api/public/webgl/7x',
			});
			expect(malformed.statusCode).toBe(400);
		} finally {
			await streamApp.close();
		}
	});

	it('turns a handler/schema response mismatch into a serialization failure', async () => {
		const responseApp = Fastify();
		responseApp.setValidatorCompiler(validatorCompiler);
		responseApp.setSerializerCompiler(serializerCompiler);
		registerRouteSchemas(responseApp);
		let serializationError: unknown;
		let invalid = false;
		responseApp.setErrorHandler((error, _request, reply) => {
			serializationError = error;
			reply.status(500).send({
				ok: false,
				error: {
					code: 'INTERNAL_ERROR',
					message: 'Internal server error',
				},
			});
		});
		responseApp.get('/api/public/years', async () => (
			invalid
				? { ok: true, data: { items: [{ id: 'not-an-integer' }] } }
				: {
					ok: true,
					data: {
						items: [{
							id: 1,
							year: 2026,
							title: '2026',
							projectCount: 0,
						}],
					},
				}
		));
		await responseApp.ready();
		try {
			const happy = await responseApp.inject({
				method: 'GET',
				url: '/api/public/years',
			});
			expect(happy.statusCode, happy.body).toBe(200);

			invalid = true;
			const mismatch = await responseApp.inject({
				method: 'GET',
				url: '/api/public/years',
			});
			expect(mismatch.statusCode, mismatch.body).toBe(500);
			expect(isResponseSerializationError(serializationError)).toBe(true);
		} finally {
			await responseApp.close();
		}
	});

	it('rejects representative response drift for every JSON route family', async () => {
		const happyResponses = {
			health: {
				ok: true,
				state: 'ready',
				timestamp: '2026-07-31T00:00:00.000Z',
				checks: { db: 'ok' },
			},
			auth: { ok: true, data: { authenticated: false } },
			'dev-auth': {
				ok: true,
				data: {
					user: {
						id: 1,
						email: 'student@g.pcu.ac.kr',
						name: 'Student',
						role: 'USER',
					},
				},
			},
			public: { ok: true, data: { items: [] } },
			'me-project': {
				ok: true,
				data: {
					id: 1,
					slug: 'game',
					year: 2026,
					status: 'PUBLISHED',
					adminEditUrl: 'https://api.example.test/admin/projects/1',
				},
			},
			'admin-exhibitions': { ok: true, data: { items: [] } },
			'admin-projects': {
				ok: true,
				data: {
					items: [],
					pagination: {
						page: 1,
						limit: 20,
						totalItems: 0,
						totalPages: 0,
						hasNextPage: false,
						hasPreviousPage: false,
					},
				},
			},
			'admin-members': { ok: true, data: { id: 1 } },
			'game-upload': {
				ok: true,
				data: {
					sessionId: 'session',
					projectId: 1,
					uploadKind: 'GAME',
					originalName: 'game.zip',
					totalBytes: 1,
					chunkSizeBytes: 1,
					totalChunks: 1,
					uploadedChunks: [],
					uploadedCount: 0,
					status: 'PENDING',
					expiresAt: '2026-07-31T00:00:00.000Z',
				},
			},
			'admin-banned-ips': { ok: true, data: { items: [] } },
			'admin-settings': {
				ok: true,
				data: { maxGameFileMb: 5120, maxChunkSizeMb: 10 },
			},
			'admin-import': {
				ok: true,
				data: { valid: true, exhibitions: [], projectCount: 0, errors: [] },
			},
			'admin-export': { ok: true, data: { running: false, progress: null } },
		} as const;
		const successStatuses = {
			'me-project': 201,
			'admin-members': 201,
		} as const;
		const cases = [
			{ family: 'health', method: 'GET', routeUrl: '/api/health', requestUrl: '/api/health' },
			{ family: 'auth', method: 'GET', routeUrl: '/api/me', requestUrl: '/api/me' },
			{
				family: 'dev-auth',
				method: 'POST',
				routeUrl: '/api/dev/auth/login',
				requestUrl: '/api/dev/auth/login',
				payload: { role: 'USER' },
			},
			{
				family: 'public',
				method: 'GET',
				routeUrl: '/api/public/years',
				requestUrl: '/api/public/years',
			},
			{
				family: 'me-project',
				method: 'POST',
				routeUrl: '/api/me/projects/submit',
				requestUrl: '/api/me/projects/submit',
			},
			{
				family: 'admin-exhibitions',
				method: 'GET',
				routeUrl: '/api/admin/exhibitions',
				requestUrl: '/api/admin/exhibitions',
			},
			{
				family: 'admin-projects',
				method: 'GET',
				routeUrl: '/api/admin/projects',
				requestUrl: '/api/admin/projects',
			},
			{
				family: 'admin-members',
				method: 'POST',
				routeUrl: '/api/admin/projects/:id/members',
				requestUrl: '/api/admin/projects/1/members',
				payload: { name: 'Student', studentId: '20260001' },
			},
			{
				family: 'game-upload',
				method: 'GET',
				routeUrl: '/api/admin/game-upload-sessions/:sessionId',
				requestUrl: '/api/admin/game-upload-sessions/session',
			},
			{
				family: 'admin-banned-ips',
				method: 'GET',
				routeUrl: '/api/admin/banned-ips',
				requestUrl: '/api/admin/banned-ips',
			},
			{
				family: 'admin-settings',
				method: 'GET',
				routeUrl: '/api/admin/settings',
				requestUrl: '/api/admin/settings',
			},
			{
				family: 'admin-import',
				method: 'POST',
				routeUrl: '/api/admin/import/preview',
				requestUrl: '/api/admin/import/preview',
			},
			{
				family: 'admin-export',
				method: 'GET',
				routeUrl: '/api/admin/export/status',
				requestUrl: '/api/admin/export/status',
			},
		] as const;

		for (const testCase of cases) {
			const familyApp = Fastify();
			familyApp.setValidatorCompiler(validatorCompiler);
			familyApp.setSerializerCompiler(serializerCompiler);
			registerRouteSchemas(familyApp);
			let serializationError: unknown;
			let invalid = false;
			familyApp.setErrorHandler((error, _request, reply) => {
				serializationError = error;
				reply.status(500).send({
					ok: false,
					error: {
						code: 'INTERNAL_ERROR',
						message: 'Internal server error',
					},
				});
			});
			familyApp.route({
				method: testCase.method,
				url: testCase.routeUrl,
				handler: async (_request, reply) => {
					const status = testCase.family in successStatuses
						? successStatuses[
							testCase.family as keyof typeof successStatuses
						]
						: 200;
					reply.status(status);
					return invalid
						? { ok: true, data: { contractDrift: true } }
						: happyResponses[testCase.family];
				},
			});
			await familyApp.ready();
			try {
				const request = {
					method: testCase.method,
					url: testCase.requestUrl,
					...(testCase.family === 'me-project'
						? { headers: { 'idempotency-key': 'response-contract' } }
						: {}),
					...('payload' in testCase ? { payload: testCase.payload } : {}),
				};
				const happy = await familyApp.inject(request);
				const expectedStatus = testCase.family in successStatuses ? 201 : 200;
				expect(happy.statusCode, `${testCase.family}: ${happy.body}`).toBe(expectedStatus);

				invalid = true;
				const response = await familyApp.inject(request);
				expect(
					response.statusCode,
					`${testCase.family}: ${response.body}`,
				).toBe(500);
				expect(
					isResponseSerializationError(serializationError),
					testCase.family,
				).toBe(true);
			} finally {
				await familyApp.close();
			}
		}
	});
});
