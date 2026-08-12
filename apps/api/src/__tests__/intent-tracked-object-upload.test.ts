import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { ObjectStorage } from '../application/ports.js';
import {
	createIntentTrackedObjectUploader,
	type IntentTrackedObjectUploadInput,
} from '../modules/assets/upload/intent-tracked-object-upload.js';

function input(storageKey: string, body: Readable): IntentTrackedObjectUploadInput {
	return {
		bucket: 'public',
		storageKey,
		purpose: 'test-image',
		owner: { projectId: 7 },
		createBody: () => body,
		contentType: 'image/webp',
		contentLength: 4,
		rollbackReason: 'test-unpersisted',
	};
}

function intentPort(options: {
	events?: string[];
	isUncommitted?: boolean;
} = {}) {
	let sequence = 0;
	return {
		prepare: vi.fn(async ({ storageKey }: { storageKey: string }) => {
			const id = `intent-${++sequence}`;
			options.events?.push(`prepare:${storageKey}:${id}`);
			return id;
		}),
		markUploaded: vi.fn(async (id: string) => {
			options.events?.push(`mark:${id}`);
		}),
		isUncommitted: vi.fn(async (id: string) => {
			options.events?.push(`uncommitted:${id}`);
			return options.isUncommitted ?? true;
		}),
		recordAmbiguousError: vi.fn(async (id: string) => {
			options.events?.push(`ambiguous:${id}`);
		}),
	};
}

function createUploader(input: {
	storage: Pick<ObjectStorage, 'upload'>;
	uploadIntents: ReturnType<typeof intentPort>;
	deleteUnpersistedObject?: (target: {
		bucket: string;
		storageKey: string;
		reason: string;
		intentId?: string;
	}) => Promise<void>;
}) {
	return createIntentTrackedObjectUploader({
		storage: input.storage,
		uploadIntents: input.uploadIntents,
		deleteUnpersistedObject: input.deleteUnpersistedObject ?? (async () => {}),
		logger: { error: vi.fn() },
		uploadStreamFailureMessage: 'PUT and request-stream cleanup failed',
		rollbackFailureMessage: 'durable rollback failed',
		ambiguousErrorLogMessage: 'ambiguous intent annotation failed',
	});
}

describe('intent-tracked object upload lifecycle', () => {
	it('prepares before PUT, marks afterward, and skips committed objects during rollback', async () => {
		const events: string[] = [];
		const uploadIntents = intentPort({ events, isUncommitted: false });
		const storage: Pick<ObjectStorage, 'upload'> = {
			upload: vi.fn(async (_bucket, key, body) => {
				events.push(`put:${key}`);
				if (body instanceof Readable) {
					for await (const _chunk of body) { /* consume request-owned body */ }
				}
			}),
		};
		const deleteUnpersistedObject = vi.fn(async () => {});
		const uploader = createUploader({ storage, uploadIntents, deleteUnpersistedObject });

		await expect(uploader.upload(input('one.webp', Readable.from(['data']))))
			.resolves.toEqual({ intentId: 'intent-1' });
		expect(events).toEqual([
			'prepare:one.webp:intent-1',
			'put:one.webp',
			'mark:intent-1',
		]);

		await uploader.rollback();
		expect(uploadIntents.isUncommitted).toHaveBeenCalledWith('intent-1');
		expect(deleteUnpersistedObject).not.toHaveBeenCalled();
	});

	it('settles an immediately rejected body, records ambiguity, and durably rolls back', async () => {
		const events: string[] = [];
		const uploadError = new Error('storage rejected before consuming body');
		const body = new Readable({ read() {} });
		const uploadIntents = intentPort({ events });
		const storage: Pick<ObjectStorage, 'upload'> = {
			upload: vi.fn(async (_bucket, key) => {
				events.push(`put:${key}`);
				throw uploadError;
			}),
		};
		const deleteUnpersistedObject = vi.fn(async (target: { storageKey: string }) => {
			events.push(`delete:${target.storageKey}`);
		});
		const uploader = createUploader({ storage, uploadIntents, deleteUnpersistedObject });

		await expect(uploader.upload(input('failed.webp', body))).rejects.toBe(uploadError);
		expect(body.destroyed).toBe(true);
		expect(body.closed).toBe(true);
		expect(uploadIntents.recordAmbiguousError).toHaveBeenCalledWith('intent-1', uploadError);

		await uploader.rollback();
		expect(events).toEqual([
			'prepare:failed.webp:intent-1',
			'put:failed.webp',
			'ambiguous:intent-1',
			'uncommitted:intent-1',
			'delete:failed.webp',
		]);
		expect(deleteUnpersistedObject).toHaveBeenCalledWith(expect.objectContaining({
			bucket: 'public',
			storageKey: 'failed.webp',
			reason: 'test-unpersisted',
			intentId: 'intent-1',
		}));
	});

	it('preserves a single durable rollback failure unchanged', async () => {
		const deleteError = new Error('object deletion and durable queue both failed');
		const uploader = createUploader({
			storage: {
				upload: vi.fn(async (_bucket, _key, body) => {
					if (body instanceof Readable) {
						for await (const _chunk of body) { /* consume request-owned body */ }
					}
				}),
			},
			uploadIntents: intentPort(),
			deleteUnpersistedObject: vi.fn(async () => { throw deleteError; }),
		});
		await uploader.upload(input('one.webp', Readable.from(['one'])));

		await expect(uploader.rollback()).rejects.toBe(deleteError);
	});

	it('preserves upload/stream failures and aggregates all durable rollback failures', async () => {
		const uploadError = new Error('PUT failed');
		const streamError = new Error('stream destroy failed');
		const brokenBody = new Readable({
			read() {},
			destroy(_error, callback) {
				callback(streamError);
			},
		});
		const uploadIntents = intentPort();
		const uploadFailingStorage: Pick<ObjectStorage, 'upload'> = {
			upload: vi.fn(async () => { throw uploadError; }),
		};
		const failedUploader = createUploader({
			storage: uploadFailingStorage,
			uploadIntents,
		});

		let uploadFailure: unknown;
		try {
			await failedUploader.upload(input('broken.webp', brokenBody));
		} catch (error) {
			uploadFailure = error;
		}
		expect(uploadFailure).toBeInstanceOf(AggregateError);
		expect((uploadFailure as AggregateError).errors).toEqual([uploadError, streamError]);

		const firstDeleteError = new Error('delete one failed');
		const secondDeleteError = new Error('delete two failed');
		const rollbackUploader = createUploader({
			storage: {
				upload: vi.fn(async (_bucket, _key, body) => {
					if (body instanceof Readable) {
						for await (const _chunk of body) { /* consume request-owned body */ }
					}
				}),
			},
			uploadIntents: intentPort(),
			deleteUnpersistedObject: vi.fn(async ({ storageKey }) => {
				throw storageKey === 'one.webp' ? firstDeleteError : secondDeleteError;
			}),
		});
		await rollbackUploader.upload(input('one.webp', Readable.from(['one'])));
		await rollbackUploader.upload(input('two.webp', Readable.from(['two'])));

		let rollbackFailure: unknown;
		try {
			await rollbackUploader.rollback();
		} catch (error) {
			rollbackFailure = error;
		}
		expect(rollbackFailure).toBeInstanceOf(AggregateError);
		expect((rollbackFailure as AggregateError).errors)
			.toEqual([secondDeleteError, firstDeleteError]);
	});
});
