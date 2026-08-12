import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createObjectStorage } from '../lib/storage.js';

describe('object storage HEAD metadata', () => {
	it('exposes validators and cache metadata without opening a body', async () => {
		const lastModified = new Date('2026-08-12T00:00:00.000Z');
		const send = vi.fn(async () => ({
			ContentLength: 123,
			ContentType: 'image/webp',
			CacheControl: 'public, max-age=31536000, immutable',
			ETag: '"abc"',
			LastModified: lastModified,
		}));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.head('public', 'image.webp')).resolves.toEqual({
			size: 123,
			contentType: 'image/webp',
			cacheControl: 'public, max-age=31536000, immutable',
			etag: '"abc"',
			lastModified,
		});
		expect(send).toHaveBeenCalledOnce();
	});

	it('returns null only for object-not-found and propagates storage failures', async () => {
		const send = vi.fn()
			.mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
			.mockRejectedValueOnce(new Error('storage unavailable'));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.head('public', 'missing.webp')).resolves.toBeNull();
		await expect(storage.head('public', 'failed.webp')).rejects.toThrow('storage unavailable');
	});
});
