import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
	addNamespaceBlockers,
	auditGameUploadCutover,
	type GameUploadCutoverAuditReport,
} from '../src/modules/admin/game-upload/cutover-audit.js';

function report(overrides: Partial<GameUploadCutoverAuditReport['residue']> = {}) {
	return {
		safeToMigrate: true,
		schemaState: 'LEGACY_PRESENT',
		legacySessions: {
			total: 1, byStatus: { PENDING: 1 }, nonterminal: 1, cleanupCandidates: 1,
			activeSlots: 1, terminalActiveSlots: 0,
		},
		preFenceDirectSessions: {
			total: 0,
			byStatus: { pending: 0, completing: 0, verifying: 0 },
			malformedLocators: 0,
		},
		residue: {
			s3KeyRows: 1,
			s3UploadIdRows: 1,
			storageKeyRows: 0,
			protectedExactTargets: 1,
			publicGenerationPrefixTargets: 0,
			...overrides,
		},
		collisions: { readyAssets: 0, projects: 0, preservedSessions: 0, liveUploadIntents: 0 },
		existingOutbox: {
			multipartAbortTasks: 0,
			matchingMultipartAbortTasks: 0,
			orphanDeletionTasks: 0,
			matchingOrphanDeletionTasks: 0,
		},
		legacyRowsRemoved: { gameUploadParts: 2, gameUploadPartClaims: 1 },
		namespace: {
			publicBucketMatchesCanonical: true,
			protectedBucketMatchesCanonical: true,
		},
		blockers: [],
	} satisfies GameUploadCutoverAuditReport;
}

describe('game-upload cutover audit', () => {
	it('blocks only the custom bucket namespaces needed by concrete cleanup targets', () => {
		const checked = addNamespaceBlockers(report({ publicGenerationPrefixTargets: 1 }), {
			publicBucket: 'custom-public',
			protectedBucket: 'custom-protected',
		});
		expect(checked.namespace).toEqual({
			publicBucketMatchesCanonical: false,
			protectedBucketMatchesCanonical: false,
		});
		expect(checked.blockers).toEqual([
			{ category: 'PROTECTED_BUCKET_NAMESPACE_MISMATCH', count: 1 },
			{ category: 'PUBLIC_BUCKET_NAMESPACE_MISMATCH', count: 1 },
		]);
		expect(checked.safeToMigrate).toBe(false);

		const noTargets = addNamespaceBlockers(report({
			protectedExactTargets: 0,
			publicGenerationPrefixTargets: 0,
		}), {
			publicBucket: 'custom-public',
			protectedBucket: 'custom-protected',
		});
		expect(noTargets.blockers).toEqual([]);
	});

	it('uses a repeatable-read read-only transaction and reports no legacy secrets after cutover', async () => {
		const execute = vi.fn(async () => 0);
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('hasTransport')) {
				return [{
					hasTransport: false,
					hasExpectedTargetFence: true,
					hasParts: false,
					hasPartClaims: false,
				}];
			}
			if (sql.includes('multipart_abort_tasks')) return [{ count: 3n }];
			if (sql.includes('orphan_objects')) return [{ count: 4n }];
			throw new Error('unexpected audit query');
		});
		const transaction = vi.fn(async (
			callback: (tx: unknown) => unknown,
			_options?: unknown,
		) => callback({
			$executeRawUnsafe: execute,
			$queryRawUnsafe: query,
		}));
		const fake = { $transaction: transaction } as unknown as PrismaClient;

		const result = await auditGameUploadCutover(fake, {
			publicBucket: 'pcu-public',
			protectedBucket: 'pcu-protected',
		});

		expect(execute).toHaveBeenCalledWith(
			'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
		);
		expect(transaction.mock.calls[0]?.[1]).toMatchObject({ isolationLevel: 'RepeatableRead' });
		expect(result.schemaState).toBe('DIRECT_ONLY');
		expect(result.existingOutbox).toMatchObject({
			multipartAbortTasks: 3,
			orphanDeletionTasks: 4,
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('raw-upload-id-fixture');
		expect(serialized).not.toContain('raw/storage/key-fixture');
		expect(serialized).not.toContain('signature-fixture');
	});
});
