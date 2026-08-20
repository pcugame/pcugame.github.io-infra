import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
	AppLogger,
	ObjectStorage,
	SettingsStore,
} from '../application/ports.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createNodeFileSystem } from '../infrastructure/production-ports.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createS3Client, createS3PresigningClient } from '../lib/s3.js';
import { createObjectStorage } from '../lib/storage.js';
import { createUploadLifecycleMetrics } from '../lib/upload-lifecycle-metrics.js';
import {
	createGameUploadProductionGraph,
	type GameUploadProductionGraph,
} from '../modules/admin/game-upload/composition.js';
import { createGameUploadValidationGraph } from '../modules/admin/game-upload/validation-worker.composition.js';
import { createGameUploadRepository } from '../modules/admin/game-upload/repository.js';
import {
	createProductionUploadLifecycleRuntime,
	type UploadLifecycleRuntime,
} from '../modules/upload-lifecycle/runtime.js';
import { createProjectAccessRepository } from '../modules/admin/project-access.repository.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import {
	createWebglDeploymentKeys,
	createWebglPublicDeploymentKeys,
	parseWebglSourceKey,
} from '../modules/webgl/paths.js';
import { createOrphanRepository } from '../modules/orphan/repository.js';
import { createOrphanService } from '../modules/orphan/service.js';
import { createObjectReferenceResolver } from '../modules/orphan/reference-resolver.js';
import { createUploadLimiter } from '../shared/upload-limits.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { sourceIdentityRoot } from '../modules/admin/game-upload/source-identity.js';
import {
	DirectUploadQuotaExceededError,
	GameUploadTargetFencedError,
} from '../modules/admin/game-upload/ports.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const runStorageIntegration = process.env['RUN_STORAGE_INTEGRATION'] === 'true';
const SOURCE_BLOCK_SIZE = 1_048_576;

function sourceIdentityForSize(totalBytes: bigint) {
	const digest = createHash('sha256').update(Buffer.from('postgres-fixture-source')).digest('hex');
	const blockDigests = Array.from(
		{ length: Math.ceil(Number(totalBytes) / SOURCE_BLOCK_SIZE) },
		() => digest,
	);
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
		sourceIdentity: sourceIdentityRoot(Number(totalBytes), SOURCE_BLOCK_SIZE, blockDigests),
		sourceIdentityBlockSizeBytes: SOURCE_BLOCK_SIZE,
		sourceIdentityBlockManifest: Buffer.from(blockDigests.join(''), 'hex'),
		sourceIdentityBlockDigests: blockDigests,
	};
}

function sourceIdentityForBuffer(bytes: Buffer) {
	const blockDigests: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += SOURCE_BLOCK_SIZE) {
		blockDigests.push(createHash('sha256')
			.update(bytes.subarray(offset, Math.min(bytes.length, offset + SOURCE_BLOCK_SIZE)))
			.digest('hex'));
	}
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
		sourceIdentity: sourceIdentityRoot(bytes.length, SOURCE_BLOCK_SIZE, blockDigests),
		sourceIdentityBlockSizeBytes: SOURCE_BLOCK_SIZE,
		sourceIdentityBlockManifest: Buffer.concat(
			blockDigests.map((digest) => Buffer.from(digest, 'hex')),
		),
		sourceIdentityBlockDigests: blockDigests,
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

function databaseUrlWithApplicationName(databaseUrl: string, applicationName: string): string {
	const parsed = new URL(databaseUrl);
	parsed.searchParams.set('application_name', applicationName);
	return parsed.toString();
}

function sqlIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

async function runCleanupSteps(
	steps: Array<() => Promise<unknown>>,
): Promise<void> {
	let firstError: unknown;
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			firstError ??= error;
		}
	}
	if (firstError !== undefined) throw firstError;
}

function makeStoredZip(files: Array<{ name: string; body?: Buffer }>): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name);
		const body = file.body ?? Buffer.alloc(0);
		const local = Buffer.alloc(30 + name.length + body.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(body.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);
		body.copy(local, 30 + name.length);
		localParts.push(local);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(body.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);
		centralParts.push(central);
		offset += local.length;
	}
	const central = Buffer.concat(centralParts);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(central.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, central, eocd]);
}

function memoryStorage() {
	const objects = new Map<string, Buffer>();
	const multiparts = new Map<string, {
		bucket: string;
		key: string;
		parts: Map<number, Buffer>;
	}>();
	let deleteFailure: Error | undefined;
	const calls = {
		completeMultipart: vi.fn(),
		abortMultipart: vi.fn(),
		delete: vi.fn(),
		upload: vi.fn(),
	};

	async function bodyBuffer(body: Buffer | NodeJS.ReadableStream): Promise<Buffer> {
		if (Buffer.isBuffer(body)) return body;
		const chunks: Buffer[] = [];
		for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	}

	const storage: ObjectStorage = {
		upload: calls.upload.mockImplementation(async (bucket, key, body) => {
			objects.set(`${bucket}/${key}`, await bodyBuffer(body));
		}),
		presign: vi.fn(async () => 'https://storage.test/object'),
		presignUploadPart: vi.fn(async (_bucket, _key, _uploadId, partNumber) => (
			`https://storage.test/upload-part/${partNumber}`
		)),
		delete: calls.delete.mockImplementation(async (bucket, key) => {
			if (deleteFailure) throw deleteFailure;
			objects.delete(`${bucket}/${key}`);
		}),
		head: vi.fn(async (bucket, key) => {
			const object = objects.get(`${bucket}/${key}`);
			return object
				? { size: object.length, contentType: 'application/zip' }
				: null;
		}),
		readRange: vi.fn(async (bucket, key, start, end) => (
			objects.get(`${bucket}/${key}`)?.subarray(start, end + 1) ?? Buffer.alloc(0)
		)),
		stream: vi.fn(async (bucket, key) => {
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
		createMultipart: vi.fn(async (bucket, key) => {
			const uploadId = randomUUID();
			multiparts.set(uploadId, { bucket, key, parts: new Map() });
			return uploadId;
		}),
		uploadPart: vi.fn(async (_bucket, _key, uploadId, partNumber, body) => {
			const upload = multiparts.get(uploadId);
			if (!upload) throw new Error('multipart not found');
			const value = await bodyBuffer(body);
			upload.parts.set(partNumber, value);
			return `etag-${partNumber}`;
		}),
		completeMultipart: calls.completeMultipart.mockImplementation(async (
			bucket,
			key,
			uploadId,
		) => {
			const upload = multiparts.get(uploadId);
			if (!upload) throw new Error('multipart not found');
			objects.set(
				`${bucket}/${key}`,
				Buffer.concat(
					[...upload.parts.entries()]
						.sort(([a], [b]) => a - b)
						.map(([, value]) => value),
		),
			);
			multiparts.delete(uploadId);
		}),
		listKeyPage: vi.fn(async (bucket, prefix, { startAfter, maxKeys }) => {
			const keys = [...objects.keys()]
				.filter((entry) => entry.startsWith(`${bucket}/${prefix}`))
				.map((entry) => entry.slice(bucket.length + 1))
				.filter((key) => !startAfter || key > startAfter)
				.sort();
			const page = keys.slice(0, maxKeys);
			return { keys: page, isTruncated: keys.length > page.length };
		}),
		deleteKeys: vi.fn(async (bucket, keys) => {
			for (const key of keys) objects.delete(`${bucket}/${key}`);
			return { deleted: [...keys], failures: [] };
		}),
		abortMultipart: calls.abortMultipart.mockImplementation(async (
			_bucket,
			_key,
			uploadId,
		) => {
			multiparts.delete(uploadId);
		}),
		listParts: vi.fn(async (_bucket, _key, uploadId) => {
			const upload = multiparts.get(uploadId);
			if (!upload) throw new Error('multipart not found');
			return [...upload.parts.keys()]
				.sort((left, right) => left - right)
				.map((partNumber) => ({
					partNumber,
					etag: `etag-${partNumber}`,
					sizeBytes: upload.parts.get(partNumber)!.length,
				}));
		}),
		listMultipartUploads: vi.fn(async (bucket, prefix) => [...multiparts.entries()]
			.filter(([, upload]) => upload.bucket === bucket && upload.key.startsWith(prefix))
			.map(([uploadId, upload]) => ({
				key: upload.key,
				uploadId,
				initiated: new Date(),
			}))),
	};
	return {
		storage,
		objects,
		multiparts,
		calls,
		put(bucket: string, key: string, value: Buffer) {
			objects.set(`${bucket}/${key}`, value);
		},
		seedMultipart(
			bucket: string,
			key: string,
			uploadId: string,
			partNumber: number,
			value: Buffer,
		) {
			multiparts.set(uploadId, {
				bucket,
				key,
				parts: new Map([[partNumber, value]]),
			});
		},
		failDelete(error = new Error('forced storage delete failure')) {
			deleteFailure = error;
		},
		restoreDelete() {
			deleteFailure = undefined;
		},
	};
}

function pointerFaultClient(client: PrismaClient, failure: Error): PrismaClient {
	let armed = true;
	return new Proxy(client, {
		get(target, property, receiver) {
			if (property !== '$transaction') {
				const value = Reflect.get(target, property, receiver) as unknown;
				return typeof value === 'function' ? value.bind(target) : value;
			}
			return async (
				work: ((tx: object) => Promise<unknown>) | unknown[],
				options?: unknown,
			) => {
				if (Array.isArray(work)) {
					return (target.$transaction as unknown as (
						input: unknown[],
						config?: unknown,
					) => Promise<unknown>)(work, options);
				}
				return (target.$transaction as unknown as (
					input: (tx: object) => Promise<unknown>,
					config?: unknown,
				) => Promise<unknown>)(async (tx) => {
					const rawProject = Reflect.get(tx, 'project') as object;
					const project = new Proxy(rawProject, {
						get(projectTarget, projectProperty, projectReceiver) {
							const value = Reflect.get(
								projectTarget,
								projectProperty,
								projectReceiver,
							) as unknown;
							if (projectProperty !== 'update' || typeof value !== 'function') {
								return typeof value === 'function'
									? value.bind(projectTarget)
									: value;
							}
							return async (args: {
								data?: { webglEntryKey?: string };
							}) => {
								if (armed && args.data?.webglEntryKey) {
									armed = false;
									throw failure;
								}
								return (value as (input: unknown) => Promise<unknown>)
									.call(projectTarget, args);
							};
						},
					});
					const wrapped = new Proxy(tx, {
						get(txTarget, txProperty, txReceiver) {
							if (txProperty === 'project') return project;
							const value = Reflect.get(txTarget, txProperty, txReceiver) as unknown;
							return typeof value === 'function' ? value.bind(txTarget) : value;
						},
					});
					return work(wrapped);
				}, options);
			};
		},
	}) as PrismaClient;
}

describe.runIf(runPostgresIntegration)(
	'game-upload production graph with PostgreSQL',
	() => {
		let control: PrismaClient;
		let recoveryClient: PrismaClient;
		let userId: number;
		let exhibitionId: number;
		let projectId: number;
		const testId = randomUUID();
		const publicBucket = `ticket-012-public-${testId}`;
		const protectedBucket = `ticket-012-protected-${testId}`;
		const storage = memoryStorage();
		const graphs: GameUploadProductionGraph[] = [];
		const runtimes: UploadLifecycleRuntime[] = [];
		let idSequence = 0;

		const settings: SettingsStore = {
			get: async () => ({ maxGameFileMb: 8, maxChunkSizeMb: 1 }),
			update: async (patch) => ({
				maxGameFileMb: patch.maxGameFileMb ?? 8,
				maxChunkSizeMb: patch.maxChunkSizeMb ?? 1,
			}),
			invalidate: () => {},
		};

		function graph(
			client: PrismaClient,
			objectStorage: ObjectStorage = storage.storage,
			buckets = { publicBucket, protectedBucket },
		): GameUploadProductionGraph {
			const access = createProjectAccessService(
				createProjectAccessRepository(client),
			);
			const uploadLifecycle = productionRuntime(client, objectStorage, buckets);
			const value = createGameUploadProductionGraph({
				config: {
					...defaultTestEnv,
					S3_BUCKET_PROTECTED: buckets.protectedBucket,
					UPLOAD_CHUNK_SIZE_MB: 1,
					UPLOAD_SESSION_TTL_MINUTES: 60,
					UPLOAD_USER_GAME_MAX_MB: 8,
					UPLOAD_PRIVILEGED_GAME_MAX_MB: 8,
				},
				storage: objectStorage,
				settings,
				uploadLimiter: createUploadLimiter(() => 2),
				lifecycle: {
					state: () => 'ready',
					setState: () => {},
					isAcceptingNewWork: () => true,
					requestStarted: () => {},
					requestFinished: () => {},
					inFlight: () => 0,
					waitForDrain: async () => 'drained',
				},
				clock: { now: () => new Date('2098-07-31T00:10:00.000Z') },
				ids: {
					next: () => {
						idSequence += 1;
						return `00000000-0000-4000-8000-${String(idSequence).padStart(12, '0')}`;
					},
				},
				logger,
				access,
				uploadLifecycle,
			});
			graphs.push(value);
			return value;
		}

		function validationGraph(
			client: PrismaClient,
			objectStorage: ObjectStorage = storage.storage,
			buckets = { publicBucket, protectedBucket },
		) {
			const uploadLifecycle = productionRuntime(client, objectStorage, buckets);
			return createGameUploadValidationGraph({
				config: {
					PUBLIC_ASSET_BASE_URL: 'https://ticket-012.assets.test',
					S3_BUCKET_PUBLIC: buckets.publicBucket,
					S3_BUCKET_PROTECTED: buckets.protectedBucket,
				},
				storage: objectStorage,
				fileSystem: createNodeFileSystem(),
				ids: { next: () => randomUUID() },
				logger,
				uploadLifecycle,
				options: {
					concurrency: 1,
					claimLeaseMs: 120_000,
					tempRoot: createNodeFileSystem().temporaryDirectory(),
					tempDiskBudgetBytes: 32 * 1024 * 1024,
				},
			});
		}

		function productionRuntime(
			client: PrismaClient,
			objectStorage: ObjectStorage = storage.storage,
			buckets = { publicBucket, protectedBucket },
		): UploadLifecycleRuntime {
			const runtime = createProductionUploadLifecycleRuntime({
				config: {
					S3_BUCKET_PUBLIC: buckets.publicBucket,
					S3_BUCKET_PROTECTED: buckets.protectedBucket,
				},
				prisma: client,
				storage: objectStorage,
				clock: { now: () => new Date('2098-07-31T00:10:00.000Z') },
				ids: { next: () => randomUUID() },
				logger,
				metrics: createUploadLifecycleMetrics(),
			});
			runtimes.push(runtime);
			return runtime;
		}

		async function createSessionFixture(input: {
			id?: string;
			uploadKind?: 'GAME' | 'WEBGL';
			status?: string;
			s3Key: string;
			s3UploadId?: string | null;
			storageKey?: string | null;
			totalBytes?: bigint;
			sourceBytes?: Buffer;
			expiresAt?: Date;
			updatedAt?: Date;
			expectedTargetAssetId?: number | null;
			expectedTargetAssetUpdatedAt?: Date | null;
		}) {
			const totalBytes = input.totalBytes ?? BigInt(input.sourceBytes?.length ?? 1);
			const { sourceIdentityBlockDigests: _sourceIdentityBlockDigests, ...sourceIdentity } = input.sourceBytes
				? sourceIdentityForBuffer(input.sourceBytes)
				: sourceIdentityForSize(totalBytes);
			const session = await control.gameUploadSession.create({
				data: {
					id: input.id ?? randomUUID(),
					projectId,
					userId,
					uploadKind: input.uploadKind ?? 'GAME',
					originalName: input.uploadKind === 'WEBGL' ? 'build.zip' : 'game.zip',
					totalBytes,
					chunkSizeBytes: SOURCE_BLOCK_SIZE,
					totalChunks: 1,
					...sourceIdentity,
					status: input.status ?? 'PENDING',
					s3Key: input.s3Key,
					s3UploadId: input.s3UploadId === undefined ? randomUUID() : input.s3UploadId,
					storageKey: input.storageKey ?? null,
					expectedTargetAssetId: input.expectedTargetAssetId ?? null,
					expectedTargetAssetUpdatedAt: input.expectedTargetAssetUpdatedAt ?? null,
					expiresAt: input.expiresAt ?? new Date('2099-01-01T00:00:00.000Z'),
				},
			});
			if (input.updatedAt) {
				await control.$executeRaw`
					UPDATE "game_upload_sessions"
					SET "updated_at" = ${input.updatedAt}
					WHERE "id" = ${session.id}
				`;
			}
			await control.gameUploadActiveSession.create({
				data: {
					projectId,
					uploadKind: session.uploadKind,
					sessionId: session.id,
				},
			});
			return session;
		}

		beforeAll(async () => {
			const databaseUrl = process.env['DATABASE_URL'];
			if (!databaseUrl) throw new Error('DATABASE_URL is required');
			control = createPrismaClientForDatabase(databaseUrl);
			recoveryClient = createPrismaClientForDatabase(databaseUrl);
			await Promise.all([control.$connect(), recoveryClient.$connect()]);
			const user = await control.user.create({
				data: {
					googleSub: `ticket-012-${testId}`,
					email: `ticket-012-${testId}@example.test`,
					name: 'Ticket 012',
					role: 'ADMIN',
				},
			});
			userId = user.id;
			const exhibition = await control.exhibition.create({
				data: {
					year: 2098,
					title: `Ticket 012 ${testId}`,
					isUploadEnabled: true,
				},
			});
			exhibitionId = exhibition.id;
			const project = await control.project.create({
				data: {
					exhibitionId,
					creatorId: userId,
					slug: `ticket-012-${testId}`,
					title: 'Ticket 012 project',
					status: 'PUBLISHED',
				},
			});
			projectId = project.id;
		});

		afterAll(async () => {
			await Promise.allSettled(graphs.map((value) => value.close()));
			await Promise.allSettled(runtimes.map((value) => value.close()));
			if (!control) return;
			await control.multipartAbortTask.deleteMany({
				where: { bucket: protectedBucket },
			});
			await control.orphanObject.deleteMany({
				where: { bucket: { in: [publicBucket, protectedBucket] } },
			});
			await control.project.deleteMany({ where: { id: projectId } });
			await control.exhibition.deleteMany({ where: { id: exhibitionId } });
			await control.user.deleteMany({ where: { id: userId } });
			await Promise.all([control.$disconnect(), recoveryClient.$disconnect()]);
		});

		it('rejects replacement of an actual COMPLETING active slot', async () => {
			const completing = await createSessionFixture({
				status: 'COMPLETING',
				uploadKind: 'GAME',
				s3Key: `${testId}-active.zip`,
			});
			const service = graph(control).service;
			const identity = sourceIdentityForSize(1n);

			await expect(service.createSession(
				projectId,
				exhibitionId,
				{ id: userId, role: 'ADMIN' },
				{
					originalName: 'replacement.zip', totalBytes: 1,
					sourceIdentityAlgorithm: identity.sourceIdentityAlgorithm,
					sourceIdentity: identity.sourceIdentity,
					sourceIdentityBlockSizeBytes: identity.sourceIdentityBlockSizeBytes,
					sourceIdentityBlockDigests: identity.sourceIdentityBlockDigests,
				},
			)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
			await expect(control.gameUploadSession.findUniqueOrThrow({
				where: { id: completing.id },
			})).resolves.toMatchObject({ status: 'COMPLETING' });
			await expect(control.gameUploadActiveSession.findUniqueOrThrow({
				where: {
					projectId_uploadKind: { projectId, uploadKind: 'GAME' },
				},
			})).resolves.toMatchObject({ sessionId: completing.id });
			expect(storage.calls.abortMultipart).not.toHaveBeenCalled();

			await control.gameUploadActiveSession.deleteMany({
				where: { sessionId: completing.id },
			});
			await control.gameUploadSession.delete({ where: { id: completing.id } });
		});

		it('persists and atomically resets the UploadPart capability refresh window', async () => {
			const active = await createSessionFixture({
				uploadKind: 'GAME',
				s3Key: `${testId}-capability-window.zip`,
			});
			const repository = createGameUploadRepository(control, {
				abortBucket: protectedBucket,
				publicBucket,
			});
			const request = {
				sessionId: active.id,
				actor: { id: userId, role: 'ADMIN' as const },
				generation: 1,
				partNumbers: [1],
				maxIssuesPerWindow: 2,
				issueWindowMs: 300_000,
				quota: {
					actorActiveSessions: 4,
					projectActiveSessions: 2,
					actorOutstandingBytes: 10n * 1024n * 1024n * 1024n,
				},
			};
			try {
				await expect(repository.reservePartCapabilities(request)).resolves.toMatchObject({
					isRefresh: false,
					session: { id: active.id },
				});
				await expect(repository.reservePartCapabilities(request)).resolves.toMatchObject({
					isRefresh: true,
				});
				await expect(repository.reservePartCapabilities(request)).rejects.toBeInstanceOf(
					DirectUploadQuotaExceededError,
				);
				await control.$executeRaw`
					UPDATE "game_upload_sessions"
					SET "part_url_issue_window_started_at" = clock_timestamp() - INTERVAL '10 minutes'
					WHERE "id" = ${active.id}
				`;
				await expect(repository.reservePartCapabilities(request)).resolves.toMatchObject({
					isRefresh: true,
				});
			} finally {
				await control.gameUploadActiveSession.deleteMany({ where: { sessionId: active.id } });
				await control.gameUploadSession.deleteMany({ where: { id: active.id } });
			}
		});

		it('enforces actor/project declared-byte quota while accounting replacement in the same slot', async () => {
			const active = await createSessionFixture({
				uploadKind: 'GAME',
				s3Key: `${testId}-quota-active.zip`,
				totalBytes: 7n,
			});
			const repository = createGameUploadRepository(control, {
				abortBucket: protectedBucket,
				publicBucket,
			});
			const limits = {
				actorActiveSessions: 1,
				projectActiveSessions: 1,
				actorOutstandingBytes: 8n,
			};
			try {
				await expect(repository.assertCanCreateSession({
					projectId,
					userId,
					uploadKind: 'GAME',
					totalBytes: 8n,
					limits,
				})).resolves.toBeUndefined();
				await expect(repository.assertCanCreateSession({
					projectId,
					userId,
					uploadKind: 'WEBGL',
					totalBytes: 1n,
					limits,
				})).rejects.toBeInstanceOf(DirectUploadQuotaExceededError);
			} finally {
				await control.gameUploadActiveSession.deleteMany({ where: { sessionId: active.id } });
				await control.gameUploadSession.deleteMany({ where: { id: active.id } });
			}
		});

		it('uses the production lifecycle repository to atomically replace an active upload and queue its abort', async () => {
			const oldKey = `${testId}-replace-old.zip`;
			const oldUploadId = randomUUID();
			const oldSession = await createSessionFixture({
				s3Key: oldKey,
				s3UploadId: oldUploadId,
			});
			const newSessionId = randomUUID();
			const newKey = `${testId}-replace-new.zip`;
			const runtime = productionRuntime(control);
			const { sourceIdentityBlockDigests: _newDigests, ...newIdentity } = sourceIdentityForSize(1n);

			try {
				const result = await runtime.gameUploads.createSessionReplacingActive({
					id: newSessionId,
					projectId,
					userId,
					uploadKind: 'GAME',
					originalName: 'replacement.zip',
					totalBytes: 1n,
					chunkSizeBytes: SOURCE_BLOCK_SIZE,
					totalChunks: 1,
					...newIdentity,
					s3UploadId: randomUUID(),
					s3Key: newKey,
					expiresAt: new Date('2099-01-01T00:00:00.000Z'),
				}, {
					actorActiveSessions: 4,
					projectActiveSessions: 2,
					actorOutstandingBytes: 10n * 1024n * 1024n * 1024n,
				});

				expect(result.session.id).toBe(newSessionId);
				expect(result.durableAborts).toEqual([{
					tracking: 'durable-abort-task-committed',
					sessionId: oldSession.id,
					key: oldKey,
					uploadId: oldUploadId,
					reason: 'active-upload-replaced',
				}]);
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: oldSession.id },
				})).resolves.toMatchObject({
					status: 'CANCELLED',
					s3Key: null,
					s3UploadId: null,
				});
				await expect(control.gameUploadActiveSession.findUniqueOrThrow({
					where: {
						projectId_uploadKind: { projectId, uploadKind: 'GAME' },
					},
				})).resolves.toMatchObject({ sessionId: newSessionId });
				await expect(control.multipartAbortTask.findUnique({
					where: {
						multipart_abort_bucket_key_upload: {
							bucket: protectedBucket,
							storageKey: oldKey,
							uploadId: oldUploadId,
						},
					},
				})).resolves.toMatchObject({
					state: 'PENDING',
					reason: 'active-upload-replaced',
				});
			} finally {
				await runCleanupSteps([
					() => control.gameUploadActiveSession.deleteMany({
						where: { sessionId: { in: [oldSession.id, newSessionId] } },
					}),
					() => control.gameUploadSession.deleteMany({
						where: { id: { in: [oldSession.id, newSessionId] } },
					}),
					() => control.multipartAbortTask.deleteMany({
						where: { bucket: protectedBucket, storageKey: oldKey, uploadId: oldUploadId },
					}),
				]);
			}
		});

		it('rolls back active replacement when the multipart-abort outbox cannot be committed', async () => {
			const oldKey = `${testId}-replace-rollback-old.zip`;
			const oldUploadId = randomUUID();
			const oldSession = await createSessionFixture({
				s3Key: oldKey,
				s3UploadId: oldUploadId,
			});
			const newSessionId = randomUUID();
			const { sourceIdentityBlockDigests: _newDigests, ...newIdentity } = sourceIdentityForSize(1n);
			const suffix = oldSession.id.replaceAll('-', '_');
			const functionName = `ticket_012_abort_${suffix}`;
			const triggerName = `${functionName}_trigger`;
			const quotedFunction = sqlIdentifier(functionName);
			const quotedTrigger = sqlIdentifier(triggerName);
			let functionCreated = false;
			let triggerCreated = false;

			try {
				await control.$executeRawUnsafe(`
					CREATE FUNCTION ${quotedFunction}() RETURNS trigger
					LANGUAGE plpgsql AS $ticket_012$
					BEGIN
						IF NEW.bucket = ${sqlLiteral(protectedBucket)}
							AND NEW.storage_key = ${sqlLiteral(oldKey)}
							AND NEW.upload_id = ${sqlLiteral(oldUploadId)}
						THEN
							RAISE EXCEPTION 'ticket-012 forced multipart abort outbox failure';
						END IF;
						RETURN NEW;
					END
					$ticket_012$
				`);
				functionCreated = true;
				await control.$executeRawUnsafe(`
					CREATE TRIGGER ${quotedTrigger}
					BEFORE INSERT OR UPDATE ON "multipart_abort_tasks"
					FOR EACH ROW EXECUTE FUNCTION ${quotedFunction}()
				`);
				triggerCreated = true;

				const runtime = productionRuntime(control);
				await expect(runtime.gameUploads.createSessionReplacingActive({
					id: newSessionId,
					projectId,
					userId,
					uploadKind: 'GAME',
					originalName: 'must-rollback.zip',
					totalBytes: 1n,
					chunkSizeBytes: SOURCE_BLOCK_SIZE,
					totalChunks: 1,
					...newIdentity,
					s3UploadId: randomUUID(),
					s3Key: `${testId}-replace-rollback-new.zip`,
					expiresAt: new Date('2099-01-01T00:00:00.000Z'),
				}, {
					actorActiveSessions: 4,
					projectActiveSessions: 2,
					actorOutstandingBytes: 10n * 1024n * 1024n * 1024n,
				})).rejects.toThrow('ticket-012 forced multipart abort outbox failure');

				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: oldSession.id },
				})).resolves.toMatchObject({
					status: 'PENDING',
					s3Key: oldKey,
					s3UploadId: oldUploadId,
				});
				await expect(control.gameUploadSession.findUnique({
					where: { id: newSessionId },
				})).resolves.toBeNull();
				await expect(control.gameUploadActiveSession.findUniqueOrThrow({
					where: {
						projectId_uploadKind: { projectId, uploadKind: 'GAME' },
					},
				})).resolves.toMatchObject({ sessionId: oldSession.id });
				await expect(control.multipartAbortTask.count({
					where: { bucket: protectedBucket, storageKey: oldKey, uploadId: oldUploadId },
				})).resolves.toBe(0);
			} finally {
				await runCleanupSteps([
					...triggerCreated
						? [() => control.$executeRawUnsafe(
								`DROP TRIGGER IF EXISTS ${quotedTrigger} ON "multipart_abort_tasks"`,
							)]
						: [],
					...functionCreated
						? [() => control.$executeRawUnsafe(
								`DROP FUNCTION IF EXISTS ${quotedFunction}()`,
							)]
						: [],
					() => control.gameUploadActiveSession.deleteMany({
						where: { sessionId: { in: [oldSession.id, newSessionId] } },
					}),
					() => control.gameUploadSession.deleteMany({
						where: { id: { in: [oldSession.id, newSessionId] } },
					}),
					() => control.multipartAbortTask.deleteMany({
						where: { bucket: protectedBucket, storageKey: oldKey, uploadId: oldUploadId },
					}),
				]);
			}
		});

		it('atomically fences a stale GAME target snapshot and preserves the newer READY asset', async () => {
			const oldKey = `${testId}-snapshot-old.zip`;
			const newerKey = `${testId}-snapshot-newer.zip`;
			const candidateKey = `${testId}-snapshot-candidate.zip`;
			const oldAsset = await control.asset.create({
				data: {
					projectId, kind: 'GAME', status: 'READY', storageKey: oldKey,
					originalName: 'old.zip', mimeType: 'application/zip', sizeBytes: 1n,
				},
			});
			const repository = createGameUploadRepository(control, { abortBucket: protectedBucket });
			const sessionId = randomUUID();
			const { sourceIdentityBlockDigests: _digests, ...identity } = sourceIdentityForSize(1n);
			await repository.createSessionReplacingActive({
				id: sessionId, projectId, userId, uploadKind: 'GAME', originalName: 'candidate.zip',
				totalBytes: 1n, chunkSizeBytes: SOURCE_BLOCK_SIZE, totalChunks: 1,
				...identity, s3Key: candidateKey, s3UploadId: randomUUID(),
				expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			}, {
				actorActiveSessions: 4,
				projectActiveSessions: 2,
				actorOutstandingBytes: 10n * 1024n * 1024n * 1024n,
			});
			const session = await control.gameUploadSession.findUniqueOrThrow({ where: { id: sessionId } });
			expect(session).toMatchObject({
				expectedTargetAssetId: oldAsset.id,
				expectedTargetAssetUpdatedAt: oldAsset.updatedAt,
			});
			const token = randomUUID();
			await control.gameUploadSession.update({
				where: { id: session.id },
				data: {
					status: 'VERIFYING',
					storageKey: candidateKey,
					completionClaimToken: token,
					completionClaimUntil: new Date('2099-01-01T00:00:00.000Z'),
				},
			});
			await control.asset.update({ where: { id: oldAsset.id }, data: { status: 'DELETED' } });
			const newerAsset = await control.asset.create({
				data: {
					projectId, kind: 'GAME', status: 'READY', storageKey: newerKey,
					originalName: 'newer.zip', mimeType: 'application/zip', sizeBytes: 1n,
				},
			});

			try {
				await expect(repository.finalizeCompletedSession(
					session.id,
					projectId,
					'GAME',
					{
						storageKey: candidateKey,
						originalName: 'candidate.zip',
						mimeType: 'application/zip',
						sizeBytes: 1n,
						isPublic: false,
						completionClaimToken: token,
					},
					{
						bucket: protectedBucket,
						reason: 'replace-game',
						playbackReason: 'replace-playback',
					},
				)).rejects.toBeInstanceOf(GameUploadTargetFencedError);
				await expect(control.asset.findUniqueOrThrow({ where: { id: newerAsset.id } }))
					.resolves.toMatchObject({ status: 'READY', storageKey: newerKey });
				await expect(control.gameUploadSession.findUniqueOrThrow({ where: { id: session.id } }))
					.resolves.toMatchObject({
						status: 'REJECTED', storageKey: candidateKey,
						completionClaimToken: null, completionLastError: 'STALE_TARGET_ASSET',
					});
				await expect(control.gameUploadActiveSession.findUnique({
					where: { projectId_uploadKind: { projectId, uploadKind: 'GAME' } },
				})).resolves.toBeNull();
				await expect(control.orphanObject.findUnique({
					where: {
						orphan_bucket_storage_key: {
							bucket: protectedBucket,
							storageKey: candidateKey,
						},
					},
				})).resolves.toMatchObject({ state: 'PENDING', targetKind: 'EXACT' });
			} finally {
				await runCleanupSteps([
					() => control.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } }),
					() => control.gameUploadSession.deleteMany({ where: { id: session.id } }),
					() => control.orphanObject.deleteMany({
						where: { bucket: protectedBucket, storageKey: candidateKey },
					}),
					() => control.asset.deleteMany({ where: { id: { in: [oldAsset.id, newerAsset.id] } } }),
				]);
			}
		});

		it('keeps an active completion lease despite a future recovery cutoff and fences expired finalizers', async () => {
			const key = `${testId}-completion-lease-clock.zip`;
			const session = await createSessionFixture({ s3Key: key });
			const owner = createGameUploadRepository(control, { abortBucket: protectedBucket });
			const recovery = createGameUploadRepository(recoveryClient, { abortBucket: protectedBucket });
			const ownerToken = randomUUID();
			const recoveryToken = randomUUID();
			const competingRecoveryToken = randomUUID();

			try {
				await expect(owner.claimCompletion({
					sessionId: session.id,
					generation: 1,
					token: ownerToken,
					leaseMs: 2 * 60_000,
				})).resolves.toEqual({ count: 1, reason: null });
				await expect(recovery.claimStaleCompletingSessions(
					new Date('9990-01-01T00:00:00.000Z'),
					recoveryToken,
					2 * 60_000,
					50,
				)).resolves.toEqual([]);
				const activeCompletion = await control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				});
				const [completionDatabaseTime] = await control.$queryRaw<Array<{ now: Date }>>`
					SELECT clock_timestamp() AS "now"
				`;
				const completionLeaseRemaining = activeCompletion.completionClaimUntil!.getTime()
					- completionDatabaseTime!.now.getTime();
				expect(completionLeaseRemaining).toBeGreaterThan(60_000);
				expect(completionLeaseRemaining).toBeLessThan(3 * 60_000);

				await expect(owner.renewCompletionClaim(session.id, 'wrong-token', 5 * 60_000))
					.resolves.toEqual({ count: 0 });
				const firstDeadline = (await control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).completionClaimUntil!;
				await expect(owner.renewCompletionClaim(session.id, ownerToken, 5 * 60_000))
					.resolves.toEqual({ count: 1 });
				const renewedDeadline = (await control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).completionClaimUntil!;
				expect(renewedDeadline.getTime())
					.toBeGreaterThan(firstDeadline.getTime() + 2 * 60_000);

				await control.gameUploadSession.update({
					where: { id: session.id },
					data: { completionClaimUntil: new Date(0) },
				});
				await expect(owner.renewCompletionClaim(session.id, ownerToken, 5 * 60_000))
					.resolves.toEqual({ count: 0 });
				await expect(owner.releaseCompletionClaim(
					session.id,
					ownerToken,
					'stale-release',
				)).resolves.toEqual({ count: 0 });
				await expect(owner.revertToPending(session.id, ownerToken))
					.resolves.toEqual({ count: 0 });
				await expect(owner.markFailed(session.id, key, ownerToken))
					.resolves.toEqual({ count: 0 });
				await expect(owner.markCompletedObjectFailed({
					sessionId: session.id,
					storageKey: key,
					reason: 'stale-terminal-finalizer',
					completionClaimToken: ownerToken,
				})).resolves.toEqual({ count: 0 });
				await expect(owner.finalizeCompletedSession(
					session.id,
					projectId,
					'GAME',
					{
						storageKey: key,
						originalName: 'game.zip',
						mimeType: 'application/zip',
						sizeBytes: 1n,
						isPublic: false,
						completionClaimToken: ownerToken,
					},
					{
						bucket: protectedBucket,
						reason: 'replace-game',
						playbackReason: 'replace-playback',
					},
				)).rejects.toThrow('Game upload completion claim is no longer active');
				const deployment = createWebglDeploymentKeys(projectId, randomUUID());
				await expect(owner.finalizeCompletedWebglSession(
					session.id,
					projectId,
					deployment.entryKey,
					deployment.sourceKey,
					{
						publicBucket,
						protectedBucket,
						reason: 'replace-webgl',
					},
					ownerToken,
					{
						status: 'COMPLETED',
						sessionId: session.id,
						generation: 1,
						sizeBytes: 1,
						uploadKind: 'WEBGL',
						webglUrl: 'https://ticket-012.assets.test/webgl/index.html',
					},
				)).rejects.toThrow('WebGL upload completion claim is no longer active');

				const recoveryOutcomes = await Promise.all([
					owner.claimStaleCompletingSessions(
						new Date('2000-01-01T00:00:00.000Z'),
						competingRecoveryToken,
						2 * 60_000,
						50,
					),
					recovery.claimStaleCompletingSessions(
						new Date('2000-01-01T00:00:00.000Z'),
						recoveryToken,
						2 * 60_000,
						50,
					),
				]);
				expect(recoveryOutcomes.flat().filter(({ id }) => id === session.id)).toHaveLength(1);
				const recovered = await control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				});
				const winningRecoveryToken = recovered.completionClaimToken!;
				const winningRecoveryRepository = winningRecoveryToken === recoveryToken
					? recovery
					: owner;
				await expect(owner.revertToPending(session.id, ownerToken))
					.resolves.toEqual({ count: 0 });
				await expect(winningRecoveryRepository.revertToPending(
					session.id,
					winningRecoveryToken,
				))
					.resolves.toEqual({ count: 1 });
			} finally {
				await runCleanupSteps([
					() => control.orphanObject.deleteMany({ where: { bucket: protectedBucket, storageKey: key } }),
					() => control.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } }),
					() => control.gameUploadSession.deleteMany({ where: { id: session.id } }),
				]);
			}
		});

		it('re-checks expiration with the database clock after waiting on the project lock', async () => {
			const expiresAt = new Date(Date.now() + 800);
			const session = await createSessionFixture({
				s3Key: `${testId}-expires-while-locked.zip`,
				expiresAt,
			});
			const repository = createGameUploadRepository(control, { abortBucket: protectedBucket });
			let releaseProjectLock!: () => void;
			let reportProjectLock!: () => void;
			const projectLocked = new Promise<void>((resolve) => { reportProjectLock = resolve; });
			const release = new Promise<void>((resolve) => { releaseProjectLock = resolve; });
			const blocker = recoveryClient.$transaction(async (tx) => {
				await tx.$queryRaw`
					SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE
				`;
				reportProjectLock();
				await release;
			});
			try {
				await projectLocked;
				let settled = false;
				const claim = repository.claimCompletion({
					sessionId: session.id,
					generation: 1,
					token: randomUUID(),
					leaseMs: 60_000,
				}).finally(() => { settled = true; });
				await new Promise((resolve) => setTimeout(resolve, 100));
				expect(settled).toBe(false);
				await new Promise((resolve) => setTimeout(
					resolve,
					Math.max(0, expiresAt.getTime() - Date.now() + 50),
				));
				releaseProjectLock();
				await blocker;
				await expect(claim).resolves.toEqual({ count: 0, reason: 'state' });
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).resolves.toMatchObject({ status: 'PENDING', completionClaimToken: null });
			} finally {
				releaseProjectLock();
				await blocker.catch(() => undefined);
				await runCleanupSteps([
					() => control.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } }),
					() => control.gameUploadSession.deleteMany({ where: { id: session.id } }),
				]);
			}
		});

		it('allows one actual concurrent complete winner through the CAS', async () => {
			const key = `${testId}-concurrent.zip`;
			const uploadId = randomUUID();
			const session = await createSessionFixture({
				s3Key: key,
				s3UploadId: uploadId,
				totalBytes: 1n,
			});
			storage.seedMultipart(
				protectedBucket,
				key,
				uploadId,
				1,
				Buffer.from([0x00]),
			);
			const databaseUrl = process.env['DATABASE_URL'];
			if (!databaseUrl) throw new Error('DATABASE_URL is required');
			const suffix = session.id.replaceAll('-', '_');
			const firstApplication = `ticket012-cas-first-${suffix.slice(0, 12)}`;
			const secondApplication = `ticket012-cas-second-${suffix.slice(0, 12)}`;
			const firstClient = createPrismaClientForDatabase(
				databaseUrlWithApplicationName(databaseUrl, firstApplication),
			);
			const secondClient = createPrismaClientForDatabase(
				databaseUrlWithApplicationName(databaseUrl, secondApplication),
			);
			const blockerClient = createPrismaClientForDatabase(
				databaseUrlWithApplicationName(
					databaseUrl,
					`ticket012-cas-blocker-${suffix.slice(0, 12)}`,
				),
			);
			const lockKey = 12_012_012;
			const functionName = `ticket_012_cas_${suffix}`;
			const triggerName = `${functionName}_trigger`;
			const quotedFunction = sqlIdentifier(functionName);
			const quotedTrigger = sqlIdentifier(triggerName);
			type Activity = {
				pid: number;
				state: string;
				waitEventType: string | null;
				waitEvent: string | null;
				query: string;
				applicationName: string;
			};
			let observed: Activity[] = [];
			let functionCreated = false;
			let triggerCreated = false;
			let lockHeld = false;
			let operations: Promise<unknown>[] = [];
			try {
				await Promise.all([
					firstClient.$connect(),
					secondClient.$connect(),
					blockerClient.$connect(),
				]);
				await control.$executeRawUnsafe(`
					CREATE FUNCTION ${quotedFunction}() RETURNS trigger
					LANGUAGE plpgsql AS $ticket_012$
					BEGIN
						IF OLD.status = 'PENDING'
							AND NEW.status = 'COMPLETING'
							AND NEW.id = ${sqlLiteral(session.id)}
						THEN
							PERFORM pg_advisory_xact_lock(${lockKey});
						END IF;
						RETURN NEW;
					END
					$ticket_012$
				`);
				functionCreated = true;
				await control.$executeRawUnsafe(`
					CREATE TRIGGER ${quotedTrigger}
					BEFORE UPDATE ON "game_upload_sessions"
					FOR EACH ROW EXECUTE FUNCTION ${quotedFunction}()
				`);
				triggerCreated = true;
				await blockerClient.$queryRawUnsafe<Array<{ locked: boolean }>>(
					`SELECT pg_advisory_lock(${lockKey}) IS NULL AS locked`,
				);
				lockHeld = true;

				const firstGraph = graph(firstClient);
				const secondGraph = graph(secondClient);
				operations = [
					firstGraph.service.completeSession(
						session.id,
						{ id: userId, role: 'ADMIN' },
						{ generation: 1, parts: [{ partNumber: 1, etag: 'etag-1', sizeBytes: 1 }] },
					),
					secondGraph.service.completeSession(
						session.id,
						{ id: userId, role: 'ADMIN' },
						{ generation: 1, parts: [{ partNumber: 1, etag: 'etag-1', sizeBytes: 1 }] },
					),
				];
				await vi.waitFor(async () => {
					observed = await control.$queryRaw<Activity[]>`
						SELECT
							pid::int AS pid,
							state,
							wait_event_type AS "waitEventType",
							wait_event AS "waitEvent",
							query,
							application_name AS "applicationName"
						FROM pg_stat_activity
						WHERE application_name IN (${firstApplication}, ${secondApplication})
							AND state = 'active'
							AND wait_event_type = 'Lock'
							AND (
								query ILIKE '%UPDATE%game_upload_sessions%'
								OR (query ILIKE '%FROM "projects"%' AND query ILIKE '%FOR UPDATE%')
							)
					`;
					expect(observed).toHaveLength(2);
					expect(
						new Set(observed.map(({ applicationName }) => applicationName)),
					).toEqual(new Set([firstApplication, secondApplication]));
					expect(new Set(observed.map(({ pid }) => pid)).size).toBe(2);
					expect(
						observed.some(({ waitEvent }) => waitEvent === 'advisory'),
						JSON.stringify(observed),
					).toBe(true);
				}, { timeout: 10_000, interval: 50 });
				await blockerClient.$queryRawUnsafe<Array<{ unlocked: boolean }>>(
					`SELECT pg_advisory_unlock(${lockKey})`,
				);
				lockHeld = false;

				const outcomes = await Promise.allSettled(operations);
				expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
				const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
				expect(rejected).toHaveLength(1);
				expect(rejected[0]).toMatchObject({
					status: 'rejected',
					reason: expect.objectContaining({ statusCode: 409, code: 'CONFLICT' }),
				});
				expect(storage.calls.completeMultipart).toHaveBeenCalledTimes(1);
				await expect(validationGraph(control).worker.runPass()).resolves.toMatchObject({
					claimed: 1,
					rejected: 1,
				});
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).resolves.toMatchObject({ status: 'REJECTED' });
			} finally {
				if (lockHeld) {
					try {
						await blockerClient.$queryRawUnsafe<Array<{ unlocked: boolean }>>(
							`SELECT pg_advisory_unlock(${lockKey})`,
						);
					} catch {
						// Closing the backend also releases its session-level lock,
						// allowing both blocked UPDATE statements to settle.
						await blockerClient.$disconnect().catch(() => undefined);
					}
				}
				await Promise.allSettled(operations);
				storage.objects.delete(`${protectedBucket}/${key}`);
				await runCleanupSteps([
					...triggerCreated
						? [() => control.$executeRawUnsafe(
								`DROP TRIGGER IF EXISTS ${quotedTrigger} ON "game_upload_sessions"`,
							)]
						: [],
					...functionCreated
						? [() => control.$executeRawUnsafe(
								`DROP FUNCTION IF EXISTS ${quotedFunction}()`,
							)]
						: [],
					() => control.gameUploadActiveSession.deleteMany({
						where: { sessionId: session.id },
					}),
					() => control.gameUploadSession.deleteMany({
						where: { id: session.id },
					}),
					async () => {
						await Promise.allSettled([
							firstClient.$disconnect(),
							secondClient.$disconnect(),
							blockerClient.$disconnect(),
						]);
					},
				]);
			}
		});

		it('blocks parent deletion and an early reaper while Garage Complete is in flight', async () => {
			const isolatedStorage = memoryStorage();
			const archive = makeStoredZip([{ name: 'game/index.html', body: Buffer.from('late-object') }]);
			const source = sourceIdentityForBuffer(archive);
			const service = graph(control, isolatedStorage.storage).service;
			const projectRepository = createProjectCrudRepository(control);
			let releaseComplete!: () => void;
			let reportCompleteEntered!: () => void;
			const completeEntered = new Promise<void>((resolve) => { reportCompleteEntered = resolve; });
			const release = new Promise<void>((resolve) => { releaseComplete = resolve; });
			const baseComplete = isolatedStorage.calls.completeMultipart.getMockImplementation()!;
			isolatedStorage.calls.completeMultipart.mockImplementationOnce(async (
				bucket: string,
				key: string,
				uploadId: string,
			) => {
				reportCompleteEntered();
				await release;
				return baseComplete(bucket, key, uploadId);
			});
			let sessionId: string | undefined;
			let sourceKey: string | undefined;
			let completion: Promise<unknown> | undefined;
			try {
				const created = await service.createSession(
					projectId,
					exhibitionId,
					{ id: userId, role: 'ADMIN' },
					{
						originalName: 'paused-complete.zip',
						totalBytes: archive.length,
						uploadKind: 'GAME',
						sourceIdentityAlgorithm: source.sourceIdentityAlgorithm,
						sourceIdentity: source.sourceIdentity,
						sourceIdentityBlockSizeBytes: source.sourceIdentityBlockSizeBytes,
						sourceIdentityBlockDigests: source.sourceIdentityBlockDigests,
					},
				);
				sessionId = created.sessionId;
				const row = await control.gameUploadSession.findUniqueOrThrow({
					where: { id: created.sessionId },
				});
				sourceKey = row.s3Key!;
				isolatedStorage.seedMultipart(
					protectedBucket,
					sourceKey,
					row.s3UploadId!,
					1,
					archive,
				);
				completion = service.completeSession(
					created.sessionId,
					{ id: userId, role: 'ADMIN' },
					{
						generation: 1,
						parts: [{ partNumber: 1, etag: 'etag-1', sizeBytes: archive.length }],
					},
				);
				await completeEntered;
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: created.sessionId },
				})).resolves.toMatchObject({ status: 'COMPLETING' });
				expect(isolatedStorage.objects.has(`${protectedBucket}/${sourceKey}`)).toBe(false);

				await expect(projectRepository.deleteProjectReturningAssets(projectId, {
					publicBucket,
					protectedBucket,
					reason: 'paused-complete-parent-delete',
				})).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS', statusCode: 409 });
				await expect(control.project.findUnique({ where: { id: projectId } })).resolves.not.toBeNull();

				const orphanRepository = createOrphanRepository(control);
				await orphanRepository.upsertOrphan(
					protectedBucket,
					sourceKey,
					'paused-complete-early-reaper',
					'EXACT',
					new Date(),
				);
				isolatedStorage.calls.delete.mockClear();
				const earlyReaper = await createOrphanService({
					clock: { now: () => new Date() },
					storage: isolatedStorage.storage,
					repository: orphanRepository,
					references: createObjectReferenceResolver(
						control,
						{ publicBucket, protectedBucket },
						{ error: vi.fn() },
					),
					ids: { next: () => 'paused-complete-reaper' },
					logger: { info: vi.fn(), error: vi.fn() },
				}).runOrphanReaper();
				expect(earlyReaper).toMatchObject({ failed: 0 });
				expect(earlyReaper.tried).toBeGreaterThanOrEqual(1);
				expect(isolatedStorage.calls.delete).not.toHaveBeenCalledWith(
					protectedBucket,
					sourceKey,
					expect.anything(),
				);
				await expect(control.orphanObject.findUniqueOrThrow({
					where: {
						orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: sourceKey },
					},
				})).resolves.toMatchObject({
					state: 'CANCELLED',
					cancelReason: 'live-reference-detected',
				});

				releaseComplete();
				await expect(completion).resolves.toMatchObject({ status: 'VERIFYING' });
				await expect(validationGraph(control, isolatedStorage.storage).worker.runPass())
					.resolves.toMatchObject({ claimed: 1, ready: 1 });
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: created.sessionId },
				})).resolves.toMatchObject({ status: 'COMPLETED', storageKey: sourceKey });
				expect(isolatedStorage.objects.has(`${protectedBucket}/${sourceKey}`)).toBe(true);
				await expect(control.asset.count({ where: { storageKey: sourceKey } })).resolves.toBe(1);
			} finally {
				releaseComplete();
				await completion?.catch(() => undefined);
				if (sourceKey) isolatedStorage.objects.delete(`${protectedBucket}/${sourceKey}`);
				if (sessionId) {
					await runCleanupSteps([
						() => control.gameUploadActiveSession.deleteMany({ where: { sessionId } }),
						() => control.asset.deleteMany({ where: { storageKey: sourceKey } }),
						() => control.orphanObject.deleteMany({
							where: { bucket: protectedBucket, storageKey: sourceKey },
						}),
						() => control.gameUploadSession.deleteMany({ where: { id: sessionId } }),
					]);
				}
			}
		});

		it('runs direct multipart through authoritative storage completion and the PostgreSQL verifier', async () => {
			const archive = makeStoredZip([{ name: 'game/index.html', body: Buffer.from('ready') }]);
			const source = sourceIdentityForBuffer(archive);
			const service = graph(control).service;
			let sessionId: string | undefined;
			let sourceKey: string | undefined;
			try {
				const created = await service.createSession(
					projectId,
					exhibitionId,
					{ id: userId, role: 'ADMIN' },
					{
						originalName: 'direct-game.zip',
						totalBytes: archive.length,
						uploadKind: 'GAME',
						sourceIdentityAlgorithm: source.sourceIdentityAlgorithm,
						sourceIdentity: source.sourceIdentity,
						sourceIdentityBlockSizeBytes: source.sourceIdentityBlockSizeBytes,
						sourceIdentityBlockDigests: source.sourceIdentityBlockDigests,
					},
				);
				sessionId = created.sessionId;
				expect(created).toMatchObject({ generation: 1 });
				const row = await control.gameUploadSession.findUniqueOrThrow({
					where: { id: created.sessionId },
				});
				sourceKey = row.s3Key!;
				expect(row).toMatchObject({
					status: 'PENDING',
					multipartGeneration: 1,
				});
				storage.seedMultipart(
					protectedBucket,
					row.s3Key!,
					row.s3UploadId!,
					1,
					archive,
				);

				await expect(service.completeSession(
					created.sessionId,
					{ id: userId, role: 'ADMIN' },
					{
						generation: 1,
						parts: [{ partNumber: 1, etag: 'etag-1', sizeBytes: archive.length }],
					},
				)).resolves.toEqual({
					status: 'VERIFYING',
					sessionId: created.sessionId,
					generation: 1,
					sizeBytes: archive.length,
				});

				await expect(validationGraph(control).worker.runPass()).resolves.toMatchObject({
					claimed: 1,
					ready: 1,
				});
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: created.sessionId },
				})).resolves.toMatchObject({
					status: 'COMPLETED',
					storageKey: row.s3Key,
					s3UploadId: null,
				});
				await expect(control.asset.findFirstOrThrow({
					where: { projectId, kind: 'GAME', storageKey: row.s3Key! },
				})).resolves.toMatchObject({ status: 'READY', isPublic: false });
				await expect(control.gameUploadActiveSession.findUnique({
					where: { projectId_uploadKind: { projectId, uploadKind: 'GAME' } },
				})).resolves.toBeNull();
			} finally {
				if (sourceKey) storage.objects.delete(`${protectedBucket}/${sourceKey}`);
				if (sessionId) {
					await runCleanupSteps([
						() => control.gameUploadActiveSession.deleteMany({ where: { sessionId } }),
						() => control.asset.deleteMany({ where: { storageKey: sourceKey } }),
						() => control.orphanObject.deleteMany({
							where: { bucket: protectedBucket, storageKey: sourceKey },
						}),
						() => control.gameUploadSession.deleteMany({ where: { id: sessionId } }),
					]);
				}
			}
		});

		it('persists one opaque WebGL public prefix across retry and queues exact cleanup on terminal failure', async () => {
			const sourceDeploymentId = randomUUID();
			const sourceKey = `webgl/${projectId}/${sourceDeploymentId}/source.zip`;
			const claimToken = randomUUID();
			const session = await createSessionFixture({
				uploadKind: 'WEBGL',
				status: 'VERIFYING',
				s3Key: sourceKey,
				s3UploadId: null,
				storageKey: sourceKey,
			});
			await control.gameUploadSession.update({
				where: { id: session.id },
				data: {
					completionClaimToken: claimToken,
					completionClaimUntil: new Date(Date.now() + 120_000),
				},
			});
			const repository = createGameUploadRepository(control, {
				abortBucket: protectedBucket,
				publicBucket,
			});
			const firstCandidate = randomUUID();
			const retryCandidate = randomUUID();
			try {
				await expect(repository.reserveWebglDeployment({
					sessionId: session.id,
					completionClaimToken: claimToken,
					candidateDeploymentId: firstCandidate,
				})).resolves.toBe(firstCandidate);
				await expect(repository.reserveWebglDeployment({
					sessionId: session.id,
					completionClaimToken: claimToken,
					candidateDeploymentId: retryCandidate,
				})).resolves.toBe(firstCandidate);
				expect(firstCandidate).not.toBe(sourceDeploymentId);

				await control.gameUploadSession.update({
					where: { id: session.id },
					data: { completionClaimUntil: new Date(0) },
				});
				await expect(repository.reserveWebglDeployment({
					sessionId: session.id,
					completionClaimToken: claimToken,
					candidateDeploymentId: randomUUID(),
				})).rejects.toThrow('claim was lost');

				await control.gameUploadSession.update({
					where: { id: session.id },
					data: { completionClaimUntil: new Date(Date.now() + 120_000) },
				});
				await expect(repository.markCompletedObjectFailed({
					sessionId: session.id,
					storageKey: sourceKey,
					reason: 'opaque-webgl-rejected',
					completionClaimToken: claimToken,
				})).resolves.toEqual({ count: 1 });
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).resolves.toMatchObject({ status: 'REJECTED', webglDeploymentId: firstCandidate });
				await expect(control.gameUploadActiveSession.count({
					where: { sessionId: session.id },
				})).resolves.toBe(0);
				const publicKeys = createWebglPublicDeploymentKeys(projectId, firstCandidate);
				await expect(control.orphanObject.findUnique({
					where: { orphan_bucket_storage_key: { bucket: publicBucket, storageKey: publicKeys.sitePrefix } },
				})).resolves.toMatchObject({ targetKind: 'PREFIX', reason: 'opaque-webgl-rejected-site' });
				await expect(control.orphanObject.findUnique({
					where: { orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: sourceKey } },
				})).resolves.toMatchObject({ targetKind: 'EXACT', reason: 'opaque-webgl-rejected-source' });
			} finally {
				await control.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } });
				await control.orphanObject.deleteMany({
					where: {
						OR: [
							{ bucket: protectedBucket, storageKey: sourceKey },
							{
								bucket: publicBucket,
								storageKey: createWebglPublicDeploymentKeys(projectId, firstCandidate).sitePrefix,
							},
						],
					},
				});
				await control.gameUploadSession.deleteMany({ where: { id: session.id } });
			}
		});

		it.runIf(runStorageIntegration)(
			'connects browser-signed Garage UploadPart to PostgreSQL VERIFYING and READY production wiring',
			async () => {
				const s3Config = {
					S3_INTERNAL_ENDPOINT: process.env['S3_INTERNAL_ENDPOINT']
						?? process.env['S3_ENDPOINT']
						?? 'http://127.0.0.1:3900',
					S3_PUBLIC_SIGNING_ENDPOINT: process.env['S3_PUBLIC_SIGNING_ENDPOINT']
						?? process.env['S3_ENDPOINT']
						?? 'http://localhost:3900',
					S3_REGION: process.env['S3_REGION'] ?? 'garage',
					S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? '',
					S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
					S3_FORCE_PATH_STYLE: true,
				};
				const internal = createS3Client(s3Config);
				const signer = createS3PresigningClient(s3Config);
				const garage = createObjectStorage(internal, {
					defaultPresignTtlSec: 60,
					presigningClient: signer,
				});
				const buckets = {
					publicBucket: process.env['S3_BUCKET_PUBLIC'] ?? 'pcu-public',
					protectedBucket: process.env['S3_BUCKET_PROTECTED'] ?? 'pcu-protected',
				};
				const archive = makeStoredZip([{
					name: 'game/index.html',
					body: Buffer.from('garage-postgres-ready'),
				}]);
				const source = sourceIdentityForBuffer(archive);
				let sessionId: string | undefined;
				let sourceKey: string | undefined;
				let uploadId: string | undefined;
				let completed = false;
				try {
					const service = graph(control, garage, buckets).service;
					const created = await service.createSession(
						projectId,
						exhibitionId,
						{ id: userId, role: 'ADMIN' },
						{
							originalName: 'garage-direct-game.zip',
							totalBytes: archive.length,
							uploadKind: 'GAME',
							sourceIdentityAlgorithm: source.sourceIdentityAlgorithm,
							sourceIdentity: source.sourceIdentity,
							sourceIdentityBlockSizeBytes: source.sourceIdentityBlockSizeBytes,
							sourceIdentityBlockDigests: source.sourceIdentityBlockDigests,
						},
					);
					sessionId = created.sessionId;
					const row = await control.gameUploadSession.findUniqueOrThrow({
						where: { id: created.sessionId },
					});
					sourceKey = row.s3Key!;
					uploadId = row.s3UploadId!;
					const capability = await service.signPartUrls(
						created.sessionId,
						{ id: userId, role: 'ADMIN' },
						{ generation: 1, parts: [{ partNumber: 1, checksumSha256: createHash('sha256').update(archive).digest('base64') }] },
					);
					expect(capability).toMatchObject({
						generation: 1,
						parts: [{ partNumber: 1, requiredHeaders: { 'content-type': 'application/octet-stream' } }],
					});
					const signedPart = capability.parts[0]!;
					const browserPut = await fetch(signedPart.url, {
						method: 'PUT',
						headers: {
							...signedPart.requiredHeaders,
							Origin: 'http://localhost:5173',
						},
						body: archive,
					});
					expect(browserPut.status).toBe(200);
					const stored = await garage.listParts(
						buckets.protectedBucket,
						sourceKey,
						uploadId,
					);
					expect(stored).toEqual([
						expect.objectContaining({ partNumber: 1, sizeBytes: archive.length }),
					]);

					await expect(service.completeSession(
						created.sessionId,
						{ id: userId, role: 'ADMIN' },
						{
							generation: 1,
							parts: [{
								partNumber: 1,
								etag: stored[0]!.etag,
								sizeBytes: stored[0]!.sizeBytes!,
							}],
						},
					)).resolves.toMatchObject({ status: 'VERIFYING' });
					completed = true;
					await expect(validationGraph(control, garage, buckets).worker.runPass())
						.resolves.toMatchObject({ claimed: 1, ready: 1 });
					await vi.waitFor(async () => {
						await expect(control.gameUploadSession.findUniqueOrThrow({
							where: { id: created.sessionId },
						})).resolves.toMatchObject({ status: 'COMPLETED', storageKey: sourceKey });
					}, { timeout: 15_000, interval: 100 });
					await expect(control.asset.findFirstOrThrow({
						where: { projectId, kind: 'GAME', storageKey: sourceKey },
					})).resolves.toMatchObject({ status: 'READY' });
					await expect(garage.head(buckets.protectedBucket, sourceKey))
						.resolves.toMatchObject({ size: archive.length });
				} finally {
					if (sourceKey) {
						if (completed) {
							await garage.delete(buckets.protectedBucket, sourceKey).catch(() => undefined);
						} else if (uploadId) {
							await garage.abortMultipart(
								buckets.protectedBucket,
								sourceKey,
								uploadId,
							).catch(() => undefined);
						}
					}
					if (sessionId) {
						await runCleanupSteps([
							() => control.gameUploadActiveSession.deleteMany({ where: { sessionId } }),
							() => control.asset.deleteMany({ where: { storageKey: sourceKey } }),
							() => control.orphanObject.deleteMany({
								where: { bucket: buckets.protectedBucket, storageKey: sourceKey },
							}),
							() => control.gameUploadSession.deleteMany({ where: { id: sessionId } }),
						]);
					}
					garage.close?.();
					internal.destroy();
				}
			},
		);

		it.runIf(runStorageIntegration)(
			'connects browser-signed Garage UploadPart to WebGL validation and immutable public deployment',
			async () => {
				const s3Config = {
					S3_INTERNAL_ENDPOINT: process.env['S3_INTERNAL_ENDPOINT']
						?? process.env['S3_ENDPOINT']
						?? 'http://127.0.0.1:3900',
					S3_PUBLIC_SIGNING_ENDPOINT: process.env['S3_PUBLIC_SIGNING_ENDPOINT']
						?? process.env['S3_ENDPOINT']
						?? 'http://localhost:3900',
					S3_REGION: process.env['S3_REGION'] ?? 'garage',
					S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? '',
					S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
					S3_FORCE_PATH_STYLE: true,
				};
				const internal = createS3Client(s3Config);
				const signer = createS3PresigningClient(s3Config);
				const garage = createObjectStorage(internal, {
					defaultPresignTtlSec: 60,
					presigningClient: signer,
				});
				const buckets = {
					publicBucket: process.env['S3_BUCKET_PUBLIC'] ?? 'pcu-public',
					protectedBucket: process.env['S3_BUCKET_PROTECTED'] ?? 'pcu-protected',
				};
				const archive = makeStoredZip([
					{ name: 'index.html', body: Buffer.from('<html>garage webgl ready</html>') },
					{ name: 'Build/game.loader.js', body: Buffer.from('loader') },
					{ name: 'Build/game.framework.js', body: Buffer.from('framework') },
					{ name: 'Build/game.wasm', body: Buffer.from([0, 97, 115, 109]) },
					{ name: 'Build/game.data', body: Buffer.from('data') },
				]);
				const source = sourceIdentityForBuffer(archive);
				let sessionId: string | undefined;
				let sourceKey: string | undefined;
				let uploadId: string | undefined;
				let sourceDeployment: ReturnType<typeof parseWebglSourceKey> = null;
				let deployment: ReturnType<typeof createWebglPublicDeploymentKeys> | null = null;
				let productionGraph: GameUploadProductionGraph | undefined;
				let multipartCompleted = false;
				const previousProject = await control.project.findUniqueOrThrow({
					where: { id: projectId },
					select: { webglEntryKey: true },
				});
				try {
					await control.project.update({
						where: { id: projectId },
						data: { webglEntryKey: '' },
					});
					productionGraph = graph(control, garage, buckets);
					const service = productionGraph.service;
					const created = await service.createSession(
						projectId,
						exhibitionId,
						{ id: userId, role: 'ADMIN' },
						{
							originalName: 'garage-direct-webgl.zip',
							totalBytes: archive.length,
							uploadKind: 'WEBGL',
							sourceIdentityAlgorithm: source.sourceIdentityAlgorithm,
							sourceIdentity: source.sourceIdentity,
							sourceIdentityBlockSizeBytes: source.sourceIdentityBlockSizeBytes,
							sourceIdentityBlockDigests: source.sourceIdentityBlockDigests,
						},
					);
					sessionId = created.sessionId;
					const row = await control.gameUploadSession.findUniqueOrThrow({
						where: { id: created.sessionId },
					});
					sourceKey = row.s3Key!;
					uploadId = row.s3UploadId!;
					sourceDeployment = parseWebglSourceKey(projectId, sourceKey);
					expect(sourceDeployment).not.toBeNull();

					const capability = await service.signPartUrls(
						created.sessionId,
						{ id: userId, role: 'ADMIN' },
						{ generation: 1, parts: [{ partNumber: 1, checksumSha256: createHash('sha256').update(archive).digest('base64') }] },
					);
					const signedPart = capability.parts[0]!;
					const browserPut = await fetch(signedPart.url, {
						method: 'PUT',
						headers: {
							...signedPart.requiredHeaders,
							Origin: 'http://localhost:5173',
						},
						body: archive,
					});
					expect(browserPut.status).toBe(200);
					const stored = await garage.listParts(
						buckets.protectedBucket,
						sourceKey,
						uploadId,
					);
					expect(stored).toEqual([
						expect.objectContaining({ partNumber: 1, sizeBytes: archive.length }),
					]);
					await expect(control.project.findUniqueOrThrow({
						where: { id: projectId },
					})).resolves.toMatchObject({ webglEntryKey: '' });

					const completion = await service.completeSession(
						created.sessionId,
						{ id: userId, role: 'ADMIN' },
						{
							generation: 1,
							parts: [{
								partNumber: 1,
								etag: stored[0]!.etag,
								sizeBytes: stored[0]!.sizeBytes!,
							}],
						},
					);
					expect(completion).toMatchObject({ status: 'VERIFYING' });
					multipartCompleted = true;
					await expect(validationGraph(control, garage, buckets).worker.runPass())
						.resolves.toMatchObject({ claimed: 1, ready: 1 });

					await vi.waitFor(async () => {
						const completedSession = await control.gameUploadSession.findUniqueOrThrow({
							where: { id: created.sessionId },
						});
						expect(completedSession).toMatchObject({
							status: 'COMPLETED',
							storageKey: sourceKey,
							s3UploadId: null,
						});
						expect(completedSession.webglDeploymentId).toEqual(expect.any(String));
					}, { timeout: 15_000, interval: 100 });
					const completedSession = await control.gameUploadSession.findUniqueOrThrow({
						where: { id: created.sessionId },
					});
					deployment = createWebglPublicDeploymentKeys(
						projectId,
						completedSession.webglDeploymentId!,
					);
					expect(deployment!.deploymentId).not.toBe(sourceDeployment!.deploymentId);

					await expect(control.project.findUniqueOrThrow({
						where: { id: projectId },
					})).resolves.toMatchObject({ webglEntryKey: deployment!.entryKey });
					for (const key of [
						deployment!.entryKey,
						`${deployment!.sitePrefix}Build/game.loader.js`,
						`${deployment!.sitePrefix}Build/game.framework.js`,
						`${deployment!.sitePrefix}Build/game.wasm`,
						`${deployment!.sitePrefix}Build/game.data`,
					]) {
						await expect(garage.head(buckets.publicBucket, key)).resolves.not.toBeNull();
					}
					await expect(garage.head(buckets.protectedBucket, sourceKey))
						.resolves.toMatchObject({ size: archive.length });
				} finally {
					const graphToClose = productionGraph;
					const sessionToDelete = sessionId;
					const sourceToDelete = sourceKey;
					const uploadToAbort = uploadId;
					const deploymentToDelete = deployment;
					try {
						await runCleanupSteps([
							...(graphToClose ? [() => graphToClose.close()] : []),
							() => control.project.update({
								where: { id: projectId },
								data: { webglEntryKey: previousProject.webglEntryKey },
							}),
							...sessionToDelete
								? [
									() => control.gameUploadActiveSession.deleteMany({
										where: { sessionId: sessionToDelete },
									}),
									() => control.orphanObject.deleteMany({
										where: {
											OR: [
												...(sourceToDelete ? [{
													bucket: buckets.protectedBucket,
													storageKey: sourceToDelete,
												}] : []),
												...(deploymentToDelete ? [{
													bucket: buckets.publicBucket,
													storageKey: deploymentToDelete.sitePrefix,
												}] : []),
											],
										},
									}),
									() => control.gameUploadSession.deleteMany({
										where: { id: sessionToDelete },
									}),
								]
								: [],
							...(!multipartCompleted && sourceToDelete && uploadToAbort
								? [() => garage.abortMultipart(
									buckets.protectedBucket,
									sourceToDelete,
									uploadToAbort,
								).catch(() => undefined)]
								: []),
							...(deploymentToDelete
								? [async () => {
									const publicKeys = await garage.listKeys(
										buckets.publicBucket,
										deploymentToDelete.sitePrefix,
									);
									if (publicKeys.length > 0) {
										const deleted = await garage.deleteKeys(
											buckets.publicBucket,
											publicKeys,
										);
										expect(deleted.failures).toEqual([]);
									}
									await expect(garage.listKeys(
										buckets.publicBucket,
										deploymentToDelete.sitePrefix,
									)).resolves.toEqual([]);
								}]
								: []),
							...(sourceToDelete
								? [async () => {
									await garage.delete(buckets.protectedBucket, sourceToDelete);
									await expect(garage.head(buckets.protectedBucket, sourceToDelete))
										.resolves.toBeNull();
								}]
								: []),
						]);
					} finally {
						garage.close?.();
						internal.destroy();
					}
				}
			},
		);

		it('claims one VERIFYING row exactly once across PostgreSQL workers', async () => {
			const archive = makeStoredZip([{ name: 'game/index.html' }]);
			const key = `${testId}-duplicate-verifier.zip`;
			const session = await createSessionFixture({
				status: 'VERIFYING',
				s3Key: key,
				storageKey: key,
				s3UploadId: null,
				sourceBytes: archive,
			});
			const first = createGameUploadRepository(control, { abortBucket: protectedBucket });
			const second = createGameUploadRepository(recoveryClient, { abortBucket: protectedBucket });
			const firstToken = randomUUID();
			const secondToken = randomUUID();
			try {
				const [firstClaim, secondClaim] = await Promise.all([
					first.claimVerifyingSessions(firstToken, 60_000, 1),
					second.claimVerifyingSessions(secondToken, 60_000, 1),
				]);
				expect(firstClaim.length + secondClaim.length).toBe(1);
				const winner = firstClaim.length === 1
					? { repository: first, token: firstToken }
					: { repository: second, token: secondToken };
				await expect(winner.repository.releaseCompletionClaim(
					session.id,
					winner.token,
					'test-release',
				)).resolves.toEqual({ count: 1 });
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).resolves.toMatchObject({ status: 'VERIFYING', completionClaimToken: null });
			} finally {
				await runCleanupSteps([
					() => control.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } }),
					() => control.gameUploadSession.deleteMany({ where: { id: session.id } }),
				]);
			}
		});

		it('rejects a verifier when the session actor loses current project access', async () => {
			const archive = makeStoredZip([{ name: 'game/index.html', body: Buffer.from('denied') }]);
			const key = `${testId}-removed-before-finalize.zip`;
			const replacementCreator = await control.user.create({
				data: {
					googleSub: `ticket-012-replacement-${randomUUID()}`,
					email: `ticket-012-replacement-${randomUUID()}@example.test`,
					name: 'Replacement creator',
					role: 'USER',
				},
			});
			const session = await createSessionFixture({
				status: 'VERIFYING',
				s3Key: key,
				storageKey: key,
				s3UploadId: null,
				sourceBytes: archive,
			});
			storage.put(protectedBucket, key, archive);
			try {
				await control.user.update({ where: { id: userId }, data: { role: 'USER' } });
				await control.project.update({
					where: { id: projectId },
					data: { creatorId: replacementCreator.id },
				});
				await control.projectMember.deleteMany({ where: { projectId, userId } });

				await expect(validationGraph(control).worker.runPass()).resolves.toEqual({
					claimed: 1,
					ready: 0,
					rejected: 1,
					retried: 0,
				});
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).resolves.toMatchObject({ status: 'REJECTED' });
				await expect(control.asset.count({ where: { storageKey: key } })).resolves.toBe(0);
				await expect(control.orphanObject.findUniqueOrThrow({
					where: { orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: key } },
				})).resolves.toMatchObject({ state: 'PENDING' });
			} finally {
				await control.project.update({ where: { id: projectId }, data: { creatorId: userId } });
				await control.user.update({ where: { id: userId }, data: { role: 'ADMIN' } });
				storage.objects.delete(`${protectedBucket}/${key}`);
				await runCleanupSteps([
					() => control.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } }),
					() => control.orphanObject.deleteMany({
						where: { bucket: protectedBucket, storageKey: key },
					}),
					() => control.gameUploadSession.deleteMany({ where: { id: session.id } }),
					() => control.user.deleteMany({ where: { id: replacementCreator.id } }),
				]);
			}
		});

		it('rejects a verifier when exhibition uploads are disabled after completion', async () => {
			const archive = makeStoredZip([{ name: 'game/index.html', body: Buffer.from('disabled') }]);
			const key = `${testId}-disabled-before-finalize.zip`;
			const session = await createSessionFixture({
				status: 'VERIFYING',
				s3Key: key,
				storageKey: key,
				s3UploadId: null,
				sourceBytes: archive,
			});
			storage.put(protectedBucket, key, archive);
			try {
				await control.user.update({ where: { id: userId }, data: { role: 'USER' } });
				await control.exhibition.update({
					where: { id: exhibitionId },
					data: { isUploadEnabled: false },
				});

				await expect(validationGraph(control).worker.runPass()).resolves.toEqual({
					claimed: 1,
					ready: 0,
					rejected: 1,
					retried: 0,
				});
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).resolves.toMatchObject({ status: 'REJECTED' });
				await expect(control.asset.count({ where: { storageKey: key } })).resolves.toBe(0);
			} finally {
				await control.exhibition.update({
					where: { id: exhibitionId },
					data: { isUploadEnabled: true },
				});
				await control.user.update({ where: { id: userId }, data: { role: 'ADMIN' } });
				storage.objects.delete(`${protectedBucket}/${key}`);
				await runCleanupSteps([
					() => control.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } }),
					() => control.orphanObject.deleteMany({
						where: { bucket: protectedBucket, storageKey: key },
					}),
					() => control.gameUploadSession.deleteMany({ where: { id: session.id } }),
				]);
			}
		});

		it('rolls back terminal state and preserves the object when atomic outbox persistence fails', async () => {
			const key = `${testId}-double-failure.zip`;
			const uploadId = randomUUID();
			const session = await createSessionFixture({
				s3Key: key,
				s3UploadId: uploadId,
				totalBytes: 1n,
			});
			storage.seedMultipart(
				protectedBucket,
				key,
				uploadId,
				1,
				Buffer.from([0x00]),
			);
			await control.orphanObject.deleteMany({
				where: { bucket: protectedBucket, storageKey: key },
			});

			const suffix = session.id.replaceAll('-', '_');
			const functionName = `ticket_012_orphan_${suffix}`;
			const triggerName = `${functionName}_trigger`;
			const quotedFunction = sqlIdentifier(functionName);
			const quotedTrigger = sqlIdentifier(triggerName);
			let functionCreated = false;
			let triggerCreated = false;
			let failure: unknown;
			try {
				await control.$executeRawUnsafe(`
					CREATE FUNCTION ${quotedFunction}() RETURNS trigger
					LANGUAGE plpgsql AS $ticket_012$
					BEGIN
						IF NEW.bucket = ${sqlLiteral(protectedBucket)}
							AND NEW.storage_key = ${sqlLiteral(key)}
						THEN
							RAISE EXCEPTION 'ticket-012 forced orphan write failure';
						END IF;
						RETURN NEW;
					END
					$ticket_012$
				`);
				functionCreated = true;
				await control.$executeRawUnsafe(`
					CREATE TRIGGER ${quotedTrigger}
					BEFORE INSERT OR UPDATE ON "orphan_objects"
					FOR EACH ROW EXECUTE FUNCTION ${quotedFunction}()
				`);
				triggerCreated = true;
				storage.calls.delete.mockClear();
				storage.failDelete();
				await graph(control).service.completeSession(
						session.id,
						{ id: userId, role: 'ADMIN' },
						{ generation: 1, parts: [{ partNumber: 1, etag: 'etag-1', sizeBytes: 1 }] },
					);
				try {
					await validationGraph(control).worker.runPass();
				} catch (error) {
					failure = error;
				}

				expect(String(failure)).toContain('ticket-012 forced orphan write failure');
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).resolves.toMatchObject({
					status: 'VERIFYING',
					storageKey: key,
				});
				await expect(control.gameUploadActiveSession.findUnique({
					where: {
						projectId_uploadKind: { projectId, uploadKind: 'GAME' },
					},
				})).resolves.toMatchObject({ sessionId: session.id });
				await expect(control.orphanObject.count({
					where: { bucket: protectedBucket, storageKey: key },
				})).resolves.toBe(0);
				expect(storage.calls.delete).not.toHaveBeenCalled();
				expect(storage.objects.has(`${protectedBucket}/${key}`)).toBe(true);
			} finally {
				storage.restoreDelete();
				storage.objects.delete(`${protectedBucket}/${key}`);
				await runCleanupSteps([
					...triggerCreated
						? [() => control.$executeRawUnsafe(
								`DROP TRIGGER IF EXISTS ${quotedTrigger} ON "orphan_objects"`,
							)]
						: [],
					...functionCreated
						? [() => control.$executeRawUnsafe(
								`DROP FUNCTION IF EXISTS ${quotedFunction}()`,
							)]
						: [],
					() => control.orphanObject.deleteMany({
						where: { bucket: protectedBucket, storageKey: key },
					}),
					() => control.gameUploadActiveSession.deleteMany({
						where: { sessionId: session.id },
					}),
					() => control.gameUploadSession.deleteMany({
						where: { id: session.id },
					}),
				]);
			}
		});

		it('preserves source on pointer failure and recovers with a fresh graph/client', async () => {
			const deployment = createWebglDeploymentKeys(projectId, randomUUID());
			const archive = makeStoredZip([
				{ name: 'index.html', body: Buffer.from('<html>ticket 012</html>') },
				{ name: 'Build/game.loader.js', body: Buffer.from('loader') },
				{ name: 'Build/game.framework.js', body: Buffer.from('framework') },
				{ name: 'Build/game.wasm', body: Buffer.from([0, 97, 115, 109]) },
				{ name: 'Build/game.data', body: Buffer.from('data') },
			]);
			storage.put(protectedBucket, deployment.sourceKey, archive);
			const session = await createSessionFixture({
				uploadKind: 'WEBGL',
				status: 'COMPLETING',
				s3Key: deployment.sourceKey,
				sourceBytes: archive,
				updatedAt: new Date('2098-07-31T00:00:00.000Z'),
			});
			const pointerFailure = new Error('forced DB pointer failure');
			const firstGraph = graph(pointerFaultClient(control, pointerFailure));

			await firstGraph.recoverStaleUploads();
			await expect(control.gameUploadSession.findUniqueOrThrow({
				where: { id: session.id },
			})).resolves.toMatchObject({ status: 'VERIFYING' });
			expect(storage.objects.has(`${protectedBucket}/${deployment.sourceKey}`)).toBe(true);
			const firstValidation = validationGraph(pointerFaultClient(control, pointerFailure));
			await firstValidation.worker.runPass();
			const reserved = await control.gameUploadSession.findUniqueOrThrow({
				where: { id: session.id },
			});
			expect(reserved.status).toBe('VERIFYING');
			expect(reserved.webglDeploymentId).toMatch(/^[0-9a-f-]{36}$/);
			expect(reserved.webglDeploymentId).not.toBe(deployment.deploymentId);
			expect(
				[...storage.objects.keys()]
					.some((key) => key.startsWith(
						`${publicBucket}/webgl/${projectId}/${reserved.webglDeploymentId}/site/`,
					)),
			).toBe(true);
			await firstGraph.close();

			const secondValidation = validationGraph(recoveryClient);
			await secondValidation.worker.runPass();
			await expect(control.gameUploadSession.findUniqueOrThrow({
				where: { id: session.id },
			})).resolves.toMatchObject({
				status: 'COMPLETED',
				storageKey: deployment.sourceKey,
			});
			await expect(control.project.findUniqueOrThrow({
				where: { id: projectId },
			})).resolves.toMatchObject({
				webglEntryKey: `webgl/${projectId}/${reserved.webglDeploymentId}/site/index.html`,
			});
			await expect(control.gameUploadActiveSession.findUnique({
				where: {
					projectId_uploadKind: { projectId, uploadKind: 'WEBGL' },
				},
			})).resolves.toBeNull();
			expect(storage.objects.has(`${protectedBucket}/${deployment.sourceKey}`)).toBe(true);
			const publicPrefix = `${publicBucket}/webgl/${projectId}/${reserved.webglDeploymentId}/site/`;
			expect(
				[...storage.objects.keys()].filter((key) => key.startsWith(publicPrefix)).sort(),
			).toEqual([
				`${publicPrefix}Build/game.data`,
				`${publicPrefix}Build/game.framework.js`,
				`${publicPrefix}Build/game.loader.js`,
				`${publicPrefix}Build/game.wasm`,
				`${publicPrefix}index.html`,
			]);
		});
	},
);
