import { readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import type { S3Client } from '@aws-sdk/client-s3';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	AppLogger,
	FileSystem,
	ObjectStorage,
} from '../application/ports.js';
import {
	createProductionBackendContext,
	type BackendRoutes,
} from '../backend-context.js';
import type { Env } from '../config/env.js';
import { createAdminRoutes } from '../modules/admin/admin.routes.js';
import {
	createImportExportProductionGraph,
	type ExportRepository,
} from '../modules/admin/import-export.composition.js';
import type {
	ImportRepository,
	ImportTransactionRepository,
} from '../modules/admin/import/service.js';
import { createProtectedDownloadLimiter } from '../shared/protected-download-limiter.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createScriptedBackendPersistence } from './helpers/backend-persistence.js';
import { ownedTestUploadLifecycleResource } from './helpers/upload-lifecycle.js';

const emptyRoute: FastifyPluginAsync = async () => {};
function fakeLogger(): AppLogger {
	const logger = {
		child: () => logger,
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	return logger;
}

function exportProject() {
	return {
		id: 71,
		title: 'Ticket 010',
		webglEntryKey: '',
		exhibition: { year: 2026, title: 'Show' },
		members: [],
		assets: [{
			id: 72,
			kind: 'IMAGE' as const,
			storageKey: 'ticket-010.png',
			originalName: 'ticket-010.png',
			mimeType: 'image/png',
			sizeBytes: 4n,
		}],
	};
}

function repositoryHarness(projects = [exportProject()]) {
	const calls = {
		findProjectsWithAssets: vi.fn().mockResolvedValue(projects),
		createJob: vi.fn(async (input: { id: string }) => ({ id: input.id })),
		latestJob: vi.fn().mockResolvedValue(null),
		findProjectBySlug: vi.fn().mockResolvedValue(null),
		createProjectWithMembers: vi.fn().mockResolvedValue({ id: 1 }),
		findExhibitionByComposite: vi.fn().mockResolvedValue(null),
		upsertExhibition: vi.fn().mockResolvedValue({ id: 11 }),
		findExhibitionForPreview: vi.fn().mockResolvedValue(null),
		runTransaction: vi.fn(),
	};
	const transactionRepository: ImportTransactionRepository = {
		findExhibitionByComposite: calls.findExhibitionByComposite,
		upsertExhibition: calls.upsertExhibition,
		findProjectBySlug: calls.findProjectBySlug,
		createProjectWithMembers: calls.createProjectWithMembers,
	};
	const importRepository: ImportRepository = {
		findExhibitionForPreview: calls.findExhibitionForPreview,
		runTransaction: calls.runTransaction.mockImplementation(async (
			work: (repository: ImportTransactionRepository) => Promise<unknown>,
		) => work(transactionRepository)),
	};
	const exportRepository: ExportRepository = {
		findProjectsWithAssets: calls.findProjectsWithAssets,
		createJob: calls.createJob,
		latestJob: calls.latestJob,
	};
	return { importRepository, exportRepository, calls };
}

interface MemoryFileSystem extends FileSystem {
	files: Map<string, Buffer>;
	temporary: Set<string>;
	calls: {
		access: ReturnType<typeof vi.fn>;
		mkdir: ReturnType<typeof vi.fn>;
		rename: ReturnType<typeof vi.fn>;
		remove: ReturnType<typeof vi.fn>;
		createWriteStream: ReturnType<typeof vi.fn>;
	};
	faults: {
		write?: Error;
		rename?: Error;
		remove?: Error;
	};
}

function memoryFileSystem(): MemoryFileSystem {
	const files = new Map<string, Buffer>();
	const temporary = new Set<string>();
	const faults: MemoryFileSystem['faults'] = {};
	const calls = {
		access: vi.fn(),
		mkdir: vi.fn(),
		rename: vi.fn(),
		remove: vi.fn(),
		createWriteStream: vi.fn(),
	};
	return {
		files,
		temporary,
		calls,
		faults,
		temporaryDirectory: () => '/tmp',
		stat: async (path) => ({ size: files.get(path)?.length ?? 0 }),
		access: calls.access.mockImplementation(async (path: string) => {
			if (!files.has(path)) throw new Error('ENOENT');
		}),
		mkdir: calls.mkdir.mockResolvedValue(undefined),
		rename: calls.rename.mockImplementation(async (from: string, to: string) => {
			if (faults.rename) throw faults.rename;
			const contents = files.get(from);
			if (!contents) throw new Error('ENOENT');
			files.delete(from);
			temporary.delete(from);
			files.set(to, contents);
		}),
		remove: calls.remove.mockImplementation(async (path: string) => {
			if (faults.remove) throw faults.remove;
			files.delete(path);
			temporary.delete(path);
		}),
		readRange: async (path, start, end) => (
			(files.get(path) ?? Buffer.alloc(0)).subarray(start, end + 1)
		),
		createReadStream: (path) => Readable.from([files.get(path) ?? Buffer.alloc(0)]),
		createWriteStream: calls.createWriteStream.mockImplementation((path: string) => {
			temporary.add(path);
			const chunks: Buffer[] = [];
			return new Writable({
				write(chunk, _encoding, callback) {
					if (faults.write) callback(faults.write);
					else {
						chunks.push(Buffer.from(chunk));
						callback();
					}
				},
				final(callback) {
					files.set(path, Buffer.concat(chunks));
					callback();
				},
			});
		}),
	};
}

function fakeStorage() {
	const calls = {
		stream: vi.fn().mockResolvedValue({
			body: Readable.from([Buffer.from('data')]),
			size: 4,
			contentType: 'image/png',
		}),
	};
	const storage: ObjectStorage = {
		upload: vi.fn(),
		presign: vi.fn(),
		presignUploadPart: vi.fn(async () => 'https://storage.test/upload-part'),
		delete: vi.fn(),
		head: vi.fn(),
		readRange: vi.fn(),
		stream: calls.stream,
		listKeys: vi.fn(),
		listKeyPage: vi.fn(async () => ({ keys: [], isTruncated: false })),
		deleteKeys: vi.fn(async (_bucket, keys) => ({ deleted: [...keys], failures: [] })),
		createMultipart: vi.fn(),
		uploadPart: vi.fn(),
		completeMultipart: vi.fn(),
		abortMultipart: vi.fn(),
		listParts: vi.fn(async () => []),
		listMultipartUploads: vi.fn(async () => []),
	};
	return { storage, calls };
}

function harness(options: {
	projects?: ReturnType<typeof exportProject>[];
	fileSystem?: MemoryFileSystem;
	storage?: ReturnType<typeof fakeStorage>;
	inlineMaxBytes?: number;
} = {}) {
	const repositories = repositoryHarness(options.projects);
	const storage = options.storage ?? fakeStorage();
	const fileSystem = options.fileSystem ?? memoryFileSystem();
	const logger = fakeLogger();
	let id = 0;
	const graph = createImportExportProductionGraph({
		config: {
			...defaultTestEnv,
			NAS_EXPORT_PATH: '/nas',
			INLINE_UPLOAD_MAX_BYTES:
				options.inlineMaxBytes ?? defaultTestEnv.INLINE_UPLOAD_MAX_BYTES,
		},
		importRepository: repositories.importRepository,
		exportRepository: repositories.exportRepository,
		ids: { next: () => `id-${++id}` },
	});
	return { graph, repositories, storage, fileSystem, logger };
}

async function routeApp(
	graph: ReturnType<typeof createImportExportProductionGraph>,
): Promise<FastifyInstance> {
	return routePluginApp(createAdminRoutes({
		projectController: emptyRoute,
		memberController: emptyRoute,
		settingsController: emptyRoute,
		bannedIpController: emptyRoute,
		exhibitionController: emptyRoute,
		importController: graph.importController,
		exportController: graph.exportController,
		projectMultipartController: emptyRoute,
		gameUploadController: emptyRoute,
	}));
}

async function routePluginApp(admin: FastifyPluginAsync): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	await app.register(fastifyMultipart, {
		limits: { fileSize: 11 * 1024 * 1024, files: 1 },
		attachFieldsToBody: false,
	});
	app.addHook('preHandler', async (request) => {
		request.currentUser = {
			id: 9,
			googleSub: 'ticket-010',
			email: 'ticket-010@example.test',
			name: 'Ticket 010',
			role: 'ADMIN',
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
	await app.register(admin, { prefix: '/api/admin' });
	await app.ready();
	return app;
}

async function contextHarness() {
	const state = harness();
	const events: string[] = [];
	const config: Env = {
		...defaultTestEnv,
		GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
		CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS],
		LOG_LEVEL: 'info',
		NAS_EXPORT_PATH: '/nas',
	};
	const routes = (
		_config: Env,
		_assets: unknown,
		_auth: unknown,
		_public: unknown,
		_project: unknown,
		_year: unknown,
		importExport: ReturnType<typeof createImportExportProductionGraph>,
	): BackendRoutes => ({
		auth: emptyRoute,
		devAuth: emptyRoute,
		public: emptyRoute,
		me: emptyRoute,
		assets: emptyRoute,
		admin: createAdminRoutes({
			projectController: emptyRoute,
			memberController: emptyRoute,
			settingsController: emptyRoute,
			bannedIpController: emptyRoute,
			exhibitionController: emptyRoute,
			importController: importExport.importController,
			exportController: importExport.exportController,
			projectMultipartController: emptyRoute,
			gameUploadController: emptyRoute,
		}),
	});
	const context = await createProductionBackendContext(config, {
		persistence: createScriptedBackendPersistence({
			importRepository: state.repositories.importRepository,
			exportRepository: state.repositories.exportRepository,
		}),
		factories: { routes },
		resources: {
			uploadLifecycle: ownedTestUploadLifecycleResource(),
			logger: { value: state.logger, ownership: 'borrowed' },
			clock: {
				value: { now: () => new Date('2026-07-24T00:00:00.000Z') },
				ownership: 'borrowed',
			},
			ids: { value: { next: () => 'context-id' }, ownership: 'borrowed' },
			scheduler: {
				value: {
					every: vi.fn(() => ({ cancel: vi.fn() })),
					delay: vi.fn(async () => {}),
				},
				ownership: 'borrowed',
			},
			fileSystem: { value: state.fileSystem, ownership: 'borrowed' },
			googleTokens: {
				value: { verify: vi.fn(async () => undefined) },
				ownership: 'borrowed',
			},
			s3: { value: { destroy: vi.fn() } as unknown as S3Client, ownership: 'borrowed' },
			storage: { value: state.storage.storage, ownership: 'borrowed' },
			settings: {
				value: {
					get: vi.fn(async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 })),
					update: vi.fn(async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 })),
					invalidate: vi.fn(),
				},
				ownership: 'borrowed',
			},
			uploadLimiter: {
				value: { acquire: vi.fn(), release: vi.fn() },
				ownership: 'borrowed',
			},
			lifecycle: {
				value: {
					state: () => 'ready',
					setState: vi.fn(),
					isAcceptingNewWork: () => true,
					requestStarted: vi.fn(),
					requestFinished: vi.fn(),
					inFlight: () => 0,
					waitForDrain: async () => 'drained',
				},
				ownership: 'borrowed',
			},
			protectedDownloads: {
				value: createProtectedDownloadLimiter(),
				ownership: 'borrowed',
			},
		},
	});
	contexts.push(context);
	return { ...state, context, events };
}

function multipartJson(
	raw: string,
	contentType = 'application/json',
	fieldname = 'file',
) {
	const boundary = 'ticket-010-json';
	return {
		headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
		payload: Buffer.from(
			`--${boundary}\r\n`
			+ `Content-Disposition: form-data; name="${fieldname}"; filename="import.json"\r\n`
			+ `Content-Type: ${contentType}\r\n\r\n`
			+ `${raw}\r\n`
			+ `--${boundary}--\r\n`,
		),
	};
}

function multipartJsonTwice() {
	const boundary = 'ticket-010-json-twice';
	const part = (filename: string) => (
		`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
		+ 'Content-Type: application/json\r\n\r\n'
		+ '{}\r\n'
	);
	return {
		headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
		payload: Buffer.from(
			`--${boundary}\r\n${part('first.json')}`
			+ `--${boundary}\r\n${part('second.json')}`
			+ `--${boundary}--\r\n`,
		),
	};
}

const apps: FastifyInstance[] = [];
const contexts: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
	await Promise.allSettled(contexts.splice(0).map((context) => context.close()));
	vi.restoreAllMocks();
});

describe('import/export production wiring', () => {
	it('keeps the Fastify export control graph free of object streams and NAS writers', async () => {
		const source = await readFile(
			new URL('../modules/admin/import-export.composition.ts', import.meta.url),
			'utf8',
		);
		expect(source).not.toMatch(/storage[.]stream|createWriteStream|createExportFileWriter/);
		expect(source).toMatch(/createJob|latestJob/);
		expect(source).toMatch(/export\/ports[.]js/);
		expect(source).not.toMatch(/export\/service[.]js|export\/file[.]adapter[.]js/);
	});
	it('imports, composes, and registers the actual admin controllers without external I/O', async () => {
		const sources = await Promise.all([
			'modules/admin/import/controller.ts',
			'modules/admin/import/repository.ts',
			'modules/admin/export/controller.ts',
			'modules/admin/export/repository.ts',
			'modules/admin/export/file.adapter.ts',
		].map((file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
		for (const source of sources) {
			expect(source).not.toMatch(/config\/env|lib\/prisma|lib\/s3|lib\/storage|\.\/runtime/);
		}
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		const state = harness();
		const app = await routeApp(state.graph);
		apps.push(app);
		expect(state.repositories.calls.findProjectsWithAssets).not.toHaveBeenCalled();
		expect(state.repositories.calls.runTransaction).not.toHaveBeenCalled();
		expect(state.storage.calls.stream).not.toHaveBeenCalled();
		expect(state.fileSystem.calls.access).not.toHaveBeenCalled();
		expect(state.fileSystem.calls.mkdir).not.toHaveBeenCalled();
		expect(state.fileSystem.calls.createWriteStream).not.toHaveBeenCalled();
		expect(setIntervalSpy).not.toHaveBeenCalled();
	});

	it('has no env, global Prisma/S3/filesystem, or runtime in its transitive closure', async () => {
		const report = await cruise(['src/modules/admin/import-export.composition.ts'], {
			doNotFollow: { path: '(^|/)node_modules/' },
			exclude: { path: '(^|/)(dist|generated|__tests__)/' },
		});
		expect(typeof report.output).not.toBe('string');
		const modules = (report.output as ICruiseResult).modules.map(({ source }) => source);
		expect(modules).toEqual(expect.arrayContaining([
			'src/modules/admin/import-export.composition.ts',
			'src/modules/admin/import/controller.ts',
			'src/modules/admin/export/controller.ts',
		]));
		expect(modules).not.toContain('src/modules/admin/export/service.ts');
		expect(modules).not.toContain('src/modules/admin/export/file.adapter.ts');
		const forbidden = modules.filter((source) => (
			source === 'src/config/env.ts'
			|| /^src\/lib\/(prisma|s3|storage|logger)\.ts$/.test(source)
			|| source === 'src/infrastructure/production-ports.ts'
			|| /(^|\/)runtime\.ts$/.test(source)
		));
		expect(forbidden).toEqual([]);
	});

	it('preserves import multipart/schema contracts through the production admin tree', async () => {
		const state = harness({ projects: [] });
		const app = await routeApp(state.graph);
		apps.push(app);

		const preview = await app.inject({
			method: 'POST',
			url: '/api/admin/import/preview',
			...multipartJson(JSON.stringify({
				years: [{ year: 2026, title: 'Show' }],
				projects: [{ year: 2026, title: 'Game' }],
			})),
		});
		expect(preview.statusCode).toBe(200);
		expect(preview.json().data).toMatchObject({ valid: true, projectCount: 1 });

		const invalidSchema = await app.inject({
			method: 'POST',
			url: '/api/admin/import/execute',
			...multipartJson(JSON.stringify({ projects: [{ year: 1900, title: 'bad' }] })),
		});
		expect(invalidSchema.statusCode).toBe(400);
		expect(state.repositories.calls.runTransaction).not.toHaveBeenCalled();

		const wrongType = multipartJson('{}', 'text/plain');
		wrongType.payload = Buffer.from(wrongType.payload.toString().replace('import.json', 'import.txt'));
		const rejectedType = await app.inject({
			method: 'POST',
			url: '/api/admin/import/preview',
			...wrongType,
		});
		expect(rejectedType.statusCode).toBe(400);

		const oversized = multipartJson(`"${'x'.repeat(10 * 1024 * 1024)}"`);
		const rejectedSize = await app.inject({
			method: 'POST',
			url: '/api/admin/import/preview',
			...oversized,
		});
		expect(rejectedSize.statusCode).toBe(413);
	});

	it('caps chunked encoded import bodies and rejects unknown or multiple parts without hanging', async () => {
		const capped = harness({ projects: [], inlineMaxBytes: 160 });
		const cappedApp = await routeApp(capped.graph);
		apps.push(cappedApp);
		const oversized = multipartJson(JSON.stringify({ value: 'x'.repeat(512) }));
		const body = oversized.payload;
		const rejectedEncoded = await cappedApp.inject({
			method: 'POST',
			url: '/api/admin/import/preview',
			headers: oversized.headers,
			payload: Readable.from([
				body.subarray(0, 80),
				body.subarray(80, 160),
				body.subarray(160),
			]),
		});
		expect(rejectedEncoded.statusCode, rejectedEncoded.body).toBe(413);
		expect(capped.repositories.calls.runTransaction).not.toHaveBeenCalled();

		const strict = harness({ projects: [] });
		const strictApp = await routeApp(strict.graph);
		apps.push(strictApp);
		const unknown = await strictApp.inject({
			method: 'POST',
			url: '/api/admin/import/preview',
			...multipartJson('{}', 'application/json', 'unknown'),
		});
		expect(unknown.statusCode).toBe(400);

		const multiple = await strictApp.inject({
			method: 'POST',
			url: '/api/admin/import/execute',
			...multipartJsonTwice(),
		});
		expect(multiple.statusCode).toBeGreaterThanOrEqual(400);
		expect(strict.repositories.calls.runTransaction).not.toHaveBeenCalled();
	});

	it('commits a durable export job and reports DB-backed status without reading object bytes', async () => {
		const state = harness();
		const app = await routeApp(state.graph);
		apps.push(app);

		const started = await app.inject({
			method: 'POST',
			url: '/api/admin/export',
			payload: { year: 2026, dryRun: true },
		});
		expect(started.statusCode, started.body).toBe(202);
		expect(started.json().data).toEqual({ jobId: 'id-1', status: 'QUEUED' });
		expect(state.repositories.calls.createJob).toHaveBeenCalledWith({
			id: 'id-1',
			requestedById: 9,
			year: 2026,
			dryRun: true,
		});
		expect(state.repositories.calls.findProjectsWithAssets).not.toHaveBeenCalled();
		expect(state.storage.calls.stream).not.toHaveBeenCalled();
		expect(state.fileSystem.calls.createWriteStream).not.toHaveBeenCalled();

		state.repositories.calls.latestJob.mockResolvedValueOnce({
			id: 'id-1',
			status: 'RUNNING',
			progress: { phase: 'downloading', downloaded: 3 },
			result: null,
			error: null,
		});
		const status = await app.inject({ method: 'GET', url: '/api/admin/export/status' });
		expect(status.statusCode).toBe(200);
		expect(status.json().data).toMatchObject({
			running: true,
			jobId: 'id-1',
			progress: { phase: 'downloading', downloaded: 3 },
		});
	});

	it('returns a repository-fenced conflict for a second active export job', async () => {
		const state = harness();
		state.repositories.calls.createJob.mockRejectedValueOnce(Object.assign(
			new Error('Export is already in progress'),
			{ statusCode: 409, code: 'CONFLICT' },
		));
		const app = await routeApp(state.graph);
		apps.push(app);

		const response = await app.inject({ method: 'POST', url: '/api/admin/export', payload: {} });
		expect(response.statusCode).toBe(409);
		expect(state.storage.calls.stream).not.toHaveBeenCalled();
		expect(state.fileSystem.calls.createWriteStream).not.toHaveBeenCalled();
	});

	it('does not bind a committed durable job to client or API graph lifetime', async () => {
		const state = harness();
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { entered = resolve; });
		state.repositories.calls.createJob.mockImplementationOnce(async (input: { id: string }) => {
			entered();
			await gate;
			return { id: input.id };
		});
		const app = await routeApp(state.graph);
		apps.push(app);
		await app.listen({ host: '127.0.0.1', port: 0 });
		const address = app.server.address();
		if (!address || typeof address === 'string') throw new Error('Expected TCP test address');
		const abort = new AbortController();
		const request = fetch(`http://127.0.0.1:${address.port}/api/admin/export`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
			signal: abort.signal,
		});
		await started;
		abort.abort();
		release();
		await expect(request).rejects.toThrow();
		await vi.waitFor(() => expect(state.repositories.calls.createJob).toHaveBeenCalledOnce());
		await expect(state.graph.close()).resolves.toBeUndefined();
		expect(state.storage.calls.stream).not.toHaveBeenCalled();
		expect(state.fileSystem.calls.createWriteStream).not.toHaveBeenCalled();
	});
});
