import { vi } from 'vitest';

import { createUploadLifecycleMetrics } from '../../lib/upload-lifecycle-metrics.js';
import type { ResourceLease } from '../../backend-context.js';
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
