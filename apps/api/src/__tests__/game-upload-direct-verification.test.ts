import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCompletedUploadFinalizer } from '../modules/admin/game-upload/finalize-completed-upload.service.js';
import type {
	GameUploadServiceDependencies,
	GameUploadSessionSummary,
} from '../modules/admin/game-upload/ports.js';
import {
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
	sourceIdentityRoot,
	validateCompletedSourceIdentity,
} from '../modules/admin/game-upload/source-identity.js';
import { sweepVerifyingSessions } from '../modules/admin/game-upload/session-maintenance.service.js';
import { badRequest } from '../shared/errors.js';
import { createDurableGameUploadRepository } from './helpers/upload-lifecycle.js';
import { validateZipArchiveObject } from '../modules/assets/upload/zip-validation.js';

function identity(bytes: Buffer) {
	const digests: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += SOURCE_IDENTITY_BLOCK_SIZE_BYTES) {
		digests.push(createHash('sha256').update(
			bytes.subarray(offset, Math.min(bytes.length, offset + SOURCE_IDENTITY_BLOCK_SIZE_BYTES)),
		).digest('hex'));
	}
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
		sourceIdentity: sourceIdentityRoot(
			bytes.length,
			SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
			digests,
		),
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockManifest: Buffer.concat(digests.map((digest) => Buffer.from(digest, 'hex'))),
	};
}

function verifyingSession(bytes: Buffer): GameUploadSessionSummary {
	return {
		id: 'verify-session',
		projectId: 7,
		userId: 11,
		uploadKind: 'GAME',
		transport: 'DIRECT_MULTIPART',
		originalName: 'game.zip',
		totalBytes: BigInt(bytes.length),
		chunkSizeBytes: 5 * 1024 * 1024,
		totalChunks: 1,
		...identity(bytes),
		uploadedChunks: [],
		status: 'VERIFYING',
		expiresAt: new Date('2026-08-21T00:00:00.000Z'),
		s3UploadId: null,
		s3Key: 'verify-generation.zip',
		storageKey: 'verify-generation.zip',
		multipartGeneration: 1,
	};
}

function workerHarness(
	session: GameUploadSessionSummary,
	finalize: GameUploadServiceDependencies['finalizer']['finalize'],
) {
	const repository = createDurableGameUploadRepository({
		claimVerifyingSessions: vi.fn(async () => [session]),
		markCompletedObjectFailed: vi.fn(async () => ({ count: 1 })),
		releaseCompletionClaim: vi.fn(async () => ({ count: 1 })),
	});
	const deps: GameUploadServiceDependencies = {
		repository,
		storage: {
			createMultipart: vi.fn(),
			abortMultipart: vi.fn(),
			uploadPart: vi.fn(),
			completeMultipart: vi.fn(),
			listParts: vi.fn(async () => []),
			listMultipartUploads: vi.fn(async () => []),
			head: vi.fn(async () => ({ size: Number(session.totalBytes), contentType: 'application/zip' })),
		},
		partSigner: { presignUploadPart: vi.fn() },
		finalizer: { finalize },
		settings: { get: vi.fn() },
		uploadSlots: { acquire: vi.fn(), release: vi.fn() },
		clock: { now: () => new Date('2026-08-20T00:00:00.000Z') },
		ids: { next: () => 'validation-claim' },
		lifecycle: { isAcceptingNewWork: () => true },
		authorizeProjectWrite: vi.fn(async () => undefined),
		config: {
			uploadChunkSizeMb: 5,
			uploadSessionTtlMinutes: 60,
			uploadPartUrlBatchMax: 16,
			uploadPartUrlTtlSeconds: 300,
		},
		roleGameMaxBytes: () => 1,
		storageKey: () => 'unused',
		deleteOrQueue: vi.fn(),
		wakeDeletionWorker: vi.fn(),
		wakeMaintenance: vi.fn(),
		wakeValidationWorker: vi.fn(),
		recordUntrackedMultipartCleanupFailure: vi.fn(),
		logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
	};
	return { deps, repository };
}

describe('direct upload source identity validation', () => {
	it('reads fixed-size ranges and matches every block plus the root', async () => {
		const bytes = Buffer.alloc(SOURCE_IDENTITY_BLOCK_SIZE_BYTES * 2 + 17, 0x41);
		const source = identity(bytes);
		const readRange = vi.fn(async (start: number, end: number) => bytes.subarray(start, end + 1));
		const assertClaimOwned = vi.fn(async () => undefined);

		await expect(validateCompletedSourceIdentity({
			totalBytes: BigInt(bytes.length),
			...source,
			readRange,
			assertClaimOwned,
		})).resolves.toBeUndefined();
		expect(readRange).toHaveBeenCalledTimes(3);
		expect(readRange).toHaveBeenNthCalledWith(1, 0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES - 1);
		expect(readRange).toHaveBeenNthCalledWith(
			3,
			SOURCE_IDENTITY_BLOCK_SIZE_BYTES * 2,
			bytes.length - 1,
		);
		expect(assertClaimOwned).toHaveBeenCalledTimes(6);
	});

	it('fails deterministically on mismatch and stops when its claim is lost', async () => {
		const expected = Buffer.alloc(SOURCE_IDENTITY_BLOCK_SIZE_BYTES * 2, 0x41);
		const actual = Buffer.from(expected);
		actual[SOURCE_IDENTITY_BLOCK_SIZE_BYTES] = 0x42;
		await expect(validateCompletedSourceIdentity({
			totalBytes: BigInt(expected.length),
			...identity(expected),
			readRange: async (start, end) => actual.subarray(start, end + 1),
		})).rejects.toMatchObject({ statusCode: 400 });

		const readRange = vi.fn(async (start: number, end: number) => expected.subarray(start, end + 1));
		let claimChecks = 0;
		await expect(validateCompletedSourceIdentity({
			totalBytes: BigInt(expected.length),
			...identity(expected),
			readRange,
			assertClaimOwned: async () => {
				claimChecks += 1;
				if (claimChecks === 3) throw new Error('claim lost');
			},
		})).rejects.toThrow('claim lost');
		expect(readRange).toHaveBeenCalledOnce();
	});
});

describe('direct upload verification worker', () => {
	it('commits READY only through the claimed finalizer', async () => {
		const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
		const finalize = vi.fn(async () => ({
			status: 'COMPLETED' as const,
			storageKey: 'verify-generation.zip',
			sizeBytes: bytes.length,
		}));
		const { deps } = workerHarness(verifyingSession(bytes), finalize);
		await expect(sweepVerifyingSessions(deps)).resolves.toEqual({
			claimed: 1,
			ready: 1,
			rejected: 0,
		});
		expect(finalize).toHaveBeenCalledWith(
			expect.objectContaining({
				transport: 'DIRECT_MULTIPART',
				sourceIdentity: expect.any(String),
			}),
			expect.objectContaining({ size: bytes.length }),
			expect.objectContaining({ assertClaimOwned: expect.any(Function) }),
		);
	});

	it('atomically rejects deterministic failures and retries transient failures', async () => {
		const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
		const rejected = workerHarness(
			verifyingSession(bytes),
			vi.fn(async () => { throw badRequest('source identity mismatch'); }),
		);
		await expect(sweepVerifyingSessions(rejected.deps)).resolves.toEqual({
			claimed: 1,
			ready: 0,
			rejected: 1,
		});
		expect(rejected.repository.markCompletedObjectFailed).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'verify-session',
				completionClaimToken: 'validation-claim',
			}),
		);
		expect(rejected.deps.wakeDeletionWorker).toHaveBeenCalledOnce();

		const transient = workerHarness(
			verifyingSession(bytes),
			vi.fn(async () => { throw new Error('database unavailable'); }),
		);
		await expect(sweepVerifyingSessions(transient.deps)).resolves.toEqual({
			claimed: 1,
			ready: 0,
			rejected: 0,
		});
		expect(transient.repository.markCompletedObjectFailed).not.toHaveBeenCalled();
		expect(transient.repository.releaseCompletionClaim).toHaveBeenCalledWith(
			'verify-session',
			'validation-claim',
			'validation-retry',
		);
		expect(transient.deps.logger.info).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'validation_retry',
				projectId: 7,
				sessionId: 'verify-session',
				generation: 1,
			}),
			'validation_retry',
		);
	});

	it('connects source mismatch to deterministic rejection before ZIP finalization', async () => {
		const declared = Buffer.alloc(32, 0x41);
		const uploaded = Buffer.alloc(32, 0x42);
		const session = verifyingSession(declared);
		const readHeader = vi.fn();
		const finalizer = createCompletedUploadFinalizer({
			validateSourceIdentity: (completed, options) => validateCompletedSourceIdentity({
				totalBytes: completed.totalBytes,
				sourceIdentityAlgorithm: completed.sourceIdentityAlgorithm,
				sourceIdentity: completed.sourceIdentity,
				sourceIdentityBlockSizeBytes: completed.sourceIdentityBlockSizeBytes,
				sourceIdentityBlockManifest: completed.sourceIdentityBlockManifest,
				readRange: async (start, end) => uploaded.subarray(start, end + 1),
				assertClaimOwned: options.assertClaimOwned,
			}),
			readHeader,
			validateGameArchive: vi.fn(),
			deployWebgl: vi.fn(),
			rollbackWebglPublicDeployment: vi.fn(),
			finalizeGame: vi.fn(),
			finalizeWebgl: vi.fn(),
			wakeDeletionWorker: vi.fn(),
			webglUrl: () => '',
			logError: vi.fn(),
		});
		const worker = workerHarness(session, finalizer.finalize);
		await expect(sweepVerifyingSessions(worker.deps)).resolves.toMatchObject({ rejected: 1 });
		expect(readHeader).not.toHaveBeenCalled();
		expect(worker.repository.markCompletedObjectFailed).toHaveBeenCalledOnce();
	});

	it('classifies impossible EOCD metadata as deterministic rejection', async () => {
		const uploaded = Buffer.alloc(52);
		uploaded.writeUInt32LE(0x04034b50, 0);
		const eocdOffset = uploaded.length - 22;
		uploaded.writeUInt32LE(0x06054b50, eocdOffset);
		uploaded.writeUInt16LE(1, eocdOffset + 8);
		uploaded.writeUInt16LE(1, eocdOffset + 10);
		uploaded.writeUInt32LE(0, eocdOffset + 12);
		uploaded.writeUInt32LE(eocdOffset, eocdOffset + 16);
		const session = verifyingSession(uploaded);
		const finalizeGame = vi.fn();
		const finalizer = createCompletedUploadFinalizer({
			validateSourceIdentity: (completed, options) => validateCompletedSourceIdentity({
				totalBytes: completed.totalBytes,
				sourceIdentityAlgorithm: completed.sourceIdentityAlgorithm,
				sourceIdentity: completed.sourceIdentity,
				sourceIdentityBlockSizeBytes: completed.sourceIdentityBlockSizeBytes,
				sourceIdentityBlockManifest: completed.sourceIdentityBlockManifest,
				readRange: async (start, end) => uploaded.subarray(start, end + 1),
				assertClaimOwned: options.assertClaimOwned,
			}),
			readHeader: async () => uploaded.subarray(0, 8),
			validateGameArchive: async (_key, size) => {
				await validateZipArchiveObject(
					size,
					async (start, end) => uploaded.subarray(start, end + 1),
				);
			},
			deployWebgl: vi.fn(),
			rollbackWebglPublicDeployment: vi.fn(),
			finalizeGame,
			finalizeWebgl: vi.fn(),
			wakeDeletionWorker: vi.fn(),
			webglUrl: () => '',
			logError: vi.fn(),
		});
		const worker = workerHarness(session, finalizer.finalize);

		await expect(sweepVerifyingSessions(worker.deps)).resolves.toEqual({
			claimed: 1,
			ready: 0,
			rejected: 1,
		});
		expect(finalizeGame).not.toHaveBeenCalled();
		expect(worker.repository.markCompletedObjectFailed).toHaveBeenCalledOnce();
	});
});
