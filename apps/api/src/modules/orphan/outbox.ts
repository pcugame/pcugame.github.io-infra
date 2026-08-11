import type { PrismaClient } from '../../generated/prisma/client.js';

export interface DurableDeletionTarget {
	bucket: string;
	storageKey: string;
	reason: string;
	targetKind?: 'EXACT' | 'PREFIX';
}

type OrphanOutboxClient = Pick<PrismaClient, 'orphanObject'>;

export const OUTBOX_REQUEUE_CANCEL_REASON = 'business-outbox-requeue-requested';

/**
 * Store cleanup intent in the caller's transaction. A trailing-slash key is a
 * prefix target and is re-enumerated by the orphan reaper on every attempt.
 */
export async function queueDurableDeletions(
	client: OrphanOutboxClient,
	targets: readonly DurableDeletionTarget[],
): Promise<void> {
	const now = new Date();
	const unique = new Map<string, DurableDeletionTarget>();
	for (const target of targets) {
		if (!target.storageKey) continue;
		unique.set(`${target.bucket}\0${target.storageKey}`, target);
	}
	for (const target of unique.values()) {
		const targetKind = target.targetKind
			?? (target.storageKey.endsWith('/') ? 'PREFIX' : 'EXACT');
		await client.orphanObject.upsert({
			where: {
				orphan_bucket_storage_key: {
					bucket: target.bucket,
					storageKey: target.storageKey,
				},
			},
			create: {
				...target,
				targetKind,
				nextAttemptAt: now,
			},
			update: { reason: target.reason },
		});
		// This helper is called only inside the business transaction that removes
		// the corresponding live reference. Do not invalidate a current token (a
		// reference writer must remain blocked while that worker may delete), but
		// leave a durable signal so a stale "live reference" observation requeues
		// instead of cancelling this newer business outbox.
		await client.orphanObject.updateMany({
			where: {
				bucket: target.bucket,
				storageKey: target.storageKey,
				state: 'DELETE_CLAIMED',
				claimUntil: { gt: now },
			},
			data: {
				cancelReason: OUTBOX_REQUEUE_CANCEL_REASON,
				nextAttemptAt: now,
			},
		});
		// Reconciliation uses createOrphanRepository.upsertOrphan instead and keeps
		// active claims entirely unchanged.
		await client.orphanObject.updateMany({
			where: {
				bucket: target.bucket,
				storageKey: target.storageKey,
				OR: [
					{ state: { not: 'DELETE_CLAIMED' } },
					{ claimUntil: null },
					{ claimUntil: { lte: now } },
				],
			},
			data: {
				targetKind,
				state: 'PENDING',
				claimToken: null,
				claimUntil: null,
				cancelReason: null,
				resolvedAt: null,
				attemptCount: 0,
				lastTriedAt: null,
				lastError: null,
				nextAttemptAt: now,
			},
		});
	}
}
