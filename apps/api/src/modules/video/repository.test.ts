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
});
