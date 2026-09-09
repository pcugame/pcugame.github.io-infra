import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createCanonicalObjectMaterializer } from '../infrastructure/canonical-object-migration.s3.js';

const checksum = 'ab'.repeat(32);
const otherChecksum = 'cd'.repeat(32);
const encoded = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const sourceHead = {
	ContentLength: 123,
	ContentType: 'image/png',
	ETag: '"source-etag"',
	ChecksumSHA256: encoded(checksum),
};

describe('canonical publication object relocation', () => {
	it('allows an exact 5 GiB source through the single CopyObject path', async () => {
		const exactLimit = 5n * 1024n * 1024n * 1024n;
		const exactLimitHead = { ...sourceHead, ContentLength: Number(exactLimit) };
		const send = vi.fn()
			.mockResolvedValueOnce(exactLimitHead)
			.mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({ ...exactLimitHead, ETag: '"destination-etag"' });
		const materializer = createCanonicalObjectMaterializer({ send } as unknown as S3Client, {
			tempRoot: '/tmp/canonical-copy-unit',
		});

		await expect(materializer.ensureCanonicalObjectCopy({
			sourceBucket: 'public', sourceKey: 'legacy/large.png',
			destinationBucket: 'public', destinationKey: 'public/images/large.png',
			expected: { size: exactLimit, mimeType: 'image/png', checksumSha256: checksum },
		})).resolves.toMatchObject({ created: true, head: { size: exactLimit } });

		expect(send.mock.calls.filter(([command]) => command instanceof CopyObjectCommand)).toHaveLength(1);
		expect(send.mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(false);
	});

	it.each([
		['canonical object', 'ensureCanonicalObjectCopy', 'public', 'public/games/large.zip'],
		['WebGL source', 'ensureWebglSourceCopy', 'protected', 'canonical/webgl/large.zip'],
	] as const)(
		'rejects a %s over 5 GiB before fallback reads, hooks, or copying',
		async (_label, method, bucket, destinationKey) => {
			const overLimit = 5n * 1024n * 1024n * 1024n + 1n;
			const send = vi.fn()
				.mockResolvedValueOnce({
					ContentLength: Number(overLimit),
					ContentType: 'application/zip',
					ETag: '"source-etag"',
				})
				.mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } });
			const materializer = createCanonicalObjectMaterializer({ send } as unknown as S3Client, {
				tempRoot: '/tmp/canonical-copy-unit',
			});
			const beforeCreate = vi.fn(async () => undefined);

			await expect(materializer[method]({
				sourceBucket: bucket, sourceKey: 'legacy/large.zip',
				destinationBucket: bucket, destinationKey,
				expected: { size: overLimit, mimeType: 'application/zip', checksumSha256: checksum },
			}, { beforeCreate })).rejects.toThrow(
				'canonical copy source exceeds the 5 GiB CopyObject limit; multipart copy is required',
			);

			expect(send).toHaveBeenCalledTimes(2);
			expect(send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
			expect(send.mock.calls[1]![0]).toBeInstanceOf(HeadObjectCommand);
			expect(send.mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(false);
			expect(send.mock.calls.some(([command]) => command instanceof CopyObjectCommand)).toBe(false);
			expect(beforeCreate).not.toHaveBeenCalled();
		},
	);

	it('reuses an exact oversized destination materialized by an external multipart copy', async () => {
		const overLimit = 5n * 1024n * 1024n * 1024n + 1n;
		const oversizedHead = {
			...sourceHead,
			ContentLength: Number(overLimit),
			ChecksumSHA256: encoded(checksum),
		};
		const send = vi.fn()
			.mockResolvedValueOnce(oversizedHead)
			.mockResolvedValueOnce({ ...oversizedHead, ETag: '"destination-etag"' });
		const materializer = createCanonicalObjectMaterializer({ send } as unknown as S3Client, {
			tempRoot: '/tmp/canonical-copy-unit',
		});
		const beforeCreate = vi.fn(async () => undefined);

		await expect(materializer.ensureCanonicalObjectCopy({
			sourceBucket: 'public', sourceKey: 'legacy/large.png',
			destinationBucket: 'public', destinationKey: 'public/images/large.png',
			expected: { size: overLimit, mimeType: 'image/png', checksumSha256: checksum },
		}, { beforeCreate })).resolves.toMatchObject({
			created: false,
			head: { size: overLimit, mimeType: 'image/png', checksumSha256: checksum },
		});

		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(false);
		expect(send.mock.calls.some(([command]) => command instanceof CopyObjectCommand)).toBe(false);
		expect(beforeCreate).not.toHaveBeenCalled();
	});

	it('pins the source ETag and replaces legacy metadata with immutable public metadata', async () => {
		const send = vi.fn()
			.mockResolvedValueOnce(sourceHead)
			.mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({ ...sourceHead, ETag: '"destination-etag"' });
		const materializer = createCanonicalObjectMaterializer({ send } as unknown as S3Client, {
			tempRoot: '/tmp/canonical-copy-unit',
		});
		const beforeCreate = vi.fn(async () => undefined);

		await expect(materializer.ensureCanonicalObjectCopy({
			sourceBucket: 'public', sourceKey: 'legacy/poster.png',
			destinationBucket: 'public', destinationKey: `public/images/7/original/${checksum}.png`,
			expected: { size: 123n, mimeType: 'image/png', etag: '"source-etag"', checksumSha256: checksum },
		}, { beforeCreate })).resolves.toMatchObject({ created: true, head: { checksumSha256: checksum } });

		expect(beforeCreate).toHaveBeenCalledOnce();
		const copy = send.mock.calls[2]![0] as CopyObjectCommand;
		expect(copy).toBeInstanceOf(CopyObjectCommand);
		expect(copy.input).toMatchObject({
			Bucket: 'public',
			CopySource: 'public/legacy/poster.png',
			CopySourceIfMatch: '"source-etag"',
			MetadataDirective: 'REPLACE',
			ContentType: 'image/png',
			CacheControl: 'public, max-age=31536000, immutable',
			ChecksumAlgorithm: 'SHA256',
		});
		expect(send.mock.calls.filter(([command]) => command instanceof HeadObjectCommand)).toHaveLength(3);
	});

	it('fails closed without copying when an existing destination checksum differs', async () => {
		const send = vi.fn()
			.mockResolvedValueOnce(sourceHead)
			.mockResolvedValueOnce({ ...sourceHead, ChecksumSHA256: encoded(otherChecksum) });
		const materializer = createCanonicalObjectMaterializer({ send } as unknown as S3Client, {
			tempRoot: '/tmp/canonical-copy-unit',
		});

		await expect(materializer.ensureCanonicalObjectCopy({
			sourceBucket: 'public', sourceKey: 'legacy/poster.png',
			destinationBucket: 'public', destinationKey: 'public/images/7/original/stable.png',
			expected: { size: 123n, mimeType: 'image/png', checksumSha256: checksum },
		})).rejects.toThrow('checksum mismatch');
		expect(send.mock.calls.some(([command]) => command instanceof CopyObjectCommand)).toBe(false);
	});
});
