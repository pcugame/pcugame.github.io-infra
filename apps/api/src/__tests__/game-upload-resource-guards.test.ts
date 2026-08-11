import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createGameUploadService } from '../modules/admin/game-upload/service.js';
import type { GameUploadServiceDependencies } from '../modules/admin/game-upload/ports.js';
import { ActiveUploadCompletionInProgressError } from '../modules/admin/game-upload/ports.js';
import { createWebglDeploymentKeys } from '../modules/webgl/paths.js';
import {
	chunkUploadBodyLimitBytes,
	resolveChunkSizeBytes,
} from '../modules/admin/game-upload/service.js';
import {
	createUploadLimiter,
	type UploadConcurrencyLimiter,
} from '../shared/upload-limits.js';
import { createDurableGameUploadRepository } from './helpers/upload-lifecycle.js';

const mocks = {
	findSessionById: vi.fn(),
	upsertPartEtag: vi.fn(),
	completePartClaim: vi.fn(),
	findExhibitionById: vi.fn(),
	getSiteSettings: vi.fn(),
	uploadPart: vi.fn(),
	createMultipartUpload: vi.fn(),
	completeMultipartUpload: vi.fn(),
	abortMultipartUpload: vi.fn(),
	headObject: vi.fn(),
	safeDeleteObject: vi.fn(),
	createSessionReplacingActive: vi.fn(),
};

let uploadLimiter: UploadConcurrencyLimiter;
let service: ReturnType<typeof createGameUploadService>;

function createDependencies(): GameUploadServiceDependencies {
	return {
		repository: createDurableGameUploadRepository({
			findSessionById: mocks.findSessionById,
			upsertPartEtag: mocks.upsertPartEtag,
			completePartClaim: mocks.completePartClaim,
			cancelSessionAndClearActive: vi.fn(),
			findExhibitionById: mocks.findExhibitionById,
			createSessionReplacingActive: mocks.createSessionReplacingActive,
			findActiveSessionsForListing: vi.fn().mockResolvedValue([]),
			findStaleCompletingSessions: vi.fn().mockResolvedValue([]),
			findPartsBySessionId: vi.fn().mockResolvedValue([]),
			revertToPending: vi.fn(),
			transitionToCompleting: vi.fn(),
			markFailed: vi.fn(),
		}),
		storage: {
			createMultipart: mocks.createMultipartUpload,
			uploadPart: mocks.uploadPart,
			completeMultipart: mocks.completeMultipartUpload,
			abortMultipart: mocks.abortMultipartUpload,
			listParts: vi.fn(async () => []),
			listMultipartUploads: vi.fn(async () => []),
			head: mocks.headObject,
		},
		finalizer: { finalize: vi.fn() },
		settings: { get: mocks.getSiteSettings },
		uploadSlots: uploadLimiter,
		clock: { now: () => new Date('2026-07-31T00:00:00.000Z') },
		ids: { next: randomUUID },
		lifecycle: { isAcceptingNewWork: () => true },
		config: {
			uploadChunkSizeMb: 10,
			uploadSessionTtlMinutes: defaultTestEnv.UPLOAD_SESSION_TTL_MINUTES,
		},
		roleGameMaxBytes: () => defaultTestEnv.UPLOAD_USER_GAME_MAX_MB * 1024 * 1024,
		storageKey: (uploadKind, projectId) => {
			const id = randomUUID();
			return uploadKind === 'WEBGL'
				? createWebglDeploymentKeys(projectId, id).sourceKey
				: `${id}.zip`;
		},
		deleteOrQueue: mocks.safeDeleteObject,
		wakeDeletionWorker: vi.fn(),
		wakeMaintenance: vi.fn(),
		recordUntrackedMultipartCleanupFailure: vi.fn(),
		logger: { error: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
	};
}

function pendingSession() {
	return {
		id: 'session-1',
		projectId: 7,
		userId: 11,
		originalName: 'game.zip',
		totalBytes: 4n,
		chunkSizeBytes: 1,
		totalChunks: 4,
		uploadedChunks: [],
		status: 'PENDING',
		expiresAt: new Date(Date.now() + 60_000),
		s3UploadId: 'multipart-1',
		s3Key: 'protected/game.zip',
		s3PartEtags: [],
		parts: [],
		project: { status: 'PUBLISHED' },
	};
}

function oneByteStream(value: number) {
	return Readable.from([Buffer.from([value])]);
}

async function consumeStream(stream: NodeJS.ReadableStream): Promise<number> {
	let bytes = 0;
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		bytes += chunk.length;
	}
	return bytes;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

describe('game upload resource guards', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uploadLimiter = createUploadLimiter(() => 2);
		service = createGameUploadService(createDependencies());
		mocks.findSessionById.mockImplementation(async () => pendingSession());
		mocks.upsertPartEtag.mockResolvedValue([{ partNumber: 1 }]);
		mocks.completePartClaim.mockImplementation(async ({ etag }) => ({
			accepted: true,
			parts: [{ partNumber: 1, etag, generation: 1 }],
		}));
	});

	afterEach(() => {
		uploadLimiter.close();
	});

	it('caps route body limit and session chunk size to UPLOAD_CHUNK_SIZE_MB', () => {
		const cfg = { ...defaultTestEnv, UPLOAD_CHUNK_SIZE_MB: 10 };

		expect(chunkUploadBodyLimitBytes(cfg)).toBe(10 * 1024 * 1024);
		expect(resolveChunkSizeBytes({ maxChunkSizeMb: 100 }, cfg)).toBe(10 * 1024 * 1024);
		expect(resolveChunkSizeBytes({ maxChunkSizeMb: 4 }, cfg)).toBe(5 * 1024 * 1024);
	});

	it('rejects an unsafe original filename before creating S3 upload state', async () => {
		await expect(service.createSession(
			7,
			1,
			{ id: 11, role: 'USER' },
			{ originalName: '../game?.zip', totalBytes: 1024 },
		)).rejects.toMatchObject({
			statusCode: 400,
			code: 'INVALID_FILENAME',
		});

		expect(mocks.findExhibitionById).not.toHaveBeenCalled();
		expect(mocks.createMultipartUpload).not.toHaveBeenCalled();
		expect(mocks.createSessionReplacingActive).not.toHaveBeenCalled();
	});

	it.each([1.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid totalBytes %s before any repository or storage work',
		async (totalBytes) => {
			await expect(service.createSession(
				7,
				1,
				{ id: 11, role: 'USER' },
				{ originalName: 'game.zip', totalBytes },
			)).rejects.toMatchObject({ statusCode: 400 });

			expect(mocks.findExhibitionById).not.toHaveBeenCalled();
			expect(mocks.createMultipartUpload).not.toHaveBeenCalled();
			expect(mocks.createSessionReplacingActive).not.toHaveBeenCalled();
		},
	);

	it('creates independent GAME and WEBGL sessions with different storage layouts', async () => {
		mocks.findExhibitionById.mockResolvedValue({
			id: 1,
			year: 2026,
			title: '',
			isUploadEnabled: true,
		});
		mocks.getSiteSettings.mockResolvedValue({ maxGameFileMb: 5120, maxChunkSizeMb: 10 });
		mocks.createMultipartUpload.mockResolvedValue('multipart-id');
		mocks.createSessionReplacingActive.mockImplementation(async (data) => ({
			session: data,
			durableAborts: [],
		}));

		const game = await service.createSession(7, 1, { id: 11, role: 'USER' }, {
			originalName: 'game.zip',
			totalBytes: 1024,
		});
		const webgl = await service.createSession(7, 1, { id: 11, role: 'USER' }, {
			originalName: 'webgl.zip',
			totalBytes: 2048,
			uploadKind: 'WEBGL',
		});

		expect(game.uploadKind).toBe('GAME');
		expect(webgl.uploadKind).toBe('WEBGL');
		const gameData = mocks.createSessionReplacingActive.mock.calls[0]![0];
		const webglData = mocks.createSessionReplacingActive.mock.calls[1]![0];
		expect(gameData.uploadKind).toBe('GAME');
		expect(gameData.s3Key).toMatch(/^[0-9a-f-]+\.zip$/);
		expect(webglData.uploadKind).toBe('WEBGL');
		expect(webglData.s3Key).toMatch(/^webgl\/7\/[0-9a-f-]+\/source\.zip$/);
		expect(gameData.s3Key).not.toBe(webglData.s3Key);
	});

	it('aborts a new multipart upload instead of replacing a completing session', async () => {
		mocks.findExhibitionById.mockResolvedValue({
			id: 1,
			year: 2026,
			title: '',
			isUploadEnabled: true,
		});
		mocks.getSiteSettings.mockResolvedValue({ maxGameFileMb: 5120, maxChunkSizeMb: 10 });
		mocks.createMultipartUpload.mockResolvedValue('new-multipart');
		mocks.abortMultipartUpload.mockResolvedValue(undefined);
		mocks.createSessionReplacingActive.mockRejectedValue(
			new ActiveUploadCompletionInProgressError(),
		);

		await expect(service.createSession(7, 1, { id: 11, role: 'USER' }, {
			originalName: 'replacement.zip',
			totalBytes: 1024,
		})).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });

		expect(mocks.abortMultipartUpload).toHaveBeenCalledOnce();
		expect(mocks.abortMultipartUpload).toHaveBeenCalledWith(
			expect.any(String),
			'new-multipart',
			undefined,
		);
	});

	it('rejects chunk uploads above configured concurrency', async () => {
		const gates: Array<ReturnType<typeof deferred<string>>> = [];
		let inFlight = 0;
		let maxInFlight = 0;
		mocks.uploadPart.mockImplementation(async (_key, _uploadId, _partNumber, body: NodeJS.ReadableStream) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const gate = deferred<string>();
			gates.push(gate);
			await consumeStream(body);
			const etag = await gate.promise;
			inFlight--;
			return etag;
		});

		const first = service.uploadChunk('session-1', 0, oneByteStream(0), { id: 11, role: 'USER' });
		const second = service.uploadChunk('session-1', 1, oneByteStream(1), { id: 11, role: 'USER' });
		await vi.waitFor(() => expect(gates).toHaveLength(2));

		await expect(
			service.uploadChunk('session-1', 2, oneByteStream(2), { id: 11, role: 'USER' }),
		).rejects.toMatchObject({
			statusCode: 429,
			code: 'TOO_MANY_UPLOADS',
		});

		expect(mocks.uploadPart).toHaveBeenCalledTimes(2);
		expect(uploadLimiter.activeCount()).toBe(2);
		expect(maxInFlight).toBe(2);

		gates[0]!.resolve('etag-1');
		gates[1]!.resolve('etag-2');
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(uploadLimiter.activeCount()).toBe(0);
	});

	it('streams chunk bodies to S3 without buffering the full part', async () => {
		mocks.findSessionById.mockResolvedValueOnce({
			...pendingSession(),
			totalBytes: 1024n,
			chunkSizeBytes: 1024,
			totalChunks: 1,
		});
		mocks.uploadPart.mockImplementation(async (_key, _uploadId, _partNumber, body: NodeJS.ReadableStream, contentLength: number) => {
			expect(Buffer.isBuffer(body)).toBe(false);
			expect(contentLength).toBe(1024);
			const bytes = await consumeStream(body);
			return `etag-${bytes}`;
		});

		const result = await service.uploadChunk(
			'session-1',
			0,
			Readable.from(Array.from({ length: 16 }, () => Buffer.alloc(64))),
			{ id: 11, role: 'USER' },
		);

		expect(result.bytesWritten).toBe(1024);
		expect(mocks.uploadPart).toHaveBeenCalledTimes(1);
		expect(mocks.completePartClaim).toHaveBeenCalledWith({
			token: expect.any(String),
			etag: 'etag-1024',
			now: new Date('2026-07-31T00:00:00.000Z'),
		});
		expect(mocks.upsertPartEtag).not.toHaveBeenCalled();
	});

	it('does not record chunk state when the request stream aborts and allows retry', async () => {
		mocks.findSessionById
			.mockResolvedValueOnce({
				...pendingSession(),
				totalBytes: 2n,
				chunkSizeBytes: 2,
				totalChunks: 1,
			})
			.mockResolvedValueOnce({
				...pendingSession(),
				totalBytes: 2n,
				chunkSizeBytes: 2,
				totalChunks: 1,
			});
		mocks.uploadPart.mockImplementation(async (_key, _uploadId, _partNumber, body: NodeJS.ReadableStream) => {
			const bytes = await consumeStream(body);
			return `etag-${bytes}`;
		});

		const aborted = new Readable({
			read() {
				this.push(Buffer.from([1]));
				this.destroy(new Error('client aborted'));
			},
		});

		await expect(
			service.uploadChunk('session-1', 0, aborted, { id: 11, role: 'USER' }),
		).rejects.toThrow('client aborted');
		expect(mocks.completePartClaim).not.toHaveBeenCalled();
		expect(uploadLimiter.activeCount()).toBe(0);

		const retried = await service.uploadChunk(
			'session-1',
			0,
			Readable.from([Buffer.from([1, 2])]),
			{ id: 11, role: 'USER' },
		);

		expect(retried.bytesWritten).toBe(2);
		expect(mocks.completePartClaim).toHaveBeenCalledWith({
			token: expect.any(String),
			etag: 'etag-2',
			now: new Date('2026-07-31T00:00:00.000Z'),
		});
		expect(mocks.upsertPartEtag).not.toHaveBeenCalled();
		expect(uploadLimiter.activeCount()).toBe(0);
	});

	it('destroys the inbound stream and releases the upload slot when S3 upload fails', async () => {
		mocks.uploadPart.mockRejectedValueOnce(new Error('s3 upload failed'));
		const source = new Readable({
			read() {
				this.push(Buffer.from([1]));
			},
		});

		await expect(
			service.uploadChunk('session-1', 0, source, { id: 11, role: 'USER' }),
		).rejects.toThrow('s3 upload failed');

		expect(source.destroyed).toBe(true);
		expect(mocks.completePartClaim).not.toHaveBeenCalled();
		expect(uploadLimiter.activeCount()).toBe(0);
	});
});
