import type { GameUploadStatus } from '@pcu/contracts';
import { badRequest } from '../../../shared/errors.js';
import { loadSession } from './session-loader.js';
import { assertUploadStateTransition } from './state-machine.js';
import { isTerminalUploadFinalizationError } from './finalize-completed-upload.service.js';
import { commitTerminalCompletedObjectFailure } from './terminal-object-failure.js';
import type { GameUploadServiceDependencies } from './ports.js';
import { createCompletionClaimGuard } from './completion-claim.js';
import {
	aggregateBusinessAndCleanupError,
	cleanupUntrackedMultipart,
	MultipartBusinessCleanupError,
	UntrackedMultipartCleanupError,
} from './multipart-cleanup.js';

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
	user: { id: number; role: string },
): Promise<GameUploadStatus> {
	const session = await loadSession(deps, sessionId, user.id, user.role);
	const uploadedChunks = uploadedChunksForSession(session);
	return {
		sessionId: session.id,
		projectId: session.projectId,
		uploadKind: session.uploadKind,
		originalName: session.originalName,
		totalBytes: Number(session.totalBytes),
		chunkSizeBytes: session.chunkSizeBytes,
		totalChunks: session.totalChunks,
		uploadedChunks,
		uploadedCount: uploadedChunks.length,
		status: session.status,
		expiresAt: session.expiresAt.toISOString(),
	};
}

function uploadedChunksForSession(session: { parts?: { partNumber: number }[]; uploadedChunks: number[] }) {
	const partChunks = (session.parts ?? []).map((p) => p.partNumber - 1).sort((a, b) => a - b);
	return partChunks.length > 0 ? partChunks : session.uploadedChunks;
}

/** Cancel an upload session and abort the S3 multipart upload */
export async function cancelSession(
	deps: GameUploadServiceDependencies,
	sessionId: string,
	user: { id: number; role: string },
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
			deps.logger.error({
				err,
				sessionId: cancelled.durableAbort?.sessionId,
				s3Key: cancelled.durableAbort?.key,
				tracking: cancelled.durableAbort?.tracking,
			}, 'Failed to abort multipart upload during cancelSession');
		});
	}
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
	const completionClaimToken = deps.ids.next();
	const stale = await deps.repository.claimStaleCompletingSessions(
			cutoff,
			now,
			completionClaimToken,
			new Date(now.getTime() + 2 * 60 * 1000),
			50,
		);
	if (stale.length === 0) return { swept: 0 };

	for (const s of stale) {
		if (signal?.aborted) break;
		let completionStateResolved = false;
		const completionClaim = createCompletionClaimGuard({
			sessionId: s.id,
			token: completionClaimToken,
			clock: deps.clock,
			renew: deps.repository.renewCompletionClaim,
			...(signal ? { outerSignal: signal } : {}),
			logHeartbeatFailure: (error) => deps.logger.error(
				{ error, sessionId: s.id },
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
				{ err, sessionId: s.id, s3Key: s.s3Key },
				'Boot sweep: failed to inspect stale COMPLETING object; leaving it recoverable',
			);
			continue;
		}
		if (finalObject) {
			try {
				await completionClaim.assertOwned();
				const finalizationSession = {
					id: s.id,
					projectId: s.projectId,
					uploadKind: s.uploadKind,
					originalName: s.originalName,
					totalBytes: s.totalBytes,
					s3Key: s.s3Key,
					completionClaimToken,
				};
				await deps.finalizer.finalize(finalizationSession, finalObject, {
					storageRequest: { signal: completionClaim.signal },
					assertClaimOwned: completionClaim.assertOwned,
				});
				completionStateResolved = true;
			} catch (err) {
				if (isTerminalUploadFinalizationError(err)) {
					await completionClaim.assertOwned();
					deps.logger.error({ err, sessionId: s.id, s3Key: s.s3Key }, 'Boot sweep: completed upload is invalid');
					await commitTerminalCompletedObjectFailure(deps, {
						sessionId: s.id,
						storageKey: s.s3Key,
						reason: s.uploadKind === 'WEBGL'
							? 'webgl-upload-sweep-invalid'
							: 'game-upload-sweep-invalid',
						completionClaimToken,
					});
					completionStateResolved = true;
				} else {
					deps.logger.error(
						{ err, sessionId: s.id, s3Key: s.s3Key },
						'Boot sweep: transient finalization failure; leaving session recoverable',
					);
				}
			}
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
					{ error, sessionId: s.id, s3Key: s.s3Key },
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
				{ error, sessionId: s.id, s3Key: s.s3Key },
				'Completing-session recovery failed; continuing with the batch',
			);
		} finally {
			completionClaim.stop();
			if (!completionStateResolved) {
				await deps.repository.releaseCompletionClaim(
					s.id,
					completionClaimToken,
					deps.clock.now(),
					'recovery-deferred',
				).catch((error) => deps.logger.error(
					{ error, sessionId: s.id },
					'Failed to release completing-session recovery claim',
				));
			}
		}
	}
	deps.logger.warn({ count: stale.length }, 'Boot sweep: inspected stale COMPLETING sessions');
	return { swept: stale.length };
}

async function abortUnusedMultipart(
	deps: GameUploadServiceDependencies,
	key: string,
	uploadId: string,
	reason: string,
	signal?: AbortSignal,
): Promise<void> {
	await cleanupUntrackedMultipart(
		deps,
		{ key, uploadId, reason },
		signal ? { signal } : undefined,
	);
}

/** Reset an entire multipart generation after any part lease expires. */
export async function sweepExpiredPartClaims(
	deps: GameUploadServiceDependencies,
	signal?: AbortSignal,
): Promise<{ swept: number }> {
	if (signal?.aborted) return { swept: 0 };
	const sessions = await deps.repository.findSessionsWithExpiredPartClaims(
		deps.clock.now(),
		50,
	);
	let swept = 0;
	for (const session of sessions) {
		if (signal?.aborted) break;
		if (!session.s3Key) continue;
		try {
			const nextUploadId = await deps.storage.createMultipart(
				session.s3Key,
				...signalRequest(signal),
			);
			let reset: Awaited<ReturnType<typeof deps.repository.replaceMultipartGeneration>>;
			try {
				reset = await deps.repository.replaceMultipartGeneration({
					sessionId: session.id,
					expectedGeneration: session.multipartGeneration ?? 1,
					newUploadId: nextUploadId,
					reason: 'expired-part-claim-maintenance-reset',
				});
			} catch (businessError) {
				try {
					await abortUnusedMultipart(
						deps,
						session.s3Key,
						nextUploadId,
						'expired-part-claim-reset-persistence-failed',
						signal,
					);
				} catch (cleanupError) {
					if (cleanupError instanceof UntrackedMultipartCleanupError) {
						throw aggregateBusinessAndCleanupError(
							businessError,
							cleanupError,
							'Expired part-claim generation replacement and cleanup both failed',
						);
					}
					throw cleanupError;
				}
				throw businessError;
			}
			if (!reset.replaced) {
				await abortUnusedMultipart(
					deps,
					session.s3Key,
					nextUploadId,
					'unused-expired-part-claim-reset',
					signal,
				);
				continue;
			}
			swept++;
			const durableAbort = reset.durableAbort;
			if (durableAbort) {
				deps.wakeMaintenance();
				await deps.storage.abortMultipart(
					durableAbort.key,
					durableAbort.uploadId,
					...signalRequest(signal),
				).catch((error) => {
					deps.logger.error(
						{
							error,
							sessionId: durableAbort.sessionId,
							s3Key: durableAbort.key,
							tracking: durableAbort.tracking,
						},
						'Best-effort abort failed after expired part generation reset; durable task retained',
					);
				});
			}
		} catch (error) {
			if (
				error instanceof UntrackedMultipartCleanupError
				|| error instanceof MultipartBusinessCleanupError
			) throw error;
			deps.logger.error(
				{ error, sessionId: session.id, s3Key: session.s3Key },
				'Expired part-claim reset failed; leaving it for retry',
			);
		}
	}
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
			const cancelled = await deps.repository.cancelSessionAndClearActive(session.id);
			if (cancelled.count !== 1) continue;
			swept++;
			if (cancelled.durableAbort) {
				deps.wakeMaintenance();
				await deps.storage.abortMultipart(
					cancelled.durableAbort.key,
					cancelled.durableAbort.uploadId,
					...signalRequest(signal),
				).catch((error) => {
					deps.logger.error(
						{
							error,
							sessionId: cancelled.durableAbort?.sessionId,
							s3Key: cancelled.durableAbort?.key,
							tracking: cancelled.durableAbort?.tracking,
						},
						'Failed best-effort abort for expired upload; durable task retained',
					);
				});
			}
		} catch (error) {
			deps.logger.error({ error, sessionId: session.id }, 'Expired-upload sweep item failed');
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
	return { queued };
}

/** List active upload sessions for a project */
export async function listSessions(
	deps: GameUploadServiceDependencies,
	projectId: number,
	user: { id: number; role: string },
): Promise<GameUploadStatus[]> {
	const isPrivileged = user.role === 'ADMIN' || user.role === 'OPERATOR';
	const sessions = await deps.repository.findActiveSessionsForListing(
		projectId,
		isPrivileged ? {} : { userId: user.id },
	);

	return sessions.map((s) => {
		const uploadedChunks = uploadedChunksForSession(s);
		return {
			sessionId: s.id,
			projectId: s.projectId,
			uploadKind: s.uploadKind,
			originalName: s.originalName,
			totalBytes: Number(s.totalBytes),
			chunkSizeBytes: s.chunkSizeBytes,
			totalChunks: s.totalChunks,
			uploadedChunks,
			uploadedCount: uploadedChunks.length,
			status: s.status,
			expiresAt: s.expiresAt.toISOString(),
		};
	});
}
