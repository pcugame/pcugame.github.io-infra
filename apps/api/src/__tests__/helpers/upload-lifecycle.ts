import { vi } from 'vitest';

import { createUploadLifecycleMetrics } from '../../lib/upload-lifecycle-metrics.js';
import type { ResourceLease } from '../../backend-context.js';
import type { DurableGameUploadRepository } from '../../modules/admin/game-upload/repository.js';
import type { UploadLifecycleRuntime } from '../../modules/upload-lifecycle/ports.js';

export function createTestUploadLifecycleRuntime(
	overrides: Partial<UploadLifecycleRuntime> = {},
): UploadLifecycleRuntime {
	const runtime: UploadLifecycleRuntime = {
		idempotency: {
			claim: vi.fn(async () => ({
				kind: 'acquired' as const,
				operationId: 'test-operation',
				ownerToken: 'test-owner',
			})),
			renew: vi.fn(async () => undefined),
			markFailed: vi.fn(async () => undefined),
			purgeExpired: vi.fn(async () => ({ count: 0 })),
		},
		uploadIntents: {
			prepare: vi.fn(async () => 'test-intent'),
			markUploaded: vi.fn(async () => undefined),
			isUncommitted: vi.fn(async () => true),
			recordAmbiguousError: vi.fn(async () => undefined),
			sweep: vi.fn(async () => ({ tried: 0, referenced: 0, queued: 0, missing: 0 })),
		},
		orphanDeletions: {
			deleteOrQueue: vi.fn(async () => undefined),
			deletePrefixOrQueue: vi.fn(async () => 0),
		},
		multipartAborts: {
			queue: vi.fn(async () => undefined),
			run: vi.fn(async () => ({ tried: 0, resolved: 0, failed: 0 })),
		},
		gameUploads: createDurableGameUploadRepository(),
		metrics: createUploadLifecycleMetrics(),
		wakeDeletionWorker: vi.fn(),
		wakeMaintenance: vi.fn(),
		recover: vi.fn(async () => undefined),
		start: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	};
	return { ...runtime, ...overrides };
}

export function ownedTestUploadLifecycleResource(
	runtime = createTestUploadLifecycleRuntime(),
): ResourceLease<UploadLifecycleRuntime> {
	return {
		value: runtime,
		ownership: 'owned',
		start: runtime.start,
		close: runtime.close,
	};
}

export function createDurableGameUploadRepository(
	overrides: Partial<DurableGameUploadRepository> = {},
): DurableGameUploadRepository {
	const repository: DurableGameUploadRepository = {
		findSessionById: vi.fn(async () => null),
		isSessionActive: vi.fn(async () => true),
		assertCanCreateSession: vi.fn(async () => undefined),
		reservePartCapabilities: vi.fn(async () => {
			throw new Error('No test upload session configured for capability reservation');
		}),
		createSessionReplacingActive: vi.fn(async (data) => ({
			session: { id: data.id },
			durableAborts: [],
		})),
		cancelSessionAndClearActive: vi.fn(async () => ({ count: 1 as const, durableAbort: null })),
		expireSessionAndClearActive: vi.fn(async () => ({ count: 1 as const, durableAbort: null })),
		queueAbortTask: vi.fn(async () => undefined),
		claimCompletion: vi.fn(async () => ({ count: 1, reason: null })),
		markVerifying: vi.fn(async () => ({ count: 1 })),
		claimVerifyingSessions: vi.fn(async () => []),
		renewCompletionClaim: vi.fn(async () => ({ count: 1 })),
		releaseCompletionClaim: vi.fn(async () => ({ count: 1 })),
		revertToPending: vi.fn(async () => ({ count: 1 })),
		markFailed: vi.fn(async () => ({ count: 1 })),
		markCompletedObjectFailed: vi.fn(async () => ({ count: 1 })),
		reserveWebglDeployment: vi.fn(async ({ candidateDeploymentId }) => candidateDeploymentId),
		claimStaleCompletingSessions: vi.fn(async () => []),
		findExpiredPendingSessions: vi.fn(async () => []),
		findKnownMultipartUploads: vi.fn(async () => []),
		findActiveSessionsForListing: vi.fn(async () => []),
		findExhibitionById: vi.fn(async () => null),
		finalizeCompletedSession: vi.fn(async () => ({
			assetId: 1,
			oldStorageKey: null,
			oldPlaybackStorageKey: null,
		})),
		finalizeCompletedWebglSession: vi.fn(async () => ({ oldEntryKey: '' })),
	};
	return { ...repository, ...overrides };
}
