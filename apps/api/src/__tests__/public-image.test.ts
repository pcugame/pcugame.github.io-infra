import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPublicImageService } from '../modules/public/image.service.js';
import { createPublicRepository } from '../modules/public/repository.js';
import {
	createResponsiveImageSerializer,
	deriveImageRenditionStorageKey,
} from '../shared/responsive-image.js';

describe('responsive image serializer', () => {
	it('advertises only ready, applicable deterministic renditions', () => {
		const { serializeResponsiveImage } = createResponsiveImageSerializer('https://api.example.test/');
		expect(serializeResponsiveImage({
			storageKey: 'original key.webp',
			width: 1400,
			height: 700,
			card480Height: 240,
			display960Height: 480,
		})).toEqual({
			original: {
				url: 'https://api.example.test/api/public/images/original%20key.webp',
				width: 1400,
				height: 700,
			},
			renditions: [
				{
					profile: 'CARD_480',
					url: `https://api.example.test/api/public/images/${encodeURIComponent(
						deriveImageRenditionStorageKey('original key.webp', 'CARD_480'),
					)}`,
					width: 480,
					height: 240,
				},
				{
					profile: 'DISPLAY_960',
					url: `https://api.example.test/api/public/images/${encodeURIComponent(
						deriveImageRenditionStorageKey('original key.webp', 'DISPLAY_960'),
					)}`,
					width: 960,
					height: 480,
				},
			],
		});
	});

	it('keeps a legacy original as a valid fallback without dimensions or renditions', () => {
		const { serializeResponsiveImage } = createResponsiveImageSerializer('https://api.example.test');
		expect(serializeResponsiveImage({ storageKey: 'legacy.webp' })).toEqual({
			original: { url: 'https://api.example.test/api/public/images/legacy.webp' },
			renditions: [],
		});
	});
});

describe('public image storage response', () => {
	const storageKey = 'current.webp';
	const lastModified = new Date('2026-08-12T01:02:03.456Z');
	const repository = { resolvePublicImage: vi.fn() };
	const storage = { head: vi.fn(), stream: vi.fn() };
	const logger = { error: vi.fn() };
	const service = createPublicImageService({
		publicBucket: 'public',
		repository,
		storage,
		logger,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		repository.resolvePublicImage.mockResolvedValue({ storageKey });
		storage.head.mockResolvedValue({
			size: 4,
			contentType: 'image/webp',
			cacheControl: 'storage-policy',
			etag: '"etag-1"',
			lastModified,
		});
		storage.stream.mockResolvedValue({
			body: Readable.from([Buffer.from('webp')]),
			size: 4,
			contentType: 'image/webp',
			etag: '"etag-1"',
			lastModified,
		});
	});

	it('streams an unconditional GET with immutable representation metadata and no HEAD', async () => {
		const response = await service.get(storageKey);
		expect(response).toMatchObject({
			status: 200,
			headers: {
				'Cache-Control': 'public, max-age=31536000, immutable',
				'Content-Type': 'image/webp',
				'Content-Length': '4',
				ETag: '"etag-1"',
				'Last-Modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
			},
			body: expect.any(Readable),
		});
		expect(storage.head).not.toHaveBeenCalled();
		expect(storage.stream).toHaveBeenCalledWith('public', storageKey);
	});

	it('serves HEAD metadata without opening the object body', async () => {
		await expect(service.head(storageKey)).resolves.toMatchObject({
			status: 200,
			headers: { 'Content-Length': '4', 'Content-Type': 'image/webp' },
		});
		expect(storage.stream).not.toHaveBeenCalled();
	});

	it.each([
		[{ ifNoneMatch: 'W/"other", W/"etag-1"' }, 'etag'],
		[{ ifNoneMatch: '*' }, 'wildcard'],
		[{ ifModifiedSince: 'Wed, 12 Aug 2026 01:02:03 GMT' }, 'modified date'],
	] as const)('returns bodyless 304 for a matching %s validator', async (headers, _label) => {
		await expect(service.get(storageKey, headers)).resolves.toMatchObject({ status: 304 });
		expect(storage.stream).not.toHaveBeenCalled();
	});

	it('gives If-None-Match precedence over If-Modified-Since', async () => {
		await expect(service.get(storageKey, {
			ifNoneMatch: '"different"',
			ifModifiedSince: 'Wed, 12 Aug 2026 01:02:03 GMT',
		})).resolves.toMatchObject({ status: 200 });
		expect(storage.head).toHaveBeenCalledOnce();
		expect(storage.stream).toHaveBeenCalledOnce();
	});

	it('rejects unreferenced and physically missing objects without probing unauthorized keys', async () => {
		repository.resolvePublicImage.mockResolvedValueOnce(null);
		await expect(service.get('unreferenced.webp')).rejects.toMatchObject({ statusCode: 404 });
		expect(storage.head).not.toHaveBeenCalled();
		expect(storage.stream).not.toHaveBeenCalled();

		storage.stream.mockResolvedValueOnce(null);
		await expect(service.get(storageKey)).rejects.toMatchObject({ statusCode: 404 });
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ storageKey, bucket: 'public' }),
			expect.stringContaining('database reference'),
		);
	});

	it('propagates storage failures instead of disguising them as 404', async () => {
		const storageFailure = new Error('storage unavailable');
		storage.stream.mockRejectedValueOnce(storageFailure);
		await expect(service.get(storageKey)).rejects.toBe(storageFailure);
	});

	it('fails closed if immutable metadata changes between HEAD and GET', async () => {
		storage.stream.mockResolvedValueOnce({
			body: Readable.from([Buffer.from('changed')]),
			size: 7,
			contentType: 'image/webp',
		});
		await expect(service.get(storageKey, { ifNoneMatch: '"different"' })).rejects.toThrow(
			'Immutable public image changed during streaming',
		);
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ headSize: 4, streamSize: 7 }),
			expect.stringContaining('metadata changed'),
		);
	});
});

describe('public image reference resolver', () => {
	const assetFindFirst = vi.fn();
	const exhibitionFindUnique = vi.fn();
	const repository = createPublicRepository({
		asset: { findFirst: assetFindFirst },
		exhibition: { findUnique: exhibitionFindUnique },
	} as unknown as PrismaClient);

	beforeEach(() => {
		vi.clearAllMocks();
		assetFindFirst.mockResolvedValue(null);
		exhibitionFindUnique.mockResolvedValue(null);
	});

	it('allows public READY image canonical objects and excludes protected kinds in the query', async () => {
		assetFindFirst.mockResolvedValueOnce({
			storageKey: 'canonical.webp',
			width: null,
			card480Height: null,
			display960Height: null,
		});
		await expect(repository.resolvePublicImage('canonical.webp')).resolves.toEqual({
			storageKey: 'canonical.webp',
		});
		expect(assetFindFirst).toHaveBeenCalledWith(expect.objectContaining({
			where: expect.objectContaining({
				status: 'READY',
				isPublic: true,
				kind: { in: ['IMAGE', 'POSTER', 'THUMBNAIL'] },
			}),
		}));
	});

	it('resolves an applicable asset rendition from its current public source in one query', async () => {
		const renditionKey = deriveImageRenditionStorageKey('canonical.webp', 'CARD_480');
		assetFindFirst.mockResolvedValueOnce({
			storageKey: 'canonical.webp',
			width: 1400,
			card480Height: 240,
			display960Height: null,
		});
		await expect(repository.resolvePublicImage(renditionKey)).resolves.toEqual({
			storageKey: renditionKey,
		});
		expect(assetFindFirst).toHaveBeenCalledOnce();
		expect(assetFindFirst).toHaveBeenCalledWith(expect.objectContaining({
			where: expect.objectContaining({ storageKey: 'canonical.webp' }),
		}));
		expect(exhibitionFindUnique).not.toHaveBeenCalled();
	});

	it('resolves an exhibition rendition after asset miss and verifies poster readiness', async () => {
		const renditionKey = deriveImageRenditionStorageKey('poster.webp', 'DISPLAY_960');
		exhibitionFindUnique.mockResolvedValueOnce({
			posterStorageKey: 'poster.webp',
			posterWidth: 1200,
			posterCard480Height: 320,
			posterDisplay960Height: 640,
		});
		await expect(repository.resolvePublicImage(renditionKey)).resolves.toEqual({
			storageKey: renditionKey,
		});
		expect(assetFindFirst).toHaveBeenCalledOnce();
		expect(exhibitionFindUnique).toHaveBeenCalledOnce();
	});

	it('rejects stale, private, protected, and unready sources through owner queries', async () => {
		const renditionKey = deriveImageRenditionStorageKey('old.webp', 'CARD_480');
		await expect(repository.resolvePublicImage(renditionKey)).resolves.toBeNull();
		expect(assetFindFirst).toHaveBeenCalledTimes(2);
		expect(exhibitionFindUnique).toHaveBeenCalledTimes(2);
		for (const call of assetFindFirst.mock.calls) {
			expect(call[0].where).toMatchObject({
				status: 'READY',
				isPublic: true,
				kind: { in: ['IMAGE', 'POSTER', 'THUMBNAIL'] },
				project: { status: { in: ['PUBLISHED', 'ARCHIVED'] } },
			});
		}

		vi.clearAllMocks();
		assetFindFirst.mockResolvedValueOnce({
			storageKey: 'old.webp',
			width: 1400,
			card480Height: null,
			display960Height: null,
		}).mockResolvedValueOnce(null);
		exhibitionFindUnique.mockResolvedValue(null);
		await expect(repository.resolvePublicImage(renditionKey)).resolves.toBeNull();
		expect(assetFindFirst).toHaveBeenCalledTimes(2);
	});

	it('does not authorize a rendition that would require enlarging its source', async () => {
		const renditionKey = deriveImageRenditionStorageKey('small.webp', 'CARD_480');
		assetFindFirst.mockResolvedValueOnce({
			storageKey: 'small.webp',
			width: 480,
			card480Height: 320,
			display960Height: null,
		}).mockResolvedValueOnce(null);
		await expect(repository.resolvePublicImage(renditionKey)).resolves.toBeNull();
	});

	it('preserves an exact legacy original that collides with the reserved rendition suffix', async () => {
		const legacyKey = deriveImageRenditionStorageKey('missing-source.webp', 'CARD_480');
		assetFindFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				storageKey: legacyKey,
				width: null,
				card480Height: null,
				display960Height: null,
			});
		await expect(repository.resolvePublicImage(legacyKey)).resolves.toEqual({
			storageKey: legacyKey,
		});
		expect(assetFindFirst).toHaveBeenCalledTimes(2);
	});

	it('keeps legacy nested original keys on the exact-owner path', async () => {
		assetFindFirst.mockResolvedValueOnce({
			storageKey: 'legacy/nested.webp',
			width: null,
			card480Height: null,
			display960Height: null,
		});
		await expect(repository.resolvePublicImage('legacy/nested.webp')).resolves.toEqual({
			storageKey: 'legacy/nested.webp',
		});
	});
});
