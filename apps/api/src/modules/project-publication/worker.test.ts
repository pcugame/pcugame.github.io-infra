import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectPublicationStorage, ValidatedProjectPublicationJob } from './ports.js';
import { copyProjectPublicationObjects, createProjectPublicationWorker, ProjectPublicationInvariantError } from './worker.js';

function sha256(value: Buffer): string {
	return createHash('sha256').update(value).digest('hex');
}

function job(bytes = Buffer.from('publication-object')): ValidatedProjectPublicationJob {
	return {
		id: 'job-1',
		projectId: 7,
		submissionId: 'submission-1',
		attemptCount: 1,
		plan: {
			version: 1,
			projectId: 7,
			submissionId: 'submission-1',
			objects: [{
				sourceBucket: 'protected',
				sourceObjectKey: 'protected/publication-staging/source.webp',
				targetBucket: 'public',
				targetObjectKey: 'public/images/1/card_480/1.webp',
				sizeBytes: String(bytes.length),
				checksumSha256: sha256(bytes),
				mimeType: 'image/webp',
				contentEncoding: null,
				cacheControl: 'public, max-age=31536000, immutable',
			}],
			representations: [],
			webglDeployments: [],
		},
	};
}

function memoryStorage(source = Buffer.from('publication-object')) {
	const objects = new Map<string, Buffer>([[
		'protected\0protected/publication-staging/source.webp', source,
	]]);
	let uploads = 0;
	const storage: ProjectPublicationStorage = {
		async head(bucket, key) {
			const value = objects.get(`${bucket}\0${key}`);
			return value ? { size: value.length, checksumSha256: sha256(value) } : null;
		},
		async stream(bucket, key) {
			const value = objects.get(`${bucket}\0${key}`);
			if (!value) throw new Error('missing');
			return { body: Readable.from(value), size: value.length };
		},
		async upload(input) {
			const chunks: Buffer[] = [];
			for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
			const value = Buffer.concat(chunks);
			if (sha256(value) !== input.checksumSha256) throw new Error('checksum mismatch');
			objects.set(`${input.bucket}\0${input.key}`, value);
			uploads++;
		},
		async delete(bucket, key) { objects.delete(`${bucket}\0${key}`); },
	};
	return { storage, objects, uploadCount: () => uploads };
}

describe('project publication worker', () => {
	it('copies protected staging bytes, verifies size/SHA-256, and reruns without rewriting immutable targets', async () => {
		const state = memoryStorage();
		const publication = job();
		const assertOwned = vi.fn(async () => undefined);
		await copyProjectPublicationObjects({ job: publication, storage: state.storage, assertOwned });
		await copyProjectPublicationObjects({ job: publication, storage: state.storage, assertOwned });
		expect(state.uploadCount()).toBe(1);
		expect(state.objects.get('public\0public/images/1/card_480/1.webp')?.toString()).toBe('publication-object');
		expect(assertOwned).toHaveBeenCalledTimes(3);
	});

	it('fails closed when an immutable target has different bytes', async () => {
		const state = memoryStorage();
		state.objects.set('public\0public/images/1/card_480/1.webp', Buffer.from('different'));
		await expect(copyProjectPublicationObjects({
			job: job(), storage: state.storage, assertOwned: async () => undefined,
		})).rejects.toBeInstanceOf(ProjectPublicationInvariantError);
		expect(state.uploadCount()).toBe(0);
	});

	it('releases transient failures and converges after a copy-before-DB-commit crash', async () => {
		const state = memoryStorage();
		const publication = job();
		const claim = vi.fn()
			.mockResolvedValueOnce(publication)
			.mockResolvedValueOnce({ ...publication, attemptCount: 2 });
		const complete = vi.fn()
			.mockRejectedValueOnce(new Error('database unavailable after copy'))
			.mockResolvedValueOnce('COMPLETED');
		const release = vi.fn(async () => true);
		const worker = createProjectPublicationWorker({
			repository: {
				claim,
				validatePlan: vi.fn(async (claimed) => ({ status: 'VALID' as const, job: claimed as ValidatedProjectPublicationJob })),
				renew: vi.fn(async () => true),
				complete,
				release,
				fail: vi.fn(async () => true),
				queueCancelledCleanup: vi.fn(async () => undefined),
			},
			storage: state.storage,
			ids: { next: () => 'claim-token' },
			logger: { error: vi.fn(), warn: vi.fn() },
			heartbeatMs: 60_000,
		});
		await expect(worker.runPass()).resolves.toMatchObject({ retried: 1 });
		await expect(worker.runPass()).resolves.toMatchObject({ completed: 1 });
		expect(state.uploadCount()).toBe(1);
		expect(release).toHaveBeenCalledTimes(1);
		expect(complete).toHaveBeenCalledTimes(2);
	});

	it('performs zero storage writes when the lease-fenced DB plan validation fails', async () => {
		const state = memoryStorage();
		const publication = job();
		const complete = vi.fn(async () => 'COMPLETED' as const);
		const worker = createProjectPublicationWorker({
			repository: {
				claim: vi.fn(async () => publication),
				validatePlan: vi.fn(async () => ({ status: 'FAILED' as const, error: 'tampered persisted plan' })),
				renew: vi.fn(async () => true),
				complete,
				release: vi.fn(async () => true),
				fail: vi.fn(async () => true),
				queueCancelledCleanup: vi.fn(async () => undefined),
			},
			storage: state.storage,
			ids: { next: () => 'claim-token' },
			logger: { error: vi.fn(), warn: vi.fn() },
			heartbeatMs: 60_000,
		});
		await expect(worker.runPass()).resolves.toMatchObject({ failed: 1 });
		const publicTargetExists = state.objects.has('public\0public/images/1/card_480/1.webp');
		expect(publicTargetExists).toBe(false);
		expect(state.uploadCount()).toBe(0);
		expect(complete).not.toHaveBeenCalled();
	});
});
