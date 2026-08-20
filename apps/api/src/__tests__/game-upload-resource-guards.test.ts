import { createHash, randomUUID } from 'node:crypto';
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
	completePartClaim: vi.fn(),
	renewPartClaim: vi.fn(),
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

const BLOCK_SIZE = 1024 * 1024;

function sourceIdentityForBlocks(values: number[]) {
	const digests = values.map((value) => createHash('sha256').update(Buffer.alloc(BLOCK_SIZE, value)).digest());
	const manifest = Buffer.concat(digests);
	const header = Buffer.allocUnsafe(16);
	header.writeBigUInt64BE(BigInt(values.length * BLOCK_SIZE), 0);
	header.writeUInt32BE(BLOCK_SIZE, 8);
	header.writeUInt32BE(values.length, 12);
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
		sourceIdentity: createHash('sha256')
			.update('PCU-UPLOAD-SOURCE-V1\0', 'utf8')
			.update(header)
			.update(manifest)
			.digest('hex'),
		sourceIdentityBlockSizeBytes: BLOCK_SIZE,
		sourceIdentityBlockManifest: manifest,
	};
}

let uploadLimiter: UploadConcurrencyLimiter;
let service: ReturnType<typeof createGameUploadService>;

function createDependencies(): GameUploadServiceDependencies {
	return {
		repository: createDurableGameUploadRepository({
			findSessionById: mocks.findSessionById,
			completePartClaim: mocks.completePartClaim,
			renewPartClaim: mocks.renewPartClaim,
			cancelSessionAndClearActive: vi.fn(),
			findExhibitionById: mocks.findExhibitionById,
			createSessionReplacingActive: mocks.createSessionReplacingActive,
			findActiveSessionsForListing: vi.fn().mockResolvedValue([]),
			findPartsBySessionId: vi.fn().mockResolvedValue([]),
			revertToPending: vi.fn(),
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
	const identity = sourceIdentityForBlocks([0, 1, 2, 3]);
	return {
		id: 'session-1',
		projectId: 7,
		userId: 11,
		originalName: 'game.zip',
		totalBytes: BigInt(4 * BLOCK_SIZE),
		chunkSizeBytes: BLOCK_SIZE,
		totalChunks: 4,
		uploadedChunks: [],
		status: 'PENDING',
		expiresAt: new Date(Date.now() + 60_000),
		s3UploadId: 'multipart-1',
		s3Key: 'protected/game.zip',
		s3PartEtags: [],
		...identity,
		parts: [],
		project: { status: 'PUBLISHED' },
	};
}

function sourceQuery(values = [0, 1, 2, 3]) {
	const identity = sourceIdentityForBlocks(values);
	return {
		sourceIdentityAlgorithm: identity.sourceIdentityAlgorithm,
		sourceIdentity: identity.sourceIdentity,
	};
}

function chunkStream(value: number) {
	return Readable.from([Buffer.alloc(BLOCK_SIZE, value)]);
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
		mocks.completePartClaim.mockImplementation(async ({ etag }) => ({
			accepted: true,
			parts: [{ partNumber: 1, etag, generation: 1 }],
		}));
		mocks.renewPartClaim.mockResolvedValue({ count: 1 });
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
			totalBytes: BLOCK_SIZE,
			...{ ...sourceIdentityForBlocks([0]), sourceIdentityBlockDigests: [createHash('sha256').update(Buffer.alloc(BLOCK_SIZE)).digest('hex')] },
		});
		const webgl = await service.createSession(7, 1, { id: 11, role: 'USER' }, {
			originalName: 'webgl.zip',
			totalBytes: BLOCK_SIZE,
			...{ ...sourceIdentityForBlocks([0]), sourceIdentityBlockDigests: [createHash('sha256').update(Buffer.alloc(BLOCK_SIZE)).digest('hex')] },
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
			totalBytes: BLOCK_SIZE,
			...{ ...sourceIdentityForBlocks([0]), sourceIdentityBlockDigests: [createHash('sha256').update(Buffer.alloc(BLOCK_SIZE)).digest('hex')] },
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

		const first = service.uploadChunk('session-1', 0, chunkStream(0), { id: 11, role: 'USER' }, sourceQuery());
		const second = service.uploadChunk('session-1', 1, chunkStream(1), { id: 11, role: 'USER' }, sourceQuery());
		await vi.waitFor(() => expect(gates).toHaveLength(2));

		await expect(
			service.uploadChunk('session-1', 2, chunkStream(2), { id: 11, role: 'USER' }, sourceQuery()),
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

	it('returns null source identity for a legacy status but rejects legacy mutation', async () => {
		const {
			sourceIdentityAlgorithm: _algorithm,
			sourceIdentity: _identity,
			sourceIdentityBlockSizeBytes: _blockSize,
			sourceIdentityBlockManifest: _manifest,
			...legacy
		} = pendingSession();
		mocks.findSessionById.mockResolvedValue(legacy);

		await expect(service.getSessionStatus('session-1', { id: 11, role: 'USER' }))
			.resolves.toMatchObject({ sourceIdentityAlgorithm: null, sourceIdentity: null, sourceIdentityBlockSizeBytes: null });
		await expect(service.uploadChunk(
			'session-1', 0, chunkStream(0), { id: 11, role: 'USER' }, sourceQuery(),
		)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT', details: { reason: 'LEGACY_UPLOAD_SESSION' } });
		expect(mocks.uploadPart).not.toHaveBeenCalled();
	});

	it('rejects a missing chunk source-identity query before storage mutation', async () => {
		await expect(service.uploadChunk(
			'session-1', 0, chunkStream(0), { id: 11, role: 'USER' }, {},
		)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
		expect(mocks.uploadPart).not.toHaveBeenCalled();
	});

	it('buffers one verified chunk before handing it to S3', async () => {
		mocks.findSessionById.mockResolvedValueOnce({
			...pendingSession(),
			totalBytes: BigInt(BLOCK_SIZE),
			chunkSizeBytes: BLOCK_SIZE,
			totalChunks: 1,
			...sourceIdentityForBlocks([0]),
		});
		mocks.uploadPart.mockImplementation(async (_key, _uploadId, _partNumber, body: NodeJS.ReadableStream, contentLength: number) => {
			expect(Buffer.isBuffer(body)).toBe(false);
			expect(contentLength).toBe(BLOCK_SIZE);
			const bytes = await consumeStream(body);
			return `etag-${bytes}`;
		});

		const result = await service.uploadChunk(
			'session-1',
			0,
			Readable.from(Array.from({ length: 16 }, () => Buffer.alloc(BLOCK_SIZE / 16))),
			{ id: 11, role: 'USER' },
			sourceQuery([0]),
		);

		expect(result.bytesWritten).toBe(BLOCK_SIZE);
		expect(mocks.uploadPart).toHaveBeenCalledTimes(1);
		expect(mocks.completePartClaim).toHaveBeenCalledWith({
			token: expect.any(String), etag: `etag-${BLOCK_SIZE}`, contentSha256: expect.any(String),
		});
	});

	it('does not record chunk state when the request stream aborts and allows retry', async () => {
		mocks.findSessionById
			.mockResolvedValueOnce({
				...pendingSession(),
				totalBytes: BigInt(BLOCK_SIZE),
				chunkSizeBytes: BLOCK_SIZE,
				totalChunks: 1,
				...sourceIdentityForBlocks([0]),
			})
			.mockResolvedValueOnce({
				...pendingSession(),
				totalBytes: BigInt(BLOCK_SIZE),
				chunkSizeBytes: BLOCK_SIZE,
				totalChunks: 1,
				...sourceIdentityForBlocks([0]),
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
			service.uploadChunk('session-1', 0, aborted, { id: 11, role: 'USER' }, sourceQuery([0])),
		).rejects.toThrow('client aborted');
		expect(mocks.completePartClaim).not.toHaveBeenCalled();
		expect(uploadLimiter.activeCount()).toBe(0);

		const retried = await service.uploadChunk(
			'session-1',
			0,
			chunkStream(0),
			{ id: 11, role: 'USER' },
			sourceQuery([0]),
		);

		expect(retried.bytesWritten).toBe(BLOCK_SIZE);
		expect(mocks.completePartClaim).toHaveBeenCalledWith({
			token: expect.any(String),
			etag: `etag-${BLOCK_SIZE}`,
			contentSha256: expect.any(String),
		});
		expect(uploadLimiter.activeCount()).toBe(0);
	});

	it('aborts upload and rejects when an expired or wrong-token heartbeat loses the part claim', async () => {
		vi.useFakeTimers();
		try {
			let uploadEntered!: () => void;
			const entered = new Promise<void>((resolve) => { uploadEntered = resolve; });
			mocks.renewPartClaim.mockResolvedValue({ count: 0 });
			mocks.uploadPart.mockImplementation((
				_key,
				_uploadId,
				_partNumber,
				_body,
				_contentLength,
				request?: { signal?: AbortSignal },
			) => {
				uploadEntered();
				return new Promise<string>((_resolve, reject) => {
					request?.signal?.addEventListener('abort', () => {
						reject(request.signal?.reason ?? new Error('aborted'));
					}, { once: true });
				});
			});

			const running = service.uploadChunk(
				'session-1',
				0,
				chunkStream(0),
				{ id: 11, role: 'USER' },
				sourceQuery(),
			);
			const rejected = expect(running).rejects.toThrow('Part-upload claim was lost');
			await entered;
			await vi.advanceTimersByTimeAsync(30_000);

			await rejected;
			expect(mocks.completePartClaim).not.toHaveBeenCalled();
			expect(mocks.renewPartClaim).toHaveBeenCalledWith(expect.any(String), 120_000);
			expect(uploadLimiter.activeCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('destroys the inbound stream and releases the upload slot when S3 upload fails', async () => {
		mocks.uploadPart.mockRejectedValueOnce(new Error('s3 upload failed'));
		const source = chunkStream(0);

		await expect(
			service.uploadChunk('session-1', 0, source, { id: 11, role: 'USER' }, sourceQuery()),
		).rejects.toThrow('s3 upload failed');

		expect(source.destroyed).toBe(true);
		expect(mocks.completePartClaim).not.toHaveBeenCalled();
		expect(uploadLimiter.activeCount()).toBe(0);
	});
});
