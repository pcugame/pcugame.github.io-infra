import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { settleUploadStreamFailure } from '../modules/assets/upload/upload-stream.js';

describe('failed upload stream ownership', () => {
	it('settles an unconsumed body before returning the original upload failure', async () => {
		const uploadError = new Error('storage rejected before reading');
		const body = new Readable({ read() {} });

		const failure = await settleUploadStreamFailure(
			body,
			uploadError,
			'upload and cleanup failed',
		);

		expect(failure).toBe(uploadError);
		expect(body.destroyed).toBe(true);
		expect(body.closed).toBe(true);
	});

	it('preserves both the upload and stream cleanup errors', async () => {
		const uploadError = new Error('storage rejected before reading');
		const cleanupError = new Error('stream close failed');
		const body = new Readable({
			read() {},
			destroy(_error, callback) {
				callback(cleanupError);
			},
		});

		const failure = await settleUploadStreamFailure(
			body,
			uploadError,
			'upload and cleanup failed',
		);

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([uploadError, cleanupError]);
		expect(body.closed).toBe(true);
	});
});
