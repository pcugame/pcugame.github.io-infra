import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
	GameUploadServiceDependencies,
	GameUploadSessionRecord,
	GameUploadStoredPartRecord,
} from '../modules/admin/game-upload/ports.js';
import {
	createGameUploadPartSigningDependencies,
	createGameUploadService,
} from '../modules/admin/game-upload/service.js';
import {
	getSessionStatus,
	sweepStaleCompletingSessions,
} from '../modules/admin/game-upload/session-maintenance.service.js';
import { forbidden } from '../shared/errors.js';
import { createDurableGameUploadRepository } from './helpers/upload-lifecycle.js';
import {
	assertMultipartPartCount,
	MAX_MULTIPART_PARTS,
} from '../modules/admin/game-upload/direct-multipart.js';

const MIB = 1024 * 1024;

function directSession(
	overrides: Partial<GameUploadSessionRecord> = {},
): GameUploadSessionRecord {
	const digests = Array.from({ length: 6 }, (_, index) => (
		createHash('sha256').update(Buffer.alloc(MIB, index)).digest()
	));
	return {
		id: 'direct-session',
		projectId: 7,
		userId: 11,
		uploadKind: 'GAME',
		transport: 'DIRECT_MULTIPART',
		originalName: 'game.zip',
		totalBytes: 6n * BigInt(MIB),
		chunkSizeBytes: 5 * MIB,
		totalChunks: 2,
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
		sourceIdentity: 'a'.repeat(64),
		sourceIdentityBlockSizeBytes: MIB,
		sourceIdentityBlockManifest: Buffer.concat(digests),
		uploadedChunks: [],
		status: 'PENDING',
		expiresAt: new Date('2026-08-20T01:00:00.000Z'),
		s3UploadId: 'upload-1',
		s3Key: 'direct-generation.zip',
		storageKey: null,
		parts: [],
		multipartGeneration: 3,
		project: { status: 'PUBLISHED' },
		...overrides,
	};
}

function harness(session = directSession()) {
	const storedParts: GameUploadStoredPartRecord[] = [
		{ partNumber: 1, etag: '"garage-1"', sizeBytes: 5 * MIB },
		{ partNumber: 2, etag: '"garage-2"', sizeBytes: MIB },
	];
	const repository = createDurableGameUploadRepository({
		findSessionById: vi.fn(async () => session),
		isSessionActive: vi.fn(async () => true),
		claimCompletion: vi.fn(async () => ({ count: 1, reason: null })),
		markVerifying: vi.fn(async () => ({ count: 1 })),
		revertToPending: vi.fn(async () => ({ count: 1 })),
	});
	let storageCompleted = false;
	const storage = {
		createMultipart: vi.fn(async () => 'upload-new'),
		abortMultipart: vi.fn(async () => undefined),
		uploadPart: vi.fn(async () => 'legacy-etag'),
		completeMultipart: vi.fn(async () => { storageCompleted = true; }),
		listParts: vi.fn(async () => storedParts),
		listMultipartUploads: vi.fn(async () => []),
		head: vi.fn(async () => storageCompleted
			? { size: 6 * MIB, contentType: 'application/zip' }
			: null),
	};
	const signer = vi.fn(async (
		_key: string,
		_uploadId: string,
		partNumber: number,
	) => `https://garage.example.test/part/${partNumber}?signature=secret`);
	const authorizeProjectWrite = vi.fn(async () => undefined);
	const deps: GameUploadServiceDependencies = {
		repository,
		storage,
		partSigner: { presignUploadPart: signer },
		finalizer: { finalize: vi.fn() },
		settings: { get: vi.fn() },
		uploadSlots: { acquire: vi.fn(), release: vi.fn() },
		clock: { now: () => new Date('2026-08-20T00:00:00.000Z') },
		ids: { next: () => 'completion-token' },
		lifecycle: { isAcceptingNewWork: () => true },
		authorizeProjectWrite,
		config: {
			uploadChunkSizeMb: 5,
			uploadSessionTtlMinutes: 60,
			uploadPartUrlBatchMax: 16,
			uploadPartUrlTtlSeconds: 300,
		},
		roleGameMaxBytes: () => 10 * MIB,
		storageKey: () => 'unused.zip',
		deleteOrQueue: vi.fn(async () => undefined),
		wakeDeletionWorker: vi.fn(),
		wakeMaintenance: vi.fn(),
		wakeValidationWorker: vi.fn(),
		recordUntrackedMultipartCleanupFailure: vi.fn(),
		logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
	};
	return {
		deps,
		repository,
		storage,
		signer,
		authorizeProjectWrite,
		service: createGameUploadService(deps),
		storedParts,
	};
}

describe('direct multipart game upload control plane', () => {
	it('accepts the S3 part-count boundary and rejects one part beyond it', () => {
		expect(() => assertMultipartPartCount(MAX_MULTIPART_PARTS)).not.toThrow();
		expect(() => assertMultipartPartCount(MAX_MULTIPART_PARTS + 1)).toThrow(
			`between 1 and ${MAX_MULTIPART_PARTS} parts`,
		);
	});

	it('issues only bounded, current-generation UploadPart capabilities', async () => {
		const { service, signer, authorizeProjectWrite } = harness();
		await expect(service.signPartUrls(
			'direct-session',
			{ id: 11, role: 'USER' },
			{ generation: 3, partNumbers: [2, 1] },
		)).resolves.toMatchObject({
			generation: 3,
			parts: [{ partNumber: 1 }, { partNumber: 2 }],
		});
		expect(authorizeProjectWrite).toHaveBeenCalledWith(
			{ id: 11, role: 'USER' },
			7,
		);
		expect(signer).toHaveBeenNthCalledWith(
			1,
			'direct-generation.zip',
			'upload-1',
			1,
			300,
		);
	});

	it('injects no completion, abort, delete, or byte relay authority into part signing', () => {
		const { deps } = harness();
		const signingDeps = createGameUploadPartSigningDependencies(deps);
		expect(Object.keys(signingDeps).sort()).toEqual([
			'authorizeProjectWrite',
			'clock',
			'config',
			'logger',
			'partSigner',
			'repository',
		]);
		expect(Object.keys(signingDeps.repository).sort()).toEqual([
			'findSessionById',
			'isSessionActive',
		]);
		expect(Object.keys(signingDeps.partSigner)).toEqual(['presignUploadPart']);
		expect(signingDeps).not.toHaveProperty('storage');
		expect(signingDeps).not.toHaveProperty('finalizer');
		expect(signingDeps).not.toHaveProperty('deleteOrQueue');
	});

	it('rejects stale generations, duplicate parts, and signing after access removal', async () => {
		const stale = harness();
		await expect(stale.service.signPartUrls(
			'direct-session', { id: 11, role: 'USER' }, { generation: 2, partNumbers: [1] },
		)).rejects.toMatchObject({ statusCode: 409 });
		await expect(stale.service.signPartUrls(
			'direct-session', { id: 11, role: 'USER' }, { generation: 3, partNumbers: [1, 1] },
		)).rejects.toMatchObject({ statusCode: 400 });

		const removed = harness();
		removed.authorizeProjectWrite.mockRejectedValueOnce(forbidden('Not project owner or member'));
		await expect(removed.service.signPartUrls(
			'direct-session', { id: 11, role: 'USER' }, { generation: 3, partNumbers: [1] },
		)).rejects.toMatchObject({ statusCode: 403 });
		expect(removed.signer).not.toHaveBeenCalled();
	});

	it('completes with Garage ListParts data and returns VERIFYING without finalizing an Asset', async () => {
		const { service, storage, repository, deps } = harness();
		await expect(service.completeSession(
			'direct-session',
			{ id: 11, role: 'USER' },
			{
				generation: 3,
				parts: [
					{ partNumber: 2, etag: 'garage-2', sizeBytes: MIB },
					{ partNumber: 1, etag: 'garage-1', sizeBytes: 5 * MIB },
				],
			},
		)).resolves.toEqual({
			status: 'VERIFYING',
			sessionId: 'direct-session',
			generation: 3,
			sizeBytes: 6 * MIB,
		});
		expect(storage.completeMultipart).toHaveBeenCalledWith(
			'direct-generation.zip',
			'upload-1',
			[
				{ partNumber: 1, etag: '"garage-1"' },
				{ partNumber: 2, etag: '"garage-2"' },
			],
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(repository.markVerifying).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: 'direct-session',
			generation: 3,
			verifiedSizeBytes: 6 * MIB,
		}));
		expect(deps.finalizer.finalize).not.toHaveBeenCalled();
		expect(deps.wakeValidationWorker).toHaveBeenCalledOnce();
	});

	it.each(['VERIFYING', 'COMPLETED'] as const)(
		'requires a current-generation manifest before idempotent %s response',
		async (status) => {
			const completionResult = status === 'COMPLETED'
				? { status: 'COMPLETED', storageKey: 'direct-generation.zip', sizeBytes: 6 * MIB }
				: undefined;
			const current = harness(directSession({ status, completionResult }));
			await expect(current.service.completeSession(
				'direct-session',
				{ id: 11, role: 'USER' },
			)).rejects.toMatchObject({ statusCode: 400 });
			await expect(current.service.completeSession(
				'direct-session',
				{ id: 11, role: 'USER' },
				{ generation: 2, parts: [] },
			)).rejects.toMatchObject({ statusCode: 409 });

			await expect(current.service.completeSession(
				'direct-session',
				{ id: 11, role: 'USER' },
				{ generation: 3, parts: [] },
			)).resolves.toMatchObject({ status });
			expect(current.storage.completeMultipart).not.toHaveBeenCalled();
		},
	);

	it('preserves bodyless idempotency for completed legacy proxy sessions', async () => {
		const legacy = harness(directSession({
			transport: 'API_CHUNK_PROXY',
			status: 'COMPLETED',
			completionResult: {
				status: 'COMPLETED',
				storageKey: 'legacy-generation.zip',
				sizeBytes: 6 * MIB,
			},
		}));
		await expect(legacy.service.completeSession(
			'direct-session',
			{ id: 11, role: 'USER' },
		)).resolves.toMatchObject({
			status: 'COMPLETED',
			storageKey: 'legacy-generation.zip',
		});
	});

	it('never trusts a client ETag or missing ListParts size', async () => {
		const mismatch = harness();
		await expect(mismatch.service.completeSession(
			'direct-session',
			{ id: 11, role: 'USER' },
			{
				generation: 3,
				parts: [
					{ partNumber: 1, etag: 'client-forged', sizeBytes: 5 * MIB },
					{ partNumber: 2, etag: 'garage-2', sizeBytes: MIB },
				],
			},
		)).rejects.toMatchObject({ statusCode: 409 });
		expect(mismatch.storage.completeMultipart).not.toHaveBeenCalled();
		expect(mismatch.repository.revertToPending).toHaveBeenCalled();

		const missingSize = harness();
		missingSize.storage.listParts.mockResolvedValueOnce([
			{ partNumber: 1, etag: 'garage-1' },
			{ partNumber: 2, etag: 'garage-2', sizeBytes: MIB },
		] as GameUploadStoredPartRecord[]);
		await expect(missingSize.service.completeSession(
			'direct-session',
			{ id: 11, role: 'USER' },
			{
				generation: 3,
				parts: [
					{ partNumber: 1, etag: 'garage-1', sizeBytes: 5 * MIB },
					{ partNumber: 2, etag: 'garage-2', sizeBytes: MIB },
				],
			},
		)).rejects.toMatchObject({ statusCode: 500 });
		expect(missingSize.storage.completeMultipart).not.toHaveBeenCalled();
	});

	it('recovers an ambiguous Complete response through HEAD into VERIFYING', async () => {
		const direct = harness();
		direct.storage.completeMultipart.mockRejectedValueOnce(new Error('response interrupted'));
		direct.storage.head.mockResolvedValue({ size: 6 * MIB, contentType: 'application/zip' });
		await expect(direct.service.completeSession(
			'direct-session',
			{ id: 11, role: 'USER' },
			{
				generation: 3,
				parts: [
					{ partNumber: 1, etag: 'garage-1', sizeBytes: 5 * MIB },
					{ partNumber: 2, etag: 'garage-2', sizeBytes: MIB },
				],
			},
		)).rejects.toThrow('response interrupted');
		expect(direct.repository.revertToPending).not.toHaveBeenCalled();
		expect(direct.repository.releaseCompletionClaim).toHaveBeenCalledWith(
			'direct-session',
			'completion-token',
			'direct-completion-deferred',
		);

		vi.mocked(direct.repository.claimStaleCompletingSessions).mockResolvedValueOnce([
			directSession({
				status: 'COMPLETING',
				completionClaimUntil: null,
			}),
		]);
		await expect(sweepStaleCompletingSessions(direct.deps)).resolves.toEqual({ swept: 1 });
		expect(direct.repository.markVerifying).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: 'direct-session',
			generation: 3,
			storageKey: 'direct-generation.zip',
			verifiedSizeBytes: 6 * MIB,
		}));
		expect(direct.deps.finalizer.finalize).not.toHaveBeenCalled();
	});

	it('preserves COMPLETING when post-Complete HEAD fails', async () => {
		const direct = harness();
		direct.storage.head.mockRejectedValueOnce(new Error('HEAD unavailable'));
		await expect(direct.service.completeSession(
			'direct-session',
			{ id: 11, role: 'USER' },
			{
				generation: 3,
				parts: [
					{ partNumber: 1, etag: 'garage-1', sizeBytes: 5 * MIB },
					{ partNumber: 2, etag: 'garage-2', sizeBytes: MIB },
				],
			},
		)).rejects.toThrow('HEAD unavailable');
		expect(direct.repository.markVerifying).not.toHaveBeenCalled();
		expect(direct.repository.revertToPending).not.toHaveBeenCalled();
		expect(direct.repository.releaseCompletionClaim).toHaveBeenCalled();
	});

	it('preserves COMPLETING when neither HEAD nor ListParts resolves an ambiguous Complete', async () => {
		const direct = harness();
		direct.storage.completeMultipart.mockRejectedValueOnce(new Error('Complete response interrupted'));
		direct.storage.head.mockResolvedValueOnce(null);
		direct.storage.listParts
			.mockResolvedValueOnce(direct.storedParts)
			.mockRejectedValueOnce(new Error('ListParts unavailable'));
		await expect(direct.service.completeSession(
			'direct-session',
			{ id: 11, role: 'USER' },
			{
				generation: 3,
				parts: [
					{ partNumber: 1, etag: 'garage-1', sizeBytes: 5 * MIB },
					{ partNumber: 2, etag: 'garage-2', sizeBytes: MIB },
				],
			},
		)).rejects.toThrow('Complete response interrupted');
		expect(direct.repository.markVerifying).not.toHaveBeenCalled();
		expect(direct.repository.revertToPending).not.toHaveBeenCalled();
		expect(direct.repository.releaseCompletionClaim).toHaveBeenCalled();
	});

	it('reconciles a Garage part uploaded before any DB control message', async () => {
		const { deps, storage } = harness();
		storage.listParts.mockResolvedValueOnce([
			{ partNumber: 1, etag: 'garage-1', sizeBytes: 5 * MIB },
		]);
		await expect(getSessionStatus(
			deps,
			'direct-session',
			{ id: 11, role: 'USER' },
		)).resolves.toMatchObject({
			transport: 'DIRECT_MULTIPART',
			generation: 3,
			uploadedChunks: [0],
			parts: [{ partNumber: 1, etag: 'garage-1', sizeBytes: 5 * MIB }],
		});
	});

	it('records upload expiration separately from a manual cancellation', async () => {
		const expired = harness(directSession({
			expiresAt: new Date('2026-08-19T00:00:00.000Z'),
		}));
		await expect(getSessionStatus(
			expired.deps,
			'direct-session',
			{ id: 11, role: 'USER' },
		)).rejects.toMatchObject({ statusCode: 400 });
		expect(expired.repository.expireSessionAndClearActive).toHaveBeenCalledWith(
			'direct-session',
		);
		expect(expired.repository.cancelSessionAndClearActive).not.toHaveBeenCalled();
	});

	it('fails closed on expired signing without owning abort or expiration cleanup', async () => {
		const expired = harness(directSession({
			expiresAt: new Date('2026-08-19T00:00:00.000Z'),
		}));
		await expect(expired.service.signPartUrls(
			'direct-session',
			{ id: 11, role: 'USER' },
			{ generation: 3, partNumbers: [1] },
		)).rejects.toMatchObject({ statusCode: 400 });
		expect(expired.repository.expireSessionAndClearActive).not.toHaveBeenCalled();
		expect(expired.storage.abortMultipart).not.toHaveBeenCalled();
		expect(expired.signer).not.toHaveBeenCalled();
	});

	it.each([
		['removed member', forbidden('Not project owner or member')],
		['upload-disabled exhibition', forbidden('Upload is disabled')],
	] as const)(
		'checks current %s policy before expired status/complete/cancel/legacy preParsing mutation',
		async (_reason, policyError) => {
			const actions = [
				(service: ReturnType<typeof createGameUploadService>) => service.getSessionStatus(
					'direct-session', { id: 11, role: 'USER' },
				),
				(service: ReturnType<typeof createGameUploadService>) => service.completeSession(
					'direct-session',
					{ id: 11, role: 'USER' },
					{ generation: 3, parts: [] },
				),
				(service: ReturnType<typeof createGameUploadService>) => service.cancelSession(
					'direct-session', { id: 11, role: 'USER' },
				),
				(service: ReturnType<typeof createGameUploadService>) => (
					service.authorizeLegacyChunkUpload(
						'direct-session', { id: 11, role: 'USER' },
					)
				),
			];
			for (const action of actions) {
				const denied = harness(directSession({
					expiresAt: new Date('2026-08-19T00:00:00.000Z'),
				}));
				denied.authorizeProjectWrite.mockRejectedValueOnce(policyError);
				await expect(action(denied.service)).rejects.toMatchObject({ statusCode: 403 });
				expect(denied.repository.expireSessionAndClearActive).not.toHaveBeenCalled();
				expect(denied.storage.abortMultipart).not.toHaveBeenCalled();
			}
		},
	);
});
