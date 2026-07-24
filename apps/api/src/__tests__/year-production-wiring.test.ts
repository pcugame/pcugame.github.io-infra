import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import type {
	AppLogger,
	FileSystem,
	ObjectStorage,
	SettingsStore,
} from '../application/ports.js';
import { createNodeFileSystem } from '../infrastructure/production-ports.js';
import { AppError } from '../shared/errors.js';
import { createAdminRoutes } from '../modules/admin/admin.routes.js';
import {
	createYearProductionGraph,
	type YearProductionDependencies,
} from '../modules/admin/year/composition.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const tinyPng = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64',
);

const logger: AppLogger = {
	child: () => logger,
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	fatal: vi.fn(),
};

interface ExhibitionRow {
	id: number;
	year: number;
	title: string;
	isUploadEnabled: boolean;
	sortOrder: number;
	posterStorageKey: string | null;
	posterOriginalName: string;
	posterMimeType: string;
	posterSizeBytes: bigint;
	_count: { projects: number };
}

function prismaHarness() {
	let nextId = 2;
	const rows = new Map<number, ExhibitionRow>([[
		1,
		{
			id: 1,
			year: 2026,
			title: 'Existing',
			isUploadEnabled: true,
			sortOrder: 0,
			posterStorageKey: 'old.webp',
			posterOriginalName: 'old.webp',
			posterMimeType: 'image/webp',
			posterSizeBytes: 10n,
			_count: { projects: 0 },
		},
	]]);
	const orphans = new Map<string, { bucket: string; storageKey: string; reason: string }>();
	let transactionFailure: Error | undefined;
	let outboxFailure: Error | undefined;

	function findUnique(where: Record<string, unknown>) {
		if ('id' in where) return rows.get(where.id as number) ?? null;
		const composite = where['year_title'] as { year: number; title: string } | undefined;
		if (!composite) return null;
		return [...rows.values()].find((row) => (
			row.year === composite.year && row.title === composite.title
		)) ?? null;
	}

	const calls = {
		findMany: vi.fn(async () => [...rows.values()]),
		findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => findUnique(where)),
		create: vi.fn(async ({ data }: { data: Partial<ExhibitionRow> & { year: number } }) => {
			const row: ExhibitionRow = {
				id: nextId++,
				year: data.year,
				title: data.title ?? '',
				isUploadEnabled: data.isUploadEnabled ?? true,
				sortOrder: data.sortOrder ?? 0,
				posterStorageKey: null,
				posterOriginalName: '',
				posterMimeType: '',
				posterSizeBytes: 0n,
				_count: { projects: 0 },
			};
			rows.set(row.id, row);
			return row;
		}),
		update: vi.fn(async ({ where, data }: {
			where: { id: number };
			data: Partial<ExhibitionRow>;
		}) => {
			const row = rows.get(where.id);
			if (!row) throw new Error('missing exhibition');
			Object.assign(row, data);
			return row;
		}),
		delete: vi.fn(async ({ where }: { where: { id: number } }) => {
			const row = rows.get(where.id);
			if (!row) throw new Error('missing exhibition');
			rows.delete(where.id);
			return row;
		}),
		queryRaw: vi.fn(async (...query: unknown[]) => {
			const id = query.slice(1).find((value): value is number => typeof value === 'number');
			const row = id === undefined ? undefined : rows.get(id);
			return row ? [{ id: row.id, posterStorageKey: row.posterStorageKey }] : [];
		}),
		orphanUpsert: vi.fn(async ({ create }: {
			create: { bucket: string; storageKey: string; reason: string };
		}) => {
			if (outboxFailure) throw outboxFailure;
			orphans.set(`${create.bucket}\0${create.storageKey}`, create);
			return create;
		}),
		transaction: vi.fn(),
	};
	const client = {
		exhibition: {
			findMany: calls.findMany,
			findUnique: calls.findUnique,
			create: calls.create,
			update: calls.update,
			delete: calls.delete,
		},
		orphanObject: {
			upsert: calls.orphanUpsert,
			findMany: vi.fn(async () => []),
			update: vi.fn(async () => ({})),
		},
		$queryRaw: calls.queryRaw,
		$transaction: calls.transaction.mockImplementation(async (work: unknown) => {
			if (transactionFailure) {
				const error = transactionFailure;
				transactionFailure = undefined;
				throw error;
			}
			if (Array.isArray(work)) return Promise.all(work);
			return (work as (tx: unknown) => Promise<unknown>)(client);
		}),
	} as unknown as PrismaClient;

	return {
		client,
		calls,
		rows,
		orphans,
		failNextTransaction(error: Error) {
			transactionFailure = error;
		},
		failOutbox(error?: Error) {
			outboxFailure = error;
		},
	};
}

function storageHarness() {
	const objects = new Map<string, Buffer>([['old.webp', Buffer.from('old')]]);
	const deleteFailures = new Set<string>();
	let uploadFailure: { timing: 'before' | 'after'; error: Error } | undefined;
	let failUploadedDeletes = false;
	const calls = {
		upload: vi.fn(async (_bucket: string, key: string, body: AsyncIterable<Buffer>) => {
			if (uploadFailure?.timing === 'before') throw uploadFailure.error;
			const chunks: Buffer[] = [];
			for await (const chunk of body) chunks.push(Buffer.from(chunk));
			objects.set(key, Buffer.concat(chunks));
			if (uploadFailure?.timing === 'after') throw uploadFailure.error;
		}),
		delete: vi.fn(async (_bucket: string, key: string) => {
			if (deleteFailures.has(key) || (failUploadedDeletes && key !== 'old.webp')) {
				throw new Error(`delete failed: ${key}`);
			}
			objects.delete(key);
		}),
	};
	const storage: ObjectStorage = {
		upload: calls.upload as ObjectStorage['upload'],
		presign: vi.fn(async () => 'https://storage.test/object'),
		delete: calls.delete,
		head: vi.fn(async () => null),
		readRange: vi.fn(async () => Buffer.alloc(0)),
		stream: vi.fn(async () => null),
		listKeys: vi.fn(async () => []),
		createMultipart: vi.fn(async () => 'upload'),
		uploadPart: vi.fn(async () => 'etag'),
		completeMultipart: vi.fn(async () => {}),
		abortMultipart: vi.fn(async () => {}),
	};
	return {
		storage,
		calls,
		objects,
		deleteFailures,
		failUpload(timing: 'before' | 'after', error = new Error(`upload failed ${timing} store`)) {
			uploadFailure = { timing, error };
		},
		failNewObjectDeletes() {
			failUploadedDeletes = true;
		},
	};
}

function fileSystemHarness() {
	const base = createNodeFileSystem();
	const created = new Set<string>();
	const removed = new Set<string>();
	const calls = {
		createWriteStream: vi.fn((filePath: string) => {
			created.add(filePath);
			return base.createWriteStream(filePath);
		}),
		createReadStream: vi.fn((filePath: string) => base.createReadStream(filePath)),
		remove: vi.fn(async (filePath: string) => {
			removed.add(filePath);
			await base.remove(filePath);
		}),
	};
	const fileSystem: FileSystem = {
		...base,
		createWriteStream: calls.createWriteStream,
		createReadStream: calls.createReadStream,
		remove: calls.remove,
	};
	return {
		fileSystem,
		calls,
		created,
		removed,
		outstanding: () => [...created].filter((filePath) => !removed.has(filePath)),
	};
}

function limiterHarness() {
	let active = 0;
	let acquireFailure: Error | undefined;
	const calls = {
		acquire: vi.fn(() => {
			if (acquireFailure) throw acquireFailure;
			active += 1;
		}),
		release: vi.fn(() => { active -= 1; }),
	};
	return {
		limiter: calls,
		calls,
		active: () => active,
		rejectNext(error: Error) {
			acquireFailure = error;
		},
	};
}

function settingsHarness(): SettingsStore {
	return {
		get: vi.fn(async () => ({ maxGameFileMb: 64, maxChunkSizeMb: 4 })),
		update: vi.fn(async () => ({ maxGameFileMb: 64, maxChunkSizeMb: 4 })),
		invalidate: vi.fn(),
	};
}

function graphHarness(options: {
	privilegedImageMaxMb?: number;
	privilegedRequestMaxMb?: number;
} = {}) {
	const prisma = prismaHarness();
	const storage = storageHarness();
	const fileSystem = fileSystemHarness();
	const limiter = limiterHarness();
	let idSequence = 0;
	const config = {
		...defaultTestEnv,
		API_PUBLIC_URL: 'https://api.example.test',
		S3_BUCKET_PUBLIC: 'public',
		UPLOAD_USER_IMAGE_MAX_MB: 1,
		UPLOAD_USER_GAME_MAX_MB: 1,
		UPLOAD_USER_REQUEST_MAX_MB: 1,
		UPLOAD_USER_MAX_FILES: 1,
		UPLOAD_PRIVILEGED_IMAGE_MAX_MB: options.privilegedImageMaxMb ?? 1,
		UPLOAD_PRIVILEGED_GAME_MAX_MB: 1,
		UPLOAD_PRIVILEGED_REQUEST_MAX_MB: options.privilegedRequestMaxMb ?? 2,
		UPLOAD_PRIVILEGED_MAX_FILES: 1,
	};
	const deps: YearProductionDependencies = {
		config,
		prisma: prisma.client,
		storage: storage.storage,
		fileSystem: fileSystem.fileSystem,
		settings: settingsHarness(),
		uploadLimiter: limiter.limiter,
		logger,
		clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
		ids: { next: () => `00000000-0000-4000-8000-${String(++idSequence).padStart(12, '0')}` },
	};
	return {
		graph: createYearProductionGraph(deps),
		prisma,
		storage,
		fileSystem,
		limiter,
		activeUploads: limiter.active,
	};
}

function multipartPoster(
	file = tinyPng,
	filename = 'poster.png',
	contentType = 'image/png',
) {
	const boundary = 'ticket-009-boundary';
	return {
		headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
		payload: Buffer.concat([
			Buffer.from(
				`--${boundary}\r\n`
				+ `Content-Disposition: form-data; name="poster"; filename="${filename}"\r\n`
				+ `Content-Type: ${contentType}\r\n\r\n`,
			),
			file,
			Buffer.from(`\r\n--${boundary}--\r\n`),
		]),
	};
}

function abortedMultipartPoster() {
	const boundary = 'ticket-009-aborted-boundary';
	const payload = Readable.from((async function* abortedBody() {
		yield Buffer.from(
			`--${boundary}\r\n`
			+ 'Content-Disposition: form-data; name="poster"; filename="poster.png"\r\n'
			+ 'Content-Type: image/png\r\n\r\n',
		);
		yield tinyPng.subarray(0, 24);
		throw new Error('ticket 009 client stream aborted');
	})());
	return {
		headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
		payload,
	};
}

async function routeApp(
	harness: ReturnType<typeof graphHarness>,
	role: 'ADMIN' | 'OPERATOR' | 'USER' = 'ADMIN',
): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	await app.register(fastifyMultipart, {
		limits: { fileSize: 2 * 1024 * 1024, files: 1 },
		attachFieldsToBody: false,
	});
	app.addHook('preHandler', async (request) => {
		request.currentUser = {
			id: 1,
			googleSub: 'ticket-009',
			email: 'ticket-009@example.test',
			name: 'Ticket 009',
			role,
		};
	});
	app.setErrorHandler((error, _request, reply) => {
		const failure = error as { statusCode?: number; code?: string };
		reply.status(failure.statusCode ?? 500).send({
			ok: false,
			error: {
				code: failure.code ?? 'ERROR',
				message: error instanceof Error ? error.message : String(error),
			},
		});
	});
	await app.register(createAdminRoutes({
		projectController: emptyRoute,
		memberController: emptyRoute,
		settingsController: emptyRoute,
		bannedIpController: emptyRoute,
		exhibitionController: harness.graph.exhibitionController,
		legacy: {
			projectMultipartController: emptyRoute,
			gameUploadController: emptyRoute,
			importController: emptyRoute,
			exportController: emptyRoute,
		},
	}), { prefix: '/api/admin' });
	await app.ready();
	return app;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('year production wiring', () => {
	it('imports, creates, and registers the production graph without env/DB/S3/timer I/O', async () => {
		const sources = await Promise.all([
			'modules/admin/year/controller.ts',
			'modules/admin/year/repository.ts',
			'modules/admin/year/poster-upload.adapter.ts',
		].map((file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
		for (const source of sources) {
			expect(source).not.toMatch(/config\/env|lib\/prisma|lib\/s3|\.\/runtime/);
		}

		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		const harness = graphHarness();
		const app = await routeApp(harness);
		apps.push(app);
		expect(harness.prisma.calls.findMany).not.toHaveBeenCalled();
		expect(harness.prisma.calls.findUnique).not.toHaveBeenCalled();
		expect(harness.prisma.calls.transaction).not.toHaveBeenCalled();
		expect(harness.storage.calls.upload).not.toHaveBeenCalled();
		expect(harness.storage.calls.delete).not.toHaveBeenCalled();
		expect(setIntervalSpy).not.toHaveBeenCalled();
	});

	it('has no env, S3, process singleton, or global runtime in its depcruise closure', async () => {
		const report = await cruise(['src/modules/admin/year/composition.ts'], {
			doNotFollow: { path: '(^|/)node_modules/' },
			exclude: { path: '(^|/)(dist|generated|__tests__)/' },
		});
		expect(typeof report.output).not.toBe('string');
		const modules = (report.output as ICruiseResult).modules.map(({ source }) => source);
		expect(modules).toEqual(expect.arrayContaining([
			'src/modules/admin/year/composition.ts',
			'src/modules/admin/year/poster-upload.adapter.ts',
			'src/modules/admin/year/poster-file-validation.ts',
			'src/modules/admin/year/poster-upload.policy.ts',
		]));
		const forbidden = modules.filter((source) => (
			source === 'src/config/env.ts'
			|| /^src\/lib\/(prisma|s3|storage|logger)\.ts$/.test(source)
			|| source === 'src/shared/upload-limits.ts'
			|| source === 'src/object-deletion.ts'
			|| /(^|\/)runtime\.ts$/.test(source)
		));
		expect(forbidden).toEqual([]);
	});

	it('preserves create/list/update/delete validation and role gates through the admin tree', async () => {
		const harness = graphHarness();
		const app = await routeApp(harness);
		apps.push(app);

		expect((await app.inject({ method: 'GET', url: '/api/admin/exhibitions' })).statusCode).toBe(200);
		const invalid = await app.inject({
			method: 'POST',
			url: '/api/admin/exhibitions',
			payload: { year: 'invalid' },
		});
		expect(invalid.statusCode).toBe(400);
		expect(harness.prisma.calls.create).not.toHaveBeenCalled();

		const created = await app.inject({
			method: 'POST',
			url: '/api/admin/exhibitions',
			payload: { year: 2027, title: 'Created' },
		});
		expect(created.statusCode).toBe(201);
		const createdId = created.json().data.id as number;
		expect((await app.inject({
			method: 'PATCH',
			url: `/api/admin/exhibitions/${createdId}`,
			payload: { title: 'Updated', isUploadEnabled: false },
		})).statusCode).toBe(200);
		expect((await app.inject({
			method: 'DELETE',
			url: `/api/admin/exhibitions/${createdId}`,
		})).statusCode).toBe(204);

		const deniedHarness = graphHarness();
		const deniedApp = await routeApp(deniedHarness, 'USER');
		apps.push(deniedApp);
		expect((await deniedApp.inject({
			method: 'POST',
			url: '/api/admin/exhibitions',
			payload: { year: 2028 },
		})).statusCode).toBe(403);
		expect(deniedHarness.prisma.calls.create).not.toHaveBeenCalled();
	});

	it('runs poster replace and clear through injected filesystem, storage, limiter, and repository', async () => {
		const harness = graphHarness();
		const app = await routeApp(harness);
		apps.push(app);

		const replaced = await app.inject({
			method: 'POST',
			url: '/api/admin/exhibitions/1/poster',
			...multipartPoster(),
		});
		expect(replaced.statusCode, replaced.body).toBe(200);
		const key = harness.prisma.rows.get(1)?.posterStorageKey;
		expect(key).toMatch(/^[0-9a-f-]+\.webp$/);
		expect(harness.storage.objects.has(key!)).toBe(true);
		expect(harness.storage.objects.has('old.webp')).toBe(false);
		expect(harness.prisma.orphans.has('public\0old.webp')).toBe(true);
		expect(harness.activeUploads()).toBe(0);

		const cleared = await app.inject({
			method: 'DELETE',
			url: '/api/admin/exhibitions/1/poster',
		});
		expect(cleared.statusCode).toBe(204);
		expect(harness.prisma.rows.get(1)?.posterStorageKey).toBeNull();
		expect(harness.storage.objects.has(key!)).toBe(false);
		expect(harness.prisma.orphans.has(`public\0${key}`)).toBe(true);
	});

	it('routes PDF processing failure through the context logger without storage or pointer mutation', async () => {
		const harness = graphHarness();
		const app = await routeApp(harness);
		apps.push(app);

		const invalidPdf = await app.inject({
			method: 'POST',
			url: '/api/admin/exhibitions/1/poster',
			...multipartPoster(
				Buffer.from('%PDF-1.4\ninvalid ticket 009 pdf'),
				'poster.pdf',
				'application/pdf',
			),
		});
		expect(invalidPdf.statusCode).toBe(400);
		expect(harness.storage.calls.upload).not.toHaveBeenCalled();
		expect(harness.prisma.rows.get(1)?.posterStorageKey).toBe('old.webp');
		expect(harness.activeUploads()).toBe(0);
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.anything() }),
			'PDF rasterization failed',
		);
		expect(harness.fileSystem.outstanding()).toEqual([]);
	});

	it('rejects invalid content and oversized poster streams and removes every injected temp file', async () => {
		const invalidHarness = graphHarness();
		const invalidApp = await routeApp(invalidHarness);
		apps.push(invalidApp);
		const invalid = await invalidApp.inject({
			method: 'POST',
			url: '/api/admin/exhibitions/1/poster',
			...multipartPoster(Buffer.from('GIF89a invalid poster'), 'poster.gif', 'image/gif'),
		});
		expect(invalid.statusCode).toBe(400);
		expect(invalidHarness.storage.calls.upload).not.toHaveBeenCalled();
		expect(invalidHarness.prisma.rows.get(1)?.posterStorageKey).toBe('old.webp');
		expect(invalidHarness.fileSystem.created.size).toBeGreaterThan(0);
		expect(invalidHarness.fileSystem.outstanding()).toEqual([]);

		const oversizeHarness = graphHarness({ privilegedImageMaxMb: 0.0001 });
		const oversizeApp = await routeApp(oversizeHarness);
		apps.push(oversizeApp);
		const oversize = await oversizeApp.inject({
			method: 'POST',
			url: '/api/admin/exhibitions/1/poster',
			...multipartPoster(Buffer.concat([tinyPng, Buffer.alloc(512)])),
		});
		expect(oversize.statusCode).toBe(413);
		expect(oversizeHarness.storage.calls.upload).not.toHaveBeenCalled();
		expect(oversizeHarness.prisma.rows.get(1)?.posterStorageKey).toBe('old.webp');
		expect(oversizeHarness.fileSystem.created.size).toBeGreaterThan(0);
		expect(oversizeHarness.fileSystem.outstanding()).toEqual([]);
		expect(oversizeHarness.activeUploads()).toBe(0);
	});

	it('cleans an aborted multipart stream through the injected filesystem', async () => {
		const harness = graphHarness();
		const app = await routeApp(harness);
		apps.push(app);
		let responseStatus: number | undefined;
		let rejected: unknown;
		try {
			responseStatus = (await app.inject({
				method: 'POST',
				url: '/api/admin/exhibitions/1/poster',
				...abortedMultipartPoster(),
			})).statusCode;
		} catch (error) {
			rejected = error;
		}
		expect(responseStatus === undefined || responseStatus >= 400).toBe(true);
		if (responseStatus === undefined) expect(rejected).toBeInstanceOf(Error);
		expect(harness.storage.calls.upload).not.toHaveBeenCalled();
		expect(harness.prisma.rows.get(1)?.posterStorageKey).toBe('old.webp');
		expect(harness.fileSystem.created.size).toBeGreaterThan(0);
		await vi.waitFor(() => {
			expect(harness.fileSystem.outstanding()).toEqual([]);
			expect(harness.activeUploads()).toBe(0);
		});
	});

	it('rejects at the injected limiter before multipart, filesystem, storage, or pointer work', async () => {
		const harness = graphHarness();
		harness.limiter.rejectNext(new AppError(
			429,
			'Upload capacity exhausted',
			'TOO_MANY_UPLOADS',
		));
		const app = await routeApp(harness);
		apps.push(app);
		const rejected = await app.inject({
			method: 'POST',
			url: '/api/admin/exhibitions/1/poster',
			...multipartPoster(),
		});
		expect(rejected.statusCode).toBe(429);
		expect(harness.limiter.calls.acquire).toHaveBeenCalledOnce();
		expect(harness.limiter.calls.release).not.toHaveBeenCalled();
		expect(harness.fileSystem.calls.createWriteStream).not.toHaveBeenCalled();
		expect(harness.storage.calls.upload).not.toHaveBeenCalled();
		expect(harness.prisma.rows.get(1)?.posterStorageKey).toBe('old.webp');
		expect(harness.activeUploads()).toBe(0);
	});

	it('idempotently cleans upload failure before store and ambiguous failure after store', async () => {
		const beforeHarness = graphHarness();
		beforeHarness.storage.failUpload('before');
		const beforeApp = await routeApp(beforeHarness);
		apps.push(beforeApp);
		const beforeFailure = await beforeApp.inject({
			method: 'POST',
			url: '/api/admin/exhibitions/1/poster',
			...multipartPoster(),
		});
		expect(beforeFailure.statusCode).toBe(500);
		const attemptedKey = beforeHarness.storage.calls.upload.mock.calls[0]?.[1];
		expect(attemptedKey).toEqual(expect.any(String));
		expect(beforeHarness.storage.calls.delete).toHaveBeenCalledWith('public', attemptedKey);
		expect(beforeHarness.storage.objects.has(attemptedKey!)).toBe(false);
		expect(beforeHarness.prisma.orphans.has(`public\0${attemptedKey}`)).toBe(false);
		expect(beforeHarness.fileSystem.outstanding()).toEqual([]);

		const afterHarness = graphHarness();
		afterHarness.storage.failUpload('after');
		const afterApp = await routeApp(afterHarness);
		apps.push(afterApp);
		const afterFailure = await afterApp.inject({
			method: 'POST',
			url: '/api/admin/exhibitions/1/poster',
			...multipartPoster(),
		});
		expect(afterFailure.statusCode).toBe(500);
		const storedThenFailedKey = afterHarness.storage.calls.upload.mock.calls[0]?.[1];
		expect(afterHarness.storage.calls.delete).toHaveBeenCalledWith('public', storedThenFailedKey);
		expect(afterHarness.storage.objects.has(storedThenFailedKey!)).toBe(false);
		expect(afterHarness.prisma.rows.get(1)?.posterStorageKey).toBe('old.webp');
		expect(afterHarness.fileSystem.outstanding()).toEqual([]);
	});

	it('durably queues ambiguous stored objects when compensating delete also fails', async () => {
		const harness = graphHarness();
		harness.storage.failUpload('after');
		harness.storage.failNewObjectDeletes();
		const app = await routeApp(harness);
		apps.push(app);
		const failed = await app.inject({
			method: 'POST',
			url: '/api/admin/exhibitions/1/poster',
			...multipartPoster(),
		});
		expect(failed.statusCode).toBe(500);
		const key = harness.storage.calls.upload.mock.calls[0]?.[1];
		expect(harness.storage.objects.has(key!)).toBe(true);
		expect(harness.prisma.orphans.get(`public\0${key}`)).toMatchObject({
			bucket: 'public',
			storageKey: key,
			reason: 'exhibition-poster-unpersisted',
		});
		expect(harness.prisma.rows.get(1)?.posterStorageKey).toBe('old.webp');
		expect(harness.fileSystem.outstanding()).toEqual([]);
	});

	it('durably rolls back an uploaded object after DB failure and retains old cleanup intent on storage failure', async () => {
		const rollbackHarness = graphHarness();
		rollbackHarness.prisma.failNextTransaction(new Error('database unavailable'));
		const rollbackApp = await routeApp(rollbackHarness);
		apps.push(rollbackApp);
		const failed = await rollbackApp.inject({
			method: 'POST',
			url: '/api/admin/exhibitions/1/poster',
			...multipartPoster(),
		});
		expect(failed.statusCode).toBe(500);
		expect(rollbackHarness.prisma.rows.get(1)?.posterStorageKey).toBe('old.webp');
		expect([...rollbackHarness.storage.objects.keys()]).toEqual(['old.webp']);
		expect(rollbackHarness.activeUploads()).toBe(0);

		const cleanupHarness = graphHarness();
		cleanupHarness.storage.deleteFailures.add('old.webp');
		const cleanupApp = await routeApp(cleanupHarness);
		apps.push(cleanupApp);
		const replaced = await cleanupApp.inject({
			method: 'POST',
			url: '/api/admin/exhibitions/1/poster',
			...multipartPoster(),
		});
		expect(replaced.statusCode, replaced.body).toBe(200);
		expect(cleanupHarness.prisma.rows.get(1)?.posterStorageKey).not.toBe('old.webp');
		expect(cleanupHarness.storage.objects.has('old.webp')).toBe(true);
		expect(cleanupHarness.prisma.orphans.has('public\0old.webp')).toBe(true);
	});

	it('keeps clear and exhibition-delete responses committed with durable old-object cleanup', async () => {
		const clearHarness = graphHarness();
		clearHarness.storage.deleteFailures.add('old.webp');
		const clearApp = await routeApp(clearHarness);
		apps.push(clearApp);
		const cleared = await clearApp.inject({
			method: 'DELETE',
			url: '/api/admin/exhibitions/1/poster',
		});
		expect(cleared.statusCode).toBe(204);
		expect(clearHarness.prisma.rows.get(1)?.posterStorageKey).toBeNull();
		expect(clearHarness.storage.objects.has('old.webp')).toBe(true);
		expect(clearHarness.prisma.orphans.get('public\0old.webp')).toMatchObject({
			bucket: 'public',
			storageKey: 'old.webp',
			reason: 'exhibition-poster-delete',
		});

		const deleteHarness = graphHarness();
		deleteHarness.storage.deleteFailures.add('old.webp');
		const deleteApp = await routeApp(deleteHarness);
		apps.push(deleteApp);
		const deleted = await deleteApp.inject({
			method: 'DELETE',
			url: '/api/admin/exhibitions/1',
		});
		expect(deleted.statusCode).toBe(204);
		expect(deleteHarness.prisma.rows.has(1)).toBe(false);
		expect(deleteHarness.storage.objects.has('old.webp')).toBe(true);
		expect(deleteHarness.prisma.orphans.get('public\0old.webp')).toMatchObject({
			bucket: 'public',
			storageKey: 'old.webp',
			reason: 'exhibition-delete-poster',
		});
	});

	it('surfaces DB/outbox plus rollback cleanup failure without committing the pointer', async () => {
		const harness = graphHarness();
		harness.prisma.failOutbox(new Error('outbox unavailable'));
		harness.storage.calls.delete.mockImplementation(async (_bucket: string, key: string) => {
			if (key !== 'old.webp') throw new Error('storage unavailable');
			harness.storage.objects.delete(key);
		});
		const app = await routeApp(harness);
		apps.push(app);

		const failed = await app.inject({
			method: 'POST',
			url: '/api/admin/exhibitions/1/poster',
			...multipartPoster(),
		});
		expect(failed.statusCode).toBe(500);
		expect(failed.json()).toMatchObject({
			error: { message: expect.stringMatching(/deletion and durable orphan recording both failed/i) },
		});
		expect(harness.prisma.rows.get(1)?.posterStorageKey).toBe('old.webp');
		expect(harness.activeUploads()).toBe(0);
	});
});
