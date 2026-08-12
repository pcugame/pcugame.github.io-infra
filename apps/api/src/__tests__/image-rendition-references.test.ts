import { describe, expect, it, vi } from 'vitest';
import {
	collectObjectReferences,
} from '../modules/orphan/reference-resolver.js';

function emptyDelegate() {
	return { findMany: vi.fn(async () => []) };
}

describe('image rendition reference inventory', () => {
	it('protects a malformed rendition exact key without marking the bucket unsafe', async () => {
		const logger = { error: vi.fn() };
		const inventory = await collectObjectReferences({
			asset: emptyDelegate(),
			exhibition: emptyDelegate(),
			project: emptyDelegate(),
			gameUploadSession: emptyDelegate(),
			uploadIntent: emptyDelegate(),
			imageRendition: {
				findMany: vi.fn(async () => [{
					id: 3,
					storageKey: 'stale-card.webp',
					sourceStorageKey: 'old.webp',
					assetId: 4,
					exhibitionId: null,
					asset: { storageKey: 'current.webp', status: 'READY' },
					exhibition: null,
				}]),
			},
		} as never, {
			publicBucket: 'public',
			protectedBucket: 'protected',
		}, logger);

		expect(inventory.unsafeBuckets.size).toBe(0);
		expect(inventory.references).toContainEqual({
			bucket: 'public',
			targetKind: 'EXACT',
			key: 'stale-card.webp',
			source: 'image-rendition:3:mismatched',
		});
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ renditionId: 3 }),
			expect.stringContaining('exact object deletion is disabled'),
		);
	});
});
