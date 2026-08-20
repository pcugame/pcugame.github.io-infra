import type { GameUploadStatus, UserRole } from '@pcu/contracts';
import { badRequest } from '../../../shared/errors.js';
import { loadSession } from './session-loader.js';
import { assertUploadStateTransition } from './state-machine.js';
import type { GameUploadServiceDependencies } from './ports.js';
import { createCompletionClaimGuard } from './completion-claim.js';
import { validateStoredParts } from './direct-multipart.js';
import { recordGameUploadEvent, safeGameUploadLogContext } from './observability.js';

function signalRequest(signal?: AbortSignal): [] | [{ signal: AbortSignal }] {
	return signal ? [{ signal }] : [];
}

function resultCount(result: unknown): number | undefined {
	return typeof result === 'object'
		&& result !== null
		&& 'count' in result
		&& typeof result.count === 'number'
		? result.count
		: undefined;
}

/** Get current session status and progress */
export async function getSessionStatus(
	deps: GameUploadServiceDependencies,
	sessionId: string,
	user: { id: number; role: UserRole },
): Promise<GameUploadStatus> {
	const session = await loadSession(deps, sessionId, user.id, user.role);
	const parts = session.status === 'PENDING'
		&& session.s3Key
		&& session.s3UploadId
		? validateStoredParts({
			parts: await deps.storage.listParts(session.s3Key, session.s3UploadId),
			totalBytes: session.totalBytes,
			chunkSizeBytes: session.chunkSizeBytes,
			totalChunks: session.totalChunks,
			requireComplete: false,
		})
		: [];
	const uploadedCount = ['COMPLETING', 'VERIFYING', 'COMPLETED'].includes(session.status)
		? session.totalChunks
		: parts.length;
	return {
		sessionId: session.id,
		projectId: session.projectId,
		uploadKind: session.uploadKind,
		generation: session.multipartGeneration ?? 1,
		originalName: session.originalName,
		totalBytes: Number(session.totalBytes),
		chunkSizeBytes: session.chunkSizeBytes,
		totalChunks: session.totalChunks,
		uploadedCount,
		status: session.status,
		expiresAt: session.expiresAt.toISOString(),
		sourceIdentityAlgorithm: session.sourceIdentityAlgorithm === 'SHA256_BLOCK_MANIFEST_V1'
			? session.sourceIdentityAlgorithm : null,
		sourceIdentity: session.sourceIdentity ?? null,
		sourceIdentityBlockSizeBytes: session.sourceIdentityBlockSizeBytes === 1048576
			? session.sourceIdentityBlockSizeBytes : null,
		parts,
	};
}

/** Cancel an upload session and abort the S3 multipart upload */
export async function cancelSession(
	deps: GameUploadServiceDependencies,
	sessionId: string,
	user: { id: number; role: UserRole },
) {
	const session = await loadSession(deps, sessionId, user.id, user.role);

	if (session.status === 'COMPLETED') {
		throw badRequest('Cannot cancel a completed session');
	}
	assertUploadStateTransition(session.status, 'CANCELLED');

	const cancelled = await deps.repository.cancelSessionAndClearActive(session.id);
	if (cancelled.count === 0) {
		throw badRequest('Session state changed before it could be cancelled');
	}
	if (cancelled.count === 1 && cancelled.durableAbort) {
		deps.wakeMaintenance();
		await deps.storage.abortMultipart(
			cancelled.durableAbort.key,
			cancelled.durableAbort.uploadId,
		).catch((err) => {
			deps.logger.error(safeGameUploadLogContext({
				err,
				sessionId: cancelled.durableAbort?.sessionId,
				action: 'prompt_abort',
				result: 'failed',
			}), 'Failed to abort multipart upload during cancelSession');
		});
	}
	recordGameUploadEvent(deps, 'upload_session_cancelled', {
		actorId: user.id,
		projectId: session.projectId,
		sessionId: session.id,
		generation: session.multipartGeneration ?? 1,
		result: 'cancelled',
	});
}

/**
 * Boot-time sweep: sessions stuck in COMPLETING cannot be blindly made writable again
 * after S3 may have completed. If the final object exists, leave the row for explicit
 * completion repair paths; otherwise abort the multipart upload and mark terminal FAILED.
 */
export async function sweepStaleCompletingSessions(
	deps: GameUploadServiceDependencies,
	signal?: AbortSignal,
): Promise<{ swept: number }> {
	if (signal?.aborted) return { swept: 0 };
	const now = deps.clock.now();
	const cutoff = new Date(now.getTime() - 5 * 60 * 1000);
	let swept = 0;
	// Recovery capacity is one: never lease a row until this process can start
	// its heartbeat and storage reconciliation immediately. Repeat the bounded
	// claim after each item instead of preclaiming a batch that waits in memory.
	while (swept < 50 && !signal?.aborted) {
		const completionClaimToken = deps.ids.next();
		const [s] = await deps.repository.claimStaleCompletingSessions(
			cutoff,
			completionClaimToken,
			2 * 60 * 1000,
			1,
		);
		if (!s) break;
		swept++;
		let completionStateResolved = false;
		const completionClaim = createCompletionClaimGuard({
			sessionId: s.id,
			token: completionClaimToken,
			renew: deps.repository.renewCompletionClaim,
			...(signal ? { outerSignal: signal } : {}),
			logHeartbeatFailure: (error) => deps.logger.error(
				safeGameUploadLogContext({ error, sessionId: s.id, action: 'claim_heartbeat', result: 'failed' }),
				'Completing-session recovery claim heartbeat failed',
			),
		});
		const operationSignal = completionClaim.signal;
		try {
			await completionClaim.assertOwned();
			if (!s.s3Key) {
				const failed = await deps.repository.markFailed(s.id, undefined, completionClaimToken);
				if (resultCount(failed) !== 1) {
					throw completionClaim.loseClaim();
				}
				completionStateResolved = true;
				continue;
			}

			let finalObject: Awaited<ReturnType<GameUploadServiceDependencies['storage']['head']>>;
			try {
				finalObject = await deps.storage.head(s.s3Key, ...signalRequest(operationSignal));
				await completionClaim.assertOwned();
			} catch (err) {
				deps.logger.error(
					safeGameUploadLogContext({ err, sessionId: s.id, action: 'head_completed_object', result: 'failed' }),
					'Boot sweep: failed to inspect stale COMPLETING object; leaving it recoverable',
				);
				continue;
			}
			if (finalObject) {
				await completionClaim.assertOwned();
				const verifying = await deps.repository.markVerifying({
					sessionId: s.id,
					generation: s.multipartGeneration ?? 1,
					storageKey: s.s3Key,
					verifiedSizeBytes: finalObject.size,
					completionClaimToken,
				});
				if (verifying.count !== 1) throw completionClaim.loseClaim();
				completionStateResolved = true;
				recordGameUploadEvent(deps, 'upload_session_completed_storage', {
					projectId: s.projectId,
					sessionId: s.id,
					generation: s.multipartGeneration ?? 1,
					declaredBytes: Number(s.totalBytes),
					verifiedBytes: finalObject.size,
					result: 'recovered',
				});
				recordGameUploadEvent(deps, 'upload_session_verifying', {
					projectId: s.projectId,
					sessionId: s.id,
					generation: s.multipartGeneration ?? 1,
					result: 'queued',
				});
				continue;
			}

			if (s.s3UploadId) {
				try {
				await deps.storage.listParts(s.s3Key, s.s3UploadId, ...signalRequest(operationSignal));
				await completionClaim.assertOwned();
				const reverted = await deps.repository.revertToPending(
					s.id,
					completionClaimToken,
				);
				if (resultCount(reverted) !== 1) {
					throw completionClaim.loseClaim();
				}
				completionStateResolved = true;
				continue;
				} catch (error) {
					deps.logger.error(
						safeGameUploadLogContext({ error, sessionId: s.id, action: 'list_parts_recovery', result: 'failed' }),
						'Recovery could not disambiguate multipart state; leaving COMPLETING',
					);
					continue;
				}
			}
			await completionClaim.assertOwned();
			const failed = await deps.repository.markFailed(s.id, undefined, completionClaimToken);
			if (resultCount(failed) !== 1) {
				throw completionClaim.loseClaim();
			}
			completionStateResolved = true;
		} catch (error) {
			deps.logger.error(
				safeGameUploadLogContext({ error, sessionId: s.id, action: 'completion_recovery', result: 'failed' }),
				'Completing-session recovery failed; continuing with the batch',
			);
		} finally {
			completionClaim.stop();
			if (!completionStateResolved) {
				try {
					const released = await deps.repository.releaseCompletionClaim(
						s.id,
						completionClaimToken,
						'recovery-deferred',
					);
					if (released.count !== 1) {
						deps.logger.warn(
							safeGameUploadLogContext({ sessionId: s.id, action: 'release_claim', result: 'claim_lost' }),
							'Completing-session recovery claim was lost before deferred release',
						);
					}
				} catch (error) {
					deps.logger.error(
						safeGameUploadLogContext({ error, sessionId: s.id, action: 'release_claim', result: 'failed' }),
						'Failed to release completing-session recovery claim',
					);
				}
			}
		}
	}
	deps.logger.warn({ count: swept }, 'Boot sweep: inspected stale COMPLETING sessions');
	return { swept };
}

/** Expire uploads even when no request ever loads their session. */
export async function sweepExpiredPendingSessions(
	deps: GameUploadServiceDependencies,
	signal?: AbortSignal,
): Promise<{ swept: number }> {
	if (signal?.aborted) return { swept: 0 };
	const expired = await deps.repository.findExpiredPendingSessions(deps.clock.now(), 50);
	let swept = 0;
	for (const session of expired) {
		if (signal?.aborted) break;
		try {
			const cancelled = await deps.repository.expireSessionAndClearActive(session.id);
			if (cancelled.count !== 1) continue;
			swept++;
			recordGameUploadEvent(deps, 'upload_session_expired', {
				projectId: session.projectId,
				sessionId: session.id,
				generation: session.multipartGeneration ?? 1,
				result: 'expired',
			});
			if (cancelled.durableAbort) {
				deps.wakeMaintenance();
				await deps.storage.abortMultipart(
					cancelled.durableAbort.key,
					cancelled.durableAbort.uploadId,
					...signalRequest(signal),
				).catch((error) => {
					deps.logger.error(
						safeGameUploadLogContext({
							error,
							sessionId: cancelled.durableAbort?.sessionId,
							action: 'prompt_abort',
							result: 'failed',
						}),
						'Failed best-effort abort for expired upload; durable task retained',
					);
				});
			}
		} catch (error) {
			deps.logger.error(
				safeGameUploadLogContext({ error, sessionId: session.id, action: 'expire_session', result: 'failed' }),
				'Expired-upload sweep item failed',
			);
		}
	}
	return { swept };
}

/** Discover app-created multipart uploads lost before their session row committed. */
export async function sweepUntrackedMultipartUploads(
	deps: GameUploadServiceDependencies,
	signal?: AbortSignal,
): Promise<{ queued: number }> {
	if (signal?.aborted) return { queued: 0 };
	const [uploads, knownRows] = await Promise.all([
		deps.storage.listMultipartUploads('', ...signalRequest(signal)),
		deps.repository.findKnownMultipartUploads(),
	]);
	const known = new Set(knownRows.map((row) => `${row.s3Key}\0${row.s3UploadId}`));
	const fence = deps.clock.now().getTime() - 60 * 60 * 1000;
	const appOwnedGameKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.zip$/i;
	const appOwnedWebglKey = /^webgl\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/source\.zip$/i;
	let queued = 0;
	for (const upload of uploads) {
		if (signal?.aborted) break;
		if (!appOwnedGameKey.test(upload.key) && !appOwnedWebglKey.test(upload.key)) continue;
		if (!upload.initiated || upload.initiated.getTime() > fence) continue;
		if (known.has(`${upload.key}\0${upload.uploadId}`)) continue;
		await deps.repository.queueAbortTask({
			key: upload.key,
			uploadId: upload.uploadId,
			reason: 'untracked-multipart-age-fence',
		});
		queued++;
	}
	if (queued > 0) deps.wakeMaintenance();
	recordGameUploadEvent(deps, 'untracked_multipart', {
		untrackedCount: queued,
		result: queued > 0 ? 'cleanup_queued' : 'none_found',
	});
	return { queued };
}

/** List active upload sessions for a project */
export async function listSessions(
	deps: GameUploadServiceDependencies,
	projectId: number,
	user: { id: number; role: UserRole },
): Promise<GameUploadStatus[]> {
	await deps.authorizeProjectWrite(user, projectId);
	const isPrivileged = user.role === 'ADMIN' || user.role === 'OPERATOR';
	const sessions = await deps.repository.findActiveSessionsForListing(
		projectId,
		isPrivileged ? {} : { userId: user.id },
	);

	return Promise.all(sessions.map(async (s) => {
		const parts = s.status === 'PENDING'
			&& s.s3Key
			&& s.s3UploadId
			? validateStoredParts({
				parts: await deps.storage.listParts(s.s3Key, s.s3UploadId),
				totalBytes: s.totalBytes,
				chunkSizeBytes: s.chunkSizeBytes,
				totalChunks: s.totalChunks,
				requireComplete: false,
			})
			: [];
		const uploadedCount = ['COMPLETING', 'VERIFYING', 'COMPLETED'].includes(s.status)
			? s.totalChunks
			: parts.length;
		return {
			sessionId: s.id,
			projectId: s.projectId,
			uploadKind: s.uploadKind,
			generation: s.multipartGeneration ?? 1,
			originalName: s.originalName,
			totalBytes: Number(s.totalBytes),
			chunkSizeBytes: s.chunkSizeBytes,
			totalChunks: s.totalChunks,
			uploadedCount,
			status: s.status,
			expiresAt: s.expiresAt.toISOString(),
			sourceIdentityAlgorithm: s.sourceIdentityAlgorithm === 'SHA256_BLOCK_MANIFEST_V1'
				? s.sourceIdentityAlgorithm : null,
			sourceIdentity: s.sourceIdentity ?? null,
			sourceIdentityBlockSizeBytes: s.sourceIdentityBlockSizeBytes === 1048576
				? s.sourceIdentityBlockSizeBytes : null,
			parts,
		};
	}));
}
