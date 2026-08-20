import type { GameUploadSessionSummary } from './ports.js';
import type { DurableGameUploadRepository } from './repository.js';
import { createCompletionClaimGuard } from './completion-claim.js';
import { isTerminalUploadFinalizationError } from './finalize-completed-upload.service.js';
import { commitTerminalCompletedObjectFailure } from './terminal-object-failure.js';
import { recordGameUploadEvent, safeGameUploadLogContext } from './observability.js';
import { GameUploadTargetFencedError } from './ports.js';

export interface ValidationWorkerOptions {
	concurrency: number;
	claimLeaseMs: number;
	heartbeatMs?: number;
}

export interface ValidationWorkerResult {
	claimed: number;
	ready: number;
	rejected: number;
	retried: number;
}

export interface ValidationItemContext {
	claimToken: string;
	signal: AbortSignal;
	assertClaimOwned(): Promise<void>;
}

export interface ValidationWorkerDependencies {
	repository: Pick<
		DurableGameUploadRepository,
		| 'claimVerifyingSessions'
		| 'renewCompletionClaim'
		| 'releaseCompletionClaim'
		| 'markCompletedObjectFailed'
	>;
	ids: { next(): string };
	processor: {
		process(session: GameUploadSessionSummary, context: ValidationItemContext): Promise<void>;
	};
	wakeDeletionWorker(): void;
	logger: {
		info?(context: Record<string, unknown>, message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
	options: ValidationWorkerOptions;
}

function assertWorkerOptions(options: ValidationWorkerOptions): void {
	if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 32) {
		throw new RangeError('Validation worker concurrency must be between 1 and 32');
	}
	if (!Number.isInteger(options.claimLeaseMs) || options.claimLeaseMs < 60_000) {
		throw new RangeError('Validation worker claim lease must be at least 60 seconds');
	}
	if (options.heartbeatMs !== undefined
		&& (!Number.isInteger(options.heartbeatMs) || options.heartbeatMs < 1_000
			|| options.heartbeatMs >= options.claimLeaseMs)) {
		throw new RangeError('Validation worker heartbeat must be shorter than its claim lease');
	}
}

/**
 * Claim no more work than this process can start immediately, then process the
 * entire claimed set concurrently. PostgreSQL SKIP LOCKED and per-row lease
 * tokens remain the cross-process single-consumer boundary.
 */
export function createValidationWorker(deps: ValidationWorkerDependencies) {
	assertWorkerOptions(deps.options);

	async function processOne(
		session: GameUploadSessionSummary,
		claimToken: string,
		signal?: AbortSignal,
	): Promise<'ready' | 'rejected' | 'retried'> {
		let resolved = false;
		const claim = createCompletionClaimGuard({
			sessionId: session.id,
			token: claimToken,
			renew: deps.repository.renewCompletionClaim,
			leaseMs: deps.options.claimLeaseMs,
			...(deps.options.heartbeatMs !== undefined
				? { heartbeatMs: deps.options.heartbeatMs }
				: {}),
			...(signal ? { outerSignal: signal } : {}),
			logHeartbeatFailure: (error) => deps.logger.error(
				safeGameUploadLogContext({ error, sessionId: session.id, action: 'claim_heartbeat', result: 'failed' }),
				'Upload validation claim heartbeat failed',
			),
		});
		const startedAt = Date.now();
		recordGameUploadEvent(deps, 'verification_started', {
			projectId: session.projectId,
			sessionId: session.id,
			generation: session.multipartGeneration ?? 1,
			result: 'started',
		});
		try {
			await claim.assertOwned();
			await deps.processor.process(session, {
				claimToken,
				signal: claim.signal,
				assertClaimOwned: claim.assertOwned,
			});
			resolved = true;
			recordGameUploadEvent(deps, 'upload_session_ready', {
				projectId: session.projectId,
				sessionId: session.id,
				generation: session.multipartGeneration ?? 1,
				durationMs: Date.now() - startedAt,
				result: 'ready',
			});
			return 'ready';
		} catch (error) {
			const storageKey = session.s3Key ?? session.storageKey;
			if (error instanceof GameUploadTargetFencedError && error.terminalStateCommitted) {
				resolved = true;
				deps.wakeDeletionWorker();
				recordGameUploadEvent(deps, 'replacement_fenced', {
					projectId: session.projectId,
					sessionId: session.id,
					generation: session.multipartGeneration ?? 1,
					durationMs: Date.now() - startedAt,
					result: 'stale_target_rejected',
				});
				return 'rejected';
			}
			if (!claim.isLost() && storageKey && isTerminalUploadFinalizationError(error)) {
				await claim.assertOwned();
				await commitTerminalCompletedObjectFailure(deps, {
					sessionId: session.id,
					storageKey,
					reason: session.uploadKind === 'WEBGL'
						? 'webgl-direct-validation-rejected'
						: 'game-direct-validation-rejected',
					completionClaimToken: claimToken,
				});
				resolved = true;
				recordGameUploadEvent(deps, 'upload_session_rejected', {
					projectId: session.projectId,
					sessionId: session.id,
					generation: session.multipartGeneration ?? 1,
					durationMs: Date.now() - startedAt,
					result: 'validation_failed',
				});
				return 'rejected';
			}
			deps.logger.error(
				safeGameUploadLogContext({
					error,
					sessionId: session.id,
					projectId: session.projectId,
					action: 'verification',
					result: 'retry_scheduled',
				}),
				'Upload validation failed transiently; leaving VERIFYING for retry',
			);
			recordGameUploadEvent(deps, 'validation_retry', {
				projectId: session.projectId,
				sessionId: session.id,
				generation: session.multipartGeneration ?? 1,
				durationMs: Date.now() - startedAt,
				result: signal?.aborted ? 'shutdown' : 'retry_scheduled',
			});
			return 'retried';
		} finally {
			claim.stop();
			if (!resolved) {
				try {
					await deps.repository.releaseCompletionClaim(
						session.id,
						claimToken,
						'validation-retry',
					);
				} catch (error) {
					deps.logger.error(
						safeGameUploadLogContext({ error, sessionId: session.id, action: 'release_claim', result: 'failed' }),
						'Failed to release upload validation claim',
					);
				}
			}
		}
	}

	return {
		async runPass(signal?: AbortSignal): Promise<ValidationWorkerResult> {
			if (signal?.aborted) return { claimed: 0, ready: 0, rejected: 0, retried: 0 };
			const claimToken = deps.ids.next();
			const sessions = await deps.repository.claimVerifyingSessions(
				claimToken,
				deps.options.claimLeaseMs,
				deps.options.concurrency,
			);
			const outcomes = await Promise.all(
				sessions.map((session) => processOne(session, claimToken, signal)),
			);
			return {
				claimed: sessions.length,
				ready: outcomes.filter((result) => result === 'ready').length,
				rejected: outcomes.filter((result) => result === 'rejected').length,
				retried: outcomes.filter((result) => result === 'retried').length,
			};
		},
	};
}
