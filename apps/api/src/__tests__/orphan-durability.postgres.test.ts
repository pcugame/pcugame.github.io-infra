import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
import { createAssetsService } from '../modules/assets/service.js';
import { createCompletedUploadFinalizer } from '../modules/admin/game-upload/finalize-completed-upload.service.js';
import * as gameUploadRepository from '../modules/admin/game-upload/repository.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createProjectAssetMutationRepository } from '../modules/admin/project/asset-mutation.repository.js';
import { createProjectService } from '../modules/admin/project/service.js';
import { createExhibitionRepository } from '../modules/admin/year/repository.js';
import { createExhibitionService } from '../modules/admin/year/service.js';
import { createOrphanRepository } from '../modules/orphan/repository.js';
import { queueDurableDeletions } from '../modules/orphan/outbox.js';
import {
	assertNoDeletionClaim,
	createObjectReferenceResolver,
} from '../modules/orphan/reference-resolver.js';
import { createOrphanService } from '../modules/orphan/service.js';
import { createUploadIntentRepository } from '../modules/upload-intent/repository.js';
import { parseWebglEntryKey, parseWebglSourceKey } from '../modules/webgl/paths.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

describe.runIf(runPostgresIntegration)('orphan durability with production PostgreSQL repositories', () => {
	let client: PrismaClient;
	let referenceWriterClient: PrismaClient;
	let projectRepository: ReturnType<typeof createProjectCrudRepository>;
	const testId = randomUUID();
	let userId: number;
	let exhibitionId: number;
	let projectId: number;
	let assetId: number;
	const storageKey = `integration/orphan-durability/${testId}.zip`;
	const publicBucket = `integration-public-${testId}`;
	const protectedBucket = `integration-protected-${testId}`;
	let fixtureSequence = 0;

	async function createProjectFixture(data: { webglEntryKey?: string } = {}) {
		fixtureSequence += 1;
		return client.project.create({
			data: {
				exhibitionId,
				creatorId: userId,
				slug: `orphan-fixture-${testId}-${fixtureSequence}`,
				title: `Orphan fixture ${fixtureSequence}`,
				status: 'PUBLISHED',
				webglEntryKey: data.webglEntryKey ?? '',
			},
		});
	}

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		client = createPrismaClientForDatabase(databaseUrl);
		referenceWriterClient = createPrismaClientForDatabase(databaseUrl);
		await Promise.all([client.$connect(), referenceWriterClient.$connect()]);
		projectRepository = createProjectCrudRepository(client);

		const user = await client.user.create({
			data: {
				googleSub: `orphan-durability-${testId}`,
				email: `orphan-durability-${testId}@example.test`,
				name: 'Orphan Durability Test',
				role: 'ADMIN',
			},
		});
		userId = user.id;
		const exhibition = await client.exhibition.create({
			data: { year: 2099, title: `Orphan durability ${testId}` },
		});
		exhibitionId = exhibition.id;
		const project = await client.project.create({
			data: {
				exhibitionId,
				creatorId: userId,
				slug: `orphan-durability-${testId}`,
				title: 'Orphan durability integration',
				status: 'PUBLISHED',
			},
		});
		projectId = project.id;
		const asset = await client.asset.create({
			data: {
				projectId,
				kind: 'GAME',
				storageKey,
				originalName: 'old-game.zip',
				mimeType: 'application/zip',
				sizeBytes: 8n,
				status: 'READY',
			},
		});
		assetId = asset.id;
	});

	afterAll(async () => {
		if (!client) return;
		await client.uploadIntent.deleteMany({
			where: { bucket: { in: [publicBucket, protectedBucket] } },
		});
		await client.orphanObject.deleteMany({
			where: {
				OR: [
					{ storageKey: { startsWith: `integration/orphan-durability/${testId}` } },
					{ bucket: { in: [publicBucket, protectedBucket] } },
				],
			},
		});
		await client.project.deleteMany({ where: { id: projectId } });
		await client.exhibition.deleteMany({ where: { id: exhibitionId } });
		await client.user.deleteMany({ where: { id: userId } });
		await Promise.all([client.$disconnect(), referenceWriterClient.$disconnect()]);
	});

	it('does not let reconciliation clear a live deletion claim', async () => {
		const repository = createOrphanRepository(client);
		const claimKey = `integration/orphan-durability/${testId}/claim-preserved.bin`;
		const now = new Date();
		await repository.upsertOrphan(protectedBucket, claimKey, 'initial', 'EXACT', now);
		await expect(repository.claimPendingOrphans!(
			1,
			now,
			'claim-owner',
			2 * 60 * 1000,
		)).resolves.toHaveLength(1);
		const initialClaim = await client.orphanObject.findUniqueOrThrow({
			where: {
				orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: claimKey },
			},
		});
		await expect(repository.renewActiveClaim!(
			initialClaim.id,
			'wrong-owner',
			5 * 60 * 1000,
		)).resolves.toEqual({ count: 0 });
		await expect(repository.renewActiveClaim!(
			initialClaim.id,
			'claim-owner',
			5 * 60 * 1000,
		)).resolves.toEqual({ count: 1 });
		const renewedClaim = await client.orphanObject.findUniqueOrThrow({
			where: { id: initialClaim.id },
		});
		expect(renewedClaim.claimUntil!.getTime())
			.toBeGreaterThan(initialClaim.claimUntil!.getTime() + 2 * 60 * 1000);

		await repository.upsertOrphan(
			protectedBucket,
			claimKey,
			'reconcile-while-claimed',
			'EXACT',
			new Date('9990-01-01T00:00:00.000Z'),
		);
		await expect(client.orphanObject.findUniqueOrThrow({
			where: {
				orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: claimKey },
			},
		})).resolves.toMatchObject({
			state: 'DELETE_CLAIMED',
			claimToken: 'claim-owner',
		});

		await client.orphanObject.update({
			where: {
				orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: claimKey },
			},
			data: { claimUntil: new Date(0) },
		});
		await expect(repository.renewActiveClaim!(
			initialClaim.id,
			'claim-owner',
			5 * 60 * 1000,
		)).resolves.toEqual({ count: 0 });
		await repository.upsertOrphan(
			protectedBucket,
			claimKey,
			'reconcile-after-expiry',
			'EXACT',
			new Date('2000-01-01T00:00:00.000Z'),
		);
		await expect(client.orphanObject.findUniqueOrThrow({
			where: {
				orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: claimKey },
			},
		})).resolves.toMatchObject({
			state: 'PENDING',
			claimToken: null,
		});
		await client.orphanObject.delete({
			where: {
				orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: claimKey },
			},
		});
	});

	it('cancels a claimed public PREFIX without S3 work when an active WebGL session already owns that writer fence', async () => {
		const deploymentId = randomUUID();
		const sourceKey = `webgl/${projectId}/${deploymentId}/source.zip`;
		const sitePrefix = parseWebglSourceKey(projectId, sourceKey)!.sitePrefix;
		const session = await client.gameUploadSession.create({
			data: {
				id: randomUUID(), projectId, userId, uploadKind: 'WEBGL', originalName: 'build.zip',
				totalBytes: 1n, chunkSizeBytes: 1, totalChunks: 1, status: 'PENDING',
				s3Key: sourceKey, s3UploadId: randomUUID(), expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			},
		});
		await client.gameUploadActiveSession.create({
			data: { projectId, uploadKind: 'WEBGL', sessionId: session.id },
		});
		const repository = createOrphanRepository(client);
		const listKeyPage = vi.fn();
		const deleteKeys = vi.fn();
		try {
			await repository.upsertOrphan(publicBucket, sitePrefix, 'active-webgl-fence', 'PREFIX', new Date());
			await expect(createOrphanService({
				clock: { now: () => new Date() },
				storage: { delete: vi.fn(), listKeyPage, deleteKeys }, repository,
				references: createObjectReferenceResolver(
					client, { publicBucket, protectedBucket }, { error: vi.fn() },
				),
				ids: { next: () => 'active-webgl-fence-reaper' }, logger: { info: vi.fn(), error: vi.fn() },
			}).runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
			expect(listKeyPage).not.toHaveBeenCalled();
			expect(deleteKeys).not.toHaveBeenCalled();
			await expect(client.orphanObject.findUniqueOrThrow({
				where: { orphan_bucket_storage_key: { bucket: publicBucket, storageKey: sitePrefix } },
			})).resolves.toMatchObject({ state: 'CANCELLED', cancelReason: 'live-reference-detected' });
		} finally {
			await client.orphanObject.deleteMany({ where: { bucket: publicBucket, storageKey: sitePrefix } });
			await client.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } });
			await client.gameUploadSession.deleteMany({ where: { id: session.id } });
		}
	});

	it('rejects WebGL session creation before it owns a session when a committed public PREFIX claim exists', async () => {
		const deploymentId = randomUUID();
		const sourceKey = `webgl/${projectId}/${deploymentId}/source.zip`;
		const sitePrefix = parseWebglSourceKey(projectId, sourceKey)!.sitePrefix;
		const sessionId = randomUUID();
		const repository = createOrphanRepository(client);
		try {
			await repository.upsertOrphan(publicBucket, sitePrefix, 'claim-before-writer', 'PREFIX', new Date());
			await expect(repository.claimPendingOrphans!(50, new Date(), 'prefix-first-claim', 120_000))
				.resolves.toEqual(expect.arrayContaining([expect.objectContaining({ storageKey: sitePrefix })]));
			await expect(gameUploadRepository.createSessionReplacingActive({
				id: sessionId, projectId, userId, uploadKind: 'WEBGL', originalName: 'build.zip',
				totalBytes: 1n, chunkSizeBytes: 1, totalChunks: 1,
				s3UploadId: randomUUID(), s3Key: sourceKey, expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			}, client, protectedBucket, publicBucket)).rejects.toThrow('Object deletion claim overlaps new reference');
			await expect(client.gameUploadSession.count({ where: { id: sessionId } })).resolves.toBe(0);
			await expect(client.gameUploadActiveSession.count({ where: { projectId, uploadKind: 'WEBGL' } })).resolves.toBe(0);
		} finally {
			await client.orphanObject.deleteMany({ where: { bucket: publicBucket, storageKey: sitePrefix } });
		}
	});

	it('fails closed for a malformed active WebGL session in the real reference inventory', async () => {
		const session = await client.gameUploadSession.create({
			data: {
				id: randomUUID(), projectId, userId, uploadKind: 'WEBGL', originalName: 'build.zip',
				totalBytes: 1n, chunkSizeBytes: 1, totalChunks: 1, status: 'COMPLETING',
				s3Key: 'webgl/not-a-project/deployment/source.zip', s3UploadId: randomUUID(),
				expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			},
		});
		await client.gameUploadActiveSession.create({ data: { projectId, uploadKind: 'WEBGL', sessionId: session.id } });
		try {
			const inventory = await createObjectReferenceResolver(
				client, { publicBucket, protectedBucket }, { error: vi.fn() },
			).collect();
			expect(inventory.unsafeBuckets).toEqual(new Set([publicBucket, protectedBucket]));
		} finally {
			await client.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } });
			await client.gameUploadSession.deleteMany({ where: { id: session.id } });
		}
	});

	it('uses advancing database wall time for reference checks inside a long transaction', async () => {
		const repository = createOrphanRepository(client);
		const exactKey = `integration/orphan-durability/${testId}/tx-clock-exact.bin`;
		const prefixKey = `integration/orphan-durability/${testId}/tx-clock-prefix/`;
		const now = new Date();
		await repository.upsertOrphan(protectedBucket, exactKey, 'tx-clock', 'EXACT', now);
		await repository.upsertOrphan(protectedBucket, prefixKey, 'tx-clock', 'PREFIX', now);
		await expect(repository.claimPendingOrphans(
			50,
			now,
			'tx-clock-owner',
			100,
		)).resolves.toEqual(expect.arrayContaining([
			expect.objectContaining({ storageKey: exactKey }),
			expect.objectContaining({ storageKey: prefixKey }),
		]));

		try {
			await client.$transaction(async (tx) => {
				// Establish transaction time while both leases are live. PostgreSQL
				// CURRENT_TIMESTAMP remains pinned here, while clock_timestamp advances.
				await tx.$queryRaw`SELECT CURRENT_TIMESTAMP`;
				await new Promise((resolve) => setTimeout(resolve, 200));
				await expect(assertNoDeletionClaim(tx, {
					bucket: protectedBucket,
					key: exactKey,
				})).resolves.toBeUndefined();
				await expect(assertNoDeletionClaim(tx, {
					bucket: protectedBucket,
					key: prefixKey,
					targetKind: 'PREFIX',
				})).resolves.toBeUndefined();
			});
		} finally {
			await client.orphanObject.deleteMany({
				where: { bucket: protectedBucket, storageKey: { in: [exactKey, prefixKey] } },
			});
		}
	});

	it('does not report success when the claim expires at the terminal resolution write', async () => {
		const repository = createOrphanRepository(client);
		const key = `integration/orphan-durability/${testId}/terminal-expiry.bin`;
		const now = new Date();
		await repository.upsertOrphan(protectedBucket, key, 'terminal-expiry', 'EXACT', now);
		const deleteObject = vi.fn(async () => {
			await client.orphanObject.update({
				where: { orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: key } },
				data: { claimUntil: new Date(0) },
			});
		});
		const service = createOrphanService({
			clock: { now: () => now },
				storage: {
					delete: deleteObject,
					listKeyPage: vi.fn().mockResolvedValue({ keys: [], isTruncated: false }),
					deleteKeys: vi.fn(async (_bucket, keys) => ({ deleted: [...keys], failures: [] })),
				},
			repository,
			references: {
				collect: vi.fn().mockResolvedValue({
					references: [],
					unsafeBuckets: new Set<string>(),
				}),
			},
			ids: { next: () => 'terminal-expiry-owner' },
			logger: { info: vi.fn(), error: vi.fn() },
		});

		try {
			await expect(service.runOrphanReaper()).resolves.toEqual({
				tried: 1,
				resolved: 0,
				failed: 1,
			});
			expect(deleteObject).toHaveBeenCalledOnce();
			await expect(client.orphanObject.findUniqueOrThrow({
				where: { orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: key } },
			})).resolves.toMatchObject({
				state: 'DELETE_CLAIMED',
				claimToken: 'terminal-expiry-owner',
				resolvedAt: null,
			});
		} finally {
			await client.orphanObject.deleteMany({
				where: { bucket: protectedBucket, storageKey: key },
			});
		}
	});

	it('requeues an older live claim when a newer reference-removal outbox commits', async () => {
		const repository = createOrphanRepository(client);
		const key = `integration/orphan-durability/${testId}/outbox-reclaims-live-claim.bin`;
		const now = new Date();
		await repository.upsertOrphan(protectedBucket, key, 'old-reconcile', 'EXACT', now);
		await expect(repository.claimPendingOrphans!(
			50,
			now,
			'old-reaper-token',
			2 * 60 * 1000,
		)).resolves.toEqual(expect.arrayContaining([
			expect.objectContaining({ storageKey: key }),
		]));

		await client.$transaction((tx) => queueDurableDeletions(tx, [{
			bucket: protectedBucket,
			storageKey: key,
			reason: 'business-reference-removed',
		}]));

		await expect(client.orphanObject.findUniqueOrThrow({
			where: {
				orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: key },
			},
		})).resolves.toMatchObject({
			state: 'DELETE_CLAIMED',
			claimToken: 'old-reaper-token',
			cancelReason: 'business-outbox-requeue-requested',
			reason: 'business-reference-removed',
		});
		const claimed = await client.orphanObject.findUniqueOrThrow({
			where: {
				orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: key },
			},
		});
		await repository.markClaimCancelled!(
			claimed.id,
			'old-reaper-token',
			'stale-live-reference-observation',
			new Date(now.getTime() + 1_000),
		);
		await expect(client.orphanObject.findUniqueOrThrow({ where: { id: claimed.id } }))
			.resolves.toMatchObject({
				state: 'PENDING',
				claimToken: null,
				cancelReason: null,
				resolvedAt: null,
			});
		await client.orphanObject.delete({ where: { id: claimed.id } });
	});

	it('orders a new reference before a competing deletion claim', async () => {
		const repository = createOrphanRepository(client);
		const referenceKey = `integration/orphan-durability/${testId}/claim-reference-race.bin`;
		const now = new Date();
		await repository.upsertOrphan(protectedBucket, referenceKey, 'reference-race', 'EXACT', now);

		let enterReference!: () => void;
		let releaseReference!: () => void;
		const referenceEntered = new Promise<void>((resolve) => { enterReference = resolve; });
		const referenceGate = new Promise<void>((resolve) => { releaseReference = resolve; });
		const referenceWrite = client.$transaction(async (tx) => {
			await assertNoDeletionClaim(tx, { bucket: protectedBucket, key: referenceKey });
			enterReference();
			await referenceGate;
			await tx.asset.create({
				data: {
					projectId,
					kind: 'IMAGE',
					storageKey: referenceKey,
					originalName: 'reference-race.bin',
					mimeType: 'application/octet-stream',
					sizeBytes: 1n,
					isPublic: false,
				},
			});
		}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
		await referenceEntered;

		let claimSettled = false;
		const claim = repository.claimPendingOrphans!(
			50,
			now,
			'reference-race-claim',
			2 * 60 * 1000,
		).finally(() => { claimSettled = true; });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(claimSettled).toBe(false);

		releaseReference();
		await referenceWrite;
		const claimed = await claim;
		const claimedReference = claimed.find((row) => row.storageKey === referenceKey);
		expect(claimedReference).toBeDefined();
		const references = createObjectReferenceResolver(
			client,
			{ publicBucket, protectedBucket },
			{ error: vi.fn() },
		);
		await expect(references.isReferenced({
			bucket: protectedBucket,
			targetKind: 'EXACT',
			key: referenceKey,
		})).resolves.toBe(true);
		await repository.markClaimCancelled!(
			claimedReference!.id,
			'reference-race-claim',
			'live-reference-detected',
			new Date(),
		);
	});

	it.each([
		{ targetKind: 'EXACT' as const, suffix: 'exact' },
		{ targetKind: 'PREFIX' as const, suffix: 'prefix' },
	])('does not let a stale $targetKind worker delete after its DB lease expired and a reference committed', async ({ targetKind, suffix }) => {
		const repository = createOrphanRepository(client);
		const baseKey = `integration/orphan-durability/${testId}/lease-continuity-${suffix}`;
		const orphanKey = targetKind === 'PREFIX' ? `${baseKey}/` : `${baseKey}.bin`;
		const referenceKey = targetKind === 'PREFIX' ? `${baseKey}/live.bin` : orphanKey;
		const intentId = randomUUID();
		const realReferences = createObjectReferenceResolver(
			client,
			{ publicBucket, protectedBucket },
			{ error: vi.fn() },
		);
		let snapshotCaptured!: () => void;
		let releaseSnapshot!: () => void;
		const snapshotReady = new Promise<void>((resolve) => { snapshotCaptured = resolve; });
		const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
		const collect = vi.fn(async () => {
			const snapshot = await realReferences.collect();
			snapshotCaptured();
			await snapshotGate;
			return snapshot;
		});
		const deleteObject = vi.fn(async () => undefined);
			const listKeyPage = vi.fn(async (_bucket, _prefix, page) => (
				page.startAfter ? { keys: [], isTruncated: false } : { keys: [referenceKey], isTruncated: false }
			));
			const deleteKeys = vi.fn(async (_bucket, keys) => ({ deleted: [...keys], failures: [] }));
		let running: ReturnType<ReturnType<typeof createOrphanService>['runOrphanReaper']> | undefined;

		await repository.upsertOrphan(
			protectedBucket,
			orphanKey,
			'lease-continuity-regression',
			targetKind,
			new Date(),
		);
		try {
			const service = createOrphanService({
				clock: { now: () => new Date() },
				storage: { delete: deleteObject, listKeyPage, deleteKeys },
				repository,
				references: { collect },
				ids: { next: () => `lease-continuity-worker-${suffix}` },
				logger: { info: vi.fn(), error: vi.fn() },
			});
			running = service.runOrphanReaper();
			await snapshotReady;

			const claimed = await client.orphanObject.findUniqueOrThrow({
				where: {
					orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: orphanKey },
				},
			});
			expect(claimed).toMatchObject({
				state: 'DELETE_CLAIMED',
				claimToken: `lease-continuity-worker-${suffix}`,
			});
			await client.orphanObject.update({
				where: { id: claimed.id },
				data: { claimUntil: new Date(0) },
			});

			await createUploadIntentRepository(referenceWriterClient).prepare({
				id: intentId,
				bucket: protectedBucket,
				storageKey: referenceKey,
				purpose: 'lease-continuity-regression',
				notBefore: new Date(Date.now() + 60 * 60 * 1000),
			});
			await expect(referenceWriterClient.uploadIntent.findUniqueOrThrow({
				where: { id: intentId },
			})).resolves.toMatchObject({
				state: 'PREPARED',
				bucket: protectedBucket,
				storageKey: referenceKey,
			});

			releaseSnapshot();
			await expect(running).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
			expect(collect).toHaveBeenCalledOnce();
			expect(listKeyPage).not.toHaveBeenCalled();
			expect(deleteObject).not.toHaveBeenCalled();
			await expect(realReferences.isReferenced({
				bucket: protectedBucket,
				targetKind: 'EXACT',
				key: referenceKey,
			})).resolves.toBe(true);
		} finally {
			releaseSnapshot();
			if (running) await Promise.allSettled([running]);
			await referenceWriterClient.uploadIntent.deleteMany({ where: { id: intentId } });
			await client.orphanObject.deleteMany({
				where: { bucket: protectedBucket, storageKey: orphanKey },
			});
		}
	});

	it('atomically commits asset deletion, clears completed-session pointers, and converges after a worker wake', async () => {
		const assetsRepository = createAssetsRepository(client);
		const productionOrphanRepository = createOrphanRepository(client);
		const completed = await client.gameUploadSession.create({
			data: {
				projectId,
				userId,
				uploadKind: 'GAME',
				originalName: 'old-game.zip',
				totalBytes: 8n,
				chunkSizeBytes: 5 * 1024 * 1024,
				totalChunks: 1,
				status: 'COMPLETED',
				storageKey,
				expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			},
		});
		const wakeDeletionWorker = vi.fn();
		const createCaller = () => createAssetsService({
			protectedBucket: 'protected',
			presign: vi.fn(),
			bucketForKind: () => 'protected',
			wakeDeletionWorker,
			loadProjectWithAccess: vi.fn().mockResolvedValue(undefined),
			downloadLimiter: { check: vi.fn().mockReturnValue('ok') },
			logger: { info: vi.fn(), error: vi.fn() },
			repository: assetsRepository,
		});

		await expect(createCaller().deleteAsset(
			assetId,
			{ id: userId, role: 'ADMIN' },
		)).resolves.toEqual({ projectId });

		await expect(client.asset.findUniqueOrThrow({ where: { id: assetId } }))
			.resolves.toMatchObject({ status: 'DELETED', storageKey });
		await expect(client.orphanObject.count({ where: { bucket: 'protected', storageKey } }))
			.resolves.toBe(1);
		await expect(client.gameUploadSession.findUniqueOrThrow({ where: { id: completed.id } }))
			.resolves.toMatchObject({ status: 'COMPLETED', storageKey: null });
		expect(wakeDeletionWorker).toHaveBeenCalledOnce();

		const reapNow = new Date(Date.now() + 1_000);
		const recoveredDelete = vi.fn().mockResolvedValue(undefined);
		const durableOrphanService = createOrphanService({
			clock: { now: () => reapNow },
			storage: {
				delete: recoveredDelete,
				listKeyPage: vi.fn().mockResolvedValue({ keys: [], isTruncated: false }),
				deleteKeys: vi.fn(async (_bucket, keys) => ({ deleted: [...keys], failures: [] })),
			},
			repository: productionOrphanRepository,
			references: createObjectReferenceResolver(
				client,
				{ publicBucket: 'public', protectedBucket: 'protected' },
				{ error: vi.fn() },
			),
			logger: { info: vi.fn(), error: vi.fn() },
		});

		await expect(createCaller().deleteAsset(
			assetId,
			{ id: userId, role: 'ADMIN' },
		)).resolves.toEqual({ projectId });
		await expect(client.orphanObject.count({ where: { bucket: 'protected', storageKey } }))
			.resolves.toBe(1);
		expect(wakeDeletionWorker).toHaveBeenCalledTimes(2);

		await expect(durableOrphanService.runOrphanReaper())
			.resolves.toMatchObject({ failed: 0 });
		await expect(client.orphanObject.findUniqueOrThrow({
			where: { orphan_bucket_storage_key: { bucket: 'protected', storageKey } },
		})).resolves.toMatchObject({ resolvedAt: reapNow });
		expect(recoveredDelete).toHaveBeenCalledWith(
			'protected',
			storageKey,
			expect.objectContaining({ requestTimeoutMs: 60_000 }),
		);
		await expect(durableOrphanService.runOrphanReaper())
			.resolves.toEqual({ tried: 0, resolved: 0, failed: 0 });
	});

	it('commits GAME replacement and its old-object outbox before waking deletion', async () => {
		const project = await createProjectFixture();
		const oldKey = `integration/orphan-durability/${testId}/game-old-${project.id}.zip`;
		const newKey = `integration/orphan-durability/${testId}/game-new-${project.id}.zip`;
		await client.asset.create({
			data: {
				projectId: project.id,
				kind: 'GAME',
				storageKey: oldKey,
				originalName: 'old.zip',
				mimeType: 'application/zip',
				sizeBytes: 4n,
				status: 'READY',
			},
		});
		const session = await client.gameUploadSession.create({
			data: {
				projectId: project.id,
				userId,
				uploadKind: 'GAME',
				originalName: 'new.zip',
				totalBytes: 4n,
				chunkSizeBytes: 4,
				totalChunks: 1,
				status: 'COMPLETING',
				completionClaimToken: 'game-finalize-owner',
				completionClaimUntil: new Date(Date.now() + 60_000),
				s3Key: newKey,
				expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			},
		});
		const wakeDeletionWorker = vi.fn();
		const finalizer = createCompletedUploadFinalizer({
			readHeader: async () => Buffer.from([0x50, 0x4b, 0x03, 0x04]),
			validateGameArchive: async () => {},
			deployWebgl: async () => { throw new Error('not used'); },
			rollbackWebglPublicDeployment: async () => {},
			finalizeGame: (completed) => gameUploadRepository.finalizeCompletedSession(
				completed.id,
				completed.projectId,
				'GAME',
				{
					storageKey: completed.s3Key,
					originalName: completed.originalName,
					mimeType: 'application/zip',
					sizeBytes: completed.totalBytes,
					isPublic: false,
					completionClaimToken: completed.completionClaimToken,
				},
				{
					bucket: protectedBucket,
					reason: 'game-upload-replace-previous',
					playbackReason: 'game-upload-replace-previous-playback',
				},
				client,
			),
			finalizeWebgl: async () => ({ oldEntryKey: '' }),
			wakeDeletionWorker,
			webglUrl: () => '',
			logError: vi.fn(),
		});

		await expect(finalizer.finalize({
			id: session.id,
			projectId: project.id,
			uploadKind: 'GAME',
			originalName: session.originalName,
			totalBytes: session.totalBytes,
			s3Key: newKey,
			completionClaimToken: 'game-finalize-owner',
		}, { size: 4 })).resolves.toMatchObject({ status: 'COMPLETED', storageKey: newKey });
		await expect(client.gameUploadSession.findUniqueOrThrow({ where: { id: session.id } }))
			.resolves.toMatchObject({ status: 'COMPLETED', storageKey: newKey });
		await expect(client.asset.findFirstOrThrow({
			where: { projectId: project.id, kind: 'GAME', status: 'READY' },
		}))
			.resolves.toMatchObject({ storageKey: newKey });
		await expect(client.orphanObject.count({ where: { bucket: protectedBucket, storageKey: oldKey } }))
			.resolves.toBe(1);
		expect(wakeDeletionWorker).toHaveBeenCalledOnce();
	});

	it('clears a superseded completed-session pointer in the generic GAME replacement transaction', async () => {
		const project = await createProjectFixture();
		const oldKey = `integration/orphan-durability/${testId}/generic-game-old-${project.id}.zip`;
		const newKey = `integration/orphan-durability/${testId}/generic-game-new-${project.id}.zip`;
		await client.asset.create({
			data: {
				projectId: project.id,
				kind: 'GAME',
				storageKey: oldKey,
				originalName: 'old.zip',
				mimeType: 'application/zip',
				sizeBytes: 8n,
				status: 'READY',
			},
		});
		const completed = await client.gameUploadSession.create({
			data: {
				projectId: project.id,
				userId,
				uploadKind: 'GAME',
				originalName: 'old.zip',
				totalBytes: 8n,
				chunkSizeBytes: 5 * 1024 * 1024,
				totalChunks: 1,
				status: 'COMPLETED',
				storageKey: oldKey,
				expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			},
		});

		await createProjectAssetMutationRepository(client).replaceOrCreateReplaceableAsset(
			project.id,
			'GAME',
			{
				storageKey: newKey,
				originalName: 'new.zip',
				mimeType: 'application/zip',
				sizeBytes: 16n,
				isPublic: false,
			},
			{
				bucket: protectedBucket,
				reason: 'generic-game-replace',
				playbackReason: 'generic-game-replace-playback',
			},
		);

		await expect(client.gameUploadSession.findUniqueOrThrow({ where: { id: completed.id } }))
			.resolves.toMatchObject({ status: 'COMPLETED', storageKey: null });
		await expect(client.orphanObject.findUniqueOrThrow({
			where: {
				orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: oldKey },
			},
		})).resolves.toMatchObject({ state: 'PENDING', reason: 'generic-game-replace' });
		await expect(client.asset.findFirstOrThrow({
			where: { projectId: project.id, kind: 'GAME', status: 'READY' },
		})).resolves.toMatchObject({ storageKey: newKey });
	});

	it('commits project deletion with exact and WebGL-prefix outbox rows before one coalesced wake', async () => {
		const deploymentId = randomUUID();
		const provisional = await createProjectFixture();
		const oldEntry = `webgl/${provisional.id}/${deploymentId}/site/index.html`;
		await client.project.update({ where: { id: provisional.id }, data: { webglEntryKey: oldEntry } });
		const assetKey = `integration/orphan-durability/${testId}/project-delete-${provisional.id}.png`;
		await client.asset.create({
			data: {
				projectId: provisional.id,
				kind: 'IMAGE',
				storageKey: assetKey,
				originalName: 'image.png',
				mimeType: 'image/png',
				sizeBytes: 8n,
			},
		});
		const wakeDeletionWorker = vi.fn();
		const wakeMaintenance = vi.fn();
		const service = createProjectService({
			repository: projectRepository,
			serializeProjectDetail: vi.fn(),
			deletionBuckets: { publicBucket, protectedBucket },
			abortMultipart: async () => {},
			wakeDeletionWorker,
			wakeMaintenance,
			logger: { error: vi.fn() },
		});

		await expect(service.deleteProject(provisional.id)).resolves.toBeUndefined();
		await expect(client.project.findUnique({ where: { id: provisional.id } })).resolves.toBeNull();
		const oldKeys = parseWebglEntryKey(provisional.id, oldEntry)!;
		await expect(client.orphanObject.count({
			where: {
				OR: [
					{ bucket: publicBucket, storageKey: assetKey },
					{ bucket: protectedBucket, storageKey: oldKeys.sourceKey },
					{ bucket: publicBucket, storageKey: oldKeys.sitePrefix },
				],
			},
		})).resolves.toBe(3);
		expect(wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(wakeMaintenance).toHaveBeenCalledOnce();
	});

	it('commits WebGL pointer/session state with source+prefix outbox before waking deletion', async () => {
		const project = await createProjectFixture();
		const oldDeployment = randomUUID();
		const newDeployment = randomUUID();
		const oldEntry = `webgl/${project.id}/${oldDeployment}/site/index.html`;
		await client.project.update({ where: { id: project.id }, data: { webglEntryKey: oldEntry } });
		const newSource = `webgl/${project.id}/${newDeployment}/source.zip`;
		const deployment = parseWebglSourceKey(project.id, newSource)!;
		const session = await client.gameUploadSession.create({
			data: {
				projectId: project.id,
				userId,
				uploadKind: 'WEBGL',
				originalName: 'webgl.zip',
				totalBytes: 4n,
				chunkSizeBytes: 4,
				totalChunks: 1,
				status: 'COMPLETING',
				completionClaimToken: 'webgl-finalize-owner',
				completionClaimUntil: new Date(Date.now() + 60_000),
				s3Key: newSource,
				expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			},
		});
		const wakeDeletionWorker = vi.fn();
		const finalizer = createCompletedUploadFinalizer({
			readHeader: async () => Buffer.from([0x50, 0x4b, 0x03, 0x04]),
			validateGameArchive: async () => {},
			deployWebgl: async () => deployment,
			rollbackWebglPublicDeployment: async () => {},
			finalizeGame: async () => ({ oldStorageKey: null, oldPlaybackStorageKey: null }),
			finalizeWebgl: (completed, deployed) => gameUploadRepository.finalizeCompletedWebglSession(
				completed.id,
				completed.projectId,
				deployed.entryKey,
				completed.s3Key,
				{ publicBucket, protectedBucket, reason: 'webgl-upload-replace-previous' },
				client,
				completed.completionClaimToken,
			),
			wakeDeletionWorker,
			webglUrl: () => '/webgl',
			logError: vi.fn(),
		});

		await expect(finalizer.finalize({
			id: session.id,
			projectId: project.id,
			uploadKind: 'WEBGL',
			originalName: session.originalName,
			totalBytes: session.totalBytes,
			s3Key: newSource,
			completionClaimToken: 'webgl-finalize-owner',
		}, { size: 4 })).resolves.toMatchObject({ status: 'COMPLETED', webglUrl: '/webgl' });
		await expect(client.project.findUniqueOrThrow({ where: { id: project.id } }))
			.resolves.toMatchObject({ webglEntryKey: deployment.entryKey });
		await expect(client.gameUploadSession.findUniqueOrThrow({ where: { id: session.id } }))
			.resolves.toMatchObject({ status: 'COMPLETED', storageKey: newSource });
		const oldKeys = parseWebglEntryKey(project.id, oldEntry)!;
		await expect(client.orphanObject.count({
			where: {
				OR: [
					{ bucket: protectedBucket, storageKey: oldKeys.sourceKey },
					{ bucket: publicBucket, storageKey: oldKeys.sitePrefix },
				],
			},
		})).resolves.toBe(2);
		expect(wakeDeletionWorker).toHaveBeenCalledOnce();
	});

	it('commits exhibition poster replacement and deletion outboxes before worker wakes', async () => {
		fixtureSequence += 1;
		const oldKey = `integration/orphan-durability/${testId}/poster-old-${fixtureSequence}.png`;
		const newKey = `integration/orphan-durability/${testId}/poster-new-${fixtureSequence}.png`;
		const exhibition = await client.exhibition.create({
			data: {
				year: 2100 + fixtureSequence,
				title: `Poster outbox ${testId}-${fixtureSequence}`,
				posterStorageKey: oldKey,
				posterOriginalName: 'old.png',
				posterMimeType: 'image/png',
				posterSizeBytes: 8n,
			},
		});
		const wakeDeletionWorker = vi.fn();
		const service = createExhibitionService({
			apiPublicUrl: 'https://api.example.test',
			posterBucket: publicBucket,
			repository: createExhibitionRepository(client),
			uploadLimits: () => ({
				posterMaxBytes: 1024,
				imageMaxBytes: 1024,
				gameMaxBytes: 1024,
				videoMaxBytes: 1024,
				requestMaxBytes: 1024,
				maxFiles: 1,
			}),
			uploadSlots: { acquire: vi.fn(), release: vi.fn() },
			posterUpload: {
				start: async () => ({
					savedFile: {
						storageKey: newKey,
						mimeType: 'image/png',
						sizeBytes: 16,
						originalName: 'new.png',
						kind: 'POSTER',
					},
					rollback: vi.fn(),
					cleanup: vi.fn(),
				}),
			},
			wakeDeletionWorker,
		});
		const parts = (async function* () {})();

		await expect(service.replacePoster(exhibition.id, {
			actor: { id: userId, role: 'ADMIN' },
			parts,
		})).resolves.toMatchObject({ id: exhibition.id });
		await expect(client.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } }))
			.resolves.toMatchObject({ posterStorageKey: newKey });
		await expect(client.orphanObject.count({ where: { bucket: publicBucket, storageKey: oldKey } }))
			.resolves.toBe(1);

		await expect(service.deleteExhibition(exhibition.id)).resolves.toBeUndefined();
		await expect(client.exhibition.findUnique({ where: { id: exhibition.id } })).resolves.toBeNull();
		await expect(client.orphanObject.count({ where: { bucket: publicBucket, storageKey: newKey } }))
			.resolves.toBe(1);
		expect(wakeDeletionWorker).toHaveBeenCalledTimes(2);
	});
});
