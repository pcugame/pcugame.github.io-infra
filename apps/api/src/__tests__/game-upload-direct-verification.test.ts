import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
	materializeAndValidateCompletedSource,
	sourceIdentityRoot,
} from '../modules/admin/game-upload/source-identity.js';
import {
	createValidationWorker,
	type ValidationWorkerDependencies,
} from '../modules/admin/game-upload/validation-worker.service.js';
import { createValidationWorkerLoop } from '../modules/admin/game-upload/validation-worker-loop.js';
import type { GameUploadSessionSummary } from '../modules/admin/game-upload/ports.js';
import { badRequest } from '../shared/errors.js';
import { createGameUploadValidationGraph } from '../modules/admin/game-upload/validation-worker.composition.js';
import { createNodeFileSystem } from '../infrastructure/production-ports.js';
import {
	createDurableGameUploadRepository,
	createTestUploadLifecycleRuntime,
} from './helpers/upload-lifecycle.js';

function storedZip(name: string, body: Buffer): Buffer {
	const nameBytes = Buffer.from(name);
	const local = Buffer.alloc(30 + nameBytes.length + body.length);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(0, 6);
	local.writeUInt16LE(0, 8);
	local.writeUInt32LE(body.length, 18);
	local.writeUInt32LE(body.length, 22);
	local.writeUInt16LE(nameBytes.length, 26);
	nameBytes.copy(local, 30);
	body.copy(local, 30 + nameBytes.length);
	const central = Buffer.alloc(46 + nameBytes.length);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(0, 8);
	central.writeUInt16LE(0, 10);
	central.writeUInt32LE(body.length, 20);
	central.writeUInt32LE(body.length, 24);
	central.writeUInt16LE(nameBytes.length, 28);
	nameBytes.copy(central, 46);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8);
	eocd.writeUInt16LE(1, 10);
	eocd.writeUInt32LE(central.length, 12);
	eocd.writeUInt32LE(local.length, 16);
	return Buffer.concat([local, central, eocd]);
}

function identity(bytes: Buffer) {
	const digests: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += SOURCE_IDENTITY_BLOCK_SIZE_BYTES) {
		digests.push(createHash('sha256').update(
			bytes.subarray(offset, Math.min(bytes.length, offset + SOURCE_IDENTITY_BLOCK_SIZE_BYTES)),
		).digest('hex'));
	}
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
		sourceIdentity: sourceIdentityRoot(bytes.length, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, digests),
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockManifest: Buffer.concat(digests.map((digest) => Buffer.from(digest, 'hex'))),
	};
}

function promiseGate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function session(id: string): GameUploadSessionSummary {
	const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
	return {
		id,
		projectId: 7,
		userId: 11,
		uploadKind: 'GAME',
		originalName: `${id}.zip`,
		totalBytes: BigInt(bytes.length),
		chunkSizeBytes: 5 * 1024 * 1024,
		totalChunks: 1,
		...identity(bytes),
		status: 'VERIFYING',
		expiresAt: new Date('2026-08-21T00:00:00.000Z'),
		s3UploadId: null,
		s3Key: `${id}.zip`,
		storageKey: `${id}.zip`,
		multipartGeneration: 1,
	};
}

function workerDeps(overrides: Partial<ValidationWorkerDependencies> = {}) {
	const repository = {
		claimVerifyingSessions: vi.fn(async () => [session('one')]),
		renewCompletionClaim: vi.fn(async () => ({ count: 1 })),
		releaseCompletionClaim: vi.fn(async () => ({ count: 1 })),
		markCompletedObjectFailed: vi.fn(async () => ({ count: 1 })),
	};
	const logger = { info: vi.fn(), error: vi.fn() };
	const deps: ValidationWorkerDependencies = {
		repository,
		ids: { next: () => 'claim-token' },
		processor: { process: vi.fn(async () => undefined) },
		wakeDeletionWorker: vi.fn(),
		logger,
		options: { concurrency: 1, claimLeaseMs: 120_000, heartbeatMs: 60_000 },
		...overrides,
	};
	return { deps, repository, logger };
}

describe('validation worker sequential source I/O', () => {
	it('keeps the protected object request count at one in production composition', async () => {
		const archive = storedZip('game.txt', Buffer.from('payload'));
		const verifying = { ...session('single-get'), totalBytes: BigInt(archive.length), ...identity(archive) };
		const repository = createDurableGameUploadRepository({
			claimVerifyingSessions: vi.fn(async () => [verifying]),
		});
		const stream = vi.fn(async () => ({
			body: Readable.from([archive.subarray(0, 7), archive.subarray(7)]),
			size: archive.length,
			contentType: 'application/zip',
		}));
		const uploadLifecycle = createTestUploadLifecycleRuntime({ gameUploads: repository });
		const graph = createGameUploadValidationGraph({
			config: {
				PUBLIC_ASSET_BASE_URL: 'https://assets.test',
				S3_BUCKET_PUBLIC: 'public',
				S3_BUCKET_PROTECTED: 'protected',
			},
			storage: { stream, upload: vi.fn() },
			fileSystem: createNodeFileSystem(),
			ids: { next: () => 'safe-worker-temp-id' },
			logger: {
				child() { return this; }, trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
				warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
			},
			uploadLifecycle,
			options: {
				concurrency: 1,
				claimLeaseMs: 120_000,
				tempRoot: createNodeFileSystem().temporaryDirectory(),
				tempDiskBudgetBytes: 1024 * 1024,
			},
		});
		await expect(graph.worker.runPass()).resolves.toEqual({
			claimed: 1, ready: 1, rejected: 0, retried: 0,
		});
		expect(stream).toHaveBeenCalledOnce();
		expect(repository.finalizeCompletedSession).toHaveBeenCalledOnce();
		expect(graph.metrics.tempBytes()).toBe(0);
	});

	it('hashes arbitrary stream chunks and writes the local archive in one pass', async () => {
		const bytes = Buffer.alloc(SOURCE_IDENTITY_BLOCK_SIZE_BYTES * 3 + 17, 0x41);
		const output: Buffer[] = [];
		const destination = new Writable({
			write(chunk, _encoding, callback) {
				output.push(Buffer.from(chunk));
				callback();
			},
		});
		const onBytes = vi.fn();
		await expect(materializeAndValidateCompletedSource({
			totalBytes: BigInt(bytes.length),
			...identity(bytes),
			source: Readable.from([
				bytes.subarray(0, 13),
				bytes.subarray(13, SOURCE_IDENTITY_BLOCK_SIZE_BYTES + 37),
				bytes.subarray(SOURCE_IDENTITY_BLOCK_SIZE_BYTES + 37),
			]),
			destination,
			physicalByteLimit: bytes.length,
			onBytes,
		})).resolves.toEqual({ bytesWritten: bytes.length });
		const materialized = Buffer.concat(output);
		expect(materialized.length).toBe(bytes.length);
		expect(createHash('sha256').update(materialized).digest('hex')).toBe(
			createHash('sha256').update(bytes).digest('hex'),
		);
		// Stream chunks only feed metrics. The byte loop has no DB renewal port,
		// so a 5 GiB-equivalent block count cannot create per-block SQL calls.
		expect(onBytes).toHaveBeenCalledTimes(3);
	});

	it('models a 5 GiB source with one object open, bounded chunks, and no block-coupled lease writes', async () => {
		const fiveGiB = 5 * 1024 * 1024 * 1024;
		const representedChunkBytes = 64 * 1024 * 1024;
		const physicalChunk = Buffer.alloc(64 * 1024, 0x41);
		const blockCount = fiveGiB / SOURCE_IDENTITY_BLOCK_SIZE_BYTES;
		const blockDigest = createHash('sha256').update(Buffer.alloc(
			SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
			0x41,
		)).digest('hex');
		const blockDigests = Array.from({ length: blockCount }, () => blockDigest);
		const hugeSession: GameUploadSessionSummary = {
			...session('synthetic-5gib'),
			totalBytes: BigInt(fiveGiB),
			totalChunks: 1024,
			sourceIdentity: sourceIdentityRoot(
				fiveGiB,
				SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
				blockDigests,
			),
			sourceIdentityBlockManifest: Buffer.concat(
				blockDigests.map((digest) => Buffer.from(digest, 'hex')),
			),
		};
		const repository = createDurableGameUploadRepository({
			claimVerifyingSessions: vi.fn(async () => [hugeSession]),
		});
		let maxSourceChunk = 0;
		let maxSinkChunk = 0;
		let representedBytes = 0;
		let maxTempBytes = 0;
		const stream = vi.fn(async () => ({
			body: Readable.from((async function* repeatableBoundedSource() {
				for (let index = 0; index < fiveGiB / representedChunkBytes; index += 1) {
					yield physicalChunk;
				}
			})()),
			size: fiveGiB,
			contentType: 'application/zip',
		}));
		const metrics = {
			recordBytesRead: vi.fn((bytes: number) => { representedBytes += bytes; }),
			recordDuration: vi.fn(),
			setActive: vi.fn(),
			setTempBytes: vi.fn((bytes: number) => { maxTempBytes = Math.max(maxTempBytes, bytes); }),
			bytesRead: () => representedBytes,
			lastDurationMs: () => 0,
			active: () => 0,
			tempBytes: () => 0,
		};
		const materializeSource: typeof materializeAndValidateCompletedSource = vi.fn(async (input) => {
			expect(input.totalBytes).toBe(BigInt(fiveGiB));
			expect(input.sourceIdentityBlockManifest).toHaveLength(blockCount * 32);
			for await (const raw of input.source) {
				const chunk = Buffer.from(raw);
				maxSourceChunk = Math.max(maxSourceChunk, chunk.length);
				maxSinkChunk = Math.max(maxSinkChunk, chunk.length);
				input.destination.write(chunk);
				input.onBytes?.(representedChunkBytes);
			}
			input.destination.end();
			return { bytesWritten: fiveGiB };
		});
		const graph = createGameUploadValidationGraph({
			config: {
				PUBLIC_ASSET_BASE_URL: 'https://assets.test',
				S3_BUCKET_PUBLIC: 'public',
				S3_BUCKET_PROTECTED: 'protected',
			},
			storage: { stream, upload: vi.fn() },
			fileSystem: {
				temporaryDirectory: () => '/tmp',
				createWriteStream: () => new Writable({
					write(_chunk, _encoding, callback) { callback(); },
				}),
				readRange: vi.fn(async () => { throw new Error('synthetic archive boundary reached'); }),
				remove: vi.fn(async () => undefined),
			},
			ids: { next: () => 'synthetic-worker' },
			logger: {
				child() { return this; }, trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
				warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
			},
			uploadLifecycle: createTestUploadLifecycleRuntime({ gameUploads: repository }),
			options: {
				concurrency: 1,
				claimLeaseMs: 120_000,
				tempRoot: '/tmp',
				tempDiskBudgetBytes: 6 * 1024 * 1024 * 1024,
			},
			metrics,
			materializeSource,
		});

		await expect(graph.worker.runPass()).resolves.toEqual({
			claimed: 1, ready: 0, rejected: 0, retried: 1,
		});
		expect(stream).toHaveBeenCalledOnce();
		expect(materializeSource).toHaveBeenCalledOnce();
		expect(representedBytes).toBe(fiveGiB);
		expect(maxSourceChunk).toBe(physicalChunk.length);
		expect(maxSinkChunk).toBe(physicalChunk.length);
		expect(maxTempBytes).toBe(fiveGiB);
		const renewCalls = vi.mocked(repository.renewCompletionClaim).mock.calls;
		expect(renewCalls.length).toBeLessThan(20);
		expect(renewCalls.length).not.toBe(blockCount);
		expect(graph.disk.usage()).toBe(0);
	});

	it('fails closed and aborts an active stream on shutdown', async () => {
		const bytes = Buffer.alloc(SOURCE_IDENTITY_BLOCK_SIZE_BYTES, 0x41);
		const controller = new AbortController();
		const source = new Readable({ read() {} });
		const destination = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
		const work = materializeAndValidateCompletedSource({
			totalBytes: BigInt(bytes.length),
			...identity(bytes),
			source,
			destination,
			signal: controller.signal,
			physicalByteLimit: bytes.length,
		});
		source.push(bytes.subarray(0, 1024));
		controller.abort(new Error('shutdown'));
		await expect(work).rejects.toMatchObject({ name: 'AbortError' });
		expect(source.destroyed).toBe(true);
	});
});

describe('validation claim capacity and fencing', () => {
	it('claims only capacity and starts a capacity-sized batch concurrently', async () => {
		const starts: string[] = [];
		let active = 0;
		let maxActive = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const harness = workerDeps({
			options: { concurrency: 2, claimLeaseMs: 120_000 },
			processor: {
				async process(item) {
					starts.push(item.id);
					active += 1;
					maxActive = Math.max(maxActive, active);
					await gate;
					active -= 1;
				},
			},
		});
		harness.repository.claimVerifyingSessions.mockResolvedValue([
			session('one'), session('two'),
		]);
		const pass = createValidationWorker(harness.deps).runPass();
		await vi.waitFor(() => expect(starts).toHaveLength(2));
		expect(maxActive).toBe(2);
		expect(harness.repository.claimVerifyingSessions).toHaveBeenCalledWith(
			'claim-token', 120_000, 2,
		);
		release();
		await expect(pass).resolves.toEqual({ claimed: 2, ready: 2, rejected: 0, retried: 0 });
	});

	it('does not preclaim a second row when capacity is one', async () => {
		const harness = workerDeps({ options: { concurrency: 1, claimLeaseMs: 120_000 } });
		await createValidationWorker(harness.deps).runPass();
		expect(harness.repository.claimVerifyingSessions).toHaveBeenCalledWith(
			'claim-token', 120_000, 1,
		);
	});

	it('keeps one long-running claim alive without preclaiming the next row', async () => {
		vi.useFakeTimers();
		try {
			const firstStarted = promiseGate();
			const secondStarted = promiseGate();
			const releaseFirst = promiseGate();
			const releaseSecond = promiseGate();
			const rows = [session('one'), session('two')];
			const leaseUntil = new Map<string, number>();
			const claimVerifyingSessions = vi.fn(async (
				_token: string,
				leaseMs: number,
				limit: number,
			) => rows.splice(0, limit).map((row) => {
				leaseUntil.set(row.id, Date.now() + leaseMs);
				return row;
			}));
			const renewCompletionClaim = vi.fn(async (
				sessionId: string,
				_token: string,
				leaseMs: number,
			) => {
				const persistedLease = leaseUntil.get(sessionId) ?? 0;
				if (persistedLease <= Date.now()) return { count: 0 };
				leaseUntil.set(sessionId, Date.now() + leaseMs);
				return { count: 1 };
			});
			let token = 0;
			const worker = createValidationWorker({
				repository: {
					claimVerifyingSessions,
					renewCompletionClaim,
					releaseCompletionClaim: vi.fn(async () => ({ count: 1 })),
					markCompletedObjectFailed: vi.fn(async () => ({ count: 1 })),
				},
				ids: { next: () => `claim-${++token}` },
				processor: {
					async process(item) {
						if (item.id === 'one') {
							firstStarted.resolve();
							await releaseFirst.promise;
						} else {
							secondStarted.resolve();
							await releaseSecond.promise;
						}
					},
				},
				wakeDeletionWorker: vi.fn(),
				logger: { info: vi.fn(), error: vi.fn() },
				options: { concurrency: 1, claimLeaseMs: 60_000, heartbeatMs: 1_000 },
			});
			const loop = createValidationWorkerLoop({
				runPass: (signal) => worker.runPass(signal),
				pollIntervalMs: 60_000,
				logger: { error: vi.fn() },
				scheduleEvery: () => ({ cancel: vi.fn() }),
			});
			const started = loop.start();
			await firstStarted.promise;
			const pendingWake = loop.wake();
			await vi.advanceTimersByTimeAsync(61_000);
			expect(claimVerifyingSessions).toHaveBeenCalledTimes(1);
			expect(leaseUntil.get('one')).toBeGreaterThan(Date.now());
			expect(renewCompletionClaim.mock.calls.length).toBeGreaterThan(1);
			expect(new Set(renewCompletionClaim.mock.calls.map(([id]) => id))).toEqual(new Set(['one']));

			releaseFirst.resolve();
			await secondStarted.promise;
			expect(claimVerifyingSessions).toHaveBeenCalledTimes(2);
			releaseSecond.resolve();
			await Promise.all([started, pendingWake]);
			await loop.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it('atomically rejects deterministic errors and retries transient failures', async () => {
		const rejected = workerDeps({
			processor: { process: vi.fn(async () => { throw badRequest('invalid ZIP'); }) },
		});
		await expect(createValidationWorker(rejected.deps).runPass()).resolves.toEqual({
			claimed: 1, ready: 0, rejected: 1, retried: 0,
		});
		expect(rejected.repository.markCompletedObjectFailed).toHaveBeenCalledWith({
			sessionId: 'one',
			storageKey: 'one.zip',
			reason: 'game-direct-validation-rejected',
			completionClaimToken: 'claim-token',
		});
		expect(rejected.deps.wakeDeletionWorker).toHaveBeenCalledOnce();

		const transient = workerDeps({
			processor: { process: vi.fn(async () => { throw new Error('storage unavailable'); }) },
		});
		await expect(createValidationWorker(transient.deps).runPass()).resolves.toEqual({
			claimed: 1, ready: 0, rejected: 0, retried: 1,
		});
		expect(transient.repository.markCompletedObjectFailed).not.toHaveBeenCalled();
		expect(transient.repository.releaseCompletionClaim).toHaveBeenCalledWith(
			'one', 'claim-token', 'validation-retry',
		);
	});

	it('prevents a stale token from reaching a final mutation', async () => {
		const harness = workerDeps({
			processor: {
				async process(_item, context) {
					await context.assertClaimOwned();
					throw badRequest('would otherwise reject');
				},
			},
		});
		harness.repository.renewCompletionClaim
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		await createValidationWorker(harness.deps).runPass();
		expect(harness.repository.markCompletedObjectFailed).not.toHaveBeenCalled();
	});
});

describe('validation worker process single-flight', () => {
	it('coalesces a wake storm into one pending pass without overlapping passes', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let active = 0;
		let maxActive = 0;
		const runPass = vi.fn(async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			if (runPass.mock.calls.length === 1) await gate;
			active -= 1;
		});
		const scheduled: Array<() => void> = [];
		const runtime = createValidationWorkerLoop({
			runPass,
			pollIntervalMs: 1_000,
			logger: { error: vi.fn() },
			scheduleEvery: (_ms, task) => {
				scheduled.push(task);
				return { cancel: vi.fn() };
			},
		});
		const starting = runtime.start();
		await vi.waitFor(() => expect(runPass).toHaveBeenCalledOnce());
		const wakes = Array.from({ length: 100 }, () => runtime.wake());
		expect(runtime.isRunning()).toBe(true);
		release();
		await Promise.all([starting, ...wakes]);
		expect(runPass).toHaveBeenCalledTimes(2);
		expect(maxActive).toBe(1);
		expect(scheduled).toHaveLength(1);
		await runtime.close();
	});

	it('recovers a failed pass on the next periodic poll', async () => {
		const runPass = vi.fn()
			.mockRejectedValueOnce(new Error('database down'))
			.mockResolvedValue(undefined);
		let poll!: () => void;
		const runtime = createValidationWorkerLoop({
			runPass,
			pollIntervalMs: 1_000,
			logger: { error: vi.fn() },
			scheduleEvery: (_ms, task) => {
				poll = task;
				return { cancel: vi.fn() };
			},
		});
		await runtime.start();
		poll();
		await vi.waitFor(() => expect(runPass).toHaveBeenCalledTimes(2));
		await runtime.close();
	});
});
