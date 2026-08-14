import { readFile } from 'node:fs/promises';
import { PassThrough, Readable, Writable } from 'node:stream';
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
import { createExportProgressStore } from '../modules/admin/export/service.js';
import type {
	ImportRepository,
	ImportTransactionRepository,
} from '../modules/admin/import/service.js';
import { createProtectedDownloadLimiter } from '../shared/protected-download-limiter.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createScriptedBackendPersistence } from './helpers/backend-persistence.js';
import { ownedTestUploadLifecycleResource } from './helpers/upload-lifecycle.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const imageDestination = '/nas/ExportedAssets/2026_Show/Ticket 010/image.png';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

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
} = {}) {
	const repositories = repositoryHarness(options.projects);
	const storage = options.storage ?? fakeStorage();
	const fileSystem = options.fileSystem ?? memoryFileSystem();
	const logger = fakeLogger();
	const progress = createExportProgressStore();
	let id = 0;
	const graph = createImportExportProductionGraph({
		config: { ...defaultTestEnv, NAS_EXPORT_PATH: '/nas' },
		importRepository: repositories.importRepository,
		exportRepository: repositories.exportRepository,
		storage: storage.storage,
		fileSystem,
		exportProgress: progress,
		clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
		ids: { next: () => `id-${++id}` },
		logger,
	});
	return { graph, repositories, storage, fileSystem, logger, progress };
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
			exportProgress: {
				value: state.progress,
				ownership: 'owned',
				close: () => {
					events.push('progress-close');
					expect(state.fileSystem.temporary.size).toBe(0);
					state.progress.close();
				},
			},
		},
	});
	contexts.push(context);
	return { ...state, context, events };
}

function multipartJson(raw: string, contentType = 'application/json') {
	const boundary = 'ticket-010-json';
	return {
		headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
		payload: Buffer.from(
			`--${boundary}\r\n`
			+ 'Content-Disposition: form-data; name="file"; filename="import.json"\r\n'
			+ `Content-Type: ${contentType}\r\n\r\n`
			+ `${raw}\r\n`
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
			'src/modules/admin/export/file.adapter.ts',
		]));
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

	it('isolates A/B progress and lets B continue after closing and aborting A', async () => {
		const a = await contextHarness();
		const b = await contextHarness();
		b.repositories.calls.findProjectsWithAssets.mockResolvedValue([]);
		const pending = new PassThrough();
		a.storage.calls.stream.mockResolvedValue({
			body: pending,
			size: 4,
			contentType: 'image/png',
		});
		const appA = await routePluginApp(a.context.routes.admin);
		const appB = await routePluginApp(b.context.routes.admin);
		apps.push(appA, appB);

		const exportA = appA.inject({
			method: 'POST',
			url: '/api/admin/export',
			payload: { year: 2026 },
		});
		await vi.waitFor(() => expect(a.storage.calls.stream).toHaveBeenCalledOnce());
		expect((await appA.inject({
			method: 'GET',
			url: '/api/admin/export/status',
		})).json().data).toMatchObject({ running: true });
		expect((await appB.inject({
			method: 'GET',
			url: '/api/admin/export/status',
		})).json().data).toEqual({ running: false, progress: null });

		await a.context.close();
		await expect(exportA).resolves.toMatchObject({ statusCode: 200 });
		expect(a.progress.get()).toBeNull();
		expect(a.fileSystem.temporary.size).toBe(0);
		await expect(appB.inject({
			method: 'POST',
			url: '/api/admin/export',
			payload: { dryRun: true },
		})).resolves.toMatchObject({ statusCode: 200 });
		expect(b.progress.get()).toBeNull();
		await b.context.close();
	});

	it('makes concurrent/double BackendContext close await one abort cleanup before progress closes', async () => {
		const state = await contextHarness();
		const pending = new PassThrough();
		const cleanupEntered = deferred<void>();
		const cleanupRelease = deferred<void>();
		let abortCount = 0;
		state.storage.calls.stream.mockImplementation(async (
			_bucket: string,
			_key: string,
			_range: unknown,
			request?: { signal?: AbortSignal },
		) => {
			request?.signal?.addEventListener('abort', () => { abortCount += 1; }, { once: true });
			return { body: pending, size: 4, contentType: 'image/png' };
		});
		const deferredRemove = vi.fn(async (path: string) => {
			cleanupEntered.resolve();
			await cleanupRelease.promise;
			state.fileSystem.files.delete(path);
			state.fileSystem.temporary.delete(path);
		});
		state.fileSystem.remove = deferredRemove;
		const finishSpy = vi.spyOn(state.progress, 'finish');
		const progressCloseSpy = vi.spyOn(state.progress, 'close');
		const app = await routePluginApp(state.context.routes.admin);
		apps.push(app);

		const running = app.inject({ method: 'POST', url: '/api/admin/export', payload: {} });
		await vi.waitFor(() => expect(state.storage.calls.stream).toHaveBeenCalledOnce());
		const firstClose = state.context.close();
		const secondClose = state.context.close();
		expect(secondClose).toBe(firstClose);
		await cleanupEntered.promise;
		let closeSettled = false;
		void firstClose.then(() => { closeSettled = true; });
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		expect(state.events).toEqual([]);
		cleanupRelease.resolve();
		await Promise.all([firstClose, secondClose]);
		const response = await running;
		expect(response.statusCode).toBe(200);
		expect(response.json().data).toMatchObject({
			aborted: true,
			downloaded: 0,
			failed: 0,
		});
		expect(state.events).toEqual(['progress-close']);
		expect(abortCount).toBe(1);
		expect(deferredRemove).toHaveBeenCalledOnce();
		expect(finishSpy).toHaveBeenCalledOnce();
		expect(progressCloseSpy).toHaveBeenCalledOnce();
		expect(state.fileSystem.temporary.size).toBe(0);
		expect(state.context.close()).toBe(firstClose);
		await state.context.close();
		expect(progressCloseSpy).toHaveBeenCalledOnce();
		expect(state.context.resourceOwnership).toEqual(expect.arrayContaining([
			{ name: 'importExport', ownership: 'owned' },
			{ name: 'exportProgress', ownership: 'owned' },
		]));
	});

	it('propagates a real client disconnect through storage and cleans temp/progress', async () => {
		const state = harness();
		const pending = new PassThrough();
		let receivedSignal: AbortSignal | undefined;
		state.storage.calls.stream.mockImplementation(async (
			_bucket: string,
			_key: string,
			_range: unknown,
			request?: { signal?: AbortSignal },
		) => {
			receivedSignal = request?.signal;
			return { body: pending, size: 4, contentType: 'image/png' };
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
		await vi.waitFor(() => expect(state.storage.calls.stream).toHaveBeenCalledOnce());
		abort.abort();
		await expect(request).rejects.toThrow();
		await vi.waitFor(() => {
			expect(receivedSignal?.aborted).toBe(true);
			expect(state.fileSystem.temporary.size).toBe(0);
			expect(state.progress.get()).toBeNull();
		});
	});

	it('treats a missing storage object as failed, leaves no file/temp, and releases the lock', async () => {
		const state = harness();
		state.storage.calls.stream.mockResolvedValueOnce(null);
		const app = await routeApp(state.graph);
		apps.push(app);

		const missing = await app.inject({ method: 'POST', url: '/api/admin/export', payload: {} });
		expect(missing.statusCode).toBe(200);
		expect(missing.json().data).toMatchObject({
			totalFiles: 1,
			failed: 1,
			downloaded: 0,
			aborted: false,
		});
		expect(state.fileSystem.files.has(imageDestination)).toBe(false);
		expect(state.fileSystem.temporary.size).toBe(0);
		expect(state.progress.get()).toBeNull();

		const later = await app.inject({
			method: 'POST',
			url: '/api/admin/export',
			payload: { dryRun: true },
		});
		expect(later.statusCode).toBe(200);
		expect(later.json().data).toMatchObject({ failed: 0, downloaded: 0 });
	});

	it('rejects a concurrent start and releases status/lock after storage read failure', async () => {
		const state = harness();
		const gate = deferred<void>();
		state.storage.calls.stream.mockImplementation(async () => {
			await gate.promise;
			throw new Error('S3 read failed');
		});
		const app = await routeApp(state.graph);
		apps.push(app);

		const first = app.inject({ method: 'POST', url: '/api/admin/export', payload: {} });
		await vi.waitFor(() => expect(state.storage.calls.stream).toHaveBeenCalledOnce());
		const concurrent = await app.inject({ method: 'POST', url: '/api/admin/export', payload: {} });
		expect(concurrent.statusCode).toBe(409);
		gate.resolve();
		const result = await first;
		expect(result.statusCode).toBe(200);
		expect(result.json().data).toMatchObject({ failed: 1, downloaded: 0 });
		expect((await app.inject({
			method: 'GET',
			url: '/api/admin/export/status',
		})).json().data).toEqual({ running: false, progress: null });
	});

	it.each([
		['write', 'filesystem write failed'],
		['rename', 'filesystem rename failed'],
	] as const)('cleans sibling temp and releases progress after %s failure', async (fault, message) => {
		const fileSystem = memoryFileSystem();
		fileSystem.faults[fault] = new Error(message);
		const state = harness({ fileSystem });
		const app = await routeApp(state.graph);
		apps.push(app);

		const response = await app.inject({ method: 'POST', url: '/api/admin/export', payload: {} });
		expect(response.statusCode).toBe(200);
		expect(response.json().data).toMatchObject({ failed: 1, downloaded: 0 });
		expect(fileSystem.temporary.size).toBe(0);
		expect(state.progress.get()).toBeNull();
	});

	it('exports a WebGL-only protected source ZIP through sibling-temp atomic rename', async () => {
		const deploymentId = '123e4567-e89b-42d3-a456-426614174000';
		const project = {
			...exportProject(),
			webglEntryKey: `webgl/71/${deploymentId}/site/index.html`,
			assets: [],
		};
		const state = harness({ projects: [project] });
		const app = await routeApp(state.graph);
		apps.push(app);

		const response = await app.inject({ method: 'POST', url: '/api/admin/export', payload: {} });
		const finalPath = '/nas/ExportedAssets/2026_Show/Ticket 010/webgl/webgl.zip';
		const temporaryPath = `${finalPath}.id-1.tmp`;
		expect(response.statusCode).toBe(200);
		expect(response.json().data).toMatchObject({
			totalFiles: 1,
			downloaded: 1,
			failed: 0,
		});
		expect(state.storage.calls.stream).toHaveBeenCalledWith(
			'pcu-protected',
			`webgl/71/${deploymentId}/source.zip`,
			undefined,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(state.storage.calls.stream.mock.calls.some(([bucket]) => bucket === 'pcu-public')).toBe(false);
		expect(state.fileSystem.calls.rename).toHaveBeenCalledWith(temporaryPath, finalPath);
		expect(state.fileSystem.files.get(finalPath)?.toString()).toBe('data');
		expect(state.fileSystem.files.has(temporaryPath)).toBe(false);
		expect(state.fileSystem.temporary.size).toBe(0);
	});

	it('diagnoses the exact temp left by rename+cleanup failure without success overcount', async () => {
		const fileSystem = memoryFileSystem();
		const renameError = new Error('rename failed');
		const cleanupError = new Error('cleanup failed');
		const temporaryPath = `${imageDestination}.id-1.tmp`;
		fileSystem.faults.rename = renameError;
		fileSystem.faults.remove = cleanupError;
		const state = harness({ fileSystem });
		const app = await routeApp(state.graph);
		apps.push(app);

		const response = await app.inject({ method: 'POST', url: '/api/admin/export', payload: {} });
		expect(response.statusCode).toBe(200);
		expect(response.json().data).toMatchObject({ failed: 1, downloaded: 0 });
		expect(fileSystem.files.has(imageDestination)).toBe(false);
		expect(fileSystem.files.get(temporaryPath)?.toString()).toBe('data');
		expect(fileSystem.temporary).toEqual(new Set([temporaryPath]));
		expect(state.logger.warn).toHaveBeenCalledWith(
			{ err: cleanupError, path: temporaryPath },
			'Failed to remove partial export file',
		);
		expect(state.progress.get()).toBeNull();
		fileSystem.faults.rename = undefined;
		fileSystem.faults.remove = undefined;
		await fileSystem.remove(temporaryPath);
		expect(fileSystem.files.has(temporaryPath)).toBe(false);
		expect(fileSystem.temporary.size).toBe(0);
		await expect(app.inject({
			method: 'POST',
			url: '/api/admin/export',
			payload: { dryRun: true },
		})).resolves.toMatchObject({ statusCode: 200 });
	});
});
