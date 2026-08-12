import { describe, expect, it, vi } from 'vitest';
import { collectObjectReferences } from '../modules/orphan/reference-resolver.js';
import { deriveImageRenditionStorageKey } from '../shared/responsive-image.js';

function delegate(rows: unknown[] = []) {
	return { findMany: vi.fn(async () => rows) };
}

describe('image rendition reference inventory', () => {
	it('derives exact live references only from owner readiness markers', async () => {
		const inventory = await collectObjectReferences({
			asset: delegate([{
				id: 4,
				storageKey: 'current.webp',
				playbackStorageKey: null,
				isPublic: true,
				card480Height: 240,
				display960Height: null,
			}]),
			exhibition: delegate([{
				id: 7,
				posterStorageKey: 'poster.webp',
				posterCard480Height: null,
				posterDisplay960Height: 480,
			}]),
			project: delegate(),
			gameUploadSession: delegate(),
			uploadIntent: delegate(),
		} as never, {
			publicBucket: 'public',
			protectedBucket: 'protected',
		}, { error: vi.fn() });

		expect(inventory.unsafeBuckets.size).toBe(0);
		expect(inventory.references).toContainEqual({
			bucket: 'public',
			targetKind: 'EXACT',
			key: deriveImageRenditionStorageKey('current.webp', 'CARD_480'),
			source: 'asset:4:rendition:CARD_480',
		});
		expect(inventory.references).toContainEqual({
			bucket: 'public',
			targetKind: 'EXACT',
			key: deriveImageRenditionStorageKey('poster.webp', 'DISPLAY_960'),
			source: 'exhibition:7:rendition:DISPLAY_960',
		});
		expect(inventory.references).not.toContainEqual(expect.objectContaining({
			key: deriveImageRenditionStorageKey('current.webp', 'DISPLAY_960'),
		}));
	});

	it('keeps an in-flight deterministic PUT protected through its upload intent', async () => {
		const key = deriveImageRenditionStorageKey('source.webp', 'CARD_480');
		const inventory = await collectObjectReferences({
			asset: delegate(),
			exhibition: delegate(),
			project: delegate(),
			gameUploadSession: delegate(),
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

	it('fails the public bucket closed when readiness points to an underivable key', async () => {
		const logger = { error: vi.fn() };
		const malformedSource = 'x'.repeat(1_024);
		const inventory = await collectObjectReferences({
			asset: delegate([{
				id: 9,
				storageKey: malformedSource,
				playbackStorageKey: null,
				isPublic: true,
				card480Height: 240,
				display960Height: null,
			}]),
			exhibition: delegate(),
			project: delegate(),
			gameUploadSession: delegate(),
			uploadIntent: delegate(),
		} as never, {
			publicBucket: 'public',
			protectedBucket: 'protected',
		}, logger);

		expect(inventory.unsafeBuckets).toEqual(new Set(['public']));
		expect(inventory.references).toContainEqual({
			bucket: 'public',
			targetKind: 'EXACT',
			key: malformedSource,
			source: 'asset:9:original',
		});
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				assetId: 9,
				storageKey: malformedSource,
				profile: 'CARD_480',
				error: expect.any(Error),
			}),
			expect.stringContaining('public bucket deletion is disabled'),
		);
	});
});
