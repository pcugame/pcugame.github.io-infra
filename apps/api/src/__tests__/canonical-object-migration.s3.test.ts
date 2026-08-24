import { CopyObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
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
