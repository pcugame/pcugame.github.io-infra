import { describe, expect, it, vi } from 'vitest';

import { collectObjectReferences, createObjectReferenceIndex } from '../modules/orphan/reference-resolver.js';

const deployment = '11111111-1111-4111-8111-111111111111';

function clientForActiveWebgl(s3Key: string) {
	return {
		asset: { findMany: vi.fn().mockResolvedValue([]) },
		exhibition: { findMany: vi.fn().mockResolvedValue([]) },
		project: { findMany: vi.fn().mockResolvedValue([]) },
		gameUploadSession: {
			findMany: vi.fn(async (query: { where: { status: unknown } }) =>
				query.where.status === 'COMPLETED'
					? []
					: [{ id: 'active', s3Key, uploadKind: 'WEBGL', projectId: 7 }]),
		},
		uploadIntent: { findMany: vi.fn().mockResolvedValue([]) },
	};
}

describe('active WebGL prefix reference fence (#29)', () => {
	it('publishes an active WebGL site PREFIX reference that blocks an overlapping reaper claim', async () => {
		const inventory = await collectObjectReferences(
			clientForActiveWebgl(`webgl/7/${deployment}/source.zip`) as never,
			{ publicBucket: 'public', protectedBucket: 'protected' }, { error: vi.fn() },
		);
		expect(inventory.references).toContainEqual({
			bucket: 'public', targetKind: 'PREFIX', key: `webgl/7/${deployment}/site/`,
			source: 'upload-session:active:webgl-site',
		});
		const index = createObjectReferenceIndex(inventory);
		expect(index.referencesTarget({
			bucket: 'public', targetKind: 'PREFIX', key: `webgl/7/${deployment}/site/`,
		})).toBe(true);
	});

	it('fails closed for malformed active WebGL identity in both buckets', async () => {
		const logger = { error: vi.fn() };
		const inventory = await collectObjectReferences(
			clientForActiveWebgl('webgl/7/not-a-deployment/source.zip') as never,
			{ publicBucket: 'public', protectedBucket: 'protected' }, logger,
		);
		expect(inventory.unsafeBuckets).toEqual(new Set(['protected', 'public']));
		expect(createObjectReferenceIndex(inventory).referencesTarget({
			bucket: 'public', targetKind: 'PREFIX', key: 'unrelated/',
		})).toBe(true);
		expect(logger.error).toHaveBeenCalledOnce();
	});
});
