import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createMultipartRecoveryStorage } from '../lib/storage.js';

describe('direct multipart recovery storage adapter', () => {
	it('paginates only the requested closed namespace and forwards cancellation to Garage', async () => {
		const send = vi.fn()
			.mockResolvedValueOnce({
				Uploads: [{
					Key: 'protected/uploads/11111111-1111-4111-8111-111111111111/1/source.zip',
					UploadId: 'first',
					Initiated: new Date('2026-08-21T00:00:00.000Z'),
				}],
				IsTruncated: true,
				NextKeyMarker: 'next-key',
				NextUploadIdMarker: 'next-upload',
			})
			.mockResolvedValueOnce({
				Uploads: [{
					Key: 'protected/uploads/22222222-2222-4222-8222-222222222222/1/source.bin',
					UploadId: 'second',
				}],
				IsTruncated: false,
			});
		const storage = createMultipartRecoveryStorage({ send } as unknown as S3Client);
		const controller = new AbortController();

		await expect(storage.listMultipartUploads(
			'protected-bucket',
			'protected/uploads/',
			{ signal: controller.signal },
		)).resolves.toEqual([
			{
				key: 'protected/uploads/11111111-1111-4111-8111-111111111111/1/source.zip',
				uploadId: 'first',
				initiated: new Date('2026-08-21T00:00:00.000Z'),
			},
			{
				key: 'protected/uploads/22222222-2222-4222-8222-222222222222/1/source.bin',
				uploadId: 'second',
			},
		]);

		expect(send).toHaveBeenCalledTimes(2);
		const [firstCommand, firstOptions] = send.mock.calls[0]!;
		expect(firstCommand).toBeInstanceOf(ListMultipartUploadsCommand);
		expect(firstCommand.input).toMatchObject({
			Bucket: 'protected-bucket',
			Prefix: 'protected/uploads/',
		});
		expect(firstOptions).toEqual({ abortSignal: controller.signal });
		expect((send.mock.calls[1]![0] as ListMultipartUploadsCommand).input).toMatchObject({
			KeyMarker: 'next-key', UploadIdMarker: 'next-upload',
		});
	});
});
