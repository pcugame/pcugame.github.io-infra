import type { GameUploadCompleteResponse } from '@pcu/contracts';
import { AppError, badRequest, conflict, operationInProgress } from '../../../shared/errors.js';
import { loadSession } from './session-loader.js';
import { assertGameUploadSessionWritable } from './session-policy.js';
import { assertUploadStateTransition } from './state-machine.js';
import { isTerminalUploadFinalizationError } from './finalize-completed-upload.service.js';
import { commitTerminalCompletedObjectFailure } from './terminal-object-failure.js';
import type { GameUploadServiceDependencies } from './ports.js';
import { createCompletionClaimGuard } from './completion-claim.js';
import {
	aggregateBusinessAndCleanupError,
	cleanupUntrackedMultipart,
	UntrackedMultipartCleanupError,
} from './multipart-cleanup.js';

function resultCount(result: unknown): number | undefined {
	return typeof result === 'object'
		&& result !== null
		&& 'count' in result
		&& typeof result.count === 'number'
		? result.count
		: undefined;
}

function signalRequest(signal?: AbortSignal): [] | [{ signal: AbortSignal }] {
	return signal ? [{ signal }] : [];
}

/** Finalize a chunked upload: complete S3 multipart, validate ZIP, create GAME asset */
export async function completeSession(
	deps: GameUploadServiceDependencies,
	sessionId: string,
	user: { id: number; role: string },
): Promise<GameUploadCompleteResponse> {
	const session = await loadSession(deps, sessionId, user.id, user.role);
	if (session.status === 'COMPLETED') {
		if (session.completionResult && typeof session.completionResult === 'object') {
			return session.completionResult as GameUploadCompleteResponse;
		}
		if (session.storageKey) {
			return {
				status: 'COMPLETED',
				storageKey: session.storageKey,
				sizeBytes: Number(session.totalBytes),
			};
		}
	}
	if (session.status === 'COMPLETING') {
		throw operationInProgress('Upload completion is already in progress');
	}

	if (session.status !== 'PENDING') {
		throw badRequest(`Cannot complete: session is ${session.status}`);
	}
	assertUploadStateTransition(session.status, 'COMPLETING');
	assertGameUploadSessionWritable(session.project.status, user.role);

	if (!session.s3UploadId || !session.s3Key) {
		throw new AppError(500, 'Session is missing S3 multipart info', 'INTERNAL_ERROR');
	}

	const generation = session.multipartGeneration ?? 1;
	const currentParts = session.parts.filter(
		(part: { generation?: number }) => (part.generation ?? generation) === generation,
	);
	const uploadedChunks = currentParts.length > 0
		? currentParts.map((part: { partNumber: number }) => part.partNumber - 1)
		: session.uploadedChunks;
	const uploaded = new Set(uploadedChunks);
	const missing: number[] = [];
	for (let i = 0; i < session.totalChunks; i++) {
		if (!uploaded.has(i)) missing.push(i);
	}
	if (missing.length > 0) {
		throw badRequest(`Missing ${missing.length} chunks: [${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}]`);
	}

	const completionToken = deps.ids.next();
	const now = deps.clock.now();
	const transitioned = await deps.repository.claimCompletion({
			sessionId: session.id,
			generation,
			token: completionToken,
			now,
			leaseUntil: new Date(now.getTime() + 2 * 60 * 1000),
		});
	if (transitioned.count === 0) {
		if (transitioned.reason === 'parts-active') {
			throw operationInProgress('A chunk upload is still active');
		}
		throw badRequest('Session is already being completed by another request');
	}
	let s3Completed = false;
	let completionStateResolved = false;
	const storageKey = session.s3Key;
	const completionClaim = createCompletionClaimGuard({
		sessionId: session.id,
		token: completionToken,
		clock: deps.clock,
		renew: deps.repository.renewCompletionClaim,
		logHeartbeatFailure: (error) => deps.logger.error(
			{ error, sessionId: session.id },
			'Completion claim heartbeat failed',
		),
	});
	const storageRequest = { signal: completionClaim.signal };
	try {
		await completionClaim.assertOwned();
		const dbParts = await deps.repository.findPartsBySessionId(session.id);
		await completionClaim.assertOwned();
		const parts = dbParts
			.filter((part) => (part.generation ?? generation) === generation)
			.map((part) => ({ partNumber: part.partNumber, etag: part.etag }));
		if (parts.length !== session.totalChunks) {
			throw new AppError(500, `Part ETag count mismatch: expected ${session.totalChunks}, got ${parts.length}`, 'INTERNAL_ERROR');
		}
		{
			const actualParts = await deps.storage.listParts(
				session.s3Key,
				session.s3UploadId,
				...signalRequest(storageRequest?.signal),
			);
			await completionClaim.assertOwned();
			const normalize = (etag: string) => etag.trim().replace(/^"|"$/g, '');
			const matches = actualParts.length === parts.length && parts.every((part, index) => {
				const actual = actualParts[index];
				return actual?.partNumber === part.partNumber
					&& normalize(actual.etag) === normalize(part.etag);
			});
			if (!matches) {
				const businessError = conflict('Stored multipart parts did not match claimed ETags; re-upload all chunks');
				const reverted = await deps.repository.revertToPending(
					session.id,
					completionToken,
				);
				if (resultCount(reverted) !== 1) {
					throw completionClaim.loseClaim();
				}
				completionStateResolved = true;
				completionClaim.stop();
				const nextUploadId = await deps.storage.createMultipart(
					session.s3Key,
					...signalRequest(storageRequest.signal),
				);
				let reset: Awaited<ReturnType<typeof deps.repository.replaceMultipartGeneration>>;
				try {
					reset = await deps.repository.replaceMultipartGeneration({
						sessionId: session.id,
						expectedGeneration: generation,
						newUploadId: nextUploadId,
						reason: 'list-parts-mismatch-generation-reset',
					});
				} catch (replacementError) {
					try {
						await cleanupUntrackedMultipart(deps, {
							key: session.s3Key,
							uploadId: nextUploadId,
							reason: 'list-parts-mismatch-reset-persistence-failed',
						}, storageRequest);
					} catch (cleanupError) {
						if (cleanupError instanceof UntrackedMultipartCleanupError) {
							throw aggregateBusinessAndCleanupError(
								[businessError, replacementError],
								cleanupError,
								'Multipart mismatch, generation replacement, and cleanup all failed',
							);
						}
						throw cleanupError;
					}
					throw new AggregateError(
						[businessError, replacementError],
						'Multipart mismatch and generation replacement both failed',
					);
				}
				if (!reset.replaced) {
					try {
						await cleanupUntrackedMultipart(deps, {
							key: session.s3Key,
							uploadId: nextUploadId,
							reason: 'unused-list-parts-mismatch-reset',
						}, storageRequest);
					} catch (cleanupError) {
						if (cleanupError instanceof UntrackedMultipartCleanupError) {
							throw aggregateBusinessAndCleanupError(
								businessError,
								cleanupError,
								'Multipart mismatch and replacement cleanup both failed',
							);
						}
						throw cleanupError;
					}
				} else if (reset.durableAbort) {
					deps.wakeMaintenance();
				}
				throw businessError;
			}
		}

		await deps.storage.completeMultipart(
			session.s3Key,
			session.s3UploadId,
			parts,
			...signalRequest(storageRequest?.signal),
		);
		s3Completed = true;
		await completionClaim.assertOwned();

		const head = await deps.storage.head(storageKey, ...signalRequest(storageRequest?.signal));
		if (!head) {
			throw new AppError(500, 'Completed object not found in S3', 'INTERNAL_ERROR');
		}
		await completionClaim.assertOwned();
		const finalizationSession = {
			id: session.id,
			projectId: session.projectId,
			uploadKind: session.uploadKind,
			originalName: session.originalName,
			totalBytes: session.totalBytes,
			s3Key: storageKey,
			completionClaimToken: completionToken,
		};
		const result = await deps.finalizer.finalize(finalizationSession, head, {
				storageRequest,
				assertClaimOwned: completionClaim.assertOwned,
			});
		completionStateResolved = true;
		return result;
	} catch (err) {
		if (completionStateResolved) throw err;
		if (completionClaim.isLost()) {
			deps.logger.warn(
				{ err, sessionId: session.id, storageKey },
				'Upload completion claim was lost; preserving COMPLETING state for the current owner',
			);
			throw err;
		}
		if (!s3Completed) {
			try {
				s3Completed = await deps.storage.head(
					storageKey,
					...signalRequest(storageRequest?.signal),
				) !== null;
			} catch (inspectionError) {
				deps.logger.error(
					{ err: inspectionError, sessionId: session.id, storageKey },
					'Could not determine whether multipart completion created the final object; preserving COMPLETING state',
				);
				throw err;
			}
			if (!s3Completed) {
				try {
					await deps.storage.listParts(
						session.s3Key,
						session.s3UploadId,
						...signalRequest(storageRequest?.signal),
					);
				} catch (inspectionError) {
					deps.logger.error(
						{ err: inspectionError, sessionId: session.id, storageKey },
						'Multipart completion and upload state are both ambiguous; preserving COMPLETING state',
					);
					throw err;
				}
			}
		}

		if (s3Completed) {
			if (isTerminalUploadFinalizationError(err)) {
				await completionClaim.assertOwned();
				await commitTerminalCompletedObjectFailure(deps, {
					sessionId: session.id,
					storageKey,
					reason: session.uploadKind === 'WEBGL'
						? 'webgl-upload-completion-invalid'
						: 'game-upload-completion-invalid',
					completionClaimToken: completionToken,
				});
				completionStateResolved = true;
			} else {
				deps.logger.warn(
					{ err, sessionId: session.id, storageKey },
					'Upload finalization failed after storage completion; preserving for restart recovery',
				);
			}
		} else {
			assertUploadStateTransition('COMPLETING', 'PENDING');
			await completionClaim.assertOwned();
			try {
				const reverted = await deps.repository.revertToPending(
					session.id,
					completionToken,
				);
				if (resultCount(reverted) !== 1) {
					throw completionClaim.loseClaim();
				}
				completionStateResolved = true;
			} catch (revertErr) {
				deps.logger.error({ err: revertErr, sessionId: session.id }, 'Failed to revert session to PENDING after pre-S3-complete error');
			}
		}
		throw err;
	} finally {
		completionClaim.stop();
		if (!completionStateResolved) {
			await deps.repository.releaseCompletionClaim(
				session.id,
				completionToken,
				deps.clock.now(),
				'request-completion-deferred',
			).catch((error) => deps.logger.error(
				{ error, sessionId: session.id },
				'Failed to release request completion claim',
			));
		}
	}
}
