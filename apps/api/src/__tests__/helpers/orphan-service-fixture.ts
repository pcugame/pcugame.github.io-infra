import { vi } from 'vitest';

import type { ObjectReferenceInventory } from '../../modules/orphan/reference-resolver.js';

interface ClaimedOrphan {
	id: number;
	bucket: string;
	storageKey: string;
	targetKind: 'EXACT' | 'PREFIX';
	attemptCount: number;
}

export function createOrphanServiceDependencies() {
	const now = new Date('2026-07-21T05:00:00.000Z');
	const repository = {
		upsertOrphan: vi.fn(async () => undefined),
		claimPendingOrphans: vi.fn(async (): Promise<ClaimedOrphan[]> => []),
		markClaimResolved: vi.fn(async () => ({ count: 1 })),
		renewActiveClaim: vi.fn(async (
			_id: number,
			_claimToken: string,
			_claimLeaseMs: number,
			_request?: { signal?: AbortSignal },
		) => ({ count: 1 })),
		markClaimCancelled: vi.fn(async () => ({ count: 1 })),
		markClaimFailed: vi.fn(async () => ({ count: 1 })),
	};

	return {
		now,
		deps: {
			clock: { now: () => now },
			storage: {
				delete: vi.fn(async (
					_bucket: string,
					_key: string,
					_request?: { signal?: AbortSignal; requestTimeoutMs?: number },
				): Promise<void> => undefined),
				listKeys: vi.fn(async (
					_bucket: string,
					_prefix: string,
					_request?: { signal?: AbortSignal; requestTimeoutMs?: number },
				): Promise<string[]> => []),
				listKeyPage: vi.fn(async (
					_bucket: string,
					_prefix: string,
					_page: { startAfter?: string; maxKeys: number },
					_request?: { signal?: AbortSignal; requestTimeoutMs?: number },
				): Promise<{ keys: string[]; isTruncated: boolean }> => ({
					keys: [], isTruncated: false,
				})),
				deleteKeys: vi.fn(async (
					_bucket: string,
					keys: readonly string[],
					_request?: { signal?: AbortSignal; requestTimeoutMs?: number },
				) => ({ deleted: [...keys], failures: [] })),
			},
			repository,
			references: {
				collect: vi.fn(async (): Promise<ObjectReferenceInventory> => ({
					references: [],
					unsafeBuckets: new Set<string>(),
				})),
			},
			ids: { next: () => 'claim-token' },
			logger: { info: vi.fn(), error: vi.fn() },
		},
	};
}

export function orphan(
	id: number,
	storageKey: string,
	overrides: Partial<{
		bucket: string;
		targetKind: 'EXACT' | 'PREFIX';
		attemptCount: number;
	}> = {},
): ClaimedOrphan {
	return {
		id,
		bucket: overrides.bucket ?? 'public',
		storageKey,
		targetKind: overrides.targetKind ?? 'EXACT',
		attemptCount: overrides.attemptCount ?? 0,
	};
}
