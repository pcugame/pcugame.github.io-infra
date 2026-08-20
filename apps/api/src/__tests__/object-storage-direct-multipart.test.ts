import { ListPartsCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createS3Client, createS3PresigningClient } from '../lib/s3.js';
import { createObjectStorage } from '../lib/storage.js';

describe('direct multipart storage capabilities', () => {
	it('signs UploadPart against the browser-visible endpoint, never by rewriting internal URLs', async () => {
		const baseConfig = {
			S3_INTERNAL_ENDPOINT: 'http://garage.internal:3900',
			S3_PUBLIC_SIGNING_ENDPOINT: 'https://assets.example.test/s3',
			S3_REGION: 'garage',
			S3_ACCESS_KEY_ID: 'test-access-key',
			S3_SECRET_ACCESS_KEY: 'test-secret-key',
			S3_FORCE_PATH_STYLE: true,
		};
		const internal = createS3Client(baseConfig);
		const publicSigner = createS3PresigningClient(baseConfig);
		const storage = createObjectStorage(internal, {
			defaultPresignTtlSec: 60,
			presigningClient: publicSigner,
		});

		const url = await storage.presignUploadPart!(
			'pcu-staging',
			'games/session-1/generation-1.zip',
			'upload-id-1',
			3,
			120,
			'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
		);
		const signed = new URL(url);
		expect(signed.origin).toBe('https://assets.example.test');
		expect(signed.pathname).toBe('/s3/pcu-staging/games/session-1/generation-1.zip');
		expect(signed.searchParams.get('partNumber')).toBe('3');
		expect(signed.searchParams.get('uploadId')).toBe('upload-id-1');
		expect(signed.searchParams.get('X-Amz-Expires')).toBe('120');

		storage.close?.();
		internal.destroy();
	});

	it('preserves S3 ListParts byte sizes for direct-completion verification', async () => {
		const send = vi.fn(async (..._args: unknown[]) => ({
			Parts: [{ PartNumber: 1, ETag: '"etag-1"', Size: 16_777_216 }],
			IsTruncated: false,
		}));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.listParts('pcu-staging', 'key', 'upload-id')).resolves.toEqual([
			{ partNumber: 1, etag: '"etag-1"', sizeBytes: 16_777_216 },
		]);
		expect(send.mock.calls[0]![0]).toBeInstanceOf(ListPartsCommand);
	});
});
