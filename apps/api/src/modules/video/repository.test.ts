import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createVideoWorkerRepository } from './repository.js';

function verifyingSession(owner: { projectId: number | null; exhibitionId: number | null }) {
	return {
		id: 'video-session',
		...owner,
		userId: 9,
		kind: 'VIDEO',
		state: 'VERIFYING',
		originalName: 'source.mov',
		declaredMimeType: 'video/quicktime',
		totalBytes: 1024n,
		bucket: 'protected',
		objectKey: 'protected/uploads/video-session/g1/source',
		generation: 1,
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
		sourceIdentity: 'source-root',
		sourceIdentityBlockSizeBytes: 1024,
		sourceIdentityBlockManifest: {},
		validationLeaseToken: 'video-lease',
		validationLeaseUntil: new Date('2030-01-01T00:00:00.000Z'),
		resultAssetId: null,
		resultRepresentationId: null,
		completionResult: null,
	};
}

describe('video worker repository ownership fencing', () => {
	it('filters kind and project ownership before the claim limit', async () => {
		const queryRaw = vi.fn(async (_query: unknown) => [{ id: 'video-session' }]);
		const findMany = vi.fn(async () => [verifyingSession({ projectId: 7, exhibitionId: null })]);
		const repository = createVideoWorkerRepository({
			$queryRaw: queryRaw,
			assetUploadSession: { findMany },
		} as unknown as PrismaClient);

		const claimed = await repository.claimVideoVerifying(4, 'video-lease', 30_000);

		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.projectId).toBe(7);
		const statement = queryRaw.mock.calls[0]?.[0] as { sql: string };
		expect(statement.sql).toContain('"kind" = \'VIDEO\'::"AssetUploadKind"');
		expect(statement.sql).toContain('"project_id" IS NOT NULL');
		expect(statement.sql).toContain('"exhibition_id" IS NULL');
		expect(statement.sql.indexOf('"project_id" IS NOT NULL')).toBeLessThan(statement.sql.indexOf('LIMIT'));
		expect(findMany).toHaveBeenCalledWith({
			where: {
				id: { in: ['video-session'] },
				kind: 'VIDEO',
				state: 'VERIFYING',
				projectId: { not: null },
				exhibitionId: null,
				validationLeaseToken: 'video-lease',
			},
		});
	});

	it('rejects an exhibition-owned row returned across the claim boundary', async () => {
		const repository = createVideoWorkerRepository({
			$queryRaw: vi.fn(async (_query: unknown) => [{ id: 'exhibition-video-session' }]),
			assetUploadSession: {
				findMany: vi.fn(async () => [verifyingSession({ projectId: null, exhibitionId: 3 })]),
			},
		} as unknown as PrismaClient);

		await expect(repository.claimVideoVerifying(1, 'video-lease', 30_000)).rejects.toThrow(
			'Claimed VIDEO upload session must be project-owned and VERIFYING',
		);
	});

	it('never terminal-rejects or cleans a source after ORIGINAL ownership was committed', async () => {
		const queryRaw = vi.fn(async (_query: unknown) => []);
		const tx = {
			uploadIntent: { findUnique: vi.fn() },
			$queryRaw: queryRaw,
		};
		const repository = createVideoWorkerRepository({
			$transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
		} as unknown as PrismaClient);
		const session = {
			...verifyingSession({ projectId: 7, exhibitionId: null }),
			resultAssetId: 42,
			resultRepresentationId: 'original-42',
		};

		await expect(repository.rejectVideo({
			session: session as never,
			token: 'video-lease',
			reason: 'CORRUPT_MEDIA: stale retry',
		})).resolves.toBe(false);

		const statement = queryRaw.mock.calls[0]?.[0] as { sql: string };
		expect(statement.sql).toContain('"result_asset_id" IS NULL');
		expect(statement.sql).toContain('"result_representation_id" IS NULL');
	});

	it('repairs only a fenced FAILED PLAYBACK representation and leaves ORIGINAL untouched', async () => {
		const original = {
			id: 'original-42', role: 'ORIGINAL', state: 'READY',
			bucket: 'protected', objectKey: 'protected/uploads/video-session/g1/source',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'source-root',
		};
		const playback = {
			id: 'playback-42', role: 'PLAYBACK', state: 'FAILED', bucket: 'protected',
			objectKey: 'protected/assets/video/7/dmlkZW8tc2Vzc2lvbg/g1/playback.mp4',
		};
		const representationUpdate = vi.fn(async () => playback);
		const sessionUpdate = vi.fn(async () => ({}));
		const tx = {
			$queryRaw: vi.fn(async () => [{ id: 'video-session' }]),
			assetUploadSession: {
				findUnique: vi.fn(async () => ({
					...verifyingSession({ projectId: 7, exhibitionId: null }),
					state: 'READY', resultAssetId: 42, resultRepresentationId: original.id,
				})),
				update: sessionUpdate,
			},
			asset: {
				findUnique: vi.fn(async () => ({
					id: 42, projectId: 7, kind: 'VIDEO', status: 'READY',
					representations: [original, playback],
				})),
			},
			assetRepresentation: { update: representationUpdate },
		};
		const repository = createVideoWorkerRepository({
			$transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
		} as unknown as PrismaClient);

		await expect(repository.requestPlaybackRepair({
			sessionId: 'video-session',
			generation: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
			sourceIdentity: 'source-root',
		})).resolves.toBe(true);

		expect(representationUpdate).toHaveBeenCalledOnce();
		expect(representationUpdate).toHaveBeenCalledWith({
			where: { id: 'playback-42' },
			data: { state: 'VERIFYING', error: null },
		});
		expect(sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
			data: expect.objectContaining({ state: 'VERIFYING' }),
		}));
	});

	it('commits the locally verified SHA-256 on a generated PLAYBACK representation', async () => {
		const session = {
			...verifyingSession({ projectId: 7, exhibitionId: null }),
			resultAssetId: 42,
			resultRepresentationId: 'original-42',
		};
		const original = {
			id: 'original-42', role: 'ORIGINAL', state: 'READY', etag: 'source-etag',
			bucket: session.bucket, objectKey: session.objectKey,
			sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
			sourceIdentity: session.sourceIdentity,
		};
		const playback = {
			id: 'playback-42', role: 'PLAYBACK', state: 'VERIFYING',
			bucket: 'protected', objectKey: 'protected/assets/video/7/session/g1/playback.mp4',
		};
		const representationUpdate = vi.fn(async () => playback);
		const tx = {
			assetUploadSession: {
				findUnique: vi.fn(async () => session),
				update: vi.fn(async () => ({})),
			},
			asset: { findUnique: vi.fn(async () => ({
				id: 42, projectId: 7, kind: 'VIDEO', status: 'READY',
				representations: [original, playback],
			})) },
			assetRepresentation: { update: representationUpdate },
			uploadIntent: {
				findMany: vi.fn(async () => [{
					id: 'intent-1', bucket: playback.bucket, storageKey: playback.objectKey,
				}]),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			$queryRaw: vi.fn(async () => [{ id: session.id }]),
		};
		const repository = createVideoWorkerRepository({
			$transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
		} as unknown as PrismaClient);
		const checksum = 'a'.repeat(64);

		await repository.commitVideoPlaybackReady({
			session: session as never,
			token: 'video-lease',
			assetId: 42,
			originalRepresentationId: original.id,
			playbackRepresentationId: playback.id,
			playback: {
				bucket: playback.bucket,
				objectKey: playback.objectKey,
				mimeType: 'video/mp4',
				sizeBytes: 128n,
				checksumSha256: checksum,
				intentId: 'intent-1',
			},
		});

		expect(representationUpdate).toHaveBeenCalledWith({
			where: { id: playback.id },
			data: expect.objectContaining({
				state: 'READY', checksumAlgorithm: 'SHA256', checksum,
			}),
		});
	});
});
