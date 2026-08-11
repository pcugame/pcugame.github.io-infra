import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ObjectStorage } from '../application/ports.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createS3Client } from '../lib/s3.js';
import { createObjectStorage } from '../lib/storage.js';
import { createGameUploadRepository } from '../modules/admin/game-upload/repository.js';
import { createGameUploadService } from '../modules/admin/game-upload/service.js';
import { createMultipartAbortRepository } from '../modules/multipart-abort/repository.js';
import { createMultipartAbortService } from '../modules/multipart-abort/service.js';
import { createOrphanRepository } from '../modules/orphan/repository.js';
import { createObjectReferenceResolver } from '../modules/orphan/reference-resolver.js';
import { reconcileObjects } from '../modules/orphan/reconcile.js';
import { createOrphanService } from '../modules/orphan/service.js';
import { createUploadIntentRepository } from '../modules/upload-intent/repository.js';
import { createUploadIntentService } from '../modules/upload-intent/service.js';
import { createWebglDeploymentKeys } from '../modules/webgl/paths.js';

const runStorageIntegration = process.env['RUN_STORAGE_INTEGRATION'] === 'true';
const MIB = 1024 * 1024;

describe.runIf(runStorageIntegration)(
	'crash-safe storage lifecycle with Garage and PostgreSQL',
	() => {
		const testId = randomUUID();
		const publicBucket = process.env['S3_BUCKET_PUBLIC'] ?? 'pcu-public';
		const protectedBucket = process.env['S3_BUCKET_PROTECTED'] ?? 'pcu-protected';
		const keyPrefix = `integration/storage-lifecycle/${testId}`;
		const key = (name: string) => `${keyPrefix}/${name}`;
		const s3 = createS3Client({
			S3_ENDPOINT: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:3900',
			S3_REGION: process.env['S3_REGION'] ?? 'garage',
			S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? '',
			S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
			S3_FORCE_PATH_STYLE: true,
		});
		const storage = createObjectStorage(s3, { defaultPresignTtlSec: 60 });
		const testObjects = new Map<string, Set<string>>([
			[publicBucket, new Set()],
			[protectedBucket, new Set()],
		]);
		const scopedStorage: ObjectStorage = {
			...storage,
			async listObjects(bucket, prefix, request) {
				const allowed = testObjects.get(bucket) ?? new Set<string>();
				const objects = await storage.listObjects!(bucket, prefix, request);
				return objects.filter((object) => allowed.has(object.key));
			},
		};
		let prisma: PrismaClient;
		let userId: number;
		let exhibitionId: number;
		let projectId: number;
		let gameRepository: ReturnType<typeof createGameUploadRepository>;
		const crashFixture = fileURLToPath(new URL(
			'./fixtures/upload-intent-crash-worker.ts',
			import.meta.url,
		));

		async function upload(bucket: string, key: string, body = Buffer.from(key)) {
			await storage.upload(
				bucket,
				key,
				body,
				'application/octet-stream',
				body.length,
			);
			testObjects.get(bucket)?.add(key);
		}

		async function killCrashFixture(input: {
			stage:
				| 'after-intent-before-put'
				| 'after-put-before-commit'
				| 'during-reference-commit'
				| 'after-commit-before-response';
			intentId: string;
			storageKey: string;
		}): Promise<void> {
			const child: ChildProcess = fork(crashFixture, [], {
				execArgv: ['--import', 'tsx'],
				env: {
					...process.env,
					FAULT_STAGE: input.stage,
					FAULT_INTENT_ID: input.intentId,
					FAULT_STORAGE_KEY: input.storageKey,
					FAULT_BUCKET: publicBucket,
					FAULT_PROJECT_ID: String(projectId),
				},
				stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			});
			let stderr = '';
			child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					child.kill('SIGKILL');
					reject(new Error(`Crash fixture timed out at ${input.stage}: ${stderr}`));
				}, 20_000);
				child.once('error', (error) => {
					clearTimeout(timeout);
					reject(error);
				});
				child.on('message', (message) => {
					if (
						typeof message === 'object'
						&& message !== null
						&& 'type' in message
						&& message.type === 'checkpoint'
					) {
						child.kill('SIGKILL');
					}
				});
				child.once('exit', (code, signal) => {
					clearTimeout(timeout);
					if (code === null && signal === 'SIGKILL') resolve();
					else reject(new Error(
						`Crash fixture exited unexpectedly (${code ?? signal}) at ${input.stage}: ${stderr}`,
					));
				});
			});
		}

		function gameService(overrides: {
			uploadPart?: (
				key: string,
				uploadId: string,
				partNumber: number,
				body: NodeJS.ReadableStream,
				contentLength: number,
			) => Promise<string>;
		} = {}) {
			return createGameUploadService({
				repository: gameRepository,
				storage: {
					createMultipart: (storageKey) => storage.createMultipart(
						protectedBucket,
						storageKey,
					),
					abortMultipart: (storageKey, uploadId) => storage.abortMultipart(
						protectedBucket,
						storageKey,
						uploadId,
					),
					uploadPart: overrides.uploadPart ?? (
						(storageKey, uploadId, partNumber, body, contentLength) => storage.uploadPart(
							protectedBucket,
							storageKey,
							uploadId,
							partNumber,
							body as Readable,
							contentLength,
						)
					),
					completeMultipart: (storageKey, uploadId, parts) => storage.completeMultipart(
						protectedBucket,
						storageKey,
						uploadId,
						parts,
					),
					listParts: (storageKey, uploadId) => storage.listParts!(
						protectedBucket,
						storageKey,
						uploadId,
					),
					listMultipartUploads: (prefix) => storage.listMultipartUploads!(
						protectedBucket,
						prefix,
					),
					head: (storageKey) => storage.head(protectedBucket, storageKey),
				},
				finalizer: {
					async finalize(session, object) {
						await gameRepository.finalizeCompletedSession(
							session.id,
							session.projectId,
							'GAME',
							{
								storageKey: session.s3Key,
								originalName: session.originalName,
								mimeType: 'application/zip',
								sizeBytes: session.totalBytes,
								isPublic: false,
								completionClaimToken: session.completionClaimToken,
							},
							{
								bucket: protectedBucket,
								reason: 'integration-game-replace',
								playbackReason: 'integration-game-playback-replace',
							},
						);
						testObjects.get(protectedBucket)?.add(session.s3Key);
						return {
							status: 'COMPLETED' as const,
							storageKey: session.s3Key,
							sizeBytes: object.size,
						};
					},
				},
				settings: { get: async () => ({ maxGameFileMb: 20, maxChunkSizeMb: 5 }) },
				uploadSlots: { acquire: () => {}, release: () => {} },
				clock: { now: () => new Date() },
				ids: { next: () => randomUUID() },
				lifecycle: { isAcceptingNewWork: () => true },
				config: { uploadChunkSizeMb: 5, uploadSessionTtlMinutes: 60 },
				roleGameMaxBytes: () => 20 * MIB,
				storageKey: () => key(`game-${randomUUID()}.zip`),
				deleteOrQueue: async () => {},
				wakeDeletionWorker: vi.fn(),
				wakeMaintenance: vi.fn(),
				recordUntrackedMultipartCleanupFailure: vi.fn(),
				logger: { error: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
			});
		}

		beforeAll(async () => {
			const databaseUrl = process.env['DATABASE_URL'];
			if (!databaseUrl) throw new Error('DATABASE_URL is required');
			prisma = createPrismaClientForDatabase(databaseUrl);
			await prisma.$connect();
			const user = await prisma.user.create({
				data: {
					googleSub: `storage-lifecycle-${testId}`,
					email: `storage-lifecycle-${testId}@example.test`,
					name: 'Storage lifecycle integration',
					role: 'ADMIN',
				},
			});
			userId = user.id;
			const exhibition = await prisma.exhibition.create({
				data: {
					year: 2097,
					title: `Storage lifecycle ${testId}`,
					posterStorageKey: key('poster.png'),
				},
			});
			exhibitionId = exhibition.id;
			const deployment = createWebglDeploymentKeys(1, randomUUID());
			const project = await prisma.project.create({
				data: {
					exhibitionId,
					creatorId: userId,
					slug: `storage-lifecycle-${testId}`,
					title: 'Storage lifecycle project',
					status: 'PUBLISHED',
				},
			});
			projectId = project.id;
			gameRepository = createGameUploadRepository(prisma, {
				abortBucket: protectedBucket,
			});
			const projectDeployment = createWebglDeploymentKeys(projectId, deployment.deploymentId);
			await prisma.project.update({
				where: { id: projectId },
				data: { webglEntryKey: projectDeployment.entryKey },
			});
		});

		afterAll(async () => {
			if (!prisma) return;
			await prisma.orphanObject.deleteMany({
				where: { storageKey: { startsWith: keyPrefix } },
			});
			await prisma.uploadIntent.deleteMany({
				where: { storageKey: { startsWith: keyPrefix } },
			});
			await prisma.multipartAbortTask.deleteMany({
				where: { storageKey: { startsWith: keyPrefix } },
			});
			await prisma.gameUploadSession.deleteMany({ where: { projectId } });
			await prisma.asset.deleteMany({ where: { projectId } });
			await prisma.project.deleteMany({ where: { id: projectId } });
			await prisma.exhibition.deleteMany({ where: { id: exhibitionId } });
			await prisma.user.deleteMany({ where: { id: userId } });
			for (const [bucket, keys] of testObjects) {
				for (const storageKey of keys) {
					await storage.delete(bucket, storageKey).catch(() => undefined);
				}
			}
			await prisma.$disconnect();
			s3.destroy();
		});

		it('accepts a 5 MiB non-final part plus a small final part', async () => {
			const multipartKey = key('multipart.zip');
			const uploadId = await storage.createMultipart(
				protectedBucket,
				multipartKey,
				'application/zip',
			);
			const first = Buffer.alloc(5 * MIB, 0x61);
			const final = Buffer.from('final-part');
			try {
				const etag1 = await storage.uploadPart(
					protectedBucket, multipartKey, uploadId, 1, Readable.from([first]), first.length,
				);
				const etag2 = await storage.uploadPart(
					protectedBucket, multipartKey, uploadId, 2, Readable.from([final]), final.length,
				);
				await expect(storage.listParts!(protectedBucket, multipartKey, uploadId))
					.resolves.toEqual([
						{ partNumber: 1, etag: etag1 },
						{ partNumber: 2, etag: etag2 },
					]);
				await storage.completeMultipart(protectedBucket, multipartKey, uploadId, [
					{ partNumber: 1, etag: etag1 },
					{ partNumber: 2, etag: etag2 },
				]);
				await expect(storage.head(protectedBucket, multipartKey)).resolves.toMatchObject({
					size: first.length + final.length,
				});
			} finally {
				await storage.abortMultipart(protectedBucket, multipartKey, uploadId)
					.catch(() => undefined);
				await storage.delete(protectedBucket, multipartKey).catch(() => undefined);
			}
		});

		it('does not let duplicate abort queueing clear a live worker claim', async () => {
			const repository = createMultipartAbortRepository(prisma);
			const target = {
				bucket: protectedBucket,
				storageKey: key('claimed-abort.zip'),
				uploadId: `claimed-${testId}`,
				reason: 'initial',
			};
			await repository.queue(target);
			const now = new Date();
			await prisma.multipartAbortTask.update({
				where: {
					multipart_abort_bucket_key_upload: {
						bucket: target.bucket,
						storageKey: target.storageKey,
						uploadId: target.uploadId,
					},
				},
				data: {
					state: 'CLAIMED',
					claimToken: 'abort-worker',
					claimUntil: new Date(now.getTime() + 2 * 60 * 1000),
				},
			});
			await repository.queue({ ...target, reason: 'duplicate' });
			await expect(prisma.multipartAbortTask.findUniqueOrThrow({
				where: {
					multipart_abort_bucket_key_upload: {
						bucket: target.bucket,
						storageKey: target.storageKey,
						uploadId: target.uploadId,
					},
				},
			})).resolves.toMatchObject({
				state: 'CLAIMED',
				claimToken: 'abort-worker',
				reason: 'duplicate',
			});
			await repository.resolve(
				(await prisma.multipartAbortTask.findUniqueOrThrow({
					where: {
						multipart_abort_bucket_key_upload: {
							bucket: target.bucket,
							storageKey: target.storageKey,
							uploadId: target.uploadId,
						},
					},
				})).id,
				'abort-worker',
				now,
			);
		});

		it('converges after SIGKILL at every PUT/reference commit boundary', async () => {
			const faults = [
				{
					stage: 'after-intent-before-put',
					intentId: randomUUID(),
					storageKey: key('fault-after-intent-before-put.bin'),
				},
				{
					stage: 'after-put-before-commit',
					intentId: randomUUID(),
					storageKey: key('fault-after-put-before-commit.bin'),
				},
				{
					stage: 'during-reference-commit',
					intentId: randomUUID(),
					storageKey: key('fault-during-reference-commit.bin'),
				},
				{
					stage: 'after-commit-before-response',
					intentId: randomUUID(),
					storageKey: key('fault-after-commit-before-response.bin'),
				},
			] as const;

			for (const fault of faults) {
				await killCrashFixture(fault);
				if (fault.stage !== 'after-intent-before-put') {
					testObjects.get(publicBucket)?.add(fault.storageKey);
				}
			}

			const [beforePut, afterPut, duringCommit, afterCommit] = faults;
			await expect(prisma.uploadIntent.findUniqueOrThrow({
				where: { id: beforePut.intentId },
			})).resolves.toMatchObject({ state: 'PREPARED' });
			await expect(storage.head(publicBucket, beforePut.storageKey)).resolves.toBeNull();
			for (const fault of [afterPut, duringCommit]) {
				await expect(prisma.uploadIntent.findUniqueOrThrow({
					where: { id: fault.intentId },
				})).resolves.toMatchObject({ state: 'UPLOADED' });
				await expect(storage.head(publicBucket, fault.storageKey)).resolves.not.toBeNull();
				await expect(prisma.asset.count({
					where: { projectId, storageKey: fault.storageKey },
				})).resolves.toBe(0);
			}
			await expect(prisma.uploadIntent.findUniqueOrThrow({
				where: { id: afterCommit.intentId },
			})).resolves.toMatchObject({ state: 'COMMITTED' });
			await expect(prisma.asset.count({
				where: { projectId, storageKey: afterCommit.storageKey },
			})).resolves.toBe(1);

			const logger = { info: vi.fn(), error: vi.fn() };
			const references = createObjectReferenceResolver(
				prisma,
				{ publicBucket, protectedBucket },
				logger,
			);
			const intentWorker = createUploadIntentService({
				repository: createUploadIntentRepository(prisma),
				references,
				storage,
				clock: { now: () => new Date(Date.now() + 1_000) },
				ids: { next: () => randomUUID() },
				logger,
				graceMs: 0,
			});
			await expect(intentWorker.sweep()).resolves.toEqual({
				tried: 3,
				referenced: 0,
				queued: 2,
				missing: 1,
			});
			const reaper = createOrphanService({
				clock: { now: () => new Date(Date.now() + 2_000) },
				storage,
				repository: createOrphanRepository(prisma),
				references,
				ids: { next: () => randomUUID() },
				logger,
			});
			const reapResult = await reaper.runOrphanReaper();
			expect(reapResult.failed).toBe(0);
			expect(reapResult.resolved).toBeGreaterThanOrEqual(2);
			for (const fault of [afterPut, duringCommit]) {
				await expect(storage.head(publicBucket, fault.storageKey)).resolves.toBeNull();
			}
			await expect(prisma.orphanObject.count({
				where: {
					storageKey: { in: [afterPut.storageKey, duringCommit.storageKey] },
					state: 'RESOLVED',
				},
			})).resolves.toBe(2);
			await expect(storage.head(publicBucket, afterCommit.storageKey)).resolves.not.toBeNull();
			await prisma.orphanObject.deleteMany({
				where: { storageKey: { in: [afterPut.storageKey, duringCommit.storageKey] } },
			});
		});

		it('isolates parallel parts and resets a real multipart generation on ETag mismatch', async () => {
			let releaseFirst!: () => void;
			let enteredFirst!: () => void;
			const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
			const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
			const service = gameService({
				async uploadPart(storageKey, uploadId, partNumber, body, contentLength) {
					enteredFirst();
					await firstGate;
					return storage.uploadPart(
						protectedBucket,
						storageKey,
						uploadId,
						partNumber,
						body as Readable,
						contentLength,
					);
				},
			});
			const actor = { id: userId, role: 'ADMIN' as const };
			const created = await service.createSession(projectId, exhibitionId, actor, {
				originalName: 'parallel.zip',
				totalBytes: 5 * MIB,
			});
			const firstUpload = service.uploadChunk(
				created.sessionId,
				0,
				Readable.from([Buffer.alloc(5 * MIB, 0x61)]),
				actor,
			);
			await firstEntered;
			await expect(service.uploadChunk(
				created.sessionId,
				0,
				Readable.from([Buffer.alloc(5 * MIB, 0x62)]),
				actor,
			)).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS', statusCode: 409 });
			releaseFirst();
			await expect(firstUpload).resolves.toMatchObject({ uploadedCount: 1 });
			const completed = await service.completeSession(created.sessionId, actor);
			expect(completed).toMatchObject({ status: 'COMPLETED', sizeBytes: 5 * MIB });
			await expect(service.completeSession(created.sessionId, actor)).resolves.toEqual(completed);

			const mismatchService = gameService();
			const mismatch = await mismatchService.createSession(projectId, exhibitionId, actor, {
				originalName: 'mismatch.zip',
				totalBytes: 5 * MIB,
			});
			await mismatchService.uploadChunk(
				mismatch.sessionId,
				0,
				Readable.from([Buffer.alloc(5 * MIB, 0x63)]),
				actor,
			);
			await prisma.gameUploadPart.updateMany({
				where: { sessionId: mismatch.sessionId },
				data: { etag: 'wrong-etag' },
			});
			await expect(mismatchService.completeSession(mismatch.sessionId, actor))
				.rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
			await expect(prisma.gameUploadSession.findUniqueOrThrow({
				where: { id: mismatch.sessionId },
				include: { parts: true, partClaims: true },
			})).resolves.toMatchObject({
				status: 'PENDING',
				multipartGeneration: 2,
				parts: [],
				partClaims: [],
			});
			await expect(prisma.multipartAbortTask.count({
				where: { storageKey: { startsWith: keyPrefix }, state: 'PENDING' },
			})).resolves.toBeGreaterThanOrEqual(1);
			await mismatchService.cancelSession(mismatch.sessionId, actor);
			const abortWorker = createMultipartAbortService({
				repository: createMultipartAbortRepository(prisma),
				storage,
				clock: { now: () => new Date(Date.now() + 1_000) },
				ids: { next: () => randomUUID() },
				logger: { error: vi.fn() },
			});
			await expect(abortWorker.run()).resolves.toMatchObject({ failed: 0 });
			await expect(prisma.multipartAbortTask.count({
				where: { storageKey: { startsWith: keyPrefix }, state: 'PENDING' },
			})).resolves.toBe(0);
		});

		it('reconciles by bucket and preserves every authoritative pointer', async () => {
			const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
			const deployment = createWebglDeploymentKeys(
				projectId,
				project.webglEntryKey.split('/')[2]!,
			);
			await prisma.asset.create({
				data: {
					projectId,
					kind: 'IMAGE',
					storageKey: key('same-key.bin'),
					playbackStorageKey: key('playback.webp'),
					originalName: 'image.png',
					mimeType: 'image/png',
					sizeBytes: 1n,
					isPublic: true,
				},
			});
			await prisma.gameUploadSession.createMany({
				data: [
					{
						id: randomUUID(), projectId, userId, uploadKind: 'GAME',
						originalName: 'completed.zip', totalBytes: 1n, chunkSizeBytes: 5 * MIB,
						totalChunks: 1, status: 'COMPLETED', storageKey: key('completed.zip'),
						expiresAt: new Date('2099-01-01T00:00:00.000Z'),
					},
					{
						id: randomUUID(), projectId, userId, uploadKind: 'GAME',
						originalName: 'pending.zip', totalBytes: 1n, chunkSizeBytes: 5 * MIB,
						totalChunks: 1, status: 'PENDING', s3Key: key('pending.zip'),
						s3UploadId: 'tracked-upload', expiresAt: new Date('2099-01-01T00:00:00.000Z'),
					},
				],
			});
			await prisma.uploadIntent.create({
				data: {
					id: randomUUID(), bucket: protectedBucket, storageKey: key('intent.zip'),
					purpose: 'integration', state: 'UPLOADED',
					notBefore: new Date('2099-01-01T00:00:00.000Z'),
				},
			});

			await Promise.all([
				upload(publicBucket, key('same-key.bin')),
				upload(publicBucket, key('playback.webp')),
				upload(publicBucket, key('poster.png')),
				upload(publicBucket, `${deployment.sitePrefix}main.js`),
				upload(publicBucket, key('public-orphan.bin')),
				upload(publicBucket, key('re-referenced.bin')),
				upload(protectedBucket, key('same-key.bin')),
				upload(protectedBucket, key('completed.zip')),
				upload(protectedBucket, key('pending.zip')),
				upload(protectedBucket, key('intent.zip')),
			]);
			const startedAt = new Date(Date.now() + 60_000);
			const dryRun = await reconcileObjects({
				prisma,
				storage: scopedStorage,
				publicBucket,
				protectedBucket,
				options: { apply: false, olderThanMinutes: 0, startedAt },
				logger: { log: vi.fn(), error: vi.fn() },
			});
			expect(dryRun).toMatchObject({ eligible: 3, enqueued: 0 });
			expect(await prisma.orphanObject.count({
				where: { storageKey: { startsWith: keyPrefix } },
			})).toBe(0);

			const applied = await reconcileObjects({
				prisma,
				storage: scopedStorage,
				publicBucket,
				protectedBucket,
				options: { apply: true, olderThanMinutes: 0, startedAt },
				logger: { log: vi.fn(), error: vi.fn() },
			});
			expect(applied).toMatchObject({ eligible: 3, enqueued: 3 });
			await prisma.asset.create({
				data: {
					projectId,
					kind: 'IMAGE',
					storageKey: key('re-referenced.bin'),
					originalName: 're-referenced.bin',
					mimeType: 'application/octet-stream',
					sizeBytes: 1n,
					isPublic: true,
				},
			});
			const clock = { now: () => new Date(startedAt.getTime() + 1_000) };
			const reaper = createOrphanService({
				clock,
				storage: scopedStorage,
				repository: createOrphanRepository(prisma),
				references: createObjectReferenceResolver(
					prisma,
					{ publicBucket, protectedBucket },
					{ error: vi.fn() },
				),
				ids: { next: () => randomUUID() },
				logger: { info: vi.fn(), error: vi.fn() },
			});
			const reapResult = await reaper.runOrphanReaper();
			expect(reapResult.failed).toBe(0);
			expect(reapResult.resolved).toBe(reapResult.tried);
			expect(reapResult.tried).toBeGreaterThanOrEqual(3);
			await expect(storage.head(publicBucket, key('public-orphan.bin'))).resolves.toBeNull();
			await expect(storage.head(protectedBucket, key('same-key.bin'))).resolves.toBeNull();
			await expect(storage.head(publicBucket, key('same-key.bin'))).resolves.not.toBeNull();
			await expect(storage.head(publicBucket, key('re-referenced.bin')))
				.resolves.not.toBeNull();
			await expect(prisma.orphanObject.findUniqueOrThrow({
				where: {
					orphan_bucket_storage_key: {
						bucket: publicBucket,
						storageKey: key('re-referenced.bin'),
					},
				},
			})).resolves.toMatchObject({
				state: 'CANCELLED',
				cancelReason: 'live-reference-detected',
			});
			await expect(storage.head(publicBucket, `${deployment.sitePrefix}main.js`))
				.resolves.not.toBeNull();
		});
	},
);
