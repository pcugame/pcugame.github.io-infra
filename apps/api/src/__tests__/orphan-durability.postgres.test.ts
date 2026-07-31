import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createObjectDeletionCoordinator } from '../application/object-deletion.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
import { createAssetsService } from '../modules/assets/service.js';
import { createCompletedUploadFinalizer } from '../modules/admin/game-upload/finalize-completed-upload.service.js';
import * as gameUploadRepository from '../modules/admin/game-upload/repository.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createProjectService } from '../modules/admin/project/service.js';
import { createExhibitionRepository } from '../modules/admin/year/repository.js';
import { createExhibitionService } from '../modules/admin/year/service.js';
import { createOrphanRepository } from '../modules/orphan/repository.js';
import { createOrphanService } from '../modules/orphan/service.js';
import { parseWebglEntryKey, parseWebglSourceKey } from '../modules/webgl/paths.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

describe.runIf(runPostgresIntegration)('orphan durability with production PostgreSQL repositories', () => {
	let client: PrismaClient;
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

	function postCommitFailureCoordinator() {
		const record = vi.fn().mockRejectedValue(new Error('forced post-commit queue failure'));
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn().mockRejectedValue(new Error('forced post-commit S3 failure')),
				listKeys: vi.fn().mockRejectedValue(new Error('forced post-commit S3 list failure')),
			},
			orphans: { record },
			logger: { error: vi.fn() },
		});
		return { coordinator, record };
	}

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

	function queuedWebglDelete(
		coordinator: ReturnType<typeof createObjectDeletionCoordinator>,
		project: number,
		entryKey: string,
		reason: string,
	) {
		const keys = parseWebglEntryKey(project, entryKey);
		if (!keys) throw new Error(`Malformed test WebGL entry key for project ${project}`);
		return Promise.all([
			coordinator.deleteDurablyQueued(protectedBucket, keys.sourceKey, `${reason}-source`),
			coordinator.deleteDurablyQueuedPrefix(publicBucket, keys.sitePrefix, `${reason}-site`),
		]).then(() => undefined);
	}

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		client = createPrismaClientForDatabase(databaseUrl);
		await client.$connect();
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
		await client.$disconnect();
	});

	it('keeps the caller non-terminal on S3+queue failure and converges idempotently on retry', async () => {
		const assetsRepository = createAssetsRepository(client);
		const productionOrphanRepository = createOrphanRepository(client);
		const queueFailure = new Error('forced orphan transaction rollback');
		const failingOrphanService = createOrphanService({
			clock: { now: () => new Date() },
			storage: { delete: vi.fn() },
			repository: {
				...productionOrphanRepository,
				upsertOrphan: (bucket, key, reason) => client.$transaction(async (tx) => {
					const transactionalRepository = createOrphanRepository(tx);
					await transactionalRepository.upsertOrphan(bucket, key, reason);
					throw queueFailure;
				}),
			},
			logger: { info: vi.fn(), error: vi.fn() },
		});
		const storageDelete = vi.fn().mockRejectedValue(new Error('forced S3 delete failure'));
		const failingCoordinator = createObjectDeletionCoordinator({
			storage: { delete: storageDelete, listKeys: vi.fn() },
			orphans: { record: failingOrphanService.recordOrphan },
			logger: { error: vi.fn() },
		});
		const createCaller = (deleteOrQueue: typeof failingCoordinator.deleteOrQueue) => createAssetsService({
			publicBucket: 'public',
			protectedBucket: 'protected',
			presign: vi.fn(),
			bucketForKind: () => 'protected',
			deleteOrQueue,
			loadProjectWithAccess: vi.fn().mockResolvedValue(undefined),
			downloadLimiter: { check: vi.fn().mockReturnValue('ok') },
			logger: { info: vi.fn(), error: vi.fn() },
			repository: assetsRepository,
		});

		await expect(createCaller(failingCoordinator.deleteOrQueue).deleteAsset(
			assetId,
			{ id: userId, role: 'ADMIN' },
		)).rejects.toMatchObject({
			name: 'DurableObjectDeletionError',
			queueError: queueFailure,
		});

		await expect(client.asset.findUniqueOrThrow({ where: { id: assetId } }))
			.resolves.toMatchObject({ status: 'DELETING', storageKey });
		await expect(client.orphanObject.count({ where: { bucket: 'protected', storageKey } }))
			.resolves.toBe(0);

		const durableOrphanService = createOrphanService({
			clock: { now: () => new Date('2026-07-22T00:00:00.000Z') },
			storage: {
				delete: vi.fn().mockResolvedValue(undefined),
				listKeys: vi.fn().mockResolvedValue([]),
			},
			repository: productionOrphanRepository,
			logger: { info: vi.fn(), error: vi.fn() },
		});
		const retryCoordinator = createObjectDeletionCoordinator({
			storage: { delete: storageDelete, listKeys: vi.fn() },
			orphans: { record: durableOrphanService.recordOrphan },
			logger: { error: vi.fn() },
		});

		await expect(createCaller(retryCoordinator.deleteOrQueue).deleteAsset(
			assetId,
			{ id: userId, role: 'ADMIN' },
		)).resolves.toEqual({ projectId });
		await expect(client.asset.findUniqueOrThrow({ where: { id: assetId } }))
			.resolves.toMatchObject({ status: 'DELETED' });
		await expect(client.orphanObject.count({ where: { bucket: 'protected', storageKey } }))
			.resolves.toBe(1);

		await Promise.all([
			durableOrphanService.recordOrphan('protected', storageKey, 'asset-delete-retry'),
			durableOrphanService.recordOrphan('protected', storageKey, 'asset-delete-retry'),
		]);
		await expect(client.orphanObject.count({ where: { bucket: 'protected', storageKey } }))
			.resolves.toBe(1);

		await expect(durableOrphanService.runOrphanReaper())
			.resolves.toMatchObject({ failed: 0 });
		await expect(client.orphanObject.findUniqueOrThrow({
			where: { orphan_bucket_storage_key: { bucket: 'protected', storageKey } },
		})).resolves.toMatchObject({ resolvedAt: new Date('2026-07-22T00:00:00.000Z') });
		await expect(durableOrphanService.runOrphanReaper())
			.resolves.toEqual({ tried: 0, resolved: 0, failed: 0 });
	});

	it('commits GAME replacement and its old-object outbox before post-commit S3+queue failure', async () => {
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
				s3Key: newKey,
				expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			},
		});
		const { coordinator, record } = postCommitFailureCoordinator();
		const finalizer = createCompletedUploadFinalizer({
			readHeader: async () => Buffer.from([0x50, 0x4b, 0x03, 0x04]),
			validateGameArchive: async () => {},
			deployWebgl: async () => { throw new Error('not used'); },
			rollbackWebglPublicDeployment: async () => {},
			deleteWebglDeploymentByEntry: async () => {},
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
				},
				{
					bucket: protectedBucket,
					reason: 'game-upload-replace-previous',
					playbackReason: 'game-upload-replace-previous-playback',
				},
				client,
			),
			finalizeWebgl: async () => ({ oldEntryKey: '' }),
			deleteOrQueue: (key, reason, context) => coordinator.deleteDurablyQueued(
				protectedBucket,
				key,
				reason,
				context,
			),
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
		}, { size: 4 })).resolves.toMatchObject({ status: 'COMPLETED', storageKey: newKey });
		await expect(client.gameUploadSession.findUniqueOrThrow({ where: { id: session.id } }))
			.resolves.toMatchObject({ status: 'COMPLETED', storageKey: newKey });
		await expect(client.asset.findFirstOrThrow({
			where: { projectId: project.id, kind: 'GAME', status: 'READY' },
		}))
			.resolves.toMatchObject({ storageKey: newKey });
		await expect(client.orphanObject.count({ where: { bucket: protectedBucket, storageKey: oldKey } }))
			.resolves.toBe(1);
		expect(record).not.toHaveBeenCalled();
	});

	it('commits project deletion with exact and WebGL-prefix outbox rows before cleanup failure', async () => {
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
		const { coordinator, record } = postCommitFailureCoordinator();
		const service = createProjectService({
			repository: projectRepository,
			serializeProjectDetail: vi.fn(),
			deletionBuckets: { publicBucket, protectedBucket },
			deleteAssetObjects: async (asset, reason) => {
				await coordinator.deleteDurablyQueued(publicBucket, asset.storageKey, reason);
			},
			abortMultipart: async () => {},
			deleteWebglDeploymentByEntry: (project, entry, reason) => queuedWebglDelete(
				coordinator,
				project,
				entry,
				reason,
			),
			deleteWebglDeployment: async (keys, reason) => {
				await queuedWebglDelete(coordinator, keys.projectId, keys.entryKey, reason);
			},
			deleteQueuedProtectedObject: (key, reason, context) => coordinator.deleteDurablyQueued(
				protectedBucket,
				key,
				reason,
				context,
			),
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
		expect(record).not.toHaveBeenCalled();
	});

	it('commits WebGL pointer/session terminal state with source+prefix outbox before cleanup failure', async () => {
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
				s3Key: newSource,
				expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			},
		});
		const { coordinator, record } = postCommitFailureCoordinator();
		const finalizer = createCompletedUploadFinalizer({
			readHeader: async () => Buffer.from([0x50, 0x4b, 0x03, 0x04]),
			validateGameArchive: async () => {},
			deployWebgl: async () => deployment,
			rollbackWebglPublicDeployment: async () => {},
			deleteWebglDeploymentByEntry: (projectId, entry, reason) => queuedWebglDelete(
				coordinator,
				projectId,
				entry,
				reason,
			),
			finalizeGame: async () => ({ oldStorageKey: null, oldPlaybackStorageKey: null }),
			finalizeWebgl: (completed, deployed) => gameUploadRepository.finalizeCompletedWebglSession(
				completed.id,
				completed.projectId,
				deployed.entryKey,
				completed.s3Key,
				{ publicBucket, protectedBucket, reason: 'webgl-upload-replace-previous' },
				client,
			),
			deleteOrQueue: async () => {},
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
		expect(record).not.toHaveBeenCalled();
	});

	it('commits exhibition poster replacement and deletion outboxes before cleanup failure', async () => {
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
		const { coordinator, record } = postCommitFailureCoordinator();
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
			deleteOrQueue: (bucket, key, reason, context) => coordinator.deleteDurablyQueued(
				bucket,
				key,
				reason,
				context,
			),
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
		expect(record).not.toHaveBeenCalled();
	});
});
