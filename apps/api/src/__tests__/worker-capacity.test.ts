import { describe, expect, it } from 'vitest';
import {
	assertDirectArchiveWorkerCapacity,
	assertExportWorkerCapacity,
	maximumAcceptedDirectArchiveBytes,
	WEBGL_MAX_DECODED_BYTES,
} from '../shared/worker-capacity.js';

const GIB = 1024 * 1024 * 1024;

describe('direct archive worker capacity', () => {
	const accepted = {
		UPLOAD_USER_GAME_MAX_MB: 5 * 1024,
		UPLOAD_PRIVILEGED_GAME_MAX_MB: 4 * 1024,
	};

	it('derives the maximum accepted archive across roles', () => {
		expect(maximumAcceptedDirectArchiveBytes(accepted)).toBe(5 * GIB);
	});

	it('accepts an exact worker/export bound and fails closed one byte below it', () => {
		expect(assertDirectArchiveWorkerCapacity({
			...accepted, DIRECT_UPLOAD_WORKER_TEMP_MAX_MB: 5 * 1024,
		}, 'GAME')).toEqual({ acceptedArchiveBytes: 5 * GIB, tempBudgetBytes: 5 * GIB });
		expect(() => assertDirectArchiveWorkerCapacity({
			...accepted, DIRECT_UPLOAD_WORKER_TEMP_MAX_MB: (5 * 1024) - (1 / (1024 * 1024)),
		}, 'WEBGL')).toThrow(/temp budget/);

		expect(assertExportWorkerCapacity({
			...accepted, EXPORT_WORKER_MAX_OBJECT_BYTES: 5 * GIB,
		})).toEqual({ acceptedArchiveBytes: 5 * GIB, maxObjectBytes: 5 * GIB });
		expect(() => assertExportWorkerCapacity({
			...accepted, EXPORT_WORKER_MAX_OBJECT_BYTES: (5 * GIB) - 1,
		})).toThrow(/object limit/);
	});

	it('documents the streamed WebGL worst case without charging decoded bytes to temp', () => {
		const archiveBytes = maximumAcceptedDirectArchiveBytes(accepted);
		expect({
			tempArchiveBytes: archiveBytes,
			maxDecodedGarageBytes: WEBGL_MAX_DECODED_BYTES,
			combinedObjectCapacityBytes: archiveBytes + WEBGL_MAX_DECODED_BYTES,
		}).toEqual({
			tempArchiveBytes: 5 * GIB,
			maxDecodedGarageBytes: 10 * GIB,
			combinedObjectCapacityBytes: 15 * GIB,
		});
	});
});
