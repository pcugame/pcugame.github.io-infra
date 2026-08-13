import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeSession } from '../modules/admin/game-upload/complete-session.service.js';
import { cancelSession } from '../modules/admin/game-upload/session-maintenance.service.js';
import { createCompletedUploadFinalizer } from '../modules/admin/game-upload/finalize-completed-upload.service.js';
import { createGameUploadService } from '../modules/admin/game-upload/service.js';
import type { GameUploadServiceDependencies } from '../modules/admin/game-upload/ports.js';
import type { WebglDeploymentKeys } from '../modules/webgl/paths.js';
import { createDurableGameUploadRepository } from './helpers/upload-lifecycle.js';

const sourceKey = 'webgl/7/123e4567-e89b-42d3-a456-426614174000/source.zip';
const deployed: WebglDeploymentKeys = {
	projectId: 7,
	deploymentId: '123e4567-e89b-42d3-a456-426614174000',
	deploymentPrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/',
	sourceKey,
	sitePrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/',
	entryKey: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/index.html',
};

function session() {
	return {
		id: 'session-webgl',
		projectId: 7,
		userId: 11,
		uploadKind: 'WEBGL' as const,
		originalName: 'webgl.zip',
		totalBytes: 8n,
		chunkSizeBytes: 8,
		totalChunks: 1,
		uploadedChunks: [],
		status: 'PENDING',
		expiresAt: new Date('2026-07-22T00:00:00.000Z'),
		s3UploadId: 'multipart',
		s3Key: sourceKey,
		parts: [{ partNumber: 1, etag: 'etag' }],
		project: { status: 'PUBLISHED' },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function createHarness() {
	const mocks = {
		findSessionById: vi.fn().mockResolvedValue(session()),
		findPartsBySessionId: vi.fn().mockResolvedValue([{ partNumber: 1, etag: 'etag' }]),
		finalizeCompletedWebglSession: vi.fn().mockResolvedValue({ oldEntryKey: '' }),
		finalizeGame: vi.fn().mockResolvedValue({
			oldStorageKey: null,
			oldPlaybackStorageKey: null,
		}),
		markFailed: vi.fn().mockResolvedValue({ count: 1 }),
		revertToPending: vi.fn().mockResolvedValue({ count: 1 }),
		completeMultipart: vi.fn().mockResolvedValue(undefined),
		head: vi.fn().mockResolvedValue({ size: 8, contentType: 'application/zip' }),
		readHeader: vi.fn().mockResolvedValue(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])),
		deleteOrQueue: vi.fn().mockResolvedValue(undefined),
		deployWebgl: vi.fn().mockResolvedValue(deployed),
		rollbackWebglPublicDeployment: vi.fn().mockResolvedValue(undefined),
		deleteWebglDeploymentByEntry: vi.fn().mockResolvedValue(undefined),
		markCompletedObjectFailed: vi.fn().mockResolvedValue({ count: 1 }),
		wakeDeletionWorker: vi.fn(),
		logError: vi.fn(),
		logWarn: vi.fn(),
	};
	const finalizer = createCompletedUploadFinalizer({
		readHeader: mocks.readHeader,
		validateGameArchive: vi.fn(),
		deployWebgl: mocks.deployWebgl,
		rollbackWebglPublicDeployment: mocks.rollbackWebglPublicDeployment,
		finalizeGame: mocks.finalizeGame,
		finalizeWebgl: mocks.finalizeCompletedWebglSession,
		wakeDeletionWorker: mocks.wakeDeletionWorker,
		webglUrl: () => 'http://localhost:4000/api/public/webgl/7/',
		logError: mocks.logError,
	});
	const deps: GameUploadServiceDependencies = {
		repository: createDurableGameUploadRepository({
			findSessionById: mocks.findSessionById,
			createSessionReplacingActive: vi.fn(),
			cancelSessionAndClearActive: vi.fn(),
			findPartsBySessionId: mocks.findPartsBySessionId,
			revertToPending: mocks.revertToPending,
			markFailed: mocks.markFailed,
			markCompletedObjectFailed: mocks.markCompletedObjectFailed,
			findActiveSessionsForListing: vi.fn(),
			findExhibitionById: vi.fn(),
		}),
		storage: {
			createMultipart: vi.fn(),
			abortMultipart: vi.fn(),
			uploadPart: vi.fn(),
			completeMultipart: mocks.completeMultipart,
			listParts: vi.fn(async () => [{ partNumber: 1, etag: 'etag' }]),
			listMultipartUploads: vi.fn(async () => []),
			head: mocks.head,
		},
		finalizer,
		settings: { get: vi.fn() },
		uploadSlots: { acquire: vi.fn(), release: vi.fn() },
		clock: { now: () => new Date('2026-07-21T00:00:00.000Z') },
		ids: { next: () => 'id' },
		lifecycle: { isAcceptingNewWork: () => true },
		config: { uploadChunkSizeMb: 10, uploadSessionTtlMinutes: 60 },
		roleGameMaxBytes: () => 1024,
		storageKey: () => sourceKey,
		deleteOrQueue: mocks.deleteOrQueue,
		wakeDeletionWorker: mocks.wakeDeletionWorker,
		wakeMaintenance: vi.fn(),
		recordUntrackedMultipartCleanupFailure: vi.fn(),
		logger: { error: mocks.logError, warn: mocks.logWarn, fatal: vi.fn() },
	};
	return {
		mocks,
		deps,
		complete: () => completeSession(deps, 'session-webgl', { id: 11, role: 'USER' }),
	};
}

function createRestartRecoveryHarness() {
	const durable = {
		session: session(),
		sourceExists: false,
		publicObjects: new Set<string>(),
		webglEntryKey: '',
		failNextPointerFinalization: true,
		events: [] as string[],
	};
	const processes: ReturnType<typeof createProcess>[] = [];

	function createProcess() {
		const rollbackWebglPublicDeployment = vi.fn(async (keys: { sitePrefix: string }) => {
			durable.events.push('public-rollback');
			for (const key of durable.publicObjects) {
				if (key.startsWith(keys.sitePrefix)) durable.publicObjects.delete(key);
			}
		});
		const deleteOrQueue = vi.fn(async (key: string) => {
			if (key === sourceKey) durable.sourceExists = false;
		});
		const wakeDeletionWorker = vi.fn();
		const finalizer = createCompletedUploadFinalizer({
			readHeader: async () => Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
			validateGameArchive: vi.fn(),
			deployWebgl: async () => {
				if (!durable.sourceExists) throw new Error('protected source missing');
				durable.events.push('public-deploy');
				durable.publicObjects.add(deployed.entryKey);
				durable.publicObjects.add(`${deployed.sitePrefix}Build/game.wasm`);
				return deployed;
			},
			rollbackWebglPublicDeployment,
			finalizeGame: vi.fn().mockResolvedValue({ oldStorageKey: null, oldPlaybackStorageKey: null }),
			finalizeWebgl: async () => {
				durable.events.push('db-pointer-finalize');
				if (durable.failNextPointerFinalization) {
					durable.failNextPointerFinalization = false;
					throw new Error('database pointer unavailable');
				}
				const oldEntryKey = durable.webglEntryKey;
				durable.webglEntryKey = deployed.entryKey;
				durable.session.status = 'COMPLETED';
				return { oldEntryKey };
			},
			wakeDeletionWorker,
			webglUrl: () => 'http://localhost:4000/api/public/webgl/7/',
			logError: vi.fn(),
		});
		const deps: GameUploadServiceDependencies = {
			repository: createDurableGameUploadRepository({
				findSessionById: async () => ({ ...durable.session }),
				createSessionReplacingActive: vi.fn(),
				cancelSessionAndClearActive: vi.fn(),
				claimCompletion: async () => {
					if (durable.session.status !== 'PENDING') {
						return { count: 0, reason: 'state' as const };
					}
					durable.session.status = 'COMPLETING';
					return { count: 1, reason: null };
				},
				findPartsBySessionId: async () => durable.session.parts,
				revertToPending: vi.fn(),
				markFailed: vi.fn(),
				claimStaleCompletingSessions: async () => (
					durable.session.status === 'COMPLETING' ? [{ ...durable.session }] : []
				),
				findActiveSessionsForListing: vi.fn(),
				findExhibitionById: vi.fn(),
			}),
			storage: {
				createMultipart: vi.fn(),
				abortMultipart: vi.fn(),
				uploadPart: vi.fn(),
				completeMultipart: async () => {
					durable.events.push('source-complete');
					durable.sourceExists = true;
				},
				listParts: async () => [{ partNumber: 1, etag: 'etag' }],
				listMultipartUploads: async () => [],
				head: async () => durable.sourceExists
					? { size: 8, contentType: 'application/zip' }
					: null,
			},
			finalizer,
			settings: { get: vi.fn() },
			uploadSlots: { acquire: vi.fn(), release: vi.fn() },
			clock: { now: () => new Date('2026-07-21T00:10:00.000Z') },
			ids: { next: () => 'id' },
			lifecycle: { isAcceptingNewWork: () => true },
			config: { uploadChunkSizeMb: 10, uploadSessionTtlMinutes: 60 },
			roleGameMaxBytes: () => 1024,
			storageKey: () => sourceKey,
			deleteOrQueue,
			wakeDeletionWorker,
			wakeMaintenance: vi.fn(),
			recordUntrackedMultipartCleanupFailure: vi.fn(),
			logger: { error: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
		};
		return {
			service: createGameUploadService(deps),
			rollbackWebglPublicDeployment,
			deleteOrQueue,
			wakeDeletionWorker,
		};
	}

	return {
		durable,
		newProcess() {
			const process = createProcess();
			processes.push(process);
			return process;
		},
		processes,
	};
}

describe('WebGL completion atomicity', () => {
	beforeEach(() => vi.clearAllMocks());

	it('does not swap the DB pointer before every hosted file is deployed', async () => {
		const { mocks, complete } = createHarness();
		const gate = deferred<WebglDeploymentKeys>();
		mocks.deployWebgl.mockReturnValue(gate.promise);

		const completion = complete();
		await vi.waitFor(() => expect(mocks.deployWebgl).toHaveBeenCalled());
		expect(mocks.finalizeCompletedWebglSession).not.toHaveBeenCalled();

		gate.resolve(deployed);
		await expect(completion).resolves.toMatchObject({
			status: 'COMPLETED',
			storageKey: sourceKey,
			webglUrl: 'http://localhost:4000/api/public/webgl/7/',
		});
		expect(mocks.finalizeCompletedWebglSession).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'session-webgl', projectId: 7 }),
			deployed,
		);
	});

	it('rejects a duplicate completion before calling multipart completion', async () => {
		const { mocks, deps, complete } = createHarness();
		deps.repository.claimCompletion = vi.fn().mockResolvedValue({ count: 0, reason: 'state' });

		await expect(complete()).rejects.toMatchObject({
			statusCode: 400,
			message: 'Session is already being completed by another request',
		});
		expect(mocks.completeMultipart).not.toHaveBeenCalled();
	});

	it('aborts completion before storage mutation when its DB lease is no longer owned', async () => {
		const { mocks, deps, complete } = createHarness();
		deps.repository.claimCompletion = vi.fn().mockResolvedValue({ count: 1, reason: null });
		deps.repository.renewCompletionClaim = vi.fn().mockResolvedValue({ count: 0 });
		deps.repository.releaseCompletionClaim = vi.fn().mockResolvedValue({ count: 0 });

		await expect(complete()).rejects.toMatchObject({
			name: 'CompletionClaimLostError',
		});
		expect(mocks.findPartsBySessionId).not.toHaveBeenCalled();
		expect(mocks.completeMultipart).not.toHaveBeenCalled();
		expect(deps.repository.releaseCompletionClaim).toHaveBeenCalledOnce();
		expect(mocks.logWarn).toHaveBeenCalledWith(
			{ sessionId: 'session-webgl', completionToken: 'id' },
			'Request completion claim was lost before deferred release',
		);
	});

	it('preserves COMPLETING when multipart outcome cannot be inspected', async () => {
		const { mocks, complete } = createHarness();
		mocks.completeMultipart.mockRejectedValueOnce(new Error('completion response lost'));
		mocks.head.mockRejectedValueOnce(new Error('storage unavailable'));

		await expect(complete()).rejects.toThrow('completion response lost');
		expect(mocks.revertToPending).not.toHaveBeenCalled();
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.deleteOrQueue).not.toHaveBeenCalled();
		expect(mocks.logError).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'session-webgl', storageKey: sourceKey }),
			'Could not determine whether multipart completion created the final object; preserving COMPLETING state',
		);
	});

	it('preserves COMPLETING when HEAD is absent but ListParts is ambiguous', async () => {
		const { mocks, deps, complete } = createHarness();
		mocks.completeMultipart.mockRejectedValueOnce(new Error('completion response lost'));
		mocks.head.mockResolvedValueOnce(null);
		deps.storage.listParts = vi.fn()
			.mockResolvedValueOnce([{ partNumber: 1, etag: 'etag' }])
			.mockRejectedValueOnce(new Error('multipart unavailable'));

		await expect(complete()).rejects.toThrow('completion response lost');
		expect(mocks.revertToPending).not.toHaveBeenCalled();
		expect(mocks.logError).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'session-webgl', storageKey: sourceKey }),
			'Multipart completion and upload state are both ambiguous; preserving COMPLETING state',
		);
	});

	it('returns to PENDING when HEAD is absent and ListParts confirms the upload remains', async () => {
		const { mocks, deps, complete } = createHarness();
		mocks.completeMultipart.mockRejectedValueOnce(new Error('completion response lost'));
		mocks.head.mockResolvedValueOnce(null);
		deps.storage.listParts = vi.fn().mockResolvedValue([{ partNumber: 1, etag: 'etag' }]);

		await expect(complete()).rejects.toThrow('completion response lost');
		expect(mocks.revertToPending).toHaveBeenCalledWith('session-webgl', 'id');
	});

	it('does not abort storage when cancellation loses the state compare-and-set', async () => {
		const { mocks, deps } = createHarness();
		deps.repository.cancelSessionAndClearActive = vi.fn().mockResolvedValue({
			count: 0,
			durableAbort: null,
		});

		await expect(cancelSession(deps, 'session-webgl', { id: 11, role: 'USER' }))
			.rejects.toThrow('Session state changed');
		expect(deps.storage.abortMultipart).not.toHaveBeenCalled();
		expect(mocks.completeMultipart).not.toHaveBeenCalled();
	});

	it('preserves a completed source for restart recovery when deployment fails transiently', async () => {
		const { mocks, complete } = createHarness();
		mocks.deployWebgl.mockRejectedValue(new Error('public upload failed'));

		await expect(complete()).rejects.toThrow('public upload failed');
		expect(mocks.finalizeCompletedWebglSession).not.toHaveBeenCalled();
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.deleteOrQueue).not.toHaveBeenCalled();
		expect(mocks.logError).not.toHaveBeenCalled();
	});

	it('preserves the source after a DB pointer fault and completes from a new recovery service', async () => {
		const harness = createRestartRecoveryHarness();
		const initialProcess = harness.newProcess();

		await expect(initialProcess.service.completeSession(
			'session-webgl',
			{ id: 11, role: 'USER' },
		)).rejects.toThrow('database pointer unavailable');

		expect(harness.durable.events).toEqual([
			'source-complete',
			'public-deploy',
			'db-pointer-finalize',
			'public-rollback',
		]);
		expect(harness.durable.session.status).toBe('COMPLETING');
		expect(harness.durable.sourceExists).toBe(true);
		expect(harness.durable.publicObjects).toEqual(new Set());
		expect(harness.durable.webglEntryKey).toBe('');
		expect(initialProcess.deleteOrQueue).not.toHaveBeenCalled();

		const recoveryProcess = harness.newProcess();
		expect(recoveryProcess.service).not.toBe(initialProcess.service);
		await expect(recoveryProcess.service.sweepStaleCompletingSessions())
			.resolves.toEqual({ swept: 1 });

		expect(harness.durable.session.status).toBe('COMPLETED');
		expect(harness.durable.webglEntryKey).toBe(deployed.entryKey);
		expect(harness.durable.sourceExists).toBe(true);
		expect(recoveryProcess.deleteOrQueue).not.toHaveBeenCalled();
		expect(harness.durable.publicObjects).toEqual(new Set([
			deployed.entryKey,
			`${deployed.sitePrefix}Build/game.wasm`,
		]));
		const deploymentPrefixes = new Set(
			[...harness.durable.publicObjects].map((key) => key.split('site/')[0]),
		);
		expect(deploymentPrefixes).toEqual(new Set([deployed.deploymentPrefix]));
		expect(harness.processes).toHaveLength(2);
	});

	it('atomically marks a deterministically invalid completed source failed, then wakes deletion', async () => {
		const { mocks, complete } = createHarness();
		mocks.readHeader.mockResolvedValue(Buffer.from('not-a-zip'));

		await expect(complete()).rejects.toMatchObject({ statusCode: 400 });
		expect(mocks.markCompletedObjectFailed).toHaveBeenCalledWith({
			sessionId: 'session-webgl',
			storageKey: sourceKey,
			reason: 'webgl-upload-completion-invalid',
			completionClaimToken: 'id',
		});
		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(mocks.deleteOrQueue).not.toHaveBeenCalled();
	});

	it('keeps an invalid completed source recoverable when the atomic failure outbox commit fails', async () => {
		const { mocks, complete } = createHarness();
		mocks.readHeader.mockResolvedValue(Buffer.from('not-a-zip'));
		mocks.markCompletedObjectFailed.mockRejectedValue(new Error('database unavailable'));

		await expect(complete()).rejects.toThrow('database unavailable');
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.revertToPending).not.toHaveBeenCalled();
		expect(mocks.wakeDeletionWorker).not.toHaveBeenCalled();
	});

	it('wakes the reference-aware deletion worker after the pointer swap', async () => {
		const { mocks, complete } = createHarness();
		const oldEntry = 'webgl/7/123e4567-e89b-42d3-b456-426614174111/site/index.html';
		mocks.finalizeCompletedWebglSession.mockResolvedValue({ oldEntryKey: oldEntry });

		await complete();
		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(mocks.deleteOrQueue).not.toHaveBeenCalled();
	});

	it('does not await global deletion work after a WebGL outbox commit', async () => {
		const { mocks, complete } = createHarness();
		mocks.finalizeCompletedWebglSession.mockResolvedValue({
			oldEntryKey: 'webgl/7/123e4567-e89b-42d3-b456-426614174111/site/index.html',
		});

		await expect(complete()).resolves.toMatchObject({ status: 'COMPLETED' });
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.rollbackWebglPublicDeployment).not.toHaveBeenCalled();
		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(mocks.logError).not.toHaveBeenCalled();
	});

	it('wakes deletion after a GAME replacement without synchronously deleting the old object', async () => {
		const { mocks, complete } = createHarness();
		mocks.findSessionById.mockResolvedValueOnce({ ...session(), uploadKind: 'GAME' });
		mocks.finalizeGame.mockResolvedValueOnce({
			oldStorageKey: 'old-game.zip',
			oldPlaybackStorageKey: null,
		});

		await expect(complete()).resolves.toMatchObject({ status: 'COMPLETED' });
		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(mocks.deleteOrQueue).not.toHaveBeenCalled();
	});
});
