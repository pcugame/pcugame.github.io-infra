import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import { createVideoWorkerRepository } from '../modules/video/repository.js';

describe('canonical representation provenance repositories', () => {
	it('commits GAME source identity, ETag, checksum, bucket, and size on ORIGINAL', async () => {
		const session = {
			id: 'game-session', projectId: 7, kind: 'GAME', state: 'VERIFYING',
			bucket: 'protected-source', objectKey: 'protected/uploads/game-session/g1/source',
			originalName: 'game.zip', totalBytes: 1234n,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'source-root',
			expectedTargetAssetId: null, expectedTargetAssetUpdatedAt: null,
			completionResult: { status: 'VERIFYING', etag: 'garage-etag' }, userId: 1,
		};
		const representationUpdate = vi.fn(async () => ({}));
		const assetCreate = vi.fn(async ({ data }: { data: Record<string, any> }) => ({
			id: 81,
			representations: [{
				id: 'game-original', role: 'ORIGINAL',
				...(data.representations as { create: Record<string, unknown>[] }).create[0],
			}],
		}));
		const tx = {
			user: { findUniqueOrThrow: vi.fn(async () => ({ id: 1, role: 'USER' })) },
			project: {
				findUnique: vi.fn(async () => ({ creatorId: 1, exhibitionId: 1, exhibition: { isModificationEnabled: true }, changeRequestDraft: null })),
				findUniqueOrThrow: vi.fn(async () => ({ creatorId: 1, exhibitionId: 1, exhibition: { isModificationEnabled: true } })),
				update: vi.fn(async () => ({})),
			},
			exhibition: { findUniqueOrThrow: vi.fn(async () => ({ isModificationEnabled: true })) },
			assetUploadSession: {
				findUnique: vi.fn(async () => session),
				update: vi.fn(async () => ({})),
			},
			asset: { findFirst: vi.fn(async () => null), create: assetCreate },
			assetRepresentation: { update: representationUpdate },
			$queryRaw: vi.fn(async () => [{ id: session.id }]),
		};
		const repository = createAssetUploadRepository({
			$transaction: vi.fn(async (operation) => operation(tx)),
		} as unknown as PrismaClient);

		await repository.commitGameReady({
			session: session as never, token: 'lease', mimeType: 'application/zip', checksum: 'decoded-sha256',
		});

		const representation = (assetCreate.mock.calls[0]![0].data.representations as { create: Record<string, unknown>[] }).create[0];
		expect(representation).toMatchObject({
			role: 'ORIGINAL', storageBucket: { connect: { bucket: 'protected-source' } },
			objectKey: 'protected/uploads/game-session/g1/source', sizeBytes: 1234n,
		});
		expect(representationUpdate).toHaveBeenCalledWith({
			where: { id: 'game-original' },
			data: {
				sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'source-root',
				etag: 'garage-etag', checksumAlgorithm: 'SHA256', checksum: 'decoded-sha256',
			},
		});
	});

	it('queues cross-bucket VIDEO playback cleanup from durable intent ownership', async () => {
		const orphanUpsert = vi.fn(async () => ({}));
		const tx = {
			uploadIntent: {
				findUnique: vi.fn(async () => ({ bucket: 'protected-playback', storageKey: 'video/asset/g1/playback.mp4' })),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			orphanObject: { upsert: orphanUpsert },
			$queryRaw: vi.fn()
				.mockResolvedValueOnce([{ id: 'video-session' }])
				.mockResolvedValue([]),
		};
		const repository = createVideoWorkerRepository({
			$transaction: vi.fn(async (operation) => operation(tx)),
		} as unknown as PrismaClient);

		await repository.rejectVideo({
			session: {
				id: 'video-session', projectId: 7, userId: 9, kind: 'VIDEO', state: 'VERIFYING',
				bucket: 'protected-source', objectKey: 'uploads/video/source',
			} as never,
			token: 'lease', reason: 'CORRUPT_MEDIA', playbackIntentId: 'intent-playback',
			playbackObjectKey: 'wrong-fallback-key',
		});

		expect(orphanUpsert).toHaveBeenCalledTimes(2);
		expect(orphanUpsert).toHaveBeenCalledWith(expect.objectContaining({
			create: expect.objectContaining({ bucket: 'protected-source', storageKey: 'uploads/video/source' }),
		}));
		expect(orphanUpsert).toHaveBeenCalledWith(expect.objectContaining({
			create: expect.objectContaining({ bucket: 'protected-playback', storageKey: 'video/asset/g1/playback.mp4' }),
		}));
	});
});
