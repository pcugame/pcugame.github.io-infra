import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	AppLogger,
	ObjectStorage,
	ObjectStreamRequest,
	Scheduler,
	SettingsStore,
} from '../application/ports.js';
import { buildApp } from '../app.js';
import { createProductionBackendContext, type BackendRoutes } from '../backend-context.js';
import type { Env } from '../config/env.js';
import type { PublicProductionRepository } from '../modules/public/composition.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createScriptedBackendPersistence } from './helpers/backend-persistence.js';
import { ownedTestUploadLifecycleResource } from './helpers/upload-lifecycle.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const deployment = '123e4567-e89b-42d3-a456-426614174000';
const origin = 'http://localhost:5173';

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

function config(label: string): Env {
	return {
		...defaultTestEnv,
		LOG_LEVEL: 'info',
		API_PUBLIC_URL: `https://api-${label}.test`,
		WEB_PUBLIC_URL: `https://web-${label}.test`,
		S3_BUCKET_PUBLIC: `${label}-public`,
		GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
		CORS_ALLOWED_ORIGINS: [origin],
	};
}

function repositoryHarness(label: string) {
	const calls = {
		findExhibitionsWithPublishedCounts: vi.fn(async () => [{
			id: 1,
			year: 2026,
			title: `${label} Show`,
			posterStorageKey: `${label}-poster.webp`,
			posterWidth: 1200,
			posterHeight: 800,
			posterCard480Height: null,
			posterDisplay960Height: null,
			_count: { projects: 1 },
		}]),
		findExhibitionsByYear: vi.fn(async (year: number) => [
			{ id: 1, year, title: `${label} Show` },
		]),
		findExhibitionById: vi.fn(async (id: number) => ({ id, year: 2026, title: `${label} Show` })),
		resolvePublicImage: vi.fn(async (
			storageKey: string,
		): Promise<{ storageKey: string } | null> => ({ storageKey })),
		findPublishedProjectsInExhibitions: vi.fn(async () => [{
			id: 7,
			slug: `${label}-game`,
			title: `${label} Game`,
			summary: `${label} Summary`,
			exhibitionId: 1,
			poster: null,
			members: [{ name: `${label} Member`, studentId: '20260001' }],
		}]),
		findPublishedProject: vi.fn(async () => ({
				id: 7,
				exhibitionId: 1,
				slug: `${label}-game`,
				title: `${label} Game`,
				summary: `${label} Summary`,
				description: `${label} Description`,
				isIncomplete: false,
				status: 'PUBLISHED' as const,
				webglEntryKey: `webgl/7/${deployment}/site/index.html`,
				exhibition: { year: 2026 },
				members: [{ id: 1, name: `${label} Member`, studentId: '20260001' }],
				assets: [],
				poster: null,
			})),
		findPublicWebglProject: vi.fn(async (): Promise<{
			id: number;
			webglEntryKey: string;
		} | null> => ({
			id: 7,
			webglEntryKey: `webgl/7/${deployment}/site/index.html`,
		})),
	};
	const repository: PublicProductionRepository = {
		findExhibitionsWithPublishedCounts: calls.findExhibitionsWithPublishedCounts,
		findExhibitionsByYear: calls.findExhibitionsByYear,
		findPublishedProjectsInExhibitions: calls.findPublishedProjectsInExhibitions,
		findExhibitionById: calls.findExhibitionById,
		resolvePublicImage: calls.resolvePublicImage,
		findPublishedProjectById: calls.findPublishedProject,
		findPublishedProjectBySlug: calls.findPublishedProject,
		findPublicWebglProject: calls.findPublicWebglProject,
	};
	return { repository, calls };
}

function storageHarness(label: string) {
	const objectBody = Buffer.from('0123456789');
	const lastModified = new Date('2026-07-22T00:00:00.000Z');
	const calls = {
		presign: vi.fn(async (bucket: string, key: string) => `https://storage.test/${bucket}/${key}`),
		head: vi.fn(async () => ({
			size: 10,
			contentType: 'image/webp',
			etag: `"${label}-etag"`,
			lastModified,
		})),
		stream: vi.fn(async (
			_bucket: string,
			_key: string,
			options?: ObjectStreamRequest,
		) => {
			if (
				options?.ifNoneMatch === '*'
				|| options?.ifNoneMatch?.split(',').map((value) => value.trim()).includes(`"${label}-etag"`)
				|| (options?.ifModifiedSince !== undefined && lastModified <= options.ifModifiedSince)
			) {
				return { kind: 'not-modified' as const, etag: `"${label}-etag"`, lastModified };
			}
			let range: { start: number; end: number } | undefined;
			if (options?.range) {
				const start = options.range.kind === 'suffix'
					? Math.max(0, 10 - Number(options.range.length))
					: Number(options.range.start);
				const end = options.range.kind === 'closed'
					? Math.min(Number(options.range.end), 9)
					: 9;
				if (start >= 10) {
					return {
						kind: 'range-not-satisfiable' as const,
						size: 10,
						contentRange: 'bytes */10',
						etag: `"${label}-etag"`,
						lastModified,
					};
				}
				range = { start, end };
			}
			const responseBody = range
				? objectBody.subarray(range.start, range.end + 1)
				: objectBody;
			return {
				body: Readable.from([responseBody]),
				size: responseBody.byteLength,
				contentType: 'image/webp',
				contentRange: range ? `bytes ${range.start}-${range.end}/10` : undefined,
				etag: `"${label}-etag"`,
				lastModified,
			};
		}),
	};
	const storage: ObjectStorage = {
		upload: vi.fn(),
		presign: calls.presign,
		delete: vi.fn(),
		head: calls.head,
		readRange: vi.fn(async () => Buffer.alloc(0)),
		stream: calls.stream,
		listKeys: vi.fn(async () => []),
		listKeyPage: vi.fn(async () => ({ keys: [], isTruncated: false })),
		deleteKeys: vi.fn(async (_bucket, keys) => ({ deleted: [...keys], failures: [] })),
		createMultipart: vi.fn(async () => 'upload-id'),
		uploadPart: vi.fn(async () => 'etag'),
		completeMultipart: vi.fn(),
		abortMultipart: vi.fn(),
		listParts: vi.fn(async () => []),
		listMultipartUploads: vi.fn(async () => []),
	};
	return { storage, calls };
}

async function harness(label: string) {
	const repository = repositoryHarness(label);
	const storage = storageHarness(label);
	const scheduler: Scheduler = {
		every: vi.fn(() => ({ cancel: vi.fn() })),
		delay: vi.fn(async () => {}),
	};
	const s3 = { send: vi.fn(), destroy: vi.fn() } as unknown as S3Client;
	const context = await createProductionBackendContext(config(label), {
		persistence: createScriptedBackendPersistence({
			publicRepository: repository.repository,
		}),
		factories: {
			routes: (_config, _assets, _auth, publicGraph): BackendRoutes => ({
				auth: emptyRoute,
				devAuth: emptyRoute,
				public: publicGraph.controller,
				admin: emptyRoute,
				me: emptyRoute,
				assets: emptyRoute,
			}),
		},
		resources: {
			uploadLifecycle: ownedTestUploadLifecycleResource(),
			logger: { value: logger, ownership: 'borrowed' },
			clock: {
				value: { now: () => new Date('2026-07-22T00:00:00.000Z') },
				ownership: 'borrowed',
			},
			scheduler: { value: scheduler, ownership: 'borrowed' },
			s3: {
				value: s3,
				ownership: 'borrowed',
			},
			storage: { value: storage.storage, ownership: 'borrowed' },
			settings: { value: settings, ownership: 'borrowed' },
		},
	});
	return { context, repository, storage, scheduler, s3 };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
});

describe('public/WebGL production wiring', () => {
	it('imports, creates the context graph, and registers the production prefix without I/O or timers', async () => {
		const sources = await Promise.all([
			'controller.ts',
			'index.ts',
			'repository.ts',
			'composition.ts',
		].map((file) => readFile(new URL(`../modules/public/${file}`, import.meta.url), 'utf8')));
		for (const source of sources) {
			expect(source).not.toMatch(/config\/env|lib\/prisma|lib\/s3|lib\/storage|\.runtime/);
		}
		await Promise.all([
			import('../modules/public/index.js'),
			import('../modules/public/composition.js'),
		]);

		const a = await harness('a');
		const app = await buildApp({ context: a.context });
		apps.push(app);

		expect(a.repository.calls.findExhibitionsWithPublishedCounts).not.toHaveBeenCalled();
		expect(a.repository.calls.findPublishedProjectsInExhibitions).not.toHaveBeenCalled();
		expect(a.repository.calls.findPublicWebglProject).not.toHaveBeenCalled();
		expect(a.storage.calls.presign).not.toHaveBeenCalled();
		expect(a.storage.calls.head).not.toHaveBeenCalled();
		expect(a.storage.calls.stream).not.toHaveBeenCalled();
		expect(a.s3.send).not.toHaveBeenCalled();
		expect(a.scheduler.every).not.toHaveBeenCalled();
	});

	it('preserves project and object not-found behavior before streaming', async () => {
		const a = await harness('a');
		const app = await buildApp({ context: a.context });
		apps.push(app);

		a.repository.calls.findPublicWebglProject.mockResolvedValueOnce(null);
		const missingProject = await app.inject({ method: 'GET', url: '/api/public/webgl/7/' });
		expect(missingProject.statusCode).toBe(404);
		expect(missingProject.json()).toMatchObject({
			ok: false,
			error: { code: 'NOT_FOUND', message: 'WebGL build not found' },
		});
		expect(a.storage.calls.head).not.toHaveBeenCalled();

		a.storage.calls.stream.mockResolvedValueOnce(null as never);
		const missingObject = await app.inject({ method: 'GET', url: '/api/public/webgl/7/' });
		expect(missingObject.statusCode).toBe(404);
		expect(missingObject.json()).toMatchObject({
			ok: false,
			error: { code: 'NOT_FOUND', message: 'WebGL asset not found' },
		});
		expect(a.storage.calls.head).not.toHaveBeenCalled();
		expect(a.storage.calls.stream).toHaveBeenCalledOnce();
	});

	it('serves years, year/exhibition projects, detail, and images through the context repository', async () => {
		const a = await harness('a');
		const app = await buildApp({ context: a.context });
		apps.push(app);

		const years = await app.inject({ method: 'GET', url: '/api/public/years' });
		expect(years.statusCode).toBe(200);
		expect(years.json()).toMatchObject({
			ok: true,
			data: {
				items: [{
					title: 'a Show',
					poster: {
						original: {
							url: 'https://api-a.test/api/public/images/a-poster.webp',
							width: 1200,
							height: 800,
						},
						renditions: [],
					},
				}],
			},
		});

		const byYear = await app.inject({ method: 'GET', url: '/api/public/years/2026/projects' });
		expect(byYear.statusCode).toBe(200);
		expect(byYear.json()).toMatchObject({
			ok: true,
			data: { year: 2026, items: [{ slug: 'a-game', title: 'a Game' }] },
		});

		const byExhibition = await app.inject({
			method: 'GET',
			url: '/api/public/exhibitions/1/projects',
		});
		expect(byExhibition.statusCode).toBe(200);
		expect(byExhibition.json()).toMatchObject({
			ok: true,
			data: { exhibition: { title: 'a Show' }, items: [{ slug: 'a-game' }] },
		});

		const detail = await app.inject({ method: 'GET', url: '/api/public/projects/7' });
		expect(detail.statusCode).toBe(200);
		expect(detail.json()).toMatchObject({
			ok: true,
			data: {
				slug: 'a-game',
				webglUrl: 'https://api-a.test/api/public/webgl/7/',
			},
		});

		const poster = await app.inject({
			method: 'GET',
			url: '/api/public/images/a-poster.webp',
		});
		expect(poster.statusCode).toBe(200);
		expect(poster.headers['content-type']).toContain('image/webp');
		expect(poster.headers['cache-control']).toBe('public, max-age=31536000, immutable');
		expect(a.repository.calls.resolvePublicImage).toHaveBeenCalledWith('a-poster.webp');
		expect(a.storage.calls.presign).not.toHaveBeenCalled();
		expect(a.storage.calls.head).not.toHaveBeenCalled();
		expect(a.storage.calls.stream).toHaveBeenCalledOnce();

		a.storage.calls.stream.mockClear();
		const posterHead = await app.inject({
			method: 'HEAD',
			url: '/api/public/images/a-poster.webp',
		});
		expect(posterHead.statusCode).toBe(200);
		expect(posterHead.body).toBe('');
		expect(posterHead.headers).toMatchObject({
			'content-type': 'image/webp',
			'content-length': '10',
			'cache-control': 'public, max-age=31536000, immutable',
			etag: '"a-etag"',
			'last-modified': 'Wed, 22 Jul 2026 00:00:00 GMT',
		});
		expect(a.storage.calls.stream).not.toHaveBeenCalled();

		for (const headers of [
			{ 'if-none-match': '"a-etag"' },
			{ 'if-modified-since': 'Wed, 22 Jul 2026 00:00:00 GMT' },
		]) {
			for (const method of ['GET', 'HEAD'] as const) {
				const notModified = await app.inject({
					method,
					url: '/api/public/images/a-poster.webp',
					headers,
				});
				expect(notModified.statusCode).toBe(304);
				expect(notModified.body).toBe('');
			}
		}
		expect(a.storage.calls.stream).not.toHaveBeenCalled();

		const legacyNestedKey = await app.inject({
			method: 'HEAD',
			url: '/api/public/images/legacy%2Fnested.webp',
		});
		expect(legacyNestedKey.statusCode).toBe(200);
		expect(a.repository.calls.resolvePublicImage).toHaveBeenCalledWith('legacy/nested.webp');

		const oldPoster = await app.inject({
			method: 'GET',
			url: '/api/public/exhibition-posters/a-poster.webp',
		});
		expect(oldPoster.statusCode).toBe(404);
	});

	it('distinguishes unauthorized, missing, and failed public image resolution', async () => {
		const a = await harness('a');
		const app = await buildApp({ context: a.context });
		apps.push(app);

		a.repository.calls.resolvePublicImage.mockResolvedValueOnce(null);
		const stale = await app.inject({ method: 'GET', url: '/api/public/images/stale.webp' });
		expect(stale.statusCode).toBe(404);
		expect(a.storage.calls.head).not.toHaveBeenCalled();

		a.storage.calls.stream.mockResolvedValueOnce(null as never);
		const missing = await app.inject({ method: 'GET', url: '/api/public/images/missing.webp' });
		expect(missing.statusCode).toBe(404);
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ storageKey: 'missing.webp', bucket: 'a-public' }),
			expect.stringContaining('database reference'),
		);

		a.storage.calls.stream.mockRejectedValueOnce(new Error('storage unavailable'));
		const failed = await app.inject({ method: 'GET', url: '/api/public/images/failed.webp' });
		expect(failed.statusCode).toBe(500);
		expect(failed.json()).toMatchObject({
			ok: false,
			error: { code: 'INTERNAL_ERROR' },
		});
	});

	it('keeps A/B storage, bucket, and public URL/CSP config isolated', async () => {
		const [a, b] = await Promise.all([harness('a'), harness('b')]);
		const [appA, appB] = await Promise.all([
			buildApp({ context: a.context }),
			buildApp({ context: b.context }),
		]);
		apps.push(appA, appB);

		const [rootA, rootB] = await Promise.all([
			appA.inject({ method: 'GET', url: '/api/public/webgl/7' }),
			appB.inject({ method: 'GET', url: '/api/public/webgl/7/' }),
		]);
		expect(rootA.statusCode).toBe(200);
		expect(rootB.statusCode).toBe(200);
		expect(rootA.headers['content-security-policy']).toContain('https://web-a.test');
		expect(rootB.headers['content-security-policy']).toContain('https://web-b.test');
		expect(a.storage.calls.stream).toHaveBeenCalledWith(
			'a-public',
			`webgl/7/${deployment}/site/index.html`,
			undefined,
		);
		expect(b.storage.calls.stream).toHaveBeenCalledWith(
			'b-public',
			`webgl/7/${deployment}/site/index.html`,
			undefined,
		);
		expect(a.storage.calls.stream).not.toHaveBeenCalledWith(
			'b-public',
			expect.any(String),
			undefined,
		);
	});

	it('preserves one-read WebGL GET, conditional, Range, If-Range, and explicit HEAD semantics', async () => {
		const a = await harness('a');
		const app = await buildApp({ context: a.context });
		apps.push(app);
		const resetCounts = () => {
			a.repository.calls.findPublicWebglProject.mockClear();
			a.storage.calls.head.mockClear();
			a.storage.calls.stream.mockClear();
		};

		const ordinary = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/Build/game.wasm.br',
		});
		expect(ordinary.statusCode).toBe(200);
		expect(ordinary.rawPayload).toEqual(Buffer.from('0123456789'));
		expect(ordinary.headers).toMatchObject({
			'content-type': 'application/wasm',
			'content-encoding': 'br',
			'content-length': '10',
			'cache-control': 'public, max-age=300, must-revalidate',
			'accept-ranges': 'bytes',
			etag: '"a-etag"',
			'last-modified': 'Wed, 22 Jul 2026 00:00:00 GMT',
		});
		expect(a.repository.calls.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(a.storage.calls.head).not.toHaveBeenCalled();
		expect(a.storage.calls.stream).toHaveBeenCalledOnce();

		resetCounts();
		const notModified = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/Build/game.wasm.br',
			headers: { 'if-none-match': 'W/"a-etag"' },
		});
		expect(notModified.statusCode).toBe(304);
		expect(notModified.body).toBe('');
		expect(notModified.headers).toMatchObject({
			'cache-control': 'public, max-age=300, must-revalidate',
			etag: '"a-etag"',
			'last-modified': 'Wed, 22 Jul 2026 00:00:00 GMT',
		});
		expect(notModified.headers['content-length']).toBeUndefined();
		expect(notModified.headers['content-range']).toBeUndefined();
		expect(a.repository.calls.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(a.storage.calls.head).not.toHaveBeenCalled();
		expect(a.storage.calls.stream).toHaveBeenCalledOnce();
		expect(a.storage.calls.stream).toHaveBeenCalledWith(
			'a-public',
			`webgl/7/${deployment}/site/Build/game.wasm.br`,
			{
				ifNoneMatch: '"a-etag"',
				notModifiedEtagFallback: '"a-etag"',
			},
		);

		for (const [range, expectedRange, expectedBody] of [
			['bytes=2-5', 'bytes 2-5/10', '2345'],
			['bytes=4-', 'bytes 4-9/10', '456789'],
			['bytes=-3', 'bytes 7-9/10', '789'],
		] as const) {
			resetCounts();
			const partial = await app.inject({
				method: 'GET',
				url: '/api/public/webgl/7/Build/game.data',
				headers: { range },
			});
			expect(partial.statusCode).toBe(206);
			expect(partial.body).toBe(expectedBody);
			expect(partial.headers['content-range']).toBe(expectedRange);
			expect(partial.headers['content-length']).toBe(String(expectedBody.length));
			expect(a.repository.calls.findPublicWebglProject).toHaveBeenCalledOnce();
			expect(a.storage.calls.head).not.toHaveBeenCalled();
			expect(a.storage.calls.stream).toHaveBeenCalledOnce();
		}

		resetCounts();
		const rangeConditional = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/Build/game.data',
			headers: {
				range: 'bytes=2-5',
				'if-none-match': '"a-etag"',
				'if-range': '"different"',
			},
		});
		expect(rangeConditional.statusCode).toBe(304);
		expect(rangeConditional.body).toBe('');
		expect(a.storage.calls.head).toHaveBeenCalledOnce();
		expect(a.storage.calls.stream).not.toHaveBeenCalled();

		resetCounts();
		const ifRangeMismatch = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/Build/game.data',
			headers: { range: 'bytes=2-5', 'if-range': '"different"' },
		});
		expect(ifRangeMismatch.statusCode).toBe(200);
		expect(ifRangeMismatch.body).toBe('0123456789');
		expect(ifRangeMismatch.headers['content-range']).toBeUndefined();
		expect(a.storage.calls.head).toHaveBeenCalledOnce();
		expect(a.storage.calls.stream).toHaveBeenCalledOnce();

		resetCounts();
		const head = await app.inject({
			method: 'HEAD',
			url: '/api/public/webgl/7/Build/game.data',
			headers: { range: 'bytes=2-5', 'if-range': '"a-etag"' },
		});
		expect(head.statusCode).toBe(200);
		expect(head.body).toBe('');
		expect(head.headers['content-length']).toBe('10');
		expect(head.headers['content-range']).toBeUndefined();
		expect(a.repository.calls.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(a.storage.calls.head).toHaveBeenCalledOnce();
		expect(a.storage.calls.stream).not.toHaveBeenCalled();

		resetCounts();
		const conditionalHead = await app.inject({
			method: 'HEAD',
			url: '/api/public/webgl/7/Build/game.data',
			headers: { 'if-modified-since': 'Wed, 22 Jul 2026 00:00:00 GMT' },
		});
		expect(conditionalHead.statusCode).toBe(304);
		expect(conditionalHead.body).toBe('');
		expect(conditionalHead.headers['content-length']).toBeUndefined();
		expect(a.storage.calls.head).toHaveBeenCalledOnce();
		expect(a.storage.calls.stream).not.toHaveBeenCalled();
	});

	it('preserves OPTIONS, wildcard metadata, ranges, CORS, CSP, and traversal rejection', async () => {
		const a = await harness('a');
		const app = await buildApp({ context: a.context });
		apps.push(app);

		for (const url of [
			'/api/public/webgl/7',
			'/api/public/webgl/7/',
			'/api/public/webgl/7/Build/game.data',
		]) {
			const response = await app.inject({
				method: 'OPTIONS',
				url,
				headers: {
					origin: 'null',
					'access-control-request-method': 'GET',
					'access-control-request-headers': 'range',
				},
			});
			expect(response.statusCode).toBe(204);
			expect(response.headers['access-control-allow-origin']).toBe('*');
			expect(response.headers['access-control-allow-credentials']).toBeUndefined();
			expect(response.headers['access-control-allow-headers']).toContain('Range');
		}

		const range = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/Build/game.wasm.br',
			headers: { range: 'bytes=2-5', origin: 'null' },
		});
		expect(range.statusCode).toBe(206);
		expect(range.headers['content-type']).toContain('application/wasm');
		expect(range.headers['content-encoding']).toBe('br');
		expect(range.headers['content-range']).toBe('bytes 2-5/10');
		expect(range.headers['content-length']).toBe('4');
		expect(range.headers['access-control-allow-origin']).toBe('*');
		expect(range.headers['x-frame-options']).toBeUndefined();

		const invalidRange = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/Build/game.data',
			headers: { range: 'bytes=1-2,4-5' },
		});
		expect(invalidRange.statusCode).toBe(416);
		expect(invalidRange.headers['content-range']).toBe('bytes */10');

		const callsBeforeTraversal = a.storage.calls.head.mock.calls.length;
		const traversal = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/Build%2F%2e%2e%2Fsource.zip',
		});
		expect([400, 404]).toContain(traversal.statusCode);
		expect(a.storage.calls.head).toHaveBeenCalledTimes(callsBeforeTraversal);
	});

	it('keeps DB/storage failures in the production error envelope with WebGL security headers', async () => {
		const a = await harness('a');
		const app = await buildApp({ context: a.context });
		apps.push(app);

		a.repository.calls.findExhibitionsWithPublishedCounts.mockRejectedValueOnce(new Error('database unavailable'));
		const dbFailure = await app.inject({ method: 'GET', url: '/api/public/years' });
		expect(dbFailure.statusCode).toBe(500);
		expect(dbFailure.json()).toEqual({
			ok: false,
			error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
		});
		expect(dbFailure.headers['x-content-type-options']).toBe('nosniff');

		a.repository.calls.findPublicWebglProject.mockRejectedValueOnce(new Error('database unavailable'));
		const webglDbFailure = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/',
			headers: { origin: 'null' },
		});
		expect(webglDbFailure.statusCode).toBe(500);
		expect(webglDbFailure.json()).toEqual({
			ok: false,
			error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
		});
		expect(webglDbFailure.headers['access-control-allow-origin']).toBe('*');
		expect(webglDbFailure.headers['x-frame-options']).toBeUndefined();
		expect(webglDbFailure.headers['content-security-policy']).toContain('https://web-a.test');

		a.storage.calls.stream.mockRejectedValueOnce(new Error('storage unavailable'));
		const storageFailure = await app.inject({
			method: 'GET',
			url: '/api/public/webgl/7/',
			headers: { origin: 'null' },
		});
		expect(storageFailure.statusCode).toBe(500);
		expect(storageFailure.json()).toEqual({
			ok: false,
			error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
		});
		expect(storageFailure.headers['access-control-allow-origin']).toBe('*');
		expect(storageFailure.headers['access-control-allow-credentials']).toBeUndefined();
		expect(storageFailure.headers['x-frame-options']).toBeUndefined();
		expect(storageFailure.headers['content-security-policy']).toContain('https://web-a.test');
	});
});
