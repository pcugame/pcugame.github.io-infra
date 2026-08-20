import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger, ObjectStorage, SettingsStore } from '../application/ports.js';
import { createNodeFileSystem } from '../infrastructure/production-ports.js';
import { createAdminRoutes } from '../modules/admin/admin.routes.js';
import {
	createGameUploadProductionGraph,
	type GameUploadProductionGraph,
} from '../modules/admin/game-upload/composition.js';
import type { GameUploadSessionRecord } from '../modules/admin/game-upload/ports.js';
import { sourceIdentityRoot } from '../modules/admin/game-upload/source-identity.js';
import { createUploadLimiter } from '../shared/upload-limits.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import {
	createDurableGameUploadRepository,
	createTestUploadLifecycleRuntime,
} from './helpers/upload-lifecycle.js';
import { forbidden } from '../shared/errors.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const apps: FastifyInstance[] = [];

function sourceForByte(value: number) {
	const digest = createHash('sha256').update(Buffer.from([value])).digest('hex');
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
		sourceIdentity: sourceIdentityRoot(1, 1024 * 1024, [digest]),
		sourceIdentityBlockSizeBytes: 1024 * 1024,
		sourceIdentityBlockManifest: Buffer.from(digest, 'hex'),
		sourceIdentityBlockDigests: [digest],
	};
}

const logger: AppLogger = {
	child: () => logger,
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	fatal: vi.fn(),
};

function session(
	overrides: Partial<GameUploadSessionRecord> = {},
): GameUploadSessionRecord {
	return {
		id: 'session-1',
		projectId: 7,
		userId: 11,
		uploadKind: 'GAME',
		transport: 'API_CHUNK_PROXY',
		originalName: 'game.zip',
		totalBytes: 1n,
		chunkSizeBytes: 1,
		totalChunks: 1,
		uploadedChunks: [],
		status: 'PENDING',
		expiresAt: new Date('2026-08-12T00:00:00.000Z'),
		s3UploadId: 'multipart-1',
		s3Key: 'game-object.zip',
		storageKey: null,
		parts: [],
		multipartGeneration: 1,
		...sourceForByte(1),
		project: { status: 'PUBLISHED' },
		...overrides,
	};
}

function createStorageHarness() {
	let headResult: { size: number; contentType: string } | null = null;
	let header: Buffer = Buffer.from('not-a-zip');
	let uploadPartGate: Promise<void> | undefined;
	const calls = {
		presignUploadPart: vi.fn(async () => 'https://storage.test/upload-part'),
		createMultipart: vi.fn(async () => 'multipart-new'),
		abortMultipart: vi.fn(async () => undefined),
		uploadPart: vi.fn(async (
			_bucket: string,
			_key: string,
			_uploadId: string,
			_partNumber: number,
			body: Buffer | NodeJS.ReadableStream,
		) => {
			for await (const _chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
				// Consume the request stream; content is irrelevant to this wiring test.
			}
			if (uploadPartGate) await uploadPartGate;
			return 'etag-1';
		}),
		completeMultipart: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
		listParts: vi.fn(async () => [{ partNumber: 1, etag: 'etag-1', sizeBytes: 1 }]),
		listMultipartUploads: vi.fn(async () => []),
		head: vi.fn(async () => headResult),
		readRange: vi.fn(async () => header),
	};
	const storage: ObjectStorage = {
		upload: async () => {},
		presign: async () => 'https://storage.test/object',
		presignUploadPart: calls.presignUploadPart,
		delete: calls.delete,
		head: calls.head,
		readRange: calls.readRange,
		stream: async () => null,
		listKeys: async () => [],
		listKeyPage: async () => ({ keys: [], isTruncated: false }),
		deleteKeys: async (_bucket, keys) => ({ deleted: [...keys], failures: [] }),
		createMultipart: calls.createMultipart,
		uploadPart: calls.uploadPart,
		completeMultipart: calls.completeMultipart,
		abortMultipart: calls.abortMultipart,
		listParts: calls.listParts,
		listMultipartUploads: calls.listMultipartUploads,
	};
	return {
		storage,
		calls,
		setHead(value: typeof headResult) { headResult = value; },
		setHeader(value: Buffer) { header = value; },
		blockUploadPart(gate: Promise<void>) { uploadPartGate = gate; },
	};
}

function idGenerator() {
	let sequence = 0;
	return {
		next() {
			sequence += 1;
			return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
		},
	};
}

function graphHarness() {
	const storage = createStorageHarness();
	const repository = createDurableGameUploadRepository({
		findExhibitionById: vi.fn(async () => ({
			id: 1,
			year: 2026,
			title: 'Exhibition',
			isUploadEnabled: true,
		})),
	});
	const uploadLifecycle = createTestUploadLifecycleRuntime({ gameUploads: repository });
	const settings: SettingsStore = {
		get: vi.fn(async () => ({ maxGameFileMb: 8, maxChunkSizeMb: 1 })),
		update: vi.fn(async () => ({ maxGameFileMb: 8, maxChunkSizeMb: 1 })),
		invalidate: vi.fn(),
	};
	const access = {
		loadProjectWithAccess: vi.fn(async () => ({
			id: 7,
			exhibitionId: 1,
			creatorId: 11,
			status: 'PUBLISHED',
		})),
	};
	const graph = createGameUploadProductionGraph({
		config: {
			...defaultTestEnv,
			API_PUBLIC_URL: 'https://api.test',
			S3_BUCKET_PUBLIC: 'public',
			S3_BUCKET_PROTECTED: 'protected',
			UPLOAD_CHUNK_SIZE_MB: 1,
			UPLOAD_SESSION_TTL_MINUTES: 60,
			UPLOAD_USER_GAME_MAX_MB: 8,
			UPLOAD_PRIVILEGED_GAME_MAX_MB: 8,
		},
		storage: storage.storage,
		fileSystem: createNodeFileSystem(),
		settings,
		uploadLimiter: createUploadLimiter(() => 2),
		lifecycle: {
			state: () => 'ready',
			setState: vi.fn(),
			isAcceptingNewWork: () => true,
			requestStarted: vi.fn(),
			requestFinished: vi.fn(),
			inFlight: () => 0,
			waitForDrain: async () => 'drained',
		},
		clock: { now: () => new Date('2026-08-11T00:00:00.000Z') },
		ids: idGenerator(),
		logger,
		access,
		uploadLifecycle,
	});
	return { graph, repository, uploadLifecycle, storage, settings, access };
}

function actorPlugin(
	controller: FastifyPluginAsync,
	actor: { id: number; role: 'USER' | 'ADMIN' | 'OPERATOR' } = { id: 11, role: 'ADMIN' },
): FastifyPluginAsync {
	return async (app) => {
		app.addHook('onRequest', async (request) => {
			request.currentUser = {
				id: actor.id,
				googleSub: 'game-upload-wiring',
				email: 'admin@example.test',
				name: 'Admin',
				role: actor.role,
			};
		});
		await app.register(controller);
	};
}

async function routeApp(
	graph: GameUploadProductionGraph,
	actor?: { id: number; role: 'USER' | 'ADMIN' | 'OPERATOR' },
): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
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
	await app.register(actorPlugin(createAdminRoutes({
		projectController: emptyRoute,
		memberController: emptyRoute,
		settingsController: emptyRoute,
		bannedIpController: emptyRoute,
		exhibitionController: emptyRoute,
		importController: emptyRoute,
		exportController: emptyRoute,
		projectMultipartController: emptyRoute,
		gameUploadController: graph.controller,
	}), actor), { prefix: '/api/admin' });
	await app.ready();
	apps.push(app);
	return app;
}

afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
	vi.restoreAllMocks();
});

describe('game-upload production composition', () => {
	it('constructs from required ports without Prisma, storage I/O, timers, or feature-local lifecycle workers', async () => {
		const source = await readFile(
			new URL('../modules/admin/game-upload/composition.ts', import.meta.url),
			'utf8',
		);
		expect(source).not.toMatch(/lib\/(prisma|s3|storage|logger)|createGameUploadRepository/);

		const interval = vi.spyOn(globalThis, 'setInterval');
		const harness = graphHarness();
		await routeApp(harness.graph);
		expect(harness.repository.findSessionById).not.toHaveBeenCalled();
		expect(harness.storage.calls.createMultipart).not.toHaveBeenCalled();
		expect(interval).not.toHaveBeenCalled();

		const report = await cruise(['src/modules/admin/game-upload/composition.ts'], {
			doNotFollow: { path: '(^|/)node_modules/' },
			exclude: { path: '(^|/)(dist|generated|__tests__)/' },
		});
		expect(typeof report.output).not.toBe('string');
		const modules = (report.output as ICruiseResult).modules.map(({ source: module }) => module);
		expect(modules).toEqual(expect.arrayContaining([
			'src/modules/admin/game-upload/composition.ts',
			'src/modules/admin/game-upload/controller.ts',
			'src/modules/webgl/deployment.ts',
		]));
		expect(modules).not.toContain('src/modules/admin/game-upload/repository.ts');
		expect(modules).not.toContain('src/modules/orphan/service.ts');
	});

	it('routes session creation through the context-owned durable repository and wakes tracked replacement cleanup', async () => {
		const harness = graphHarness();
		vi.mocked(harness.repository.findExhibitionById).mockResolvedValue({
			id: 1,
			year: 2026,
			title: 'Exhibition',
			isUploadEnabled: true,
		});
		vi.mocked(harness.repository.createSessionReplacingActive).mockResolvedValue({
			session: { id: 'created-session' },
			durableAborts: [{
				tracking: 'durable-abort-task-committed',
				sessionId: 'old-session',
				key: 'old.zip',
				uploadId: 'old-upload',
				reason: 'active-upload-replaced',
			}],
		});
		harness.storage.calls.abortMultipart.mockRejectedValueOnce(new Error('prompt abort failed'));
		const app = await routeApp(harness.graph);
		const response = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/7/game-upload-sessions',
			payload: { originalName: 'game.zip', totalBytes: 1, ...sourceForByte(1) },
		});

		expect(response.statusCode, response.body).toBe(201);
		expect(response.json().data).toMatchObject({
			transport: 'DIRECT_MULTIPART',
			generation: 1,
		});
		expect(harness.repository.createSessionReplacingActive).toHaveBeenCalledWith(
			expect.objectContaining({
				id: expect.any(String),
				s3UploadId: 'multipart-new',
				s3Key: expect.stringMatching(/\.zip$/),
			}),
		);
		expect(harness.uploadLifecycle.wakeMaintenance).toHaveBeenCalledOnce();
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'old-session' }),
			'Failed to abort multipart upload while replacing active session',
		);
	});

	it('wires the public UploadPart signer with configured bounds and rechecks upload policy', async () => {
		const harness = graphHarness();
		vi.mocked(harness.repository.findSessionById).mockResolvedValue(session({
			transport: 'DIRECT_MULTIPART',
			multipartGeneration: 4,
		}));
		vi.mocked(harness.repository.findExhibitionById).mockResolvedValue({
			id: 1,
			year: 2026,
			title: 'Closed exhibition',
			isUploadEnabled: false,
		});

		await expect(harness.graph.service.signPartUrls(
			'session-1',
			{ id: 11, role: 'USER' },
			{ generation: 4, partNumbers: [1] },
		)).rejects.toMatchObject({ statusCode: 403 });
		expect(harness.storage.calls.presignUploadPart).not.toHaveBeenCalled();

		vi.mocked(harness.repository.findExhibitionById).mockResolvedValue({
			id: 1,
			year: 2026,
			title: 'Open exhibition',
			isUploadEnabled: true,
		});
		await expect(harness.graph.service.signPartUrls(
			'session-1',
			{ id: 11, role: 'USER' },
			{ generation: 4, partNumbers: [1] },
		)).resolves.toMatchObject({ generation: 4, parts: [{ partNumber: 1 }] });
		expect(harness.storage.calls.presignUploadPart).toHaveBeenCalledWith(
			'protected',
			'game-object.zip',
			'multipart-1',
			1,
			defaultTestEnv.UPLOAD_PART_URL_TTL_SEC,
		);
	});

	it('never sends a DIRECT_MULTIPART body through the legacy chunk relay and returns 202 after storage completion', async () => {
		const harness = graphHarness();
		vi.mocked(harness.repository.findSessionById).mockResolvedValue(session({
			transport: 'DIRECT_MULTIPART',
			multipartGeneration: 1,
		}));
		harness.storage.calls.listParts.mockResolvedValue([
			{ partNumber: 1, etag: 'garage-etag', sizeBytes: 1 },
		]);
		harness.storage.setHead({ size: 1, contentType: 'application/zip' });
		const app = await routeApp(harness.graph);

		const rejectedChunk = await app.inject({
			method: 'PUT',
			url: '/api/admin/game-upload-sessions/session-1/chunks/0',
			headers: { 'content-type': 'application/octet-stream' },
			payload: Buffer.from([1]),
		});
		expect(rejectedChunk.statusCode).toBe(400);
		expect(harness.storage.calls.uploadPart).not.toHaveBeenCalled();

		const completed = await app.inject({
			method: 'POST',
			url: '/api/admin/game-upload-sessions/session-1/complete',
			payload: {
				generation: 1,
				parts: [{ partNumber: 1, etag: 'garage-etag', sizeBytes: 1 }],
			},
		});
		expect(completed.statusCode, completed.body).toBe(202);
		expect(completed.json().data).toMatchObject({ status: 'VERIFYING', generation: 1 });
		expect(harness.repository.markVerifying).toHaveBeenCalled();
	});

	it('enforces owner access and privileged overrides on direct status, complete, and cancel routes', async () => {
		const actions = [
			{ method: 'GET' as const, url: '/api/admin/game-upload-sessions/session-1' },
			{
				method: 'POST' as const,
				url: '/api/admin/game-upload-sessions/session-1/complete',
				payload: {
					generation: 1,
					parts: [{ partNumber: 1, etag: 'garage-etag', sizeBytes: 1 }],
				},
			},
			{ method: 'DELETE' as const, url: '/api/admin/game-upload-sessions/session-1' },
		];

		const otherUser = graphHarness();
		vi.mocked(otherUser.repository.findSessionById).mockResolvedValue(session({
			transport: 'DIRECT_MULTIPART',
		}));
		const otherUserApp = await routeApp(otherUser.graph, { id: 12, role: 'USER' });
		for (const action of actions) {
			const response = await otherUserApp.inject(action);
			expect(response.statusCode, `${action.method} ${response.body}`).toBe(403);
		}
		expect(otherUser.storage.calls.completeMultipart).not.toHaveBeenCalled();
		expect(otherUser.repository.cancelSessionAndClearActive).not.toHaveBeenCalled();

		for (const role of ['ADMIN', 'OPERATOR'] as const) {
			const privileged = graphHarness();
			vi.mocked(privileged.repository.findSessionById).mockResolvedValue(session({
				transport: 'DIRECT_MULTIPART',
			}));
			privileged.storage.calls.listParts.mockResolvedValue([
				{ partNumber: 1, etag: 'garage-etag', sizeBytes: 1 },
			]);
			privileged.storage.setHead({ size: 1, contentType: 'application/zip' });
			const app = await routeApp(privileged.graph, { id: 12, role });
			const responses = [];
			for (const action of actions) responses.push(await app.inject(action));
			expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 202, 204]);
		}

		const removed = graphHarness();
		vi.mocked(removed.repository.findSessionById).mockResolvedValue(session({
			transport: 'DIRECT_MULTIPART',
		}));
		removed.access.loadProjectWithAccess.mockRejectedValue(
			forbidden('Not project owner or member'),
		);
		const removedApp = await routeApp(removed.graph, { id: 11, role: 'USER' });
		for (const action of actions) {
			const response = await removedApp.inject(action);
			expect(response.statusCode, `${action.method} ${response.body}`).toBe(403);
		}
		expect(removed.storage.calls.completeMultipart).not.toHaveBeenCalled();
		expect(removed.repository.cancelSessionAndClearActive).not.toHaveBeenCalled();
	});

	it('uses required part-claim and generation ports instead of a legacy ETag write shortcut', async () => {
		const harness = graphHarness();
		vi.mocked(harness.repository.findSessionById).mockResolvedValue(session({
			multipartGeneration: 3,
		}));
		vi.mocked(harness.repository.completePartClaim).mockResolvedValue({
			accepted: true,
			parts: [{ partNumber: 1, etag: 'etag-1', generation: 3 }],
		});
		const app = await routeApp(harness.graph);
		const response = await app.inject({
			method: 'PUT',
			url: `/api/admin/game-upload-sessions/session-1/chunks/0?sourceIdentityAlgorithm=SHA256_BLOCK_MANIFEST_V1&sourceIdentity=${session().sourceIdentity}`,
			headers: { 'content-type': 'application/octet-stream' },
			payload: Buffer.from([1]),
		});

		expect(response.statusCode, response.body).toBe(200);
		const claim = vi.mocked(harness.repository.acquirePartClaim).mock.calls[0]?.[0];
		expect(claim).toMatchObject({
			sessionId: 'session-1',
			partNumber: 1,
			generation: 3,
			token: expect.any(String),
		});
		expect(harness.repository.completePartClaim).toHaveBeenCalledWith({
			token: claim?.token,
			etag: 'etag-1',
			contentSha256: createHash('sha256').update(Buffer.from([1])).digest('hex'),
		});
	});

	it('passes the completion claim token into the atomic terminal outbox commit and only wakes the worker afterward', async () => {
		const harness = graphHarness();
		vi.mocked(harness.repository.findSessionById).mockResolvedValue(session({
			parts: [{ partNumber: 1, etag: 'etag-1', generation: 1, contentSha256: createHash('sha256').update(Buffer.from([1])).digest('hex') }],
		}));
		vi.mocked(harness.repository.findPartsBySessionId).mockResolvedValue([
			{ partNumber: 1, etag: 'etag-1', generation: 1, contentSha256: createHash('sha256').update(Buffer.from([1])).digest('hex') },
		]);
		harness.storage.setHead({ size: 1, contentType: 'application/zip' });
		harness.storage.setHeader(Buffer.from('not-a-zip'));
		const app = await routeApp(harness.graph);
		const response = await app.inject({
			method: 'POST',
			url: '/api/admin/game-upload-sessions/session-1/complete',
		});

		expect(response.statusCode, response.body).toBe(400);
		const completion = vi.mocked(harness.repository.claimCompletion).mock.calls[0]?.[0];
		expect(completion).toMatchObject({
			sessionId: 'session-1',
			generation: 1,
			token: expect.any(String),
		});
		expect(harness.repository.markCompletedObjectFailed).toHaveBeenCalledWith({
			sessionId: 'session-1',
			storageKey: 'game-object.zip',
			reason: 'game-upload-completion-invalid',
			completionClaimToken: completion?.token,
		});
		expect(harness.uploadLifecycle.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(harness.storage.calls.delete).not.toHaveBeenCalled();
	});

	it('does not wake deletion or report terminal success when the atomic outbox commit fails', async () => {
		const harness = graphHarness();
		vi.mocked(harness.repository.findSessionById).mockResolvedValue(session({
			parts: [{ partNumber: 1, etag: 'etag-1', generation: 1, contentSha256: createHash('sha256').update(Buffer.from([1])).digest('hex') }],
		}));
		vi.mocked(harness.repository.findPartsBySessionId).mockResolvedValue([
			{ partNumber: 1, etag: 'etag-1', generation: 1, contentSha256: createHash('sha256').update(Buffer.from([1])).digest('hex') },
		]);
		vi.mocked(harness.repository.markCompletedObjectFailed).mockRejectedValue(
			new Error('atomic outbox unavailable'),
		);
		harness.storage.setHead({ size: 1, contentType: 'application/zip' });
		const app = await routeApp(harness.graph);
		const response = await app.inject({
			method: 'POST',
			url: '/api/admin/game-upload-sessions/session-1/complete',
		});

		expect(response.statusCode).toBe(500);
		expect(response.json().error.message).toContain('atomic outbox unavailable');
		expect(harness.uploadLifecycle.wakeDeletionWorker).not.toHaveBeenCalled();
		expect(harness.storage.calls.delete).not.toHaveBeenCalled();
	});

	it('uses claimed recovery and keeps two injected durable runtimes isolated', async () => {
		const a = graphHarness();
		const b = graphHarness();
		vi.mocked(a.repository.claimStaleCompletingSessions).mockResolvedValue([
			session({ id: 'stale-a', s3Key: null, s3UploadId: null, status: 'COMPLETING' }),
		]);

		await a.graph.recoverStaleUploads();
		expect(a.repository.claimStaleCompletingSessions).toHaveBeenCalledWith(
			new Date('2026-08-10T23:55:00.000Z'),
			expect.any(String),
			2 * 60 * 1000,
			50,
		);
		expect(a.repository.markFailed).toHaveBeenCalledWith(
			'stale-a',
			undefined,
			expect.any(String),
		);
		expect(b.repository.claimStaleCompletingSessions).not.toHaveBeenCalled();
	});

	it('drains only its own active upload work during close', async () => {
		const a = graphHarness();
		const b = graphHarness();
		vi.mocked(a.repository.findSessionById).mockResolvedValue(session());
		vi.mocked(b.repository.findSessionById).mockResolvedValue(session({ id: 'session-b', ...sourceForByte(2) }));
		vi.mocked(a.repository.completePartClaim).mockResolvedValue({
			accepted: true,
			parts: [{ partNumber: 1, etag: 'etag-1', generation: 1 }],
		});
		vi.mocked(b.repository.completePartClaim).mockResolvedValue({
			accepted: true,
			parts: [{ partNumber: 1, etag: 'etag-1', generation: 1 }],
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		a.storage.blockUploadPart(gate);

		const activeA = a.graph.service.uploadChunk(
			'session-1',
			0,
			Readable.from([Buffer.from([1])]),
			{ id: 11, role: 'ADMIN' },
			{ sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: session().sourceIdentity! },
		);
		await vi.waitFor(() => expect(a.storage.calls.uploadPart).toHaveBeenCalledOnce());
		let closed = false;
		const closing = a.graph.close().then(() => { closed = true; });
		await Promise.resolve();
		expect(closed).toBe(false);

		await expect(b.graph.service.uploadChunk(
			'session-b',
			0,
			Readable.from([Buffer.from([2])]),
			{ id: 11, role: 'ADMIN' },
			{ sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: sourceForByte(2).sourceIdentity },
		)).resolves.toMatchObject({ uploadedCount: 1 });
		release();
		await Promise.all([activeA, closing]);
		expect(closed).toBe(true);
		expect(b.repository.completePartClaim).toHaveBeenCalledOnce();
		await b.graph.close();
	});
});
