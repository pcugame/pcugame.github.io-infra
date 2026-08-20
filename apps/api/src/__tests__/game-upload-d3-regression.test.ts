import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGameUploadService } from '../modules/admin/game-upload/service.js';
import type {
	GameUploadPartRecord,
	GameUploadServiceDependencies,
	GameUploadSessionRecord,
} from '../modules/admin/game-upload/ports.js';
import {
	SOURCE_IDENTITY_ALGORITHM,
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
	sourceIdentityRoot,
} from '../modules/admin/game-upload/source-identity.js';
import { createDurableGameUploadRepository } from './helpers/upload-lifecycle.js';

/** Equal-length, byte-different source files for the original D3 failure mode. */
const SOURCE_A = Buffer.alloc(SOURCE_IDENTITY_BLOCK_SIZE_BYTES, 0x41);
const SOURCE_B = Buffer.alloc(SOURCE_IDENTITY_BLOCK_SIZE_BYTES, 0x42);

function sourceIdentity(bytes: Buffer) {
	const digest = createHash('sha256').update(bytes).digest('hex');
	return {
		algorithm: SOURCE_IDENTITY_ALGORITHM,
		identity: sourceIdentityRoot(bytes.length, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, [digest]),
		blockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		manifest: Buffer.from(digest, 'hex'),
	};
}

const IDENTITY_A = sourceIdentity(SOURCE_A);
const IDENTITY_B = sourceIdentity(SOURCE_B);

function session(overrides: Partial<GameUploadSessionRecord> = {}): GameUploadSessionRecord {
	return {
		id: 'd3-session',
		projectId: 7,
		userId: 11,
		uploadKind: 'GAME',
		originalName: 'resume-a.zip',
		totalBytes: BigInt(SOURCE_A.length),
		chunkSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		totalChunks: 1,
		uploadedChunks: [],
		status: 'PENDING',
		expiresAt: new Date(Date.now() + 60_000),
		s3UploadId: 'multipart-d3',
		s3Key: 'protected/d3.zip',
		storageKey: null,
		parts: [],
		multipartGeneration: 1,
		project: { status: 'PUBLISHED' },
		sourceIdentityAlgorithm: IDENTITY_A.algorithm,
		sourceIdentity: IDENTITY_A.identity,
		sourceIdentityBlockSizeBytes: IDENTITY_A.blockSizeBytes,
		sourceIdentityBlockManifest: IDENTITY_A.manifest,
		...overrides,
	};
}

type UploadChunk = (
	sessionId: string,
	chunkIndex: number,
	body: NodeJS.ReadableStream,
	user: { id: number; role: string },
	identity: { sourceIdentityAlgorithm: string; sourceIdentity: string },
) => Promise<unknown>;

function createHarness(record = session()) {
	const parts = new Map<number, GameUploadPartRecord>();
	const objects = new Map<number, Buffer>();
	const uploadPart = vi.fn(async (
		_key: string,
		_uploadId: string,
		partNumber: number,
		body: NodeJS.ReadableStream,
	) => {
		const chunks: Buffer[] = [];
		for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		objects.set(partNumber, Buffer.concat(chunks));
		return `etag-${partNumber}`;
	});

	const repository = createDurableGameUploadRepository({
		findSessionById: vi.fn(async () => ({ ...record, parts: [...parts.values()] })),
		acquirePartClaim: vi.fn(async (input) => {
			const existing = parts.get(input.partNumber);
			if (existing) {
				if (existing.contentSha256 === input.contentSha256) {
					return { kind: 'already-uploaded' as const, parts: [...parts.values()] };
				}
				return { kind: 'conflict' as const };
			}
			return { kind: 'acquired' as const, token: input.token };
		}),
		completePartClaim: vi.fn(async (input) => {
			parts.set(1, {
				partNumber: 1,
				etag: input.etag,
				contentSha256: input.contentSha256,
				generation: 1,
			});
			return { accepted: true as const, parts: [...parts.values()] };
		}),
		findPartsBySessionId: vi.fn(async () => [...parts.values()]),
	});

	const deps: GameUploadServiceDependencies = {
		repository,
		storage: {
			createMultipart: vi.fn(async () => 'multipart-new'),
			abortMultipart: vi.fn(async () => undefined),
			uploadPart,
			completeMultipart: vi.fn(async () => undefined),
			listParts: vi.fn(async () => [...parts.values()]),
			listMultipartUploads: vi.fn(async () => []),
			head: vi.fn(async () => ({ size: SOURCE_A.length, contentType: 'application/zip' })),
		},
		finalizer: {
			finalize: vi.fn(async () => ({
				status: 'COMPLETED' as const,
				storageKey: 'protected/d3.zip',
				sizeBytes: SOURCE_A.length,
			})),
		},
		settings: { get: vi.fn(async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 1 })) },
		uploadSlots: { acquire: vi.fn(), release: vi.fn() },
		clock: { now: () => new Date() },
		ids: { next: vi.fn(() => 'claim-d3') },
		lifecycle: { isAcceptingNewWork: () => true },
		config: { uploadChunkSizeMb: 1, uploadSessionTtlMinutes: 60 },
		roleGameMaxBytes: () => 5120 * 1024 * 1024,
		storageKey: () => 'protected/d3.zip',
		deleteOrQueue: vi.fn(async () => undefined),
		wakeDeletionWorker: vi.fn(),
		wakeMaintenance: vi.fn(),
		recordUntrackedMultipartCleanupFailure: vi.fn(),
		logger: { error: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
	};

	return {
		service: createGameUploadService(deps),
		repository,
		storage: { uploadPart, objects },
		setRecord(next: GameUploadSessionRecord) {
			vi.mocked(repository.findSessionById).mockResolvedValue({ ...next, parts: [...parts.values()] });
		},
	};
}

function callUpload(
	service: ReturnType<typeof createGameUploadService>,
	bytes: Buffer,
	identity = IDENTITY_A,
) {
	const uploadChunk = service.uploadChunk as unknown as UploadChunk;
	return uploadChunk(
		'd3-session',
		0,
		Readable.from([bytes]),
		{ id: 11, role: 'USER' },
		{ sourceIdentityAlgorithm: identity.algorithm, sourceIdentity: identity.identity },
	);
}

afterEach(() => vi.restoreAllMocks());

describe('D3 upload source identity regression', () => {
	it('B1: retries the same part content idempotently without a second storage write', async () => {
		const harness = createHarness();

		await expect(callUpload(harness.service, SOURCE_A)).resolves.toMatchObject({
			index: 0,
			bytesWritten: SOURCE_A.length,
		});
		const storedBeforeRetry = Buffer.from(harness.storage.objects.get(1)!);

		await expect(callUpload(harness.service, SOURCE_A)).resolves.toMatchObject({ index: 0 });
		expect(harness.storage.uploadPart).toHaveBeenCalledOnce();
		expect(harness.storage.objects.get(1)).toEqual(storedBeforeRetry);
	});

	it('B2: rejects same-size different bytes and leaves the existing part unchanged', async () => {
		const harness = createHarness();
		await callUpload(harness.service, SOURCE_A);
		const storedBeforeAttack = Buffer.from(harness.storage.objects.get(1)!);

		await expect(callUpload(harness.service, SOURCE_B, IDENTITY_A)).rejects.toMatchObject({
			statusCode: 409,
			code: 'CONFLICT',
			details: { reason: 'CHUNK_CONTENT_MISMATCH' },
		});
		expect(harness.storage.uploadPart).toHaveBeenCalledOnce();
		expect(harness.storage.objects.get(1)).toEqual(storedBeforeAttack);
	});

	it('B3: rejects a direct wrong-source request before it can mutate storage', async () => {
		const harness = createHarness();

		await expect(callUpload(harness.service, SOURCE_B, IDENTITY_B)).rejects.toMatchObject({
			statusCode: 409,
			code: 'CONFLICT',
			details: { reason: 'SOURCE_IDENTITY_MISMATCH' },
		});
		expect(harness.storage.uploadPart).not.toHaveBeenCalled();
		expect(harness.storage.objects.size).toBe(0);
	});

	it('B4: fails closed for an identity-less legacy session without storage mutation', async () => {
		const harness = createHarness(session({
			sourceIdentityAlgorithm: null,
			sourceIdentity: null,
			sourceIdentityBlockSizeBytes: null,
			sourceIdentityBlockManifest: null,
		}));

		await expect(callUpload(harness.service, SOURCE_A)).rejects.toMatchObject({
			statusCode: 409,
			code: 'CONFLICT',
			details: { reason: 'LEGACY_UPLOAD_SESSION' },
		});
		expect(harness.storage.uploadPart).not.toHaveBeenCalled();
		expect(harness.storage.objects.size).toBe(0);
	});
});
