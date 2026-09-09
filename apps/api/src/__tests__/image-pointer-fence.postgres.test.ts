import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createPrismaImageWorkerRepository } from '../modules/image/prisma.repository.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

describe.runIf(runPostgresIntegration)('canonical processing persistence fences', () => {
	let client: PrismaClient;
	let actorId = 0;
	let exhibitionId = 0;
	let projectId = 0;
	const marker = randomUUID();
	const publicBucket = 'pcu-public';
	const protectedBucket = 'pcu-protected';

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required');
		client = createPrismaClientForDatabase(databaseUrl);
		await client.$connect();
		await client.storageBucket.upsert({
			where: { bucket: publicBucket },
			update: { visibility: 'PUBLIC' },
			create: { bucket: publicBucket, visibility: 'PUBLIC' },
		});
		await client.storageBucket.upsert({
			where: { bucket: protectedBucket },
			update: { visibility: 'PROTECTED' },
			create: { bucket: protectedBucket, visibility: 'PROTECTED' },
		});
		const actor = await client.user.create({ data: {
			googleSub: `image-fence-${marker}`, email: `image-fence-${marker}@example.test`,
			name: 'Image fence', role: 'ADMIN',
		} });
		actorId = actor.id;
		const exhibition = await client.exhibition.create({ data: {
			year: 30_000 + actor.id, title: `image-fence-${marker}`,
		} });
		exhibitionId = exhibition.id;
		const project = await client.project.create({ data: {
			exhibitionId, creatorId: actorId, slug: `image-fence-${marker}`, title: 'Image fence', status: 'PUBLISHED',
		} });
		projectId = project.id;
	});

	afterAll(async () => {
		if (!client) return;
		await client.orphanObject.deleteMany({ where: { bucket: { in: [publicBucket, protectedBucket] }, storageKey: { contains: marker } } }).catch(() => undefined);
		await client.uploadIntent.deleteMany({ where: { bucket: { in: [publicBucket, protectedBucket] }, storageKey: { contains: marker } } }).catch(() => undefined);
		if (projectId) {
			await client.assetUploadSession.deleteMany({ where: { projectId } }).catch(() => undefined);
			await client.project.deleteMany({ where: { id: projectId } }).catch(() => undefined);
		}
		if (exhibitionId) await client.exhibition.deleteMany({ where: { id: exhibitionId } }).catch(() => undefined);
		if (actorId) await client.user.deleteMany({ where: { id: actorId } }).catch(() => undefined);
		await client.$disconnect();
	});

	async function readyImage(label: string) {
		const asset = await client.asset.create({ data: {
			projectId, kind: 'IMAGE', status: 'PROCESSING', originalName: `${label}.webp`,
		} });
		for (const representation of [
			{ role: 'ORIGINAL' as const, key: `public/images/${label}/original`, sizeBytes: 10n },
			{ role: 'CARD_480' as const, key: `public/images/${label}/card`, sizeBytes: 8n },
			{ role: 'DISPLAY_960' as const, key: `public/images/${label}/display`, sizeBytes: 9n },
		]) await client.assetRepresentation.create({ data: {
			asset: { connect: { id: asset.id } }, role: representation.role,
			objectKey: representation.key, mimeType: 'image/webp', sizeBytes: representation.sizeBytes, state: 'READY',
			storageBucket: { connect: { bucket: publicBucket } },
		} });
		return client.asset.update({ where: { id: asset.id }, data: { status: 'READY' } });
	}

	it('commits zero stale representations after a manual poster selection wins', async () => {
		const expected = await readyImage(`${marker}-expected`);
		const manuallySelected = await readyImage(`${marker}-manual`);
		await client.project.update({ where: { id: projectId }, data: { posterAssetId: expected.id } });
		const resultAsset = await client.asset.create({ data: {
			projectId, kind: 'POSTER', status: 'PROCESSING', originalName: 'late.webp',
		} });
		const sessionId = randomUUID();
		const token = randomUUID();
		const leaseUntil = new Date(Date.now() + 5 * 60_000);
		await client.assetUploadSession.create({ data: {
			id: sessionId, projectId, userId: actorId, kind: 'POSTER', state: 'VERIFYING',
			originalName: 'late.webp', declaredMimeType: 'image/webp', totalBytes: 10n,
			partSizeBytes: 10, totalParts: 1, bucket: protectedBucket, objectKey: `protected/uploads/${marker}/source`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: '',
			validationLeaseToken: token, validationLeaseUntil: leaseUntil,
			expectedTargetAssetId: expected.id, expectedTargetAssetUpdatedAt: expected.updatedAt,
			resultAssetId: resultAsset.id, expiresAt: leaseUntil,
		} });
		const outputs = (['ORIGINAL', 'CARD_480', 'DISPLAY_960'] as const).map((role) => ({
			role, bucket: publicBucket, objectKey: `public/images/${marker}/late/${role}`, mimeType: 'image/webp' as const,
			sizeBytes: 10, width: 10, height: 10, checksumSha256: 'b'.repeat(64),
			intentId: randomUUID(),
		}));
		for (const output of outputs) await client.uploadIntent.create({ data: {
			id: output.intentId, bucket: publicBucket, storageKey: output.objectKey, purpose: 'direct-image-representation',
			ownerOperationId: sessionId, ownerActorId: actorId, ownerProjectId: projectId,
			state: 'UPLOADED', notBefore: new Date(Date.now() + 60_000),
		} });

		// This represents a manual/admin pointer mutation racing ahead of the late worker.
		await client.project.update({ where: { id: projectId }, data: { posterAssetId: manuallySelected.id } });
		const repository = createPrismaImageWorkerRepository(client, { publicBucket, protectedBucket });
		await expect(repository.commitReady({
			session: {
				id: sessionId, kind: 'POSTER', state: 'VERIFYING', owner: { type: 'PROJECT', id: String(projectId) },
				actorId: String(actorId), originalName: 'late.webp', declaredMimeType: 'image/webp', totalBytes: 10n,
				bucket: protectedBucket, objectKey: `protected/uploads/${marker}/source`, generation: 1,
				sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
				sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: '',
				validationAttemptCount: 1, expectedTargetAssetId: expected.id,
				expectedTargetAssetUpdatedAt: expected.updatedAt,
			},
			token, assetId: String(resultAsset.id), sourceCleanup: { bucket: protectedBucket, objectKey: `protected/uploads/${marker}/source` }, outputs,
		})).rejects.toThrow('POSTER_REPLACEMENT_FENCE_LOST');

		await expect(client.project.findUniqueOrThrow({ where: { id: projectId }, select: { posterAssetId: true } }))
			.resolves.toEqual({ posterAssetId: manuallySelected.id });
		await expect(client.assetRepresentation.count({ where: { assetId: resultAsset.id } })).resolves.toBe(0);
		await expect(client.uploadIntent.count({ where: {
			id: { in: outputs.map((output) => output.intentId) }, state: 'UPLOADED',
		} })).resolves.toBe(3);
	});

	it('terminalizes a GAME replacement fence and releases its active upload slot', async () => {
		const repository = createAssetUploadRepository(client);
		const sessionId = randomUUID();
		const token = randomUUID();
		const leaseUntil = new Date(Date.now() + 5 * 60_000);
		await client.assetUploadSession.create({ data: {
			id: sessionId, projectId, userId: actorId, kind: 'GAME', state: 'VERIFYING',
			originalName: 'late-game.zip', declaredMimeType: 'application/zip', totalBytes: 10n,
			partSizeBytes: 10, totalParts: 1, bucket: protectedBucket, objectKey: `protected/uploads/${marker}/late-game`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'c'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: '',
			validationLeaseToken: token, validationLeaseUntil: leaseUntil, expiresAt: leaseUntil,
		} });

		await expect(repository.markRejected(
			sessionId, 1, token, 'GAME_REPLACEMENT_FENCE_LOST',
		)).resolves.toBe(true);
		await expect(client.assetUploadSession.findUniqueOrThrow({ where: { id: sessionId } }))
			.resolves.toMatchObject({
				state: 'REJECTED', validationLeaseToken: null, validationLeaseUntil: null,
				validationError: 'GAME_REPLACEMENT_FENCE_LOST',
			});
		const nextId = randomUUID();
		await expect(client.assetUploadSession.create({ data: {
			id: nextId, projectId, userId: actorId, kind: 'GAME', state: 'ALLOCATING',
			originalName: 'next-game.zip', declaredMimeType: 'application/zip', totalBytes: 10n,
			partSizeBytes: 10, totalParts: 1, bucket: protectedBucket, objectKey: `protected/uploads/${marker}/next-game`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'd'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: '', expiresAt: leaseUntil,
		} })).resolves.toMatchObject({ id: nextId, state: 'ALLOCATING' });
		await client.assetUploadSession.delete({ where: { id: nextId } });
	});

	it('allows zero stale IMAGE writes after a validation lease takeover', async () => {
		const resultAsset = await client.asset.create({ data: {
			projectId, kind: 'IMAGE', status: 'PROCESSING', originalName: 'takeover.webp',
		} });
		const sessionId = randomUUID();
		const leaseUntil = new Date(Date.now() + 5 * 60_000);
		await client.assetUploadSession.create({ data: {
			id: sessionId, projectId, userId: actorId, kind: 'IMAGE', state: 'VERIFYING',
			originalName: 'takeover.webp', declaredMimeType: 'image/webp', totalBytes: 10n,
			partSizeBytes: 10, totalParts: 1, bucket: protectedBucket, objectKey: `protected/uploads/${marker}/takeover-source`, generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'e'.repeat(64),
			sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: '',
			validationLeaseToken: 'new-worker-token', validationLeaseUntil: leaseUntil,
			resultAssetId: resultAsset.id, expiresAt: leaseUntil,
		} });
		const repository = createPrismaImageWorkerRepository(client, { publicBucket, protectedBucket });
		await expect(repository.commitReady({
			session: {
				id: sessionId, kind: 'IMAGE', state: 'VERIFYING', owner: { type: 'PROJECT', id: String(projectId) },
				actorId: String(actorId), originalName: 'takeover.webp', declaredMimeType: 'image/webp', totalBytes: 10n,
				bucket: protectedBucket, objectKey: `protected/uploads/${marker}/takeover-source`, generation: 1,
				sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'e'.repeat(64),
				sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: '',
				validationAttemptCount: 2, expectedTargetAssetId: null, expectedTargetAssetUpdatedAt: null,
			},
			token: 'stale-worker-token', assetId: String(resultAsset.id),
			sourceCleanup: { bucket: protectedBucket, objectKey: `protected/uploads/${marker}/takeover-source` },
			outputs: [{
				role: 'ORIGINAL', bucket: publicBucket, objectKey: `public/images/${marker}/must-not-write`, mimeType: 'image/webp',
				sizeBytes: 10, width: 10, height: 10, checksumSha256: 'f'.repeat(64), intentId: randomUUID(),
			}],
		})).rejects.toThrow('Image processing lease lost');
		await expect(client.assetRepresentation.count({ where: { assetId: resultAsset.id } })).resolves.toBe(0);
		await expect(client.asset.findUniqueOrThrow({ where: { id: resultAsset.id } }))
			.resolves.toMatchObject({ status: 'PROCESSING' });
	});
});
