import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import type { S3Client } from '@aws-sdk/client-s3';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import {
	createProductionBackendContext,
	type BackendRoutes,
} from '../backend-context.js';
import type { Env } from '../config/env.js';
import type {
	AppLogger,
	FileSystem,
	ObjectStorage,
	Scheduler,
	SettingsStore,
} from '../application/ports.js';
import {
	createObjectDeletionCoordinator,
	DurableObjectDeletionError,
} from '../application/object-deletion.js';
import { createNodeFileSystem } from '../infrastructure/production-ports.js';
import { createNodeProjectUploadProcessing } from '../infrastructure/project-upload-processing.js';
import { AppError } from '../shared/errors.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import type {
	ProjectApplicationRepository,
	ProjectAssetWriteData,
	SubmitProjectWriteData,
} from '../modules/admin/project/ports.js';
import { createProjectMultipartProductionGraph } from '../modules/admin/project-multipart.composition.js';
import {
	ProjectTempCleanupError,
	type ProjectUploadProcessing,
} from '../modules/admin/project/project-upload.adapter.js';
import { createAdminRoutes } from '../modules/admin/admin.routes.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createMultipartRequestHasher } from '../infrastructure/multipart-request-hasher.js';
import { createTestUploadLifecycleRuntime } from './helpers/upload-lifecycle.js';
import { createScriptedBackendPersistence } from './helpers/backend-persistence.js';

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
const fileSystemTeardowns: Array<() => Promise<void>> = [];

interface ProjectPortRow {
	id: number;
	exhibitionId: number;
	creatorId: number;
	status: SubmitProjectWriteData['status'];
	slug: string;
	title: string;
}

function projectRow(): ProjectPortRow {
	return {
		id: 7,
		exhibitionId: 1,
		creatorId: 1,
		status: 'PUBLISHED',
		slug: 'existing',
		title: 'Existing',
	};
}

function portHarness(label: string) {
	const project = projectRow();
	const projects = new Map<number, ProjectPortRow>([[project.id, project]]);
	const slugs = new Map<string, ProjectPortRow>([
		[`${project.exhibitionId}\0${project.slug}`, project],
	]);
	const orphans = new Map<string, { bucket: string; storageKey: string; reason: string }>();
	let nextIntentId = 0;
	let nextProjectId = 20;
	let nextAssetId = 100;
	let failProjectCreate: Error | undefined;
	let failAssetCreate: Error | undefined;
	let failOrphanWrite: Error | undefined;
	let memberUserId: number | undefined;
	let successfulProjectCreates = 0;

	const calls = {
		projectFindUnique: vi.fn(async (id: number) => projects.get(id) ?? null),
		projectFindBySlug: vi.fn(async (exhibitionId: number, slug: string) => (
			slugs.get(`${exhibitionId}\0${slug}`) ?? null
		)),
		projectCreate: vi.fn(async (data: SubmitProjectWriteData) => {
			if (failProjectCreate) throw failProjectCreate;
			successfulProjectCreates += 1;
			const row = {
				id: nextProjectId++,
				exhibitionId: data.exhibitionId,
				creatorId: data.creatorId,
				status: data.status,
				slug: data.slug,
				title: data.title,
			};
			projects.set(row.id, row);
			slugs.set(`${row.exhibitionId}\0${row.slug}`, row);
			return row;
		}),
		assetCreate: vi.fn(async (data: ProjectAssetWriteData) => {
			if (failAssetCreate) throw failAssetCreate;
			return { id: nextAssetId++, ...data };
		}),
		orphanUpsert: vi.fn(async (create: {
			bucket: string;
			storageKey: string;
			reason: string;
		}) => {
			if (failOrphanWrite) throw failOrphanWrite;
			orphans.set(`${create.bucket}\0${create.storageKey}`, create);
			return create;
		}),
	};
	const repository: ProjectApplicationRepository = {
		findProjectsForUser: vi.fn(async () => ({ items: [], totalItems: 0 })),
		findProjectById: vi.fn(async () => null),
		isMemberOfProject: vi.fn(async () => null),
		updateProject: vi.fn(async () => { throw new Error('not scripted'); }),
		deleteProjectReturningAssets: vi.fn(async () => { throw new Error('not scripted'); }),
		clearWebglDeployment: vi.fn(async () => { throw new Error('not scripted'); }),
		findAssetById: vi.fn(async () => null),
		setProjectPoster: vi.fn(async () => undefined),
		bulkDeleteProjectsReturningAssets: vi.fn(async () => { throw new Error('not scripted'); }),
		bulkUpdateStatus: vi.fn(async () => ({ count: 0 })),
		findExhibitionById: vi.fn(async (id: number) => id === 1
			? {
					id: 1,
					year: 2026,
					title: `${label} Exhibition`,
					isUploadEnabled: true,
				}
			: null),
		findProjectByExhibitionAndSlug: calls.projectFindBySlug,
		async createProjectWithAssets(data) {
			const created = await calls.projectCreate(data);
			for (const file of data.savedFiles) {
				await calls.assetCreate({
					...file,
					projectId: created.id,
					isPublic: file.kind !== 'GAME' && file.kind !== 'VIDEO',
					sizeBytes: BigInt(file.sizeBytes),
					playbackSizeBytes: BigInt(file.playbackSizeBytes ?? 0),
				});
			}
			return created;
		},
		createAsset: calls.assetCreate,
		async replaceOrCreateReplaceableAsset(projectId, kind, data) {
			const asset = await calls.assetCreate({ projectId, kind, ...data });
			return { assetId: asset.id, oldStorageKey: null, oldPlaybackStorageKey: null };
		},
	};
	const accessRepository = {
		findProject: calls.projectFindUnique,
		isLinkedMember: async (_projectId: number, userId: number) => (
			memberUserId !== undefined && memberUserId === userId
		),
	};
	return {
		repository,
		access: createProjectAccessService(accessRepository),
		accessRepository,
		calls,
		orphans,
		failProject(error = new Error('project DB write failed')) {
			failProjectCreate = error;
		},
		failAsset(error = new Error('asset DB write failed')) {
			failAssetCreate = error;
		},
		failOrphan(error = new Error('orphan queue write failed')) {
			failOrphanWrite = error;
		},
		allowMember(userId: number) {
			memberUserId = userId;
		},
		projectCreateSuccesses() {
			return successfulProjectCreates;
		},
		prepareIntent(input: { bucket: string; storageKey: string }) {
			return `${label}-intent-${++nextIntentId}-${input.bucket}-${input.storageKey}`;
		},
	};
}

function storageHarness(label: string) {
	const objects = new Map<string, Buffer>();
	let uploadFailure: {
		timing: 'before' | 'after';
		error: Error;
		streamCleanupError?: Error;
	} | undefined;
	let deleteFailure: Error | undefined;
	const calls = {
		upload: vi.fn(async (_bucket: string, key: string, body: Readable) => {
			if (uploadFailure?.timing === 'before') {
				if (uploadFailure.streamCleanupError) {
					const cleanupError = uploadFailure.streamCleanupError;
					const streamWithDestroy = body as Readable & {
						_destroy(
							error: Error | null,
							callback: (error?: Error | null) => void,
						): void;
					};
					const originalDestroy = streamWithDestroy._destroy.bind(streamWithDestroy);
					streamWithDestroy._destroy = (error, callback) => {
						originalDestroy(error, () => callback(cleanupError));
					};
				}
				throw uploadFailure.error;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of body) chunks.push(Buffer.from(chunk));
			objects.set(key, Buffer.concat(chunks));
			if (uploadFailure?.timing === 'after') throw uploadFailure.error;
		}),
		delete: vi.fn(async (_bucket: string, key: string) => {
			if (deleteFailure) throw deleteFailure;
			objects.delete(key);
		}),
	};
	const storage: ObjectStorage = {
		upload: calls.upload as ObjectStorage['upload'],
		presign: vi.fn(async () => `https://${label}.storage.test/object`),
		delete: calls.delete,
		head: vi.fn(async () => null),
		readRange: vi.fn(async () => Buffer.alloc(0)),
		stream: vi.fn(async () => null),
		listKeys: vi.fn(async () => []),
		createMultipart: vi.fn(async () => 'upload-id'),
		uploadPart: vi.fn(async () => 'etag'),
		completeMultipart: vi.fn(async () => {}),
		abortMultipart: vi.fn(async () => {}),
		listParts: vi.fn(async () => []),
		listMultipartUploads: vi.fn(async () => []),
	};
	return {
		storage,
		calls,
		objects,
		failUpload(
			timing: 'before' | 'after',
			error = new Error(`${label} upload failed ${timing}`),
			streamCleanupError?: Error,
		) {
			uploadFailure = {
				timing,
				error,
				...(streamCleanupError ? { streamCleanupError } : {}),
			};
		},
		failDelete(error = new Error(`${label} delete failed`)) {
			deleteFailure = error;
		},
	};
}

function fileSystemHarness(label: string) {
	const base = createNodeFileSystem();
	const created = new Set<string>();
	const removed = new Set<string>();
	const streamPaths = new WeakMap<Readable, string>();
	const lifecycle: Array<{
		type: 'stream-close' | 'remove';
		path: string;
		stream?: Readable;
	}> = [];
	let removeFailuresRemaining = 0;
	let permanentRemoveFailure = false;
	let missingRemovalsRemaining = 0;
	const calls = {
		createWriteStream: vi.fn((filePath: string) => {
			expect(filePath).toContain(label);
			created.add(filePath);
			return base.createWriteStream(filePath);
		}),
		createReadStream: vi.fn((filePath: string) => {
			const stream = base.createReadStream(filePath);
			streamPaths.set(stream, filePath);
			stream.once('close', () => lifecycle.push({ type: 'stream-close', path: filePath, stream }));
			return stream;
		}),
		remove: vi.fn(async (filePath: string) => {
			lifecycle.push({ type: 'remove', path: filePath });
			// Processors such as sharp create derived temp paths without going
			// through createWriteStream; observing remove makes those residues
			// visible to assertions and teardown as well.
			created.add(filePath);
			if (missingRemovalsRemaining > 0) {
				missingRemovalsRemaining -= 1;
				await base.remove(filePath);
				removed.add(filePath);
				const error = new Error(
					`${label} temp file was already removed`,
				) as NodeJS.ErrnoException;
				error.code = 'ENOENT';
				throw error;
			}
			if (permanentRemoveFailure || removeFailuresRemaining > 0) {
				removeFailuresRemaining = Math.max(0, removeFailuresRemaining - 1);
				const error = new Error(`${label} temp remove failed`) as NodeJS.ErrnoException;
				error.code = 'EIO';
				throw error;
			}
			await base.remove(filePath);
			removed.add(filePath);
		}),
	};
	const fileSystem: FileSystem = {
		...base,
		createWriteStream: calls.createWriteStream,
		createReadStream: calls.createReadStream,
		remove: calls.remove,
	};
	async function recoverAndRemoveOutstanding(
		additionalPaths: readonly string[] = [],
	): Promise<void> {
		permanentRemoveFailure = false;
		removeFailuresRemaining = 0;
		missingRemovalsRemaining = 0;
		const cleanupPaths = new Set([
			...[...created].filter((path) => !removed.has(path)),
			...additionalPaths,
		]);
		for (const filePath of cleanupPaths) {
			await calls.remove(filePath).catch(() => undefined);
		}
	}
	fileSystemTeardowns.push(() => recoverAndRemoveOutstanding());

	return {
		fileSystem,
		calls,
		created,
		lifecycle: () => [...lifecycle],
		streamPath: (stream: Readable) => streamPaths.get(stream),
		outstanding: () => [...created].filter((filePath) => !removed.has(filePath)),
		failRemoveTimes(count: number) {
			removeFailuresRemaining = count;
		},
		failRemovePermanently() {
			permanentRemoveFailure = true;
		},
		removeAsMissing(count = 1) {
			missingRemovalsRemaining = count;
		},
		recoverAndRemoveOutstanding,
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
		release: vi.fn(() => {
			active -= 1;
		}),
	};
	return {
		limiter: calls,
		calls,
		active: () => active,
		reject(error: Error) {
			acquireFailure = error;
		},
	};
}

function graphHarness(label: string, options: { imageMaxMb?: number } = {}) {
	const ports = portHarness(label);
	const storage = storageHarness(label);
	const fileSystem = fileSystemHarness(label);
	const limiter = limiterHarness();
	const settings: SettingsStore = {
		get: vi.fn(async () => ({ maxGameFileMb: 2, maxChunkSizeMb: 1 })),
		update: vi.fn(async () => ({ maxGameFileMb: 2, maxChunkSizeMb: 1 })),
		invalidate: vi.fn(),
	};
	let id = 0;
	const config = {
		...defaultTestEnv,
		API_PUBLIC_URL: `https://${label}.api.test`,
		WEB_PUBLIC_URL: `https://${label}.web.test`,
		S3_BUCKET_PUBLIC: `${label}-public`,
		S3_BUCKET_PROTECTED: `${label}-protected`,
		UPLOAD_USER_IMAGE_MAX_MB: options.imageMaxMb ?? 1,
		UPLOAD_USER_GAME_MAX_MB: 2,
		UPLOAD_USER_REQUEST_MAX_MB: 2,
		UPLOAD_USER_MAX_FILES: 4,
		UPLOAD_PRIVILEGED_IMAGE_MAX_MB: options.imageMaxMb ?? 1,
		UPLOAD_PRIVILEGED_GAME_MAX_MB: 2,
		UPLOAD_PRIVILEGED_REQUEST_MAX_MB: 2,
		UPLOAD_PRIVILEGED_MAX_FILES: 4,
		RATE_LIMIT_SUBMIT_MAX: 20,
		RATE_LIMIT_SUBMIT_WINDOW_MS: 60_000,
	};
	const access = ports.access;
	const repository = ports.repository;
	const baseUploadLifecycle = createTestUploadLifecycleRuntime();
	const uploadLifecycle = createTestUploadLifecycleRuntime({
		uploadIntents: {
			...baseUploadLifecycle.uploadIntents,
			prepare: vi.fn(async (input) => ports.prepareIntent(input)),
		},
		orphanDeletions: createObjectDeletionCoordinator({
			storage: storage.storage,
			orphans: {
				async record(bucket, storageKey, reason) {
					await ports.calls.orphanUpsert({ bucket, storageKey, reason });
				},
			},
			logger,
		}),
	});
	const graph = createProjectMultipartProductionGraph({
		config,
		storage: storage.storage,
		fileSystem: fileSystem.fileSystem,
		settings,
		uploadLimiter: limiter.limiter,
		logger,
		clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
		ids: { next: () => `${label}-${String(++id).padStart(4, '0')}` },
		processing: createNodeProjectUploadProcessing(fileSystem.fileSystem, logger),
		requestHasher: createMultipartRequestHasher(fileSystem.fileSystem),
		uploadLifecycle,
		access,
		repository,
	});
	return {
		graph,
		config,
		access,
		repository,
		ports,
		storage,
		fileSystem,
		limiter,
		uploadLifecycle,
		settings,
	};
}

function multipart(parts: Array<
	| { type: 'field'; name: string; value: string }
	| { type: 'file'; name: string; filename: string; contentType: string; value: Buffer }
>) {
	const boundary = `ticket-011-${Math.random().toString(16).slice(2)}`;
	const buffers: Buffer[] = [];
	for (const part of parts) {
		if (part.type === 'field') {
			buffers.push(Buffer.from(
				`--${boundary}\r\n`
				+ `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`
				+ `${part.value}\r\n`,
			));
		} else {
			buffers.push(Buffer.from(
				`--${boundary}\r\n`
				+ `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
				+ `Content-Type: ${part.contentType}\r\n\r\n`,
			));
			buffers.push(part.value, Buffer.from('\r\n'));
		}
	}
	buffers.push(Buffer.from(`--${boundary}--\r\n`));
	return {
		headers: {
			'content-type': `multipart/form-data; boundary=${boundary}`,
			'idempotency-key': `test-${Math.random().toString(16).slice(2)}`,
		},
		payload: Buffer.concat(buffers),
	};
}

function submitPayload() {
	return JSON.stringify({
		exhibitionId: 1,
		title: 'Ticket Eleven',
		summary: 'Context owned multipart',
		description: 'Production route',
		members: [{ name: 'Owner', studentId: '20260001' }],
	});
}

function assetMultipart(file = tinyPng, filename = 'image.png') {
	return multipart([
		{ type: 'field', name: 'kind', value: 'IMAGE' },
		{
			type: 'file',
			name: 'file',
			filename,
			contentType: 'image/png',
			value: file,
		},
	]);
}

function submitMultipart(payload = submitPayload(), file?: Buffer) {
	return multipart([
		{ type: 'field', name: 'payload', value: payload },
		...(file
			? [{
					type: 'file' as const,
					name: 'images[]',
					filename: 'image.png',
					contentType: 'image/png',
					value: file,
				}]
			: []),
	]);
}

function abortedAssetMultipart() {
	const boundary = 'ticket-011-aborted';
	const payload = Readable.from((async function* body() {
		yield Buffer.from(
			`--${boundary}\r\n`
				+ 'Content-Disposition: form-data; name="kind"\r\n\r\n'
				+ 'IMAGE\r\n'
				+ `--${boundary}\r\n`
				+ 'Content-Disposition: form-data; name="file"; filename="image.png"\r\n'
				+ 'Content-Type: image/png\r\n\r\n',
		);
		yield tinyPng.subarray(0, 24);
		throw new Error('ticket 011 client aborted');
	})());
	return {
		headers: {
			'content-type': `multipart/form-data; boundary=${boundary}`,
			'idempotency-key': 'test-aborted-asset',
		},
		payload,
	};
}

async function routeApp(
	harness: ReturnType<typeof graphHarness>,
	observedErrors: unknown[] = [],
): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	await app.register(fastifyMultipart, {
		limits: { fileSize: 3 * 1024 * 1024, files: 4 },
		attachFieldsToBody: false,
	});
	app.addHook('preHandler', async (request) => {
		const role = (request.headers['x-test-role'] ?? 'ADMIN') as
			| 'ADMIN'
			| 'OPERATOR'
			| 'USER';
		request.currentUser = {
			id: Number(request.headers['x-test-user-id'] ?? (role === 'USER' ? 1 : 9)),
			googleSub: `ticket-011-${role}`,
			email: `${role.toLowerCase()}@example.test`,
			name: `Ticket 011 ${role}`,
			role,
		};
	});
	app.setErrorHandler((error, _request, reply) => {
		observedErrors.push(error);
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
		exhibitionController: emptyRoute,
		importController: emptyRoute,
		exportController: emptyRoute,
		projectMultipartController: harness.graph.projectMultipartController,
		gameUploadController: emptyRoute,
	}), { prefix: '/api/admin' });
	await app.register(harness.graph.meController, { prefix: '/api/me' });
	await app.ready();
	return app;
}

function actorPlugin(
	controller: FastifyPluginAsync,
): FastifyPluginAsync {
	return async function actorRoutes(app): Promise<void> {
		app.addHook('preHandler', async (request) => {
			const role = (request.headers['x-test-role'] ?? 'ADMIN') as
				| 'ADMIN'
				| 'OPERATOR'
				| 'USER';
			request.currentUser = {
				id: Number(request.headers['x-test-user-id'] ?? (role === 'USER' ? 1 : 9)),
				googleSub: `ticket-011-context-${role}`,
				email: `${role.toLowerCase()}@context.test`,
				name: `Ticket 011 Context ${role}`,
				role,
			};
		});
		await app.register(controller);
	};
}

async function contextAppHarness(
	label: string,
	transformProcessing?: (
		processing: ProjectUploadProcessing,
	) => ProjectUploadProcessing,
) {
	const harness = graphHarness(label);
	const scheduler: Scheduler = {
		every: vi.fn(() => ({ cancel: vi.fn() })),
		delay: vi.fn(async () => {}),
	};
	const ownedIdsClose = vi.fn(async () => {});
	const contextLoggerCalls = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	let contextLogger: AppLogger;
	contextLogger = {
		child: () => contextLogger,
		...contextLoggerCalls,
	};
	let id = 10_000;
	let receivedIdentity:
		| { access: boolean; repository: boolean }
		| undefined;

	const context = await createProductionBackendContext(
		harness.config as unknown as Env,
		{
			persistence: createScriptedBackendPersistence({
				projectAccessRepository: harness.ports.accessRepository,
				projectRepository: harness.ports.repository,
			}),
			factories: {
				projectUploadProcessing: (fileSystem, appLogger) => {
					const processing = createNodeProjectUploadProcessing(
						fileSystem,
						appLogger,
					);
					return transformProcessing?.(processing) ?? processing;
				},
				routes: (
					_config,
					_assetsBanned,
					_auth,
					_publicGraph,
					projectMemberSettings,
					_year,
					_importExport,
					projectMultipart,
				): BackendRoutes => {
					receivedIdentity = {
						access: projectMultipart.projectAccess
							=== projectMemberSettings.projectAccess,
						repository: projectMultipart.projectRepository
							=== projectMemberSettings.projectRepository,
					};
					return {
						auth: emptyRoute,
						devAuth: emptyRoute,
						public: emptyRoute,
						assets: emptyRoute,
						admin: actorPlugin(createAdminRoutes({
							projectController: emptyRoute,
							memberController: emptyRoute,
							settingsController: emptyRoute,
							bannedIpController: emptyRoute,
							exhibitionController: emptyRoute,
							importController: emptyRoute,
							exportController: emptyRoute,
							projectMultipartController:
								projectMultipart.projectMultipartController,
							gameUploadController: emptyRoute,
						})),
						me: actorPlugin(projectMultipart.meController),
					};
				},
			},
			resources: {
				uploadLifecycle: {
					value: harness.uploadLifecycle,
					ownership: 'borrowed',
				},
				logger: { value: contextLogger, ownership: 'borrowed' },
				clock: {
					value: { now: () => new Date('2026-07-24T00:00:00.000Z') },
					ownership: 'borrowed',
				},
				ids: {
					value: { next: () => `${label}-context-${++id}` },
					ownership: 'owned',
					close: ownedIdsClose,
				},
				scheduler: { value: scheduler, ownership: 'borrowed' },
				fileSystem: {
					value: harness.fileSystem.fileSystem,
					ownership: 'borrowed',
				},
				googleTokens: {
					value: { verify: vi.fn(async () => undefined) },
					ownership: 'borrowed',
				},
				s3: {
					value: { destroy: vi.fn() } as unknown as S3Client,
					ownership: 'borrowed',
				},
				storage: { value: harness.storage.storage, ownership: 'borrowed' },
				settings: { value: harness.settings, ownership: 'borrowed' },
				uploadLimiter: {
					value: harness.limiter.limiter,
					ownership: 'borrowed',
				},
			},
		},
	);
	const app = await buildApp({ context });
	apps.push(app);
	return {
		...harness,
		app,
		context,
		contextLoggerCalls,
		ownedIdsClose,
		receivedIdentity: () => receivedIdentity,
	};
}

interface DependencyEdge {
	from: string;
	to: string;
}

const FORBIDDEN_PROJECT_MULTIPART_DEPENDENCY =
	/^(?:(?:node:)?(?:fs(?:\/promises)?|os|crypto|child_process)|src\/config\/env\.ts|src\/lib\/(?:prisma|s3|storage|logger)\.ts|src\/shared\/upload-limits\.ts|src\/object-deletion\.ts|.*runtime\.ts)$/;

function dependencyEdges(result: ICruiseResult): DependencyEdge[] {
	return result.modules.flatMap((module) => module.dependencies.map((dependency) => ({
		from: module.source,
		to: dependency.resolved,
	})));
}

function forbiddenProjectMultipartEdges(result: ICruiseResult): DependencyEdge[] {
	return dependencyEdges(result).filter(({ to }) => (
		FORBIDDEN_PROJECT_MULTIPART_DEPENDENCY.test(to)
	));
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
	await Promise.allSettled(
		fileSystemTeardowns.splice(0).map((cleanup) => cleanup()),
	);
	vi.restoreAllMocks();
});

function expectReleased(harness: ReturnType<typeof graphHarness>): void {
	expect(harness.limiter.active()).toBe(0);
	expect(harness.limiter.calls.acquire).toHaveBeenCalledOnce();
	expect(harness.limiter.calls.release).toHaveBeenCalledOnce();
	expect(harness.fileSystem.outstanding()).toEqual([]);
}

function expectUploadStreamClosedBeforeTempRemoval(
	harness: ReturnType<typeof graphHarness>,
	body: Readable,
): void {
	const filePath = harness.fileSystem.streamPath(body);
	expect(filePath).toEqual(expect.any(String));
	const lifecycle = harness.fileSystem.lifecycle();
	const closeIndex = lifecycle.findIndex((event) => (
		event.type === 'stream-close' && event.stream === body
	));
	const removeIndex = lifecycle.findIndex((event) => (
		event.type === 'remove' && event.path === filePath
	));
	expect(closeIndex).toBeGreaterThanOrEqual(0);
	expect(removeIndex).toBeGreaterThan(closeIndex);
}

function errorLeaves(error: unknown): unknown[] {
	if (error instanceof AggregateError) {
		return [
			error,
			...error.errors.flatMap((nested) => errorLeaves(nested)),
		];
	}
	return [error];
}

function contextUnhandledError(
	harness: Awaited<ReturnType<typeof contextAppHarness>>,
): unknown {
	return harness.contextLoggerCalls.error.mock.calls.find(
		([, message]) => message === 'Unhandled error',
	)?.[0];
}

describe('project multipart production wiring', () => {
	it('registers without I/O and has no transitive runtime/env/global resource dependency', async () => {
		const sources = await Promise.all([
			'modules/admin/project/multipart.controller.ts',
			'modules/me/project/controller.ts',
			'modules/admin/project/project-upload.adapter.ts',
			'modules/admin/project/project-asset-upload.adapter.ts',
		].map((file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
		for (const source of sources) {
			expect(source).not.toMatch(/config\/env|lib\/(prisma|s3|storage|logger)|runtime\.js/);
		}

		const harness = graphHarness('registration');
		const interval = vi.spyOn(globalThis, 'setInterval');
		const app = await routeApp(harness);
		apps.push(app);
		expect(harness.ports.calls.projectFindUnique).not.toHaveBeenCalled();
		expect(harness.storage.calls.upload).not.toHaveBeenCalled();
		expect(harness.fileSystem.calls.createWriteStream).not.toHaveBeenCalled();
		expect(interval).not.toHaveBeenCalled();

		const report = await cruise(['src/modules/admin/project-multipart.composition.ts'], {
			doNotFollow: { path: '(^|/)node_modules/' },
			exclude: { path: '(^|/)(dist|generated|__tests__)/' },
		});
		expect(typeof report.output).not.toBe('string');
		const result = report.output as ICruiseResult;
		const modules = result.modules.map(({ source }) => source);
		expect(modules).toEqual(expect.arrayContaining([
			'src/modules/admin/project-multipart.composition.ts',
			'src/modules/admin/project/project-upload.adapter.ts',
			'src/modules/admin/project/project-asset-upload.adapter.ts',
			'src/modules/me/project/controller.ts',
		]));
		expect(modules.filter((source) => (
			source === 'src/config/env.ts'
			|| /^src\/lib\/(prisma|s3|storage|logger)\.ts$/.test(source)
			|| source === 'src/shared/upload-limits.ts'
			|| source === 'src/object-deletion.ts'
			|| /(^|\/).*runtime\.ts$/.test(source)
		))).toEqual([]);
		expect(forbiddenProjectMultipartEdges(result)).toEqual([]);

		const mutationReport = await cruise(
			['test-fixtures/project-multipart-forbidden.ts'],
			{ doNotFollow: { path: '(^|/)node_modules/' } },
		);
		expect(typeof mutationReport.output).not.toBe('string');
		expect(forbiddenProjectMultipartEdges(
			mutationReport.output as ICruiseResult,
		)).toEqual(expect.arrayContaining([
			expect.objectContaining({
				from: 'test-fixtures/project-multipart-forbidden.ts',
				to: 'fs',
			}),
		]));
	});

	it('wires the actual BackendContext graph into real admin/me prefixes and reuses ticket-008 identities', async () => {
		const harness = await contextAppHarness('actual-context');
		expect(harness.receivedIdentity()).toEqual({
			access: true,
			repository: true,
		});
		expect(harness.context.resourceOwnership).toEqual(expect.arrayContaining([
			{ name: 'ids', ownership: 'owned' },
			{ name: 'fileSystem', ownership: 'borrowed' },
			{ name: 'storage', ownership: 'borrowed' },
			{ name: 'uploadLimiter', ownership: 'borrowed' },
		]));

		const meRequest = submitMultipart();
		const me = await harness.app.inject({
			method: 'POST',
			url: '/api/me/projects/submit',
			...meRequest,
			headers: {
				...meRequest.headers,
				origin: defaultTestEnv.WEB_PUBLIC_URL,
				'x-test-role': 'USER',
			},
		});
		expect(me.statusCode, me.body).toBe(201);

		const deniedRequest = submitMultipart();
		const denied = await harness.app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			...deniedRequest,
			headers: {
				...deniedRequest.headers,
				origin: defaultTestEnv.WEB_PUBLIC_URL,
				'x-test-role': 'USER',
			},
		});
		expect(denied.statusCode).toBe(403);

		const assetRequest = assetMultipart();
		const asset = await harness.app.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...assetRequest,
			headers: {
				...assetRequest.headers,
				origin: defaultTestEnv.WEB_PUBLIC_URL,
				'x-test-role': 'ADMIN',
			},
		});
		expect(asset.statusCode, asset.body).toBe(201);
		expect(harness.ports.calls.assetCreate).toHaveBeenCalledOnce();
		expect(harness.storage.calls.upload).toHaveBeenCalledOnce();
		expect(harness.fileSystem.outstanding()).toEqual([]);

		await harness.app.close();
		expect(harness.ownedIdsClose).toHaveBeenCalledOnce();
	});

	it('treats actual-context ENOENT temp cleanup as idempotent for success and original errors', async () => {
		const successful = await contextAppHarness('context-missing-success');
		successful.fileSystem.removeAsMissing();
		const assetRequest = assetMultipart();
		const asset = await successful.app.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...assetRequest,
			headers: {
				...assetRequest.headers,
				origin: defaultTestEnv.WEB_PUBLIC_URL,
			},
		});
		expect(asset.statusCode, asset.body).toBe(201);
		expect(successful.limiter.calls.acquire).toHaveBeenCalledOnce();
		expect(successful.limiter.calls.release).toHaveBeenCalledOnce();
		expect(successful.limiter.active()).toBe(0);
		expect(successful.fileSystem.outstanding()).toEqual([]);
		expect(contextUnhandledError(successful)).toBeUndefined();

		const invalid = await contextAppHarness('context-missing-error');
		invalid.fileSystem.removeAsMissing();
		const invalidRequest = submitMultipart('{invalid-json', tinyPng);
		const malformed = await invalid.app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			...invalidRequest,
			headers: {
				...invalidRequest.headers,
				origin: defaultTestEnv.WEB_PUBLIC_URL,
			},
		});
		expect(malformed.statusCode).toBe(400);
		expect(malformed.json().error.message).toBe('Invalid payload JSON');
		expect(invalid.limiter.calls.acquire).toHaveBeenCalledOnce();
		expect(invalid.limiter.calls.release).toHaveBeenCalledOnce();
		expect(invalid.limiter.active()).toBe(0);
		expect(invalid.fileSystem.outstanding()).toEqual([]);
		expect(contextUnhandledError(invalid)).toBeUndefined();
	});

	it('uses actual admin/me prefixes with explicit actor policy and injected access', async () => {
		const harness = graphHarness('routes');
		const app = await routeApp(harness);
		apps.push(app);

		const meRequest = submitMultipart();
		const me = await app.inject({
			method: 'POST',
			url: '/api/me/projects/submit',
			...meRequest,
			headers: { ...meRequest.headers, 'x-test-role': 'USER' },
		});
		expect(me.statusCode, me.body).toBe(201);
		expect(harness.ports.calls.projectCreate).toHaveBeenCalledWith(
			expect.objectContaining({ creatorId: 1 }),
		);

		const deniedRequest = submitMultipart();
		const denied = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			...deniedRequest,
			headers: { ...deniedRequest.headers, 'x-test-role': 'USER' },
		});
		expect(denied.statusCode).toBe(403);

		const assetRequest = assetMultipart();
		const asset = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...assetRequest,
			headers: { ...assetRequest.headers, 'x-test-role': 'ADMIN' },
		});
		expect(asset.statusCode, asset.body).toBe(201);
		expect(harness.ports.calls.projectFindUnique).toHaveBeenCalledWith(7);
		expect(harness.ports.calls.assetCreate).toHaveBeenCalled();
		expect(harness.limiter.active()).toBe(0);
		expect(harness.limiter.calls.acquire).toHaveBeenCalledTimes(2);
		expect(harness.limiter.calls.release).toHaveBeenCalledTimes(2);
		expect(harness.fileSystem.outstanding()).toEqual([]);
	});

	it('rejects a non-owner USER asset before upload capacity, storage, or DB mutation', async () => {
		const harness = graphHarness('non-owner');
		const app = await routeApp(harness);
		apps.push(app);
		const request = assetMultipart();
		const denied = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...request,
			headers: {
				...request.headers,
				'x-test-role': 'USER',
				'x-test-user-id': '2',
			},
		});
		expect(denied.statusCode).toBe(403);
		expect(harness.limiter.calls.acquire).not.toHaveBeenCalled();
		expect(harness.fileSystem.calls.createWriteStream).not.toHaveBeenCalled();
		expect(harness.storage.calls.upload).not.toHaveBeenCalled();
		expect(harness.ports.calls.assetCreate).not.toHaveBeenCalled();
	});

	it('rejects malformed JSON and unsupported signatures without object or temp leaks', async () => {
		const malformedHarness = graphHarness('malformed');
		const malformedApp = await routeApp(malformedHarness);
		apps.push(malformedApp);
		const malformed = await malformedApp.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			...submitMultipart('{not-json'),
		});
		expect(malformed.statusCode).toBe(400);
		expect(malformedHarness.storage.calls.upload).not.toHaveBeenCalled();
		expectReleased(malformedHarness);

		const signatureHarness = graphHarness('signature');
		const signatureApp = await routeApp(signatureHarness);
		apps.push(signatureApp);
		const invalid = await signatureApp.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...assetMultipart(Buffer.from('GIF89a not an allowed image'), 'image.gif'),
		});
		expect(invalid.statusCode).toBe(400);
		expect(signatureHarness.storage.calls.upload).not.toHaveBeenCalled();
		expectReleased(signatureHarness);
	});

	it('rejects an oversized stream and an acquire failure with exact limiter ownership', async () => {
		const oversizeHarness = graphHarness('oversize', { imageMaxMb: 0.0001 });
		const oversizeApp = await routeApp(oversizeHarness);
		apps.push(oversizeApp);
		const oversize = await oversizeApp.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...assetMultipart(Buffer.concat([tinyPng, Buffer.alloc(512)])),
		});
		expect(oversize.statusCode).toBe(413);
		expect(oversizeHarness.storage.calls.upload).not.toHaveBeenCalled();
		expectReleased(oversizeHarness);

		const rejectedHarness = graphHarness('capacity');
		rejectedHarness.limiter.reject(new AppError(
			429,
			'Upload capacity exhausted',
			'TOO_MANY_UPLOADS',
		));
		const rejectedApp = await routeApp(rejectedHarness);
		apps.push(rejectedApp);
		const rejected = await rejectedApp.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...assetMultipart(),
		});
		expect(rejected.statusCode).toBe(429);
		expect(rejectedHarness.limiter.calls.acquire).toHaveBeenCalledOnce();
		expect(rejectedHarness.limiter.calls.release).not.toHaveBeenCalled();
		expect(rejectedHarness.limiter.active()).toBe(0);
		expect(rejectedHarness.fileSystem.calls.createWriteStream).not.toHaveBeenCalled();
		expect(rejectedHarness.storage.calls.upload).not.toHaveBeenCalled();
	});

	it('cleans an aborted real multipart stream and releases the slot once', async () => {
		const harness = graphHarness('abort');
		const app = await routeApp(harness);
		apps.push(app);
		let status: number | undefined;
		let rejected: unknown;
		try {
			status = (await app.inject({
				method: 'POST',
				url: '/api/admin/projects/7/assets',
				...abortedAssetMultipart(),
			})).statusCode;
		} catch (error) {
			rejected = error;
		}
		expect(status === undefined || status >= 400).toBe(true);
		if (status === undefined) expect(rejected).toBeInstanceOf(Error);
		await vi.waitFor(() => expectReleased(harness));
		expect(harness.storage.calls.upload).not.toHaveBeenCalled();
	});

	it.each(['before', 'after'] as const)(
		'rolls back storage failure %s persistence and removes temp files',
		async (timing) => {
			const harness = graphHarness(`storage-${timing}`);
			harness.storage.failUpload(timing);
			const app = await routeApp(harness);
			apps.push(app);
			const failed = await app.inject({
				method: 'POST',
				url: '/api/admin/projects/7/assets',
				...assetMultipart(),
			});
			expect(failed.statusCode).toBe(500);
			const key = harness.storage.calls.upload.mock.calls[0]?.[1];
			expect(key).toEqual(expect.any(String));
			expect(harness.storage.calls.delete).toHaveBeenCalledWith(
				'storage-' + timing + '-public',
				key,
			);
			const uploadBody = harness.storage.calls.upload.mock.calls[0]?.[2];
			expect(uploadBody).toBeInstanceOf(Readable);
			expect((uploadBody as Readable).destroyed).toBe(true);
			expectUploadStreamClosedBeforeTempRemoval(harness, uploadBody as Readable);
			expect(harness.storage.objects.has(key!)).toBe(false);
			if (timing === 'before') {
				// S3 DELETE is intentionally idempotent: rollback succeeds although
				// the failed PUT never created the key.
				expect(harness.storage.objects.has(key!)).toBe(false);
			}
			expectReleased(harness);
		},
	);

	it('preserves immediate upload rejection and stream cleanup failure after close', async () => {
		const harness = graphHarness('storage-stream-cleanup');
		const uploadError = new Error('storage rejected without consuming body');
		const streamCleanupError = new Error('request stream close failed');
		harness.storage.failUpload('before', uploadError, streamCleanupError);
		const observedErrors: unknown[] = [];
		const app = await routeApp(harness, observedErrors);
		apps.push(app);

		const failed = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...assetMultipart(),
		});

		expect(failed.statusCode).toBe(500);
		const uploadBody = harness.storage.calls.upload.mock.calls[0]?.[2];
		expect(uploadBody).toBeInstanceOf(Readable);
		expect((uploadBody as Readable).closed).toBe(true);
		expectUploadStreamClosedBeforeTempRemoval(harness, uploadBody as Readable);
		const leaves = errorLeaves(observedErrors[0]);
		expect(leaves).toContain(uploadError);
		expect(leaves).toContain(streamCleanupError);
		expectReleased(harness);
	});

	it('retries transient temp removal and reports permanent residue without false success', async () => {
		const transient = graphHarness('temp-transient');
		transient.fileSystem.failRemoveTimes(1);
		const transientApp = await routeApp(transient);
		apps.push(transientApp);
		const successful = await transientApp.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...assetMultipart(),
		});
		expect(successful.statusCode, successful.body).toBe(201);
		expect(transient.fileSystem.calls.remove.mock.calls.length).toBeGreaterThan(1);
		expectReleased(transient);

		const permanent = graphHarness('temp-permanent');
		permanent.fileSystem.failRemovePermanently();
		const observedErrors: unknown[] = [];
		const permanentApp = await routeApp(permanent, observedErrors);
		apps.push(permanentApp);
		const failed = await permanentApp.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			...submitMultipart('{invalid-json', tinyPng),
		});
		expect(failed.statusCode).toBe(500);
		expect(permanent.ports.calls.projectCreate).not.toHaveBeenCalled();
		expect(permanent.storage.calls.upload).not.toHaveBeenCalled();
		expect(permanent.fileSystem.calls.remove).toHaveBeenCalledTimes(3);
		expect(permanent.fileSystem.outstanding()).toHaveLength(1);
		const permanentErrorTree = errorLeaves(observedErrors[0]);
		expect(permanentErrorTree).toEqual(expect.arrayContaining([
			expect.objectContaining({
				message: 'Invalid payload JSON',
			}),
			expect.any(ProjectTempCleanupError),
		]));
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				residuePaths: permanent.fileSystem.outstanding(),
				maxAttempts: 3,
			}),
			'Project upload temp-file cleanup exhausted retries',
		);
		await permanent.fileSystem.recoverAndRemoveOutstanding();
		expect(permanent.fileSystem.outstanding()).toEqual([]);
	});

	it('deletes an unreferenced object after DB failure or records a durable orphan', async () => {
		const deletedHarness = graphHarness('db-delete');
		const assetDbError = new Error('asset DB original');
		deletedHarness.ports.failAsset(assetDbError);
		const observedErrors: unknown[] = [];
		const deletedApp = await routeApp(deletedHarness, observedErrors);
		apps.push(deletedApp);
		const deleted = await deletedApp.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...assetMultipart(),
		});
		expect(deleted.statusCode).toBe(500);
		expect(deletedHarness.storage.objects.size).toBe(0);
		expect(deletedHarness.storage.calls.delete).toHaveBeenCalledOnce();
		expect(errorLeaves(observedErrors[0])).toContain(assetDbError);
		expectReleased(deletedHarness);

		const queuedHarness = graphHarness('db-queue');
		queuedHarness.ports.failProject();
		queuedHarness.storage.failDelete();
		const queuedApp = await routeApp(queuedHarness);
		apps.push(queuedApp);
		const queued = await queuedApp.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			...submitMultipart(submitPayload(), tinyPng),
		});
		expect(queued.statusCode).toBe(500);
		const key = queuedHarness.storage.calls.upload.mock.calls[0]?.[1];
		expect(queuedHarness.storage.objects.has(key!)).toBe(true);
		expect(queuedHarness.ports.orphans.get(`db-queue-public\0${key}`)).toMatchObject({
			bucket: 'db-queue-public',
			storageKey: key,
			reason: 'project-upload-unpersisted-original',
		});
		expectReleased(queuedHarness);
	});

	it('surfaces cleanup plus durable queue double failure without DB success', async () => {
		const harness = graphHarness('double-failure');
		const projectDbError = new Error('project DB original');
		harness.ports.failProject(projectDbError);
		harness.storage.failDelete();
		harness.ports.failOrphan();
		const observedErrors: unknown[] = [];
		const app = await routeApp(harness, observedErrors);
		apps.push(app);
		const failed = await app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			...submitMultipart(submitPayload(), tinyPng),
		});
		expect(failed.statusCode).toBe(500);
		expect(failed.json().error.message).toMatch(/durable .*rollback failed/i);
		expect(errorLeaves(observedErrors[0])).toContain(projectDbError);
		expect(harness.ports.calls.projectCreate).toHaveBeenCalledOnce();
		expect(harness.ports.orphans.size).toBe(0);
		expectReleased(harness);
	});

	it('preserves DB, durable rollback, and permanent temp failures in one actual route error tree', async () => {
		const harness = await contextAppHarness('context-all-failures');
		const projectDbError = new Error('context project DB original');
		harness.ports.failProject(projectDbError);
		harness.storage.failDelete(new Error('context storage delete failed'));
		harness.ports.failOrphan(new Error('context durable queue failed'));
		harness.fileSystem.failRemovePermanently();

		const request = submitMultipart(submitPayload(), tinyPng);
		const failed = await harness.app.inject({
			method: 'POST',
			url: '/api/admin/projects/submit',
			...request,
			headers: {
				...request.headers,
				origin: defaultTestEnv.WEB_PUBLIC_URL,
			},
		});
		expect(failed.statusCode).toBe(500);
		const unhandled = contextUnhandledError(harness);
		expect(unhandled).toBeInstanceOf(AggregateError);
		const nestedErrors = errorLeaves(unhandled);
		expect(nestedErrors).toContain(projectDbError);
		expect(nestedErrors).toEqual(expect.arrayContaining([
			expect.any(DurableObjectDeletionError),
			expect.any(ProjectTempCleanupError),
		]));
		const tempCleanup = nestedErrors.find(
			(error): error is ProjectTempCleanupError => (
				error instanceof ProjectTempCleanupError
			),
		);
		expect(tempCleanup?.residuePaths).toEqual(
			expect.arrayContaining(harness.fileSystem.outstanding()),
		);
		expect(tempCleanup?.residuePaths.length).toBeGreaterThanOrEqual(
			harness.fileSystem.outstanding().length,
		);
		expect(harness.ports.calls.projectCreate).toHaveBeenCalledOnce();
		expect(harness.ports.projectCreateSuccesses()).toBe(0);
		expect(harness.ports.orphans.size).toBe(0);
		expect(harness.limiter.calls.acquire).toHaveBeenCalledOnce();
		expect(harness.limiter.calls.release).toHaveBeenCalledOnce();
		expect(harness.limiter.active()).toBe(0);
		expect(harness.fileSystem.outstanding().length).toBeGreaterThan(0);
		expect(harness.contextLoggerCalls.error).toHaveBeenCalledWith(
			expect.objectContaining({
				residuePaths: expect.arrayContaining(
					harness.fileSystem.outstanding(),
				),
				maxAttempts: 3,
			}),
			'Project upload temp-file cleanup exhausted retries',
		);

		const residuePaths = [...(tempCleanup?.residuePaths ?? [])];
		await harness.fileSystem.recoverAndRemoveOutstanding(residuePaths);
		expect(harness.fileSystem.outstanding()).toEqual([]);
		for (const residuePath of residuePaths) {
			await expect(
				harness.fileSystem.fileSystem.access(residuePath),
			).rejects.toBeDefined();
		}
	});

	it('drains an actual context with an in-flight multipart barrier and keeps B usable', async () => {
		let enterValidation!: () => void;
		const validationEntered = new Promise<void>((resolve) => {
			enterValidation = resolve;
		});
		let terminateValidation!: (error: Error) => void;
		const validationTermination = new Promise<never>((_resolve, reject) => {
			terminateValidation = reject;
		});
		const a = await contextAppHarness('drain-a', (processing) => ({
			...processing,
			async validate(filePath, kind) {
				enterValidation();
				await validationTermination;
				return processing.validate(filePath, kind);
			},
		}));
		const b = await contextAppHarness('drain-b');

		const requestA = assetMultipart();
		const inFlightA = a.app.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...requestA,
			headers: {
				...requestA.headers,
				origin: defaultTestEnv.WEB_PUBLIC_URL,
			},
		});
		await validationEntered;
		expect(a.context.lifecycle.inFlight()).toBe(1);
		expect(a.limiter.active()).toBe(1);
		expect(a.fileSystem.outstanding()).toHaveLength(1);

		a.context.lifecycle.setState('draining');
		let closeSettled = false;
		const closeA = a.app.close().finally(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);

		const requestB = assetMultipart();
		const responseB = await b.app.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...requestB,
			headers: {
				...requestB.headers,
				origin: defaultTestEnv.WEB_PUBLIC_URL,
			},
		});
		expect(responseB.statusCode, responseB.body).toBe(201);
		expectReleased(b);

		terminateValidation(new Error('ticket 011 drain terminated upload'));
		const responseA = await inFlightA;
		expect(responseA.statusCode).toBe(500);
		await closeA;
		expect(a.context.lifecycle.inFlight()).toBe(0);
		expectReleased(a);
		expect(a.ownedIdsClose).toHaveBeenCalledOnce();
		expect(b.ownedIdsClose).not.toHaveBeenCalled();
	});

	it('isolates actual A/B BackendContexts and closing A leaves B production routes usable', async () => {
		const a = await contextAppHarness('context-a');
		const b = await contextAppHarness('context-b');

		const requestA = assetMultipart();
		const responseA = await a.app.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...requestA,
			headers: {
				...requestA.headers,
				origin: defaultTestEnv.WEB_PUBLIC_URL,
			},
		});
		expect(responseA.statusCode, responseA.body).toBe(201);
		expect(a.settings.get).toHaveBeenCalledOnce();
		expect(b.settings.get).not.toHaveBeenCalled();
		expect(a.storage.calls.upload).toHaveBeenCalledOnce();
		expect(b.storage.calls.upload).not.toHaveBeenCalled();
		expect(a.fileSystem.created.size).toBeGreaterThan(0);
		expect(b.fileSystem.created.size).toBe(0);
		await a.app.close();
		expect(a.ownedIdsClose).toHaveBeenCalledOnce();

		const requestB = assetMultipart();
		const responseB = await b.app.inject({
			method: 'POST',
			url: '/api/admin/projects/7/assets',
			...requestB,
			headers: {
				...requestB.headers,
				origin: defaultTestEnv.WEB_PUBLIC_URL,
			},
		});
		expect(responseB.statusCode, responseB.body).toBe(201);
		expect(b.settings.get).toHaveBeenCalledOnce();
		expect(b.storage.calls.upload).toHaveBeenCalledOnce();
		expectReleased(a);
		expectReleased(b);
	});
});
