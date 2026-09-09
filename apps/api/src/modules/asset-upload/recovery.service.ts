import { validateStoredMultipartParts } from '../admin/game-upload/direct-multipart.js';
import { createClaimHeartbeatGuard } from '../upload-lifecycle/claim-heartbeat.js';
import type {
	AssetUploadRecoveryStorage,
	AssetUploadRepository,
	AssetUploadSessionRecord,
} from './ports.js';

const RECOVERY_BATCH_SIZE = 50;
const COMPLETION_RECOVERY_CONCURRENCY = 4;
const COMPLETION_LEASE_MS = 120_000;
const RECOVERY_STORAGE_TIMEOUT_MS = 15_000;
const UNKNOWN_MULTIPART_MINIMUM_AGE_MS = 15 * 60 * 1_000;

function recoveryCompletionResult(
	session: AssetUploadSessionRecord,
	head: { size: number; etag?: string },
) {
	const etag = head.etag?.trim();
	return {
		status: 'VERIFYING' as const,
		sessionId: session.id,
		generation: session.generation,
		sizeBytes: head.size,
		...(etag ? { etag } : {}),
	};
}

function closedDirectMultipartKey(key: string, prefix: string): boolean {
	if (!key.startsWith(prefix)) return false;
	const relative = key.slice(prefix.length);
	// Session identifiers are production UUIDs and this namespace is allocated
	// only by createSession.  Do not turn a broad protected-bucket inventory into
	// a destructive scanner for arbitrary keys.
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[1-9][0-9]*\/source\.(?:zip|bin)$/i.test(relative);
}

function isNoSuchUpload(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const candidate = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } };
	return candidate.name === 'NoSuchUpload' || candidate.Code === 'NoSuchUpload'
		|| candidate.$metadata?.httpStatusCode === 404;
}

function withTimeoutSignal<T>(
	outer: AbortSignal | undefined,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(new Error('Direct multipart recovery storage timeout')), RECOVERY_STORAGE_TIMEOUT_MS);
	timer.unref();
	const signal = outer ? AbortSignal.any([outer, timeout.signal]) : timeout.signal;
	return work(signal).finally(() => clearTimeout(timer));
}

async function mapBounded<T, R>(
	items: readonly T[],
	concurrency: number,
	map: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await map(items[index]!);
		}
	}));
	return results;
}

export type AssetUploadRecoveryResult = {
	expired: number;
	abortsQueued: number;
	completionClaimed: number;
	completionVerified: number;
	completionReleased: number;
	completionRejected: number;
	completionRetried: number;
	inventoryQueued: number;
};

/**
 * Maintenance-only recovery for direct multipart control state.  It has S3
 * metadata/complete capabilities but never receives GetObject or bytes.
 */
export function createAssetUploadRecoveryService(deps: {
	repository: AssetUploadRepository;
	storage: AssetUploadRecoveryStorage;
	clock: { now(): Date };
	ids: { next(): string };
	logger: { error(context: Record<string, unknown>, message: string): void };
	wakeMaintenance(): void;
	bucket: string;
	stagingPrefix?: string;
	unknownMultipartMinimumAgeMs?: number;
}) {
	const stagingPrefix = deps.stagingPrefix ?? 'protected/uploads/';
	const unknownMultipartMinimumAgeMs = deps.unknownMultipartMinimumAgeMs
		?? UNKNOWN_MULTIPART_MINIMUM_AGE_MS;
	if (!stagingPrefix.startsWith('protected/uploads/') || !stagingPrefix.endsWith('/')) {
		throw new Error('Direct multipart recovery staging prefix must remain the closed protected/uploads namespace');
	}
	if (!Number.isSafeInteger(unknownMultipartMinimumAgeMs) || unknownMultipartMinimumAgeMs < 1_000) {
		throw new Error('Direct multipart recovery unknown-upload age fence must be at least one second');
	}

	async function reconcileCompletedObject(
		session: AssetUploadSessionRecord,
		token: string,
		head: { size: number; etag?: string },
		claim: ReturnType<typeof createClaimHeartbeatGuard>,
	): Promise<'verified' | 'rejected' | 'retried'> {
		if (head.size !== Number(session.totalBytes)) {
			await claim.assertOwned();
			const rejected = await deps.repository.rejectRecoveredCompletion({
				sessionId: session.id,
				generation: session.generation,
				token,
				reason: `Recovered completed object size mismatch: expected ${session.totalBytes}, got ${head.size}`,
			});
			if (rejected) deps.wakeMaintenance();
			return rejected ? 'rejected' : 'retried';
		}
		await claim.assertOwned();
		const marked = await deps.repository.markVerifying({
			sessionId: session.id,
			token,
			generation: session.generation,
			completedSize: head.size,
			result: recoveryCompletionResult(session, head),
		});
		return marked ? 'verified' : 'retried';
	}

	async function recoverCompletion(
		session: AssetUploadSessionRecord,
		token: string,
		outerSignal?: AbortSignal,
	): Promise<'verified' | 'released' | 'rejected' | 'retried'> {
		if (!session.uploadId) return 'retried';
		const claim = createClaimHeartbeatGuard({
			heartbeatMs: 30_000,
			lostMessage: 'Direct multipart recovery completion lease was lost',
			outerSignal,
			renew: () => deps.repository.renewCompletion(session.id, token, COMPLETION_LEASE_MS)
				.then((owned) => ({ count: owned ? 1 : 0 })),
			logHeartbeatFailure: (error) => deps.logger.error(
				{ error, sessionId: session.id },
				'Direct multipart recovery completion heartbeat failed',
			),
		});
		try {
			await claim.assertOwned();
			const completed = await withTimeoutSignal(claim.signal, (signal) => (
				deps.storage.head(session.bucket, session.objectKey, { signal })
			));
			if (completed) return reconcileCompletedObject(session, token, completed, claim);

			let listedParts;
			try {
				listedParts = await withTimeoutSignal(claim.signal, (signal) => (
					deps.storage.listParts(session.bucket, session.objectKey, session.uploadId!, { signal })
				));
			} catch (error) {
				if (!claim.isLost() && isNoSuchUpload(error)) {
					// HEAD already proved no completed object exists.  A missing multipart
					// upload cannot be resumed with this immutable session generation, so
					// terminalize it instead of looping forever in COMPLETING.
					await claim.assertOwned();
					const rejected = await deps.repository.rejectRecoveredCompletion({
						sessionId: session.id,
						generation: session.generation,
						token,
						reason: 'Garage no longer has the incomplete multipart upload',
					});
					if (rejected) deps.wakeMaintenance();
					return rejected ? 'rejected' : 'retried';
				}
				// Storage availability is not evidence that the browser's multipart
				// manifest is invalid.  Retain COMPLETING so a later claimant can
				// reconcile an ambiguous CompleteMultipart safely.
				throw error;
			}
			let parts;
			try {
				parts = validateStoredMultipartParts({
					parts: listedParts,
					totalBytes: session.totalBytes,
					partSizeBytes: session.partSizeBytes,
					totalParts: session.totalParts,
				});
			} catch (error) {
				if (claim.isLost()) return 'retried';
				const released = await deps.repository.releaseRecoveredCompletion({
					sessionId: session.id,
					generation: session.generation,
					token,
					reason: `Recovered completion needs browser resume: ${String(error instanceof Error ? error.message : error)}`,
				});
				if (released === 'expired') deps.wakeMaintenance();
				return released === 'lost' ? 'retried' : 'released';
			}

			await claim.assertOwned();
			try {
				await withTimeoutSignal(claim.signal, (signal) => (
					deps.storage.completeMultipart(session.bucket, session.objectKey, session.uploadId!, parts, { signal })
				));
			} catch (error) {
				if (claim.isLost()) return 'retried';
				// CompleteMultipart is ambiguous.  A fresh HEAD is the only success
				// proof; an unavailable Garage remains safely retryable in COMPLETING.
				const afterErrorHead = await withTimeoutSignal(claim.signal, (signal) => (
					deps.storage.head(session.bucket, session.objectKey, { signal })
				)).catch(() => undefined);
				if (afterErrorHead) return reconcileCompletedObject(session, token, afterErrorHead, claim);
				if (afterErrorHead === null && isNoSuchUpload(error)) {
					// ListParts was valid before CompleteMultipart, but Garage can remove
					// that upload in between. HEAD=null plus NoSuchUpload proves neither
					// a completed object nor a resumable multipart remains.
					await claim.assertOwned();
					const rejected = await deps.repository.rejectRecoveredCompletion({
						sessionId: session.id,
						generation: session.generation,
						token,
						reason: 'Garage no longer has the incomplete multipart upload',
					});
					if (rejected) deps.wakeMaintenance();
					return rejected ? 'rejected' : 'retried';
				}
				throw error;
			}
			await claim.assertOwned();
			const afterComplete = await withTimeoutSignal(claim.signal, (signal) => (
				deps.storage.head(session.bucket, session.objectKey, { signal })
			));
			if (!afterComplete) throw new Error('Garage did not expose a completed direct upload after CompleteMultipart');
			return reconcileCompletedObject(session, token, afterComplete, claim);
		} catch (error) {
			if (!claim.isLost()) {
				deps.logger.error({ error, sessionId: session.id }, 'Direct multipart completion recovery will retry');
			}
			return 'retried';
		} finally {
			claim.stop();
		}
	}

	return {
		async recover(signal?: AbortSignal): Promise<AssetUploadRecoveryResult> {
			if (signal?.aborted) {
				return {
					expired: 0, abortsQueued: 0, completionClaimed: 0,
					completionVerified: 0, completionReleased: 0, completionRejected: 0,
					completionRetried: 0, inventoryQueued: 0,
				};
			}
			const expired = await deps.repository.expireTimedOutSessions(RECOVERY_BATCH_SIZE);
			const token = deps.ids.next();
			const completions = await deps.repository.claimExpiredCompletions({
				limit: RECOVERY_BATCH_SIZE,
				token,
				leaseMs: COMPLETION_LEASE_MS,
			});
			const results = await mapBounded(
				completions,
				COMPLETION_RECOVERY_CONCURRENCY,
				(session) => recoverCompletion(session, token, signal),
			);
			let inventoryQueued = 0;
			try {
				const uploads = await withTimeoutSignal(signal, (storageSignal) => (
					deps.storage.listMultipartUploads(
						deps.bucket,
						stagingPrefix,
						{ signal: storageSignal },
					)
				));
				const oldestAllowed = deps.clock.now().getTime() - unknownMultipartMinimumAgeMs;
				const eligible = uploads.filter((upload) => (
					closedDirectMultipartKey(upload.key, stagingPrefix)
					&& upload.initiated !== undefined
					&& upload.initiated.getTime() <= oldestAllowed
				));
				if (eligible.length > 0) {
					inventoryQueued = await deps.repository.queueUnknownMultipartAborts({
						bucket: deps.bucket,
						uploads: eligible.map((upload) => ({ key: upload.key, uploadId: upload.uploadId })),
					});
				}
			} catch (error) {
				deps.logger.error({ error }, 'Direct multipart inventory recovery will retry');
			}
			if (expired.aborts > 0 || inventoryQueued > 0) deps.wakeMaintenance();
			return {
				expired: expired.expired,
				abortsQueued: expired.aborts,
				completionClaimed: completions.length,
				completionVerified: results.filter((result) => result === 'verified').length,
				completionReleased: results.filter((result) => result === 'released').length,
				completionRejected: results.filter((result) => result === 'rejected').length,
				completionRetried: results.filter((result) => result === 'retried').length,
				inventoryQueued,
			};
		},
	};
}
