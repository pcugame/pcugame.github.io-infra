import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import type { S3Client } from '@aws-sdk/client-s3';
import Fastify, {
	type FastifyInstance,
	type FastifyPluginAsync,
} from 'fastify';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	AppLogger,
	ObjectStorage,
	Scheduler,
	SettingsStore,
} from '../application/ports.js';
import { buildApp } from '../app.js';
import {
	createProductionBackendContext,
} from '../backend-context.js';
import type { Env } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createNodeFileSystem } from '../infrastructure/production-ports.js';
import { createAdminRoutes } from '../modules/admin/admin.routes.js';
import {
	createGameUploadProductionGraph,
	type GameUploadProductionGraph,
} from '../modules/admin/game-upload/composition.js';
import { createProjectAccessRepository } from '../modules/admin/project-access.repository.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createUploadLimiter } from '../shared/upload-limits.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const apps: FastifyInstance[] = [];

const logger: AppLogger = {
	child: () => logger,
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	fatal: vi.fn(),
};

interface SessionRow {
	id: string;
	projectId: number;
	userId: number;
	uploadKind: 'GAME' | 'WEBGL';
	originalName: string;
	totalBytes: bigint;
	chunkSizeBytes: number;
	totalChunks: number;
	uploadedChunks: number[];
	status: string;
	expiresAt: Date;
	s3UploadId: string | null;
	s3Key: string | null;
	storageKey: string | null;
	createdAt: Date;
	updatedAt: Date;
}

function matchesStatus(actual: string, expected: unknown): boolean {
	if (typeof expected === 'string') return actual === expected;
	if (
		expected
		&& typeof expected === 'object'
		&& 'in' in expected
		&& Array.isArray((expected as { in: unknown }).in)
	) {
		return (expected as { in: unknown[] }).in.includes(actual);
	}
	return true;
}

function prismaHarness(label: string) {
	const now = new Date('2026-07-31T00:00:00.000Z');
	const project = {
		id: 7,
		exhibitionId: 1,
		creatorId: 11,
		status: 'PUBLISHED',
		webglEntryKey: '',
	};
	const exhibition = {
		id: 1,
		year: 2026,
		title: `${label} exhibition`,
		isUploadEnabled: true,
	};
	const sessions = new Map<string, SessionRow>();
	const active = new Map<string, string>();
	const parts = new Map<string, Map<number, { id: number; sessionId: string; partNumber: number; etag: string }>>();
	const orphans = new Map<string, {
		id: number;
		bucket: string;
		storageKey: string;
		reason: string;
		attemptCount: number;
		lastTriedAt: Date | null;
		lastError: string | null;
		resolvedAt: Date | null;
	}>();
	let partId = 0;
	let orphanId = 0;

	function sessionResult(row: SessionRow) {
		return {
			...row,
			parts: [...(parts.get(row.id)?.values() ?? [])]
				.sort((a, b) => a.partNumber - b.partNumber),
			project: { status: project.status },
		};
	}

	const calls = {
		sessionFind: vi.fn(),
		sessionCreate: vi.fn(),
		sessionUpdateMany: vi.fn(),
		activeFind: vi.fn(),
		activeUpsert: vi.fn(),
		activeDeleteMany: vi.fn(),
		partUpsert: vi.fn(),
		orphanUpsert: vi.fn(),
		orphanFindMany: vi.fn(),
		bannedFindMany: vi.fn(async () => []),
	};

	const client = {
		project: {
			findUnique: vi.fn(async ({ where }: { where: { id: number } }) => (
				where.id === project.id ? { ...project } : null
			)),
		},
		projectMember: {
			findFirst: vi.fn(async () => null),
		},
		exhibition: {
			findUnique: vi.fn(async ({ where }: { where: { id: number } }) => (
				where.id === exhibition.id ? { ...exhibition } : null
			)),
		},
		gameUploadSession: {
			findUnique: calls.sessionFind.mockImplementation(async ({ where }: {
				where: { id: string };
			}) => {
				const row = sessions.get(where.id);
				return row ? sessionResult(row) : null;
			}),
			create: calls.sessionCreate.mockImplementation(async ({ data }: {
				data: Omit<
					SessionRow,
					'uploadedChunks' | 'status' | 'storageKey' | 'createdAt' | 'updatedAt'
				>;
			}) => {
				const row: SessionRow = {
					...data,
					uploadedChunks: [],
					status: 'PENDING',
					storageKey: null,
					createdAt: now,
					updatedAt: now,
				};
				sessions.set(row.id, row);
				return { ...row };
			}),
			updateMany: calls.sessionUpdateMany.mockImplementation(async ({ where, data }: {
				where: { id: string; status?: unknown; uploadKind?: string };
				data: Partial<SessionRow>;
			}) => {
				const row = sessions.get(where.id);
				if (
					!row
					|| !matchesStatus(row.status, where.status)
					|| (where.uploadKind && row.uploadKind !== where.uploadKind)
				) {
					return { count: 0 };
				}
				Object.assign(row, data, { updatedAt: now });
				return { count: 1 };
			}),
			findMany: vi.fn(async ({ where }: {
				where: {
					status?: unknown;
					projectId?: number;
					userId?: number;
					updatedAt?: { lt: Date };
				};
			}) => [...sessions.values()]
				.filter((row) => matchesStatus(row.status, where.status))
				.filter((row) => where.projectId === undefined || row.projectId === where.projectId)
				.filter((row) => where.userId === undefined || row.userId === where.userId)
				.filter((row) => !where.updatedAt || row.updatedAt < where.updatedAt.lt)
				.map(sessionResult)),
		},
		gameUploadActiveSession: {
			findUnique: calls.activeFind.mockImplementation(async ({ where }: {
				where: { projectId_uploadKind: { projectId: number; uploadKind: string } };
			}) => {
				const key = `${where.projectId_uploadKind.projectId}:${where.projectId_uploadKind.uploadKind}`;
				const sessionId = active.get(key);
				const session = sessionId ? sessions.get(sessionId) : undefined;
				return sessionId
					? { sessionId, session: session ? { ...session } : null }
					: null;
			}),
			upsert: calls.activeUpsert.mockImplementation(async ({ update, create }: {
				update: { sessionId: string };
				create: { projectId: number; uploadKind: string; sessionId: string };
			}) => {
				active.set(`${create.projectId}:${create.uploadKind}`, update.sessionId);
				return create;
			}),
			deleteMany: calls.activeDeleteMany.mockImplementation(async ({ where }: {
				where: { sessionId: string };
			}) => {
				let count = 0;
				for (const [key, sessionId] of active) {
					if (sessionId === where.sessionId) {
						active.delete(key);
						count += 1;
					}
				}
				return { count };
			}),
		},
		gameUploadPart: {
			upsert: calls.partUpsert.mockImplementation(async ({ where, update, create }: {
				where: { game_upload_part_session_part: { sessionId: string; partNumber: number } };
				update: { etag: string };
				create: { sessionId: string; partNumber: number; etag: string };
			}) => {
				const { sessionId, partNumber } = where.game_upload_part_session_part;
				const sessionParts = parts.get(sessionId) ?? new Map();
				const existing = sessionParts.get(partNumber);
				const row = existing
					? { ...existing, etag: update.etag }
					: { id: ++partId, ...create };
				sessionParts.set(partNumber, row);
				parts.set(sessionId, sessionParts);
				return row;
			}),
			findMany: vi.fn(async ({ where }: { where: { sessionId: string } }) => (
				[...(parts.get(where.sessionId)?.values() ?? [])]
					.sort((a, b) => a.partNumber - b.partNumber)
			)),
			deleteMany: vi.fn(async ({ where }: { where: { sessionId: string } }) => {
				const count = parts.get(where.sessionId)?.size ?? 0;
				parts.delete(where.sessionId);
				return { count };
			}),
		},
		orphanObject: {
			upsert: calls.orphanUpsert.mockImplementation(async ({ where, create, update }: {
				where: { orphan_bucket_storage_key: { bucket: string; storageKey: string } };
				create: { bucket: string; storageKey: string; reason: string };
				update: Partial<{
					reason: string;
					resolvedAt: null;
					attemptCount: number;
					lastTriedAt: null;
					lastError: null;
				}>;
			}) => {
				const key = `${where.orphan_bucket_storage_key.bucket}\0${where.orphan_bucket_storage_key.storageKey}`;
				const previous = orphans.get(key);
				const row = previous
					? { ...previous, ...update }
					: {
							id: ++orphanId,
							...create,
							attemptCount: 0,
							lastTriedAt: null,
							lastError: null,
							resolvedAt: null,
						};
				orphans.set(key, row);
				return row;
			}),
			findMany: calls.orphanFindMany.mockImplementation(async () => (
				[...orphans.values()].filter(({ resolvedAt }) => resolvedAt === null)
			)),
			update: vi.fn(async ({ where, data }: {
				where: { id: number };
				data: Record<string, unknown>;
			}) => {
				const entry = [...orphans.entries()].find(([, row]) => row.id === where.id);
				if (!entry) throw new Error('orphan not found');
				const [key, row] = entry;
				orphans.set(key, { ...row, ...data });
				return orphans.get(key);
			}),
		},
		authSession: {
			findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (
				where.id === 'ticket-012-session'
					? {
							id: where.id,
							expiresAt: new Date('2026-08-01T00:00:00.000Z'),
							lastSeenAt: now,
							user: {
								id: 11,
								googleSub: 'ticket-012',
								email: 'ticket-012@example.test',
								name: 'Ticket 012',
								role: 'ADMIN',
								studentId: null,
							},
						}
					: null
			)),
			update: vi.fn(async () => ({})),
			delete: vi.fn(async () => ({})),
			deleteMany: vi.fn(async () => ({ count: 0 })),
		},
		bannedIp: {
			findMany: calls.bannedFindMany,
		},
		$transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
		$queryRaw: vi.fn(async () => [{ id: project.id }]),
		$disconnect: vi.fn(async () => {}),
	} as unknown as PrismaClient;

	return {
		client,
		calls,
		sessions,
		active,
		parts,
		orphans,
		project,
		seedSession(row: Partial<SessionRow> & Pick<SessionRow, 'id'>) {
			const session: SessionRow = {
				id: row.id,
				projectId: row.projectId ?? project.id,
				userId: row.userId ?? 11,
				uploadKind: row.uploadKind ?? 'GAME',
				originalName: row.originalName ?? 'game.zip',
				totalBytes: row.totalBytes ?? 1n,
				chunkSizeBytes: row.chunkSizeBytes ?? 1,
				totalChunks: row.totalChunks ?? 1,
				uploadedChunks: row.uploadedChunks ?? [],
				status: row.status ?? 'PENDING',
				expiresAt: row.expiresAt ?? new Date('2026-08-01T00:00:00.000Z'),
				s3UploadId: row.s3UploadId ?? 'multipart-seeded',
				s3Key: row.s3Key ?? `${label}-seeded.zip`,
				storageKey: row.storageKey ?? null,
				createdAt: row.createdAt ?? now,
				updatedAt: row.updatedAt ?? now,
			};
			sessions.set(session.id, session);
			active.set(`${session.projectId}:${session.uploadKind}`, session.id);
			return session;
		},
	};
}

async function consume(body: Buffer | NodeJS.ReadableStream): Promise<Buffer> {
	if (Buffer.isBuffer(body)) return body;
	const chunks: Buffer[] = [];
	for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

function storageHarness(label: string) {
	const objects = new Map<string, Buffer>();
	const multiparts = new Map<string, {
		bucket: string;
		key: string;
		parts: Map<number, Buffer>;
	}>();
	let sequence = 0;
	let headFailure: Error | undefined;
	let deleteFailure: Error | undefined;
	let uploadPartGate: Promise<void> | undefined;
	const calls = {
		createMultipart: vi.fn(),
		uploadPart: vi.fn(),
		completeMultipart: vi.fn(),
		abortMultipart: vi.fn(),
		head: vi.fn(),
		delete: vi.fn(),
		upload: vi.fn(),
		stream: vi.fn(),
	};
	const storage: ObjectStorage = {
		upload: calls.upload.mockImplementation(async (
			bucket: string,
			key: string,
			body: Buffer | NodeJS.ReadableStream,
		) => {
			objects.set(`${bucket}/${key}`, await consume(body));
		}),
		presign: vi.fn(async (_bucket, key) => `https://${label}.storage.test/${key}`),
		delete: calls.delete.mockImplementation(async (bucket: string, key: string) => {
			if (deleteFailure) throw deleteFailure;
			objects.delete(`${bucket}/${key}`);
		}),
		head: calls.head.mockImplementation(async (bucket: string, key: string) => {
			if (headFailure) throw headFailure;
			const object = objects.get(`${bucket}/${key}`);
			return object
				? { size: object.length, contentType: 'application/zip' }
				: null;
		}),
		readRange: vi.fn(async (bucket, key, start, end) => (
			objects.get(`${bucket}/${key}`)?.subarray(start, end + 1) ?? Buffer.alloc(0)
		)),
		stream: calls.stream.mockImplementation(async (bucket: string, key: string) => {
			const object = objects.get(`${bucket}/${key}`);
			return object
				? {
						body: Readable.from([object]),
						size: object.length,
						contentType: 'application/zip',
					}
				: null;
		}),
		listKeys: vi.fn(async (bucket, prefix) => [...objects.keys()]
			.filter((entry) => entry.startsWith(`${bucket}/${prefix}`))
			.map((entry) => entry.slice(bucket.length + 1))),
		createMultipart: calls.createMultipart.mockImplementation(async (bucket: string, key: string) => {
			const id = `${label}-multipart-${++sequence}`;
			multiparts.set(id, { bucket, key, parts: new Map() });
			return id;
		}),
		uploadPart: calls.uploadPart.mockImplementation(async (
			_bucket: string,
			_key: string,
			uploadId: string,
			partNumber: number,
			body: Buffer | NodeJS.ReadableStream,
		) => {
			const multipart = multiparts.get(uploadId);
			if (!multipart) throw new Error('multipart not found');
			const value = await consume(body);
			if (uploadPartGate) await uploadPartGate;
			multipart.parts.set(partNumber, value);
			return `etag-${partNumber}-${value.length}`;
		}),
		completeMultipart: calls.completeMultipart.mockImplementation(async (
			bucket: string,
			key: string,
			uploadId: string,
		) => {
			const multipart = multiparts.get(uploadId);
			if (!multipart) throw new Error('multipart not found');
			const value = Buffer.concat(
				[...multipart.parts.entries()]
					.sort(([a], [b]) => a - b)
					.map(([, part]) => part),
			);
			objects.set(`${bucket}/${key}`, value);
			multiparts.delete(uploadId);
		}),
		abortMultipart: calls.abortMultipart.mockImplementation(async (
			_bucket: string,
			_key: string,
			uploadId: string,
		) => {
			multiparts.delete(uploadId);
		}),
	};
	return {
		storage,
		calls,
		objects,
		multiparts,
		failHead(error = new Error(`${label} HEAD unavailable`)) {
			headFailure = error;
		},
		restoreHead() {
			headFailure = undefined;
		},
		failDelete(error = new Error(`${label} delete unavailable`)) {
			deleteFailure = error;
		},
		blockUploadPart(gate: Promise<void>) {
			uploadPartGate = gate;
		},
	};
}

function idGenerator(label: string) {
	let sequence = 0;
	return {
		next: () => {
			sequence += 1;
			const suffix = String(sequence).padStart(12, '0');
			return `00000000-0000-4000-8000-${suffix}`;
		},
		label,
	};
}

function graphHarness(label: string, options: {
	maxGameFileMb?: number;
	maxConcurrent?: number;
} = {}) {
	const prisma = prismaHarness(label);
	const storage = storageHarness(label);
	const settings: SettingsStore = {
		get: vi.fn(async () => ({
			maxGameFileMb: options.maxGameFileMb ?? 8,
			maxChunkSizeMb: 1,
		})),
		update: vi.fn(async (patch) => ({
			maxGameFileMb: patch.maxGameFileMb ?? options.maxGameFileMb ?? 8,
			maxChunkSizeMb: patch.maxChunkSizeMb ?? 1,
		})),
		invalidate: vi.fn(),
	};
	const limiter = createUploadLimiter(() => options.maxConcurrent ?? 2);
	const config = {
		...defaultTestEnv,
		API_PUBLIC_URL: `https://${label}.api.test`,
		S3_BUCKET_PUBLIC: `${label}-public`,
		S3_BUCKET_PROTECTED: `${label}-protected`,
		UPLOAD_CHUNK_SIZE_MB: 1,
		UPLOAD_SESSION_TTL_MINUTES: 60,
		UPLOAD_USER_GAME_MAX_MB: 8,
		UPLOAD_PRIVILEGED_GAME_MAX_MB: 8,
	};
	const clock = { now: () => new Date('2026-07-31T00:10:00.000Z') };
	const ids = idGenerator(label);
	const access = createProjectAccessService(createProjectAccessRepository(prisma.client));
	const graph = createGameUploadProductionGraph({
		config,
		prisma: prisma.client,
		storage: storage.storage,
		fileSystem: createNodeFileSystem(),
		settings,
		uploadLimiter: limiter,
		lifecycle: {
			state: () => 'ready',
			setState: vi.fn(),
			isAcceptingNewWork: () => true,
			requestStarted: vi.fn(),
			requestFinished: vi.fn(),
			inFlight: () => 0,
			waitForDrain: async () => 'drained',
		},
		clock,
		ids,
		logger,
		access,
	});
	return { graph, prisma, storage, settings, limiter, config, clock, ids, access };
}

function actorPlugin(controller: FastifyPluginAsync): FastifyPluginAsync {
	return async function actorRoutes(app): Promise<void> {
		app.addHook('preHandler', async (request) => {
			request.currentUser = {
				id: 11,
				googleSub: 'ticket-012',
				email: 'ticket-012@example.test',
				name: 'Ticket 012',
				role: 'ADMIN',
			};
		});
		await app.register(controller);
	};
}

async function routeApp(graph: GameUploadProductionGraph): Promise<FastifyInstance> {
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
	})), { prefix: '/api/admin' });
	await app.ready();
	apps.push(app);
	return app;
}

async function createSession(
	app: FastifyInstance,
	body: {
		originalName?: string;
		totalBytes?: number;
		uploadKind?: 'GAME' | 'WEBGL';
	} = { originalName: 'game.zip', totalBytes: 1 },
) {
	return app.inject({
		method: 'POST',
		url: '/api/admin/projects/7/game-upload-sessions',
		payload: body,
	});
}

async function uploadChunk(
	app: FastifyInstance,
	sessionId: string,
	value = Buffer.from([0x50]),
) {
	return app.inject({
		method: 'PUT',
		url: `/api/admin/game-upload-sessions/${sessionId}/chunks/0`,
		headers: { 'content-type': 'application/octet-stream' },
		payload: value,
	});
}

function schedulerHarness() {
	const tasks: Array<{
		intervalMs: number;
		task: () => void | Promise<void>;
		cancel: ReturnType<typeof vi.fn>;
	}> = [];
	const scheduler: Scheduler = {
		every: vi.fn((intervalMs, task) => {
			const scheduled = { intervalMs, task, cancel: vi.fn() };
			tasks.push(scheduled);
			return scheduled;
		}),
		delay: vi.fn(async () => {}),
	};
	return { scheduler, tasks };
}

async function contextHarness(label: string) {
	const base = graphHarness(label);
	const scheduler = schedulerHarness();
	const context = await createProductionBackendContext(
		base.config as unknown as Env,
		{
			factories: {
				scheduler: () => scheduler.scheduler,
			},
			resources: {
				logger: { value: logger, ownership: 'borrowed' },
				clock: { value: base.clock, ownership: 'borrowed' },
				ids: { value: base.ids, ownership: 'borrowed' },
				fileSystem: {
					value: createNodeFileSystem(),
					ownership: 'borrowed',
				},
				googleTokens: {
					value: { verify: vi.fn(async () => undefined) },
					ownership: 'borrowed',
				},
				prisma: { value: base.prisma.client, ownership: 'borrowed' },
				s3: {
					value: { destroy: vi.fn() } as unknown as S3Client,
					ownership: 'borrowed',
				},
				storage: { value: base.storage.storage, ownership: 'borrowed' },
				settings: { value: base.settings, ownership: 'borrowed' },
				uploadLimiter: { value: base.limiter, ownership: 'borrowed' },
			},
		},
	);
	return {
		...base,
		context,
		scheduler,
	};
}

const authenticatedHeaders = {
	origin: defaultTestEnv.WEB_PUBLIC_URL,
	cookie: `${defaultTestEnv.SESSION_COOKIE_NAME}=ticket-012-session`,
};

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
	vi.restoreAllMocks();
});

describe('game-upload/WebGL production wiring', () => {
	it('constructs and registers without I/O or transitive runtime/global resources', async () => {
		const source = await readFile(
			new URL('../modules/admin/game-upload/controller.ts', import.meta.url),
			'utf8',
		);
		expect(source).not.toMatch(/config\/env|lib\/(prisma|s3|storage|logger)|runtime\.js/);

		const harness = graphHarness('registration');
		const interval = vi.spyOn(globalThis, 'setInterval');
		const app = await routeApp(harness.graph);
		expect(harness.prisma.calls.sessionFind).not.toHaveBeenCalled();
		expect(harness.prisma.calls.sessionCreate).not.toHaveBeenCalled();
		expect(harness.storage.calls.createMultipart).not.toHaveBeenCalled();
		expect(harness.storage.calls.head).not.toHaveBeenCalled();
		expect(interval).not.toHaveBeenCalled();

		const report = await cruise(
			['src/modules/admin/game-upload/composition.ts'],
			{
				doNotFollow: { path: '(^|/)node_modules/' },
				exclude: { path: '(^|/)(dist|generated|__tests__)/' },
			},
		);
		expect(typeof report.output).not.toBe('string');
		const result = report.output as ICruiseResult;
		const modules = result.modules.map(({ source: module }) => module);
		expect(modules).toEqual(expect.arrayContaining([
			'src/modules/admin/game-upload/composition.ts',
			'src/modules/admin/game-upload/controller.ts',
			'src/modules/admin/game-upload/repository.ts',
			'src/modules/webgl/deployment.ts',
			'src/modules/orphan/service.ts',
		]));
		expect(modules.filter((module) => (
			module === 'src/config/env.ts'
			|| /^src\/lib\/(prisma|s3|storage|logger|lifecycle)\.ts$/.test(module)
			|| module === 'src/object-deletion.ts'
			|| /(^|\/).*runtime\.ts$/.test(module)
		))).toEqual([]);

		await app.close();
		await harness.graph.close();
	});

	it('reaches the real game-upload controller through BackendContext default production routes', async () => {
		const harness = await contextHarness('actual-context');
		const app = await buildApp({ context: harness.context });
		apps.push(app);
		expect(harness.context.resourceOwnership).toContainEqual({
			name: 'gameUploadWorkflow',
			ownership: 'owned',
		});

		harness.settings.get = vi.fn(async () => ({
			maxGameFileMb: 1,
			maxChunkSizeMb: 1,
		}));
		const response = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/7/game-upload-sessions',
			headers: authenticatedHeaders,
			payload: {
				originalName: 'too-large.zip',
				totalBytes: 2 * 1024 * 1024,
			},
		});
		expect(response.statusCode, response.body).toBe(400);
		expect(response.json()).toMatchObject({
			ok: false,
			error: { message: expect.stringContaining('exceeds max 1MB') },
		});
		expect(harness.storage.calls.createMultipart).not.toHaveBeenCalled();
	});

	it('replays duplicate chunk, missing chunk, HEAD outage, cancel, and ZIP validation branches', async () => {
		const harness = graphHarness('failures');
		const app = await routeApp(harness.graph);

		const created = await createSession(app);
		expect(created.statusCode, created.body).toBe(201);
		const sessionId = created.json().data.sessionId as string;
		const firstChunk = await uploadChunk(app, sessionId);
		const duplicateChunk = await uploadChunk(app, sessionId);
		expect(firstChunk.statusCode, firstChunk.body).toBe(200);
		expect(duplicateChunk.statusCode, duplicateChunk.body).toBe(200);
		expect(duplicateChunk.json().data.uploadedCount).toBe(1);

		const missingCreated = await createSession(app, {
			originalName: 'missing.zip',
			totalBytes: 1024 * 1024 + 1,
		});
		const missingId = missingCreated.json().data.sessionId as string;
		await uploadChunk(app, missingId, Buffer.alloc(1024 * 1024));
		const missing = await app.inject({
			method: 'POST',
			url: `/api/admin/game-upload-sessions/${missingId}/complete`,
		});
		expect(missing.statusCode, missing.body).toBe(400);
		expect(missing.json().error.message).toContain('Missing 1 chunks');

		const headCreated = await createSession(app);
		const headId = headCreated.json().data.sessionId as string;
		await uploadChunk(app, headId);
		harness.storage.failHead();
		const head = await app.inject({
			method: 'POST',
			url: `/api/admin/game-upload-sessions/${headId}/complete`,
		});
		expect(head.statusCode).toBe(500);
		expect(harness.prisma.sessions.get(headId)?.status).toBe('COMPLETING');
		harness.storage.restoreHead();
		harness.prisma.active.delete('7:GAME');

		const cancelled = await createSession(app);
		const cancelledId = cancelled.json().data.sessionId as string;
		const cancel = await app.inject({
			method: 'DELETE',
			url: `/api/admin/game-upload-sessions/${cancelledId}`,
		});
		expect(cancel.statusCode, cancel.body).toBe(204);
		expect(harness.storage.calls.abortMultipart).toHaveBeenCalled();
		expect(harness.prisma.sessions.get(cancelledId)?.status).toBe('CANCELLED');

		const invalidCreated = await createSession(app);
		const invalidId = invalidCreated.json().data.sessionId as string;
		await uploadChunk(app, invalidId, Buffer.from([0x00]));
		const invalid = await app.inject({
			method: 'POST',
			url: `/api/admin/game-upload-sessions/${invalidId}/complete`,
		});
		expect(invalid.statusCode, invalid.body).toBe(400);
		expect(harness.prisma.sessions.get(invalidId)?.status).toBe('FAILED');
		expect(harness.storage.calls.delete).toHaveBeenCalledWith(
			harness.config.S3_BUCKET_PROTECTED,
			harness.prisma.sessions.get(invalidId)?.s3Key,
		);
	});

	it('keeps a completing active slot and lets only one concurrent complete reach storage', async () => {
		const harness = graphHarness('concurrency');
		const app = await routeApp(harness.graph);
		const completing = harness.prisma.seedSession({
			id: 'already-completing',
			status: 'COMPLETING',
			uploadKind: 'WEBGL',
			s3Key: 'webgl/7/00000000-0000-4000-8000-000000000099/source.zip',
		});
		const conflict = await createSession(app, {
			originalName: 'replacement.zip',
			totalBytes: 1,
			uploadKind: 'WEBGL',
		});
		expect(conflict.statusCode, conflict.body).toBe(409);
		expect(harness.prisma.sessions.get(completing.id)?.status).toBe('COMPLETING');
		expect(harness.storage.calls.abortMultipart).toHaveBeenCalledOnce();

		harness.prisma.active.delete('7:WEBGL');
		const created = await createSession(app);
		const sessionId = created.json().data.sessionId as string;
		await uploadChunk(app, sessionId, Buffer.from([0x00]));
		const url = `/api/admin/game-upload-sessions/${sessionId}/complete`;
		const [a, b] = await Promise.all([
			app.inject({ method: 'POST', url }),
			app.inject({ method: 'POST', url }),
		]);
		expect([a.statusCode, b.statusCode].sort()).toEqual([400, 400]);
		expect(harness.storage.calls.completeMultipart).toHaveBeenCalledOnce();
		expect(
			[a.json().error.message, b.json().error.message]
				.filter((message) => message.includes('already being completed')),
		).toHaveLength(1);
	});

	it('isolates A/B recovery, limiter, scheduler, and close while draining active upload work', async () => {
		const a = await contextHarness('a');
		const b = await contextHarness('b');
		const appA = await buildApp({ context: a.context });
		const appB = await buildApp({ context: b.context });
		apps.push(appA, appB);
		expect(a.prisma.calls.sessionFind).not.toHaveBeenCalled();
		expect(a.prisma.calls.orphanFindMany).not.toHaveBeenCalled();
		expect(a.scheduler.tasks).toHaveLength(0);
		expect(b.scheduler.tasks).toHaveLength(0);

		a.prisma.seedSession({
			id: 'a-recovery',
			status: 'COMPLETING',
			updatedAt: new Date('2026-07-30T00:00:00.000Z'),
			s3Key: 'a-missing.zip',
		});
		await Promise.all([a.context.start(), b.context.start()]);
		expect(a.prisma.sessions.get('a-recovery')?.status).toBe('FAILED');
		expect(a.prisma.calls.sessionFind).not.toHaveBeenCalled();
		expect(a.scheduler.tasks).toHaveLength(4);
		expect(b.scheduler.tasks).toHaveLength(4);

		const aKey = 'a-stream.zip';
		const bKey = 'b-stream.zip';
		const aUploadId = await a.storage.storage.createMultipart(
			a.config.S3_BUCKET_PROTECTED,
			aKey,
		);
		const bUploadId = await b.storage.storage.createMultipart(
			b.config.S3_BUCKET_PROTECTED,
			bKey,
		);
		const aSession = a.prisma.seedSession({
			id: 'a-stream',
			totalBytes: 1n,
			s3Key: aKey,
			s3UploadId: aUploadId,
		});
		const bSession = b.prisma.seedSession({
			id: 'b-stream',
			totalBytes: 1n,
			s3Key: bKey,
			s3UploadId: bUploadId,
		});
		const gate = deferred();
		a.storage.blockUploadPart(gate.promise);
		const aUpload = appA.inject({
			method: 'PUT',
			url: `/api/admin/game-upload-sessions/${aSession.id}/chunks/0`,
			headers: {
				...authenticatedHeaders,
				'content-type': 'application/octet-stream',
			},
			payload: Buffer.from([1]),
		});
		await vi.waitFor(() => expect(a.storage.calls.uploadPart).toHaveBeenCalledOnce());
		let aClosed = false;
		const closingA = a.context.close().then(() => { aClosed = true; });
		await Promise.resolve();
		expect(aClosed).toBe(false);

		const bUpload = await appB.inject({
			method: 'PUT',
			url: `/api/admin/game-upload-sessions/${bSession.id}/chunks/0`,
			headers: {
				...authenticatedHeaders,
				'content-type': 'application/octet-stream',
			},
			payload: Buffer.from([2]),
		});
		expect(bUpload.statusCode, bUpload.body).toBe(200);
		expect(bUpload.json().data).toMatchObject({ uploadedCount: 1 });
		expect(b.scheduler.tasks.every(({ cancel }) => !cancel.mock.calls.length)).toBe(true);
		gate.resolve();
		const [aResponse] = await Promise.all([aUpload, closingA]);
		expect(aResponse.statusCode, aResponse.body).toBe(200);
		expect(a.scheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
		expect(b.scheduler.tasks.every(({ cancel }) => cancel.mock.calls.length === 0)).toBe(true);
		await a.context.close();
		await b.context.close();
	});

	it('does not mark terminal status when object delete and orphan persistence both fail', async () => {
		const harness = graphHarness('double-failure');
		const app = await routeApp(harness.graph);
		const created = await createSession(app);
		const sessionId = created.json().data.sessionId as string;
		await uploadChunk(app, sessionId, Buffer.from([0x00]));
		harness.storage.failDelete();
		harness.prisma.calls.orphanUpsert.mockRejectedValueOnce(
			new Error('orphan database unavailable'),
		);

		const response = await app.inject({
			method: 'POST',
			url: `/api/admin/game-upload-sessions/${sessionId}/complete`,
		});
		expect(response.statusCode).toBe(500);
		expect(harness.prisma.sessions.get(sessionId)?.status).toBe('COMPLETING');
		expect(harness.prisma.orphans.size).toBe(0);
	});
});
