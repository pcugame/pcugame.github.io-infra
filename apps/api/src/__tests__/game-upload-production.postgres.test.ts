import { randomUUID } from 'node:crypto';
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
import { createUploadLifecycleMetrics } from '../lib/upload-lifecycle-metrics.js';
import {
	createGameUploadProductionGraph,
	type GameUploadProductionGraph,
} from '../modules/admin/game-upload/composition.js';
import { createGameUploadRepository } from '../modules/admin/game-upload/repository.js';
import {
	createProductionUploadLifecycleRuntime,
	type UploadLifecycleRuntime,
} from '../modules/upload-lifecycle/runtime.js';
import { createProjectAccessRepository } from '../modules/admin/project-access.repository.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createWebglDeploymentKeys } from '../modules/webgl/paths.js';
import { createUploadLimiter } from '../shared/upload-limits.js';
import { defaultTestEnv } from './helpers/app-mocks.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

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
				.map((partNumber) => ({ partNumber, etag: `etag-${partNumber}` }));
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

		function graph(client: PrismaClient): GameUploadProductionGraph {
			const access = createProjectAccessService(
				createProjectAccessRepository(client),
			);
			const uploadLifecycle = productionRuntime(client);
			const value = createGameUploadProductionGraph({
				config: {
					...defaultTestEnv,
					API_PUBLIC_URL: 'https://ticket-012.api.test',
					S3_BUCKET_PUBLIC: publicBucket,
					S3_BUCKET_PROTECTED: protectedBucket,
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

		function productionRuntime(client: PrismaClient): UploadLifecycleRuntime {
			const runtime = createProductionUploadLifecycleRuntime({
				config: {
					S3_BUCKET_PUBLIC: publicBucket,
					S3_BUCKET_PROTECTED: protectedBucket,
				},
				prisma: client,
				storage: storage.storage,
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
			s3UploadId?: string;
			totalBytes?: bigint;
			updatedAt?: Date;
		}) {
			const session = await control.gameUploadSession.create({
				data: {
					id: input.id ?? randomUUID(),
					projectId,
					userId,
					uploadKind: input.uploadKind ?? 'GAME',
					originalName: input.uploadKind === 'WEBGL' ? 'build.zip' : 'game.zip',
					totalBytes: input.totalBytes ?? 1n,
					chunkSizeBytes: Number(input.totalBytes ?? 1n),
					totalChunks: 1,
					status: input.status ?? 'PENDING',
					s3Key: input.s3Key,
					s3UploadId: input.s3UploadId ?? randomUUID(),
					expiresAt: new Date('2099-01-01T00:00:00.000Z'),
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

			await expect(service.createSession(
				projectId,
				exhibitionId,
				{ id: userId, role: 'ADMIN' },
				{ originalName: 'replacement.zip', totalBytes: 1 },
			)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
			await expect(control.gameUploadSession.findUniqueOrThrow({
				where: { id: completing.id },
			})).resolves.toMatchObject({ status: 'COMPLETING' });
			await expect(control.gameUploadActiveSession.findUniqueOrThrow({
				where: {
					projectId_uploadKind: { projectId, uploadKind: 'GAME' },
				},
			})).resolves.toMatchObject({ sessionId: completing.id });
			expect(storage.calls.abortMultipart).toHaveBeenCalled();

			await control.gameUploadActiveSession.deleteMany({
				where: { sessionId: completing.id },
			});
			await control.gameUploadSession.delete({ where: { id: completing.id } });
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

			try {
				const result = await runtime.gameUploads.createSessionReplacingActive({
					id: newSessionId,
					projectId,
					userId,
					uploadKind: 'GAME',
					originalName: 'replacement.zip',
					totalBytes: 1n,
					chunkSizeBytes: 1,
					totalChunks: 1,
					s3UploadId: randomUUID(),
					s3Key: newKey,
					expiresAt: new Date('2099-01-01T00:00:00.000Z'),
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
					chunkSizeBytes: 1,
					totalChunks: 1,
					s3UploadId: randomUUID(),
					s3Key: `${testId}-replace-rollback-new.zip`,
					expiresAt: new Date('2099-01-01T00:00:00.000Z'),
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

		it('serializes part claimants with DB deadlines and fences an expired multipart generation', async () => {
			const key = `${testId}-part-lease-clock.zip`;
			const oldUploadId = randomUUID();
			const session = await createSessionFixture({ s3Key: key, s3UploadId: oldUploadId });
			const first = createGameUploadRepository(control, { abortBucket: protectedBucket });
			const second = createGameUploadRepository(recoveryClient, { abortBucket: protectedBucket });
			const firstToken = randomUUID();
			const secondToken = randomUUID();

			try {
				const outcomes = await Promise.all([
					first.acquirePartClaim({
						sessionId: session.id,
						partNumber: 1,
						generation: 1,
						token: firstToken,
						owner: 'clock-skew-future-worker',
						leaseMs: 2 * 60_000,
					}),
					second.acquirePartClaim({
						sessionId: session.id,
						partNumber: 1,
						generation: 1,
						token: secondToken,
						owner: 'clock-skew-past-worker',
						leaseMs: 2 * 60_000,
					}),
				]);
				expect(outcomes.filter(({ kind }) => kind === 'acquired')).toHaveLength(1);
				expect(outcomes.filter(({ kind }) => kind === 'busy')).toHaveLength(1);
				const claim = await control.gameUploadPartClaim.findFirstOrThrow({
					where: { sessionId: session.id, partNumber: 1 },
				});
				await expect(second.replaceMultipartGeneration({
					sessionId: session.id,
					expectedGeneration: 1,
					newUploadId: randomUUID(),
					reason: 'must-not-revoke-live-part-claim',
				})).resolves.toEqual({ replaced: false, durableAbort: null });
				await expect(control.gameUploadPartClaim.findUnique({ where: { id: claim.id } }))
					.resolves.toMatchObject({ token: claim.token, generation: 1 });
				const [partDatabaseTime] = await control.$queryRaw<Array<{ now: Date }>>`
					SELECT clock_timestamp() AS "now"
				`;
				const partLeaseRemaining = claim.leaseUntil.getTime() - partDatabaseTime!.now.getTime();
				expect(partLeaseRemaining).toBeGreaterThan(60_000);
				expect(partLeaseRemaining).toBeLessThan(3 * 60_000);
				const winningRepository = claim.token === firstToken ? first : second;

				await expect(first.renewPartClaim('wrong-token', 5 * 60_000))
					.resolves.toEqual({ count: 0 });
				await expect(winningRepository.renewPartClaim(claim.token, 5 * 60_000))
					.resolves.toEqual({ count: 1 });
				const renewed = await control.gameUploadPartClaim.findUniqueOrThrow({
					where: { id: claim.id },
				});
				expect(renewed.leaseUntil.getTime())
					.toBeGreaterThan(claim.leaseUntil.getTime() + 2 * 60_000);

				await control.gameUploadPartClaim.update({
					where: { id: claim.id },
					data: { leaseUntil: new Date(0) },
				});
				await expect(winningRepository.renewPartClaim(claim.token, 5 * 60_000))
					.resolves.toEqual({ count: 0 });
				await expect(winningRepository.completePartClaim({
					token: claim.token,
					etag: 'stale-etag',
				})).resolves.toEqual({ accepted: false, parts: [] });
				await expect(second.acquirePartClaim({
					sessionId: session.id,
					partNumber: 1,
					generation: 1,
					token: randomUUID(),
					owner: 'post-expiry-worker',
					leaseMs: 2 * 60_000,
				})).resolves.toEqual({ kind: 'expired' });

				const newUploadId = randomUUID();
				await expect(second.replaceMultipartGeneration({
					sessionId: session.id,
					expectedGeneration: 1,
					newUploadId,
					reason: 'db-expired-part-claim-reset',
				})).resolves.toMatchObject({ replaced: true });
				const nextToken = randomUUID();
				await expect(second.acquirePartClaim({
					sessionId: session.id,
					partNumber: 1,
					generation: 2,
					token: nextToken,
					owner: 'new-generation-worker',
					leaseMs: 2 * 60_000,
				})).resolves.toEqual({ kind: 'acquired', token: nextToken });
				await expect(second.completePartClaim({ token: nextToken, etag: 'etag-generation-2' }))
					.resolves.toMatchObject({ accepted: true });
				await expect(control.gameUploadPart.findUniqueOrThrow({
					where: {
						game_upload_part_session_part: { sessionId: session.id, partNumber: 1 },
					},
				})).resolves.toMatchObject({ generation: 2, etag: 'etag-generation-2' });
			} finally {
				await runCleanupSteps([
					() => control.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } }),
					() => control.gameUploadSession.deleteMany({ where: { id: session.id } }),
					() => control.multipartAbortTask.deleteMany({
						where: { bucket: protectedBucket, storageKey: key, uploadId: oldUploadId },
					}),
				]);
			}
		});

		it('keeps an active completion lease despite a future recovery cutoff and fences expired finalizers', async () => {
			const key = `${testId}-completion-lease-clock.zip`;
			const session = await createSessionFixture({ s3Key: key });
			await control.gameUploadPart.create({
				data: { sessionId: session.id, partNumber: 1, etag: 'etag-1', generation: 1 },
			});
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

		it('fences stale part claims when replacing a multipart generation', async () => {
			const key = `${testId}-generation.zip`;
			const oldUploadId = randomUUID();
			const newUploadId = randomUUID();
			const session = await createSessionFixture({
				s3Key: key,
				s3UploadId: oldUploadId,
			});
			const repository = createGameUploadRepository(control, {
				abortBucket: protectedBucket,
			});
			const leaseMs = 60_000;
			const staleToken = randomUUID();

			try {
				await expect(repository.acquirePartClaim({
					sessionId: session.id,
					partNumber: 1,
					generation: 1,
					token: staleToken,
					owner: 'first-request',
					leaseMs,
				})).resolves.toEqual({ kind: 'acquired', token: staleToken });
				await expect(repository.acquirePartClaim({
					sessionId: session.id,
					partNumber: 1,
					generation: 1,
					token: randomUUID(),
					owner: 'second-request',
					leaseMs,
				})).resolves.toEqual({ kind: 'busy' });
				await control.gameUploadPart.create({
					data: {
						sessionId: session.id,
						partNumber: 1,
						etag: 'old-etag',
						generation: 1,
					},
				});
				await expect(repository.replaceMultipartGeneration({
					sessionId: session.id,
					expectedGeneration: 1,
					newUploadId,
					reason: 'must-not-revoke-active-part-claim',
				})).resolves.toEqual({ replaced: false, durableAbort: null });
				await expect(control.gameUploadPartClaim.findUnique({ where: { token: staleToken } }))
					.resolves.toMatchObject({ token: staleToken, generation: 1 });
				await control.gameUploadPartClaim.update({
					where: { token: staleToken },
					data: { leaseUntil: new Date(0) },
				});

				await expect(repository.replaceMultipartGeneration({
					sessionId: session.id,
					expectedGeneration: 1,
					newUploadId,
					reason: 'expired-part-claim-reset',
				})).resolves.toEqual({
					replaced: true,
					durableAbort: {
						tracking: 'durable-abort-task-committed',
						sessionId: session.id,
						key,
						uploadId: oldUploadId,
						reason: 'expired-part-claim-reset',
					},
				});
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).resolves.toMatchObject({
					multipartGeneration: 2,
					s3UploadId: newUploadId,
					uploadedChunks: [],
				});
				await expect(control.gameUploadPartClaim.count({
					where: { sessionId: session.id },
				})).resolves.toBe(0);
				await expect(control.gameUploadPart.count({
					where: { sessionId: session.id },
				})).resolves.toBe(0);
				await expect(repository.completePartClaim({
					token: staleToken,
					etag: 'stale-etag',
				})).resolves.toEqual({ accepted: false, parts: [] });
				await expect(repository.acquirePartClaim({
					sessionId: session.id,
					partNumber: 1,
					generation: 1,
					token: randomUUID(),
					owner: 'stale-generation',
					leaseMs,
				})).resolves.toEqual({ kind: 'unavailable' });
				await expect(control.multipartAbortTask.findUnique({
					where: {
						multipart_abort_bucket_key_upload: {
							bucket: protectedBucket,
							storageKey: key,
							uploadId: oldUploadId,
						},
					},
				})).resolves.toMatchObject({ reason: 'expired-part-claim-reset' });
			} finally {
				await runCleanupSteps([
					() => control.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } }),
					() => control.gameUploadSession.deleteMany({ where: { id: session.id } }),
					() => control.multipartAbortTask.deleteMany({
						where: { bucket: protectedBucket, storageKey: key, uploadId: oldUploadId },
					}),
				]);
			}
		});

		it('blocks completion while a part claim is active and fences later part work after completion claim', async () => {
			const session = await createSessionFixture({
				s3Key: `${testId}-completion-claim.zip`,
			});
			const repository = createGameUploadRepository(control, {
				abortBucket: protectedBucket,
			});
			const leaseMs = 60_000;
			const partToken = randomUUID();
			const completionToken = randomUUID();

			try {
				await repository.acquirePartClaim({
					sessionId: session.id,
					partNumber: 1,
					generation: 1,
					token: partToken,
					owner: 'part-request',
					leaseMs,
				});
				await expect(repository.claimCompletion({
					sessionId: session.id,
					generation: 1,
					token: completionToken,
					leaseMs,
				})).resolves.toEqual({ count: 0, reason: 'parts-active' });
				await expect(repository.completePartClaim({
					token: partToken,
					etag: 'etag-1',
				})).resolves.toMatchObject({ accepted: true });
				await expect(repository.claimCompletion({
					sessionId: session.id,
					generation: 1,
					token: completionToken,
					leaseMs,
				})).resolves.toEqual({ count: 1, reason: null });
				await expect(repository.renewCompletionClaim(
					session.id,
					'wrong-token',
					2 * 60_000,
				)).resolves.toEqual({ count: 0 });
				await expect(repository.renewCompletionClaim(
					session.id,
					completionToken,
					2 * 60_000,
				)).resolves.toEqual({ count: 1 });
				await expect(repository.acquirePartClaim({
					sessionId: session.id,
					partNumber: 1,
					generation: 1,
					token: randomUUID(),
					owner: 'late-part-request',
					leaseMs,
				})).resolves.toEqual({ kind: 'unavailable' });
			} finally {
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
			await control.gameUploadPart.create({
				data: { sessionId: session.id, partNumber: 1, etag: 'etag-1' },
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
					),
					secondGraph.service.completeSession(
						session.id,
						{ id: userId, role: 'ADMIN' },
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
							AND query ILIKE '%UPDATE%game_upload_sessions%'
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
				expect(outcomes.every(({ status }) => status === 'rejected')).toBe(true);
				expect(outcomes.filter((outcome) => (
					outcome.status === 'rejected'
					&& /session is COMPLETING|already being completed/.test(
						String(outcome.reason instanceof Error
							? outcome.reason.message
							: outcome.reason),
					)
				))).toHaveLength(1);
				expect(storage.calls.completeMultipart).toHaveBeenCalledTimes(1);
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).resolves.toMatchObject({ status: 'FAILED' });
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

		it('rolls back terminal state and preserves the object when atomic outbox persistence fails', async () => {
			const key = `${testId}-double-failure.zip`;
			const uploadId = randomUUID();
			const session = await createSessionFixture({
				s3Key: key,
				s3UploadId: uploadId,
				totalBytes: 1n,
			});
			await control.gameUploadPart.create({
				data: { sessionId: session.id, partNumber: 1, etag: 'etag-1' },
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
				try {
					await graph(control).service.completeSession(
						session.id,
						{ id: userId, role: 'ADMIN' },
					);
				} catch (error) {
					failure = error;
				}

				expect(String(failure)).toContain('ticket-012 forced orphan write failure');
				await expect(control.gameUploadSession.findUniqueOrThrow({
					where: { id: session.id },
				})).resolves.toMatchObject({
					status: 'COMPLETING',
					storageKey: null,
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
				{ name: 'Build/game.wasm', body: Buffer.from([0, 97, 115, 109]) },
			]);
			storage.put(protectedBucket, deployment.sourceKey, archive);
			const session = await createSessionFixture({
				uploadKind: 'WEBGL',
				status: 'COMPLETING',
				s3Key: deployment.sourceKey,
				totalBytes: BigInt(archive.length),
				updatedAt: new Date('2098-07-31T00:00:00.000Z'),
			});
			const pointerFailure = new Error('forced DB pointer failure');
			const firstGraph = graph(pointerFaultClient(control, pointerFailure));

			await firstGraph.recoverStaleUploads();
			await expect(control.gameUploadSession.findUniqueOrThrow({
				where: { id: session.id },
			})).resolves.toMatchObject({ status: 'COMPLETING' });
			expect(storage.objects.has(`${protectedBucket}/${deployment.sourceKey}`)).toBe(true);
			expect(
				[...storage.objects.keys()]
					.filter((key) => key.startsWith(`${publicBucket}/${deployment.sitePrefix}`)),
			).toEqual([]);
			await firstGraph.close();

			const secondGraph = graph(recoveryClient);
			await secondGraph.recoverStaleUploads();
			await expect(control.gameUploadSession.findUniqueOrThrow({
				where: { id: session.id },
			})).resolves.toMatchObject({
				status: 'COMPLETED',
				storageKey: deployment.sourceKey,
			});
			await expect(control.project.findUniqueOrThrow({
				where: { id: projectId },
			})).resolves.toMatchObject({ webglEntryKey: deployment.entryKey });
			await expect(control.gameUploadActiveSession.findUnique({
				where: {
					projectId_uploadKind: { projectId, uploadKind: 'WEBGL' },
				},
			})).resolves.toBeNull();
			expect(storage.objects.has(`${protectedBucket}/${deployment.sourceKey}`)).toBe(true);
			expect(
				[...storage.objects.keys()]
					.filter((key) => key.startsWith(`${publicBucket}/${deployment.sitePrefix}`))
					.sort(),
			).toEqual([
				`${publicBucket}/${deployment.sitePrefix}Build/game.wasm`,
				`${publicBucket}/${deployment.entryKey}`,
			]);
		});
	},
);
