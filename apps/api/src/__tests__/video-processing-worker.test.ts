import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceIdentityRoot } from '../modules/admin/game-upload/source-identity.js';
import { VideoRejectedError } from '../modules/video/errors.js';
import { DEFAULT_VIDEO_LIMITS } from '../modules/video/policy.js';
import { createVideoProcessor } from '../modules/video/processor.js';
import type { VerifyingVideoSession, VideoProbe } from '../modules/video/ports.js';
import { createVideoProcessingWorker } from '../modules/video/worker.js';

function sourceBytes(): Buffer {
	const source = Buffer.alloc(64);
	source.writeUInt32BE(24, 0);
	source.write('ftyp', 4, 'ascii');
	source.write('isom', 8, 'ascii');
	return source;
}

function videoSession(source = sourceBytes()): VerifyingVideoSession {
	const digest = createHash('sha256').update(source).digest();
	return {
		id: 'session-video-1',
		projectId: 7,
		userId: 9,
		kind: 'VIDEO',
		state: 'VERIFYING',
		originalName: 'demo.mov',
		declaredMimeType: 'text/plain',
		totalBytes: BigInt(source.length),
		bucket: 'protected',
		objectKey: 'protected/uploads/session-video-1/1/source.bin',
		generation: 1,
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
		sourceIdentity: sourceIdentityRoot(source.length, 1_048_576, [digest.toString('hex')]),
		sourceIdentityBlockSizeBytes: 1_048_576,
		sourceIdentityBlockManifest: digest.toString('base64'),
		validationLeaseToken: 'lease',
		validationLeaseUntil: new Date(Date.now() + 60_000),
	};
}

function probe(overrides: Partial<VideoProbe> = {}): VideoProbe {
	return {
		formatNames: ['mov', 'mp4'],
		videoCodec: 'h264',
		audioCodec: 'aac',
		pixelFormat: 'yuv420p',
		width: 1_280,
		height: 720,
		frameRate: 30,
		bitRate: 3_000_000,
		durationSeconds: 10,
		streamCount: 2,
		videoStreamCount: 1,
		audioStreamCount: 1,
		fastStart: true,
		...overrides,
	};
}

async function processorHarness(input: {
	inputProbe?: VideoProbe;
	outputProbe?: VideoProbe;
	commitError?: Error;
	existingPlayback?: boolean;
} = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-processor-test-'));
	const source = sourceBytes();
	const upload = vi.fn(async ({ body }: { body: Readable }) => {
		for await (const _chunk of body) { /* drain */ }
	});
	const commitVideoReady = input.commitError
		? vi.fn(async () => { throw input.commitError; })
		: vi.fn(async () => ({
			assetId: 20,
			originalRepresentationId: 'original',
			playbackRepresentationId: 'playback',
		}));
	const repository = {
		claimVideoVerifying: vi.fn(),
		renewVideoLease: vi.fn(),
		preparePlaybackIntent: vi.fn(async () => ({ id: 'intent-1', state: 'PREPARED' as const })),
		markPlaybackUploaded: vi.fn(async () => {}),
		commitVideoReady,
		rejectVideo: vi.fn(),
	};
	const probes = [input.inputProbe ?? probe(), input.outputProbe ?? probe()];
	const operations = {
		probe: vi.fn(async () => probes.shift() ?? probe()),
		verifyDecode: vi.fn(async () => {}),
		remux: vi.fn(async (_input: string, output: string) => fs.writeFile(output, Buffer.alloc(128))),
		reencode: vi.fn(async (_input: string, output: string) => fs.writeFile(output, Buffer.alloc(128))),
	};
	const storage = {
		stream: vi.fn(async () => ({ body: Readable.from([source]), size: source.length, etag: 'source-etag' })),
		head: vi.fn(async () => input.existingPlayback ? { size: 128 } : null),
		upload,
	};
	const logger = { info: vi.fn(), warn: vi.fn() };
	return {
		root,
		repository,
		operations,
		storage,
		logger,
		processor: createVideoProcessor({
			repository: repository as never,
			storage,
			operations,
			tempRoot: root,
			tempDiskBudgetBytes: 4 * 1024 * 1024,
			protectedBucket: 'protected',
			limits: { ...DEFAULT_VIDEO_LIMITS, maxSourceBytes: 1024 * 1024, maxPlaybackBytes: 1024 * 1024 },
			clock: { now: () => new Date(0) },
			logger,
		}),
	};
}

describe('direct VIDEO processor', () => {
	it('distrusts declared MIME, fully decodes, and commits browser-safe original as playback', async () => {
		const harness = await processorHarness();
		try {
			await expect(harness.processor.process(videoSession(), 'token')).resolves.toEqual({
				strategy: 'passthrough',
				assetId: 20,
			});
			expect(harness.operations.verifyDecode).toHaveBeenCalledOnce();
			expect(harness.storage.upload).not.toHaveBeenCalled();
			expect(harness.repository.commitVideoReady).toHaveBeenCalledWith(expect.objectContaining({
				originalMimeType: 'video/mp4',
				playback: expect.objectContaining({
					objectKey: 'protected/uploads/session-video-1/1/source.bin',
					mimeType: 'video/mp4',
				}),
			}));
			expect(harness.logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({ declaredMimeType: 'text/plain', detectedMimeType: 'video/mp4' }),
				expect.any(String),
			);
			expect(await fs.readdir(harness.root)).toEqual([]);
		} finally {
			await fs.rm(harness.root, { recursive: true, force: true });
		}
	});

	it('creates a bounded protected generation and a durable intent before upload', async () => {
		const harness = await processorHarness({
			inputProbe: probe({ videoCodec: 'vp9', formatNames: ['matroska', 'webm'], fastStart: false }),
		});
		try {
			await expect(harness.processor.process(videoSession(), 'token')).resolves.toMatchObject({
				strategy: 'reencode', assetId: 20,
			});
			expect(harness.operations.reencode).toHaveBeenCalledWith(
				expect.any(String), expect.any(String), expect.any(Number), undefined,
			);
			expect(harness.repository.preparePlaybackIntent.mock.invocationCallOrder[0])
				.toBeLessThan(harness.storage.upload.mock.invocationCallOrder[0]!);
			expect(harness.repository.markPlaybackUploaded.mock.invocationCallOrder[0])
				.toBeLessThan(harness.repository.commitVideoReady.mock.invocationCallOrder[0]!);
		} finally {
			await fs.rm(harness.root, { recursive: true, force: true });
		}
	});

	it('retains the durable generated-object intent when DB commit fails and cleans temp files', async () => {
		const harness = await processorHarness({
			inputProbe: probe({ videoCodec: 'vp9', formatNames: ['webm'], fastStart: false }),
			commitError: new Error('database unavailable'),
		});
		try {
			await expect(harness.processor.process(videoSession(), 'token')).rejects.toThrow('database unavailable');
			expect(harness.repository.preparePlaybackIntent).toHaveBeenCalledOnce();
			expect(harness.repository.markPlaybackUploaded).toHaveBeenCalledWith('intent-1');
			expect(await fs.readdir(harness.root)).toEqual([]);
		} finally {
			await fs.rm(harness.root, { recursive: true, force: true });
		}
	});

	it('recovers an already uploaded deterministic generation without another Garage PUT', async () => {
		const harness = await processorHarness({
			inputProbe: probe({ videoCodec: 'vp9', formatNames: ['webm'], fastStart: false }),
			existingPlayback: true,
		});
		try {
			await harness.processor.process(videoSession(), 'token');
			expect(harness.storage.upload).not.toHaveBeenCalled();
			expect(harness.repository.markPlaybackUploaded).toHaveBeenCalledOnce();
		} finally {
			await fs.rm(harness.root, { recursive: true, force: true });
		}
	});
});

describe('VIDEO worker failure classification', () => {
	let repository: ReturnType<typeof workerRepository>;
	function workerRepository() {
		return {
			claimVideoVerifying: vi.fn(async () => [videoSession()]),
			renewVideoLease: vi.fn(async () => true),
			preparePlaybackIntent: vi.fn(),
			markPlaybackUploaded: vi.fn(),
			commitVideoReady: vi.fn(),
			rejectVideo: vi.fn(async () => true),
		};
	}
	beforeEach(() => { repository = workerRepository(); });

	it('rejects deterministic corrupt media and queues source cleanup', async () => {
		const processor = { process: vi.fn(async () => {
			throw new VideoRejectedError('corrupt stream', 'CORRUPT_MEDIA');
		}) };
		const worker = createVideoProcessingWorker({
			repository: repository as never,
			processor: processor as never,
			ids: { next: () => 'token' },
			logger: { error: vi.fn(), warn: vi.fn() },
		});
		await expect(worker.runPass()).resolves.toMatchObject({ rejected: 1, retried: 0 });
		expect(repository.rejectVideo).toHaveBeenCalledWith(expect.objectContaining({
			reason: 'CORRUPT_MEDIA: corrupt stream',
		}));
	});

	it.each(['Garage unavailable', 'database commit failed', 'worker crash'])(
		'retries transient %s failures after lease expiry',
		async (message) => {
			const processor = { process: vi.fn(async () => { throw new Error(message); }) };
			const worker = createVideoProcessingWorker({
				repository: repository as never,
				processor: processor as never,
				ids: { next: () => 'token' },
				logger: { error: vi.fn(), warn: vi.fn() },
			});
			await expect(worker.runPass()).resolves.toMatchObject({ rejected: 0, retried: 1 });
			expect(repository.rejectVideo).not.toHaveBeenCalled();
		},
	);
});
