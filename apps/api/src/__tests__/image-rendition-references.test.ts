import { describe, expect, it, vi } from 'vitest';
import { collectObjectReferences } from '../modules/orphan/reference-resolver.js';

function delegate(rows: unknown[] = []) {
	return { findMany: vi.fn(async () => rows) };
}

describe('image rendition reference inventory', () => {
	it('takes exact live public image references from READY canonical representations', async () => {
		const inventory = await collectObjectReferences({
			asset: delegate([{
				id: 4,
				representations: [
					{ id: 'original', role: 'ORIGINAL', bucket: 'public', objectKey: 'images/4/original/g1.webp' },
					{ id: 'card', role: 'CARD_480', bucket: 'public', objectKey: 'images/4/card-480/g1.webp' },
				],
			}]),
			project: delegate(),
			assetUploadSession: delegate(),
			uploadIntent: delegate(),
		} as never, {
			publicBucket: 'public',
			protectedBucket: 'protected',
		}, { error: vi.fn() });

		expect(inventory.unsafeBuckets.size).toBe(0);
		expect(inventory.references).toContainEqual({
			bucket: 'public',
			targetKind: 'EXACT',
			key: 'images/4/card-480/g1.webp',
			source: 'asset:4:representation:CARD_480:card',
		});
		expect(inventory.references).toContainEqual({
			bucket: 'public',
			targetKind: 'EXACT',
			key: 'images/4/original/g1.webp',
			source: 'asset:4:representation:ORIGINAL:original',
		});
		expect(inventory.references).toHaveLength(2);
	});

	it('keeps an in-flight deterministic PUT protected through its upload intent', async () => {
		const key = 'images/4/card-480/pending.webp';
		const inventory = await collectObjectReferences({
			asset: delegate(),
			project: delegate(),
			assetUploadSession: delegate(),
			uploadIntent: delegate([{
				id: 'intent-1',
				bucket: 'public',
				storageKey: key,
			}]),
		} as never, {
			publicBucket: 'public',
			protectedBucket: 'protected',
		}, { error: vi.fn() });

		expect(inventory.references).toContainEqual({
			bucket: 'public',
			targetKind: 'EXACT',
			key,
			source: 'upload-intent:intent-1',
		});
	});

	it('uses an opaque representation object key without legacy key derivation', async () => {
		const logger = { error: vi.fn() };
		const malformedSource = 'x'.repeat(1_024);
		const inventory = await collectObjectReferences({
			asset: delegate([{
				id: 9,
				representations: [{
					id: 'opaque', role: 'ORIGINAL', bucket: 'public', objectKey: malformedSource,
				}],
			}]),
			project: delegate(),
			assetUploadSession: delegate(),
			uploadIntent: delegate(),
		} as never, {
			publicBucket: 'public',
			protectedBucket: 'protected',
		}, logger);

		expect(inventory.unsafeBuckets).toEqual(new Set());
		expect(inventory.references).toContainEqual({
			bucket: 'public',
			targetKind: 'EXACT',
			key: malformedSource,
			source: 'asset:9:representation:ORIGINAL:opaque',
		});
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('takes canonical representation bucket/key ownership without legacy locators', async () => {
		const inventory = await collectObjectReferences({
			asset: delegate([{
				id: 12,
				representations: [{
					id: 'rep-1',
					role: 'ORIGINAL',
					bucket: 'canonical-protected',
					objectKey: 'assets/12/original/g1',
				}],
			}]),
			project: delegate(),
			assetUploadSession: delegate(),
			uploadIntent: delegate(),
		} as never, {
			publicBucket: 'legacy-public',
			protectedBucket: 'legacy-protected',
		}, { error: vi.fn() });

		expect(inventory.references).toEqual([{
			bucket: 'canonical-protected',
			targetKind: 'EXACT',
			key: 'assets/12/original/g1',
			source: 'asset:12:representation:ORIGINAL:rep-1',
		}]);
	});
});
